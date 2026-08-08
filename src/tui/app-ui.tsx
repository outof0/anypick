/**
 * TUI — Apps + Manage + Proxy.
 * Mutations via AccountService / BindingService only.
 *
 * This component owns nothing but the hook graph. Every screen lives in a route
 * module under `routes/`, which receives that graph as one `RouteCtx` and
 * returns the first match; state belongs to the hooks so the routes stay pure
 * functions of it.
 */

import React from 'react';
import { render, useStdout } from 'ink';
import type { AnyPickApp } from '../core/app';
import { modelPolicyLookup } from '../core/model-policy';
import { useTuiShell } from './use-tui-shell';
import { useTuiNav } from './use-tui-nav';
import { useModelRoleEditor } from './actions/use-model-role-editor';
import { useAppBindings } from './actions/use-app-bindings';
import { useGatewayActions } from './actions/use-gateway-actions';
import { useProxyActions } from './actions/use-proxy-actions';
import { useAccountActions } from './actions/use-account-actions';
import { useTextInputSubmit } from './actions/use-text-input-submit';
import { useHomeFilter } from './actions/use-home-filter';
import { useProviderFilter } from './actions/use-provider-filter';
import { useTrayRuntimeActions } from './actions/use-tray-runtime-actions';
import type { RouteCtx } from './routes/context';
import { commonRoute } from './routes/common';
import { gatewayRoute } from './routes/gateway';
import { proxyRoute } from './routes/proxy';
import { accountRoute } from './routes/account';
import { appsRoute } from './routes/apps';

interface Props {
  app: AnyPickApp;
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
  const accountProviderFilter = useProviderFilter(shell);
  const gatewayProviderFilter = useProviderFilter(shell);
  const bindings = useAppBindings(app, shell, nav, policyLookup, roleEditor);
  const gateways = useGatewayActions(app, shell, nav, bindings, roleEditor);
  const proxies = useProxyActions(app, shell, nav, bindings);
  const accounts = useAccountActions(app, shell, nav);
  const trayRuntime = useTrayRuntimeActions(app, shell);
  const submitTextInput = useTextInputSubmit(app, shell, nav, accounts);
  const trayStartHandled = React.useRef(false);

  React.useEffect(() => {
    if (trayStartHandled.current || !nav.home) {
      return;
    }
    if (process.env.ANYPICK_TUI_SCREEN === 'add-account') {
      trayStartHandled.current = true;
      accounts.startAdd();
    } else if (process.env.ANYPICK_TUI_SCREEN === 'add-gateway') {
      trayStartHandled.current = true;
      gateways.startGatewayCreate();
    }
  }, [accounts, gateways, nav.home]);

  const ctx: RouteCtx = {
    app,
    columns,
    shell,
    nav,
    bindings,
    gateways,
    proxies,
    accounts,
    trayRuntime,
    roleEditor,
    homeFilter,
    accountProviderFilter,
    gatewayProviderFilter,
    submitTextInput,
    policyLookup,
  };

  // `accountRoute` is last because it also owns the legacy Switch board and the
  // account-model loading fallback.
  return (
    commonRoute(ctx) ?? appsRoute(ctx) ?? gatewayRoute(ctx) ?? proxyRoute(ctx) ?? accountRoute(ctx)
  );
}

export function runTuiApp(app: AnyPickApp): void {
  const instance = render(
    <TuiApp
      app={app}
      onExit={(code = 0) => {
        instance.unmount();
        process.exitCode = code;
        setTimeout(() => process.exit(code), 0);
      }}
    />,
  );
}
