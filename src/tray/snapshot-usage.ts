import type { AnyPickApp } from '../core/app';
import { shortClientName } from '../presentation/client-name';
import type { TrayUsageSnapshot, TrayUsageWindow } from './snapshot-types';

/**
 * Read quota only for provider credentials that are live on disk. Never
 * restores or authenticates with a saved AnyPick account just to populate the
 * tray, so a usage card can never belong to a hidden account.
 */
export async function buildTrayUsage(app: AnyPickApp): Promise<TrayUsageSnapshot[]> {
  const listedAccounts = await app.accounts.list().catch(() => []);
  const liveAccounts = listedAccounts.filter((account) => account.isLiveMatch);
  const clients = app.clients.list();
  const providers = [...new Set(liveAccounts.map((account) => account.provider))];
  const cards = await Promise.all(
    providers.map(async (providerId): Promise<TrayUsageSnapshot | null> => {
      const client = clients.find((candidate) => candidate.id === providerId);
      if (!client) {
        return null;
      }
      const usage = await app.accounts.liveUsage(providerId).catch(() => null);
      if (!usage?.windows.length) {
        return null;
      }
      const account = liveAccounts.find((candidate) => candidate.provider === providerId);
      return {
        client: shortClientName(client.id, client.name, client.shortName),
        account: account?.label ?? account?.name ?? providerId,
        windows: usage.windows
          .filter((window) => window.label.trim())
          .map((window) => {
            const normalized: TrayUsageWindow = {
              label: window.label.trim().slice(0, 24),
              remainingPercent: Math.max(0, Math.min(100, Math.round(window.remainingPercent))),
            };
            if (window.resetsAtMs != null && Number.isFinite(window.resetsAtMs)) {
              normalized.resetsAtMs = window.resetsAtMs;
            }
            return normalized;
          }),
      };
    }),
  );
  return cards.filter(
    (card): card is TrayUsageSnapshot => card !== null && card.windows.length > 0,
  );
}
