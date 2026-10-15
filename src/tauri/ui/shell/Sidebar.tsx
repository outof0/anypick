import { DESTINATIONS, type AppDestination, type Destination } from '../lib/contract';
import { translate } from '../lib/i18n';

import { Symbol } from './Symbol';

/**
 * The sidebar: peer destinations in System Settings order, including Settings.
 *
 * The order and the labels are the contract with the macOS app, and
 * `contract-drift.test.ts` pins the engine-backed pane list. Settings is a
 * shell-only route and does not change that data contract.
 */

const DESTINATION_MESSAGE_KEY: Record<Destination, string> = {
  overview: 'desktop.nav.overview',
  apps: 'desktop.nav.apps',
  accounts: 'desktop.nav.accounts',
  proxyHub: 'desktop.nav.proxy_hub',
  proxies: 'desktop.nav.proxies',
  activity: 'desktop.nav.activity',
  backups: 'desktop.nav.backups',
};

const DESTINATION_SYMBOL: Record<Destination, string> = {
  overview: 'square.grid.2x2',
  apps: 'app.badge',
  accounts: 'person.2',
  proxyHub: 'point.3.connected.trianglepath.dotted',
  proxies: 'server.rack',
  activity: 'list.bullet',
  backups: 'externaldrive.badge.timemachine',
};

const SHELL_DESTINATIONS: readonly AppDestination[] = [...DESTINATIONS, 'settings'];

export function Sidebar({
  destination,
  onSelect,
  state,
  runningCount,
  language,
  resolvedLanguage,
}: {
  destination: AppDestination;
  onSelect: (destination: AppDestination) => void;
  state: 'starting' | 'connected' | 'stopped' | 'error';
  runningCount: number;
  language: string;
  resolvedLanguage: string;
}) {
  return (
    <aside
      className="flex min-h-0 min-w-0 flex-col overflow-auto border-r border-separator-soft bg-sidebar py-2 pr-2 pl-2"
      data-testid="sidebar-navigation"
    >
      <nav
        className="grid content-start gap-px"
        aria-label={translate('desktop.sidebar.sections', language, resolvedLanguage)}
      >
        {SHELL_DESTINATIONS.map((item) => {
          const label = item === 'settings'
            ? translate('desktop.nav.settings', language, resolvedLanguage)
            : translate(DESTINATION_MESSAGE_KEY[item], language, resolvedLanguage);
          const symbol = item === 'settings' ? 'gearshape' : DESTINATION_SYMBOL[item];
          return (
            <button
              key={item}
              type="button"
              className={`flex min-h-7 w-full items-center gap-2 rounded-control bg-transparent px-2 py-1 text-left text-[13px] font-normal hover:bg-hover ${
                destination === item ? 'bg-accent font-[590] text-white hover:bg-accent' : 'text-text'
              }`}
              onClick={() => onSelect(item)}
              aria-current={destination === item ? 'page' : undefined}
              title={label}
              data-testid={`sidebar-${item}`}
            >
              <span
                className={`flex-none ${destination === item ? 'text-white' : 'text-secondary'}`}
                aria-hidden="true"
              >
                <Symbol name={symbol} />
              </span>
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
      <div className="mt-auto flex flex-col items-stretch pt-2.5 pr-2 pb-2 pl-2">
        <div
          className="mt-2 flex min-w-0 items-center gap-[7px] border-t border-separator-soft pt-2 text-[11px] text-secondary"
          data-testid="sidebar-service-status"
        >
          <span
            className={`size-status-dot flex-none rounded-full ${
              state === 'connected'
                ? 'bg-green'
                : state === 'error'
                  ? 'bg-red'
                  : state === 'starting'
                    ? 'bg-orange'
                    : 'border-[1.5px] border-secondary/60 bg-transparent'
            }`}
            aria-hidden="true"
          />
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">
            {statusLabel(state, runningCount, language, resolvedLanguage)}
          </span>
        </div>
      </div>
    </aside>
  );
}

function statusLabel(
  state: 'starting' | 'connected' | 'stopped' | 'error',
  runningCount: number,
  language: string,
  resolvedLanguage: string,
): string {
  if (state === 'starting') return translate('desktop.sidebar.service_connecting', language, resolvedLanguage);
  if (state === 'error') return translate('desktop.sidebar.service_attention', language, resolvedLanguage);
  if (state === 'stopped') return translate('desktop.sidebar.service_stopped', language, resolvedLanguage);
  const countKey = runningCount === 1 ? 'desktop.sidebar.local_service_one' : 'desktop.sidebar.local_service_many';
  return translate(countKey, language, resolvedLanguage).replace('%d', String(runningCount));
}
