import type { AnyPickApp } from '../../core/app';

/**
 * Short UI label for an app/client.
 *
 * Prefer the adapter's `shortName` / `name` via `fallback`. Never hardcode
 * built-in client ids — third-party clients would otherwise show raw slugs
 * only when the switch misses them.
 */
export function shortAppName(clientId: string, fallback?: string): string {
  return fallback ?? clientId;
}

/**
 * Short UI label for a tool/provider.
 *
 * Callers pass the provider's own `shortName ?? name` as `fallback`, so a
 * registered provider supplies its own label. The switch that used to live here
 * hardcoded the built-in ids and left third-party providers showing raw slugs.
 */
export function shortToolName(providerId: string, fallback?: string): string {
  return fallback ?? providerId;
}

/**
 * A provider's display name, falling back to its id.
 *
 * Screens reached from a stale binding or a removed plugin may name a provider
 * the registry no longer has, and a label is never worth throwing over.
 */
export function providerDisplayName(app: AnyPickApp, providerId?: string): string {
  if (!providerId) {
    return '';
  }
  try {
    return app.accounts.provider(providerId).name;
  } catch {
    return providerId;
  }
}

/**
 * Apps that can use this proxy source (transport allows managed/external proxy).
 */
