import type { DoctorFixPlan } from './doctor-types';

/**
 * Format forbidden findings for human output (spec §18.5 example).
 */
export function formatForbiddenManual(item: DoctorFixPlan['manual'][number]): string {
  const lines = [item.message, '', 'Doctor will not perform this change automatically.', ''];
  if (item.suggestions.length) {
    lines.push('Review / fix manually:');
    for (const s of item.suggestions) {
      lines.push(`  ${s}`);
    }
  }
  return lines.join('\n');
}

/**
 * Re-plan orphan proxy actions with provider/account params from check ids.
 */
export function enrichFixPlan(plan: DoctorFixPlan): DoctorFixPlan {
  return {
    ...plan,
    actions: plan.actions.map((a) => {
      if (a.kind === 'stop_orphan_proxy') {
        // id: stop_orphan_proxy:orphan-proxy:provider/account
        const m = a.id.match(/orphan-proxy:([^/]+)\/(.+)$/);
        if (m) {
          return {
            ...a,
            params: { ...a.params, provider: m[1], account: m[2] },
          };
        }
      }
      if (a.kind === 'delete_stale_pid' && a.target.endsWith('proxy.pid')) {
        return a;
      }
      if (
        a.kind === 'delete_temp_overlay' ||
        a.kind === 'delete_stale_lock' ||
        a.kind === 'delete_stale_pid'
      ) {
        // ensure target is the detail path when available
        return a;
      }
      return a;
    }),
  };
}
