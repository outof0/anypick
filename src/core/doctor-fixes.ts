import { chmod, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathExists } from '../utils/fs';
import { isProcessRunning, readPidFile } from '../utils/process';
import { isLockStale, readLockInfo } from '../utils/lock';
import { recoverIncompleteOperations } from './activation-executor';
import type { DoctorFixAction, DoctorServiceDeps } from './doctor-types';
import { isUnderRoot, walkHotplugOwned } from './doctor-utils';

export async function executeDoctorFix(
  action: DoctorFixAction,
  root: string,
  deps: DoctorServiceDeps,
): Promise<string> {
  switch (action.kind) {
    case 'delete_stale_lock':
      return fixDeleteStaleLock(action.target, root);
    case 'delete_stale_pid':
      return fixDeleteStalePid(action.target, root);
    case 'stop_orphan_proxy':
      return fixStopOrphanProxy(action, deps);
    case 'delete_temp_overlay':
      return fixDeleteTempOverlay(action.target);
    case 'repair_permissions':
      return fixRepairPermissions(root);
    case 'rebuild_caches':
      return fixRebuildCaches(root);
    case 'complete_journal_rollback':
      return fixJournal(action, deps);
    default: {
      const kind: never = action.kind;
      throw new Error(`Unknown fix kind: ${String(kind)}`);
    }
  }
}

async function fixDeleteStaleLock(target: string, root: string): Promise<string> {
  if (!isUnderRoot(target, root)) {
    throw new Error(`Refusing to delete lock outside hotplug root: ${target}`);
  }
  if (!(await pathExists(target))) {
    return `Lock already gone: ${target}`;
  }
  if (!target.endsWith('.lock')) {
    throw new Error(`Not a lock file: ${target}`);
  }
  if (!(await isLockStale(target))) {
    const info = await readLockInfo(target);
    throw new Error(
      `Lock still held by live process ${info?.pid ?? '?'}; refusing delete: ${target}`,
    );
  }
  await rm(target, { force: true });
  return `Deleted stale lock: ${target}`;
}

async function fixDeleteStalePid(target: string, root: string): Promise<string> {
  if (!isUnderRoot(target, root)) {
    throw new Error(`Refusing to delete PID outside hotplug root: ${target}`);
  }
  if (!target.endsWith('.pid') && !target.endsWith('proxy.pid')) {
    throw new Error(`Not a PID record: ${target}`);
  }
  const pid = await readPidFile(target);
  if (pid != null && isProcessRunning(pid)) {
    throw new Error(`Process ${pid} still running; refusing to delete PID file ${target}`);
  }
  await rm(target, { force: true });
  return `Deleted stale PID record: ${target}`;
}

async function fixStopOrphanProxy(
  action: DoctorFixAction,
  deps: DoctorServiceDeps,
): Promise<string> {
  const provider = String(action.params?.provider ?? '');
  const account = String(action.params?.account ?? '');
  if (!provider || !account) {
    throw new Error('Orphan proxy fix requires provider and account');
  }

  if (deps.leases?.findByProviderAccount(provider, account)) {
    throw new Error(`Live lease still references ${provider}/${account}; not an orphan`);
  }

  if (deps.bindings) {
    for (const b of deps.bindings.listGlobal()) {
      const s = b.spec.source;
      if (s.kind === 'account' && s.provider === provider && s.name === account) {
        throw new Error(`Global binding for ${b.client} still references ${provider}/${account}`);
      }
    }
    for (const b of deps.bindings.listAllProjects()) {
      const s = b.spec.source;
      if (s.kind === 'account' && s.provider === provider && s.name === account) {
        throw new Error(`Project binding for ${b.client} still references ${provider}/${account}`);
      }
    }
  }

  await deps.proxy.stopProxy(provider, account);
  return `Stopped orphan proxy ${provider}/${account}`;
}

async function fixDeleteTempOverlay(target: string): Promise<string> {
  const tmp = tmpdir();
  if (!isUnderRoot(target, tmp)) {
    throw new Error(`Refusing to delete overlay outside system temp: ${target}`);
  }
  const base = target.split(/[/\\]/).pop() ?? '';
  if (!/^hotplug-(claude|codex|kiro|client)-/.test(base)) {
    throw new Error(`Not a Hotplug-owned temp overlay: ${target}`);
  }
  const st = await stat(target);
  const ageMs = Date.now() - st.mtimeMs;
  if (ageMs < 60 * 60 * 1000) {
    throw new Error(`Overlay too recent (${Math.round(ageMs / 1000)}s); refusing delete`);
  }
  await rm(target, { recursive: true, force: true });
  return `Deleted temp overlay: ${target}`;
}

async function fixRepairPermissions(root: string): Promise<string> {
  let fixed = 0;
  await walkHotplugOwned(root, async (path, isDir) => {
    try {
      await chmod(path, isDir ? 0o700 : 0o600);
      fixed++;
    } catch {
      // ignore unchmodable
    }
  });
  return `Repaired permissions on ${fixed} Hotplug-owned path(s) under ${root}`;
}

async function fixRebuildCaches(root: string): Promise<string> {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const cacheDir = join(root, 'cache');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    join(cacheDir, 'doctor-rebuild.json'),
    `${JSON.stringify({ rebuiltAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return `Rebuilt local cache metadata under ${cacheDir}`;
}

async function fixJournal(action: DoctorFixAction, deps: DoctorServiceDeps): Promise<string> {
  if (!deps.journal) {
    throw new Error('Journal store not available');
  }
  const checkId = String(action.params?.checkId ?? action.target);
  const id = checkId.replace(/^journal:/, '');
  const entry = deps.journal.get(id);
  if (!entry) {
    return `Journal entry already gone: ${id}`;
  }
  const result = await recoverIncompleteOperations({ journal: deps.journal });
  return `Journal recovery: recovered=${result.recovered} failed=${result.failed.length} refused=${result.refused.length}`;
}
