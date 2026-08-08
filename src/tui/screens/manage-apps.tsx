/**
 * Proxy → manage apps (DESIGN-TUI §6.3).
 */

import { Box, Text, useInput } from 'ink';
import { DataRow, EmptyState, ScreenShell, type KeyHint } from '../components/chrome';
import type { AppBindingRow } from '../model';

export interface ManageAppsScreenProps {
  proxyRef: string;
  /** Breadcrumb for the source that opened this shared screen. */
  path?: string | string[];
  apps: AppBindingRow[];
  checked: Set<string>;
  selectedIndex: number;
  busy?: boolean;
  columns?: number;
  /** clientId → short models summary, e.g. "default=grok-4.5" */
  modelSummaries?: Record<string, string>;
  onMove: (delta: number) => void;
  onToggle: (clientId: string) => void;
  onConfirm: () => void;
  /** Edit model map for an app already using this proxy. */
  onEditModels?: (clientId: string) => void;
  onCancel: () => void;
}

function appStatus(
  app: AppBindingRow,
  proxyRef: string,
): { kind: 'using' | 'not-using'; label: string } {
  if (app.bound && app.sourceDisplay === proxyRef) {
    return { kind: 'using', label: 'using this proxy' };
  }
  if (app.bound && app.sourceDisplay) {
    return { kind: 'using', label: `using ${app.sourceDisplay}` };
  }
  return { kind: 'not-using', label: 'not using' };
}

export function ManageAppsScreen(props: ManageAppsScreenProps) {
  const {
    proxyRef,
    path = ['proxy', 'apps'],
    apps,
    checked,
    selectedIndex,
    busy,
    columns = 80,
    modelSummaries = {},
    onMove,
    onToggle,
    onConfirm,
    onEditModels,
    onCancel,
  } = props;

  const currentlyUsing = new Set(
    apps.filter((a) => a.bound && a.sourceDisplay === proxyRef).map((a) => a.clientId),
  );
  const toAttach = [...checked].filter((id) => !currentlyUsing.has(id));
  const toDetach = [...currentlyUsing].filter((id) => !checked.has(id));
  const changeCount = toAttach.length + toDetach.length;
  const selected = apps[selectedIndex];
  const canEditModels =
    Boolean(onEditModels) &&
    Boolean(selected) &&
    selected.bound &&
    selected.sourceDisplay === proxyRef;

  useInput((input, key) => {
    if (busy) {
      return;
    }
    if (key.escape) {
      onCancel();
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
    if (input === ' ') {
      const sel = apps[selectedIndex];
      if (sel) {
        onToggle(sel.clientId);
      }
      return;
    }
    if (input === 'm' && canEditModels && selected) {
      onEditModels?.(selected.clientId);
      return;
    }
    // Enter with no checkbox changes → edit models for current app if using this proxy
    if (key.return) {
      if (changeCount > 0) {
        onConfirm();
        return;
      }
      if (canEditModels && selected) {
        onEditModels?.(selected.clientId);
      }
    }
  });

  let outcome = 'No app changes selected.';
  let support = 'space toggle   esc cancel';
  if (canEditModels && changeCount === 0) {
    const summary = modelSummaries[selected.clientId];
    outcome = `Models for ${selected.clientName}`;
    support = summary
      ? `${summary}   ·  enter or m to edit`
      : 'enter or m to set models for this app';
  }
  if (changeCount > 0) {
    if (toAttach.length && !toDetach.length) {
      outcome = `Use ${proxyRef} with ${toAttach
        .map((id) => apps.find((a) => a.clientId === id)?.clientName ?? id)
        .join(' and ')}`;
      support = 'Next you will set models for each new app.';
    } else if (toDetach.length && !toAttach.length) {
      outcome = `Stop using ${proxyRef} with ${toDetach
        .map((id) => apps.find((a) => a.clientId === id)?.clientName ?? id)
        .join(' and ')}`;
      support = '';
    } else {
      outcome = `Review ${changeCount} change${changeCount === 1 ? '' : 's'}`;
      support = toAttach.length ? 'New apps will open the model map next.' : '';
    }
  }

  const hints: KeyHint[] =
    changeCount === 0
      ? [
          { key: 'space', label: 'toggle' },
          ...(canEditModels
            ? [
                { key: 'enter', label: 'models' } as KeyHint,
                { key: 'm', label: 'models' } as KeyHint,
              ]
            : []),
          { key: 'esc', label: 'back' },
        ]
      : [
          { key: 'space', label: 'toggle' },
          {
            key: 'enter',
            label: `review ${changeCount} change${changeCount === 1 ? '' : 's'}`,
          },
          { key: 'esc', label: 'cancel' },
        ];

  return (
    <ScreenShell
      path={path}
      columns={columns}
      busy={busy}
      busyLabel="Looking for supported apps"
      outcome={outcome}
      support={support}
      hints={hints}
    >
      <Box flexDirection="column">
        <Text bold> Apps using {proxyRef}</Text>
        <Text> </Text>
        {apps.length === 0 ? (
          <EmptyState
            text="No supported apps were found."
            hint="Install Claude Code, Codex, or Gemini CLI, then reopen this screen."
          />
        ) : (
          apps.map((app, i) => {
            const st = appStatus(app, proxyRef);
            const box = checked.has(app.clientId) ? '[x]' : '[ ]';
            const models = modelSummaries[app.clientId];
            const identity = st.kind === 'using' && models ? `${st.label} · ${models}` : st.label;
            return (
              <DataRow
                key={app.clientId}
                selected={i === selectedIndex}
                name={`${box} ${app.clientName}`}
                identity={identity}
                status={st.kind}
                columns={columns}
              />
            );
          })
        )}
      </Box>
    </ScreenShell>
  );
}

export function describeAppChanges(
  proxyRef: string,
  apps: AppBindingRow[],
  checked: Set<string>,
): { attach: AppBindingRow[]; detach: AppBindingRow[]; body: string[] } {
  const currentlyUsing = new Set(
    apps.filter((a) => a.bound && a.sourceDisplay === proxyRef).map((a) => a.clientId),
  );
  const attach = apps.filter((a) => checked.has(a.clientId) && !currentlyUsing.has(a.clientId));
  const detach = apps.filter((a) => currentlyUsing.has(a.clientId) && !checked.has(a.clientId));
  const body: string[] = [];
  for (const a of attach) {
    const from = a.sourceDisplay ?? 'not using';
    body.push(`${a.clientName.padEnd(10)} ${from}  →  ${proxyRef}`);
  }
  for (const a of detach) {
    body.push(`${a.clientName.padEnd(10)} ${proxyRef}  →  no AnyPick proxy`);
  }
  return { attach, detach, body };
}
