/**
 * Account detail — read-only info card + live usage (when this account is the
 * active/live one). Actions (export/import/remove/refresh/logs) stay on the
 * accounts list to avoid duplicating key bindings across two screens.
 */

import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ScreenShell, Spacer } from '../components/chrome';
import { formatUsageWindow, identityDisplayText, type AccountDetailModel } from '../model';
import type { AnyPickApp } from '../../core/app';
import type { LiveUsage } from '../../types';

export interface AccountDetailScreenProps {
  app: AnyPickApp;
  detail: AccountDetailModel;
  onBack: () => void;
}

export function AccountDetailScreen(props: AccountDetailScreenProps) {
  const { app, detail, onBack } = props;
  const [usage, setUsage] = useState<LiveUsage | null>(null);

  useInput((_input, key) => {
    if (key.escape || key.return) {
      onBack();
    }
  });

  // Usage is a property of the live login on disk, so only fetch it for the
  // active account (AnyPick keeps exactly one login live at a time).
  useEffect(() => {
    if (!detail.active) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const u = await app.accounts.liveUsage(detail.providerId);
        if (!cancelled) {
          setUsage(u);
        }
      } catch {
        // Usage is best-effort; never block the detail view.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [app, detail.providerId, detail.active]);

  const proxyLine = detail.proxy
    ? `${detail.proxyStateLabel ?? '—'} · ${detail.proxy.endpoint ?? `${detail.proxy.host ?? '127.0.0.1'}:${detail.proxy.port ?? '—'}`}`
    : detail.canProxy
      ? 'disabled'
      : 'not supported';

  return (
    <ScreenShell
      path={[detail.providerId, detail.name]}
      outcome={detail.canonical}
      support={identityDisplayText(detail.identity, 'no identity')}
      hints={[{ key: 'esc', label: 'back' }]}
    >
      <Box flexDirection="column">
        <Text bold> {detail.canonical}</Text>
        <Text dimColor>
          {' '}
          {detail.label && detail.label !== detail.name ? detail.label + ' · ' : ''}
          {identityDisplayText(detail.identity, 'no identity')}
        </Text>
        <Spacer />
        <Text> active {detail.active ? 'yes' : 'no'}</Text>
        <Text> relation {detail.relationSummary}</Text>
        <Text>
          {' '}
          updated {detail.updatedRelative} ({detail.updatedAt})
        </Text>
        <Text> created {detail.createdAt}</Text>
        {detail.canProxy ? <Text> proxy {proxyLine}</Text> : null}
        {usage && usage.windows.length > 0 ? (
          <>
            <Spacer />
            <Text dimColor> Usage (live login)</Text>
            {usage.windows.map((w, i) => (
              <Text key={i}> {formatUsageWindow(w)}</Text>
            ))}
          </>
        ) : null}
        <Spacer />
        <Text dimColor> Advanced</Text>
        <Text dimColor> snapshot {detail.snapshotDir}</Text>
      </Box>
    </ScreenShell>
  );
}
