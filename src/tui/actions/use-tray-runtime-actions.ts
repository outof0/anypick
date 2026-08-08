import React from 'react';
import type { AnyPickApp } from '../../core/app';
import { startTray, stopTray, trayStatus, type TrayStatus } from '../../tray/supervisor';
import {
  desktopTraySurfaceAvailable,
  launchSurface,
  type LaunchSurface,
} from '../../tray/settings';
import type { Screen } from '../model/screen';
import type { TuiShell } from '../use-tui-shell';

export interface TrayRuntimeActions {
  available: boolean;
  status: TrayStatus | null;
  defaultSurface: LaunchSurface;
  open: (back: Screen) => Promise<void>;
  refresh: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  toggleDefaultSurface: () => Promise<void>;
  detach: () => Promise<void>;
}

export function useTrayRuntimeActions(app: AnyPickApp, shell: TuiShell): TrayRuntimeActions {
  const available = desktopTraySurfaceAvailable();
  const [status, setStatus] = React.useState<TrayStatus | null>(null);
  const [defaultSurface, setDefaultSurface] = React.useState<LaunchSurface>('tui');

  const refresh = React.useCallback(async () => {
    const [nextStatus, config] = await Promise.all([trayStatus(app.root), app.config.read()]);
    setStatus(nextStatus);
    setDefaultSurface(launchSurface(config) ?? 'tui');
  }, [app]);

  const open = React.useCallback(
    async (back: Screen) => {
      await shell.withBusy('Loading Tray runtime', refresh);
      shell.go({ kind: 'tray-runtime', back });
    },
    [refresh, shell],
  );

  const start = React.useCallback(async () => {
    if (!available) {
      throw new Error('The desktop Tray is not available on this installation.');
    }
    const cliEntry = process.argv[1];
    if (!cliEntry) {
      throw new Error('AnyPick could not locate its CLI entry point.');
    }
    await shell.withBusy('Starting AnyPick Tray', async () => {
      const result = await startTray(app.root, cliEntry);
      await refresh();
      shell.reportOk(
        result.started ? 'Tray started in the background.' : 'Tray is already running.',
      );
    });
  }, [app.root, available, refresh, shell]);

  const stop = React.useCallback(async () => {
    await shell.withBusy('Stopping AnyPick Tray', async () => {
      const stopped = await stopTray(app.root);
      await refresh();
      shell.reportOk(
        stopped ? 'Tray and its managed proxies stopped.' : 'Tray was already stopped.',
      );
    });
  }, [app.root, refresh, shell]);

  const toggleDefaultSurface = React.useCallback(async () => {
    const next: LaunchSurface = defaultSurface === 'tray' ? 'tui' : 'tray';
    if (next === 'tray' && !available) {
      throw new Error('The desktop Tray is not available on this installation.');
    }
    await shell.withBusy('Saving default surface', async () => {
      await app.config.setLaunchSurface(next);
      setDefaultSurface(next);
      shell.reportOk(`Bare anypick will open the ${next === 'tray' ? 'Tray' : 'Terminal UI'}.`);
    });
  }, [app, available, defaultSurface, shell]);

  const detach = React.useCallback(async () => {
    await start();
    shell.quit(0);
  }, [shell, start]);

  return {
    available,
    status,
    defaultSurface,
    open,
    refresh,
    start,
    stop,
    toggleDefaultSurface,
    detach,
  };
}
