import type { CatalogRegistry } from '../catalog/providers';
import type { ClientRegistry } from '../clients/registry';
import type { AccountService } from './service';
import type { ProxyService } from './proxy-service';
import type { ProfileService } from './profile-service';
import type { RuntimeService } from './runtime-service';
import type { BindingStore } from './binding-store';
import type { LeaseStore } from './lease-store';
import type { OperationJournal } from './journal';
import type { AccountStore } from './store';
import type { PluginLoadFailure, PluginRecord } from '../types';

export interface DoctorCheck {
  id: string;
  ok: boolean;
  message: string;
  detail?: string;
  /** When set, this finding is fixable via allowlisted --fix action. */
  fixable?: DoctorFixActionKind;
  /** When set, doctor must not auto-fix; show manual commands. */
  forbidden?: DoctorForbiddenKind;
  suggestions?: string[];
}

export interface DoctorReport {
  ok: boolean;
  root: string;
  checks: DoctorCheck[];
}

/** Spec §18.4 — hard allowlist only. */
export type DoctorFixActionKind =
  | 'delete_stale_lock'
  | 'delete_stale_pid'
  | 'stop_orphan_proxy'
  | 'delete_temp_overlay'
  | 'repair_permissions'
  | 'rebuild_caches'
  | 'complete_journal_rollback';

export const DOCTOR_FIX_ALLOWLIST: readonly DoctorFixActionKind[] = [
  'delete_stale_lock',
  'delete_stale_pid',
  'stop_orphan_proxy',
  'delete_temp_overlay',
  'repair_permissions',
  'rebuild_caches',
  'complete_journal_rollback',
] as const;

/** Spec §18.5 — never auto-fixed. */
export type DoctorForbiddenKind =
  | 'modify_native_auth'
  | 'switch_or_clear_account'
  | 'mutate_binding'
  | 'modify_unmanaged_client_config'
  | 'revoke_token'
  | 'refresh_token'
  | 'replace_api_key'
  | 'change_gateway_endpoint'
  | 'assign_source_or_model'
  | 'import_external_config'
  | 'delete_user_resource'
  | 'reassign_live_proxy_port'
  | 'install_external_package';

export const DOCTOR_FIX_FORBIDDEN: readonly DoctorForbiddenKind[] = [
  'modify_native_auth',
  'switch_or_clear_account',
  'mutate_binding',
  'modify_unmanaged_client_config',
  'revoke_token',
  'refresh_token',
  'replace_api_key',
  'change_gateway_endpoint',
  'assign_source_or_model',
  'import_external_config',
  'delete_user_resource',
  'reassign_live_proxy_port',
  'install_external_package',
] as const;

export interface DoctorFixAction {
  id: string;
  kind: DoctorFixActionKind;
  description: string;
  /** Absolute path or resource ref for the fix target. */
  target: string;
  /** Extra serializable params for journal. */
  params?: Record<string, unknown>;
}

export interface DoctorFixPlan {
  actions: DoctorFixAction[];
  /** Forbidden findings with manual remediation only. */
  manual: Array<{
    id: string;
    kind: DoctorForbiddenKind;
    message: string;
    suggestions: string[];
  }>;
}

export interface DoctorFixResult {
  plan: DoctorFixPlan;
  applied: Array<{ id: string; ok: boolean; message: string }>;
  dryRun: boolean;
  journalId?: string;
}

export interface DoctorServiceDeps {
  accounts: AccountService;
  proxy: ProxyService;
  profiles: ProfileService;
  runtime: RuntimeService;
  catalog: CatalogRegistry;
  clients: ClientRegistry;
  root?: string;
  bindings?: BindingStore;
  leases?: LeaseStore;
  journal?: OperationJournal;
  accountStore?: AccountStore;
  /**
   * Plugin state as it was resolved at startup, not re-read from disk.
   *
   * Doctor must report the graph this process is actually running, so a plugin
   * that has been edited since load still shows as loaded here — `plugin list`
   * is where the on-disk digest is re-checked.
   */
  plugins?: {
    /** Re-read per run, so `plugin add` between doctor runs is reflected. */
    installed: () => readonly PluginRecord[];
    loadedNames: readonly string[];
    failures: readonly PluginLoadFailure[];
  };
}
