/**
 * Standalone TUI sub-components used by the main app shell.
 * Kept out of app-ui.tsx (the navigation god-component) so each is small,
 * independently testable, and free of the shell's closure state.
 */
import { Box, Text, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HotplugApp } from '../core/app';
import { G, LoadingView, ScreenShell } from './components/chrome';
import { AddModeScreen, addModeOptions, type AddMode } from './screens/add-account';
import { clampIndex } from './app-ui-helpers';

export function AddModeGate(props: {
  app: HotplugApp;
  providerId: string;
  /** Sign-in source for providers with more than one (e.g. Gemini's Antigravity). */
  source?: 'antigravity';
  selectedIndex: number;
  onMove: (d: number) => void;
  onSelectMode: (mode: AddMode, identity?: string) => void;
  onBack: () => void;
}) {
  const [liveIdentity, setLiveIdentity] = useState<string | undefined>();
  const [livePresent, setLivePresent] = useState(false);
  const [canClearLive, setCanClearLive] = useState(false);
  const [canUseApiKey, setCanUseApiKey] = useState(false);
  const [ready, setReady] = useState(false);
  const { source } = props;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const provider = props.app.accounts.provider(props.providerId);
        setCanUseApiKey(provider.credentialInputs?.includes('api-key') ?? false);
        if (source) {
          const live = provider.detectLiveSource
            ? await provider.detectLiveSource(source)
            : { present: false };
          if (cancelled) {
            return;
          }
          setLivePresent(live.present);
          setLiveIdentity(live.identity);
          setCanClearLive(typeof provider.clearLiveSource === 'function');
          return;
        }
        const cur = await props.app.accounts.current(props.providerId);
        if (cancelled) {
          return;
        }
        setLivePresent(cur.live.present);
        setLiveIdentity(cur.live.identity);
        setCanClearLive(typeof provider.clearLive === 'function');
      } finally {
        if (!cancelled) {
          setReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.app, props.providerId, source]);

  if (!ready) {
    return <LoadingView label="Checking logins" />;
  }

  const optionCount = addModeOptions({ livePresent, canClearLive, canUseApiKey }).length;

  return (
    <AddModeScreen
      providerId={props.providerId}
      displayName={
        source === 'antigravity'
          ? 'Antigravity'
          : props.app.accounts.provider(props.providerId).name
      }
      livePresent={livePresent}
      liveIdentity={liveIdentity}
      canClearLive={canClearLive}
      canUseApiKey={canUseApiKey}
      source={source}
      selectedIndex={clampIndex(props.selectedIndex, optionCount)}
      onMove={props.onMove}
      onSelect={(mode) => {
        props.onSelectMode(mode, liveIdentity);
      }}
      onBack={props.onBack}
    />
  );
}

export function MessageContinue({ onContinue }: { onContinue: () => void }) {
  useInput((_input, key) => {
    if (key.return || key.escape) {
      onContinue();
    }
  });
  return null;
}

export function ProxyLogsView(props: {
  app: HotplugApp;
  providerId: string;
  name: string;
  text: string;
  running?: boolean;
  onBack: () => void;
  /** Read the current tail. Used for manual refresh and as a watcher fallback. */
  readLogs: () => Promise<string>;
}) {
  const [lines, setLines] = useState<string[]>(() => props.text.split('\n').filter(Boolean));
  const [following, setFollowing] = useState(true);
  const previousText = useRef(props.text);
  const { stdout } = useStdout();

  const replaceLines = useCallback((text: string) => {
    const next = text.split('\n').filter(Boolean);
    setLines(next.length > 2000 ? next.slice(next.length - 2000) : next);
  }, []);

  // A parent can replace the initial tail after a navigation or account change.
  useEffect(() => {
    if (props.text === previousText.current) {
      return;
    }
    previousText.current = props.text;
    replaceLines(props.text);
  }, [props.text, replaceLines]);

  const refresh = useCallback(() => {
    void props
      .readLogs()
      .then(replaceLines)
      .catch(() => {});
  }, [props.readLogs, replaceLines]);

  useEffect(() => {
    if (!following) {
      return;
    }
    const buf: string[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      flushTimer = undefined;
      if (buf.length === 0) {
        return;
      }
      setLines((prev) => {
        const next = [...prev, ...buf];
        // Cap at 2000 lines to bound memory.
        return next.length > 2000 ? next.slice(next.length - 2000) : next;
      });
      buf.length = 0;
    };
    const controller = new AbortController();
    void props.app.proxy
      .proxyLogsFollow(
        props.providerId,
        props.name,
        (line: string) => {
          buf.push(line);
          if (!flushTimer) {
            flushTimer = setTimeout(flush, 80);
          }
        },
        // The current tail is already supplied through props.text. Replaying
        // another 200 lines here duplicates the screen and pushes new live
        // lines outside the visible terminal viewport.
        { lines: 0, signal: controller.signal },
      )
      .catch(() => {});
    return () => {
      controller.abort();
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
    };
  }, [following, props.app, props.providerId, props.name]);

  useEffect(() => {
    if (!following) {
      return;
    }

    // `proxyLogsFollow` normally pushes new lines within 200ms. Polling the
    // authoritative tail as a fallback closes startup/rotation races and
    // keeps the view live when a platform file watcher misses an append.
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [following, refresh]);

  useInput((input, key) => {
    if (key.escape) {
      props.onBack();
      return;
    }
    if (input === 'f') {
      refresh();
    }
    if (input === ' ') {
      setFollowing((f) => !f);
    }
  });
  const ambient = `${props.providerId}/${props.name}${props.running ? `  ${G.live} running` : ''}`;
  // Keep the newest log line and the live marker visible above the outcome
  // rail. Ink does not scroll an oversized flex column automatically.
  const visibleRows = Math.max(5, (stdout.rows ?? 30) - 10);
  const visibleLines = lines.slice(-visibleRows);
  return (
    <ScreenShell
      path={['proxy', 'logs']}
      ambient={ambient}
      outcome=""
      support=""
      hints={[
        { key: 'f', label: 'refresh' },
        { key: 'space', label: following ? 'pause' : 'follow' },
        { key: 'esc', label: 'back' },
      ]}
    >
      <Box flexDirection="column">
        {visibleLines.map((line, i) => (
          <Text key={i} dimColor>
            {' '}
            {line}
          </Text>
        ))}
        {following ? (
          <Text dimColor> — live — </Text>
        ) : (
          <Text dimColor> — paused — press space to resume — </Text>
        )}
      </Box>
    </ScreenShell>
  );
}
