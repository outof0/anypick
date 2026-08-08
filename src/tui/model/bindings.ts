import type { AnyPickApp } from '../../core/app';
import type { ProxyRow } from './types';
import { proxyRowLabel } from './proxy-labels';
import { shortAppName } from './names';

export interface ClaudeBindStatus {
  bound: boolean;
  /** e.g. grok/work or openrouter-work */
  display?: string;
  scope?: string | null;
}

/** One app (client) and whether it uses a AnyPick proxy source. */
export interface AppBindingRow {
  clientId: string;
  /** User-facing app name (Claude, Codex, Kiro). */
  clientName: string;
  bound: boolean;
  /** Source ref when bound, e.g. grok/jonben */
  sourceDisplay?: string;
  scope?: string | null;
}

function sourceDisplayFromBinding(binding: unknown): string | undefined {
  if (!binding || typeof binding !== 'object') {
    return undefined;
  }
  const spec = (binding as { spec?: { source?: Record<string, unknown> } }).spec;
  const source = spec?.source;
  if (!source) {
    return undefined;
  }
  if (
    source.kind === 'account' &&
    typeof source.provider === 'string' &&
    typeof source.name === 'string'
  ) {
    return `${source.provider}/${source.name}`;
  }
  if (source.kind === 'account-pool' && typeof source.provider === 'string') {
    return `pool:${source.provider}`;
  }
  if (source.kind === 'gateway' && typeof source.name === 'string') {
    return source.name;
  }
  // Match proxyBindingRef / displayRef — manage-apps checked state compares to hub:name.
  if (source.kind === 'proxy-hub' && typeof source.name === 'string') {
    return `hub:${source.name}`;
  }
  if (source.kind === 'preset' && typeof source.name === 'string') {
    return `@${source.name}`;
  }
  return undefined;
}

/** All registered apps and their current AnyPick proxy source. */
export function loadAppBindings(app: AnyPickApp): AppBindingRow[] {
  try {
    return app.bindingService.current().map((r) => ({
      clientId: r.client,
      clientName: shortAppName(r.client, r.clientName),
      bound: Boolean(r.binding),
      sourceDisplay: sourceDisplayFromBinding(r.binding),
      scope: r.scope,
    }));
  } catch {
    return [];
  }
}

/** Short UI label for an app/client. */

export async function compatibleAppsForProxy(
  app: AnyPickApp,
  providerId: string,
  accountName: string,
): Promise<AppBindingRow[]> {
  const { accountAdapterFor } = await import('../../sources/account-adapters');
  let provider;
  let account;
  try {
    provider = app.accounts.provider(providerId);
    account = await app.accounts.get(providerId, accountName);
  } catch {
    return [];
  }
  if (!account) {
    return [];
  }
  const adapter = accountAdapterFor(provider, account);
  const all = loadAppBindings(app);
  const byId = new Map(all.map((a) => [a.clientId, a]));
  const out: AppBindingRow[] = [];
  for (const client of app.clients.list()) {
    const transport = adapter.transportFor(client.id);
    if (
      transport !== 'managed_builtin_proxy' &&
      transport !== 'managed_external_proxy' &&
      transport !== 'external_manual_proxy'
    ) {
      continue;
    }
    const existing = byId.get(client.id);
    out.push(
      existing ?? {
        clientId: client.id,
        clientName: shortAppName(client.id, client.name),
        bound: false,
      },
    );
  }
  return out;
}

/**
 * Proxy rail outcome for a row (DESIGN-TUI §6).
 * `usedBy` is a short label like "Claude" when an app uses this proxy.
 */
export function proxyOutcome(
  row: ProxyRow | undefined,
  usedBy?: string | null,
): { outcome: string; support: string } {
  if (!row) {
    return {
      outcome: 'No saved logins can run a proxy yet',
      support: 'Add a Grok, OpenCode, Gemini, or Kiro login in Accounts.',
    };
  }
  if (row.needsApiKey) {
    const ref = proxyRowLabel(row);
    return {
      outcome: `${ref} needs an API key`,
      support:
        row.attentionHint ??
        'Add GEMINI_API_KEY to this login, save again, then turn the proxy on.',
    };
  }
  const ref = `${row.providerId}/${row.name}`;
  if (row.stateLabel === 'unavailable') {
    return {
      outcome: `${ref} isn't available`,
      support: 'Press l for details, then press enter to check again.',
    };
  }
  if (row.status.running) {
    return {
      outcome: usedBy ? `Manage apps using ${ref}` : `${ref} is running`,
      support: usedBy ? `${usedBy} uses this proxy` : 'No app uses it yet · enter to pick apps',
    };
  }
  if (row.status.enabled) {
    return {
      outcome: `Start ${ref}`,
      support: "App settings won't change.",
    };
  }
  return {
    outcome: `Turn on and start ${ref}`,
    support: 'AnyPick chooses the address automatically.',
  };
}

/** Apps currently pointing at this proxy (display labels). */
export function appsUsingProxy(apps: AppBindingRow[] | ClaudeBindStatus, ref: string): string[] {
  // Backward-compat: single Claude status
  if (!Array.isArray(apps)) {
    if (apps.bound && apps.display === ref) {
      return ['Claude'];
    }
    return [];
  }
  return apps.filter((a) => a.bound && a.sourceDisplay === ref).map((a) => a.clientName);
}

/** Effective Claude binding (global/project) for Proxy board status. */
export function loadClaudeBindStatus(app: AnyPickApp): ClaudeBindStatus {
  const apps = loadAppBindings(app);
  const claude = apps.find((a) => a.clientId === 'claude');
  if (!claude?.bound) {
    return { bound: false };
  }
  return { bound: true, display: claude.sourceDisplay, scope: claude.scope };
}

/**
 * Flat list of all saved accounts for AnyPick home.
 * Primary action on a row: make live (accounts.use).
 */
