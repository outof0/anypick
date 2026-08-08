import { DOCTOR_FIX_ALLOWLIST } from './doctor-types';
import { getAnyPickRoot } from './paths';
import { runDoctorReport } from './doctor-report';
import { executeDoctorFix } from './doctor-fixes';
import type {
  DoctorFixPlan,
  DoctorFixResult,
  DoctorServiceDeps,
  DoctorReport,
} from './doctor-types';

export {
  DOCTOR_FIX_ALLOWLIST,
  DOCTOR_FIX_FORBIDDEN,
  type DoctorCheck,
  type DoctorFixAction,
  type DoctorFixActionKind,
  type DoctorFixPlan,
  type DoctorFixResult,
  type DoctorForbiddenKind,
  type DoctorReport,
  type DoctorServiceDeps,
} from './doctor-types';
export { enrichFixPlan, formatForbiddenManual } from './doctor-format';

export class DoctorService {
  constructor(private readonly deps: DoctorServiceDeps) {}

  run(target?: string): Promise<DoctorReport> {
    return runDoctorReport(this.deps, target);
  }

  async planFixes(target?: string): Promise<DoctorFixPlan> {
    const report = await this.run(target);
    const actions: DoctorFixPlan['actions'] = [];
    const manual: DoctorFixPlan['manual'] = [];
    const seen = new Set<string>();

    for (const c of report.checks) {
      if (c.ok) {
        continue;
      }
      if (c.forbidden) {
        manual.push({
          id: c.id,
          kind: c.forbidden,
          message: c.message,
          suggestions: c.suggestions ?? [],
        });
        continue;
      }
      if (!c.fixable) {
        continue;
      }
      if (!DOCTOR_FIX_ALLOWLIST.includes(c.fixable)) {
        continue;
      }

      const actionId = `${c.fixable}:${c.id}`;
      if (seen.has(actionId)) {
        continue;
      }
      seen.add(actionId);

      const params: Record<string, unknown> = { checkId: c.id };
      if (c.fixable === 'stop_orphan_proxy') {
        const m = c.id.match(/^orphan-proxy:([^/]+)\/(.+)$/);
        if (m) {
          params.provider = m[1];
          params.account = m[2];
        }
      }

      actions.push({
        id: actionId,
        kind: c.fixable,
        description: c.message,
        target: c.detail ?? c.id,
        params,
      });
    }

    if (
      report.checks.some((c) => c.id === 'permissions' && !c.ok) &&
      !actions.some((a) => a.kind === 'repair_permissions')
    ) {
      actions.push({
        id: 'repair_permissions:root',
        kind: 'repair_permissions',
        description: 'Repair permissions on AnyPick-owned files',
        target: report.root,
      });
    }

    return { actions, manual };
  }

  async applyFixes(
    plan: DoctorFixPlan,
    opts: { dryRun?: boolean; yes?: boolean } = {},
  ): Promise<DoctorFixResult> {
    const dryRun = Boolean(opts.dryRun);
    const applied: DoctorFixResult['applied'] = [];
    const root = getAnyPickRoot(this.deps.root);

    for (const action of plan.actions) {
      if (!DOCTOR_FIX_ALLOWLIST.includes(action.kind)) {
        applied.push({
          id: action.id,
          ok: false,
          message: `Refused non-allowlisted fix kind: ${action.kind}`,
        });
      }
    }
    const safeActions = plan.actions.filter((a) => DOCTOR_FIX_ALLOWLIST.includes(a.kind));

    let journalId: string | undefined;
    if (!dryRun && this.deps.journal && safeActions.length > 0) {
      const entry = this.deps.journal.create('doctor:fix', {
        affectedResources: safeActions.map((a) => a.target),
        params: {
          actions: safeActions.map((a) => ({
            id: a.id,
            kind: a.kind,
            target: a.target,
          })),
        },
        state: 'executing',
      });
      journalId = entry.id;
    }

    try {
      for (const action of safeActions) {
        if (dryRun) {
          applied.push({
            id: action.id,
            ok: true,
            message: `[dry-run] would ${action.kind}: ${action.description}`,
          });
          continue;
        }

        try {
          const msg = await executeDoctorFix(action, root, this.deps);
          applied.push({ id: action.id, ok: true, message: msg });
        } catch (err) {
          applied.push({
            id: action.id,
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (journalId && this.deps.journal) {
        const allOk = applied.every((a) => a.ok);
        this.deps.journal.update(journalId, {
          state: allOk ? 'committed' : 'failed',
        });
      }
    } catch (err) {
      if (journalId && this.deps.journal) {
        this.deps.journal.update(journalId, { state: 'failed' });
      }
      throw err;
    }

    return { plan, applied, dryRun, journalId };
  }
}
