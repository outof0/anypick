/**
 * Root launcher action model (spec §7 rev 2.5).
 * Pure data — no I/O chrome. First paint uses local state only.
 */

import type { HotplugApp } from '../core/app';
import { localAttentionFor } from './local-health';
import { shortCwd } from './render-util';

export type LauncherSection = 'attention' | 'run' | 'configure' | 'more' | 'get-started' | 'other';

export type LauncherActionKind =
  | 'run'
  | 'fix-attention'
  | 'change-default'
  | 'add-connection'
  | 'link'
  | 'view-details'
  | 'doctor'
  | 'connect-client'
  | 'add-account'
  | 'add-gateway';

export interface LauncherAction {
  /** Stable semantic id for selection restore across refresh. */
  id: string;
  kind: LauncherActionKind;
  section: LauncherSection;
  /** Primary label (e.g. "Claude"). */
  label: string;
  /** Middle column (source display). */
  detail?: string;
  /** Right column status (ready / token expired / …). */
  status?: string;
  /** Client id when applicable. */
  clientId?: string;
  /** Severity for attention items. */
  severity?: 'error' | 'warn';
  /** Footer hint when this row is focused. */
  preview?: string;
}

export interface LauncherModel {
  cwd: string;
  cwdShort: string;
  mode: 'ready' | 'empty' | 'degraded';
  title: string;
  subtitle: string;
  actions: LauncherAction[];
}

export interface ClientRow {
  clientId: string;
  clientName: string;
  shortName: string;
  /** Effective source display, if any. */
  source?: string;
  status: 'ready' | 'attention' | 'unbound';
  attention?: string;
}

/** Short, scannable names for the Run column. */
export function shortClientName(clientId: string, fullName: string): string {
  switch (clientId) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'kiro':
      return 'Kiro';
    default:
      return fullName.length > 14 ? fullName.slice(0, 13) + '…' : fullName;
  }
}

function sourceDisplay(source: { kind: string; provider?: string; name?: string }): string {
  if (source.kind === 'account' && source.provider && source.name) {
    return `${source.provider}/${source.name}`;
  }
  if (source.kind === 'gateway' && source.name) {
    return source.name;
  }
  if (source.kind === 'preset' && source.name) {
    return `@${source.name}`;
  }
  return '?';
}

export async function buildClientRows(app: HotplugApp): Promise<ClientRow[]> {
  const clients = app.clients.list();
  return Promise.all(
    clients.map(async (c) => {
      const shortName = shortClientName(c.id, c.name);
      let effective;
      try {
        effective = app.bindingService.current(c.id)[0];
      } catch {
        effective = undefined;
      }
      const binding = effective?.binding;
      if (!binding) {
        return {
          clientId: c.id,
          clientName: c.name,
          shortName,
          status: 'unbound' as const,
        };
      }
      const src = binding.spec.source;
      const display = sourceDisplay(src);
      const attention = await localAttentionFor(app, c.id, src);
      if (attention) {
        return {
          clientId: c.id,
          clientName: c.name,
          shortName,
          source: display,
          status: 'attention' as const,
          attention,
        };
      }
      return {
        clientId: c.id,
        clientName: c.name,
        shortName,
        source: display,
        status: 'ready' as const,
      };
    }),
  );
}

export async function buildLauncherModel(
  app: HotplugApp,
  opts: { cwd?: string } = {},
): Promise<LauncherModel> {
  const cwd = opts.cwd ?? process.cwd();
  const clientRows = await buildClientRows(app);
  const ready = clientRows.filter((r) => r.status === 'ready');
  const attention = clientRows.filter((r) => r.status === 'attention');
  const unbound = clientRows.filter((r) => r.status === 'unbound');

  const actions: LauncherAction[] = [];

  // Empty: no bindings at all
  if (ready.length === 0 && attention.length === 0) {
    for (const r of unbound) {
      actions.push({
        id: `connect:${r.clientId}`,
        kind: 'connect-client',
        section: 'get-started',
        label: `Connect ${r.shortName}`,
        clientId: r.clientId,
        preview: `set ${r.clientId} source`,
      });
    }
    actions.push(
      {
        id: 'other:add-account',
        kind: 'add-account',
        section: 'other',
        label: 'Add account',
        preview: 'save a native login',
      },
      {
        id: 'other:add-gateway',
        kind: 'add-gateway',
        section: 'other',
        label: 'Add gateway',
        preview: 'API endpoint + key',
      },
    );
    return {
      cwd,
      cwdShort: shortCwd(cwd),
      mode: 'empty',
      title: 'hotplug',
      subtitle: 'No clients connected yet',
      actions,
    };
  }

  for (const r of attention) {
    actions.push({
      id: `attention:${r.clientId}`,
      kind: 'fix-attention',
      section: 'attention',
      label: `Fix ${r.shortName}`,
      detail: r.attention,
      clientId: r.clientId,
      severity: 'error',
      preview: `repair ${r.clientId}`,
    });
  }

  for (const r of ready) {
    actions.push({
      id: `run:${r.clientId}`,
      kind: 'run',
      section: 'run',
      label: r.shortName,
      detail: r.source,
      status: 'ready',
      clientId: r.clientId,
      preview: `hotplug run ${r.clientId}`,
    });
  }

  actions.push(
    {
      id: 'configure:change-default',
      kind: 'change-default',
      section: 'configure',
      label: 'Change a default',
      preview: 'hotplug use <client> --with …',
    },
    {
      id: 'configure:add-connection',
      kind: 'add-connection',
      section: 'configure',
      label: 'Add connection',
      preview: 'account or gateway',
    },
    {
      id: 'configure:link',
      kind: 'link',
      section: 'configure',
      label: 'Link this project',
      preview: 'project-local binding',
    },
  );

  actions.push(
    {
      id: 'more:details',
      kind: 'view-details',
      section: 'more',
      label: 'View details',
      preview: 'hotplug current',
    },
    {
      id: 'more:doctor',
      kind: 'doctor',
      section: 'more',
      label: 'Diagnose',
      preview: 'hotplug doctor',
    },
  );

  const mode: LauncherModel['mode'] = attention.length > 0 ? 'degraded' : 'ready';
  return {
    cwd,
    cwdShort: shortCwd(cwd),
    mode,
    title: 'hotplug',
    subtitle: mode === 'degraded' ? 'Needs attention' : 'AI CLI connections',
    actions,
  };
}

export const SECTION_LABELS: Record<LauncherSection, string> = {
  attention: 'Attention',
  run: 'Run',
  configure: 'Configure',
  more: 'More',
  'get-started': 'Get started',
  other: 'Other',
};

export const SECTION_ORDER: LauncherSection[] = [
  'attention',
  'run',
  'get-started',
  'configure',
  'other',
  'more',
];
