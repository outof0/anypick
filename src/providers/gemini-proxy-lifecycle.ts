import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { ProxyContext, ProxyHandle, ProxyStatus } from '../types';
import { ensureDir, pathExists } from '../utils/fs';
import { HotplugError } from '../utils/errors';
import { assertLoopbackHost } from '../utils/network';
import { readGeminiApiKeyFromEnvFile } from './gemini-env';
import {
  isProcessRunning,
  readPidFile,
  spawnDetached,
  stopPidFile,
  waitForHttp,
} from '../utils/process';
import { resolveProxyMain } from './gemini-proxy-entry';

export interface GeminiProxyLifecycleOptions {
  liveDir: string;
  compatibility: string;
  defaultPort: number;
}

export async function startGeminiProxy(
  ctx: ProxyContext,
  opts: GeminiProxyLifecycleOptions,
): Promise<ProxyHandle> {
  const host = ctx.config.host ?? '127.0.0.1';
  assertLoopbackHost(host);
  const port = ctx.config.port ?? opts.defaultPort;
  const mainJs = resolveProxyMain();
  if (!(await pathExists(mainJs))) {
    throw new HotplugError(
      `Gemini proxy entry not found at ${mainJs}. Run: pnpm build`,
      'PROXY_BINARY_MISSING',
    );
  }

  await ensureDir(ctx.runtimeDir);
  const logPath = join(ctx.runtimeDir, 'proxy.log');
  const pidPath = join(ctx.runtimeDir, 'proxy.pid');
  await writeFile(logPath, '', { mode: 0o600 });

  // Prefer snapshot (account-scoped key); fall back to live ~/.gemini
  const snapshotEnv = join(ctx.snapshotDir, '.env');
  const liveEnv = join(opts.liveDir, '.env');
  let authDir = ctx.snapshotDir;
  if (!(await pathExists(snapshotEnv)) && (await pathExists(liveEnv))) {
    authDir = opts.liveDir;
  }

  const poolDirs = Array.isArray(ctx.config.options?.authDirs)
    ? (ctx.config.options.authDirs as unknown[]).filter(
        (d): d is string => typeof d === 'string' && d.length > 0,
      )
    : [];

  const oauthSource = ctx.config.options?.oauthSource ?? 'auto';
  if (oauthSource !== 'auto' && oauthSource !== 'gemini-cli' && oauthSource !== 'antigravity') {
    throw new HotplugError(
      `Invalid Gemini OAuth source: ${String(oauthSource)}. Use auto, gemini-cli, or antigravity.`,
      'PROXY_CONFIG_INVALID',
    );
  }

  // A snapshotted Antigravity account carries its credential in the auth dir.
  // Auto-select the antigravity source and point the proxy at that file so the
  // account "just works" when switched to — no absolute path stored in config.
  // An explicit gemini-cli source still wins (operator opted out of Antigravity).
  const snapshotAntigravityFile = join(authDir, 'antigravity_oauth.json');
  const hasSnapshotAntigravity =
    oauthSource !== 'gemini-cli' && (await pathExists(snapshotAntigravityFile));
  const effectiveOAuthSource = hasSnapshotAntigravity ? 'antigravity' : oauthSource;

  const hasOAuth =
    effectiveOAuthSource === 'antigravity' ||
    effectiveOAuthSource === 'auto' ||
    (await pathExists(join(authDir, 'oauth_creds.json')));
  if (poolDirs.length === 0 && !(await pathExists(join(authDir, '.env'))) && !hasOAuth) {
    throw new HotplugError(
      'Gemini proxy needs GEMINI_API_KEY.\n\nPut the key in ~/.gemini/.env, then:\n  hotplug add account gemini --current --name <name>\n\nOAuth-only logins work for the Gemini CLI, but not for Claude/Codex via this proxy.',
      'NO_LIVE_AUTH',
    );
  }

  // An explicitly supplied process key is the operator's latest credential
  // and must win over a stale account snapshot key. This also makes key
  // rotation possible without rewriting the saved account immediately.
  const key =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    (await readGeminiApiKeyFromEnvFile(join(authDir, '.env'))) ||
    (poolDirs[0] ? await readGeminiApiKeyFromEnvFile(join(poolDirs[0], '.env')) : undefined);
  if (!key && poolDirs.length === 0 && !hasOAuth) {
    throw new HotplugError(
      'This Gemini login has no usable API key. OAuth subscription accounts use the Code Assist transport automatically; refresh the Gemini login if oauth_creds.json is expired.',
      'NO_LIVE_AUTH',
    );
  }

  const upstream =
    (typeof ctx.config.options?.upstream === 'string' ? ctx.config.options.upstream : undefined) ??
    process.env.GEMINI_PROXY_UPSTREAM ??
    'https://generativelanguage.googleapis.com';

  const args = [
    mainJs,
    '--port',
    String(port),
    '--host',
    host,
    '--auth-dir',
    authDir,
    '--upstream',
    upstream,
    '--oauth-source',
    effectiveOAuthSource,
  ];
  const codeAssistUpstream =
    (typeof ctx.config.options?.codeAssistUpstream === 'string'
      ? ctx.config.options.codeAssistUpstream
      : undefined) ?? process.env.GEMINI_CODE_ASSIST_UPSTREAM;
  if (codeAssistUpstream) {
    args.push('--code-assist-upstream', codeAssistUpstream);
  }
  // Explicit config path wins; otherwise fall back to the snapshotted credential.
  if (typeof ctx.config.options?.antigravityOAuthFile === 'string') {
    args.push('--antigravity-oauth-file', ctx.config.options.antigravityOAuthFile);
  } else if (hasSnapshotAntigravity) {
    args.push('--antigravity-oauth-file', snapshotAntigravityFile);
  }
  if (poolDirs.length > 0) {
    args.push('--auth-dirs', poolDirs.join(','));
  }

  const endpoint = `http://${host}:${port}`;
  const { pid, instanceId } = await spawnDetached(process.execPath, args, {
    logPath,
    pidPath,
    endpoint,
    provider: 'gemini',
    account: ctx.accountName,
    env: {
      ...process.env,
      ...(key ? { GEMINI_API_KEY: key } : {}),
      ...(ctx.token ? { HOTPLUG_PROXY_TOKEN: ctx.token } : {}),
      HOTPLUG_PROXY_LOG: logPath,
    },
  });

  const ready = await waitForHttp(`${endpoint}/health`, {
    timeoutMs: 5000,
    requirePid: pid,
    expectInstanceId: instanceId,
  });
  if (!ready || !isProcessRunning(pid)) {
    let tail = '';
    try {
      const raw = await readFile(logPath, 'utf8');
      tail = raw.split(/\r?\n/).slice(-20).join('\n');
    } catch {
      // ignore
    }
    if (isProcessRunning(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // ignore
      }
    }
    throw new HotplugError(
      `Gemini proxy failed to bind ${host}:${port}.${tail ? `\n${tail}` : ''}`,
      'PROXY_START_FAILED',
    );
  }

  return {
    endpoint,
    compatibility: opts.compatibility,
    pid,
    instanceId,
    token: ctx.token,
    logPath,
  };
}

export async function stopGeminiProxy(ctx: ProxyContext): Promise<void> {
  await stopPidFile(join(ctx.runtimeDir, 'proxy.pid'));
}

export async function geminiProxyStatus(
  ctx: ProxyContext,
  compatibility: string,
  defaultPort: number,
): Promise<ProxyStatus> {
  const pidPath = join(ctx.runtimeDir, 'proxy.pid');
  const logPath = join(ctx.runtimeDir, 'proxy.log');
  const pid = await readPidFile(pidPath);
  const running = pid != null && isProcessRunning(pid);
  const host = ctx.config.host ?? '127.0.0.1';
  const port = ctx.config.port ?? defaultPort;
  return {
    enabled: ctx.config.enabled,
    running,
    endpoint: running ? `http://${host}:${port}` : undefined,
    compatibility,
    pid: running ? (pid ?? undefined) : undefined,
    logPath: (await pathExists(logPath)) ? logPath : undefined,
    detail: running ? undefined : ctx.config.enabled ? 'stopped' : 'disabled',
    port,
    host,
  };
}

export async function readGeminiProxyLogs(ctx: ProxyContext, lines = 50): Promise<string> {
  const logPath = join(ctx.runtimeDir, 'proxy.log');
  if (!(await pathExists(logPath))) {
    return '(no log file yet)';
  }
  const raw = await readFile(logPath, 'utf8');
  return raw.split(/\r?\n/).slice(-lines).join('\n');
}
