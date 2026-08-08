/**
 * What every route module is handed.
 *
 * The screen union is one flat namespace, so routes are grouped by domain
 * rather than nested: each one matches the `screen.kind`s it owns and returns
 * `null` for everything else, and `app-ui.tsx` takes the first non-null. A
 * route returning `null` for a kind it *does* own — a screen whose data has not
 * loaded — deliberately falls through to the next route, which is how the
 * Switch board doubles as the loading fallback.
 */

import type { ReactElement } from 'react';
import type { HotplugApp } from '../../core/app';
import type { TuiShell } from '../use-tui-shell';
import type { TuiNav } from '../use-tui-nav';
import type { AppBindingActions } from '../actions/use-app-bindings';
import type { GatewayActions } from '../actions/use-gateway-actions';
import type { ProxyActions } from '../actions/use-proxy-actions';
import type { AccountActions } from '../actions/use-account-actions';
import type { ModelRoleEditor } from '../actions/use-model-role-editor';
import type { HomeFilter } from '../actions/use-home-filter';
import type { TextInputSubmit } from '../actions/use-text-input-submit';

export interface RouteCtx {
  app: HotplugApp;
  columns: number;
  shell: TuiShell;
  nav: TuiNav;
  bindings: AppBindingActions;
  gateways: GatewayActions;
  proxies: ProxyActions;
  accounts: AccountActions;
  roleEditor: ModelRoleEditor;
  homeFilter: HomeFilter;
  submitTextInput: TextInputSubmit;
}

export type Route = (ctx: RouteCtx) => ReactElement | null;
