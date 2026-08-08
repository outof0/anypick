import React from 'react';
import { useApp } from 'ink';
import { isHotplugError } from '../utils/errors';
import type { OperationReceipt, OperationReceiptLine } from './model/types';
import type { Screen } from './model/screen';

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Chrome shared by every screen: navigation, the busy banner, the inline error
 * line, and the operation receipt.
 *
 * Feature hooks take one `TuiShell` instead of a dozen loose setters, which is
 * what makes them extractable from the root component at all.
 */
export interface TuiShell {
  screen: Screen;
  go: (s: Screen) => void;
  /**
   * Update the current screen in place, or leave it alone when `update` returns
   * null. For a late async result: it sees the screen as it is at write time, so
   * a caller can decline to clobber a screen the user has already navigated away
   * from or started typing into.
   */
  replaceScreen: (update: (current: Screen) => Screen | null) => void;
  quit: (code?: number) => void;
  selectedIndex: number;
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  busy: boolean;
  busyLabel: string | undefined;
  /**
   * Show the busy banner for the duration of `fn`. Rejections propagate: the
   * caller decides whether a failure is a receipt, an inline error, or fatal.
   */
  withBusy: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  error: string | undefined;
  setError: React.Dispatch<React.SetStateAction<string | undefined>>;
  receipt: OperationReceipt | null;
  setReceipt: React.Dispatch<React.SetStateAction<OperationReceipt | null>>;
  reportOk: (text: string) => void;
  /**
   * Report a failure as a receipt. Any `HotplugError` suggestions are appended
   * as info lines, so remediation hints reach the TUI the same way
   * `toHuman()` carries them to the CLI. `fallback` replaces the raw value for
   * a non-`Error` throw, where `String(err)` would be unreadable.
   */
  reportFail: (err: unknown, fallback?: string) => void;
}

export function useTuiShell(onExit: (code?: number) => void): TuiShell {
  const { exit } = useApp();
  const [screen, setScreen] = React.useState<Screen>({
    kind: 'loading',
    label: 'Loading saved logins',
  });
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [busyLabel, setBusyLabel] = React.useState<string | undefined>();
  const [error, setError] = React.useState<string | undefined>();
  const [receipt, setReceipt] = React.useState<OperationReceipt | null>(null);

  // Success notices clear after 3s or next navigation.
  React.useEffect(() => {
    if (
      !receipt?.lines.some((l) => l.kind === 'ok') ||
      receipt.lines.some((l) => l.kind === 'warn' || l.kind === 'fail')
    ) {
      return;
    }
    const t = setTimeout(() => setReceipt(null), 3000);
    return () => clearTimeout(t);
  }, [receipt]);

  const go = React.useCallback((s: Screen) => {
    setError(undefined);
    setScreen(s);
  }, []);

  const replaceScreen = React.useCallback((update: (current: Screen) => Screen | null) => {
    setScreen((current) => update(current) ?? current);
  }, []);

  const quit = React.useCallback(
    (code = 0) => {
      exit();
      onExit(code);
    },
    [exit, onExit],
  );

  React.useEffect(() => {
    const onSigInt = () => {
      quit(130);
    };
    process.once('SIGINT', onSigInt);
    return () => {
      process.off('SIGINT', onSigInt);
    };
  }, [quit]);

  const withBusy = React.useCallback(async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    setBusy(true);
    setBusyLabel(label);
    try {
      return await fn();
    } finally {
      setBusy(false);
      setBusyLabel(undefined);
    }
  }, []);

  const reportOk = React.useCallback((text: string) => {
    setReceipt({ title: '', lines: [{ kind: 'ok', text }] });
  }, []);

  const reportFail = React.useCallback((err: unknown, fallback?: string) => {
    const text = err instanceof Error ? err.message : (fallback ?? String(err));
    const lines: OperationReceiptLine[] = [{ kind: 'fail', text }];
    if (isHotplugError(err)) {
      for (const s of err.suggestions) {
        lines.push({ kind: 'info', text: `– ${s}` });
      }
    }
    setReceipt({ title: '', lines });
  }, []);

  return {
    screen,
    go,
    replaceScreen,
    quit,
    selectedIndex,
    setSelectedIndex,
    busy,
    busyLabel,
    withBusy,
    error,
    setError,
    receipt,
    setReceipt,
    reportOk,
    reportFail,
  };
}
