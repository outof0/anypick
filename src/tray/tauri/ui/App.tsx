import type { ReactNode } from 'react';
import appIcon from './assets/app-icon.svg';
import { AppsView } from './components/AppsView';
import { ManageView } from './components/ManageView';
import {
  HubSourcesView,
  LogsView,
  ModelsView,
  ProxiesView,
  RoutingIssuesView,
  SettingsView,
} from './components/OtherViews';
import { useTrayController } from './hooks/useTrayController';
import type { TrayTab } from './lib/types';
import './styles.css';

export function App() {
  const ctrl = useTrayController();

  const openAddAccount = () => {
    const provider = (ctrl.snapshot?.accountProviders ?? []).find((item) => item.installed);
    ctrl.setTab('Saved accounts');
    ctrl.setForm({
      kind: 'account-add',
      providerId: provider?.id || '',
      name: '',
      label: '',
      detected: false,
    });
  };

  let view: ReactNode;
  if (!ctrl.snapshot) {
    view = <div className="empty">Waiting for AnyPick state…</div>;
  } else {
    switch (ctrl.tab as TrayTab) {
      case 'Apps':
        view = <AppsView ctrl={ctrl} />;
        break;
      case 'Saved accounts':
        view = <ManageView ctrl={ctrl} />;
        break;
      case 'Hub Sources':
        view = <HubSourcesView ctrl={ctrl} />;
        break;
      case 'Routing Issues':
        view = <RoutingIssuesView ctrl={ctrl} />;
        break;
      case 'Models':
        view = <ModelsView ctrl={ctrl} />;
        break;
      case 'Proxies':
        view = <ProxiesView ctrl={ctrl} />;
        break;
      case 'Logs':
        view = <LogsView ctrl={ctrl} />;
        break;
      case 'Settings':
        view = <SettingsView ctrl={ctrl} />;
        break;
      default:
        view = <AppsView ctrl={ctrl} />;
    }
  }

  return (
    <main className="shell">
      <header className="header">
        <div className="brand-mark" aria-hidden="true">
          <img src={appIcon} alt="" />
        </div>
        <div className="brand-copy">
          <h1>AnyPick</h1>
          <p>{ctrl.headerStatus}</p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            id="open-settings"
            className={ctrl.tab === 'Settings' ? 'active' : ''}
            title="Settings"
            aria-label="Settings"
            onClick={() => {
              ctrl.setTab('Settings');
              ctrl.setForm(null);
            }}
          >
            ⚙
          </button>
        </div>
      </header>

      <nav
        className={`tabs${ctrl.isAuxiliary ? ' auxiliary' : ''}`}
        aria-label="AnyPick sections"
      >
        {ctrl.isAuxiliary ? (
          <>
            <button type="button" onClick={() => ctrl.goBack()}>
              ‹ Back
            </button>
            <strong>{ctrl.auxiliaryTitle}</strong>
            <span />
          </>
        ) : (
          ctrl.primaryTabs.map((tab) => (
            <button
              key={tab}
              type="button"
              className={ctrl.tab === tab ? 'active' : ''}
              aria-pressed={ctrl.tab === tab}
              onClick={() => ctrl.setTab(tab)}
            >
              {tab}
            </button>
          ))
        )}
      </nav>

      {ctrl.notice ? (
        <section
          className={`notice${ctrl.notice.isError ? ' error' : ''}`}
          aria-live="polite"
        >
          {ctrl.notice.message}
        </section>
      ) : null}

      <section className="content" aria-live="polite">
        <div className="view">{view}</div>
      </section>

      <footer className="footer">
        <div className="footer-primary">
          <button type="button" className="primary" onClick={openAddAccount}>
            ＋ Add account
          </button>
          <span id="footer-status">{ctrl.footerStatus}</span>
        </div>
        <div>
          <button
            type="button"
            onClick={() =>
              ctrl.mutate('proxy-restart-all', { name: 'all' }, 'restarting enabled proxies')
            }
          >
            ↻ Restart proxies
          </button>
          <button
            type="button"
            onClick={() => ctrl.mutate('proxy-stop-all', { name: 'all' }, 'stopping all proxies')}
          >
            □ Stop proxies
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              if (ctrl.bridge.isDemo) {
                ctrl.notify('Demo: production would quit the tray and stop owned proxies.');
              } else {
                void ctrl.send('quit');
              }
            }}
          >
            ⌁ Quit
          </button>
        </div>
      </footer>
    </main>
  );
}
