import type React from 'react';
import { Box, Text } from 'ink';
import type { OperationReceipt } from '../../model';
import { G } from './status';
import { ScreenHeader, type KeyHint, type Notice, type ScreenPath } from './header';
import { Rule, ScreenShell } from './layout';

export function ScreenFrame(props: {
  screen?: string;
  status?: string;
  step?: string;
  receipt?: OperationReceipt | null;
  error?: string;
  busy?: boolean;
  footer?: string;
  children: React.ReactNode;
  path?: ScreenPath | string[];
  outcome?: string;
  support?: string;
  hints?: KeyHint[];
  columns?: number;
  ambient?: string;
  notice?: Notice | null;
  busyLabel?: string;
}) {
  const path =
    props.path ??
    [legacyScreenPath(props.screen), props.step ? props.step.toLowerCase() : '']
      .filter(Boolean)
      .join(' / ')
      .split(' / ')
      .filter(Boolean);

  const hints: KeyHint[] =
    props.hints ??
    (props.footer
      ? props.footer.split(/\s*·\s*/).map((part) => {
          const m = part.trim().match(/^(\S+)\s+(.+)$/);
          return m ? { key: m[1] ?? '', label: m[2] ?? '' } : { key: part.trim(), label: '' };
        })
      : []);

  return (
    <ScreenShell
      path={path.length ? path : 'switch'}
      ambient={props.ambient ?? props.status}
      columns={props.columns}
      notice={props.notice}
      receipt={props.receipt}
      error={props.error}
      busy={props.busy}
      busyLabel={props.busyLabel}
      outcome={props.outcome}
      support={props.support}
      hints={hints}
    >
      {props.children}
    </ScreenShell>
  );
}

function legacyScreenPath(screen?: string): string {
  if (!screen) {
    return 'switch';
  }
  const s = screen.toLowerCase();
  if (s === 'anypick' || s === 'home') {
    return 'switch';
  }
  return s;
}

/** @deprecated */
export function AppChromeHeader(props: {
  version?: string;
  projectRoot?: string;
  issueCount?: number;
  proxyRunningCount?: number;
  driftCount?: number;
  screen: string;
  screenStatus?: string;
}) {
  void props.version;
  void props.projectRoot;
  void props.issueCount;
  const ambient =
    props.screenStatus ??
    [
      props.driftCount && props.driftCount > 0 ? `${G.changed} ${props.driftCount} changed` : '',
      props.proxyRunningCount && props.proxyRunningCount > 0
        ? `${G.live} ${props.proxyRunningCount} running`
        : '',
    ]
      .filter(Boolean)
      .join('  ');
  return <ScreenHeader path={legacyScreenPath(props.screen)} ambient={ambient || undefined} />;
}

/** @deprecated */
export function Header(props: {
  screen?: string;
  status?: string;
  title?: string;
  breadcrumb?: string[];
}) {
  if (props.breadcrumb?.length) {
    return (
      <ScreenHeader path={props.breadcrumb.map((b) => b.toLowerCase())} ambient={props.status} />
    );
  }
  return (
    <Box flexDirection="column">
      <ScreenHeader path={legacyScreenPath(props.screen)} ambient={props.status} />
      {props.title ? <Text dimColor> {props.title}</Text> : null}
    </Box>
  );
}

/** @deprecated — design forbids permanent right pane */
export function TwoPane(props: {
  columns: number;
  left: React.ReactNode;
  right: React.ReactNode;
  wideAt?: number;
}) {
  void props.wideAt;
  return <Box flexDirection="column">{props.left}</Box>;
}

export function SectionLabel(props: { children: string }) {
  return <Text bold> {props.children}</Text>;
}

/** Selected row: › + bold name (no color) */
export function ListRow(props: { selected: boolean; children: React.ReactNode }) {
  return <Text bold={props.selected}> {props.children}</Text>;
}

/** @deprecated Inspect removed from design */
export function InspectPane(props: { title?: string; lines: string[]; emphasizePrefix?: string }) {
  void props.emphasizePrefix;
  return (
    <Box flexDirection="column">
      {props.lines.map((line, i) =>
        line === '' ? <Text key={i}> </Text> : <Text key={i}> {line}</Text>,
      )}
    </Box>
  );
}

/** @deprecated */
export function ContextBlock(props: { title?: string; lines: string[] }) {
  return <InspectPane lines={props.lines} />;
}

export function FooterBar(props: { text: string }) {
  return (
    <Box flexDirection="column">
      <Rule />
      <Text dimColor> {props.text}</Text>
    </Box>
  );
}

export function PrimaryAction(props: { label: string }) {
  return (
    <Text>
      {' '}
      <Text bold>{G.focus}</Text> {props.label}
    </Text>
  );
}

export function HintLine(props: { text: string }) {
  return <Text dimColor> {props.text}</Text>;
}

export function StatusLine(props: { text: string }) {
  return <Text dimColor> {props.text}</Text>;
}

export function Explanation(props: { text: string }) {
  return <Text> {props.text}</Text>;
}

export function SelectList(props: { items: string[]; selectedIndex: number }) {
  return (
    <Box flexDirection="column">
      {props.items.map((item, i) => (
        <ListRow key={i} selected={i === props.selectedIndex}>
          {i === props.selectedIndex ? G.focus : ' '} {item}
        </ListRow>
      ))}
    </Box>
  );
}
