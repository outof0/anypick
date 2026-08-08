/** Internal `anypick proxy serve opencode` process entry. */
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { expandHome } from '../../utils/fs';
import { assertLoopbackHost } from '../../utils/network';
import { installProxyShutdown } from '../proxy-shared';
import { listenOpenCodeProxy } from './server';

const defaultAuth = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
  'opencode',
  'auth.json',
);

export async function runOpenCodeProxyCli(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string', short: 'p', default: '4120' },
      host: { type: 'string', default: '127.0.0.1' },
      'auth-path': { type: 'string', default: '' },
      'auth-paths': { type: 'string', default: '' },
      'auth-account-names': { type: 'string', default: '' },
      'auth-mode': { type: 'string', default: 'auto' },
      'quota-guard': { type: 'boolean', default: false },
      'quota-guard-state': { type: 'string', default: '' },
      'quota-guard-cooldown-ms': { type: 'string', default: '3600000' },
      upstream: { type: 'string', default: '' },
      'model-metadata-url': { type: 'string', default: '' },
      'proxy-token': { type: 'string', default: '' },
      quiet: { type: 'boolean', short: 'q', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(proxyHelp());
    return;
  }

  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${values.port}`);
  }
  const host = values.host ?? '127.0.0.1';
  assertLoopbackHost(host);
  const authMode = values['auth-mode'];
  if (authMode !== 'auto' && authMode !== 'public' && authMode !== 'api') {
    throw new Error(`Invalid auth mode: ${authMode}`);
  }

  const authPath = expandHome(values['auth-path'] || defaultAuth);
  const authPaths = (values['auth-paths'] || '')
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean)
    .map(expandHome);
  const authAccountNames = (values['auth-account-names'] || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const quotaGuardCooldownMs = Number(values['quota-guard-cooldown-ms']);
  if (!Number.isFinite(quotaGuardCooldownMs) || quotaGuardCooldownMs < 1_000) {
    throw new Error(`Invalid quota guard cooldown: ${values['quota-guard-cooldown-ms']}`);
  }
  const metadataSetting = values['model-metadata-url'] || process.env.OPENCODE_MODEL_METADATA_URL;
  const modelMetadataUrl = metadataSetting === 'none' ? false : metadataSetting || undefined;
  const log = values.quiet ? () => {} : makeLog();
  const { endpoint, server } = await listenOpenCodeProxy({
    host,
    port,
    authPath,
    authPaths,
    authAccountNames: authAccountNames.length ? authAccountNames : undefined,
    authMode,
    upstream: values.upstream || undefined,
    token: values['proxy-token'] || process.env.ANYPICK_PROXY_TOKEN || undefined,
    modelMetadataUrl,
    quiet: values.quiet,
    quotaGuard: {
      enabled: values['quota-guard'] === true,
      cooldownMs: Math.floor(quotaGuardCooldownMs),
      statePath: values['quota-guard-state'] ? expandHome(values['quota-guard-state']) : undefined,
      accountNames: authAccountNames,
      providerId: 'opencode',
    },
    log,
  });

  process.stdout.write(`anypick-opencode-proxy listening on ${endpoint}\n`);
  log(`listening on ${endpoint}`);
  log(`auth: ${authPath}`);
  if (authPaths.length > 0) {
    log(`auth pool: ${authPaths.length + 1} members`);
  }
  log('catalogs: zen + go (route by model)');
  if (values.upstream) {
    log(`upstream override: ${values.upstream}`);
  }
  if (metadataSetting) {
    log(`model metadata: ${metadataSetting}`);
  }
  installProxyShutdown(server);
}

function makeLog(): (line: string) => void {
  return (line) => {
    const clean = line.replace(/^\s+/, '');
    const ts = new Date().toISOString().slice(11, 19);
    process.stderr.write(`${ts} ${tagFor(clean)} ${clean}\n`);
    const extraLog = process.env.ANYPICK_PROXY_LOG;
    if (extraLog && process.stderr.isTTY) {
      try {
        appendFileSync(extraLog, `${ts} ${tagFor(clean)} ${clean}\n`);
      } catch {
        // ignore secondary log failures
      }
    }
  };
}

function tagFor(line: string): string {
  if (line.startsWith('✗')) {
    return 'ERR ';
  }
  if (line.startsWith('↻')) {
    return 'RETRY';
  }
  if (line.startsWith('✓')) {
    return 'OK  ';
  }
  if (line.includes('←')) {
    return 'RECV';
  }
  if (line.startsWith('models')) {
    return 'CAT ';
  }
  return 'INFO';
}

function proxyHelp(): string {
  return `anypick proxy serve opencode — OpenAI + Anthropic via OpenCode Zen+Go

  --port <n>              Listen port (default 4120)
  --host <host>           Listen host (default 127.0.0.1)
  --auth-path <path>      Path to OpenCode auth.json
  --auth-paths <paths>    Comma-separated auth.json files for pool failover
  --auth-account-names    Comma-separated saved account labels for pool audit
  --auth-mode <mode>      auto, public, or api (default auto)
  --quota-guard           Fail over only on confirmed credential quota errors
  --upstream <url>        Force a single upstream (tests)
  --model-metadata-url    Override dynamic model metadata URL
  -q, --quiet             Less logging
`;
}
