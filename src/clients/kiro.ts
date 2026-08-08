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
import { resolveFromContext } from './resolve';
import { removeClientEnvFiles, writeClientEnvFiles } from './env-files';
import { ensureDir, pathExists, writeTextFile } from '../utils/fs';
import {
  createTempRuntimeRoot,
  makeIsolatedRuntime,
  materializeIsolatablePaths,
  syntheticProxyProfile,
} from './isolation';
import { DEFAULT_MODEL_ROLE } from './model-roles';

async function applyKiroContext(ctx: ApplyContext) {
  const r = resolveFromContext(ctx);
  const env: Record<string, string> = {
    OPENAI_API_KEY: r.apiKey,
  };
  if (r.endpoint) {
    env.OPENAI_BASE_URL = r.endpoint;
  }
  if (r.defaultModel) {
    env.OPENAI_MODEL = r.defaultModel;
  }
  // Anthropic-compatible consumers of Kiro proxy
  if (r.endpoint) {
    env.ANTHROPIC_BASE_URL = r.endpoint;
    env.ANTHROPIC_AUTH_TOKEN = r.apiKey;
  }

  if (ctx.dryRun) {
    return {
      managedPaths: [
        join(ctx.hotplugRoot, 'clients', 'kiro', 'env.sh'),
        join(ctx.hotplugRoot, 'clients', 'kiro', 'env.ps1'),
      ],
      managedEnvKeys: Object.keys(env),
    };
  }

  if (ctx.isolatedHome) {
    // Write env into isolated tree only — never touch live hotplug root env files
    const isoHotplug = join(ctx.isolatedHome, '.hotplug');
    const envPaths = await writeClientEnvFiles(isoHotplug, 'kiro', env);
    // Also drop a small dotenv for launchers that source it
    const dotenv = join(ctx.isolatedHome, '.kiro-hotplug.env');
    await writeTextFile(
      dotenv,
      Object.entries(env)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join('\n') + '\n',
      0o600,
    );
    return {
      managedPaths: [...envPaths, dotenv],
      managedEnvKeys: Object.keys(env),
    };
  }

  const envPaths = await writeClientEnvFiles(ctx.hotplugRoot, 'kiro', env);
  return {
    managedPaths: envPaths,
    managedEnvKeys: Object.keys(env),
  };
}

/**
 * Kiro client adapter — primarily env-file based.
 * Native Kiro auth remains under account backup/restore (SSO cache files).
 *
 * Ephemeral run uses an isolated temporary HOME so live config is untouched.
 */
export function createKiroClient(home = process.env.HOME ?? homedir()): ClientAdapter {
  const adapter: ClientAdapter = {
    id: 'kiro',
    name: 'Kiro',
    description: 'Amazon Kiro (runtime env overlay)',
    supportedApiStyles: ['openai', 'anthropic', 'custom'],
    capabilities: {
      id: 'kiro',
      acceptedProtocols: ['openai', 'anthropic'],
      supportsEnvironmentOverlay: false,
      supportsIsolatedHome: true,
      supportsPersistentConfig: true,
      protocolPreference: 'anthropic',
    },
    modelRoles: () => DEFAULT_MODEL_ROLE,

    async validate(_ctx: ApplyContext): Promise<void> {
      // No key format/presence checks — local proxies use arbitrary tokens.
    },

    async apply(ctx: ApplyContext) {
      return applyKiroContext(ctx);
    },

    async listIsolatablePaths(_liveState: ClientLiveState): Promise<readonly IsolatablePath[]> {
      // Kiro runtime is env-driven; no live config files required.
      // Keep allowlist empty (still implements isolation via env in temp home).
      return [];
    },

    async createIsolatedRuntime(
      plan: ResolvedClientPlan,
      paths: readonly IsolatablePath[],
    ): Promise<IsolatedClientRuntime> {
      const runtimeRoot = await createTempRuntimeRoot('hotplug-kiro-');
      const isoHome = join(runtimeRoot, 'home');
      await ensureDir(isoHome);
      await materializeIsolatablePaths(isoHome, paths);

      const profile =
        plan.profile ??
        syntheticProxyProfile({
          name: `ephemeral-${plan.source.display}`,
          endpoint: plan.transport.endpoint ?? '',
          apiKey: 'hotplug-proxy',
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
          secrets: {
            ...profile.secrets,
            apiKey: profile.secrets.apiKey ?? 'hotplug-proxy',
          },
        },
        clientId: 'kiro',
        dryRun: plan.dryRun,
        verbose: plan.verbose,
        proxyEndpoint: endpoint || undefined,
        hotplugRoot: plan.hotplugRoot,
        isolatedHome: isoHome,
      };

      let env: Record<string, string>;
      if (!plan.dryRun) {
        await applyKiroContext(ctx);
        env = {
          HOME: isoHome,
          OPENAI_API_KEY: ctx.profile.secrets.apiKey ?? 'hotplug-proxy',
          ...(endpoint
            ? {
                OPENAI_BASE_URL: endpoint,
                ANTHROPIC_BASE_URL: endpoint,
                ANTHROPIC_AUTH_TOKEN: ctx.profile.secrets.apiKey ?? 'hotplug-proxy',
              }
            : {}),
        };
      } else {
        env = { HOME: isoHome };
      }

      return makeIsolatedRuntime(runtimeRoot, env);
    },

    async applyPersistent(plan: ResolvedClientPlan) {
      const profile =
        plan.profile ??
        syntheticProxyProfile({
          name: `proxy-${plan.source.display}`,
          endpoint: plan.transport.endpoint ?? '',
          apiKey: 'hotplug-proxy',
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
        clientId: 'kiro',
        dryRun: plan.dryRun,
        verbose: plan.verbose,
        proxyEndpoint: endpoint || undefined,
        hotplugRoot: plan.hotplugRoot,
      };
      return applyKiroContext(ctx);
    },

    async reset(state: ClientState): Promise<void> {
      const hotplugRoot =
        inferHotplugRoot(state) ?? process.env.HOTPLUG_HOME ?? join(homedir(), '.hotplug');
      await removeClientEnvFiles(hotplugRoot, 'kiro');
    },

    async inspect(): Promise<ClientInspectResult> {
      void home;
      void pathExists;
      return {
        present: true,
        configPaths: [],
        summary: 'Kiro runtime uses hotplug env files (account auth separate)',
      };
    },
  };

  return adapter;
}

function inferHotplugRoot(state: ClientState): string | undefined {
  for (const p of state.managedPaths) {
    const idx = p.replace(/\\/g, '/').indexOf('/clients/kiro/');
    if (idx > 0) {
      return p.slice(0, idx);
    }
  }
  return undefined;
}

export const kiroClient = createKiroClient();
