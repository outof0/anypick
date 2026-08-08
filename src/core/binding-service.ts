/**
 * Orchestration for use / run / link / reset / current (spec primary verbs).
 */

import type { ActivationPlan, BindingProvenance, BindingSpec, ClientId } from '../types';
import { hotplugError, ExitCode } from '../utils/errors';
import { planActivation, planFromWith } from './activation-planner';
import { executeActivation, type ExecuteResult, type ExecutorDeps } from './activation-executor';
import { resolveEffectiveBinding, type ResolveSourceDeps } from './resolve-source';
import { resolveProjectRoot } from './project-root';
import type { ClientRegistry } from '../clients/registry';
import type { PresetStore } from './preset-store';

export interface BindingServiceDeps extends ExecutorDeps {
  clients: ClientRegistry;
  presets: PresetStore;
}

export interface UseOptions {
  with?: string;
  current?: boolean;
  model?: string;
  /** Role id → model id (stored on binding; applied to client settings). */
  modelRoles?: Record<string, string>;
  save?: string;
  dryRun?: boolean;
  verbose?: boolean;
  /** Interactive TTY: re-apply existing or open picker (caller supplies with). */
  allowMissingSource?: boolean;
}

export interface RunOptions {
  with?: string;
  model?: string;
  dryRun?: boolean;
  verbose?: boolean;
  childArgs?: string[];
  cwd?: string;
}

export interface LinkOptions {
  with?: string;
  model?: string;
  dryRun?: boolean;
  verbose?: boolean;
  cwd?: string;
}

export class BindingService {
  constructor(private readonly deps: BindingServiceDeps) {}

  /**
   * hotplug use <client> [--with <source|@preset> | --current]
   */
  async use(
    client: ClientId,
    opts: UseOptions = {},
  ): Promise<ExecuteResult & { savedPreset?: string }> {
    this.requireClient(client);

    if (opts.current && opts.with) {
      throw hotplugError('--current is mutually exclusive with --with.', 'INVALID_USAGE', {
        exitCode: ExitCode.INVALID_USAGE,
      });
    }
    if (opts.current && (opts.model || opts.save)) {
      throw hotplugError(
        '--current is mutually exclusive with --model and --save.',
        'INVALID_USAGE',
        { exitCode: ExitCode.INVALID_USAGE },
      );
    }

    let plan: ActivationPlan;

    // --current: re-apply stored global snapshot (never dereference preset)
    if (opts.current) {
      if (opts.with) {
        throw hotplugError('--current is mutually exclusive with --with.', 'INVALID_USAGE', {
          exitCode: ExitCode.INVALID_USAGE,
        });
      }
      const existing = this.deps.bindings.getGlobal(client);
      if (!existing) {
        throw hotplugError(
          `No global binding for ${client}. Use --with <source> first.`,
          'NO_ACTIVE_BINDING',
          {
            exitCode: ExitCode.CAPABILITY_CONFLICT,
            suggestions: [`hotplug use ${client} --with <source>`],
          },
        );
      }
      return this.reapplyStoredBinding('persistent', client, existing.spec, existing.provenance, {
        dryRun: opts.dryRun,
        verbose: opts.verbose,
      });
    }

    // Bare client without --with:
    //   allowMissingSource (TTY): re-apply existing global, else caller opens picker
    //   otherwise (non-TTY): exit 2
    if (!opts.with) {
      if (opts.allowMissingSource) {
        const existing = this.deps.bindings.getGlobal(client);
        if (existing) {
          return this.reapplyStoredBinding(
            'persistent',
            client,
            existing.spec,
            existing.provenance,
            { dryRun: opts.dryRun, verbose: opts.verbose },
          );
        }
        // No binding — signal caller to open picker
        throw hotplugError(`No global binding for ${client}.`, 'MISSING_SOURCE', {
          exitCode: ExitCode.INVALID_USAGE,
          suggestions: [`hotplug use ${client} --with <source>`],
          details: { needsPicker: true },
        });
      }
      throw hotplugError(
        `A source or --current is required.\n\nSpecify a source:\n  hotplug use ${client} --with grok/work\n  hotplug use ${client} --with openrouter-work\n\nOr re-apply the stored global binding:\n  hotplug use ${client} --current`,
        'MISSING_SOURCE',
        {
          exitCode: ExitCode.INVALID_USAGE,
          suggestions: [`hotplug use ${client} --with <source>`, `hotplug use ${client} --current`],
        },
      );
    }

    plan = await planFromWith('persistent', client, opts.with, this.deps, {
      model: opts.model,
      modelRoles: opts.modelRoles,
      dryRun: opts.dryRun,
      verbose: opts.verbose,
    });

    const result = await executeActivation(plan, this.deps, {
      dryRun: opts.dryRun,
      verbose: opts.verbose,
    });

    this.recordSuccessfulSourceResume(plan.bindingSpec, opts.dryRun);

    // --save is independent of binding idempotency: always honor save intent
    // even when the binding was already active (no file rewrite).
    const savedPreset = this.maybeSavePreset(opts.save, plan, opts.dryRun);

    return { ...result, savedPreset };
  }

  /**
   * Explicit preset save from a planned binding spec.
   * Decoupled from whether activation mutated state.
   */
  private maybeSavePreset(
    saveName: string | undefined,
    plan: ActivationPlan,
    dryRun?: boolean,
  ): string | undefined {
    if (!saveName || dryRun || !plan.bindingSpec) {
      return undefined;
    }

    const model =
      plan.bindingSpec.model.mode === 'explicit' || plan.bindingSpec.model.mode === 'omitted'
        ? plan.bindingSpec.model
        : ({ mode: 'omitted' } as const);

    const existing = this.deps.presets.getByName(saveName);
    if (existing) {
      // Update in place (new revision) so --save is not a no-op when re-used
      this.deps.presets.update(saveName, {
        spec: {
          client: plan.bindingSpec.client,
          source: plan.bindingSpec.source,
          model,
          transportPolicy: plan.bindingSpec.transportPolicy,
          clientOptions: plan.bindingSpec.clientOptions,
        },
      });
    } else {
      this.deps.presets.create(saveName, {
        client: plan.bindingSpec.client,
        source: plan.bindingSpec.source,
        model,
        transportPolicy: plan.bindingSpec.transportPolicy,
        clientOptions: plan.bindingSpec.clientOptions,
      });
    }
    return saveName;
  }

  /**
   * hotplug run <client> [--with] — plan + execute ephemeral (or dry-run).
   * Child spawn is handled by CLI layer; this returns the plan/result for setup.
   */
  async runPrepare(client: ClientId, opts: RunOptions = {}): Promise<ExecuteResult> {
    this.requireClient(client);
    const projectRoot = resolveProjectRoot(opts.cwd);

    let plan: ActivationPlan;

    if (opts.with) {
      plan = await planFromWith('ephemeral', client, opts.with, this.deps, {
        model: opts.model,
        dryRun: opts.dryRun,
        verbose: opts.verbose,
      });
    } else {
      const effective = resolveEffectiveBinding(client, this.deps, projectRoot);
      const source = effective.binding.spec.source;
      if (source.kind === 'preset') {
        throw hotplugError('Binding snapshot has invalid preset pointer.', 'STATE_CONFLICT', {
          exitCode: ExitCode.CAPABILITY_CONFLICT,
        });
      }
      plan = await planActivation(
        {
          mode: 'ephemeral',
          client,
          source,
          model:
            effective.binding.spec.model.mode === 'explicit'
              ? effective.binding.spec.model.id
              : undefined,
          childArgs: opts.childArgs,
        },
        this.deps,
        {
          reapplySnapshot: {
            spec: effective.binding.spec,
            provenance: effective.binding.provenance,
          },
          dryRun: opts.dryRun,
          verbose: opts.verbose,
        },
      );
    }

    // Ephemeral must not commit bindings and must not patch live client config (P8 / §9.7.1)
    if (opts.dryRun) {
      return {
        plan,
        dryRun: true,
        alreadyActive: false,
        proxyEndpoint: plan.transport.endpoint,
      };
    }

    // Delegate to the shared activation pipeline. The planner emits an
    // isolated-home or environment-overlay runtime plus SpawnChild; ephemeral
    // execution never writes native auth. The executor builds that session —
    // no parallel implementation lives in the CLI layer.
    return executeActivation(plan, this.deps, {
      dryRun: opts.dryRun,
      verbose: opts.verbose,
      projectRoot: resolveProjectRoot(opts.cwd),
    });
  }

  /**
   * hotplug link <client> [--with]
   */
  async link(client: ClientId, opts: LinkOptions = {}): Promise<ExecuteResult> {
    this.requireClient(client);
    const projectRoot = resolveProjectRoot(opts.cwd);

    if (opts.with) {
      const plan = await planFromWith('project', client, opts.with, this.deps, {
        model: opts.model,
        projectRoot,
        dryRun: opts.dryRun,
        verbose: opts.verbose,
      });
      return executeActivation(plan, this.deps, {
        dryRun: opts.dryRun,
        verbose: opts.verbose,
        projectRoot,
      });
    }

    // Without --with: global → existing project → error
    const global = this.deps.bindings.getGlobal(client);
    if (global) {
      const plan = await planActivation(
        {
          mode: 'project',
          client,
          source: global.spec.source.kind === 'preset' ? undefined : global.spec.source,
          projectRoot,
        },
        this.deps,
        {
          reapplySnapshot: {
            spec: global.spec,
            provenance: {
              kind: 'global_binding_snapshot',
              globalBindingUpdatedAt: global.updatedAt,
            },
          },
          projectRoot,
        },
      );
      // Force provenance for link-from-global (planner may have chosen another)
      plan.provenance = {
        kind: 'global_binding_snapshot',
        globalBindingUpdatedAt: global.updatedAt,
      };
      if (plan.bindingSpec) {
        plan.bindingSpec = { ...global.spec };
      }
      return executeActivation(plan, this.deps, {
        dryRun: opts.dryRun,
        projectRoot,
      });
    }

    const existing = this.deps.bindings.getProject(projectRoot, client);
    if (existing) {
      return this.reapplyStoredBinding('project', client, existing.spec, existing.provenance, {
        dryRun: opts.dryRun,
        verbose: opts.verbose,
        projectRoot,
      });
    }

    throw hotplugError(
      `No global or project binding for ${client} to link.\n\nSet a global binding first:\n  hotplug use ${client} --with <source>\n\nOr link with an explicit source:\n  hotplug link ${client} --with <source>`,
      'NO_ACTIVE_BINDING',
      {
        exitCode: ExitCode.CAPABILITY_CONFLICT,
        suggestions: [
          `hotplug use ${client} --with <source>`,
          `hotplug link ${client} --with <source>`,
        ],
      },
    );
  }

  async unlink(client?: ClientId, cwd?: string): Promise<number> {
    const projectRoot = resolveProjectRoot(cwd);
    if (client) {
      this.requireClient(client);
      return this.deps.bindings.deleteProject(projectRoot, client) ? 1 : 0;
    }
    return this.deps.bindings.deleteProject(projectRoot);
  }

  async reset(
    client: ClientId,
    opts: { dryRun?: boolean } = {},
  ): Promise<{ client: ClientId; removedGlobal: boolean; dryRun: boolean }> {
    this.requireClient(client);
    if (opts.dryRun) {
      const g = this.deps.bindings.getGlobal(client);
      return { client, removedGlobal: Boolean(g), dryRun: true };
    }
    const removedGlobal = this.deps.bindings.deleteGlobal(client);
    try {
      await this.deps.runtime.reset(client, { dryRun: false });
    } catch {
      // client may have no runtime state
    }
    return { client, removedGlobal, dryRun: false };
  }

  current(client?: ClientId, cwd?: string) {
    const projectRoot = resolveProjectRoot(cwd);
    const clients = client
      ? [this.requireClient(client)]
      : this.deps.clients.list().map((c) => c.id);

    return clients.map((id) => {
      const project = this.deps.bindings.getProject(projectRoot, id);
      const global = this.deps.bindings.getGlobal(id);
      const effective = project ?? global ?? null;
      const scope = project ? 'project' : global ? 'global' : null;
      return {
        client: id,
        clientName: this.deps.clients.get(id).name,
        scope,
        binding: effective,
        global,
        project,
        projectRoot,
      };
    });
  }

  private requireClient(client: ClientId): ClientId {
    if (!this.deps.clients.has(client)) {
      throw hotplugError(`Unknown client "${client}".`, 'CLIENT_NOT_FOUND', {
        exitCode: ExitCode.NOT_FOUND,
        suggestions: [`Known: ${this.deps.clients.ids().join(', ')}`],
      });
    }
    return client;
  }

  /**
   * Single path for "re-apply a stored binding" (use --current, use without
   * --with on a TTY, link from global/project). Replaces the ad-hoc
   * planActivation+executeActivation copies that previously differed only in
   * their surrounding error handling. `source` is taken from the stored spec
   * (preset pointers are dereferenced to undefined so the planner re-expands).
   */
  private async reapplyStoredBinding(
    mode: ActivationPlan['mode'],
    client: ClientId,
    spec: BindingSpec,
    provenance: BindingProvenance,
    opts: {
      dryRun?: boolean;
      verbose?: boolean;
      projectRoot?: string;
      model?: string;
      childArgs?: string[];
    } = {},
  ): Promise<ExecuteResult> {
    const source = spec.source.kind === 'preset' ? undefined : spec.source;
    const plan = await planActivation(
      {
        mode,
        client,
        source,
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.childArgs ? { childArgs: opts.childArgs } : {}),
      },
      this.deps,
      {
        reapplySnapshot: { spec, provenance },
        ...(opts.projectRoot ? { projectRoot: opts.projectRoot } : {}),
      },
    );
    const result = await executeActivation(plan, this.deps, {
      dryRun: opts.dryRun,
      verbose: opts.verbose,
      ...(opts.projectRoot ? { projectRoot: opts.projectRoot } : {}),
    });
    if (mode === 'persistent') {
      this.recordSuccessfulSourceResume(plan.bindingSpec, opts.dryRun);
    }
    return result;
  }

  /** Resume history is an optional DX cache; never turn a good activation into a failure. */
  private recordSuccessfulSourceResume(spec: BindingSpec | undefined, dryRun?: boolean): void {
    if (dryRun || !spec) {
      return;
    }
    try {
      this.deps.bindings.recordSourceResume(spec);
    } catch {
      // Binding and native client configuration already succeeded. History can
      // be safely skipped and will be rebuilt after the next successful apply.
    }
  }
}

export type { ResolveSourceDeps };
