/**
 * What every route module is handed.
 *
 * The screen union is one flat namespace, so routes are grouped by domain
 * rather than nested: each one matches the `screen.kind`s it owns and returns
 * `null` for everything else, and `app-ui.tsx` takes the first non-null. A
 * route returning `null` for a kind it *does* own — a screen whose data has not
 * loaded — deliberately falls through to the next route, which renders the
 * relevant loading fallback.
 */

import type { ReactElement } from 'react';
import type { AnyPickApp } from '../../core/app';
import type { TuiShell } from '../use-tui-shell';
import type { TuiNav } from '../use-tui-nav';
import type { AppBindingActions } from '../actions/use-app-bindings';
import type { GatewayActions } from '../actions/use-gateway-actions';
import type { ProxyActions } from '../actions/use-proxy-actions';
import type { AccountActions } from '../actions/use-account-actions';
import type { TrayRuntimeActions } from '../actions/use-tray-runtime-actions';
import type { ModelRoleEditor } from '../actions/use-model-role-editor';
import type { HomeFilter } from '../actions/use-home-filter';
import type { ProviderFilter } from '../actions/use-provider-filter';
import type { TextInputSubmit } from '../actions/use-text-input-submit';
import type { ModelPolicyLookup } from '../../clients/model-roles';

export interface RouteCtx {
  app: AnyPickApp;
  columns: number;
  shell: TuiShell;
  nav: TuiNav;
  bindings: AppBindingActions;
  gateways: GatewayActions;
  proxies: ProxyActions;
  accounts: AccountActions;
  trayRuntime: TrayRuntimeActions;
  roleEditor: ModelRoleEditor;
  homeFilter: HomeFilter;
  accountProviderFilter: ProviderFilter;
  gatewayProviderFilter: ProviderFilter;
  submitTextInput: TextInputSubmit;
  policyLookup: ModelPolicyLookup;
}

export type Route = (ctx: RouteCtx) => ReactElement | null;
