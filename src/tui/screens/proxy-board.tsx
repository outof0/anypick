/**
 * Proxy — peer daily surface (DESIGN-TUI §6).
 * Account proxies (default) + multi pool opt-in + unsaved live prompts.
 */

import { Box, useInput } from 'ink';
import {
  EmptyState,
  G,
  ProxyRowLine,
  ScreenShell,
  type KeyHint,
  type Notice,
} from '../components/chrome';
import {
  appsUsingProxy,
  proxyBindingRef,
  proxyRowLabel,
  type AppBindingRow,
  type OperationReceipt,
  type ProxyRow,
} from '../model';
import { boardOutcome, proxyStatusKind, usedByLabel } from './proxy-board-helpers';

export interface ProxyBoardScreenProps {
  rows: ProxyRow[];
  selectedIndex: number;
  apps: AppBindingRow[];
  columns: number;
  receipt?: OperationReceipt | null;
  notice?: Notice | null;
  busy?: boolean;
  busyLabel?: string;
  error?: string;
  onMove: (delta: number) => void;
  onPrimary: (row: ProxyRow) => void;
  onRestart: (row: ProxyRow) => void;
  onStop: (row: ProxyRow) => void;
  onEnableStart: (row: ProxyRow) => void;
  onDisable: (row: ProxyRow) => void;
  onLogs: (row: ProxyRow) => void;
  onManageApps: (row: ProxyRow) => void;
  /** Toggle pool multi mode for provider. */
  onTogglePoolMulti?: (row: ProxyRow) => void;
  /** Space on member: enable/pause in pool. */
  onToggleMember?: (row: ProxyRow) => void;
  /** Enable/disable safe quota-driven failover for every multi-account pool. */
  onToggleQuotaGuard?: (row: ProxyRow) => void;
  /** Open the model-routed Proxy Hub editor. */
  onHub?: () => void;
  /** Save unsaved live login for proxy provider. */
  onSaveUnsaved?: (row: ProxyRow) => void;
  onSwitch: () => void;
  onAccounts: () => void;
  onHelp?: () => void;
  onTray?: () => void;
  onDetach?: () => void;
  onQuit: () => void;
}

export function ProxyBoardScreen(props: ProxyBoardScreenProps) {
  const {
    rows,
    selectedIndex,
    apps,
    columns,
    receipt,
    notice,
    busy,
    busyLabel,
    error,
    onMove,
    onPrimary,
    onRestart,
    onStop,
    onEnableStart,
    onDisable,
    onLogs,
    onManageApps,
    onTogglePoolMulti,
    onToggleMember,
    onToggleQuotaGuard,
    onHub,
    onSaveUnsaved,
    onSwitch,
    onAccounts,
    onHelp,
    onTray,
    onDetach,
    onQuit,
  } = props;

  const selected = rows[selectedIndex];
  const ref = selected ? proxyBindingRef(selected) : '';
  const using =
    selected && selected.rowKind !== 'member' && selected.rowKind !== 'unsaved'
      ? appsUsingProxy(apps, ref)
      : [];
  const usedBy = using.length ? using.join(', ') : null;
  const { outcome, support } = boardOutcome(
    selected,
    usedBy ?? (selected ? usedByLabel(selected, apps) : null),
  );
  const quotaGuardHint: KeyHint = { key: 'f', label: 'failover guard' };

  useInput((input, key) => {
    if (busy) {
      return;
    }
    if (input === 'q' || (key.ctrl && input === 'c')) {
      onQuit();
      return;
    }
    if (input === 'h' && onHelp) {
      onHelp();
      return;
    }
    if (input === 't' && onTray) {
      onTray();
      return;
    }
    if (input === 'D' && onDetach) {
      onDetach();
      return;
    }
    if (key.escape) {
      onSwitch();
      return;
    }
    if (key.tab) {
      onSwitch();
      return;
    }
    if (input === 'a') {
      onAccounts();
      return;
    }
    if (key.upArrow || input === 'k') {
      onMove(-1);
      return;
    }
    if (key.downArrow || input === 'j') {
      onMove(1);
      return;
    }
    if (!selected) {
      return;
    }
    if (selected.rowKind === 'hub' && (key.return || input === 'm')) {
      onHub?.();
      return;
    }
    if (selected.rowKind === 'hub') {
      return;
    }
    if (input === ' ' && selected.rowKind === 'member' && onToggleMember) {
      onToggleMember(selected);
      return;
    }
    if (input === 'p' && onTogglePoolMulti && selected.rowKind !== 'unsaved') {
      onTogglePoolMulti(selected);
      return;
    }
    if (input === 'f' && selected.rowKind === 'pool' && onToggleQuotaGuard) {
      onToggleQuotaGuard(selected);
      return;
    }
    if (
      input === 'm' &&
      (selected.status.running || selected.status.enabled || selected.rowKind === 'pool')
    ) {
      if (selected.rowKind !== 'member' && selected.rowKind !== 'unsaved') {
        onManageApps(selected);
      }
      return;
    }
    if (key.return) {
      if (selected.rowKind === 'unsaved') {
        onSaveUnsaved?.(selected);
        return;
      }
      if (selected.needsApiKey) {
        // Block start; keep focus so the rail explains the missing key
        return;
      }
      if (selected.rowKind === 'member') {
        onToggleMember?.(selected);
        return;
      }
      if (selected.status.running || selected.rowKind === 'pool') {
        if (selected.status.running) {
          onManageApps(selected);
        } else if (selected.status.enabled) {
          onPrimary(selected);
        } else {
          onEnableStart(selected);
        }
        return;
      }
      if (selected.status.enabled || selected.stateLabel === 'unavailable') {
        onPrimary(selected);
      } else {
        onEnableStart(selected);
      }
      return;
    }
    if (input === 'r' && selected.status.running) {
      onRestart(selected);
      return;
    }
    if (input === 's' && selected.status.running) {
      onStop(selected);
      return;
    }
    if (input === 'd' && selected.rowKind !== 'member' && selected.rowKind !== 'unsaved') {
      onDisable(selected);
      return;
    }
    if (input === 'l' && selected.rowKind !== 'unsaved' && selected.rowKind !== 'member') {
      onLogs(selected);
    }
  });

  const running = rows.filter((r) => r.status.running).length;
  const ambient = running > 0 ? `${G.live} ${running} running` : undefined;

  const hints: KeyHint[] = !selected
    ? [
        { key: 'a', label: 'accounts' },
        { key: 'tab', label: 'apps' },
        { key: 'h', label: 'help', when: Boolean(onHelp) },
        { key: 'q', label: 'quit' },
      ]
    : selected.needsApiKey
      ? [
          { key: 'a', label: 'accounts' },
          { key: 'tab', label: 'apps' },
          { key: 'h', label: 'help', when: Boolean(onHelp) },
        ]
      : selected.rowKind === 'hub'
        ? [
            { key: 'enter', label: 'configure Hub' },
            { key: 'm', label: 'manage Hub' },
            { key: 'a', label: 'accounts' },
            { key: 'tab', label: 'apps' },
          ]
        : selected.rowKind === 'unsaved'
          ? [
              { key: 'enter', label: 'save this login' },
              { key: 'a', label: 'accounts' },
              { key: 'tab', label: 'apps' },
            ]
          : selected.rowKind === 'member'
            ? [
                { key: 'space', label: selected.memberEnabled ? 'pause' : 'enable' },
                { key: 'p', label: 'pool mode' },
                { key: 'a', label: 'accounts' },
                { key: 'tab', label: 'apps' },
              ]
            : selected.status.running
              ? [
                  { key: 'enter', label: 'manage apps' },
                  { key: 'm', label: 'manage apps' },
                  { key: 's', label: 'stop' },
                  { key: 'r', label: 'restart' },
                  { key: 'd', label: 'disable' },
                  { key: 'p', label: 'pool', when: Boolean(onTogglePoolMulti) },
                  ...(selected.rowKind === 'pool' && onToggleQuotaGuard ? [quotaGuardHint] : []),
                  { key: 'l', label: 'logs' },
                  { key: 'a', label: 'accounts' },
                  { key: 'tab', label: 'apps' },
                ]
              : selected.status.enabled
                ? [
                    { key: 'enter', label: 'start' },
                    { key: 'm', label: 'manage apps' },
                    { key: 'd', label: 'disable' },
                    { key: 'p', label: 'pool', when: Boolean(onTogglePoolMulti) },
                    ...(selected.rowKind === 'pool' && onToggleQuotaGuard ? [quotaGuardHint] : []),
                    { key: 'l', label: 'logs' },
                    { key: 'a', label: 'accounts' },
                    { key: 'tab', label: 'apps' },
                  ]
                : selected.stateLabel === 'unavailable'
                  ? [
                      { key: 'enter', label: 'check again' },
                      { key: 'l', label: 'logs' },
                      { key: 'a', label: 'accounts' },
                      { key: 'tab', label: 'apps' },
                    ]
                  : [
                      { key: 'enter', label: 'turn on and start' },
                      { key: 'p', label: 'multi pool', when: Boolean(onTogglePoolMulti) },
                      ...(selected.rowKind === 'pool' && onToggleQuotaGuard
                        ? [quotaGuardHint]
                        : []),
                      { key: 'a', label: 'accounts' },
                      { key: 'tab', label: 'apps' },
                    ];

  hints.push(
    { key: 't', label: 'tray runtime', when: Boolean(onTray) },
    { key: 'D', label: 'detach to Tray', when: Boolean(onDetach) },
  );

  return (
    <ScreenShell
      path="proxy"
      ambient={ambient}
      columns={columns}
      receipt={receipt}
      notice={notice}
      error={error}
      busy={busy}
      busyLabel={busyLabel}
      outcome={outcome}
      support={support}
      hints={hints}
    >
      <Box flexDirection="column">
        {rows.length === 0 ? (
          <EmptyState
            text="No saved logins can run a proxy yet."
            hint="Add a Grok, OpenCode, Gemini, or Kiro login — or save a live login from Switch."
          />
        ) : (
          rows.map((row, i) => {
            const label = proxyRowLabel(row);
            const display = row.indent ? `  ${label}` : label;
            return (
              <ProxyRowLine
                key={`${row.rowKind ?? 'a'}:${row.providerId}/${row.name}:${i}`}
                selected={i === selectedIndex}
                refLabel={display}
                status={proxyStatusKind(row)}
                usedBy={usedByLabel(row, apps)}
                columns={columns}
              />
            );
          })
        )}
      </Box>
    </ScreenShell>
  );
}
