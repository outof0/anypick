/**
 * Gemini CLI client adapter.
 *
 * Persistent writes:
 * - ~/.hotplug/clients/gemini/env.sh (+ env.ps1)
 * - ~/.gemini/.env managed keys (GEMINI_API_KEY, GEMINI_MODEL, …)
 *
 * Gemini CLI primarily authenticates via API key or Google OAuth.
 * This adapter targets API-key / gateway-style apply. When the source is a
 * native Gemini account, activation uses direct auth restore (provider.restore)
 * rather than rewriting settings for a remote OpenAI proxy.
 */

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
import { HotplugError } from '../utils/errors';
import { ensureDir, pathExists } from '../utils/fs';
import { resolveFromContext } from './resolve';
import {
  managedMarker,
  removeClientEnvFiles,
  HOTPLUG_MANAGED_KEY,
  writeClientEnvFiles,
} from './env-files';
import {
  createTempRuntimeRoot,
  makeIsolatedRuntime,
  materializeIsolatablePaths,
  syntheticProxyProfile,
} from './isolation';
import { DEFAULT_MODEL_ROLE } from './model-roles';
import { upsertEnvFile } from '../providers/gemini';
import { writeJsonFile, readJsonFile } from '../utils/fs';
import { stripKeysFromEnv, stateHomeRoot } from './gemini-client-utils';

function geminiDir(home = process.env.HOME ?? homedir()): string {
  return process.env.GEMINI_CONFIG_DIR ?? join(home, '.gemini');
}

function envPath(home = process.env.HOME ?? homedir()): string {
  return join(geminiDir(home), '.env');
}

function settingsPath(home = process.env.HOME ?? homedir()): string {
  return join(geminiDir(home), 'settings.json');
}

function effectiveHome(ctx: ApplyContext, liveHome: string): string {
  return ctx.isolatedHome ?? liveHome;
}

export function createGeminiClient(home = process.env.HOME ?? homedir()): ClientAdapter {
  const liveEnv = envPath(home);
  const liveSettings = settingsPath(home);

  async function applyToHome(ctx: ApplyContext, targetHome: string) {
    const r = resolveFromContext(ctx);
    const targetEnv = envPath(targetHome);
    const targetSettings = settingsPath(targetHome);

    const env: Record<string, string> = {};
    if (r.apiKey) {
      env.GEMINI_API_KEY = r.apiKey;
    }
    if (r.endpoint) {
      // Best-effort: some forks / gateways honor a base URL override.
      env.GOOGLE_GEMINI_BASE_URL = r.endpoint;
      env.GEMINI_API_BASE_URL = r.endpoint;
    }
    if (r.defaultModel) {
      env.GEMINI_MODEL = r.defaultModel;
    }

    const extraEnv = r.overlay.env;
    if (extraEnv && typeof extraEnv === 'object' && !Array.isArray(extraEnv)) {
      for (const [k, v] of Object.entries(extraEnv)) {
        if (typeof v !== 'string') {
          continue;
        }
        if (
          k.startsWith('GEMINI_') ||
          k.startsWith('GOOGLE_') ||
          k === 'GOOGLE_APPLICATION_CREDENTIALS'
        ) {
          env[k] = v;
        }
      }
    }

    const managedPaths = [targetEnv, targetSettings];
    const managedEnvKeys = Object.keys(env);

    if (ctx.dryRun) {
      return {
        managedPaths: [
          ...managedPaths,
          join(ctx.hotplugRoot, 'clients', 'gemini', 'env.sh'),
          join(ctx.hotplugRoot, 'clients', 'gemini', 'env.ps1'),
        ],
        managedEnvKeys,
      };
    }

    // Existing user config is authoritative. A malformed JSON file must never
    // be replaced with an empty object, which would silently destroy unrelated
    // Gemini settings. Fail before writing env files or the .env target.
    let doc: Record<string, unknown> = {};
    if (await pathExists(targetSettings)) {
      try {
        const parsed = await readJsonFile<unknown>(targetSettings);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('root value is not an object');
        }
        doc = parsed as Record<string, unknown>;
      } catch (err) {
        throw new HotplugError(
          `Refusing to overwrite unreadable Gemini settings at ${targetSettings}: ${err instanceof Error ? err.message : String(err)}`,
          'CLIENT_CONFIG_INVALID',
        );
      }
    }

    let envPaths: string[] = [];
    if (!ctx.isolatedHome) {
      envPaths = await writeClientEnvFiles(ctx.hotplugRoot, 'gemini', env);
    }

    await ensureDir(geminiDir(targetHome));
    await upsertEnvFile(targetEnv, env);

    // Mark managed keys in settings.json (non-destructive)
    doc[HOTPLUG_MANAGED_KEY] = managedMarker(managedEnvKeys);
    await writeJsonFile(targetSettings, doc, 0o600);

    return {
      managedPaths: [...managedPaths, ...envPaths],
      managedEnvKeys,
    };
  }

  const adapter: ClientAdapter = {
    id: 'gemini',
    name: 'Gemini CLI',
    description: 'Google Gemini CLI (API key / env runtime)',
    supportedApiStyles: ['custom', 'openai'],
    capabilities: {
      id: 'gemini',
      acceptedProtocols: ['openai'],
      supportsEnvironmentOverlay: false,
      supportsIsolatedHome: true,
      supportsPersistentConfig: true,
      protocolPreference: 'openai',
    },
    modelRoles: () => DEFAULT_MODEL_ROLE,

    async validate(ctx: ApplyContext): Promise<void> {
      const r = resolveFromContext(ctx);
      // API key optional when user relies on OAuth account switch (direct transport)
      if (!r.apiKey && !r.endpoint) {
        throw new HotplugError(
          'Gemini apply needs an API key or endpoint. Use a gateway profile, or switch a Gemini account directly.',
          'CLIENT_CONFIG_INVALID',
        );
      }
    },

    async apply(ctx: ApplyContext) {
      return applyToHome(ctx, effectiveHome(ctx, home));
    },

    async listIsolatablePaths(liveState: ClientLiveState): Promise<readonly IsolatablePath[]> {
      return [
        {
          sourcePath: envPath(liveState.home),
          destinationPath: join('.gemini', '.env'),
          kind: 'file',
          required: false,
        },
        {
          sourcePath: settingsPath(liveState.home),
          destinationPath: join('.gemini', 'settings.json'),
          kind: 'file',
          required: false,
        },
      ];
    },

    async createIsolatedRuntime(
      plan: ResolvedClientPlan,
      paths: readonly IsolatablePath[],
    ): Promise<IsolatedClientRuntime> {
      const runtimeRoot = await createTempRuntimeRoot('hotplug-gemini-');
      const isoHome = join(runtimeRoot, 'home');
      await ensureDir(isoHome);
      await materializeIsolatablePaths(isoHome, paths);

      const endpoint = plan.transport.endpoint ?? '';
      const profile =
        plan.profile ??
        syntheticProxyProfile({
          name: `ephemeral-${plan.source.display}`,
          endpoint,
          apiKey: 'hotplug-proxy',
          defaultModel: plan.model.mode === 'explicit' ? plan.model.id : undefined,
        });

      const ctx: ApplyContext = {
        profile: {
          ...profile,
          meta: { ...profile.meta, endpoint: endpoint || profile.meta.endpoint },
          secrets: {
            ...profile.secrets,
            apiKey: profile.secrets.apiKey ?? 'hotplug-proxy',
          },
        },
        clientId: 'gemini',
        dryRun: plan.dryRun,
        verbose: plan.verbose,
        proxyEndpoint: endpoint || undefined,
        hotplugRoot: plan.hotplugRoot,
        isolatedHome: isoHome,
      };

      if (!plan.dryRun) {
        await applyToHome(ctx, isoHome);
      }

      return makeIsolatedRuntime(runtimeRoot, {
        HOME: isoHome,
        GEMINI_CONFIG_DIR: join(isoHome, '.gemini'),
        GEMINI_API_KEY: ctx.profile.secrets.apiKey ?? '',
        ...(endpoint ? { GOOGLE_GEMINI_BASE_URL: endpoint, GEMINI_API_BASE_URL: endpoint } : {}),
      });
    },

    async applyPersistent(plan: ResolvedClientPlan) {
      const profile =
        plan.profile ??
        syntheticProxyProfile({
          name: plan.source.display,
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
        clientId: 'gemini',
        dryRun: plan.dryRun,
        verbose: plan.verbose,
        proxyEndpoint: endpoint || undefined,
        hotplugRoot: plan.hotplugRoot,
      };
      await adapter.validate(ctx);
      return applyToHome(ctx, home);
    },

    async reset(state: ClientState): Promise<void> {
      const root = stateHomeRoot(state, home);
      await removeClientEnvFiles(root, 'gemini');

      // Strip managed keys from live .env
      if (await pathExists(liveEnv)) {
        const keys = state.managedEnvKeys ?? [];
        // upsertEnvFile only writes defined keys; remove by rewrite
        await stripKeysFromEnv(liveEnv, keys);
      }

      if (await pathExists(liveSettings)) {
        try {
          const doc = await readJsonFile<Record<string, unknown>>(liveSettings);
          delete doc[HOTPLUG_MANAGED_KEY];
          await writeJsonFile(liveSettings, doc, 0o600);
        } catch {
          // ignore
        }
      }
    },

    async inspect(): Promise<ClientInspectResult> {
      const present = (await pathExists(liveEnv)) || (await pathExists(liveSettings));
      const issues: string[] = [];
      let summary: string | undefined;
      if (await pathExists(liveSettings)) {
        try {
          const doc = await readJsonFile<Record<string, unknown>>(liveSettings);
          const managed = doc[HOTPLUG_MANAGED_KEY] as { keys?: string[] } | undefined;
          summary = managed?.keys?.length
            ? `hotplug-managed env keys: ${managed.keys.length}`
            : 'settings present';
        } catch {
          issues.push('settings.json unreadable');
        }
      }
      return {
        present,
        configPaths: [liveEnv, liveSettings],
        summary,
        issues: issues.length ? issues : undefined,
      };
    },
  };

  return adapter;
}

export const geminiClient = createGeminiClient();
