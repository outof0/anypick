import { join } from 'node:path';
import { homedir } from 'node:os';
import { expandHome } from '../utils/fs';

/**
 * Resolve the hotplug data root.
 * Override with HOTPLUG_HOME env var (useful for tests / portable installs).
 */
export function getHotplugRoot(override?: string): string {
  if (override) {
    return expandHome(override);
  }
  if (process.env.HOTPLUG_HOME) {
    return expandHome(process.env.HOTPLUG_HOME);
  }
  return join(homedir(), '.hotplug');
}

export function providerDir(root: string, providerId: string): string {
  return join(root, 'providers', providerId);
}

export function accountsDir(root: string, providerId: string): string {
  return join(providerDir(root, providerId), 'accounts');
}

export function accountDir(root: string, providerId: string, accountName: string): string {
  return join(accountsDir(root, providerId), accountName);
}

export function accountMetaPath(root: string, providerId: string, accountName: string): string {
  return join(accountDir(root, providerId, accountName), 'meta.json');
}

export function accountSnapshotDir(root: string, providerId: string, accountName: string): string {
  return join(accountDir(root, providerId, accountName), 'snapshot');
}

/** File holding the name of the currently active account for a provider. */
export function activePointerPath(root: string, providerId: string): string {
  return join(providerDir(root, providerId), 'active');
}

/** Per-account proxy configuration (enabled, port, options). */
export function accountProxyConfigPath(
  root: string,
  providerId: string,
  accountName: string,
): string {
  return join(accountDir(root, providerId, accountName), 'proxy.json');
}

/**
 * Writable runtime directory for an account's proxy process
 * (pid, logs, state). Isolated per provider + account.
 */
export function accountProxyRuntimeDir(
  root: string,
  providerId: string,
  accountName: string,
): string {
  return join(accountDir(root, providerId, accountName), 'runtime');
}

export function proxyPidPath(root: string, providerId: string, accountName: string): string {
  return join(accountProxyRuntimeDir(root, providerId, accountName), 'proxy.pid');
}

export function proxyLogPath(root: string, providerId: string, accountName: string): string {
  return join(accountProxyRuntimeDir(root, providerId, accountName), 'proxy.log');
}

export function proxyStatePath(root: string, providerId: string, accountName: string): string {
  return join(accountProxyRuntimeDir(root, providerId, accountName), 'state.json');
}

// ── Global config / database ─────────────────────────────────────

export function configPath(root: string): string {
  return join(root, 'config.json');
}

/** Primary SQLite database for structured hotplug data. */
export function hotplugDbPath(root: string): string {
  return join(root, 'hotplug.db');
}

// ── Runtime profiles ─────────────────────────────────────────────

export function profilesDir(root: string): string {
  return join(root, 'profiles');
}

export function profileDir(root: string, profileName: string): string {
  return join(profilesDir(root), profileName);
}

export function profileMetaPath(root: string, profileName: string): string {
  return join(profileDir(root, profileName), 'profile.json');
}

export function profileSecretsPath(root: string, profileName: string): string {
  return join(profileDir(root, profileName), 'secrets.json');
}

// ── Client state ─────────────────────────────────────────────────

export function clientsDir(root: string): string {
  return join(root, 'clients');
}

export function clientDir(root: string, clientId: string): string {
  return join(clientsDir(root), clientId);
}

export function clientStatePath(root: string, clientId: string): string {
  return join(clientDir(root, clientId), 'state.json');
}

export function clientBackupDir(root: string, clientId: string): string {
  return join(clientDir(root, clientId), 'backup');
}

/**
 * Owner-only recovery directory for durable crash backups (TXN-01). Backups of
 * overwritten client config files live here — inside the Hotplug root, not the
 * system temp dir — so they survive a crash and are never world-readable.
 * Created with mode 0o700 (owner-only).
 */
export function recoveryDir(root: string): string {
  return join(root, 'recovery');
}

export function clientRecoveryDir(root: string, clientId: string): string {
  return join(recoveryDir(root), 'clients', clientId);
}

export function clientEnvPath(root: string, clientId: string): string {
  return join(clientDir(root, clientId), 'env.sh');
}

export function clientEnvPs1Path(root: string, clientId: string): string {
  return join(clientDir(root, clientId), 'env.ps1');
}
