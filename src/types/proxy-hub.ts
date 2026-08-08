import type { AccountPoolResourceRef, AccountResourceRef, ClientId, Protocol } from './bindings';
import type { AccountProxyConfig } from './account';

/** A Hub can only delegate to a concrete saved account or a provider pool. */
export type ProxyHubSourceRef = AccountResourceRef | AccountPoolResourceRef;

/** One source opted into a Hub profile. Credentials stay in the source snapshot. */
export interface ProxyHubSource {
  ref: ProxyHubSourceRef;
  enabled: boolean;
}

/**
 * A deliberate source choice for an ambiguous raw model id. The ambiguity may
 * be between provider catalogs or between credentials in one catalog. Clients
 * still send the original provider model id.
 */
export interface ProxyHubModelOwner {
  model: string;
  source: ProxyHubSourceRef;
}

/** Persisted Hub configuration. `default` is the only profile exposed in v1. */
export interface ProxyHubConfig {
  name: string;
  enabled: boolean;
  host: string;
  port: number;
  sources: ProxyHubSource[];
  modelOwners: ProxyHubModelOwner[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** One compiled, exact public model route. */
export interface ProxyHubRouteTarget {
  model: string;
  source: ProxyHubSourceRef;
  /** Lets a backend normalize an exposed id later without changing the client API. */
  upstreamModel: string;
}

/** A raw model collision across distinct catalog identities that needs an owner. */
export interface ProxyHubModelConflict {
  kind: 'model-overlap';
  model: string;
  catalogIds: string[];
  candidates: ProxyHubSourceRef[];
}

/**
 * One aggregated credential choice inside an adapter-owned catalog. Core must
 * not guess an account; users choose one source or opt into an explicit pool.
 */
export interface ProxyHubSourceChoiceConflict {
  kind: 'source-choice';
  catalogId: string;
  models: string[];
  candidates: ProxyHubSourceRef[];
}

/**
 * Token-scoped route snapshot. Its token is stored separately and is never
 * returned from status, doctor, JSON, or Tray snapshots.
 */
export interface ProxyHubRouteManifest {
  version: 1;
  hub: string;
  revision: number;
  client: ClientId;
  protocol: Protocol;
  routes: ProxyHubRouteTarget[];
}

/** Public state of the singleton Hub process; intentionally secret-free. */
export interface ProxyHubRuntimeState {
  name: string;
  endpoint?: string;
  pid?: number;
  instanceId?: string;
  logPath?: string;
  startedAt?: string;
}

/** A public status row safe for CLI JSON, TUI, Tray, logs, and doctor. */
export interface ProxyHubStatus {
  name: string;
  enabled: boolean;
  running: boolean;
  endpoint?: string;
  pid?: number;
  sourceCount: number;
  modelCount: number;
  conflictCount: number;
  revision: number;
  detail?: string;
}

/** Account material handed to a provider-owned in-process Hub backend. */
export interface ProxyHubBackendAccount {
  name: string;
  snapshotDir: string;
  proxy: AccountProxyConfig;
}

/**
 * Context and lifecycle for a provider backend hosted behind the single public
 * Hub listener. `token` is an internal loopback secret, never a client token.
 */
export interface ProxyHubBackendContext {
  source: ProxyHubSourceRef;
  accounts: readonly ProxyHubBackendAccount[];
  token: string;
  log: (line: string) => void;
}

export interface ProxyHubBackendHandle {
  endpoint: string;
  close(): Promise<void>;
}
