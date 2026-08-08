import type { ReactNode } from 'react';
import type { TrayActionSnapshot } from '../../../snapshot-types';
import type { TrayController } from '../hooks/useTrayController';
import { ProviderIcon, providerName } from '../lib/provider';
import {
  chipActionsFor,
  chipTitle,
  routeHasAlternates,
  routeKind,
  routeProvider,
  routeSubtitle,
  routeTitle,
} from '../lib/routes';

type SectionId = 'accounts' | 'proxies' | 'gateways';

function sectionFor(action: TrayActionSnapshot): SectionId | null {
  const kind = routeKind(action);
  if (kind === 'direct-account') return 'accounts';
  if (kind === 'hub' || kind === 'account' || kind === 'pool') return 'proxies';
  if (kind === 'gateway' || !action.routeKind) return 'gateways';
  return null;
}

function sortSelectedFirst(items: TrayActionSnapshot[]) {
  return [...items].sort((left, right) => {
    if (left.selected !== right.selected) return left.selected ? -1 : 1;
    return routeTitle(left).localeCompare(routeTitle(right));
  });
}

function PickerAction({
  action,
  busy,
  onSelect,
}: {
  action: TrayActionSnapshot;
  busy: boolean;
  onSelect: (action: TrayActionSnapshot) => void;
}) {
  return (
    <button
      type="button"
      className={`picker-row${action.selected ? ' active' : ''}`}
      disabled={action.selected || !action.enabled || busy}
      onClick={() => onSelect(action)}
    >
      <ProviderIcon value={routeProvider(action)} size="small" />
      <span>
        <strong>{routeTitle(action)}</strong>
        <small>{routeSubtitle(action)}</small>
      </span>
      <span className="picker-check">{action.selected ? '✓' : ''}</span>
    </button>
  );
}

function PickerSection({
  title,
  items,
  busy,
  onSelect,
}: {
  title: string;
  items: TrayActionSnapshot[];
  busy: boolean;
  onSelect: (action: TrayActionSnapshot) => void;
}) {
  if (!items.length) return null;
  return (
    <section className="picker-section">
      <div className="picker-label">
        <span>{title}</span>
      </div>
      {items.map((action) => (
        <PickerAction key={action.id} action={action} busy={busy} onSelect={onSelect} />
      ))}
    </section>
  );
}

/**
 * Navigation via ctrl.routeGroup:
 * - null → auto-open active section (or root when multi-group + no selection)
 * - "__root__" → Accounts / Proxies / Gateways list
 * - "accounts" | "proxies" | "gateways"
 * - "proxies:<providerId>" → provider account list
 */
export function RoutePicker({
  pickerKey,
  actions,
  extras,
  ctrl,
}: {
  pickerKey: string;
  actions: TrayActionSnapshot[];
  extras?: ReactNode;
  ctrl: TrayController;
}) {
  if (ctrl.routePicker !== pickerKey) return null;

  const close = () => {
    ctrl.setRoutePicker(null);
    ctrl.setRouteQuery('');
    ctrl.setRouteGroup(null);
  };

  const query = ctrl.routeQuery.trim().toLocaleLowerCase();
  const current = actions.find((action) => action.selected);

  const accountActions = actions.filter((a) => routeKind(a) === 'direct-account');
  const hubActions = actions.filter((a) => routeKind(a) === 'hub');
  const proxyAccountActions = actions.filter(
    (a) => routeKind(a) === 'account' || routeKind(a) === 'pool',
  );
  const gatewayActions = actions.filter(
    (a) => routeKind(a) === 'gateway' || a.routeKind == null,
  );

  const sections: SectionId[] = [];
  if (accountActions.length) sections.push('accounts');
  if (hubActions.length || proxyAccountActions.length) sections.push('proxies');
  if (gatewayActions.length) sections.push('gateways');

  const activeSection = current ? sectionFor(current) : null;

  // Default path when group is unset: land in the active section (no “Current” block).
  let nav = ctrl.routeGroup;
  if (!query && nav == null) {
    if (activeSection) {
      if (
        activeSection === 'proxies' &&
        current &&
        (routeKind(current) === 'account' || routeKind(current) === 'pool')
      ) {
        const key = current.upstreamProviderId || current.sourceId;
        const peers = proxyAccountActions.filter(
          (a) => (a.upstreamProviderId || a.sourceId) === key,
        );
        nav = peers.length > 1 ? `proxies:${encodeURIComponent(key)}` : 'proxies';
      } else {
        nav = activeSection;
      }
    } else if (sections.length === 1) {
      nav = sections[0];
    } else {
      nav = '__root__';
    }
  }

  const providerDrill =
    typeof nav === 'string' && nav.startsWith('proxies:')
      ? decodeURIComponent(nav.slice('proxies:'.length))
      : null;
  const openSection: SectionId | null = providerDrill
    ? 'proxies'
    : nav === 'accounts' || nav === 'proxies' || nav === 'gateways'
      ? nav
      : null;

  let results: ReactNode;

  if (query) {
    const matching = actions.filter((action) =>
      [
        action.label,
        action.detail,
        action.modelId,
        action.upstreamProviderId,
        action.upstreamSourceLabel,
      ].some((value) =>
        String(value || '')
          .toLocaleLowerCase()
          .includes(query),
      ),
    );
    results = matching.length ? (
      <PickerSection
        title="Results"
        items={matching.slice(0, 20)}
        busy={ctrl.busy}
        onSelect={ctrl.trySelectRoute}
      />
    ) : (
      <div className="picker-empty">
        <strong>No matching source</strong>
        <span>Try an account, proxy, or gateway.</span>
      </div>
    );
  } else if (providerDrill) {
    const items = sortSelectedFirst(
      proxyAccountActions.filter(
        (a) => (a.upstreamProviderId || a.sourceId) === providerDrill,
      ),
    );
    results = (
      <>
        <button
          type="button"
          className="picker-group-back"
          onClick={() => ctrl.setRouteGroup('proxies')}
        >
          ‹ Proxies
        </button>
        <PickerSection
          title={providerName(providerDrill)}
          items={items}
          busy={ctrl.busy}
          onSelect={ctrl.trySelectRoute}
        />
      </>
    );
  } else if (openSection === 'accounts') {
    results = (
      <>
        {sections.length > 1 ? (
          <button
            type="button"
            className="picker-group-back"
            onClick={() => ctrl.setRouteGroup('__root__')}
          >
            ‹ Sources
          </button>
        ) : null}
        <PickerSection
          title="Accounts"
          items={sortSelectedFirst(accountActions)}
          busy={ctrl.busy}
          onSelect={ctrl.trySelectRoute}
        />
      </>
    );
  } else if (openSection === 'gateways') {
    results = (
      <>
        {sections.length > 1 ? (
          <button
            type="button"
            className="picker-group-back"
            onClick={() => ctrl.setRouteGroup('__root__')}
          >
            ‹ Sources
          </button>
        ) : null}
        <PickerSection
          title="Gateways"
          items={sortSelectedFirst(gatewayActions)}
          busy={ctrl.busy}
          onSelect={ctrl.trySelectRoute}
        />
      </>
    );
  } else if (openSection === 'proxies') {
    const providers = [
      ...new Set(proxyAccountActions.map((a) => a.upstreamProviderId || a.sourceId)),
    ].sort((a, b) => providerName(a).localeCompare(providerName(b)));
    results = (
      <>
        {sections.length > 1 ? (
          <button
            type="button"
            className="picker-group-back"
            onClick={() => ctrl.setRouteGroup('__root__')}
          >
            ‹ Sources
          </button>
        ) : null}
        <PickerSection
          title="Proxy Hub"
          items={sortSelectedFirst(hubActions)}
          busy={ctrl.busy}
          onSelect={ctrl.trySelectRoute}
        />
        {providers.length <= 1 ? (
          <PickerSection
            title={hubActions.length ? 'Other proxies' : 'Proxies'}
            items={sortSelectedFirst(proxyAccountActions)}
            busy={ctrl.busy}
            onSelect={ctrl.trySelectRoute}
          />
        ) : (
          <section className="picker-section">
            <div className="picker-label">
              <span>{hubActions.length ? 'Other proxies' : 'Proxies'}</span>
            </div>
            {providers.map((providerId) => {
              const items = proxyAccountActions.filter(
                (a) => (a.upstreamProviderId || a.sourceId) === providerId,
              );
              const active = items.some((a) => a.selected);
              return (
                <button
                  key={providerId}
                  type="button"
                  className="picker-row"
                  onClick={() => {
                    if (items.length === 1 && !items[0].selected && items[0].enabled) {
                      ctrl.trySelectRoute(items[0]);
                      return;
                    }
                    ctrl.setRouteGroup(`proxies:${encodeURIComponent(providerId)}`);
                  }}
                >
                  <ProviderIcon value={providerId} size="small" />
                  <span>
                    <strong>
                      {providerName(providerId)}
                      {active ? ' · Now' : ''}
                    </strong>
                    <small>
                      {items.length} account{items.length === 1 ? '' : 's'}
                    </small>
                  </span>
                  <span className="picker-check">{items.length > 1 ? '›' : ''}</span>
                </button>
              );
            })}
          </section>
        )}
      </>
    );
  } else {
    // Root: Accounts · Proxies · Gateways (empty hidden).
    results = sections.length ? (
      <section className="picker-section">
        <div className="picker-label">
          <span>Switch source</span>
        </div>
        {sections.map((id) => {
          const count =
            id === 'accounts'
              ? accountActions.length
              : id === 'proxies'
                ? hubActions.length + proxyAccountActions.length
                : gatewayActions.length;
          const active = activeSection === id;
          const title =
            id === 'accounts' ? 'Accounts' : id === 'proxies' ? 'Proxies' : 'Gateways';
          return (
            <button
              key={id}
              type="button"
              className={`picker-row${active ? ' active' : ''}`}
              onClick={() => ctrl.setRouteGroup(id)}
            >
              <span>
                <strong>{title}</strong>
                <small>
                  {active && current
                    ? `Now · ${routeTitle(current)}`
                    : `${count} source${count === 1 ? '' : 's'}`}
                </small>
              </span>
              <span className="picker-check">›</span>
            </button>
          );
        })}
      </section>
    ) : (
      <div className="picker-empty">
        <strong>No sources are available</strong>
        <span>Save an account or gateway first.</span>
      </div>
    );
  }

  return (
    <>
      <div className="route-picker-scrim" onClick={close} />
      <div className="route-popover" role="dialog" aria-label="Switch source">
        <div className="route-search">
          <input
            autoFocus
            value={ctrl.routeQuery}
            onChange={(event) => ctrl.setRouteQuery(event.target.value)}
            placeholder="Search sources"
            aria-label="Search sources"
          />
        </div>
        <div className="route-results">{results}</div>
        {extras}
      </div>
    </>
  );
}

/** Face control — hidden when there is nothing to switch to. */
export function SwitchMenu({
  pickerKey,
  actions,
  configureModelsId,
  openLabel = 'Open App…',
  ctrl,
}: {
  pickerKey: string;
  actions: TrayActionSnapshot[];
  configureModelsId?: string | null;
  openLabel?: string;
  ctrl: TrayController;
}) {
  if (!routeHasAlternates(actions)) return null;

  const extras = (
    <>
      {configureModelsId ? (
        <button
          type="button"
          className="picker-footer-action"
          disabled={ctrl.busy}
          onClick={() => ctrl.openModelEditor(configureModelsId)}
        >
          Configure Models…
        </button>
      ) : null}
      <button
        type="button"
        className="picker-footer-action"
        disabled={ctrl.busy}
        onClick={() => {
          ctrl.closeModelEditor();
          ctrl.setForm(null);
          ctrl.setRoutePicker(null);
        }}
      >
        {openLabel}
      </button>
    </>
  );

  return (
    <div className="picker-anchor">
      <button
        type="button"
        className="native-button compact popup"
        disabled={ctrl.busy}
        title="Switch source"
        onClick={() => {
          ctrl.setOverflowMenu(null);
          ctrl.setRoutePicker(ctrl.routePicker === pickerKey ? null : pickerKey);
          ctrl.setRouteQuery('');
          ctrl.setRouteGroup(null);
        }}
      >
        {/* Account identity is on the row — face stays the verb only. */}
        <span className="popup-title">Switch</span>
        <span className="popup-chevron" aria-hidden="true">
          ⌄
        </span>
      </button>
      <RoutePicker pickerKey={pickerKey} actions={actions} extras={extras} ctrl={ctrl} />
    </div>
  );
}

export function RouteChips({
  pickerKey,
  actions,
  ctrl,
}: {
  pickerKey: string;
  actions: TrayActionSnapshot[];
  ctrl: TrayController;
}) {
  const chips = chipActionsFor(actions);
  if (!chips.length) return null;
  const more = actions.length > chips.length;
  return (
    <div className="route-chip-row">
      {chips.map((action) => {
        const selected = Boolean(action.selected);
        const disabled = !action.enabled || ctrl.busy;
        return (
          <button
            key={action.id}
            type="button"
            className={`route-chip${selected ? ' selected' : ''}`}
            disabled={selected || disabled}
            title={routeTitle(action)}
            onClick={() => ctrl.trySelectRoute(action)}
          >
            <ProviderIcon value={routeProvider(action)} size="chip" />
            {chipTitle(action)}
          </button>
        );
      })}
      {more ? (
        <button
          type="button"
          className="route-chip-more"
          disabled={ctrl.busy}
          onClick={() => {
            ctrl.setOverflowMenu(null);
            ctrl.setRoutePicker(ctrl.routePicker === pickerKey ? null : pickerKey);
            ctrl.setRouteQuery('');
            ctrl.setRouteGroup(null);
          }}
        >
          More…
        </button>
      ) : null}
    </div>
  );
}
