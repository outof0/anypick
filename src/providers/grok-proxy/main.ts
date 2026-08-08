#!/usr/bin/env node
/**
 * Detached entrypoint for the Grok compatibility proxy.
 * Spawned by GrokProvider.startProxy — not meant for direct end-user use
 * (though it works standalone for debugging).
 *
 * Usage:
 *   node dist/providers/grok-proxy/main.js --port 8080 --host 127.0.0.1 --auth-path ~/.grok/auth.json
 */
import { parseArgs } from 'node:util';
import { appendFileSync } from 'node:fs';
import { expandHome } from '../../utils/fs';
import { listenGrokProxy } from './server';
import { assertLoopbackHost } from '../../utils/network';
import { installProxyShutdown } from '../proxy-shared';

const { values } = parseArgs({
  options: {
    port: { type: 'string', short: 'p', default: '8080' },
    host: { type: 'string', default: '127.0.0.1' },
    'auth-path': { type: 'string', default: '' },
    upstream: { type: 'string', default: 'https://cli-chat-proxy.grok.com' },
    'client-version': { type: 'string', default: '0.2.101' },
    'proxy-token': { type: 'string', default: '' },
    quiet: { type: 'boolean', short: 'q', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
});

if (values.help) {
  process.stdout.write(`hotplug-grok-proxy — OpenAI + Anthropic proxy using Grok CLI OIDC auth
  OpenAI:    POST /v1/chat/completions  (Codex)
  Anthropic: POST /v1/messages          (Claude Code)

Options:
  -p, --port <n>              Listen port (default 8080)
      --host <host>           Listen host (default 127.0.0.1)
      --auth-path <path>      Path to ~/.grok/auth.json
      --upstream <url>        Upstream base (default https://cli-chat-proxy.grok.com)
      --client-version <v>    x-grok-client-version header
  -q, --quiet                 Less logging
  -h, --help
`);
  process.exit(0);
}

const authPath =
  values['auth-path'] || process.env.GROK_AUTH_PATH || `${process.env.HOME ?? ''}/.grok/auth.json`;

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`Invalid port: ${values.port}\n`);
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
  const msg = `[grok-proxy] ${line}\n`;
  process.stderr.write(msg);
  // Detached proxies already have stderr redirected to this file.
  if (process.env.HOTPLUG_PROXY_LOG && process.stderr.isTTY) {
    try {
      appendFileSync(process.env.HOTPLUG_PROXY_LOG, msg);
    } catch {
      // ignore
    }
  }
}

const { endpoint, server } = await listenGrokProxy({
  host,
  port,
  authPath: expandHome(authPath),
  upstream: values.upstream,
  clientVersion: values['client-version'],
  token: values['proxy-token'] || process.env.HOTPLUG_PROXY_TOKEN || undefined,
  quiet: values.quiet,
  log: values.quiet ? () => {} : log,
});

// Single-line marker the parent can scrape if needed
process.stdout.write(`hotplug-grok-proxy listening on ${endpoint}\n`);
log(`listening on ${endpoint}`);
log(`auth: ${expandHome(authPath)}`);
log(`upstream: ${values.upstream}`);

installProxyShutdown(server);
