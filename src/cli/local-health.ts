/**
 * Local-only health hints (no network). Shared by launcher model and TUI.
 */

import type { HotplugApp } from '../core/app';
import { pathExists } from '../utils/fs';
import { whichExecutable } from '../utils/process';

/**
 * Detect degraded binding state without network I/O.
 * Returns a short reason string, or undefined when healthy.
 */
export async function localAttentionFor(
  app: HotplugApp,
  clientId: string,
  source: { kind: string; provider?: string; name?: string },
): Promise<string | undefined> {
  if (source.kind === 'account' && source.provider && source.name) {
    const acc = await app.accounts.get(source.provider, source.name);
    if (!acc) {
      return 'account missing';
    }
    if (source.provider === 'kiro' && (clientId === 'claude' || clientId === 'codex')) {
      const has =
        whichExecutable('kirolink') ??
        whichExecutable('kiro-link') ??
        whichExecutable('kiro-proxy');
      if (!has) {
        return 'proxy not installed';
      }
    }
    if (acc.snapshotDir && !(await pathExists(acc.snapshotDir))) {
      return 'snapshot missing';
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
