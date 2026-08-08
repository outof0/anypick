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
 * Claude Code: default + sonnet/opus/haiku. Codex Desktop/Hub: default + list2–5.
 * Kiro (and other single-model apps): default only.
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
  /** AnyPick data root (for client-local backups under clients/). */
  anypickRoot: string;
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

export interface NativeClientInstallation {
  /** Provider-owned native source id, e.g. `gemini-cli` or `antigravity`. */
  sourceId: string;
  /** Any matching executable or macOS application makes this source installed. */
  executables?: readonly string[];
  macApplications?: readonly string[];
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
   * Short UI label for compact lists (Run column, tray). Defaults to `name`
   * truncated by the presentation layer when omitted — never hardcode client
   * ids in CLI/TUI switches.
   */
  readonly shortName?: string;
  /**
   * Executable name (or env-overridable default) used by `anypick run`.
   * When omitted, the client id is used. Env overrides still win when set
   * (`CLAUDE_BINARY`, `CODEX_BINARY`, …) via `binaryEnvVar`.
   */
  readonly binaryName?: string;
  /**
   * Environment variable that overrides `binaryName` for this client
   * (e.g. `CLAUDE_BINARY`). Optional.
   */
  readonly binaryEnvVar?: string;
  /**
   * Sources worth exposing in compact app-routing surfaces such as Apps and
   * the macOS tray. Native-only is the safe default: clients opt into gateway
   * routing only when that is a first-class workflow.
   */
  readonly routingSurfacePolicy?: 'native-only' | 'all-compatible';
  /** Installation probes for native-only account switches in compact surfaces. */
  readonly nativeInstallations?: readonly NativeClientInstallation[];
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
   * Remove anypick-managed configuration; restore backups when present.
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
    /** Surface opened by bare `anypick` in an interactive terminal. */
    defaultSurface?: 'tui' | 'tray';
    /** Opt-in automatic failover for multi-account compatibility proxies only. */
    quotaGuard?: {
      enabled?: boolean;
      cooldownMinutes?: number;
    };
    tray?: {
      startEnabledProxies?: boolean;
      showQuota?: boolean;
      /** Legacy one-time guide marker, kept for config compatibility. */
      guideSeen?: boolean;
    };
  };
}

export const CURRENT_SCHEMA_VERSION = 2;

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  defaultClient: 'claude',
};

// ── DX redesign: resource refs, bindings, sources, isolation ──────

/** Stable client identifier (e.g. "claude", "codex", "kiro"). */
