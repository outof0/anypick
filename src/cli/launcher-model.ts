/**
 * Root launcher action model (spec §7 rev 2.5).
 * Pure data — no I/O chrome. First paint uses local state only.
 */

import type { AnyPickApp } from '../core/app';
import { localAttentionFor } from './local-health';
import { shortCwd } from './render-util';
import { shortClientName } from '../presentation/client-name';

export { shortClientName };

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
  /** Effective primary model when the binding pins one. */
  model?: string;
  /** Binding scope reported by the resolver (normally global on the launcher). */
  scope?: string | null;
  status: 'ready' | 'attention' | 'native' | 'unbound';
  /** Identity reported by the matching native provider when no AnyPick route exists. */
  nativeIdentity?: string;
  attention?: string;
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
  if (source.kind === 'account-pool' && source.provider) {
    return `pool:${source.provider}`;
  }
  if (source.kind === 'proxy-hub' && source.name) {
    return `hub:${source.name}`;
  }
  return '?';
}

export async function buildClientRows(app: AnyPickApp): Promise<ClientRow[]> {
  const clients = app.clients.list();
  return Promise.all(
    clients.map(async (c) => {
      const shortName = shortClientName(c.id, c.name, c.shortName);
      let effective;
      try {
        effective = app.bindingService.current(c.id)[0];
      } catch {
        effective = undefined;
      }
      const binding = effective?.binding;
      if (!binding) {
        const native = await nativeConnectionFor(app, c.id);
        if (native) {
          return {
            clientId: c.id,
            clientName: c.name,
            shortName,
            source: 'native login',
            status: 'native' as const,
            nativeIdentity: native.identity,
          };
        }
        return {
          clientId: c.id,
          clientName: c.name,
          shortName,
          status: 'unbound' as const,
        };
      }
      const src = binding.spec.source;
      const display = sourceDisplay(src);
      const model =
        binding.spec.model.mode === 'explicit'
          ? binding.spec.model.id
          : typeof binding.spec.clientOptions.modelRoles === 'object' &&
              binding.spec.clientOptions.modelRoles &&
              'default' in binding.spec.clientOptions.modelRoles &&
              typeof binding.spec.clientOptions.modelRoles.default === 'string'
            ? binding.spec.clientOptions.modelRoles.default
            : undefined;
      const attention = await localAttentionFor(app, c.id, src);
      if (attention) {
        return {
          clientId: c.id,
          clientName: c.name,
          shortName,
          source: display,
          model,
          scope: effective?.scope,
          status: 'attention' as const,
          attention,
        };
      }
      return {
        clientId: c.id,
        clientName: c.name,
        shortName,
        source: display,
        model,
        scope: effective?.scope,
        status: 'ready' as const,
      };
    }),
  );
}

/**
 * Matching account/client ids identify native auth without a client-specific
 * branch. Native means "usable outside AnyPick", not "AnyPick route exists".
 */
export async function nativeConnectionFor(
  app: AnyPickApp,
  clientId: string,
): Promise<{ identity?: string } | null> {
  if (!app.accountRegistry.has(clientId)) {
    return null;
  }
  try {
    const current = await app.accounts.current(clientId);
    return current.live.present ? { identity: current.live.identity } : null;
  } catch {
    return null;
  }
}

export async function buildLauncherModel(
  app: AnyPickApp,
  opts: { cwd?: string } = {},
): Promise<LauncherModel> {
  const cwd = opts.cwd ?? process.cwd();
  const clientRows = await buildClientRows(app);
  const ready = clientRows.filter((r) => r.status === 'ready');
  const attention = clientRows.filter((r) => r.status === 'attention');
  const native = clientRows.filter((r) => r.status === 'native');
  const unbound = clientRows.filter((r) => r.status === 'unbound' || r.status === 'native');

  const actions: LauncherAction[] = [];

  // Empty: no bindings at all
  if (ready.length === 0 && attention.length === 0) {
    for (const r of unbound) {
      actions.push({
        id: `connect:${r.clientId}`,
        kind: 'connect-client',
        section: 'get-started',
        label:
          r.status === 'native' ? `Connect ${r.shortName} to AnyPick` : `Connect ${r.shortName}`,
        detail: r.status === 'native' ? (r.nativeIdentity ?? 'native login active') : undefined,
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
      title: 'anypick',
      subtitle: native.length
        ? 'Native clients found · no AnyPick routes yet'
        : 'No clients connected yet',
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
      preview: `anypick run ${r.clientId}`,
    });
  }

  actions.push(
    {
      id: 'configure:change-default',
      kind: 'change-default',
      section: 'configure',
      label: 'Change a default',
      preview: 'anypick use <client> --with …',
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
      preview: 'anypick current',
    },
    {
      id: 'more:doctor',
      kind: 'doctor',
      section: 'more',
      label: 'Diagnose',
      preview: 'anypick doctor',
    },
  );

  const mode: LauncherModel['mode'] = attention.length > 0 ? 'degraded' : 'ready';
  return {
    cwd,
    cwdShort: shortCwd(cwd),
    mode,
    title: 'anypick',
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
