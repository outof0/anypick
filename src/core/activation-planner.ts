/**
 * Activation planner — structured plans for use / run / link (spec §22).
 */

import type {
  ActivationPlan,
  ActivationRequest,
  BindingProvenance,
  BindingSpec,
  ClientId,
  ModelSelection,
  PlanStep,
  PlanWarning,
  ResolvedSource,
  ResourceRef,
  RollbackStep,
} from '../types';
import { anypickError, ExitCode } from '../utils/errors';
import { displayRef, serializeRef } from './refs';
import {
  expandPreset,
  loadAccountForRef,
  loadProfileForRef,
  materializeResolvedSource,
  modelFromRequest,
  parseAndResolveSourceInput,
  type ResolveSourceDeps,
} from './resolve-source';
import type { ClientRegistry } from '../clients/registry';
import { mergeModelRolesIntoClientOptions, modelFromRolesOrSelection } from './activation-models';
import { buildTransport } from './activation-transport';
import { randomUUID } from 'node:crypto';

export interface PlanOptions {
  dryRun?: boolean;
  verbose?: boolean;
  /** When re-applying a stored binding snapshot (use --current). */
  reapplySnapshot?: {
    spec: BindingSpec;
    provenance: BindingProvenance;
  };
  savePreset?: string;
  projectRoot?: string;
  /** Origin for provenance when expanding a preset. */
  originPreset?: { id: string; name: string; revision: number };
  /** Role id → model id stored on binding clientOptions.modelRoles. */
  modelRoles?: Record<string, string>;
}

export async function planActivation(
  request: ActivationRequest,
  deps: ResolveSourceDeps & { clients: ClientRegistry },
  opts: PlanOptions = {},
): Promise<ActivationPlan> {
  const clientId = request.client;
  if (!deps.clients.has(clientId)) {
    throw anypickError(`Unknown client "${clientId}".`, 'CLIENT_NOT_FOUND', {
      exitCode: ExitCode.NOT_FOUND,
      suggestions: [`Known clients: ${deps.clients.ids().join(', ')}`],
    });
  }

  const client = deps.clients.get(clientId);
  const caps = client.capabilities;

  const steps: PlanStep[] = [];
  const rollback: RollbackStep[] = [];
  const warnings: PlanWarning[] = [];

  let resolvedSource: ResolvedSource;
  let model: ModelSelection;
  let bindingSpec: BindingSpec;
  let provenance: BindingProvenance = { kind: 'direct' };
  let sourceRef: ResourceRef;

  // Re-apply stored snapshot without re-resolving preset provenance
  if (opts.reapplySnapshot) {
    sourceRef = opts.reapplySnapshot.spec.source;
    if (sourceRef.kind === 'preset') {
      throw anypickError('Stored binding has invalid preset source pointer.', 'STATE_CONFLICT', {
        exitCode: ExitCode.CAPABILITY_CONFLICT,
      });
    }
    steps.push({
      kind: 'ResolveSource',
      detail: `Re-apply snapshot ${displayRef(sourceRef)}`,
      params: { ref: serializeRef(sourceRef) },
    });
    resolvedSource = await materializeResolvedSource(sourceRef, deps);
    model = opts.reapplySnapshot.spec.model;
    bindingSpec = { ...opts.reapplySnapshot.spec };
    provenance = opts.reapplySnapshot.provenance;
  } else if (request.preset || (request.source && request.source.kind === 'preset')) {
    const presetName =
      request.preset ?? (request.source?.kind === 'preset' ? request.source.name : undefined);
    if (!presetName) {
      throw anypickError('Preset name required.', 'INVALID_USAGE', {
        exitCode: ExitCode.INVALID_USAGE,
      });
    }
    steps.push({
      kind: 'ExpandPreset',
      detail: `@${presetName}`,
      params: { preset: presetName },
    });
    const expanded = await expandPreset(presetName, clientId, deps);
    resolvedSource = expanded.source;
    sourceRef = expanded.source.ref;
    model = modelFromRequest(request.model, expanded.model);
    bindingSpec = {
      ...expanded.bindingSpec,
      model,
      clientOptions: mergeModelRolesIntoClientOptions(
        expanded.bindingSpec.clientOptions,
        request.modelRoles ?? opts.modelRoles,
        model,
      ),
    };
    // Prefer default role from modelRoles when request.model was omitted
    model = modelFromRolesOrSelection(bindingSpec, model);
    bindingSpec = { ...bindingSpec, model };
    provenance = {
      kind: 'preset_snapshot',
      presetId: expanded.preset.id,
      presetNameAtSnapshot: expanded.preset.name,
      presetRevisionAtSnapshot: expanded.preset.revision,
    };
  } else if (request.source) {
    // Preset sources handled above; remaining are account | gateway
    sourceRef = request.source;
    steps.push({
      kind: 'ResolveSource',
      detail: displayRef(sourceRef),
      params: { ref: serializeRef(sourceRef) },
    });
    resolvedSource = await materializeResolvedSource(sourceRef, deps);
    model = modelFromRequest(request.model, { mode: 'omitted' });
    bindingSpec = {
      client: clientId,
      source: sourceRef,
      model,
      transportPolicy: 'auto',
      clientOptions: mergeModelRolesIntoClientOptions(
        {},
        request.modelRoles ?? opts.modelRoles,
        model,
      ),
    };
    model = modelFromRolesOrSelection(bindingSpec, model);
    bindingSpec = { ...bindingSpec, model };
    provenance = { kind: 'direct' };
  } else {
    throw anypickError('A source or --current is required.', 'MISSING_SOURCE', {
      exitCode: ExitCode.INVALID_USAGE,
      suggestions: [`anypick use ${clientId} --with <source>`, `anypick use ${clientId} --current`],
    });
  }

  // Validate compatibility / transport
  steps.push({ kind: 'ValidateCompatibility', detail: `${clientId} × ${resolvedSource.display}` });
  steps.push({ kind: 'ValidateCredential' });

  const capability = resolvedSource.adapter.transportFor(clientId);
  steps.push({
    kind: 'ResolveTransport',
    detail: capability,
    params: { capability },
  });

  if (capability === 'unsupported') {
    throw anypickError(
      `Source ${resolvedSource.display} cannot be used with client ${clientId} (unsupported transport).`,
      'UNSUPPORTED_TRANSPORT',
      {
        exitCode: ExitCode.CAPABILITY_CONFLICT,
        suggestions: ['Try a different source or client.', `anypick list`],
      },
    );
  }

  if (capability === 'external_manual_proxy') {
    steps.push({
      kind: 'ValidateExternalDependency',
      detail: 'external proxy executable required',
    });
  }

  const account = await loadAccountForRef(resolvedSource.ref, deps);
  const profile = await loadProfileForRef(resolvedSource.ref, deps);
  let poolPort: number | undefined;
  if (resolvedSource.ref.kind === 'account-pool' && deps.pools) {
    const pool = await deps.pools.get(resolvedSource.ref.provider);
    poolPort = pool?.port;
  }

  const transport = buildTransport(
    client.capabilities,
    resolvedSource,
    capability,
    account,
    profile,
    poolPort,
  );
  if (resolvedSource.ref.kind === 'proxy-hub') {
    const hubService = deps.hub;
    if (!hubService) {
      throw new Error('Proxy Hub service is unavailable in this composition.');
    }
    const hub = await hubService.get(resolvedSource.ref.name);
    transport.endpoint = `http://${hub.host}:${hub.port}`;
    transport.managedProxy = {
      provider: 'proxy-hub',
      account: hub.name,
      port: hub.port,
      leaseId: 'pending',
    };
  }

  // Model unknown handling
  if (model.mode === 'unknown') {
    warnings.push({
      code: 'MODEL_UNKNOWN',
      message: 'Migrated binding has unknown model; will not inject a model override.',
    });
  }

  // Proxy steps: only persistent use and ephemeral run own shared proxy
  // lifecycle. A project binding (`link`) records project-scoped metadata only
  // and must not start a proxy (or otherwise mutate live state) at link time —
  // the proxy is started when `run` resolves the binding into an isolated
  // session (spec decision #7).
  if (
    resolvedSource.ref.kind === 'proxy-hub' &&
    (request.mode === 'persistent' || request.mode === 'ephemeral')
  ) {
    const routeId =
      request.mode === 'persistent'
        ? `global/${clientId}`
        : `ephemeral/${clientId}/${randomUUID()}`;
    steps.push({ kind: 'EnsureProxyHub', params: { hub: resolvedSource.ref.name } });
    steps.push({
      kind: 'AttachProxyHubRoute',
      params: { hub: resolvedSource.ref.name, routeId },
    });
    steps.push({ kind: 'WaitForHubHealth', params: { hub: resolvedSource.ref.name } });
    steps.push({
      kind: 'ValidateProxyHubRoute',
      params: { hub: resolvedSource.ref.name, routeId },
    });
    rollback.push({
      kind: 'DetachProxyHubRoute',
      params: { hub: resolvedSource.ref.name, routeId },
    });
    rollback.push({
      kind: 'StopProxyHubIfStartedAndIdle',
      params: { hub: resolvedSource.ref.name },
    });
  } else if (
    (request.mode === 'persistent' || request.mode === 'ephemeral') &&
    (capability === 'managed_builtin_proxy' || capability === 'managed_external_proxy')
  ) {
    steps.push({ kind: 'AllocateProxyLease', params: { port: transport.managedProxy?.port } });
    steps.push({ kind: 'StartProxy' });
    steps.push({ kind: 'WaitForHealth' });
    rollback.push({ kind: 'ReleaseLease' });
    rollback.push({ kind: 'StopProxy' });
  }

  // Native auth writes are deliberately persistent-only. An ephemeral run must
  // never switch the machine's live login: a SIGKILL or power loss between the
  // switch and cleanup would otherwise leave the user on the wrong account.
  // Providers that need native credentials during `run` must first implement
  // isolated auth materialization for the target client.
  if (
    request.mode === 'ephemeral' &&
    resolvedSource.kind === 'account' &&
    resolvedSource.adapter.capabilities.requiresNativeAuthWrite &&
    capability === 'direct'
  ) {
    throw anypickError(
      `Safe ephemeral execution is not available for ${resolvedSource.display} × ${clientId}: this source requires live native auth. Use \`anypick use\` first or add an isolated-auth adapter.`,
      'UNSUPPORTED_TRANSPORT',
      { exitCode: ExitCode.CAPABILITY_CONFLICT },
    );
  }

  // Persistent activation is the only mode allowed to change native auth.
  if (
    request.mode === 'persistent' &&
    resolvedSource.kind === 'account' &&
    resolvedSource.adapter.capabilities.requiresNativeAuthWrite &&
    capability === 'direct'
  ) {
    steps.push({
      kind: 'WriteNativeAuth',
      detail: resolvedSource.display,
      params: { ref: serializeRef(resolvedSource.ref) },
    });
    rollback.push({ kind: 'RestoreNativeAuth' });
  }

  // Mode-specific steps
  if (request.mode === 'ephemeral') {
    // §9.7.1: Claude/Codex/Kiro must use CreateTemporaryClientHome, never live patch
    if (caps?.supportsIsolatedHome) {
      steps.push({ kind: 'CreateTemporaryClientHome' });
      rollback.push({ kind: 'RestoreTemporaryState' });
    } else if (caps?.supportsEnvironmentOverlay) {
      steps.push({ kind: 'CreateEnvironmentOverlay' });
      rollback.push({ kind: 'RestoreTemporaryState' });
    } else {
      throw anypickError(
        `Client ${clientId} cannot run ephemerally: no isolated home or environment overlay support.`,
        'UNSUPPORTED_TRANSPORT',
        { exitCode: ExitCode.CAPABILITY_CONFLICT },
      );
    }
    // Never emit CreateEnvironmentOverlay for isolated-home clients
    if (caps?.supportsIsolatedHome && steps.some((s) => s.kind === 'CreateEnvironmentOverlay')) {
      throw new Error('Internal planner error: CreateEnvironmentOverlay with supportsIsolatedHome');
    }
    steps.push({ kind: 'SpawnChild' });
  } else if (request.mode === 'project') {
    // SCOPE-01 (spec decision #7): a project binding records project-scoped
    // metadata only. It does NOT write the global client config, does NOT start
    // a proxy, and does NOT mutate live account selection. `run` inside the
    // project resolves this binding into an isolated ephemeral session.
    steps.push({
      kind: 'CommitProjectBinding',
      params: { projectRoot: opts.projectRoot ?? request.projectRoot },
    });
  } else {
    // persistent
    steps.push({ kind: 'InspectClientState' });
    steps.push({ kind: 'WriteClientConfig' });
    steps.push({ kind: 'VerifyEffectiveState' });
    steps.push({ kind: 'CommitGlobalBinding' });
  }

  // Gateway sources must never have WriteNativeAuth
  if (resolvedSource.kind === 'gateway') {
    const bad = steps.find((s) => s.kind === 'WriteNativeAuth');
    if (bad) {
      throw new Error('Internal planner error: WriteNativeAuth for gateway');
    }
  }
  if (resolvedSource.kind === 'proxy-hub') {
    const bad = steps.find((step) => step.kind === 'WriteNativeAuth');
    if (bad) {
      throw new Error('Internal planner error: WriteNativeAuth for Proxy Hub');
    }
  }

  return {
    mode: request.mode,
    client: clientId,
    resolvedSource,
    transport,
    model,
    steps,
    rollback,
    warnings,
    bindingSpec,
    provenance,
  };
}

/**
 * Plan from a raw --with string (parses ref / expands preset).
 */
export async function planFromWith(
  mode: ActivationRequest['mode'],
  client: ClientId,
  withInput: string,
  deps: ResolveSourceDeps & { clients: ClientRegistry },
  opts: PlanOptions & { model?: string; modelRoles?: Record<string, string> } = {},
): Promise<ActivationPlan> {
  const ref = await parseAndResolveSourceInput(withInput, deps);
  if (ref.kind === 'preset') {
    return planActivation(
      {
        mode,
        client,
        preset: ref.name,
        model: opts.model,
        modelRoles: opts.modelRoles,
        projectRoot: opts.projectRoot,
      },
      deps,
      opts,
    );
  }
  return planActivation(
    {
      mode,
      client,
      source: ref,
      model: opts.model,
      modelRoles: opts.modelRoles,
      projectRoot: opts.projectRoot,
    },
    deps,
    opts,
  );
}
