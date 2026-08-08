import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { AnyPickApp } from '../core/app';
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
import { AnyPickError } from '../utils/errors';
import { openAnyPickTerminal } from './terminal-launcher';
import {
  assertNativeTrayPlatform,
  nativeTrayBinary,
  nativeTrayNeedsRestart,
  sendProxyLogs,
  sendSnapshot,
} from './supervisor-native';
import { buildTraySnapshot } from './snapshot';
import { buildTrayUsage } from './snapshot-usage';
import type { TrayActionTarget, TrayProxyActionTarget, TrayUsageSnapshot } from './snapshot-types';
import { decodeTrayCommand } from './protocol';
import type { TrayLogsCommand } from './protocol';
import { trayLaunchAtLoginEnabled, trayPreferences } from './settings';
import { TrayActivityService } from './activity';
import { tauriTrayBinary } from './supervisor-tauri';
import { invokeTrayAction, invokeTrayModelRoles, type TrayActionSet } from './supervisor-actions';
import { recordTrayActivity } from './supervisor-activity';
import { resolveTrayProxyLogs } from './supervisor-logs';
import { invokeTrayMutation } from './supervisor-mutations';
import {
  startConfiguredProxies,
  startEnabledProxies,
  stopAllProxies,
  totalRunningProxyCount,
} from './supervisor-proxies';

export interface TrayStatus {
  running: boolean;
  pid?: number;
  proxyCount?: number;
  startedAt?: string;
  mode?: 'native' | 'tauri' | 'headless';
}

/**
 * Resolve how to re-exec `tray run` as a detached supervisor.
 * - Built package: `node dist/cli.js tray run` (or any .js entry)
 * - Dev TypeScript: `node --import tsx src/cli.ts tray run`
 *
 * Never fall back to a stale dist/ when the entry is .ts — that still ships
 * the old single-file AnyPickTray.swift. Prefer `node --import tsx` over the
 * `tsx` binary so the supervisor PID matches `process.pid` written into
 * state.json (the tsx CLI re-spawns Node and breaks the ready wait).
 */
async function traySupervisorLaunchArgs(
  cliEntry: string,
): Promise<{ command: string; args: string[] }> {
  const entry = resolve(cliEntry);
  const isTypeScript = entry.endsWith('.ts') || entry.endsWith('.tsx');
  if (!isTypeScript) {
    return { command: process.execPath, args: [entry, 'tray', 'run'] };
  }

  return {
    command: process.execPath,
    args: ['--import', 'tsx', entry, 'tray', 'run'],
  };
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
  let current = await runningTrayPid(root);
  if (current != null) {
    const staleNativeHelper =
      process.platform === 'darwin' && (await nativeTrayNeedsRestart(root).catch(() => false));
    if (!staleNativeHelper) {
      return { pid: current, started: false };
    }
    await stopTray(root);
    current = await runningTrayPid(root);
    if (current != null) {
      return { pid: current, started: false };
    }
  }
  await ensureDir(trayRuntimeDir(root));
  await unlink(trayStatePath(root)).catch(() => {});
  // A failed helper appends compiler diagnostics to this file. Clear it for a
  // new supervisor attempt so startup errors never report stale diagnostics
  // from an already-fixed source asset.
  await writeFile(trayLogPath(root), '', { mode: 0o600 });
  const entry = resolve(cliEntry);
  // `pnpm dev tray start` passes a .ts entry. Detached child must load TS via
  // `node --import tsx` (same PID as state.json) — never bare `node src/cli.ts`
  // and never a stale dist/ when developing from source.
  const { command: nodeOrTsx, args: runArgs } = await traySupervisorLaunchArgs(entry);
  const { pid } = await spawnDetached(nodeOrTsx, runArgs, {
    pidPath: trayPidPath(root),
    logPath: trayLogPath(root),
    env: {
      ...process.env,
      ANYPICK_HOME: root,
      ANYPICK_TRAY_PROCESS: '1',
      ANYPICK_TRAY_CLI_ENTRY: entry,
    },
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      const log = await readFile(trayLogPath(root), 'utf8').catch(() => '');
      throw new AnyPickError(
        `AnyPick tray exited during startup.${log ? `\n${log.slice(-2000)}` : ''}`,
        'TRAY_START_FAILED',
      );
    }
    const state = await readTrayState(root);
    // Prefer exact PID match. Also accept a ready state whose pid is alive when
    // a loader re-execs (historical tsx CLI) — stop still uses the pid file.
    if (state?.ready && (state.pid === pid || (state.pid != null && isProcessRunning(state.pid)))) {
      return { pid: state.pid === pid ? pid : state.pid, started: true };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  // The tray proves ownership through its ready-state file rather than HTTP.
  // Keep the same explicit exception used by stopTray for timeout cleanup.
  await stopPidFile(trayPidPath(root), { graceMs: 5000, verifyHealth: false });
  throw new AnyPickError('Timed out waiting for the AnyPick supervisor.', 'TRAY_START_TIMEOUT');
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

/** Keep proxy ownership alive when no desktop tray helper is installed. */
async function runHeadlessSupervisor(app: AnyPickApp): Promise<void> {
  await startConfiguredProxies(app);
  let proxyCount = await totalRunningProxyCount(app, await app.proxy.adoptRunningProxies());
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
    proxyCount = await totalRunningProxyCount(app, await app.proxy.adoptRunningProxies());
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

/** Long-running owner for enabled proxies and the platform desktop tray helper. */
export async function runTraySupervisor(app: AnyPickApp): Promise<void> {
  let binary: string | undefined;
  let trayMode: 'native' | 'tauri';
  if (process.platform === 'darwin') {
    assertNativeTrayPlatform();
    binary = await nativeTrayBinary(app.root);
    trayMode = 'native';
  } else {
    binary = await tauriTrayBinary();
    if (!binary) {
      process.stderr.write(
        '[tray] No packaged Tauri helper is available; continuing in headless mode.\n',
      );
      await runHeadlessSupervisor(app);
      return;
    }
    trayMode = 'tauri';
  }
  await startConfiguredProxies(app);
  let proxyCount = await totalRunningProxyCount(app, await app.proxy.adoptRunningProxies());
  const native = spawn(binary, [String(proxyCount)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  const startedAt = new Date().toISOString();
  const activity = new TrayActivityService(app.root);
  const writeState = async (ready: boolean) => {
    const state: TrayRuntimeState = {
      pid: process.pid,
      ready,
      proxyCount,
      startedAt,
      mode: trayMode,
    };
    await writeJsonFile(trayStatePath(app.root), state);
  };
  await writeState(true);

  // Action ids are intentionally process-local and opaque. The native helper
  // may render non-secret display labels, but a click only echoes an id +
  // revision; executable source refs and model-role settings stay here.
  let actionRevision = 0;
  const actionSets = new Map<number, TrayActionSet>();
  const stableActionIds = new Map<string, string>();
  let usage: TrayUsageSnapshot[] = [];
  let usageRefreshedAt = 0;
  let usageStale = true;
  let usageGeneration = 0;
  let usageFetchInFlight: Promise<void> | undefined;

  // Quota endpoints can be slow or unavailable. Keep the first menu render
  // independent from them, then let the next periodic refresh publish cards.
  const refreshUsageInBackground = () => {
    if (!usageStale && Date.now() - usageRefreshedAt < 60_000) {
      return;
    }
    if (usageFetchInFlight) {
      return;
    }
    const generation = usageGeneration;
    usageFetchInFlight = buildTrayUsage(app)
      .then((nextUsage) => {
        if (generation !== usageGeneration) {
          return;
        }
        usage = nextUsage;
        usageRefreshedAt = Date.now();
        usageStale = false;
      })
      .catch(() => {
        if (generation !== usageGeneration) {
          return;
        }
        usage = [];
        usageRefreshedAt = Date.now();
        usageStale = false;
      })
      .finally(() => {
        usageFetchInFlight = undefined;
      });
  };

  let operation = Promise.resolve();
  let shutdownPromise: Promise<void> | undefined;
  const refresh = async () => {
    const accountProxyCount = await app.proxy.adoptRunningProxies();
    const quotaEvents = await app.proxy.quotaGuardEvents();
    await Promise.all(
      quotaEvents.map((event) =>
        activity.record(
          event.to
            ? `Quota Guard switched ${event.providerId}/${event.from} → ${event.to}.`
            : `Quota Guard put ${event.providerId}/${event.from} on cooldown; no eligible backup.`,
          false,
          'quota',
          `quota-guard:${event.id}`,
        ),
      ),
    );
    const preferences = trayPreferences(await app.config.read(), await trayLaunchAtLoginEnabled());
    if (preferences.showQuota) {
      refreshUsageInBackground();
    }
    const revision = actionRevision + 1;
    const nextTargets = new Map<string, TrayActionTarget | TrayProxyActionTarget>();
    const snapshot = await buildTraySnapshot(
      app,
      accountProxyCount,
      {
        revision,
        register(target) {
          const key = JSON.stringify(target);
          const id = stableActionIds.get(key) ?? randomUUID();
          stableActionIds.set(key, id);
          nextTargets.set(id, target);
          return id;
        },
      },
      {
        usage: preferences.showQuota ? usage : [],
        settings: preferences,
        activity: await activity.list(),
      },
    );
    proxyCount = snapshot.proxyCount;
    actionRevision = revision;
    actionSets.set(revision, {
      targets: nextTargets,
      labels: new Map([
        ...snapshot.actions.map((action): [string, string] => [action.id, action.label]),
        ...snapshot.proxies.flatMap(
          (proxy): Array<[string, string]> => [
            [proxy.toggleActionId, proxy.label],
            [proxy.restartActionId, proxy.label],
            ...(proxy.testActionId
              ? ([[proxy.testActionId, `${proxy.label} test`]] as Array<[string, string]>)
              : []),
          ],
        ),
        ...snapshot.hubConflicts.flatMap((conflict) =>
          conflict.candidates.map((candidate): [string, string] => [
            candidate.actionId,
            `${candidate.label} for ${conflict.models.length} model${conflict.models.length === 1 ? '' : 's'}`,
          ]),
        ),
      ]),
    });
    // Keep one previous menu generation so a click racing the 2.5 s refresh
    // still performs the exact opaque target it displayed. Older replays are
    // rejected, and a removed resource will still fail during activation.
    while (actionSets.size > 2) {
      const oldestRevision = actionSets.keys().next().value;
      if (oldestRevision === undefined) {
        break;
      }
      actionSets.delete(oldestRevision);
    }
    sendSnapshot(native, snapshot);
    await writeState(true);
  };
  await refresh();
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

  const cliEntry = process.env.ANYPICK_TRAY_CLI_ENTRY || process.argv[1] || '';
  const lines = createInterface({ input: native.stdout });
  lines.on('line', (line) => {
    const command = decodeTrayCommand(line);
    if (!command) {
      return;
    }
    operation = operation
      .then(async () => {
        switch (command.kind) {
          case 'open':
            await openAnyPickTerminal(cliEntry);
            break;
          case 'navigate':
            await openAnyPickTerminal(cliEntry, command.screen);
            break;
          case 'refresh':
            usageGeneration += 1;
            usageStale = true;
            await refresh();
            break;
          case 'restart':
            await stopAllProxies(app);
            await startEnabledProxies(app);
            await recordTrayActivity(activity, 'Restarted enabled proxies.', false, 'proxy');
            await refresh();
            break;
          case 'stop':
            await stopAllProxies(app);
            await recordTrayActivity(activity, 'Stopped all proxies.', false, 'proxy');
            await refresh();
            break;
          case 'quit':
            void shutdown(false);
            break;
          case 'invoke':
            await invokeTrayAction(
              app,
              native,
              command.payload,
              actionSets,
              activity,
              refresh,
              () => {
                usageGeneration += 1;
                usageStale = true;
              },
            );
            break;
          case 'apply-model-roles':
            await invokeTrayModelRoles(
              app,
              native,
              command.payload,
              actionSets,
              activity,
              refresh,
              () => {
                usageGeneration += 1;
                usageStale = true;
              },
            );
            break;
          case 'logs':
            await sendTrayProxyLogs(app, native, command.payload);
            break;
          case 'mutate':
            await invokeTrayMutation(
              app,
              native,
              command.payload,
              cliEntry,
              activity,
              refresh,
              () => {
                usageGeneration += 1;
                usageStale = true;
              },
            );
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

async function sendTrayProxyLogs(
  app: AnyPickApp,
  native: import('node:child_process').ChildProcessWithoutNullStreams,
  payload: TrayLogsCommand,
): Promise<void> {
  sendProxyLogs(native, await resolveTrayProxyLogs(app, payload));
}
