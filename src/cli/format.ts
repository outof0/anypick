import pc from 'picocolors';
import { MARK } from './ux';
import type { ListedAccount } from '../core/service';
import type { Provider, ProxyStatus } from '../types';
import { providerCanProxy } from '../core/capabilities';

export function printAccounts(accounts: ListedAccount[], json = false): void {
  if (json) {
    console.log(JSON.stringify(accounts, null, 2));
    return;
  }

  if (accounts.length === 0) {
    console.log(pc.dim('No saved accounts.'));
    console.log(pc.dim('  → anypick add account <provider> --current --name <name>'));
    return;
  }

  const byProvider = new Map<string, ListedAccount[]>();
  for (const a of accounts) {
    const list = byProvider.get(a.provider) ?? [];
    list.push(a);
    byProvider.set(a.provider, list);
  }

  for (const [provider, list] of byProvider) {
    console.log(pc.bold(pc.cyan(provider)));
    for (const a of list) {
      const mark = a.active ? pc.green(MARK.live) : pc.dim(MARK.open);
      const name = a.active ? pc.green(pc.bold(a.name)) : pc.white(a.name);
      const identity = a.identity ? pc.dim(`  ${a.identity}`) : '';
      const label = a.label && a.label !== a.name ? pc.dim(` (${a.label})`) : '';
      let proxyTag = '';
      if (a.proxyEnabled) {
        proxyTag = a.proxyRunning ? pc.magenta('  [proxy:on]') : pc.dim('  [proxy]');
      }
      console.log(`  ${mark} ${name}${label}${identity}${proxyTag}`);
    }
    console.log();
  }
}

export function printProviders(providers: Provider[], json = false): void {
  if (json) {
    console.log(
      JSON.stringify(
        providers.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          supportsProxy: providerCanProxy(p),
          proxyCompatibility: p.proxyCompatibility,
        })),
        null,
        2,
      ),
    );
    return;
  }

  for (const p of providers) {
    const proxy = providerCanProxy(p) ? pc.magenta(` proxy:${p.proxyCompatibility ?? 'yes'}`) : '';
    console.log(`${pc.bold(p.id.padEnd(10))} ${pc.dim(p.name)}${proxy}`);
    console.log(`${''.padEnd(10)} ${pc.dim(p.description)}`);
  }
}

export function printProxyStatus(
  providerId: string,
  accountName: string,
  providerName: string,
  status: ProxyStatus,
  json = false,
): void {
  if (json) {
    console.log(JSON.stringify({ provider: providerId, account: accountName, ...status }, null, 2));
    return;
  }
  console.log(pc.bold(`${providerId}/${accountName}`));
  console.log(`  Provider:       ${providerName}`);
  console.log(`  Enabled:        ${status.enabled ? pc.green('yes') : pc.dim('no')}`);
  console.log(`  Running:        ${status.running ? pc.green('yes') : pc.dim('no')}`);
  if (status.port != null) {
    console.log(`  Listen:         ${pc.cyan(`${status.host ?? '127.0.0.1'}:${status.port}`)}`);
  }
  if (status.endpoint) {
    console.log(`  Endpoint:       ${pc.cyan(status.endpoint)}`);
  }
  if (status.compatibility) {
    console.log(`  Compatibility:  ${status.compatibility}`);
  }
  if (status.pid) {
    console.log(`  PID:            ${status.pid}`);
  }
  if (status.logPath) {
    console.log(`  Log:            ${status.logPath}`);
  }
  if (status.detail) {
    console.log(pc.dim(`  (${status.detail})`));
  }
}
