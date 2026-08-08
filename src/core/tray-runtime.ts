import { join } from 'node:path';
import { readJsonFile, pathExists } from '../utils/fs';
import { isProcessRunning, readPidFile } from '../utils/process';

export interface TrayRuntimeState {
  pid: number;
  ready: boolean;
  proxyCount: number;
  startedAt: string;
  /** Native menu-bar icon on macOS; background owner on other platforms. */
  mode?: 'native' | 'headless';
}

export function trayRuntimeDir(root: string): string {
  return join(root, 'runtime', 'tray');
}

export function trayPidPath(root: string): string {
  return join(trayRuntimeDir(root), 'tray.pid');
}

export function trayLogPath(root: string): string {
  return join(trayRuntimeDir(root), 'tray.log');
}

export function trayStatePath(root: string): string {
  return join(trayRuntimeDir(root), 'state.json');
}

export async function runningTrayPid(root: string): Promise<number | null> {
  const pid = await readPidFile(trayPidPath(root));
  return pid != null && isProcessRunning(pid) ? pid : null;
}

export async function readTrayState(root: string): Promise<TrayRuntimeState | null> {
  const path = trayStatePath(root);
  if (!(await pathExists(path))) {
    return null;
  }
  try {
    return await readJsonFile<TrayRuntimeState>(path);
  } catch {
    return null;
  }
}
