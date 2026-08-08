import { LoadingView, ScreenShell } from '../components/chrome';
import { MessageContinue } from '../components';
import { HelpScreen } from '../screens/help';
import { ConfirmScreen } from '../screens/confirm';
import { TextInputScreenView } from '../screens/text-input';
import { providerDisplayName } from '../model';
import { errorText } from '../use-tui-shell';
import type { Route } from './context';

/** Chrome that belongs to no single domain: loading, help, receipts, prompts. */
export const commonRoute: Route = (ctx) => {
  const { app, shell, nav, submitTextInput } = ctx;
  const { screen, go, busy, busyLabel, error, setError, withBusy, setReceipt } = shell;
  const { home, openSwitch, openProxy, openAccounts } = nav;

  if (screen.kind === 'loading' || (screen.kind === 'hotplug' && !home)) {
    return (
      <LoadingView label={screen.kind === 'loading' ? screen.label : 'Loading saved logins'} />
    );
  }

  if (screen.kind === 'help') {
    return <HelpScreen context={screen.context} onBack={() => go(screen.back)} />;
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
              if (screen.back.kind === 'hotplug') {
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
