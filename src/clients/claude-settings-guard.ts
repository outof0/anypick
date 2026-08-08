/**
 * Claude Code rewrites ~/.claude/settings.json mid-session (model, effort, …)
 * and can clobber anypick-managed env (BASE_URL → stale openrouter/etc.).
 * Result: next API call 404s with "selected model may not exist" and never hits
 * the local proxy — even while the proxy log shows earlier turns succeeded.
 *
 * While a anypick proxy is alive, re-assert BASE_URL/AUTH on a short interval
 * when _anypickManaged is present.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathExists, readJsonFile, writeJsonFile } from '../utils/fs';
import { ANYPICK_MANAGED_KEY } from './env-files';

export interface ClaudeSettingsGuardOptions {
  /** Expected ANTHROPIC_BASE_URL (local proxy). */
  endpoint: string;
  /** Dummy key Claude sends to the proxy. */
  apiKey?: string;
  home?: string;
  intervalMs?: number;
  log?: (line: string) => void;
}

function settingsPath(home: string): string {
  return join(home, '.claude', 'settings.json');
}

function normalizeBase(url: string): string {
  return url.replace(/\/$/, '');
}

/**
 * One-shot repair. Returns true when a write was needed and applied.
 */
export async function repairClaudeSettingsIfDrifted(
  opts: ClaudeSettingsGuardOptions,
): Promise<boolean> {
  const home = opts.home ?? process.env.HOME ?? homedir();
  const path = settingsPath(home);
  const expected = normalizeBase(opts.endpoint);
  const apiKey = opts.apiKey ?? 'anypick-proxy';
  const log = opts.log ?? (() => {});

  if (!(await pathExists(path))) {
    return false;
  }

  let doc: Record<string, unknown>;
  try {
    doc = await readJsonFile<Record<string, unknown>>(path);
  } catch {
    return false;
  }

  const managed = doc[ANYPICK_MANAGED_KEY] as { keys?: string[] } | undefined;
  if (!managed?.keys?.includes('ANTHROPIC_BASE_URL')) {
    // Not a anypick-managed Claude install — leave alone.
    return false;
  }

  const env =
    doc.env && typeof doc.env === 'object' && !Array.isArray(doc.env)
      ? { ...(doc.env as Record<string, string>) }
      : {};

  const current = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : '';
  if (normalizeBase(current) === expected) {
    return false;
  }

  log(
    `claude settings drift: ANTHROPIC_BASE_URL="${current || '(empty)'}" → "${expected}" (repairing)`,
  );

  env.ANTHROPIC_BASE_URL = expected;
  env.ANTHROPIC_AUTH_TOKEN = apiKey;
  delete env.ANTHROPIC_API_KEY;

  doc.env = env;
  await writeJsonFile(path, doc, 0o600);
  return true;
}

/**
 * Poll settings and repair drift until stop() is called.
 */
export function startClaudeSettingsGuard(opts: ClaudeSettingsGuardOptions): () => void {
  const intervalMs = opts.intervalMs ?? 2_000;
  let stopped = false;

  const tick = () => {
    if (stopped) {
      return;
    }
    void repairClaudeSettingsIfDrifted(opts).catch(() => {
      // ignore transient FS errors
    });
  };

  tick();
  const id = setInterval(tick, intervalMs);
  id.unref?.();

  return () => {
    stopped = true;
    clearInterval(id);
  };
}
