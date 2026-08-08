import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  ApplyContext,
  ClientAdapter,
  ClientInspectResult,
  ClientLiveState,
  ClientState,
  IsolatablePath,
  IsolatedClientRuntime,
  ResolvedClientPlan,
} from '../types';
import { AnyPickError } from '../utils/errors';
import { ensureDir, pathExists, readJsonFile, writeJsonFile } from '../utils/fs';
import { resolveFromContext } from './resolve';
import { removeClientEnvFiles, ANYPICK_MANAGED_KEY } from './env-files';
import {
  createTempRuntimeRoot,
  makeIsolatedRuntime,
  materializeIsolatablePaths,
  syntheticProxyProfile,
} from './isolation';
import { CLAUDE_MODEL_ROLES } from './model-roles';
import { applyClaudeToHome, settingsPath } from './claude-client-apply';
export { bareModelId } from './claude-client-apply';

function effectiveHome(ctx: ApplyContext, liveHome: string): string {
  return ctx.isolatedHome ?? liveHome;
}

export function createClaudeCodeClient(home = process.env.HOME ?? homedir()): ClientAdapter {
  const liveSettings = settingsPath(home);

  const adapter: ClientAdapter = {
    id: 'claude',
    name: 'Claude Code',
    shortName: 'Claude',
    binaryName: 'claude',
    binaryEnvVar: 'CLAUDE_BINARY',
    description: 'Anthropic Claude Code CLI / IDE',
    supportedApiStyles: ['openai', 'anthropic', 'custom'],
    nativeInstallations: [
      {
        sourceId: 'claude-code',
        executables: ['claude'],
        macApplications: ['Claude.app'],
      },
    ],
    routingSurfacePolicy: 'all-compatible',
    capabilities: {
      id: 'claude',
      acceptedProtocols: ['anthropic'],
      supportsEnvironmentOverlay: false,
      supportsIsolatedHome: true,
      supportsPersistentConfig: true,
      protocolPreference: 'anthropic',
    },
    modelRoles: () => CLAUDE_MODEL_ROLES,

    async validate(ctx: ApplyContext): Promise<void> {
      const r = resolveFromContext(ctx);
      if (!r.endpoint) {
        throw new AnyPickError(
          'Profile has no endpoint. Set with: profile edit <name> --endpoint …',
          'CLIENT_CONFIG_INVALID',
        );
      }
    },

    async apply(ctx: ApplyContext) {
      const targetHome = effectiveHome(ctx, home);
      return applyClaudeToHome(ctx, targetHome);
    },

    async listIsolatablePaths(liveState: ClientLiveState): Promise<readonly IsolatablePath[]> {
      return [
        {
          sourcePath: settingsPath(liveState.home),
          destinationPath: join('.claude', 'settings.json'),
          kind: 'file',
          required: false,
        },
      ];
    },

    async createIsolatedRuntime(
      plan: ResolvedClientPlan,
      paths: readonly IsolatablePath[],
    ): Promise<IsolatedClientRuntime> {
      const runtimeRoot = await createTempRuntimeRoot('anypick-claude-');
      const isoHome = join(runtimeRoot, 'home');
      await ensureDir(isoHome);

      await materializeIsolatablePaths(isoHome, paths);

      const endpoint =
        plan.transport.endpoint ??
        (plan.transport.managedProxy ? `http://127.0.0.1:${plan.transport.managedProxy.port}` : '');

      const profile =
        plan.profile ??
        syntheticProxyProfile({
          name: `ephemeral-${plan.source.display}`,
          endpoint,
          apiKey: 'anypick-proxy',
          defaultModel: plan.model.mode === 'explicit' ? plan.model.id : undefined,
        });

      const ctx: ApplyContext = {
        profile: {
          ...profile,
          meta: { ...profile.meta, endpoint },
          secrets: {
            ...profile.secrets,
            apiKey: profile.secrets.apiKey ?? 'anypick-proxy',
          },
        },
        clientId: 'claude',
        dryRun: plan.dryRun,
        verbose: plan.verbose,
        proxyEndpoint: endpoint || undefined,
        anypickRoot: plan.anypickRoot,
        isolatedHome: isoHome,
      };

      if (!plan.dryRun) {
        await adapter.validate(ctx);
        await applyClaudeToHome(ctx, isoHome);
      }

      return makeIsolatedRuntime(runtimeRoot, {
        HOME: isoHome,
      });
    },

    async applyPersistent(plan: ResolvedClientPlan) {
      const profile =
        plan.profile ??
        syntheticProxyProfile({
          name: `proxy-${plan.source.display}`,
          endpoint: plan.transport.endpoint ?? '',
          apiKey: 'anypick-proxy',
          defaultModel: plan.model.mode === 'explicit' ? plan.model.id : undefined,
        });
      const endpoint =
        plan.transport.endpoint ??
        (plan.transport.managedProxy
          ? `http://127.0.0.1:${plan.transport.managedProxy.port}`
          : (profile.meta.endpoint ?? ''));
      const ctx: ApplyContext = {
        profile: {
          ...profile,
          meta: { ...profile.meta, endpoint },
        },
        clientId: 'claude',
        dryRun: plan.dryRun,
        verbose: plan.verbose,
        proxyEndpoint: endpoint || undefined,
        anypickRoot: plan.anypickRoot,
      };
      await adapter.validate(ctx);
      return applyClaudeToHome(ctx, home);
    },

    async reset(state: ClientState): Promise<void> {
      await removeClientEnvFiles(stateHomeRoot(state), 'claude');

      const anypickRoot = inferAnyPickRoot(state) ?? process.env.ANYPICK_HOME;
      if (anypickRoot) {
        await removeClientEnvFiles(anypickRoot, 'claude');
      }

      if (await pathExists(liveSettings)) {
        try {
          const doc = await readJsonFile<Record<string, unknown>>(liveSettings);
          const managed = doc[ANYPICK_MANAGED_KEY] as { keys?: string[] } | undefined;
          const keys = [
            ...(managed?.keys ?? state.managedEnvKeys ?? []),
            'OPENAI_API_KEY',
            'OPENAI_BASE_URL',
            'OPENAI_MODEL',
          ];
          if (doc.env && typeof doc.env === 'object') {
            const env = { ...(doc.env as Record<string, string>) };
            for (const key of keys) {
              delete env[key];
            }
            if (Object.keys(env).length === 0) {
              delete doc.env;
            } else {
              doc.env = env;
            }
          }
          delete doc[ANYPICK_MANAGED_KEY];
          await writeJsonFile(liveSettings, doc, 0o600);
        } catch (err) {
          // Never report a successful reset when the file that may contain a
          // managed endpoint/token could not be inspected safely.
          throw new Error(
            `Could not safely reset Claude Code settings: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
      }
    },

    async inspect(): Promise<ClientInspectResult> {
      const present = await pathExists(liveSettings);
      const issues: string[] = [];
      let summary: string | undefined;
      if (present) {
        try {
          const doc = await readJsonFile<Record<string, unknown>>(liveSettings);
          const managed = doc[ANYPICK_MANAGED_KEY] as { keys?: string[] } | undefined;
          const env =
            doc.env && typeof doc.env === 'object' ? (doc.env as Record<string, string>) : {};
          if (env.OPENAI_API_KEY || env.OPENAI_BASE_URL) {
            issues.push(
              'settings.env still has OPENAI_* keys (not used by Claude Code) — re-run runtime use or reset',
            );
          }
          for (const k of [
            'ANTHROPIC_MODEL',
            'ANTHROPIC_DEFAULT_SONNET_MODEL',
            'ANTHROPIC_DEFAULT_OPUS_MODEL',
            'ANTHROPIC_DEFAULT_HAIKU_MODEL',
          ]) {
            const v = env[k];
            if (v && v.includes('/')) {
              issues.push(`${k}="${v}" has a provider prefix; Claude Code expects bare model ids`);
            }
          }
          summary = managed?.keys?.length
            ? `anypick-managed env keys: ${managed.keys.length}`
            : 'settings present (no anypick marker)';
        } catch {
          issues.push('settings.json unreadable');
        }
      }
      return {
        present,
        configPaths: [liveSettings],
        summary,
        issues: issues.length ? issues : undefined,
      };
    },
  };

  return adapter;
}

function inferAnyPickRoot(state: ClientState): string | undefined {
  for (const p of state.managedPaths) {
    const idx = p.replace(/\\/g, '/').indexOf('/clients/claude/');
    if (idx > 0) {
      return p.slice(0, idx);
    }
  }
  return undefined;
}

function stateHomeRoot(state: ClientState): string {
  return inferAnyPickRoot(state) ?? process.env.ANYPICK_HOME ?? join(homedir(), '.anypick');
}

export const claudeCodeClient = createClaudeCodeClient();
