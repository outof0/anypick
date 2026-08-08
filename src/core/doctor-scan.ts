import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { pathExists } from '../utils/fs';
import { isProcessRunning, readPidFile } from '../utils/process';
import { isLockStale, readLockInfo } from '../utils/lock';
import type { DoctorCheck, DoctorServiceDeps } from './doctor-types';
import { walkAnyPickOwned } from './doctor-utils';

export type DoctorPush = (c: DoctorCheck) => void;

export async function scanProxyPids(
  root: string,
  deps: DoctorServiceDeps,
  push: DoctorPush,
): Promise<void> {
  if (!deps.accountStore) {
    const providersRoot = join(root, 'providers');
    if (!(await pathExists(providersRoot))) {
      return;
    }
    try {
      const providers = await readdir(providersRoot);
      for (const provider of providers) {
        const accountsRoot = join(providersRoot, provider, 'accounts');
        if (!(await pathExists(accountsRoot))) {
          continue;
        }
        const accounts = await readdir(accountsRoot);
        for (const account of accounts) {
          const pidPath = join(accountsRoot, account, 'runtime', 'proxy.pid');
          await checkPidFile(pidPath, provider, account, deps, push);
        }
      }
    } catch {
      // ignore scan errors
    }
    return;
  }

  for (const p of deps.accounts.listProviders()) {
    if (typeof p.startProxy !== 'function') {
      continue;
    }
    const accounts = await deps.accountStore.listAccounts(p.id);
    for (const a of accounts) {
      const pidPath = deps.accountStore.pidPath(p.id, a.meta.name);
      await checkPidFile(pidPath, p.id, a.meta.name, deps, push);
    }
  }
}

export async function scanStaleLocks(root: string, push: DoctorPush): Promise<void> {
  await walkAnyPickOwned(root, async (path, isDir) => {
    if (isDir || !path.endsWith('.lock')) {
      return;
    }
    if (!(await isLockStale(path))) {
      return;
    }
    const info = await readLockInfo(path);
    push({
      id: `stale-lock:${relative(root, path)}`,
      ok: false,
      message: info
        ? `Stale AnyPick lock (dead pid ${info.pid}): ${relative(root, path)}`
        : `Stale or corrupt AnyPick lock: ${relative(root, path)}`,
      detail: path,
      fixable: 'delete_stale_lock',
    });
  });
}

export async function scanTempOverlays(push: DoctorPush): Promise<void> {
  const tmp = tmpdir();
  try {
    const entries = await readdir(tmp);
    for (const name of entries) {
      if (!/^anypick-(claude|codex|kiro|client)-/.test(name)) {
        continue;
      }
      const full = join(tmp, name);
      try {
        const st = await stat(full);
        if (!st.isDirectory()) {
          continue;
        }
        const ageMs = Date.now() - st.mtimeMs;
        if (ageMs < 60 * 60 * 1000) {
          continue;
        }
        push({
          id: `overlay:${name}`,
          ok: false,
          message: `Leftover temporary client overlay: ${name}`,
          detail: full,
          fixable: 'delete_temp_overlay',
        });
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore tmp unreadable
  }
}

export async function scanPermissions(root: string, push: DoctorPush): Promise<void> {
  let bad = 0;
  try {
    await walkAnyPickOwned(root, async (path, isDir) => {
      try {
        const st = await stat(path);
        const mode = st.mode & 0o777;
        if (isDir) {
          if (mode & 0o022) {
            bad++;
          }
        } else if (mode & 0o077) {
          bad++;
        }
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }
  if (bad > 0) {
    push({
      id: 'permissions',
      ok: false,
      message: `${bad} AnyPick-owned path(s) have overly permissive mode`,
      detail: root,
      fixable: 'repair_permissions',
    });
  } else {
    push({
      id: 'permissions',
      ok: true,
      message: 'AnyPick-owned permissions look restrictive',
    });
  }
}

async function checkPidFile(
  pidPath: string,
  provider: string,
  account: string,
  deps: DoctorServiceDeps,
  push: DoctorPush,
): Promise<void> {
  if (!(await pathExists(pidPath))) {
    return;
  }
  const pid = await readPidFile(pidPath);
  if (pid == null) {
    push({
      id: `pid:${provider}/${account}`,
      ok: false,
      message: `Corrupt proxy PID file for ${provider}/${account}`,
      detail: pidPath,
      fixable: 'delete_stale_pid',
    });
    return;
  }
  if (!isProcessRunning(pid)) {
    push({
      id: `pid:${provider}/${account}`,
      ok: false,
      message: `Stale proxy PID ${pid} for ${provider}/${account}`,
      detail: pidPath,
      fixable: 'delete_stale_pid',
    });
    return;
  }

  const hasLease = Boolean(deps.leases?.findByProviderAccount(provider, account));
  let hasBinding = false;
  if (deps.bindings) {
    for (const b of [...deps.bindings.listGlobal(), ...deps.bindings.listAllProjects()]) {
      const s = b.spec.source;
      if (s.kind === 'account' && s.provider === provider && s.name === account) {
        hasBinding = true;
        break;
      }
    }
  }
  if (!hasLease && !hasBinding) {
    push({
      id: `orphan-proxy:${provider}/${account}`,
      ok: false,
      message: `Orphan proxy running for ${provider}/${account} (pid ${pid})`,
      detail: pidPath,
      fixable: 'stop_orphan_proxy',
    });
  } else {
    push({
      id: `proxy:${provider}/${account}`,
      ok: true,
      message: `Proxy ${provider}/${account} running (pid ${pid})`,
    });
  }
}
