import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { HotplugApp } from '../core/app';
import {
  readTrayState,
  runningTrayPid,
  trayLogPath,
  trayPidPath,
  trayRuntimeDir,
  trayStatePath,
  type TrayRuntimeState,
} from '../core/tray-runtime';
import { ensureDir, writeJsonFile } from '../utils/fs';
import { isProcessRunning, spawnDetached, stopPidFile } from '../utils/process';
import { HotplugError } from '../utils/errors';
import { openHotplugTerminal } from './terminal-launcher';
import { assertNativeTrayPlatform, nativeTrayBinary, sendStatus } from './supervisor-native';

export interface TrayStatus {
  running: boolean;
  pid?: number;
  proxyCount?: number;
  startedAt?: string;
  mode?: 'native' | 'headless';
}

export async function trayStatus(root: string): Promise<TrayStatus> {
  const pid = await runningTrayPid(root);
  if (pid == null) {
    return { running: false };
  }
  const state = await readTrayState(root);
  return {
    running: true,
    pid,
    proxyCount: state?.proxyCount,
    startedAt: state?.startedAt,
    mode: state?.mode ?? (process.platform === 'darwin' ? 'native' : 'headless'),
  };
}

export async function startTray(
  root: string,
  cliEntry: string,
): Promise<{ pid: number; started: boolean }> {
  const current = await runningTrayPid(root);
  if (current != null) {
    return { pid: current, started: false };
  }
  await ensureDir(trayRuntimeDir(root));
  await unlink(trayStatePath(root)).catch(() => {});
  const entry = resolve(cliEntry);
  const { pid } = await spawnDetached(process.execPath, [entry, 'tray', 'run'], {
    pidPath: trayPidPath(root),
    logPath: trayLogPath(root),
    env: {
      ...process.env,
      HOTPLUG_HOME: root,
      HOTPLUG_TRAY_PROCESS: '1',
      HOTPLUG_TRAY_CLI_ENTRY: entry,
    },
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      const log = await readFile(trayLogPath(root), 'utf8').catch(() => '');
      throw new HotplugError(
        `Hotplug tray exited during startup.${log ? `\n${log.slice(-2000)}` : ''}`,
        'TRAY_START_FAILED',
      );
    }
    const state = await readTrayState(root);
    if (state?.ready && state.pid === pid) {
      return { pid, started: true };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  // The tray proves ownership through its ready-state file rather than HTTP.
  // Keep the same explicit exception used by stopTray for timeout cleanup.
  await stopPidFile(trayPidPath(root), { graceMs: 5000, verifyHealth: false });
  throw new HotplugError('Timed out waiting for the Hotplug supervisor.', 'TRAY_START_TIMEOUT');
}

export async function stopTray(root: string): Promise<boolean> {
  // The tray has no HTTP health endpoint; its owner identity is the separate
  // ready state file checked by runningTrayPid. Keep the explicit opt-out local
  // to this supervisor rather than weakening proxy PID ownership globally.
  const stopped = await stopPidFile(trayPidPath(root), {
    graceMs: 15_000,
    verifyHealth: false,
  });
  if (!(await runningTrayPid(root))) {
    await unlink(trayStatePath(root)).catch(() => {});
  }
  return stopped;
}

async function stopAllProxies(app: HotplugApp): Promise<void> {
  await app.proxy.stopProxies();
  for (const provider of app.accountRegistry.list()) {
    try {
      const status = await app.proxy.poolProxyStatus(provider.id);
      if (status.running) {
        await app.proxy.stopPoolProxy(provider.id);
      }
    } catch {
      // Provider has no supported pool/proxy.
    }
  }
}

async function startEnabledProxies(app: HotplugApp): Promise<void> {
  await app.proxy.startProxies();
  for (const provider of app.accountRegistry.list()) {
    try {
      const pool = await app.proxy.getPool(provider.id);
      if (pool.mode === 'multi' && pool.enabled) {
        await app.proxy.startPoolProxy(provider.id);
      }
    } catch {
      // Provider has no enabled pool/proxy.
    }
  }
}

/** Keep proxy ownership alive on Linux/Windows where no native menu-bar helper is bundled. */
async function runHeadlessSupervisor(app: HotplugApp): Promise<void> {
  await startEnabledProxies(app);
  let proxyCount = await app.proxy.adoptRunningProxies();
  const startedAt = new Date().toISOString();
  const writeState = async (ready: boolean) => {
    const state: TrayRuntimeState = {
      pid: process.pid,
      ready,
      proxyCount,
      startedAt,
      mode: 'headless',
    };
    await writeJsonFile(trayStatePath(app.root), state);
  };
  await writeState(true);

  let operation = Promise.resolve();
  let shutdownPromise: Promise<void> | undefined;
  const refresh = async () => {
    proxyCount = await app.proxy.adoptRunningProxies();
    await writeState(true);
  };
  const refreshTimer = setInterval(() => {
    operation = operation.then(refresh).catch((err: unknown) => {
      process.stderr.write(`[tray] ${err instanceof Error ? err.message : String(err)}\n`);
    });
  }, 2500);
  const shutdown = (waitForOperation = true): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      clearInterval(refreshTimer);
      if (waitForOperation) {
        await operation.catch(() => {});
      }
      await stopAllProxies(app).catch(() => {});
      await unlink(trayStatePath(app.root)).catch(() => {});
    })();
    return shutdownPromise;
  };

  await new Promise<void>((resolveDone) => {
    const requestShutdown = () => {
      void shutdown().finally(resolveDone);
    };
    process.once('SIGINT', requestShutdown);
    process.once('SIGTERM', requestShutdown);
  });
}

/** Long-running owner for enabled proxies and the native macOS status item. */
export async function runTraySupervisor(app: HotplugApp): Promise<void> {
  if (process.platform !== 'darwin') {
    await runHeadlessSupervisor(app);
    return;
  }
  assertNativeTrayPlatform();
  await startEnabledProxies(app);
  let proxyCount = await app.proxy.adoptRunningProxies();
  const binary = await nativeTrayBinary(app.root);
  const native = spawn(binary, [String(proxyCount)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  const startedAt = new Date().toISOString();
  const writeState = async (ready: boolean) => {
    const state: TrayRuntimeState = {
      pid: process.pid,
      ready,
      proxyCount,
      startedAt,
      mode: 'native',
    };
    await writeJsonFile(trayStatePath(app.root), state);
  };
  await writeState(true);

  let operation = Promise.resolve();
  let shutdownPromise: Promise<void> | undefined;
  const refresh = async () => {
    proxyCount = await app.proxy.adoptRunningProxies();
    sendStatus(native, proxyCount);
    await writeState(true);
  };
  const refreshTimer = setInterval(() => {
    operation = operation.then(refresh).catch((err: unknown) => {
      process.stderr.write(`[tray] ${err instanceof Error ? err.message : String(err)}\n`);
    });
  }, 2500);
  const shutdown = (waitForOperation = true): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      clearInterval(refreshTimer);
      if (waitForOperation) {
        await operation.catch(() => {});
      }
      await stopAllProxies(app).catch(() => {});
      native.stdin.end();
      if (native.pid != null && isProcessRunning(native.pid)) {
        native.kill('SIGTERM');
      }
      await unlink(trayStatePath(app.root)).catch(() => {});
    })();
    return shutdownPromise;
  };

  const cliEntry = process.env.HOTPLUG_TRAY_CLI_ENTRY || process.argv[1] || '';
  const lines = createInterface({ input: native.stdout });
  lines.on('line', (line) => {
    operation = operation
      .then(async () => {
        switch (line.trim()) {
          case 'open':
            await openHotplugTerminal(cliEntry);
            break;
          case 'restart':
            await stopAllProxies(app);
            await startEnabledProxies(app);
            await refresh();
            break;
          case 'stop':
            await stopAllProxies(app);
            await refresh();
            break;
          case 'quit':
            void shutdown(false);
            break;
          default:
            break;
        }
      })
      .catch((err: unknown) => {
        process.stderr.write(`[tray] ${err instanceof Error ? err.message : String(err)}\n`);
      });
  });
  native.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));

  await new Promise<void>((resolveDone) => {
    const requestShutdown = () => {
      void shutdown().finally(resolveDone);
    };
    process.once('SIGINT', requestShutdown);
    process.once('SIGTERM', requestShutdown);
    native.once('exit', requestShutdown);
  });
}
