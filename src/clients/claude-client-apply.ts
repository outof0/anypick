import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ApplyContext } from '../types';
import { HotplugError } from '../utils/errors';
import { copyFileSafe, ensureDir, pathExists, readJsonFile, writeJsonFile } from '../utils/fs';
import { clientBackupDir } from '../core/paths';
import { resolveFromContext } from './resolve';
import { managedMarker, HOTPLUG_MANAGED_KEY, writeClientEnvFiles } from './env-files';

export function settingsPath(home = process.env.HOME ?? homedir()): string {
  return join(home, '.claude', 'settings.json');
}

export function bareModelId(id: string | undefined): string | undefined {
  if (!id) {
    return undefined;
  }
  const trimmed = id.trim();
  if (!trimmed) {
    return undefined;
  }
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function isOfficialAnthropicEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === 'api.anthropic.com' || host.endsWith('.anthropic.com');
  } catch {
    return false;
  }
}

function expectedEnvPaths(hotplugRoot: string): string[] {
  return [
    join(hotplugRoot, 'clients', 'claude', 'env.sh'),
    join(hotplugRoot, 'clients', 'claude', 'env.ps1'),
  ];
}

export async function applyClaudeToHome(ctx: ApplyContext, targetHome: string) {
  const settings = settingsPath(targetHome);
  const r = resolveFromContext(ctx);
  const apiKey = r.apiKey;
  const env: Record<string, string> = {};
  const official = isOfficialAnthropicEndpoint(r.endpoint);

  env.ANTHROPIC_BASE_URL = r.endpoint;

  if (official) {
    env.ANTHROPIC_API_KEY = apiKey;
  } else {
    env.ANTHROPIC_AUTH_TOKEN = apiKey;
  }

  // Claude Code slots: default + sonnet/opus/haiku. When only default is set
  // (common for proxy model maps), fill all slots so UI model "sonnet[…]"
  // still hits the proxy model instead of a built-in Claude id.
  const defaultModel = bareModelId(r.roles.default ?? r.defaultModel);
  const sonnet = bareModelId(r.roles.sonnet) ?? defaultModel;
  const opus = bareModelId(r.roles.opus) ?? defaultModel;
  const haiku = bareModelId(r.roles.haiku) ?? defaultModel;

  if (defaultModel) {
    env.ANTHROPIC_MODEL = defaultModel;
  }
  if (sonnet) {
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnet;
  }
  if (opus) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = opus;
  }
  if (haiku) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku;
  }

  const extraEnv = r.overlay.env;
  if (extraEnv && typeof extraEnv === 'object' && !Array.isArray(extraEnv)) {
    for (const [k, v] of Object.entries(extraEnv)) {
      if (typeof v !== 'string') {
        continue;
      }
      if (k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_') || k.startsWith('CLAUDE_CODE_')) {
        env[k] = v;
      }
    }
  }

  if (ctx.dryRun) {
    return {
      managedPaths: [settings, ...expectedEnvPaths(ctx.hotplugRoot)],
      managedEnvKeys: Object.keys(env),
    };
  }

  // Never turn malformed user JSON into `{}`. Parse and validate before any
  // env/config write so a failed apply leaves the user's files untouched.
  let doc: Record<string, unknown> = {};
  if (await pathExists(settings)) {
    try {
      const parsed = await readJsonFile<unknown>(settings);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('root value is not an object');
      }
      doc = parsed as Record<string, unknown>;
    } catch (err) {
      throw new HotplugError(
        `Refusing to overwrite unreadable Claude settings at ${settings}: ${err instanceof Error ? err.message : String(err)}`,
        'CLIENT_CONFIG_INVALID',
      );
    }
  }

  const prevManaged = doc[HOTPLUG_MANAGED_KEY] as { keys?: string[] } | undefined;
  const prevKeys = prevManaged?.keys ?? [];
  const existingEnv =
    doc.env && typeof doc.env === 'object' && !Array.isArray(doc.env)
      ? { ...(doc.env as Record<string, string>) }
      : {};

  for (const key of prevKeys) {
    delete existingEnv[key];
  }

  delete existingEnv.OPENAI_API_KEY;
  delete existingEnv.OPENAI_BASE_URL;
  delete existingEnv.OPENAI_MODEL;
  if (official) {
    delete existingEnv.ANTHROPIC_AUTH_TOKEN;
  } else {
    delete existingEnv.ANTHROPIC_API_KEY;
  }
  for (const k of [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ]) {
    if (!(k in env)) {
      delete existingEnv[k];
    }
  }

  Object.assign(existingEnv, env);

  const managedKeys = [
    ...Object.keys(env),
    official ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY',
  ];
  doc.env = existingEnv;
  doc[HOTPLUG_MANAGED_KEY] = managedMarker([...new Set(managedKeys)]);

  // Env files only for live (persistent) applies — not for isolated runtimes.
  // Keep the shell environment and settings.json in sync.
  let envPaths: string[] = [];
  if (!ctx.isolatedHome) {
    envPaths = await writeClientEnvFiles(ctx.hotplugRoot, 'claude', env);
    const backupDir = clientBackupDir(ctx.hotplugRoot, 'claude');
    await ensureDir(backupDir);
    const backupFile = join(backupDir, 'settings.json');
    if ((await pathExists(settings)) && !(await pathExists(backupFile))) {
      await copyFileSafe(settings, backupFile);
    }
  }

  await ensureDir(join(targetHome, '.claude'));
  await writeJsonFile(settings, doc, 0o600);

  // Hard guarantee: Claude Code reads settings.json env, not only env.sh
  try {
    const verify = await readJsonFile<Record<string, unknown>>(settings);
    const venv =
      verify.env && typeof verify.env === 'object' && !Array.isArray(verify.env)
        ? (verify.env as Record<string, string>)
        : {};
    if (venv.ANTHROPIC_BASE_URL !== r.endpoint) {
      throw new HotplugError(
        `Failed to write proxy into ${settings}: ANTHROPIC_BASE_URL is "${venv.ANTHROPIC_BASE_URL ?? ''}" (expected ${r.endpoint})`,
        'CLIENT_CONFIG_INVALID',
      );
    }
  } catch (err) {
    if (err instanceof HotplugError) {
      throw err;
    }
    throw new HotplugError(
      `Could not verify ${settings} after write: ${err instanceof Error ? err.message : String(err)}`,
      'CLIENT_CONFIG_INVALID',
    );
  }

  return {
    managedPaths: [settings, ...envPaths],
    managedEnvKeys: managedKeys,
  };
}
