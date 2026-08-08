/**
 * Pure helpers shared across TUI screens.
 * No React state / effect logic lives here — these are testable utilities.
 */
import type { AnyPickApp } from '../core/app';
import type { AppBindingRow, ProxyRow, AnyPickHomeRow } from './model';
import { proxyBindingRef } from './model';
import { modelRolesFromClientOptions } from '../clients/model-roles';

export function clampIndex(i: number, len: number): number {
  if (len <= 0) {
    return 0;
  }
  return ((i % len) + len) % len;
}

export function proxyRef(row: ProxyRow): string {
  return proxyBindingRef(row);
}

/** Flip one client's checkbox on an app picker. */
export function toggleChecked(checked: readonly string[], clientId: string): string[] {
  const next = new Set(checked);
  if (!next.delete(clientId)) {
    next.add(clientId);
  }
  return [...next];
}

export function modelSummariesForApps(
  app: AnyPickApp,
  proxyRefStr: string,
  apps: AppBindingRow[],
): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const a of apps) {
      if (!a.bound || a.sourceDisplay !== proxyRefStr) {
        continue;
      }
      const cur = app.bindingService.current(a.clientId)[0];
      const roles = modelRolesFromClientOptions(cur?.binding?.spec.clientOptions);
      if (!roles || !Object.keys(roles).length) {
        continue;
      }
      // Prefer short default + count
      if (roles.default) {
        const extra = Object.keys(roles).length - 1;
        out[a.clientId] = extra > 0 ? `${roles.default} +${extra}` : roles.default;
      } else {
        out[a.clientId] = Object.entries(roles)
          .slice(0, 2)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ');
      }
    }
  } catch {
    // ignore
  }
  return out;
}

export function indexOfRef(rows: AnyPickHomeRow[], focusRef?: string): number {
  if (!focusRef) {
    return 0;
  }
  const i = rows.findIndex((r) => r.ref === focusRef);
  return i >= 0 ? i : 0;
}

export function indexOfProxy(rows: ProxyRow[], focusRef?: string): number {
  if (!focusRef) {
    return 0;
  }
  const i = rows.findIndex(
    (r) => proxyBindingRef(r) === focusRef || `${r.providerId}/${r.name}` === focusRef,
  );
  return i >= 0 ? i : 0;
}
