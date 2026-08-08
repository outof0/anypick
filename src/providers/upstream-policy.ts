export type UpstreamFailureKind = 'rate_limit' | 'auth' | 'transient' | 'server' | 'permanent';
export type LimitScope = 'ip' | 'credential' | 'model' | 'unknown';

export interface ClassifiedFailure {
  kind: UpstreamFailureKind;
  status?: number;
  scope: LimitScope;
  retryAfterMs?: number;
  message?: string;
}

/**
 * Billing exhaustion is credential-scoped, unlike an IP/model rate limit.
 * Keep this deliberately narrow: a generic 403 can be a model entitlement or
 * policy rejection and must not silently disable an otherwise healthy account.
 */
export function isInsufficientBalanceFailure(status: number, bodyPreview = ''): boolean {
  if (status !== 402 && status !== 403) {
    return false;
  }
  const text = bodyPreview.slice(0, 2000).toLowerCase();
  return (
    /insufficient[_\s-]*(?:account[_\s-]*)?balance/.test(text) ||
    /account[_\s-]*balance[^.]{0,80}insufficient/.test(text) ||
    /balance[^.]{0,80}(?:depleted|exhausted)/.test(text)
  );
}

/**
 * A 429 is normally shared by an IP, endpoint, or model. This deliberately
 * returns true only for vendor responses that explicitly attribute exhaustion
 * to an API key, project, account, billing balance, or quota allocation.
 * Generic 429s must remain on the current account.
 */
export function isCredentialQuotaFailure(
  status: number,
  headers: Headers,
  bodyPreview = '',
): boolean {
  if (status !== 429 && !isInsufficientBalanceFailure(status, bodyPreview)) {
    return false;
  }
  const text =
    `${headers.get('x-goog-api-client') ?? ''} ${bodyPreview.slice(0, 2000)}`.toLowerCase();
  if (/freeusagelimit|free usage|\bip(?: address)?\b|per[-\s]?minute|rate limit/.test(text)) {
    return false;
  }
  return (
    /resource[_\s-]*exhausted/.test(text) ||
    /(?:api[_\s-]*key|credential|project|account|billing)[^.]{0,100}(?:quota|balance|exhausted|limit)/.test(
      text,
    ) ||
    /(?:quota|balance)[^.]{0,100}(?:exhausted|depleted|exceeded|insufficient)/.test(text)
  );
}

export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) {
    return undefined;
  }
  const raw = value.trim();
  if (/^[+-]?\d+(?:\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds * 1000) : undefined;
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date) && date >= now) {
    return date - now;
  }
  return undefined;
}

export function classifyUpstreamFailure(
  status: number,
  headers: Headers,
  bodyPreview = '',
  now = Date.now(),
): ClassifiedFailure {
  const text = bodyPreview.slice(0, 2000);
  if (status === 429) {
    const lower = text.toLowerCase();
    const scope: LimitScope = /freeusagelimit|free usage|\bip\b/.test(lower) ? 'ip' : 'unknown';
    return {
      kind: 'rate_limit',
      status,
      scope,
      retryAfterMs: parseRetryAfter(headers.get('retry-after'), now),
      message: text || undefined,
    };
  }
  if (status === 401 || status === 403) {
    return { kind: 'auth', status, scope: 'credential', message: text || undefined };
  }
  if (status === 408 || status === 502 || status === 503 || status === 504) {
    return { kind: 'transient', status, scope: 'unknown', message: text || undefined };
  }
  if (status >= 500) {
    return { kind: 'server', status, scope: 'unknown', message: text || undefined };
  }
  return { kind: 'permanent', status, scope: 'unknown', message: text || undefined };
}

export class CooldownRegistry {
  private readonly deadlines = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}
  set(key: string, delayMs: number): void {
    if (delayMs > 0) {
      this.deadlines.set(key, this.now() + delayMs);
    }
  }
  remainingMs(key: string): number {
    const deadline = this.deadlines.get(key);
    if (deadline === undefined) {
      return 0;
    }
    const remaining = deadline - this.now();
    if (remaining <= 0) {
      this.deadlines.delete(key);
      return 0;
    }
    return remaining;
  }
  get size(): number {
    return this.deadlines.size;
  }
}
