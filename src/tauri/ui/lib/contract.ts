/**
 * The desktop UI's data contract, generated from the Go engine.
 *
 * Source of truth is `go/internal/desktop/snapshot.go`. Nothing here is
 * invented and nothing is a fixture: if a field is listed, the engine sends it.
 * The engine speaks this shape over the stdio desktop protocol, the Rust layer
 * forwards it, and this file is the TypeScript mirror of it.
 *
 * Do not add fields "for the UI's convenience" — change the Go struct, or map
 * at the edge. A contract that drifts from the engine is worse than none.
 *
 * `test/contract-drift.test.ts` reads `snapshot.go` and fails the build when a
 * Go JSON tag has no counterpart here, so the mirror cannot rot silently.
 */

/** One engine object whose shape the engine itself documents as free-form. */
export type EngineMap = Record<string, unknown>;

export type DegradedCondition = {
  id: string;
  kind: string;
  title: string;
  detail: string;
};

/** One selectable client → source route. */
export type ActionRow = {
  id: string;
  clientId: string;
  sourceId: string;
  client: string;
  label: string;
  detail?: string;
  /** 'native' | 'gateway' | 'hub' */
  kind: string;
  /** 'native-account' | 'app-route' */
  presentation: string;
  selected: boolean;
  enabled: boolean;
  disabledReason?: string;
  /** 'direct-account' | 'managed-account' | 'gateway' | 'hub' */
  routeKind?: string;
};

export type AccountRow = {
  id: string;
  providerId: string;
  sourceId?: string;
  name: string;
  label: string;
  detail: string;
  active: boolean;
  canRefresh: boolean;
  switchActionId: string;
};

export type ProxyRow = {
  id: string;
  providerId: string;
  label: string;
  detail: string;
  address?: string;
  running: boolean;
  enabled: boolean;
  logsAvailable?: boolean;
  toggleActionId: string;
  restartActionId: string;
  rotateActionId?: string;
  /**
   * Says a copy can be fetched. The bearer itself never crosses into the
   * snapshot (ADR 0006); the UI asks for it with the `proxy-token` operation
   * and reads it from the result payload.
   */
  hasToken?: boolean;
};

export type LogSourceRow = {
  id: string;
  providerId: string;
  name: string;
  label: string;
  detail: string;
};

/**
 * The engine emits gateways as a free-form map today. These are the keys it
 * actually writes; a reader that needs one of them should read it through
 * `decodeGateway` so a missing or mistyped key becomes one place to fix.
 */
export type GatewayRow = {
  id: string;
  providerId: string;
  name: string;
  detail: string;
  ready: boolean;
  defaultModel: string;
};

export type LoginMethodRow = {
  id: string;
  label: string;
  detail?: string;
  /** 'official' | 'community' */
  provenance: string;
  preferred: boolean;
  sourceId?: string;
  sourceLabel?: string;
  available: boolean;
  unavailableReason?: string;
};

export type CredentialProfileRow = {
  id: string;
  label: string;
};

export type CredentialKindRow = {
  kind: string;
  label: string;
  profiles: CredentialProfileRow[];
  /** The product works without a key (a local model server). */
  secretOptional?: boolean;
};

export type AccountProviderRow = {
  id: string;
  providerId: string;
  clientId?: string;
  sourceId?: string;
  label: string;
  detail: string;
  installed: boolean;
  livePresent: boolean;
  liveIdentity?: string;
  loginMethods: LoginMethodRow[];
  canClear?: boolean;
  /**
   * The explicit credential products this provider accepts through
   * `account-save-input`. Native-only providers leave it empty: those
   * accounts come from a live login or a browser sign-in, never typed input.
   * Definitions only — no secrets cross this boundary.
   */
  credentialKinds?: CredentialKindRow[];
  /**
   * The provider can save its own auth file from pasted JSON. Absent on a
   * snapshot from an older engine, which means the paste field stays hidden.
   */
  acceptsAuthPaste?: boolean;
};

export type GatewayProviderRow = {
  id: string;
  label: string;
  detail: string;
  providesEndpoint?: boolean;
  requiresApiKey: boolean;
  defaultEndpoint?: string;
  firstPartyClientIds?: string[];
  kind?: string;
  requiresGatewayId?: boolean;
  requiresAccountId?: boolean;
};

export type CodexProfileRow = {
  name: string;
  sourceId: string;
  sourceLabel: string;
  modelId: string;
  /** 'auto' | 'direct' | 'proxy' */
  transportPolicy: string;
  launchCommand: string;
  /** True when this machine can open the profile in the Codex desktop app (macOS). */
  appOpenable?: boolean;
  /** Absent from engines that predate codex-profile-terminal. */
  terminalOpenable?: boolean;
};

export type CodexProfileSourceRow = {
  sourceId: string;
  kind: string;
  label: string;
  detail: string;
  selected: boolean;
  models: string[];
};

export type UsageWindow = {
  label: string;
  remainingPercent: number;
  resetsAtMs?: number;
  limitWindowSeconds?: number;
  group?: string;
};

export type UsageSnapshotRow = {
  providerId?: string;
  client: string;
  account: string;
  windows: UsageWindow[];
};

export type RouteRow = {
  clientId: string;
  client: string;
  /** 'unbound' | 'native' | 'ready' */
  status: string;
  source?: string;
  model?: string;
};

export type ModelRole = {
  id: string;
  label: string;
};

export type ModelOption = {
  actionId: string;
  modelId: string;
  providerId?: string;
  sourceLabel?: string;
};

export type ClientModelConfig = {
  clientId: string;
  client: string;
  roles: ModelRole[];
  modelRoles: Record<string, string>;
  options: ModelOption[];
  editable: boolean;
  unavailableReason?: string;
  sourceLabel?: string;
  /** "provider" means the pins were inherited. "explicit" means this connection customized them. */
  modelRolesSource?: string;
  defaultModel?: string;
};

/** An account attached to a hub. */
export type HubAccountSource = {
  id: string;
  providerId: string;
  /** The account name, or `pool:<provider>`. */
  name: string;
  label: string;
  detail: string;
  enabled: boolean;
  hub: string;
};

/** A source that points at an account the engine no longer has. */
export type HubGhostSource = HubAccountSource & {
  ghost: true;
  unavailableReason: string;
};

/** Every account of one provider, rotated as a unit. */
export type HubPoolSource = {
  id: string;
  providerId: string;
  name: string;
  label: string;
  detail: string;
  enabled: true;
  hub: string;
  poolSource: true;
};

/** Failover versus round-robin, for one hub. */
export type HubRotationSource = {
  id: string;
  providerId: string;
  name: 'rotation';
  label: string;
  detail: string;
  /** True is round-robin, false is failover. Kept for older engines. */
  enabled: boolean;
  /** The hub-wide request mode. Absent from an engine that predates it. */
  strategy?: HubStrategy;
  hub: string;
  rotates: true;
  accountCount: number;
};

export type HubStrategy = 'failover' | 'round-robin' | 'soonest-reset';

export type HubSource =
  | HubAccountSource
  | HubGhostSource
  | HubPoolSource
  | HubRotationSource;

export type HubConflictCandidate = {
  id: string;
  providerId: string;
  label: string;
  detail: string;
  actionId: string;
  providerChoice: boolean;
};

export type HubConflict = {
  id: string;
  /** 'source-choice' | 'model-overlap' */
  kind: string;
  title: string;
  models: string[];
  candidates: HubConflictCandidate[];
};

export type HubPublishedModel = {
  id: string;
  ownerLabel: string;
  ownerProviderId: string;
  needsChoice: boolean;
  ownerAccountId?: string;
};

export type HubCatalog = {
  accountID: string;
  catalog: string;
  models: string[];
};

export type ActivityRow = {
  id: string;
  createdAt: string;
  message: string;
  isError: boolean;
  /** 'activation' | 'gateway' | 'proxy' | 'quota' | 'settings' */
  kind: string;
  /** Omitted when the event is unbranded. Absent is not a fallback glyph. */
  provider?: string;
};

export type Preferences = {
  launchAtLogin: boolean;
  startEnabledProxies: boolean;
  showQuota: boolean;
  quotaGuardEnabled: boolean;
  language: string;
  resolvedLanguage: string;
  languageOptions: Array<{ value: string; label: string }>;
};

/** The full snapshot the engine pushes after a handshake and on every change. */
export type Snapshot = {
  proxyCount: number;
  revision: number;
  routes: RouteRow[];
  actions: ActionRow[];
  clientModelConfigs: ClientModelConfig[];
  usage: UsageSnapshotRow[];
  proxies: ProxyRow[];
  accounts: AccountRow[];
  hubSources: HubSource[];
  hubConflicts: HubConflict[];
  hubPublishedModels: HubPublishedModel[];
  hubCatalogs: HubCatalog[];
  codexProfiles: CodexProfileRow[];
  codexProfileSources: CodexProfileSourceRow[];
  logSources: LogSourceRow[];
  gateways: GatewayRow[];
  accountProviders: AccountProviderRow[];
  gatewayProviders: GatewayProviderRow[];
  settings: Preferences;
  activity: ActivityRow[];
  degradedConditions: DegradedCondition[];
};

/** Engine-backed pane destinations. The shell-only Settings route is separate. */
export const DESTINATIONS = [
  'overview',
  'apps',
  'accounts',
  'proxyHub',
  'proxies',
  'activity',
  'backups',
] as const;

export type Destination = (typeof DESTINATIONS)[number];

/** UI destinations include Settings, which has no engine-owned data route. */
export type AppDestination = Destination | 'settings';

export function isDestination(value: string): value is Destination {
  return (DESTINATIONS as readonly string[]).includes(value);
}
