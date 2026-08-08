import type { DoctorCheck, DoctorFixPlan, DoctorReport } from '../../core/doctor';
import type { ProxyStatus } from '../../types';

export type LiveAccountRelation =
  | 'match'
  | 'drift'
  | 'unsaved-live'
  | 'no-live'
  | 'empty'
  | 'unknown'
  | 'error';

export type ProxyStateLabel = 'running' | 'enabled-stopped' | 'disabled' | 'unavailable';

export type { ProviderCapabilities } from '../../core/capabilities';

export interface ProviderPoolRow {
  providerId: string;
  displayName: string;
  activeName: string | null;
  /** Primary identity/status column (email, "no live auth", etc.). */
  identityLabel: string;
  savedCount: number;
  relation: LiveAccountRelation;
  /** Secondary attention / status hint (identity drift, save this login, …). */
  statusHint: string;
  proxyLabel?: string;
  canRefresh: boolean;
  canProxy: boolean;
  canClear: boolean;
  error?: string;
  /** Live identity if present (display only). */
  liveIdentity?: string;
  /** Active saved account identity if present. */
  activeIdentity?: string;
}

export interface RootModel {
  providers: ProviderPoolRow[];
  totalAccounts: number;
  proxiesEnabled: number;
  issueCount: number;
  loadedAt: number;
}

export interface AccountRow {
  providerId: string;
  name: string;
  label: string;
  identity?: string;
  /** Semantic active/live marker: true when this is the active record. */
  active: boolean;
  /** True when active and live identity match (●). */
  isLiveMatch: boolean;
  updatedAt: string;
  updatedRelative: string;
  createdAt: string;
  proxyEnabled: boolean;
  proxyRunning: boolean;
  proxyLabel?: string;
}

export interface LiveBlock {
  present: boolean;
  activeName: string | null;
  identity?: string;
  details?: string;
  relation: LiveAccountRelation;
  summary: string;
}

export interface ProviderPoolModel {
  providerId: string;
  displayName: string;
  canRefresh: boolean;
  canProxy: boolean;
  canClear: boolean;
  live: LiveBlock;
  accounts: AccountRow[];
  error?: string;
}

export interface AnyPickPreviewModel {
  providerId: string;
  displayName: string;
  fromName: string | null;
  fromIdentity?: string;
  toName: string;
  toIdentity?: string;
  alreadyActive: boolean;
  willRefreshPrevious: boolean;
  canProxy: boolean;
  previousProxy?: { enabled: boolean; running: boolean; endpoint?: string };
  targetProxy?: {
    enabled: boolean;
    running: boolean;
    host?: string;
    port?: number;
    endpoint?: string;
    willStart: boolean;
  };
  restoreOwner?: {
    name: string;
    running: boolean;
  };
  steps: {
    before: string[];
    switch: string[];
    after: string[];
    notes: string[];
  };
}

export type ProxyRowKind =
  /** Per-account proxy (default single mode). */
  | 'account'
  /** Multi-account pool header (opt-in). */
  | 'pool'
  /** Member under a pool header. */
  | 'member'
  /** Live login present but not saved yet — prompt to save. */
  | 'unsaved'
  /** One public endpoint with model-driven provider routing. */
  | 'hub';

export interface ProxyRow {
  providerId: string;
  providerName: string;
  name: string;
  active: boolean;
  status: ProxyStatus;
  stateLabel: ProxyStateLabel;
  stateText: string;
  endpointText: string;
  compatibilityText: string;
  detailText?: string;
  /** True when enabled but account is not active — not serving. */
  inactiveEnabled: boolean;
  /** Row shape on the Proxy board. Default account. */
  rowKind?: ProxyRowKind;
  /** Indent member rows under a pool. */
  indent?: boolean;
  /** Member enabled in multi pool. */
  memberEnabled?: boolean;
  /** Global, opt-in policy shown only on a multi-account pool row. */
  quotaGuardEnabled?: boolean;
  /** Live identity for unsaved rows. */
  identity?: string;
  /** Display ref override (e.g. pool:gemini). */
  displayRef?: string;
  /**
   * When set, proxy cannot start until the user fixes credentials
   * (e.g. Gemini account without GEMINI_API_KEY).
   */
  needsApiKey?: boolean;
  /** Short rail message when needsApiKey (or similar). */
  attentionHint?: string;
}

export interface OperationReceiptLine {
  kind: 'ok' | 'fail' | 'info' | 'warn';
  text: string;
}

export interface OperationReceipt {
  title: string;
  lines: OperationReceiptLine[];
}

export interface AccountDetailModel {
  providerId: string;
  displayName: string;
  name: string;
  canonical: string;
  label?: string;
  identity?: string;
  createdAt: string;
  updatedAt: string;
  updatedRelative: string;
  active: boolean;
  relation: LiveAccountRelation;
  relationSummary: string;
  canProxy: boolean;
  canRefresh: boolean;
  proxy?: ProxyStatus | null;
  proxyStateLabel?: ProxyStateLabel;
  snapshotDir: string;
  accountDir: string;
}

export interface HealthModel {
  report: DoctorReport;
  plan: DoctorFixPlan | null;
  /** Account/proxy-prioritized checks (failures first). */
  prioritized: DoctorCheck[];
}
