import { LoadingView, ScreenShell } from '../components/chrome';
import { MessageContinue } from '../components';
import { HelpScreen } from '../screens/help';
import { ConfirmScreen } from '../screens/confirm';
import { TextInputScreenView } from '../screens/text-input';
import { TrayRuntimeScreen } from '../screens/tray-runtime';
import { providerDisplayName } from '../model';
import { errorText } from '../use-tui-shell';
import type { Route } from './context';

/** Chrome that belongs to no single domain: loading, help, receipts, prompts. */
export const commonRoute: Route = (ctx) => {
  const { app, shell, nav, submitTextInput, trayRuntime } = ctx;
  const {
    screen,
    go,
    quit,
    busy,
    busyLabel,
    error,
    receipt,
    setError,
    withBusy,
    setReceipt,
    reportFail,
  } = shell;
  const { home, openApps, openSwitch, openProxy, openAccounts } = nav;

  if (screen.kind === 'loading' || (screen.kind === 'anypick' && !home)) {
    return (
      <LoadingView
        path={screen.kind === 'anypick' ? 'switch' : 'apps'}
        label={screen.kind === 'loading' ? screen.label : 'Loading saved accounts'}
      />
    );
  }

  if (screen.kind === 'help') {
    return <HelpScreen context={screen.context} onBack={() => go(screen.back)} />;
  }

  if (screen.kind === 'tray-runtime') {
    return (
      <TrayRuntimeScreen
        available={trayRuntime.available}
        status={trayRuntime.status}
        defaultSurface={trayRuntime.defaultSurface}
        busy={busy}
        busyLabel={busyLabel}
        receipt={receipt}
        onRefresh={() => {
          void withBusy('Refreshing Tray runtime', trayRuntime.refresh).catch((err: unknown) => {
            reportFail(err, 'Could not refresh Tray runtime status.');
          });
        }}
        onToggle={() => {
          const action = trayRuntime.status?.running ? trayRuntime.stop : trayRuntime.start;
          void action().catch((err: unknown) => {
            reportFail(err, 'Could not change the Tray runtime.');
          });
        }}
        onToggleDefaultSurface={() => {
          void trayRuntime.toggleDefaultSurface().catch((err: unknown) => {
            reportFail(err, 'Could not change the default AnyPick surface.');
          });
        }}
        onDetach={() => {
          void trayRuntime.detach().catch((err: unknown) => {
            reportFail(err, 'Could not detach AnyPick to the Tray.');
          });
        }}
        onBack={() => go(screen.back)}
        onQuit={() => quit(0)}
      />
    );
  }

  if (screen.kind === 'message') {
    return (
      <ScreenShell
        path="switch"
        outcome={screen.msg ?? screen.receipt?.lines[0]?.text ?? ''}
        support=""
        hints={[{ key: 'enter', label: 'continue' }]}
        receipt={screen.receipt}
      >
        <MessageContinue
          onContinue={() => {
            setReceipt(null);
            void (async () => {
              if (screen.back.kind === 'apps') {
                await openApps(screen.back.focusClientId);
              } else if (screen.back.kind === 'anypick') {
                await openSwitch();
              } else if (screen.back.kind === 'proxy') {
                await openProxy();
              } else if (screen.back.kind === 'accounts') {
                await openAccounts();
              } else {
                go(screen.back);
              }
            })();
          }}
        />
      </ScreenShell>
    );
  }

  if (screen.kind === 'confirm') {
    return (
      <ConfirmScreen
        title={screen.title}
        body={screen.body}
        confirmLabel={screen.confirmLabel}
        cancelLabel={screen.cancelLabel}
        path={screen.path}
        danger={screen.danger}
        busy={busy}
        busyLabel={busyLabel}
        error={error}
        onCancel={() => go(screen.back)}
        onConfirm={() => {
          // Clear the previous failure before retrying. This creates a new
          // error transition if the retry fails with the same message, which
          // resets ConfirmScreen's one-shot submission guard again.
          setError(undefined);
          void withBusy(screen.confirmLabel ?? 'Working', async () => {
            try {
              await screen.action();
            } catch (err) {
              setError(errorText(err));
            }
          });
        }}
      />
    );
  }

  if (screen.kind === 'text-input') {
    return (
      <TextInputScreenView
        screen={screen}
        providerName={providerDisplayName(app, screen.providerId)}
        error={error}
        onCancel={() => go(screen.back)}
        onSubmit={(value) => {
          const v = value.trim();
          // An API key is the one value allowed through empty, so a gateway can
          // be created now and keyed later.
          if (!v && screen.purpose !== 'gateway-api-key') {
            setError(
              screen.purpose === 'save-name'
                ? 'Name needs at least one letter or number.'
                : 'Value is required',
            );
            return;
          }
          void submitTextInput(screen, v);
        }}
      />
    );
  }

  return null;
};
