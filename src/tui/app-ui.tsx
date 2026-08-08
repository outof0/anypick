/**
 * TUI — Switch + Proxy + Accounts (DESIGN-TUI.md).
 * Mutations via AccountService / BindingService only.
 *
 * This component owns nothing but the hook graph. Every screen lives in a route
 * module under `routes/`, which receives that graph as one `RouteCtx` and
 * returns the first match; state belongs to the hooks so the routes stay pure
 * functions of it.
 */

import React from 'react';
import { render, useStdout } from 'ink';
import type { HotplugApp } from '../core/app';
import { modelPolicyLookup } from '../core/model-policy';
import { errorText, useTuiShell } from './use-tui-shell';
import { useTuiNav } from './use-tui-nav';
import { useModelRoleEditor } from './actions/use-model-role-editor';
import { useAppBindings } from './actions/use-app-bindings';
import { useGatewayActions } from './actions/use-gateway-actions';
import { useProxyActions } from './actions/use-proxy-actions';
import { useAccountActions } from './actions/use-account-actions';
import { useTextInputSubmit } from './actions/use-text-input-submit';
import { useHomeFilter } from './actions/use-home-filter';
import type { RouteCtx } from './routes/context';
import { commonRoute } from './routes/common';
import { gatewayRoute } from './routes/gateway';
import { proxyRoute } from './routes/proxy';
import { accountRoute } from './routes/account';

interface Props {
  app: HotplugApp;
  onExit: (code?: number) => void;
}

export function TuiApp(props: Props) {
  const { app, onExit } = props;
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  const shell = useTuiShell(onExit);

  // Registries are sealed at app creation, so the lookup is stable for the
  // lifetime of this component.
  const policyLookup = React.useMemo(
    () =>
      modelPolicyLookup({
        accountRegistry: app.accountRegistry,
        catalog: app.catalog,
      }),
    [app],
  );

  const nav = useTuiNav(app, shell);
  const roleEditor = useModelRoleEditor();
  const homeFilter = useHomeFilter(shell);
  const bindings = useAppBindings(app, shell, nav, policyLookup, roleEditor);
  const gateways = useGatewayActions(app, shell, nav, bindings, roleEditor);
  const proxies = useProxyActions(app, shell, nav, bindings);
  const accounts = useAccountActions(app, shell, nav);
  const submitTextInput = useTextInputSubmit(app, shell, nav, accounts);

  const ctx: RouteCtx = {
    app,
    columns,
    shell,
    nav,
    bindings,
    gateways,
    proxies,
    accounts,
    roleEditor,
    homeFilter,
    submitTextInput,
  };

  // `accountRoute` is last because it also owns the Switch board, which is both
  // the default screen and the fallback while the model is still loading.
  return commonRoute(ctx) ?? gatewayRoute(ctx) ?? proxyRoute(ctx) ?? accountRoute(ctx);
}

export function runTuiApp(app: HotplugApp): void {
  const instance = render(
    <TuiApp
      app={app}
      onExit={(code = 0) => {
        instance.unmount();
        const cliEntry = process.argv[1];
        const finish = () => {
          process.exitCode = code;
          setTimeout(() => process.exit(code), 0);
        };
        if (process.env.HOTPLUG_NO_TRAY === '1' || !cliEntry) {
          finish();
          return;
        }
        // Closing the terminal UI hands ownership to the tray supervisor.
        // macOS keeps a native menu-bar icon; other platforms use a headless
        // background owner so enabled proxies remain alive.
        // "Quit Hotplug" from that menu is the explicit graceful shutdown.
        void import('../tray/supervisor')
          .then(({ startTray }) => startTray(app.root, cliEntry))
          .catch((err: unknown) => {
            process.stderr.write(`Could not start Hotplug tray: ${errorText(err)}\n`);
          })
          .finally(finish);
      }}
    />,
  );
}
