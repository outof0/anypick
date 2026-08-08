import type { ApiStyle, RuntimeProfile } from './catalog';
import type {
  ClientCapabilities,
  IsolatedClientRuntime,
  IsolatablePath,
  ResolvedClientPlan,
} from './bindings';

export type ClientConfigMode = 'none' | 'profile' | 'account';

/**
 * One model slot an app exposes in its settings (client-shaped, not provider-shaped).
 * Claude Code: default + sonnet/opus/haiku. Codex/Kiro: default only.
 */
export interface ClientModelRole {
  /** Stable id stored in BindingSpec.clientOptions.modelRoles */
  id: string;
  /** Short UI label (sentence case), e.g. "Sonnet" */
  label: string;
}

export interface ClientState {
  clientId: string;
  mode: ClientConfigMode;
  profileName?: string;
  accountRef?: { provider: string; name: string };
  updatedAt: string;
  /** Paths we last wrote / managed (for precise reset). */
  managedPaths: string[];
  /** Env keys we set in client env files / settings. */
  managedEnvKeys: string[];
}

export interface ApplyContext {
  profile: RuntimeProfile;
  clientId: string;
  dryRun: boolean;
  verbose: boolean;
  /** Active proxy endpoint if started for this apply. */
  proxyEndpoint?: string;
  /** Hotplug data root (for client-local backups under clients/). */
  hotplugRoot: string;
  /**
   * When set, client adapters write into this home instead of the live user home.
   * Used by isolated ephemeral runtimes (spec §9.7.1).
   */
  isolatedHome?: string;
}

/** Minimal live-state handle for isolation path listing. */
export interface ClientLiveState {
  home: string;
}

export interface ClientInspectResult {
  present: boolean;
  configPaths: string[];
  summary?: string;
  issues?: string[];
}

/**
 * Applies / resets runtime configuration for one AI application.
 * Core must never contain client-specific write logic.
 */
export interface ClientAdapter {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly supportedApiStyles: ApiStyle[];
  /**
   * Capability flags for activation planner (spec §20.2).
   * supportsIsolatedHome may be true only when isolation methods exist.
   */
  readonly capabilities?: ClientCapabilities;
  /**
   * Model slots this app writes into settings when a proxy/profile is applied.
   * Defaults to a single "default" role when omitted.
   */
  modelRoles?(): readonly ClientModelRole[];

  validate(ctx: ApplyContext): Promise<void>;

  /**
   * Apply runtime configuration. Must be idempotent enough to re-apply.
   * Returns managed paths and env keys for client state tracking.
   * When ctx.isolatedHome is set, writes only under that home (no live mutation).
   */
  apply(ctx: ApplyContext): Promise<{
    managedPaths: string[];
    managedEnvKeys: string[];
  }>;

  /**
   * Remove hotplug-managed configuration; restore backups when present.
   * Preserve unrelated user configuration.
   */
  reset(state: ClientState): Promise<void>;

  inspect(): Promise<ClientInspectResult>;

  /**
   * Explicit allowlist of live paths that may be copied into an isolated runtime.
   * Required when capabilities.supportsIsolatedHome is true (spec §9.7.1).
   */
  listIsolatablePaths?(liveState: ClientLiveState): Promise<readonly IsolatablePath[]>;

  /**
   * Create an owner-only temporary client runtime for ephemeral `run`.
   * Required when capabilities.supportsIsolatedHome is true.
   */
  createIsolatedRuntime?(
    plan: ResolvedClientPlan,
    paths: readonly IsolatablePath[],
  ): Promise<IsolatedClientRuntime>;

  /**
   * Create an ephemeral environment overlay when a client cannot safely use
   * an isolated home. Required when `supportsEnvironmentOverlay` is true and
   * `supportsIsolatedHome` is false. It must not mutate live client state.
   */
  createEnvironmentOverlay?(plan: ResolvedClientPlan): Promise<IsolatedClientRuntime>;

  /**
   * Persistent apply via resolved plan (optional convenience over apply()).
   */
  applyPersistent?(
    plan: ResolvedClientPlan,
  ): Promise<{ managedPaths: string[]; managedEnvKeys: string[] }>;
}

// ── Global config ────────────────────────────────────────────────

export interface GlobalConfig {
  schemaVersion: number;
  /** Client applied by `profile use` when --client is omitted. */
  defaultClient?: string;
  /** Last activated runtime profile (name slug). */
  activeProfile?: string;
  defaults?: {
    proxyHost?: string;
  };
  ui?: {
    color?: boolean;
  };
}

export const CURRENT_SCHEMA_VERSION = 2;

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  defaultClient: 'claude',
};

// ── DX redesign: resource refs, bindings, sources, isolation ──────

/** Stable client identifier (e.g. "claude", "codex", "kiro"). */
