/**
 * Core-side model-role extraction shared by core services (realign, runtime).
 *
 * Kept in core so `core` does not take value imports from the clients package.
 * Client-only role helpers remain in `src/clients/model-roles.ts`.
 */

/** Extract modelRoles from binding clientOptions (best-effort). */
export function modelRolesFromClientOptions(
  clientOptions: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!clientOptions || typeof clientOptions !== 'object') {
    return undefined;
  }
  const raw = clientOptions.modelRoles;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim()) {
      out[k] = v.trim();
    }
  }
  return Object.keys(out).length ? out : undefined;
}
