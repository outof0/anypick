import type { SourceAdapter } from './bindings';
import type { ModelPolicy } from './catalog';
import type { ProxyHubBackendContext, ProxyHubBackendHandle } from './proxy-hub';

/**
 * Metadata stored alongside each saved account snapshot.
 * Secrets live only in the snapshot files, never in meta.
 */
export interface AccountMeta {
  /** Stable account name (slug), unique within a provider. */
  name: string;
  /** Provider id this account belongs to. */
  provider: string;
  /** When the snapshot was first created (ISO 8601). */
  createdAt: string;
  /** When the snapshot was last updated (ISO 8601). */
  updatedAt: string;
  /** Optional human label shown in list/interactive UI. */
  label?: string;
  /** Best-effort identity hint (email, account id) for display. */
  identity?: string;
  /** Free-form notes. */
  notes?: string;
  /**
   * How this account's credential relates to the machine. Absent means
   * `native`: a snapshot of the provider's own login file, which activation
   * restores over the live credential.
   *
   * `proxy-only` is credential material the user supplied directly — an API key,
   * say — that never occupies that file. Such an account can never be "live",
   * must not be restored over a native login, and must not absorb a refreshed
   * live token; it is reachable only through the provider's proxy.
   */
  credentialKind?: 'native' | 'proxy-only';
}

/** Fields a provider may contribute to AccountMeta when it writes a snapshot. */
export type SnapshotMeta = Partial<
  Pick<AccountMeta, 'identity' | 'label' | 'notes' | 'credentialKind'>
>;

/**
 * Credential material typed by the user rather than read from a live login.
 *
 * The provider decides what a kind means and what it writes; core only carries
 * the value through to `backupInput` and never logs or persists it in meta.
 */
export interface CredentialInput {
  /** Provider-declared kind, e.g. `api-key`. */
  kind: string;
  /** The secret itself. */
  secret: string;
  /** Non-secret qualifiers the provider understands, e.g. `{ region }`. */
  options?: Record<string, string>;
}

/**
 * One non-secret qualifier a credential input accepts, described well enough for
 * a caller to offer the values without knowing the provider.
 *
 * `choices` are values the provider knows are real, but a caller may pass
 * something else: these lists go stale as vendors add regions. The point is that
 * a picker beats free text for a field where a plausible-looking typo yields an
 * account that starts and then cannot serve a single request.
 */
export interface CredentialInputField {
  /** Key under `CredentialInput.options`, e.g. `region`. */
  name: string;
  label: string;
  choices: readonly string[];
  default?: string;
}

/**
 * Per-account proxy configuration (stored separately from secrets).
 * Provider-specific knobs go in `options`.
 */
export interface AccountProxyConfig {
  /** When true, switching to / activating this account starts the proxy. */
  enabled: boolean;
  /** Preferred listen port (provider may fall back if busy). */
  port?: number;
  /** Preferred listen host (default typically 127.0.0.1). */
  host?: string;
  /** Opaque provider-specific options. */
  options?: Record<string, unknown>;
}

/**
 * A saved account: metadata + path to the opaque snapshot directory.
 */
export interface Account {
  meta: AccountMeta;
  /** Absolute path to the snapshot directory for this account. */
  snapshotDir: string;
  /** Absolute path to the account directory (meta + snapshot + proxy). */
  accountDir: string;
  /** Per-account proxy configuration (defaults to disabled). */
  proxy: AccountProxyConfig;
}

/**
 * Result of inspecting the live (active) auth state on disk.
 */
export interface LiveAuthStatus {
  /** Whether live auth material appears to be present. */
  present: boolean;
  /** Optional identity extracted from live auth (email, etc.). */
  identity?: string;
  /** Optional extra display details. */
  details?: string;
  /**
   * Stable provider account id when known (e.g. ChatGPT `account_id`).
   * Used for live matching when session tokens and display emails disagree.
   */
  accountId?: string;
}

/** A provider-reported rate-limit window for the account currently live on disk. */
export interface LiveUsageWindow {
  /** Short, provider-defined label such as "5h" or "weekly". */
  label: string;
  /** Percentage of this window that remains, from 0 to 100. */
  remainingPercent: number;
  /** Optional epoch milliseconds when the window resets. */
  resetsAtMs?: number;
}

/** Best-effort usage snapshot. It is never read from a saved account snapshot. */
export interface LiveUsage {
  windows: LiveUsageWindow[];
}

/** Context passed to provider proxy lifecycle methods. */
export interface ProxyContext {
  providerId: string;
  accountName: string;
  /** Snapshot directory for this account (read-only for proxy). */
  snapshotDir: string;
  /**
   * Writable runtime directory for this account's proxy
   * (pid file, logs, state). Unique per provider+account.
   */
  runtimeDir: string;
  /** Account proxy configuration. */
  config: AccountProxyConfig;
  /**
   * Per-instance high-entropy secret required on every credentialed route.
   * Generated once per proxy lifecycle; transmitted to the child only via the
   * `ANYPICK_PROXY_TOKEN` env var. Never logged or returned in status.
   */
  token?: string;
}

/** Returned when a proxy successfully starts. */
export interface ProxyHandle {
  /** Local endpoint clients should use, e.g. http://127.0.0.1:8080 */
  endpoint: string;
  /** Human-readable protocol compatibility label. */
  compatibility?: string;
  /** OS process id if the proxy is a child process. */
  pid?: number;
  /** Opaque instance id (PROC-01) used to prove ownership via health echo. */
  instanceId?: string;
  /**
   * Per-instance high-entropy secret (PROXY-01) accepted on every credentialed
   * route. Transient — present only on the freshly started handle so the
   * caller (executor) can bind it into client config. Never persisted beyond
   * `proxy_state` and never returned in status/doctor.
   */
  token?: string;
  /** Lease created for this lifecycle operation. */
  leaseId?: string;
  /** True only when this call spawned a new child process. */
  startedNow?: boolean;
  /** Path to the proxy log file, if any. */
  logPath?: string;
  /**
   * Clients whose native config (e.g. ~/.claude/settings.json) was rewritten
   * to this endpoint after a start/port bump.
   */
  realignedClients?: string[];
}

/** Status of a provider account's proxy. */
export interface ProxyStatus {
  enabled: boolean;
  running: boolean;
  /** Configured listen port (always set when known). */
  port?: number;
  /** Configured listen host (default 127.0.0.1). */
  host?: string;
  endpoint?: string;
  compatibility?: string;
  pid?: number;
  logPath?: string;
  detail?: string;
}

/** External application that must release live auth before a restore. */
export interface RestoreOwnerStatus {
  name: string;
  running: boolean;
}

/** Human-facing native source represented by one provider snapshot. */
export interface AccountSourceDescriptor {
  id: string;
  name: string;
}

/**
 * Provider contract.
 *
 * Each provider owns:
 * - where live auth lives on the machine
 * - how to copy it into a snapshot directory (backup)
 * - how to write a snapshot back to live paths (restore)
 * - optionally, a compatibility proxy lifecycle
 *
 * Snapshots are opaque directories. The core store never interprets
 * provider-specific secret formats beyond what describe* returns.
 * Proxy logic is entirely provider-specific; core only orchestrates.
 */
export interface Provider extends ModelPolicy {
  /** Stable machine id used in paths and CLI args (e.g. "codex"). */
  readonly id: string;
  /** Human-readable name (e.g. "OpenAI Codex"). */
  readonly name: string;
  /** One-line description for help text. */
  readonly description: string;

  /** Short UI label for lists and status lines. Defaults to `name`. */
  readonly shortName?: string;

  /**
   * When true, the TUI/CLI account-add flow offers a multi-source picker before
   * mode selection (e.g. Gemini CLI vs Antigravity). Driven by the provider so
   * UI surfaces never hardcode provider ids.
   */
  readonly requiresAccountSourcePick?: boolean;

  /**
   * True when the compatibility proxy needs an API key from the snapshot and
   * cannot be driven from an OAuth-only login. Callers gate the proxy on this
   * instead of consulting a hardcoded provider-id set.
   */
  readonly proxyRequiresApiKey?: boolean;

  /**
   * Report whether `snapshotDir` carries the API key material this provider's
   * proxy needs. Only consulted when `proxyRequiresApiKey` is true.
   *
   * Providers own this because only they know where the key lives inside their
   * own snapshot layout. Returning a `hint` lets the UI explain what to do
   * without core knowing anything about the provider's file format.
   */
  proxyApiKeyStatus?(snapshotDir: string): Promise<{ present: boolean; hint?: string }>;

  /**
   * Default listen port when enabling proxy without an explicit `-p`.
   * Used as the base for auto-allocation to avoid collisions.
   * Proxy capability is determined by presence of startProxy(), not a boolean flag.
   */
  readonly defaultProxyPort?: number;

  /**
   * Optional short label for what the proxy speaks
   * (e.g. "OpenAI API", "Anthropic + OpenAI API").
   */
  readonly proxyCompatibility?: string;

  /**
   * Provider-owned source policy. Implement this instead of relying on core
   * provider-id conditionals when an account supports direct or proxy-backed
   * activation. The returned adapter is scoped to one saved account.
   */
  sourceAdapter?(account: Account): SourceAdapter;

  /**
   * Provider-owned source policy for an opt-in multi-account pool.
   * Omit when pooling is unsupported.
   */
  poolSourceAdapter?(): SourceAdapter;

  /**
   * Optional provider-owned backend for the unified Proxy Hub. Core owns local
   * auth/routing only; each provider keeps its protocol translation and
   * credential lifecycle behind this boundary.
   */
  createProxyHubBackend?(ctx: ProxyHubBackendContext): Promise<ProxyHubBackendHandle>;

  /**
   * Inspect the currently active (live) auth on this machine.
   * Must not throw for "not logged in" — return present: false.
   */
  detectLive(): Promise<LiveAuthStatus>;

  /**
   * Read usage for the currently live local login only. Implementations must
   * not restore, inspect, or authenticate with a saved AnyPick snapshot.
   */
  liveUsage?(): Promise<LiveUsage | null>;

  /**
   * Copy live auth material into `destDir`.
   * `destDir` is empty and already created by the store.
   * Return display fields that should be merged into AccountMeta.
   */
  backup(destDir: string): Promise<SnapshotMeta>;

  /**
   * Credential kinds this provider accepts as direct user input, e.g.
   * `['api-key']`. Declaring one is what makes `backupInput` reachable from the
   * CLI, so core can validate a request without knowing the provider.
   */
  readonly credentialInputs?: readonly string[];

  /**
   * Non-secret qualifiers a credential kind accepts, in the order a caller
   * should ask for them. The TUI turns each into a picker and the CLI into a
   * flag, so a provider that needs one does not have to be special-cased.
   */
  credentialInputFields?(kind: string): readonly CredentialInputField[];

  /**
   * Write a snapshot from credential material the user supplied, rather than
   * from a live login. There is nothing on disk to detect first, so core skips
   * the live-auth gate for this path — the provider must validate the input
   * itself and throw if it is unusable.
   */
  backupInput?(input: CredentialInput, destDir: string): Promise<SnapshotMeta>;

  /**
   * Optional source-parameterized liveness check. Providers that support more
   * than one sign-in source (e.g. Gemini CLI vs Antigravity) implement this to
   * detect a specific source on explicit user request. Sources that read the OS
   * keychain must be gated here, never in detectLive() (which runs frequently).
   */
  detectLiveSource?(source: string): Promise<LiveAuthStatus>;

  /**
   * Optional source-parameterized backup, paired with detectLiveSource.
   */
  backupSource?(source: string, destDir: string): Promise<SnapshotMeta>;

  /**
   * Optional source-parameterized clear, paired with detectLiveSource. Without
   * it, stashing a non-default source would wipe the wrong credential store and
   * leave the chosen source still signed in.
   */
  clearLiveSource?(source: string): Promise<void>;

  /**
   * Restore auth material from `srcDir` (a previous backup) into live paths.
   * Should overwrite live auth atomically where practical.
   */
  restore(srcDir: string): Promise<void>;

  /**
   * Optional mutation-free restore guard.
   *
   * Core calls this before taking a live-auth checkpoint or stopping proxies,
   * so an unsafe external owner can reject the switch without triggering a
   * rollback for work that never started.
   */
  preflightRestore?(srcDir: string): Promise<void>;

  /**
   * Optional status for an external application that owns the live credential.
   * TUI previews use this to explain a required quit before the user commits,
   * instead of discovering the requirement as an operational error.
   */
  restoreOwnerStatus?(srcDir: string): Promise<RestoreOwnerStatus | null>;

  /**
   * Optional account-source label when one provider manages multiple native
   * products. This keeps product identity out of core and TUI conditionals.
   */
  accountSource?(srcDir: string): Promise<AccountSourceDescriptor>;

  /** Source label for a live login that has not been saved to a snapshot yet. */
  liveAccountSource?(live: LiveAuthStatus): Promise<AccountSourceDescriptor>;

  /**
   * Optional: read identity/label from an existing snapshot without restoring.
   */
  describeSnapshot?(srcDir: string): Promise<SnapshotMeta>;

  /**
   * Remove live auth files so the tool thinks you are logged out,
   * WITHOUT calling the provider logout/revoke endpoint.
   * Tokens in anypick snapshots stay valid for later restore.
   */
  clearLive?(): Promise<void>;

  /**
   * Refresh OAuth/OIDC tokens for auth material under `authDir`
   * (a snapshot directory containing provider auth files, e.g. auth.json).
   * Mutates files in place. Return updated display fields if known.
   */
  refreshAuth?(authDir: string): Promise<SnapshotMeta>;

  /**
   * Determine whether the auth material in `snapshotDir` is the currently
   * live (active) login for this provider.
   *
   * Providers own this comparison because only they know the shape of their
   * own credentials and which field (refresh_token, account_id, API key bag…)
   * is authoritative for "same login". The default core path falls back to an
   * email/identity string comparison when a provider does not implement this.
   *
   * Returning `false` must never throw — a missing or unreadable snapshot is
   * simply "not the live login".
   */
  snapshotMatchesLive?(snapshotDir: string): Promise<boolean>;

  /**
   * Start the compatibility proxy for this account.
   * Presence of this method indicates proxy capability (replaces supportsProxy).
   * Only called when the account has proxy enabled.
   *
   * Idempotency contract: a second call while a healthy process for this
   * account already exists must NOT spawn a second orphaned child. This
   * guarantee is enforced by `ProxyService.startProxyInternal` (it reuses the
   * existing pid via the pid-file check), not by this method — so implementors
   * may call `provider.startProxy` directly only when they own the lifecycle.
   */
  startProxy?(ctx: ProxyContext): Promise<ProxyHandle>;

  /**
   * Stop the compatibility proxy for this account if running.
   * Must not throw if already stopped.
   */
  stopProxy?(ctx: ProxyContext): Promise<void>;

  /**
   * Report whether the proxy is running and its endpoint.
   * Core falls back to pid-file heuristics if omitted.
   */
  proxyStatus?(ctx: ProxyContext): Promise<ProxyStatus>;

  /**
   * Return recent log text for `proxy logs`.
   * Core falls back to reading `runtimeDir/proxy.log` if omitted.
   */
  readProxyLogs?(ctx: ProxyContext, lines?: number): Promise<string>;
}

export interface AnyPickConfig {
  /** Absolute path to the anypick data root. Default: ~/.anypick */
  rootDir: string;
}

export const DEFAULT_PROXY_CONFIG: AccountProxyConfig = {
  enabled: false,
};

// ── API provider catalog (runtime profiles) ──────────────────────

/** Protocol family for client adapters. */
