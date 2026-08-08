import { mkdir } from 'node:fs/promises';
import { getAnyPickRoot, anypickDbPath } from './paths';
import { pathExists } from '../utils/fs';
import { displayRef } from './refs';
import { scanPermissions, scanProxyPids, scanStaleLocks, scanTempOverlays } from './doctor-scan';
import type { DoctorCheck, DoctorReport, DoctorServiceDeps } from './doctor-types';

export async function runDoctorReport(
  deps: DoctorServiceDeps,
  target?: string,
): Promise<DoctorReport> {
  const root = getAnyPickRoot(deps.root);
  const checks: DoctorCheck[] = [];
  const filter = target?.trim().toLowerCase();

  const push = (c: DoctorCheck) => {
    if (filter && !c.id.toLowerCase().includes(filter) && filter !== 'all') {
      if (!c.message.toLowerCase().includes(filter) && !c.id.toLowerCase().startsWith(filter)) {
        return;
      }
    }
    checks.push(c);
  };

  push({
    id: 'root',
    ok: true,
    message: `Data root: ${root}`,
  });

  const dbFile = anypickDbPath(root);
  const dbExists = await pathExists(dbFile);
  push({
    id: 'sqlite',
    ok: dbExists,
    message: dbExists ? `SQLite: ${dbFile}` : `SQLite missing (expected ${dbFile})`,
  });

  for (const p of deps.accounts.listProviders()) {
    try {
      const live = await p.detectLive();
      push({
        id: `auth:${p.id}`,
        ok: true,
        message: `${p.id}: ${live.present ? 'live auth present' : 'no live auth'}`,
        detail: live.identity,
      });
    } catch (err) {
      push({
        id: `auth:${p.id}`,
        ok: false,
        message: `${p.id}: detectLive failed`,
        detail: err instanceof Error ? err.message : String(err),
        forbidden: 'modify_native_auth',
        suggestions: [
          `anypick current ${deps.clients.has(p.id) ? p.id : ''}`.trim(),
          `anypick add account ${p.id} --current --name <name>`,
        ],
      });
    }
  }

  push({
    id: 'catalog',
    ok: deps.catalog.list().length > 0,
    message: `Catalog providers: ${deps.catalog.ids().join(', ') || '(none)'}`,
  });

  const profiles = await deps.profiles.list();
  push({
    id: 'profiles',
    ok: true,
    message: `Gateways (profiles): ${profiles.length}`,
    detail: profiles.map((p) => p.meta.name).join(', ') || undefined,
  });

  for (const profile of profiles) {
    if (!deps.catalog.has(profile.meta.provider)) {
      push({
        id: `profile:${profile.meta.name}:provider`,
        ok: false,
        message: `Gateway "${profile.meta.name}" references unknown provider "${profile.meta.provider}"`,
        forbidden: 'change_gateway_endpoint',
        suggestions: [
          `anypick edit gateway/${profile.meta.name}`,
          `anypick remove @preset or anypick list gateways`,
        ],
      });
    }
    if (!profile.secrets.apiKey) {
      push({
        id: `profile:${profile.meta.name}:key`,
        ok: true,
        message: `Gateway "${profile.meta.name}" has no API key (ok if proxy ignores it)`,
      });
    }
  }

  for (const c of deps.clients.list()) {
    try {
      const inspect = await c.inspect();
      const state = await deps.runtime.which(c.id);
      const binding = deps.bindings?.getGlobal(c.id);
      push({
        id: `client:${c.id}`,
        ok: true,
        message: binding
          ? `${c.id}: binding ${displayRef(binding.spec.source)}`
          : `${c.id}: mode=${state?.mode ?? 'none'}${state?.profileName ? ` profile=${state.profileName}` : ''}`,
        detail: inspect.summary,
      });
      if (inspect.issues?.length) {
        for (const issue of inspect.issues) {
          push({
            id: `client:${c.id}:issue`,
            ok: false,
            message: `${c.id}: ${issue}`,
            forbidden: 'modify_unmanaged_client_config',
            suggestions: [`anypick current ${c.id} --verbose`, `anypick reset ${c.id}`],
          });
        }
      }
    } catch (err) {
      push({
        id: `client:${c.id}`,
        ok: false,
        message: `${c.id}: inspect failed`,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await scanProxyPids(root, deps, push);
  await scanStaleLocks(root, push);

  if (deps.journal) {
    const incomplete = deps.journal.listIncomplete();
    for (const entry of incomplete) {
      push({
        id: `journal:${entry.id}`,
        ok: false,
        message: `Incomplete operation journal: ${entry.type} (${entry.state})`,
        detail: entry.affectedResources.join(', '),
        fixable: 'complete_journal_rollback',
      });
    }
  }

  if (deps.bindings) {
    for (const pb of deps.bindings.listAllProjects()) {
      const src = pb.spec.source;
      if (src.kind === 'gateway') {
        const names = new Set((await deps.profiles.list()).map((p) => p.meta.name));
        if (!names.has(src.name)) {
          push({
            id: `project-binding:${pb.projectRoot}:${pb.client}`,
            ok: false,
            message: `Project binding ${pb.client} → gateway/${src.name} references missing gateway`,
            forbidden: 'mutate_binding',
            suggestions: [
              `anypick unlink ${pb.client}`,
              `anypick link ${pb.client} --with <source>`,
            ],
          });
        }
      } else if (src.kind === 'account') {
        const acc = await deps.accounts.get(src.provider, src.name);
        if (!acc) {
          push({
            id: `project-binding:${pb.projectRoot}:${pb.client}`,
            ok: false,
            message: `Project binding ${pb.client} → ${src.provider}/${src.name} references missing account`,
            forbidden: 'mutate_binding',
            suggestions: [
              `anypick unlink ${pb.client}`,
              `anypick add account ${src.provider} --current --name ${src.name}`,
            ],
          });
        }
      }
    }
  }

  if (deps.plugins) {
    const { loadedNames, failures } = deps.plugins;
    const records = deps.plugins.installed();
    const enabled = records.filter((r) => r.enabled);
    push({
      id: 'plugins',
      ok: true,
      message: `Plugins: ${loadedNames.length} loaded, ${records.length - enabled.length} disabled`,
      detail: loadedNames.length > 0 ? loadedNames.join(', ') : undefined,
    });
    for (const f of failures) {
      push({
        id: `plugin:${f.name}`,
        ok: false,
        message: f.untrusted
          ? `Plugin ${f.name} was refused: its code changed since you trusted it`
          : `Plugin ${f.name} failed to load`,
        detail: f.reason,
        suggestions: f.untrusted
          ? [`anypick plugin trust ${f.name}`, `anypick plugin remove ${f.name}`]
          : [`anypick plugin disable ${f.name}`],
      });
    }
  }

  await scanTempOverlays(push);
  await scanPermissions(root, push);

  try {
    await mkdir(root, { recursive: true });
    push({
      id: 'writable',
      ok: await pathExists(root),
      message: 'Data root is writable',
    });
  } catch (err) {
    push({
      id: 'writable',
      ok: false,
      message: 'Data root is not writable',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    ok: checks.every((c) => c.ok),
    root,
    checks,
  };
}
