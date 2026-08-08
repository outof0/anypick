#!/usr/bin/env node
/**
 * Detached entrypoint for the Gemini compatibility proxy.
 *
 * Usage:
 *   node dist/providers/gemini-proxy/main.js --port 4130 --host 127.0.0.1 --auth-dir ~/.gemini
 */
import { parseArgs } from 'node:util';
import { appendFileSync } from 'node:fs';
import { expandHome } from '../../utils/fs';
import { listenGeminiProxy } from './server';
import { assertLoopbackHost } from '../../utils/network';
import { installProxyShutdown } from '../proxy-shared';

const { values } = parseArgs({
  options: {
    port: { type: 'string', short: 'p', default: '4130' },
    host: { type: 'string', default: '127.0.0.1' },
    'auth-dir': { type: 'string', default: '' },
    'auth-dirs': { type: 'string', default: '' },
    'auth-account-names': { type: 'string', default: '' },
    'api-key': { type: 'string', default: '' },
    'oauth-source': { type: 'string', default: 'auto' },
    'antigravity-oauth-file': { type: 'string', default: '' },
    upstream: {
      type: 'string',
      default: 'https://generativelanguage.googleapis.com',
    },
    'code-assist-upstream': { type: 'string', default: '' },
    'proxy-token': { type: 'string', default: '' },
    'quota-guard': { type: 'boolean', default: false },
    'quota-guard-state': { type: 'string', default: '' },
    'quota-guard-cooldown-ms': { type: 'string', default: '3600000' },
    quiet: { type: 'boolean', short: 'q', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
});

if (values.help) {
  process.stdout.write(`anypick-gemini-proxy — OpenAI + Anthropic → Gemini API
  OpenAI:    POST /v1/responses or /v1/chat/completions  (Codex / SDKs)
  Anthropic: POST /v1/messages          (Claude Code)

Options:
  -p, --port <n>           Listen port (default 4130)
      --host <host>        Listen host (default 127.0.0.1)
      --auth-dir <path>    Dir with .env (GEMINI_API_KEY), e.g. ~/.gemini or snapshot
      --auth-dirs <paths>  Comma-separated dirs for multi-key failover (pool)
      --auth-account-names <names>
                           Saved account labels for pool audit
      --api-key <key>      Override API key (tests)
      --quota-guard        Fail over only on confirmed credential quota errors
      --oauth-source <src> Gemini OAuth source: auto, gemini-cli, or antigravity (default auto)
      --antigravity-oauth-file <path>
                           Portable Antigravity OAuth credential file
      --upstream <url>     Gemini API base (default generativelanguage.googleapis.com)
      --code-assist-upstream <url>
                           Override Code Assist base URL
  -q, --quiet
  -h, --help
`);
  process.exit(0);
}

const authDir =
  values['auth-dir'] || process.env.GEMINI_CONFIG_DIR || `${process.env.HOME ?? ''}/.gemini`;

const authDirs = (values['auth-dirs'] || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => expandHome(p));
const authAccountNames = (values['auth-account-names'] || '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const quotaGuardCooldownMs = Number(values['quota-guard-cooldown-ms']);
if (!Number.isFinite(quotaGuardCooldownMs) || quotaGuardCooldownMs < 1_000) {
  process.stderr.write(`Invalid quota guard cooldown: ${values['quota-guard-cooldown-ms']}\n`);
  process.exit(1);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`Invalid port: ${values.port}\n`);
  process.exit(1);
}

const oauthSource = values['oauth-source'];
if (oauthSource !== 'auto' && oauthSource !== 'gemini-cli' && oauthSource !== 'antigravity') {
  process.stderr.write(`Invalid OAuth source: ${oauthSource}\n`);
  process.exit(1);
}

const host = values.host ?? '127.0.0.1';
try {
  assertLoopbackHost(host);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

function log(line: string): void {
  const msg = `[gemini-proxy] ${line}\n`;
  process.stderr.write(msg);
  // Detached proxies already have stderr redirected to this file.
  if (process.env.ANYPICK_PROXY_LOG && process.stderr.isTTY) {
    try {
      appendFileSync(process.env.ANYPICK_PROXY_LOG, msg);
    } catch {
      // ignore
    }
  }
}

const { endpoint, server } = await listenGeminiProxy({
  host,
  port,
  authDir: expandHome(authDir),
  authDirs: authDirs.length ? authDirs : undefined,
  authAccountNames: authAccountNames.length ? authAccountNames : undefined,
  apiKey: values['api-key'] || undefined,
  oauthSource,
  antigravityOAuthFile: values['antigravity-oauth-file']
    ? expandHome(values['antigravity-oauth-file'])
    : undefined,
  upstream: values.upstream,
  codeAssistUpstream:
    values['code-assist-upstream'] || process.env.GEMINI_CODE_ASSIST_UPSTREAM || undefined,
  token: values['proxy-token'] || process.env.ANYPICK_PROXY_TOKEN || undefined,
  quiet: values.quiet,
  quotaGuard: {
    enabled: values['quota-guard'] === true,
    cooldownMs: Math.floor(quotaGuardCooldownMs),
    statePath: values['quota-guard-state'] ? expandHome(values['quota-guard-state']) : undefined,
    accountNames: authAccountNames,
    providerId: 'gemini',
  },
  log: values.quiet ? () => {} : log,
});

process.stdout.write(`anypick-gemini-proxy listening on ${endpoint}\n`);
log(`listening on ${endpoint}`);
log(`auth-dir: ${expandHome(authDir)}`);
if (authDirs.length) {
  log(`auth-dirs: ${authDirs.length} members`);
}
log(`upstream: ${values.upstream}`);
log(`oauth-source: ${oauthSource}`);

installProxyShutdown(server);
