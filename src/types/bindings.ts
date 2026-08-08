import type { Account } from './account';
import type { RuntimeProfile } from './catalog';

export type ClientId = string;

/** Protocol family accepted by clients / declared by sources. */
export type Protocol = 'openai' | 'anthropic';

export type TransportCapability =
  | 'direct'
  | 'managed_builtin_proxy'
  | 'managed_external_proxy'
  | 'external_manual_proxy'
  | 'unsupported';

export type ResourceKind = 'account' | 'gateway' | 'proxy-hub' | 'preset' | 'account-pool';

export interface AccountResourceRef {
  kind: 'account';
  provider: string;
  name: string;
}

export interface GatewayResourceRef {
  kind: 'gateway';
  name: string;
}

/** Unified local Proxy Hub profile. Display: hub:default. */
export interface ProxyHubResourceRef {
  kind: 'proxy-hub';
  name: string;
}

export interface PresetResourceRef {
  kind: 'preset';
  name: string;
}

/** Provider-scoped multi-account proxy pool (opt-in). Display: pool:grok */
export interface AccountPoolResourceRef {
  kind: 'account-pool';
  provider: string;
}

export type ResourceRef =
  | AccountResourceRef
  | GatewayResourceRef
  | ProxyHubResourceRef
  | PresetResourceRef
  | AccountPoolResourceRef;

/** Member of a provider proxy pool. */
export interface PoolMember {
  account: string;
  /** When false, account is paused and skipped by rotation. */
  enabled: boolean;
}

/**
 * Optional multi-account proxy pool for one provider.
 * mode "single" (default): each account has its own proxy process.
 * mode "multi": one shared endpoint; members enable/disable independently.
 */
export interface ProviderProxyPool {
  provider: string;
  mode: 'single' | 'multi';
  /** Pool process on/off when mode is multi. */
  enabled: boolean;
  host?: string;
  port?: number;
  strategy: 'failover' | 'round-robin';
  members: PoolMember[];
  updatedAt: string;
}

/**
 * Explicit policy for quota-driven pool failover. It is deliberately separate
 * from normal request retries: only an authoritative credential quota/balance
 * response may advance a pool, and native client logins are never touched.
 */
export interface QuotaGuardPolicy {
  enabled: boolean;
  /** Conservative fallback when the provider gives no Retry-After header. */
  cooldownMinutes: number;
}

export type ModelSelection =
  | { mode: 'explicit'; id: string }
  | { mode: 'omitted' }
  | {
      mode: 'unknown';
      reason: 'legacy_migration' | 'external_import';
    };

export interface BindingSpec {
  client: ClientId;
  source: ResourceRef;
  model: ModelSelection;
  transportPolicy: 'auto' | 'direct' | 'proxy';
  clientOptions: Record<string, unknown>;
}

export type BindingProvenance =
  | { kind: 'direct' }
  | {
      kind: 'preset_snapshot';
      presetId: string;
      presetNameAtSnapshot: string;
      presetRevisionAtSnapshot: number;
    }
  | {
      kind: 'global_binding_snapshot';
      globalBindingUpdatedAt: string;
    }
  | {
      kind: 'legacy_migration';
      sourceConfidence: 'exact';
      modelConfidence: 'exact' | 'omitted' | 'unknown';
      importedAt: string;
    };

export interface GlobalBinding {
  client: ClientId;
  spec: BindingSpec;
  provenance: BindingProvenance;
  managedConfigRevision?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectBinding {
  projectRoot: string;
  client: ClientId;
  spec: BindingSpec;
  provenance: BindingProvenance;
  createdAt: string;
  updatedAt: string;
}

/**
 * Last successful setup for one client + concrete source.
 *
 * This is deliberately separate from a global/project binding and from a
 * named preset: bindings represent the current state, presets are user-owned,
 * while this small history lets the TUI resume a source-specific setup.
 */
export interface SourceResume {
  client: ClientId;
  spec: BindingSpec;
  updatedAt: string;
}

export interface SavedPreset {
  id: string;
  name: string;
  revision: number;
  spec: Omit<BindingSpec, 'model'> & {
    model: { mode: 'explicit'; id: string } | { mode: 'omitted' };
  };
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  useCount: number;
}

export interface SourceCapabilities {
  sourceKind: 'account' | 'gateway' | 'proxy-hub';
  /** Provider/catalog identity, e.g. grok, openrouter, custom. */
  provider: string;
  /**
   * Clients for which this source can perform native/direct activation
   * without a compatibility proxy. Metadata only — never used to infer
   * a missing CLI argument.
   */
  nativeClients: ClientId[];
  protocols: Protocol[];
  canRefresh: boolean;
  supportsModelDiscovery: boolean;
  /**
   * When true, persistent activation may emit WriteNativeAuth for this
   * account source (e.g. native Codex login switch).
   */
  requiresNativeAuthWrite?: boolean;
}

export interface SourceAdapter {
  readonly sourceRef: ResourceRef;
  readonly capabilities: SourceCapabilities;
  transportFor(clientId: ClientId): TransportCapability;
}

export interface ResolvedSource {
  ref: ResourceRef;
  kind: 'account' | 'gateway' | 'proxy-hub';
  adapter: SourceAdapter;
  /** Display label for UX (e.g. grok/work, openrouter-work). */
  display: string;
}

export interface ResolvedTransport {
  capability: TransportCapability;
  protocol: Protocol;
  endpoint?: string;
  managedProxy?: {
    provider: string;
    account?: string;
    port: number;
    leaseId: string;
    /** Per-instance secret (PROXY-01) to bind into client config. */
    token?: string;
  };
  externalExecutable?: {
    name: string;
    path: string;
  };
}

export interface ClientCapabilities {
  id: ClientId;
  acceptedProtocols: Protocol[];
  supportsEnvironmentOverlay: boolean;
  supportsIsolatedHome: boolean;
  supportsPersistentConfig: boolean;
  /**
   * Preferred protocol when a source speaks more than one. Lets core resolve
   * the transport protocol from the adapter instead of a hardcoded client-id
   * table. Defaults to the first accepted protocol when omitted.
   */
  protocolPreference?: Protocol;
}

export interface IsolatablePath {
  sourcePath: string;
  destinationPath: string;
  kind: 'file' | 'directory';
  required: boolean;
}

export interface IsolatedClientRuntime {
  directory: string;
  environment: Record<string, string>;
  /** Client arguments required to activate the isolated configuration. */
  args?: string[];
  cleanup(): Promise<void>;
}

/** Plan handed to client adapters for persistent or ephemeral apply. */
export interface ResolvedClientPlan {
  clientId: ClientId;
  source: ResolvedSource;
  transport: ResolvedTransport;
  model: ModelSelection;
  mode: 'persistent' | 'ephemeral' | 'project';
  /** Gateway profile material when source is a gateway. */
  profile?: RuntimeProfile;
  /** Account when source is an account. */
  account?: Account;
  dryRun: boolean;
  verbose: boolean;
  anypickRoot: string;
}

export type PlanStepKind =
  | 'ResolveSource'
  | 'ExpandPreset'
  | 'ValidateCompatibility'
  | 'ValidateCredential'
  | 'InspectClientState'
  | 'ResolveTransport'
  | 'ValidateExternalDependency'
  | 'AllocateProxyLease'
  | 'StartProxy'
  | 'WaitForHealth'
  | 'EnsureProxyHub'
  | 'AttachProxyHubRoute'
  | 'WaitForHubHealth'
  | 'ValidateProxyHubRoute'
  | 'WriteNativeAuth'
  | 'WriteClientConfig'
  | 'CreateEnvironmentOverlay'
  | 'CreateTemporaryClientHome'
  | 'VerifyEffectiveState'
  | 'CommitGlobalBinding'
  | 'CommitProjectBinding'
  | 'SpawnChild'
  | 'ReleaseLease'
  | 'RestoreTemporaryState';

export interface PlanStep {
  kind: PlanStepKind;
  detail?: string;
  /** Serializable params only — never adapter instances. */
  params?: Record<string, unknown>;
}

export interface RollbackStep {
  kind: string;
  detail?: string;
  params?: Record<string, unknown>;
}

export interface PlanWarning {
  code: string;
  message: string;
}

export interface ActivationRequest {
  mode: 'persistent' | 'ephemeral' | 'project';
  client: ClientId;
  source?: ResourceRef;
  preset?: string;
  model?: string;
  /**
   * Per-client model role map (role id → model id).
   * Stored on BindingSpec.clientOptions.modelRoles; default role also sets model.
   */
  modelRoles?: Record<string, string>;
  projectRoot?: string;
  childArgs?: string[];
}

export interface ActivationPlan {
  mode: 'persistent' | 'ephemeral' | 'project';
  client: ClientId;
  resolvedSource: ResolvedSource;
  transport: ResolvedTransport;
  model: ModelSelection;
  steps: PlanStep[];
  rollback: RollbackStep[];
  warnings: PlanWarning[];
  /** Binding spec that will be committed (persistent/project). */
  bindingSpec?: BindingSpec;
  provenance?: BindingProvenance;
}

export type JournalState =
  | 'planned'
  | 'executing'
  | 'verifying'
  | 'committed'
  | 'rolling_back'
  | 'rolled_back'
  | 'failed';

export interface OperationJournalEntry {
  id: string;
  type: string;
  state: JournalState;
  /** Canonical serializable resource refs. */
  affectedResources: string[];
  backupPaths: string[];
  /** Serializable operation params. */
  params?: Record<string, unknown>;
  startedAt: string;
  updatedAt: string;
}

export interface ProxyLease {
  leaseId: string;
  provider: string;
  account?: string;
  port: number;
  host: string;
  endpoint?: string;
  ownerPid: number;
  /** Opaque instance id (PROC-01); proves ownership via health echo. */
  instanceId?: string;
  bindingRefs: string[];
  createdAt: string;
  updatedAt: string;
}
