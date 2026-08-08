/**
 * Execute activation plans transactionally (spec §P7, §23).
 * Journals only serializable ResourceRef values — never adapter instances.
 */

import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  ActivationPlan,
  GlobalBinding,
  PlanStep,
  ProjectBinding,
  ResolvedClientPlan,
  ResourceRef,
} from '../types';
import { displayRef, mutationScopeForRef, parseRef, serializeRef } from './refs';
import type { OperationJournal } from './journal';
import type { LeaseStore } from './lease-store';
import type { AccountService } from './service';
import type { LiveAuthCheckpoint } from './service';
import type { ClientConfigRecovery, RuntimeService } from './runtime-service';
import {
  loadAccountForRef,
  loadProfileForRef,
  materializeResolvedSource,
  type ResolveSourceDeps,
} from './resolve-source';
import type { ProxyService } from './proxy-service';
import type { ProxyHubRouteSecret } from './proxy-hub-store';
import { anypickError, ExitCode, isAnyPickError } from '../utils/errors';
import { pathExists } from '../utils/fs';
import { waitForHttp } from '../utils/process/health';
import { withMutationLocks } from './mutation-lock';
import { makeEmitter, type AnyPickEventSink } from './events';

export interface ExecuteResult {
  plan: ActivationPlan;
  dryRun: boolean;
  alreadyActive: boolean;
  binding?: GlobalBinding | ProjectBinding;
  proxyEndpoint?: string;
  journalId?: string;
  childExitCode?: number;
  /** Ephemeral isolated runtime (spec §9.7.1) — must be cleaned up by caller. */
  isolated?: {
    directory: string;
    environment: Record<string, string>;
    args?: string[];
    cleanup: () => Promise<void>;
  };
  /** Scoped rollback for a successful ephemeral run. Idempotent. */
  cleanup?: () => Promise<void>;
}

export interface ExecutorDeps extends ResolveSourceDeps {
  journal: OperationJournal;
  leases: LeaseStore;
  runtime: RuntimeService;
  accounts: AccountService;
  proxy: ProxyService;
  /**
   * Structured sink for degraded-state conditions (OBS-01). Optional.
   * Named `eventSink` rather than `events` so an entire `AnyPickApp` (whose
   * `events` is a `{ sink, emit, list }` facade) can still be passed where
   * `ExecutorDeps` is expected without a structural type collision.
   */
  eventSink?: AnyPickEventSink;
}

export interface ExecuteOptions {
  dryRun?: boolean;
  verbose?: boolean;
  projectRoot?: string;
  /** Report an equal persistent binding as already active after it is safely re-applied. */
  skipIfActive?: boolean;
  /** Budget for the WaitForHealth step. Lowered by tests; defaults to 5s. */
  healthTimeoutMs?: number;
}

function bindingEqual(
  a: {
    source: { kind: string };
    model: unknown;
    client: string;
    clientOptions?: Record<string, unknown>;
  },
  b: {
    source: { kind: string };
    model: unknown;
    client: string;
    clientOptions?: Record<string, unknown>;
  },
): boolean {
  // Include clientOptions (modelRoles) — editing models must re-apply, not no-op.
  return (
    JSON.stringify({
      client: a.client,
      source: a.source,
      model: a.model,
      clientOptions: a.clientOptions ?? {},
    }) ===
    JSON.stringify({
      client: b.client,
      source: b.source,
      model: b.model,
      clientOptions: b.clientOptions ?? {},
    })
  );
}

function mutationScopes(plan: ActivationPlan): string[] {
  // Hub mutations own their complete Hub + provider lock set inside
  // ProxyHubService. Keeping the executor's outer lock client-scoped avoids
  // holding the Hub lock before the service can acquire its sorted scope set.
  if (plan.resolvedSource.ref.kind === 'proxy-hub') {
    return [`client/${plan.client}`];
  }
  return [`client/${plan.client}`, mutationScopeForRef(plan.resolvedSource.ref)];
}

export async function executeActivation(
  plan: ActivationPlan,
  deps: ExecutorDeps,
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const dryRun = Boolean(opts.dryRun);
  // An equal binding still goes through the transaction. The historical fast
  // path rewrote client files and started proxies outside the operation journal,
  // leaving no durable compensation if the process died mid-write.
  const existing =
    plan.mode === 'persistent' && plan.bindingSpec && opts.skipIfActive !== false
      ? deps.bindings.getGlobal(plan.client)
      : undefined;
  const alreadyActive = Boolean(
    existing && plan.bindingSpec && bindingEqual(existing.spec, plan.bindingSpec),
  );

  if (dryRun) {
    return {
      plan,
      dryRun: true,
      alreadyActive: false,
      proxyEndpoint: plan.transport.endpoint,
    };
  }

  // Concurrent mutations are locked (spec §23.3 / §28.2 #67)
  return withMutationLocks(deps.runtime.root, mutationScopes(plan), async () => {
    const result = await executeActivationLocked(plan, deps, opts);
    return { ...result, alreadyActive };
  });
}

interface ActivationContext {
  /** True once any step has mutated live state / config. */
  mutated: boolean;
  /** LIFO stack of undo operations, run in reverse on failure. */
  undo: Array<() => Promise<void>>;
  /** Proxies started by this activation (for stop-on-rollback). */
  startedProxies: Array<{ provider: string; account?: string }>;
  /** Lease ids created by this activation (for release-on-rollback). */
  leaseIds: string[];
  /** Exact local auth checkpoint before a native-auth switch. */
  nativeAuthCheckpoint?: LiveAuthCheckpoint;
  /** Client config written by this activation (for reset-on-rollback). */
  clientConfigWritten?: string;
  /** Isolated runtime from an ephemeral run (for cleanup-on-rollback). */
  isolated?: {
    directory: string;
    environment: Record<string, string>;
    args?: string[];
    cleanup: () => Promise<void>;
  };
  /** `src=>dest` backups of on-disk config files overwritten by this activation. */
  backupPaths: string[];
  /** Binding committed by the authoritative plan step. */
  binding?: GlobalBinding | ProjectBinding;
}

/**
 * Execute an activation plan by interpreting its `steps` as the source of
 * truth. Each mutating step records an inverse operation onto a rollback
 * stack; if any step throws, the stack is unwound in reverse so partial
 * state is undone (proxy stopped, lease released, prior account restored,
 * client config reset, binding removed).
 *
 * The plan is authoritative: the executor does not re-derive behavior from
 * transport capability, so the planner and executor cannot silently diverge.
 */
async function executeActivationLocked(
  plan: ActivationPlan,
  deps: ExecutorDeps,
  opts: ExecuteOptions,
): Promise<ExecuteResult> {
  const affected = [`client/${plan.client}`, serializeRef(plan.resolvedSource.ref)];
  const ctx: ActivationContext = {
    mutated: false,
    undo: [],
    startedProxies: [],
    leaseIds: [],
    backupPaths: [],
  };

  const journal = deps.journal.create(`activate:${plan.mode}`, {
    affectedResources: affected,
    params: {
      client: plan.client,
      source: serializeRef(plan.resolvedSource.ref),
      mode: plan.mode,
      steps: plan.steps.map((s) => s.kind),
    },
    state: 'planned',
  });

  try {
    deps.journal.update(journal.id, { state: 'executing' });

    // Transport gates before any mutation (planner does not emit steps for these).
    if (plan.transport.capability === 'external_manual_proxy') {
      throw anypickError(
        `Required external proxy for ${plan.resolvedSource.display} is not installed.\n\nInstall the provider proxy and retry.`,
        'MISSING_DEPENDENCY',
        {
          exitCode: ExitCode.MISSING_DEPENDENCY,
          suggestions: [`anypick doctor ${plan.client}`],
          mutated: false,
        },
      );
    }
    if (plan.transport.capability === 'unsupported') {
      throw anypickError(
        `Unsupported transport for ${plan.client} × ${plan.resolvedSource.display}`,
        'UNSUPPORTED_TRANSPORT',
        { exitCode: ExitCode.CAPABILITY_CONFLICT },
      );
    }

    for (const step of plan.steps) {
      await runStep(step, plan, deps, opts, ctx, journal.id);
    }

    deps.journal.update(journal.id, {
      state: 'verifying',
      backupPaths: ctx.backupPaths,
    });

    deps.journal.update(journal.id, { state: 'committed' });

    const cleanup = plan.mode === 'ephemeral' ? makeEphemeralCleanup(ctx, deps) : undefined;

    return {
      plan,
      dryRun: false,
      alreadyActive: false,
      binding: ctx.binding,
      proxyEndpoint: plan.transport.endpoint,
      journalId: journal.id,
      isolated: ctx.isolated,
      cleanup,
    };
  } catch (err) {
    const rethrow = err instanceof Error ? err : new Error(String(err));
    const rolledBack = await runRollback(ctx, deps, journal.id);
    await finalizeJournal(deps, journal.id, rolledBack);
    // Surface whether any live state was left changed.
    const mutated = ctx.mutated && !rolledBack;
    if (isAnyPickError(rethrow)) {
      rethrow.mutated = mutated;
    }
    throw rethrow;
  }
}

/**
 * Per-step execution context. Handlers register undo on `ctx` and never re-derive
 * transport capability from adapters — the plan is the single source of truth.
 */
interface StepRunArgs {
  step: PlanStep;
  plan: ActivationPlan;
  deps: ExecutorDeps;
  opts: ExecuteOptions;
  ctx: ActivationContext;
  journalId: string;
}

type StepHandler = (args: StepRunArgs) => Promise<void>;

/** Planner-time markers: resolved while building the plan, no execution work. */
const plannerOnlyStep: StepHandler = async () => {};

/**
 * Exhaustive step-handler registry.
 *
 * Adding a PlanStepKind without a handler is a compile error (`satisfies`),
 * which is how ValidateCredential/WaitForHealth/VerifyEffectiveState came to
 * be advertised in `--dry-run` while doing nothing under a silent default.
 */
const STEP_HANDLERS = {
  EnsureProxyHub: async ({ step, plan, deps, ctx }) => {
    const name = hubNameForStep(step, plan);
    const hub = requireProxyHub(deps);
    const started = await hub.ensureRunning(name);
    plan.transport.endpoint = started.endpoint;
    if (started.startedNow) {
      ctx.mutated = true;
      ctx.undo.push(async () => {
        if (hub.getAttachedRouteCount(name) === 0) {
          await hub.stop(name);
        }
      });
    }
  },

  AttachProxyHubRoute: async ({ step, plan, deps, ctx }) => {
    const name = hubNameForStep(step, plan);
    const routeId = routeIdForStep(step);
    const hub = requireProxyHub(deps);
    const previous: ProxyHubRouteSecret | null = hub.getAttachedRoute(routeId);
    const attached = await hub.attachRoute(
      routeId,
      plan.client,
      plan.transport.protocol,
      name,
      requestedHubModels(plan),
    );
    if (plan.transport.managedProxy) {
      plan.transport.managedProxy.token = attached.token;
    }
    ctx.mutated = true;
    ctx.undo.push(async () => {
      await hub.restoreRoute(routeId, previous);
    });
  },

  WaitForHubHealth: async ({ plan, opts }) => {
    const endpoint = plan.transport.endpoint;
    if (!endpoint) {
      throw new Error('Internal plan error: Proxy Hub has no endpoint');
    }
    const ready = await waitForHttp(`${endpoint}/health`, { timeoutMs: opts.healthTimeoutMs });
    if (!ready) {
      throw anypickError('Proxy Hub did not become healthy.', 'PROXY_START_FAILED');
    }
  },

  ValidateProxyHubRoute: async ({ plan, opts }) => {
    const endpoint = plan.transport.endpoint;
    const token = plan.transport.managedProxy?.token;
    if (!endpoint || !token) {
      throw new Error('Internal plan error: Proxy Hub route has no token');
    }
    const response = await fetch(`${endpoint}/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(opts.healthTimeoutMs ?? 5000),
    });
    if (!response.ok) {
      throw anypickError('Proxy Hub route could not be validated.', 'PROXY_START_FAILED');
    }
  },

  StartProxy: async ({ plan, deps, ctx }) => {
    const endpoint = await startManagedProxy(plan, deps, ctx);
    if (endpoint) {
      plan.transport.endpoint = endpoint;
    }
  },

  WriteNativeAuth: async ({ plan, deps, ctx, journalId }) => {
    if (plan.mode === 'ephemeral') {
      throw anypickError(
        'Internal plan error: ephemeral activation must not write live native auth.',
        'UNSUPPORTED_TRANSPORT',
        { exitCode: ExitCode.CAPABILITY_CONFLICT },
      );
    }
    if (plan.resolvedSource.ref.kind === 'account') {
      const { provider, name } = plan.resolvedSource.ref;
      // Snapshot before invoking provider.restore. Mark mutation intent and
      // register undo before the call so a provider that writes one auth file
      // and then throws is still compensated.
      const checkpoint = await deps.accounts.checkpointLiveAuth(provider, { durable: true });
      const journal = deps.journal.get(journalId);
      deps.journal.update(journalId, {
        params: {
          ...journal?.params,
          nativeAuthCheckpoint: checkpoint,
        },
      });
      ctx.nativeAuthCheckpoint = checkpoint;
      ctx.mutated = true;
      ctx.undo.push(async () => {
        try {
          await deps.accounts.restoreLiveAuthCheckpoint(checkpoint);
        } finally {
          await deps.accounts.discardLiveAuthCheckpoint(checkpoint);
        }
      });
      await deps.accounts.use(provider, name, {
        noProxy: plan.transport.capability !== 'direct',
      });
    }
  },

  WriteClientConfig: async ({ plan, deps, opts, ctx, journalId }) => {
    if (
      (plan.resolvedSource.kind === 'account' || plan.resolvedSource.kind === 'proxy-hub') &&
      plan.transport.endpoint &&
      plan.transport.capability !== 'direct'
    ) {
      // Persist exact file compensation before an adapter can touch disk.
      const recovery = await prepareClientRecovery(plan.client, deps, ctx, journalId);
      ctx.clientConfigWritten = plan.client;
      ctx.mutated = true;
      ctx.undo.push(async () => {
        await deps.runtime.restoreClientConfigRecovery(recovery);
      });
      // Leaving the Hub must drop this client's route so Claude's Hub attach
      // cannot keep a stale global/<client> route that confuses live Codex config.
      if (plan.mode === 'persistent' && plan.resolvedSource.ref.kind !== 'proxy-hub') {
        await detachClientHubRoute(deps, plan.client);
      }
      // Account + managed proxy: inject endpoint into native client config.
      await injectProxyEndpoint(plan, deps, opts, recovery);
    } else if (
      plan.resolvedSource.kind === 'gateway' &&
      plan.resolvedSource.ref.kind === 'gateway' &&
      (plan.mode === 'persistent' || plan.mode === 'project')
    ) {
      // Persist exact file compensation before an adapter can touch disk.
      const recovery = await prepareClientRecovery(plan.client, deps, ctx, journalId);
      ctx.clientConfigWritten = plan.client;
      ctx.mutated = true;
      ctx.undo.push(async () => {
        await deps.runtime.restoreClientConfigRecovery(recovery);
      });
      if (plan.mode === 'persistent') {
        await detachClientHubRoute(deps, plan.client);
      }
      // Gateway profile: apply the saved profile to the client.
      await deps.runtime.apply(plan.resolvedSource.ref.name, plan.client, {
        dryRun: false,
        verbose: opts.verbose,
        proxyEndpoint: plan.transport.endpoint,
        recovery,
      });
    } else if (
      plan.client === 'codex' &&
      plan.mode === 'persistent' &&
      plan.transport.capability === 'direct'
    ) {
      // Native Codex account: restore the user's top-level model/model_provider
      // and mark live mode native so a still-running proxy cannot re-takeover.
      await deps.runtime.restoreCodexLiveForNative();
      await detachClientHubRoute(deps, 'codex');
    }
  },

  ValidateCredential: async ({ plan, deps }) => {
    await validateCredential(plan, deps);
  },

  WaitForHealth: async ({ plan, opts }) => {
    await waitForProxyHealth(plan, opts);
  },

  VerifyEffectiveState: async ({ plan, deps }) => {
    await verifyEffectiveState(plan, deps);
  },

  CreateTemporaryClientHome: async (args) => {
    await createEphemeralHome(args);
  },

  CreateEnvironmentOverlay: async (args) => {
    await createEphemeralHome(args);
  },

  SpawnChild: async () => {
    // The actual child process is spawned by the CLI launcher (launch-client),
    // which uses `result.isolated.environment` + `result.isolated.cleanup`.
    // The executor must NOT spawn here — it only builds the ephemeral session
    // so a single temp-home step produces exactly one dir.
  },

  CommitGlobalBinding: async ({ plan, deps, ctx }) => {
    if (plan.mode !== 'persistent' || !plan.bindingSpec || !plan.provenance) {
      throw new Error('Internal plan error: invalid global binding commit');
    }
    const previous = deps.bindings.getGlobal(plan.client);
    ctx.binding = deps.bindings.upsertGlobal(plan.client, plan.bindingSpec, plan.provenance);
    ctx.mutated = true;
    ctx.undo.push(async () => {
      if (previous) {
        deps.bindings.upsertGlobal(plan.client, previous.spec, previous.provenance);
      } else {
        deps.bindings.deleteGlobal(plan.client);
      }
    });
    // Codex Desktop catalog aliases read modelRoles from the binding store.
    // Re-sync after commit so Default/Model 2–5 win over the pre-binding attach.
    if (plan.client === 'codex' && plan.resolvedSource.ref.kind === 'proxy-hub') {
      await deps.runtime.refreshCodexLiveConfig({ forceRouted: true });
    }
  },

  CommitProjectBinding: async ({ step, plan, deps, opts, ctx }) => {
    if (plan.mode !== 'project' || !plan.bindingSpec || !plan.provenance) {
      throw new Error('Internal plan error: invalid project binding commit');
    }
    const root =
      typeof step.params?.projectRoot === 'string' ? step.params.projectRoot : opts.projectRoot;
    if (!root) {
      throw anypickError('projectRoot required for project binding commit', 'INVALID_USAGE', {
        exitCode: ExitCode.INVALID_USAGE,
      });
    }
    const previous = deps.bindings.getProject(root, plan.client);
    ctx.binding = deps.bindings.upsertProject(root, plan.client, plan.bindingSpec, plan.provenance);
    ctx.mutated = true;
    ctx.undo.push(async () => {
      if (previous) {
        deps.bindings.upsertProject(root, plan.client, previous.spec, previous.provenance);
      } else {
        deps.bindings.deleteProject(root, plan.client);
      }
    });
  },

  ResolveSource: plannerOnlyStep,
  ExpandPreset: plannerOnlyStep,
  ValidateCompatibility: plannerOnlyStep,
  ResolveTransport: plannerOnlyStep,
  ValidateExternalDependency: plannerOnlyStep,
  AllocateProxyLease: plannerOnlyStep,
  InspectClientState: plannerOnlyStep,
  ReleaseLease: plannerOnlyStep,
  RestoreTemporaryState: plannerOnlyStep,
} as const satisfies Record<PlanStep['kind'], StepHandler>;

async function createEphemeralHome({ plan, deps, opts, ctx }: StepRunArgs): Promise<void> {
  // Exactly one isolated home is created for the whole ephemeral run. The
  // returned session owns its own temp dir + acquired handles; cleanup is
  // idempotent so the launcher can call it on every exit path.
  if (
    plan.resolvedSource.ref.kind === 'account' ||
    plan.resolvedSource.ref.kind === 'gateway' ||
    plan.resolvedSource.ref.kind === 'proxy-hub'
  ) {
    const profile = await loadProfileForRef(plan.resolvedSource.ref, deps);
    const account = await loadAccountForRef(plan.resolvedSource.ref, deps);
    const resolvedPlan: ResolvedClientPlan = {
      clientId: plan.client,
      source: plan.resolvedSource,
      transport: plan.transport,
      model: plan.model,
      mode: 'ephemeral',
      profile,
      account,
      dryRun: false,
      verbose: Boolean(opts.verbose),
      anypickRoot: deps.runtime.root,
    };
    const isolated = await deps.runtime.createEphemeralRuntime(resolvedPlan);
    ctx.isolated = isolated;
    ctx.mutated = true;
    ctx.undo.push(async () => {
      await isolated.cleanup();
    });
  }
}

/**
 * Execute one plan step. Validation/inspection steps are no-ops at execution
 * time (the planner already resolved and validated); mutating steps perform
 * the side effect and register its inverse on the rollback stack.
 */
async function runStep(
  step: PlanStep,
  plan: ActivationPlan,
  deps: ExecutorDeps,
  opts: ExecuteOptions,
  ctx: ActivationContext,
  journalId: string,
): Promise<void> {
  const handler = STEP_HANDLERS[step.kind];
  await handler({ step, plan, deps, opts, ctx, journalId });
}

/**
 * Assert the credential behind this source is usable before anything mutates
 * live state. For accounts this is a presence check on the saved snapshot plus
 * an opportunistic refresh when the provider supports it: activating onto an
 * expired token otherwise fails later, after the client config was rewritten.
 * Gateways carry their key material in the profile, so presence is sufficient.
 */
async function validateCredential(plan: ActivationPlan, deps: ExecutorDeps): Promise<void> {
  const ref = plan.resolvedSource.ref;

  if (ref.kind === 'account') {
    // `accounts.get` returns null unless the account has snapshot rows in the
    // database, and materializes them to disk as a side effect. That row check
    // *is* the credential-presence check — a filesystem probe here would be
    // meaningless, since the directory is (re)created by this very call.
    const account = await deps.accounts.get(ref.provider, ref.name);
    if (!account) {
      throw anypickError(
        `Account ${ref.provider}/${ref.name} has no stored credential snapshot.`,
        'AUTH_REQUIRED',
        {
          exitCode: ExitCode.AUTH_REQUIRED,
          suggestions: [`anypick add ${ref.provider} --name ${ref.name}`],
        },
      );
    }
    // Best-effort: a provider that can refresh does so now, while we still hold
    // the mutation lock and before any client file is touched. A refresh failure
    // is not fatal — the credential may still be valid — but it is observable.
    if (plan.resolvedSource.adapter.capabilities.canRefresh) {
      try {
        await deps.accounts.refresh(ref.provider, ref.name);
      } catch (err) {
        makeEmitter(deps.eventSink)(
          'warn',
          'credential_refresh_failed',
          `Could not refresh credential for ${ref.provider}/${ref.name} before activation`,
          {
            step: 'ValidateCredential',
            resourceIds: [serializeRef(ref)],
            context: { error: err instanceof Error ? err.message : String(err) },
          },
        );
      }
    }
    return;
  }

  if (ref.kind === 'gateway') {
    const profile = await loadProfileForRef(ref, deps);
    if (!profile) {
      throw anypickError(`Gateway not found: ${ref.name}`, 'GATEWAY_NOT_FOUND', {
        exitCode: ExitCode.NOT_FOUND,
      });
    }
    return;
  }

  if (ref.kind === 'proxy-hub') {
    const hub = await requireProxyHub(deps).get(ref.name);
    if (!hub.enabled) {
      throw anypickError(`Proxy Hub hub:${ref.name} is disabled.`, 'PROXY_DISABLED');
    }
    return;
  }

  if (ref.kind === 'account-pool') {
    const pool = deps.pools ? await deps.pools.get(ref.provider) : undefined;
    const enabled = pool?.members.filter((m) => m.enabled) ?? [];
    if (enabled.length === 0) {
      throw anypickError(
        `Pool ${ref.provider} has no enabled members to activate.`,
        'AUTH_REQUIRED',
        {
          exitCode: ExitCode.AUTH_REQUIRED,
          suggestions: [`anypick proxy pool ${ref.provider}`],
        },
      );
    }
  }
}

/**
 * Confirm the managed proxy is actually serving before its endpoint is written
 * into a client config.
 *
 * Provider `startProxy` implementations already poll `/health` with instance-id
 * verification and throw `PROXY_START_FAILED` on timeout, so under normal
 * sequencing this step is a cheap re-assertion rather than the primary gate.
 * It matters for the reuse path: when `startProxy` adopts an already-running
 * process it returns without a fresh readiness probe, and for a process that
 * died in the window between start and config write.
 */
async function waitForProxyHealth(plan: ActivationPlan, opts: ExecuteOptions): Promise<void> {
  const endpoint = plan.transport.endpoint;
  if (!endpoint) {
    return;
  }
  const ref = plan.resolvedSource.ref;
  const ok = await waitForHttp(`${endpoint}/health`, {
    timeoutMs: opts.healthTimeoutMs ?? 5000,
  });
  if (!ok) {
    throw anypickError(
      `Proxy for ${plan.resolvedSource.display} is not responding at ${endpoint}.`,
      'HEALTH_FAILURE',
      {
        exitCode: ExitCode.HEALTH_FAILURE,
        suggestions: [
          `anypick proxy logs ${ref.kind === 'account' ? `${ref.provider} ${ref.name}` : ''}`.trim(),
          `anypick doctor ${plan.client}`,
        ],
      },
    );
  }
}

/**
 * Read back the client configuration this activation just wrote and confirm the
 * adapter reports it as present. Without this, a client adapter whose write
 * silently no-ops leaves `anypick use` reporting success while the client keeps
 * talking to the previous endpoint — the exact silent inconsistency the journal
 * exists to prevent.
 *
 * Non-fatal by design: a failed read-back is reported as a degraded-state event
 * rather than rolling back a correct write, because `inspect()` is a heuristic
 * and a false negative must not undo a good activation.
 */
async function verifyEffectiveState(plan: ActivationPlan, deps: ExecutorDeps): Promise<void> {
  if (plan.mode === 'ephemeral') {
    return;
  }
  const client = deps.clients.get(plan.client);
  let inspected;
  try {
    inspected = await client.inspect();
  } catch (err) {
    makeEmitter(deps.eventSink)(
      'warn',
      'effective_state_unverified',
      `Could not read back ${plan.client} configuration after activation`,
      {
        step: 'VerifyEffectiveState',
        resourceIds: [`client/${plan.client}`],
        context: { error: err instanceof Error ? err.message : String(err) },
      },
    );
    return;
  }
  if (!inspected.present) {
    makeEmitter(deps.eventSink)(
      'warn',
      'effective_state_mismatch',
      `${plan.client} reports no anypick-managed configuration after activation`,
      {
        step: 'VerifyEffectiveState',
        resourceIds: [`client/${plan.client}`],
        context: { issues: inspected.issues?.join('; ') },
      },
    );
  }
}

/**
 * Start the managed proxy (pool or account) for this activation, create its
 * lease, and record inverse operations. Returns the proxy endpoint.
 */
async function startManagedProxy(
  plan: ActivationPlan,
  deps: ExecutorDeps,
  ctx: ActivationContext,
): Promise<string | undefined> {
  const ref = plan.resolvedSource.ref;
  if (ref.kind === 'account-pool') {
    const started = await deps.proxy.startPoolProxy(ref.provider);
    if (started.startedNow) {
      ctx.startedProxies.push({ provider: ref.provider });
    }
    ctx.mutated = true;
    if (started.startedNow) {
      ctx.undo.push(async () => {
        await deps.proxy.stopPoolProxy(ref.provider);
      });
    }
    if (started.leaseId) {
      ctx.leaseIds.push(started.leaseId);
    }
    if (plan.transport.managedProxy) {
      if (started.leaseId) {
        plan.transport.managedProxy.leaseId = started.leaseId;
      }
      // The proxy token is independent of lease bookkeeping. A lease can be
      // unavailable (for example while a tray owns the process) even though
      // the reused proxy returned its live token; never fall back to the
      // unauthenticated `anypick-proxy` placeholder in that case.
      if (started.token) {
        plan.transport.managedProxy.token = started.token;
      }
    }
    return started.endpoint;
  }

  if (ref.kind === 'account') {
    const accountBefore = await deps.accounts.get(ref.provider, ref.name);
    if (!accountBefore) {
      throw anypickError(`Account not found: ${ref.provider}/${ref.name}`, 'NOT_FOUND');
    }
    if (plan.mode === 'ephemeral' && !accountBefore.proxy.enabled) {
      // `startProxy` needs an enabled account config. Restore the exact prior
      // config after the child exits so one-shot runs do not silently opt an
      // account into future automatic proxy starts.
      const priorConfig = accountBefore.proxy;
      ctx.mutated = true;
      ctx.undo.push(async () => {
        await deps.proxy.restoreProxyConfig(ref.provider, ref.name, priorConfig);
      });
    }
    try {
      await deps.proxy.enableProxy(ref.provider, ref.name, {});
    } catch {
      // may already be enabled
    }
    const started = await deps.proxy.startProxy(ref.provider, ref.name);
    if (started.startedNow) {
      ctx.startedProxies.push({ provider: ref.provider, account: ref.name });
    }
    ctx.mutated = true;
    if (started.startedNow) {
      ctx.undo.push(async () => {
        await deps.proxy.stopProxy(ref.provider, ref.name);
      });
    }
    if (started.leaseId) {
      ctx.leaseIds.push(started.leaseId);
    }
    if (plan.transport.managedProxy) {
      if (started.leaseId) {
        plan.transport.managedProxy.leaseId = started.leaseId;
      }
      if (started.token) {
        plan.transport.managedProxy.token = started.token;
      }
    }
    return started.endpoint;
  }

  return undefined;
}

/** Inject the managed proxy endpoint into native client config (account proxy). */
async function injectProxyEndpoint(
  plan: ActivationPlan,
  deps: ExecutorDeps,
  opts: ExecuteOptions,
  recovery: ClientConfigRecovery,
): Promise<void> {
  const endpoint = plan.transport.endpoint;
  if (!endpoint) {
    return;
  }
  const ref = plan.resolvedSource.ref;
  const modelId = plan.model.mode === 'explicit' ? plan.model.id : undefined;
  const rawRoles = plan.bindingSpec?.clientOptions?.modelRoles;
  const modelRoles =
    rawRoles && typeof rawRoles === 'object' && !Array.isArray(rawRoles)
      ? Object.fromEntries(
          Object.entries(rawRoles as Record<string, unknown>).filter(
            (e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== '',
          ),
        )
      : undefined;
  const accountRef =
    ref.kind === 'account'
      ? { provider: ref.provider, name: ref.name }
      : { provider: plan.resolvedSource.adapter.capabilities.provider, name: '*' };
  await deps.runtime.applyProxyEndpoint(plan.client, {
    endpoint,
    apiKey: plan.transport.managedProxy?.token ?? 'anypick-proxy',
    defaultModel: modelRoles?.default ?? modelId,
    modelRoles,
    accountRef,
    dryRun: false,
    verbose: opts.verbose,
    // Canonical source id (hub:default, grok/work, …) so live sticky routes match bindings.
    label: displayRef(plan.resolvedSource.ref),
    recovery,
  });
}

function hubNameForStep(step: PlanStep, plan: ActivationPlan): string {
  const name = typeof step.params?.hub === 'string' ? step.params.hub : undefined;
  if (name) {
    return name;
  }
  if (plan.resolvedSource.ref.kind === 'proxy-hub') {
    return plan.resolvedSource.ref.name;
  }
  throw new Error('Internal plan error: Proxy Hub step has no hub name');
}

function requireProxyHub(deps: ExecutorDeps): NonNullable<ExecutorDeps['hub']> {
  if (!deps.hub) {
    throw new Error('Proxy Hub service is unavailable in this composition.');
  }
  return deps.hub;
}

/** Drop a client's persistent Hub route when it leaves the Hub for another source. */
async function detachClientHubRoute(deps: ExecutorDeps, clientId: string): Promise<void> {
  try {
    await deps.hub?.detachRoute(`global/${clientId}`);
  } catch {
    // Hub may be unavailable in some compositions / tests.
  }
}

function routeIdForStep(step: PlanStep): string {
  const routeId = typeof step.params?.routeId === 'string' ? step.params.routeId : undefined;
  if (!routeId) {
    throw new Error('Internal plan error: Proxy Hub route step has no route id');
  }
  return routeId;
}

function requestedHubModels(plan: ActivationPlan): string[] {
  // Prefer Desktop role order (default → list2…list5) so attachRoute aliases
  // pin the same slots Configure Models chose. Fall back to explicit model.
  const models: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    if (typeof raw !== 'string') {
      return;
    }
    const model = raw.trim();
    if (!model || seen.has(model)) {
      return;
    }
    seen.add(model);
    models.push(model);
  };
  const rawRoles = plan.bindingSpec?.clientOptions?.modelRoles;
  if (rawRoles && typeof rawRoles === 'object' && !Array.isArray(rawRoles)) {
    const roles = rawRoles as Record<string, unknown>;
    for (const id of ['default', 'list2', 'list3', 'list4', 'list5'] as const) {
      push(roles[id]);
    }
    for (const value of Object.values(roles)) {
      push(value);
    }
  }
  if (plan.model.mode === 'explicit') {
    push(plan.model.id);
  }
  return models;
}

/** Persist file compensation before a client adapter is permitted to mutate. */
async function prepareClientRecovery(
  clientId: string,
  deps: ExecutorDeps,
  ctx: ActivationContext,
  journalId: string,
): Promise<ClientConfigRecovery> {
  const recovery = await deps.runtime.prepareClientConfigRecovery(clientId, journalId);
  ctx.backupPaths.push(...recovery.backupPaths);
  deps.journal.update(journalId, { backupPaths: ctx.backupPaths });
  return recovery;
}

/**
 * Unwind a failed activation in reverse. Returns true when every recorded
 * inverse operation completed (state fully restored).
 */
async function runRollback(
  ctx: ActivationContext,
  deps: ExecutorDeps,
  journalId: string,
): Promise<boolean> {
  if (!ctx.mutated) {
    return true;
  }
  deps.journal.update(journalId, { state: 'rolling_back' });
  return runUndo(ctx);
}

async function runUndo(ctx: ActivationContext): Promise<boolean> {
  let allUndone = true;
  for (let i = ctx.undo.length - 1; i >= 0; i--) {
    try {
      await ctx.undo[i]();
    } catch {
      allUndone = false;
    }
  }
  return allUndone;
}

/**
 * A successful `run` is still scoped: when its child exits we reverse every
 * setup side effect (temporary home, native auth, proxy and lease). The closure
 * is idempotent because signal/error paths can race normal child exit.
 */
function makeEphemeralCleanup(ctx: ActivationContext, deps: ExecutorDeps): () => Promise<void> {
  let cleanup: Promise<void> | undefined;
  return async () => {
    cleanup ??= (async () => {
      const restored = await runUndo(ctx);
      for (const leaseId of ctx.leaseIds) {
        deps.leases.release(leaseId);
      }
      if (!restored) {
        throw anypickError(
          'Ephemeral run cleanup could not restore all local state. Run anypick doctor before switching accounts.',
          'EPHEMERAL_CLEANUP_FAILED',
        );
      }
    })();
    return cleanup;
  };
}

async function finalizeJournal(
  deps: ExecutorDeps,
  journalId: string,
  rolledBack: boolean,
): Promise<void> {
  try {
    deps.journal.update(journalId, { state: rolledBack ? 'rolled_back' : 'failed' });
  } catch {
    // journal update failure must not mask the original error
  }
}

export interface RecoveryDeps extends Pick<ExecutorDeps, 'journal'> {
  /** When present, recovery re-resolves source adapters from journal ResourceRefs. */
  resolve?: ResolveSourceDeps;
  /** Structured event sink for refusing recovery that cannot be made exact (OBS-01). */
  events?: AnyPickEventSink;
}

export interface RecoveryResult {
  recovered: number;
  failed: string[];
  /** Entries where source/adapter could not be re-resolved exactly (no forward exec). */
  refused: string[];
}

/**
 * Parse a canonical resource ref from journal params / affectedResources.
 */
function sourceRefFromJournal(entry: {
  params?: Record<string, unknown>;
  affectedResources: string[];
}): ResourceRef | null {
  const raw =
    (typeof entry.params?.source === 'string' ? entry.params.source : undefined) ??
    entry.affectedResources.find(
      (r) =>
        r.startsWith('account/') ||
        r.startsWith('gateway/') ||
        r.startsWith('hub/') ||
        r.startsWith('preset/'),
    );
  if (!raw) {
    return null;
  }
  try {
    return parseRef(raw);
  } catch {
    return null;
  }
}

/**
 * Startup recovery: re-resolve adapters from stored ResourceRef values;
 * complete exact rollbacks when possible; never substitute another source (spec §23.4).
 */
export async function recoverIncompleteOperations(deps: RecoveryDeps): Promise<RecoveryResult> {
  const incomplete = deps.journal.listIncomplete();
  const failed: string[] = [];
  const refused: string[] = [];
  let recovered = 0;
  const emit = makeEmitter(deps.events);

  for (const entry of incomplete) {
    // Re-resolve source adapter from stored canonical ref when possible
    const sourceRef = sourceRefFromJournal(entry);
    let reResolvedOk = true;

    if (sourceRef && deps.resolve) {
      if (sourceRef.kind === 'preset') {
        // Presets must never be forward-executed from journal; mark failed
        reResolvedOk = false;
      } else {
        try {
          const resolved = await materializeResolvedSource(sourceRef, deps.resolve);
          const identity = serializeRef(resolved.ref);
          const expected =
            typeof entry.params?.source === 'string'
              ? entry.params.source
              : serializeRef(sourceRef);
          if (identity !== expected) {
            reResolvedOk = false;
          }
          // Touch adapter.transportFor to ensure it is live (not a serialized object)
          if (typeof resolved.adapter.transportFor !== 'function') {
            reResolvedOk = false;
          }
        } catch {
          reResolvedOk = false;
        }
      }
    } else if (sourceRef && !deps.resolve) {
      // Without resolve deps we cannot re-resolve — refuse forward paths later
      reResolvedOk = false;
    }

    let restoredDurableState = false;

    // Exact file rollback from recorded backups (no adapter substitution)
    if (entry.backupPaths.length > 0) {
      try {
        let allRestored = true;
        for (const backup of entry.backupPaths) {
          // backupPaths entries are either "src=>dest" or plain backup file paths
          if (backup.includes('=>')) {
            const [src, dest] = backup.split('=>').map((s) => s.trim());
            if (!src || !dest) {
              allRestored = false;
              break;
            }
            if (src === 'delete') {
              const { rm } = await import('node:fs/promises');
              await rm(dest, { force: true });
              continue;
            }
            if (!(await pathExists(src))) {
              allRestored = false;
              break;
            }
            await mkdir(dirname(dest), { recursive: true });
            await copyFile(src, dest);
          } else if (!(await pathExists(backup))) {
            allRestored = false;
            break;
          }
        }
        if (allRestored) {
          restoredDurableState = true;
        } else {
          deps.journal.update(entry.id, { state: 'failed' });
          failed.push(entry.id);
          continue;
        }
      } catch {
        deps.journal.update(entry.id, { state: 'failed' });
        failed.push(entry.id);
        continue;
      }
    }

    // Persistent native-auth switches store their exact checkpoint before the
    // provider is allowed to restore anything. Recover it after client config
    // (reverse mutation order) and only then mark the journal terminal.
    const rawCheckpoint = entry.params?.nativeAuthCheckpoint;
    if (isLiveAuthCheckpoint(rawCheckpoint)) {
      if (!deps.resolve) {
        deps.journal.update(entry.id, { state: 'failed' });
        failed.push(entry.id);
        continue;
      }
      try {
        await deps.resolve.accounts.restoreLiveAuthCheckpoint(rawCheckpoint);
        await deps.resolve.accounts.discardLiveAuthCheckpoint(rawCheckpoint);
        restoredDurableState = true;
      } catch {
        deps.journal.update(entry.id, { state: 'failed' });
        failed.push(entry.id);
        continue;
      }
    }

    if (restoredDurableState) {
      deps.journal.update(entry.id, { state: 'rolled_back' });
      recovered++;
      continue;
    }

    // Never forward-execute when original source cannot be re-resolved exactly
    if (sourceRef && !reResolvedOk) {
      deps.journal.update(entry.id, { state: 'failed' });
      refused.push(entry.id);
      failed.push(entry.id);
      emit(
        'warn',
        'recovery_refused',
        'Journal recovery refused: source could not be re-resolved exactly',
        {
          opId: entry.id,
          context: { reason: 'source-not-reresolvable', resourceIds: entry.affectedResources },
        },
      );
      continue;
    }

    if (entry.state === 'planned') {
      // Never started — mark failed, no mutation
      deps.journal.update(entry.id, { state: 'failed' });
      recovered++;
      continue;
    }

    // executing / verifying / rolling_back without backups: cannot safely continue
    deps.journal.update(entry.id, { state: 'failed' });
    failed.push(entry.id);
  }

  return { recovered, failed, refused };
}

function isLiveAuthCheckpoint(value: unknown): value is LiveAuthCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const checkpoint = value as Partial<LiveAuthCheckpoint>;
  return (
    typeof checkpoint.providerId === 'string' &&
    (typeof checkpoint.activeAccount === 'string' || checkpoint.activeAccount === null) &&
    typeof checkpoint.hadLiveAuth === 'boolean' &&
    typeof checkpoint.directory === 'string'
  );
}
