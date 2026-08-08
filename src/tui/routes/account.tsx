import { LoadingView } from '../components/chrome';
import { AddModeGate } from '../components';
import { AnyPickHomeScreen } from '../screens/anypick-home';
import { AccountsHomeScreen } from '../screens/accounts-home';
import { AccountDetailScreen } from '../screens/account-detail';
import { AnyPickPreviewScreen } from '../screens/anypick-preview';
import { AddProviderScreen, AddSourceScreen, StashResultScreen } from '../screens/add-account';
import { CredentialFormScreen } from '../screens/credential-form';
import { accountProviderFilterOptions, appsUsingProxy, filterHomeByProvider } from '../model';
import { clampIndex } from '../app-ui-helpers';
import type { Route } from './context';

/** Account management, native switching, and the account-specific fallback board. */
export const accountRoute: Route = (ctx) => {
  const { app, columns, shell, nav, accounts, homeFilter, accountProviderFilter, trayRuntime } =
    ctx;
  const { screen, go, quit, selectedIndex, setSelectedIndex, busy, busyLabel, error, receipt } =
    shell;
  const { setReceipt } = shell;
  const {
    home,
    apps,
    preview,
    accountDetail,
    setAccountDetail,
    liveUsageSummary,
    contextLines,
    openSwitch,
    openApps,
    openProxy,
    openAccounts,
    openGateways,
  } = nav;
  const { providerPickRows, providerPickPurpose } = accounts;

  if (screen.kind === 'add-provider') {
    const idx = clampIndex(selectedIndex, providerPickRows.length);
    return (
      <AddProviderScreen
        providers={providerPickRows}
        selectedIndex={idx}
        purpose={providerPickPurpose}
        onMove={(d) => setSelectedIndex(clampIndex(idx + d, providerPickRows.length))}
        onSelect={(row) => {
          setSelectedIndex(0);
          if (providerPickPurpose === 'import') {
            go({
              kind: 'text-input',
              purpose: 'import-name',
              providerId: row.providerId,
              label: 'Name the imported login',
              initial: 'imported',
              back: { kind: 'accounts' },
            });
            return;
          }
          let needsSourcePick = false;
          try {
            needsSourcePick = Boolean(
              app.accounts.provider(row.providerId).requiresAccountSourcePick,
            );
          } catch {
            needsSourcePick = false;
          }
          if (needsSourcePick) {
            go({ kind: 'add-source', providerId: row.providerId });
            return;
          }
          go({ kind: 'add-mode', providerId: row.providerId });
        }}
        onBack={() => {
          void openAccounts();
        }}
      />
    );
  }

  if (screen.kind === 'add-source') {
    const providerId = screen.providerId;
    const displayName =
      providerPickRows.find((r) => r.providerId === providerId)?.displayName ?? providerId;
    return (
      <AddSourceScreen
        displayName={displayName}
        selectedIndex={clampIndex(selectedIndex, 2)}
        onMove={(d) => setSelectedIndex((i) => clampIndex(i + d, 2))}
        onSelect={(source) => {
          setSelectedIndex(0);
          go({
            kind: 'add-mode',
            providerId,
            source: source === 'antigravity' ? 'antigravity' : undefined,
          });
        }}
        onBack={() => {
          void openAccounts();
        }}
      />
    );
  }

  if (screen.kind === 'add-mode') {
    return (
      <AddModeGate
        app={app}
        providerId={screen.providerId}
        source={screen.source}
        selectedIndex={selectedIndex}
        onMove={(d) => setSelectedIndex((i) => i + d)}
        onSelectMode={(mode, identity) => {
          if (mode === 'save') {
            accounts.startSaveName(screen.providerId, identity, screen.source);
          } else if (mode === 'add-another') {
            void accounts.doPrepareAnother(screen.providerId, screen.source);
          } else if (mode === 'api-key') {
            accounts.startCredentialInput(screen.providerId, 'api-key');
          } else {
            void accounts.recheckLogin(screen.providerId, screen.source);
          }
        }}
        onBack={() => {
          if (screen.source) {
            go({ kind: 'add-source', providerId: screen.providerId });
            return;
          }
          void openAccounts();
        }}
      />
    );
  }

  if (screen.kind === 'credential-form') {
    const { providerId, credentialKind } = screen;
    const provider = app.accounts.provider(providerId);
    return (
      <CredentialFormScreen
        providerName={provider.name}
        credentialKind={credentialKind}
        fields={provider.credentialInputFields?.(credentialKind) ?? []}
        initial={screen.draft}
        error={error}
        onSubmit={(values) => {
          void accounts.doSaveCredential({
            providerId,
            kind: credentialKind,
            secret: values.secret,
            options: values.options,
            name: values.name,
          });
        }}
        onCancel={() => go(screen.back)}
      />
    );
  }

  if (screen.kind === 'stash-result') {
    return (
      <StashResultScreen
        providerId={screen.providerId}
        source={screen.source}
        displayName={screen.displayName}
        cleared={screen.cleared}
        backedUpTo={screen.backedUpTo}
        previousIdentity={screen.previousIdentity}
        matchedByIdentity={screen.matchedByIdentity}
        skippedBackup={screen.skippedBackup}
        onCheckAgain={() => {
          // add-mode re-detects and offers "Save this login", so a sign-in that
          // completed while this screen was up can be saved without starting over.
          setSelectedIndex(0);
          go({ kind: 'add-mode', providerId: screen.providerId, source: screen.source });
        }}
        onDone={() => {
          void openAccounts();
        }}
      />
    );
  }

  if (screen.kind === 'account-detail' && accountDetail) {
    return (
      <AccountDetailScreen
        app={app}
        detail={accountDetail}
        onBack={() => {
          setAccountDetail(null);
          go(screen.back);
        }}
      />
    );
  }

  if (screen.kind === 'anypick-preview' && preview) {
    return (
      <AnyPickPreviewScreen
        preview={preview}
        busy={busy}
        error={error}
        onCancel={() => {
          void openSwitch(`${screen.providerId}/${screen.name}`);
        }}
        onConfirm={() => {
          void accounts.doSwitch(screen.providerId, screen.name);
        }}
      />
    );
  }

  if (screen.kind === 'accounts' && home) {
    const providerOptions = accountProviderFilterOptions(home);
    const filteredHome = filterHomeByProvider(home, accountProviderFilter.selectedId);
    const idx = clampIndex(selectedIndex, filteredHome.rows.length);
    return (
      <AccountsHomeScreen
        model={filteredHome}
        selectedIndex={idx}
        columns={columns}
        receipt={receipt}
        busy={busy}
        busyLabel={busyLabel}
        onMove={(d) => setSelectedIndex(clampIndex(idx + d, filteredHome.rows.length))}
        providerFilterId={accountProviderFilter.selectedId}
        providerFilterLabel={accountProviderFilter.label(providerOptions)}
        providerFilterOptions={providerOptions}
        onCycleProvider={() => accountProviderFilter.cycle(providerOptions)}
        onClearProvider={accountProviderFilter.clear}
        onAdd={(providerId) => {
          accounts.startAdd(providerId);
        }}
        onViewDetail={(row) => {
          accounts.openAccountDetail(row.providerId, row.name, {
            kind: 'accounts',
            focusRef: row.ref,
          });
        }}
        onRefresh={(row) => {
          setReceipt(null);
          void accounts.doRefresh(row);
        }}
        onSaveCurrent={accounts.confirmSaveCurrent}
        onDelete={(row) => {
          accounts.confirmDelete(row, appsUsingProxy(apps, row.ref));
        }}
        onExport={(row) => {
          setReceipt(null);
          go({
            kind: 'text-input',
            purpose: 'export-path',
            providerId: row.providerId,
            accountName: row.name,
            label: 'File',
            initial: `./${row.providerId}-${row.name}.json`,
            hint: 'This file contains login secrets. Keep it private.',
            back: { kind: 'accounts', focusRef: row.ref },
          });
        }}
        onImport={accounts.startImport}
        onOpenSwitch={(row) => {
          setReceipt(null);
          void accounts.openSwitchConfirm(row);
        }}
        onSaveLive={(row) => {
          setReceipt(null);
          void accounts.openSwitchConfirm(row);
        }}
        onBack={() => {
          setReceipt(null);
          void openApps();
        }}
        onNextSection={() => {
          setReceipt(null);
          void openGateways();
        }}
        onHelp={() => {
          go({ kind: 'help', context: 'accounts', back: { kind: 'accounts' } });
        }}
        onTray={() => {
          void trayRuntime.open(screen).catch((err: unknown) => {
            shell.reportFail(err, 'Could not open Tray runtime controls.');
          });
        }}
        onDetach={() => {
          void trayRuntime.detach().catch((err: unknown) => {
            shell.reportFail(err, 'Could not detach AnyPick to the Tray.');
          });
        }}
        onQuit={() => quit(0)}
      />
    );
  }

  if (!home) {
    return (
      <LoadingView
        path={screen.kind === 'accounts' ? ['manage', 'accounts'] : 'switch'}
        label="Loading saved accounts"
      />
    );
  }

  const { model, committed } = homeFilter.view(home);
  const idx = clampIndex(selectedIndex, model.rows.length);
  return (
    <AnyPickHomeScreen
      model={model}
      selectedIndex={idx}
      columns={columns}
      filter={committed}
      filterDraft={homeFilter.draft}
      filterActive={homeFilter.active}
      contextLines={contextLines}
      usageSummary={liveUsageSummary}
      receipt={receipt}
      busy={busy}
      busyLabel={busyLabel}
      onMove={(d) => setSelectedIndex(clampIndex(idx + d, model.rows.length))}
      onSwitch={(row) => {
        setReceipt(null);
        void accounts.openSwitchConfirm(row);
      }}
      onRefresh={(row) => {
        setReceipt(null);
        void accounts.doRefresh(row, false);
      }}
      onSaveCurrent={accounts.confirmSaveCurrent}
      onAdd={(providerId) => {
        setReceipt(null);
        accounts.startAdd(providerId);
      }}
      onProxy={(row) => {
        setReceipt(null);
        void openProxy(row?.ref);
      }}
      onAccounts={() => {
        setReceipt(null);
        void openAccounts();
      }}
      onGateways={() => {
        setReceipt(null);
        void openGateways();
      }}
      onFilter={homeFilter.start}
      onFilterChange={homeFilter.change}
      onFilterSubmit={homeFilter.submit}
      onFilterClear={homeFilter.clear}
      onHelp={() => {
        go({ kind: 'help', context: 'switch', back: { kind: 'anypick' } });
      }}
      onTray={() => {
        void trayRuntime.open(screen).catch((err: unknown) => {
          shell.reportFail(err, 'Could not open Tray runtime controls.');
        });
      }}
      onDetach={() => {
        void trayRuntime.detach().catch((err: unknown) => {
          shell.reportFail(err, 'Could not detach AnyPick to the Tray.');
        });
      }}
      onQuit={() => quit(0)}
    />
  );
};
