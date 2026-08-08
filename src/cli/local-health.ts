/**
 * Local-only health hints (no network). Shared by launcher model and TUI.
 */

import type { AnyPickApp } from '../core/app';
import { pathExists } from '../utils/fs';

/**
 * Detect degraded binding state without network I/O.
 * Returns a short reason string, or undefined when healthy.
 *
 * Transport-dependent probes (e.g. external proxy missing) come from the
 * provider's SourceAdapter via transportFor — never from provider-id switches.
 */
export async function localAttentionFor(
  app: AnyPickApp,
  clientId: string,
  source: { kind: string; provider?: string; name?: string },
): Promise<string | undefined> {
  if (source.kind === 'account' && source.provider && source.name) {
    const acc = await app.accounts.get(source.provider, source.name);
    if (!acc) {
      return 'account missing';
    }
    if (acc.snapshotDir && !(await pathExists(acc.snapshotDir))) {
      return 'snapshot missing';
    }
    try {
      const provider = app.accounts.provider(source.provider);
      const adapter = provider.sourceAdapter?.(acc);
      if (adapter) {
        const transport = adapter.transportFor(clientId);
        if (transport === 'external_manual_proxy') {
          return 'proxy not installed';
        }
      }
    } catch {
      // Unknown provider is not a health signal here.
    }
  }
  if (source.kind === 'gateway' && source.name) {
    try {
      await app.profiles.get(source.name);
    } catch {
      return 'gateway missing';
    }
  }
  return undefined;
}
