import type { ClientAdapter, ProxyHubSourceRef } from '../types';
import type { TrayPreferences } from './settings';
import type { TrayActivityRecord } from './activity';

export interface TrayRouteSnapshot {
  clientId: string;
  client: string;
  source?: string;
  model?: string;
  status: 'ready' | 'attention' | 'native' | 'unbound';
}

export type TrayActionKind = 'native' | 'gateway';
/**
 * Source-first switch kinds. One tray action per bindable source — models are
 * configured in Configure Models or the client’s own picker, not Switch fan-out.
 * Legacy `hub-model` / `gateway-model` were per-model actions and are gone.
 */
export type TrayRouteKind = 'direct-account' | 'account' | 'gateway' | 'pool' | 'hub';

export interface TrayActionSnapshot {
  id: string;
  clientId: string;
  sourceId: string;
  client: string;
  label: string;
  detail?: string;
  kind: TrayActionKind;
  presentation: 'app-route' | 'native-account';
  selected: boolean;
  enabled: boolean;
  disabledReason?: string;
  routeKind?: TrayRouteKind;
  modelId?: string;
  upstreamProviderId?: string;
  upstreamSourceLabel?: string;
}

export interface TrayActionTarget {
  clientId: string;
  source: string;
  model?: string;
  modelRoles?: Record<string, string>;
}

export interface TrayClientModelRoleSnapshot {
  id: string;
  label: string;
}

export interface TrayClientModelOptionSnapshot {
  actionId: string;
  modelId: string;
  providerId: string;
  sourceLabel: string;
}

export interface TrayClientModelConfigSnapshot {
  clientId: string;
  client: string;
  sourceLabel?: string;
  editable: boolean;
  unavailableReason?: string;
  roles: TrayClientModelRoleSnapshot[];
  defaultModel?: string;
  modelRoles: Record<string, string>;
  options: TrayClientModelOptionSnapshot[];
}

export interface TrayAccountProxyActionTarget {
  operation: 'enable' | 'disable' | 'restart';
  providerId: string;
  accountName: string;
}

/** Switch the live login for a provider that has no client routing surface (Grok, OpenCode). */
export interface TrayAccountSwitchActionTarget {
  operation: 'account-switch';
  providerId: string;
  accountName: string;
}

export interface TrayHubProxyActionTarget {
  operation: 'hub-start' | 'hub-stop' | 'hub-restart';
  name: string;
}

export interface TrayHubOwnerActionTarget {
  operation: 'hub-own-models';
  name: string;
  models: string[];
  source: ProxyHubSourceRef;
}

export interface TrayHubTestActionTarget {
  operation: 'hub-test';
  name: string;
}

export type TrayProxyActionTarget =
  | TrayAccountProxyActionTarget
  | TrayAccountSwitchActionTarget
  | TrayHubProxyActionTarget
  | TrayHubOwnerActionTarget
  | TrayHubTestActionTarget;

export interface TrayProxySnapshot {
  id: string;
  providerId: string;
  label: string;
  detail: string;
  address?: string;
  running: boolean;
  enabled: boolean;
  /** Whether this runtime has an allowlisted supervisor-owned log stream. */
  logsAvailable?: boolean;
  /** Present for the Hub's source, catalog, and routed-client summaries. */
  sourceCount?: number;
  modelCount?: number;
  clientCount?: number;
  conflictCount?: number;
  toggleActionId: string;
  restartActionId: string;
  testActionId?: string;
}

export interface TrayManagedAccountSnapshot {
  id: string;
  providerId: string;
  sourceId?: string;
  name: string;
  label: string;
  detail: string;
  active: boolean;
  canRefresh: boolean;
}

/**
 * A saved account the Hub can use as an upstream. This is deliberately only
 * display and reference data: snapshot paths and credentials stay in the
 * supervisor.
 */
export interface TrayHubSourceSnapshot {
  id: string;
  providerId: string;
  name: string;
  label: string;
  detail: string;
  enabled: boolean;
  status: 'disabled' | 'ready' | 'unavailable';
  modelCount: number;
  warning?: string;
}

export interface TrayHubConflictCandidateSnapshot {
  id: string;
  providerId: string;
  label: string;
  detail: string;
  actionId: string;
}

export interface TrayHubConflictSnapshot {
  id: string;
  kind: 'model-overlap' | 'source-choice';
  title: string;
  models: string[];
  candidates: TrayHubConflictCandidateSnapshot[];
}

export interface TrayLogSourceSnapshot {
  id: string;
  label: string;
  detail: string;
  providerId: string;
  name: string;
}

export interface TrayGatewaySnapshot {
  id: string;
  providerId: string;
  name: string;
  detail: string;
  ready: boolean;
  defaultModel?: string;
}

export interface TrayAccountProviderSnapshot {
  id: string;
  providerId: string;
  /** Client that can be routed through this provider, when one exists. */
  clientId?: string;
  sourceId?: string;
  label: string;
  detail: string;
  installed: boolean;
  /**
   * Provider can clear the live app login (local wipe only — not a remote
   * logout). Used by the tray form so a second login can be signed in.
   */
  canClear?: boolean;
}

export interface TrayGatewayProviderSnapshot {
  id: string;
  label: string;
  detail: string;
  /**
   * How a selection is saved. `gateway` (default) creates a catalog profile;
   * `account-api-key` is a proxy-only account provider (e.g. Kiro) whose key is
   * saved through account-save with an api-key credential, not gateway-create.
   */
  kind?: 'gateway' | 'account-api-key';
  /** For `account-api-key`: region choices from the provider's credential input. */
  regions?: string[];
  regionDefault?: string;
}

export interface TrayUsageWindow {
  label: string;
  remainingPercent: number;
  resetsAtMs?: number;
}

export interface TrayUsageSnapshot {
  client: string;
  account: string;
  windows: TrayUsageWindow[];
}

export interface TrayActionRegistry {
  revision: number;
  register(target: TrayActionTarget | TrayProxyActionTarget): string;
}

export interface TraySnapshotOptions {
  usage?: TrayUsageSnapshot[];
  settings?: TrayPreferences;
  activity?: TrayActivityRecord[];
  isNativeSourceInstalled?: (client: ClientAdapter, sourceId: string) => Promise<boolean>;
}

export interface TraySnapshot {
  proxyCount: number;
  revision: number;
  routes: TrayRouteSnapshot[];
  actions: TrayActionSnapshot[];
  clientModelConfigs: TrayClientModelConfigSnapshot[];
  usage: TrayUsageSnapshot[];
  proxies: TrayProxySnapshot[];
  accounts: TrayManagedAccountSnapshot[];
  hubSources: TrayHubSourceSnapshot[];
  hubConflicts: TrayHubConflictSnapshot[];
  logSources: TrayLogSourceSnapshot[];
  gateways: TrayGatewaySnapshot[];
  accountProviders: TrayAccountProviderSnapshot[];
  gatewayProviders: TrayGatewayProviderSnapshot[];
  settings: TrayPreferences;
  activity: TrayActivityRecord[];
}
