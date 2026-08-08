#!/usr/bin/env node

/**
 * Soften experimental node:sqlite warning for end users.
 * Must run before any module that imports node:sqlite (ESM hoist-safe via dynamic import).
 */
function silenceSqliteExperimentalWarning(): void {
  const original = process.emitWarning.bind(process);
  process.emitWarning = (warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === 'string' ? warning : String(warning?.message ?? warning);
    const typeOrName =
      typeof rest[0] === 'string'
        ? rest[0]
        : typeof warning === 'object' && warning && 'name' in warning
          ? String((warning as { name?: string }).name)
          : '';
    if (typeOrName === 'ExperimentalWarning' || message.includes('ExperimentalWarning')) {
      if (message.includes('SQLite') || message.includes('sqlite')) {
        return;
      }
    }
    if (message.includes('SQLite is an experimental feature')) {
      return;
    }
    return (original as (...a: unknown[]) => void)(warning, ...rest);
  };
}

silenceSqliteExperimentalWarning();

const earlyArgs = process.argv.slice(2);
const openCodeProxyCommand =
  earlyArgs[0] === 'proxy' && earlyArgs[1] === 'serve' && earlyArgs[2] === 'opencode';
const proxyHubCommand =
  earlyArgs[0] === 'proxy' && earlyArgs[1] === 'serve' && earlyArgs[2] === 'hub';
if (openCodeProxyCommand) {
  const { runOpenCodeProxyCli } = await import('./providers/opencode-proxy/cli');
  await runOpenCodeProxyCli(earlyArgs.slice(3));
} else if (proxyHubCommand) {
  const { runProxyHubCli } = await import('./core/proxy-hub-cli');
  await runProxyHubCli(earlyArgs.slice(3));
} else {
  const { runAnyPickCli } = await import('./cli/bootstrap');
  await runAnyPickCli(earlyArgs);
}
