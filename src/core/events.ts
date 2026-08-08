/**
 * Structured event sink for degraded / lifecycle conditions (spec OBS-01).
 *
 * AnyPick surfaces partial failures — startup recovery refusal, lease mismatch,
 * proxy realignment failure, unverified processes, cleanup failure — as typed
 * events rather than swallowing them or leaking them into stderr with secrets.
 * Library consumers can supply their own sink (e.g. to feed a TUI status bar);
 * when none is supplied, events are recorded in an in-memory ring that `doctor`
 * / `status` can read, and (optionally) echoed to stderr behind ANYPICK_DEBUG.
 *
 * All event context is sanitized at the boundary: secret material (keys,
 * tokens, auth files, full headers, complete imported payloads) is never placed
 * into an event.
 */

export type AnyPickEventSeverity = 'info' | 'warn' | 'error';

export interface AnyPickEvent {
  /** Correlation id (e.g. a journal operation id) when available. */
  opId?: string;
  /** Resource ids touched by the condition (scoped, not secret). */
  resourceIds?: string[];
  /** Lifecycle step the event corresponds to, when relevant. */
  step?: string;
  severity: AnyPickEventSeverity;
  /** Stable machine-readable code (no spaces). */
  code: string;
  /** Human-readable message; must not contain secrets. */
  message: string;
  /** Sanitized context (no keys/tokens/paths-to-credentials). */
  context?: Record<string, unknown>;
  /** ISO timestamp. */
  timestamp: string;
}

export interface AnyPickEventSink {
  emit(event: AnyPickEvent): void;
}

/**
 * Redact obviously-sensitive keys from a context object. Returns a shallow copy
 * with known-secret fields replaced by a constant placeholder. Values that are
 * themselves objects are not traversed (context is meant to be flat and small).
 */
const SENSITIVE_KEYS = new Set([
  'key',
  'keys',
  'token',
  'tokens',
  'secret',
  'secrets',
  'password',
  'apiKey',
  'api_key',
  'authorization',
  'auth',
  'accessToken',
  'refreshToken',
  'bearer',
]);

export function sanitizeContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!context) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(context)) {
    if (SENSITIVE_KEYS.has(k)) {
      out[k] = '<redacted>';
      continue;
    }
    // Redact any value that looks like a long bearer/token string.
    if (typeof v === 'string' && v.length > 24 && /[\w-]{24,}/.test(v)) {
      out[k] = '<redacted>';
      continue;
    }
    out[k] = v;
  }
  return out;
}

export interface EmitOptions {
  opId?: string;
  resourceIds?: string[];
  step?: string;
  context?: Record<string, unknown>;
}

/** Build a sanitized event and hand it to the sink. */
export function makeEmitter(sink: AnyPickEventSink | undefined) {
  return function emit(
    severity: AnyPickEventSeverity,
    code: string,
    message: string,
    opts: EmitOptions = {},
  ): void {
    if (!sink) {
      return;
    }
    sink.emit({
      opId: opts.opId,
      resourceIds: opts.resourceIds,
      step: opts.step,
      severity,
      code,
      message,
      context: sanitizeContext(opts.context),
      timestamp: new Date().toISOString(),
    });
  };
}

/** In-memory ring buffer used when no external sink is supplied. */
export class InMemoryEventSink implements AnyPickEventSink {
  private readonly events: AnyPickEvent[] = [];
  private readonly max: number;

  constructor(max = 200) {
    this.max = max;
  }

  emit(event: AnyPickEvent): void {
    this.events.push(event);
    if (this.events.length > this.max) {
      this.events.shift();
    }
  }

  list(): readonly AnyPickEvent[] {
    return this.events;
  }

  clear(): void {
    this.events.length = 0;
  }
}

/** Sink that echoes to stderr (only when ANYPICK_DEBUG is set). */
export class DebugStderrEventSink implements AnyPickEventSink {
  emit(event: AnyPickEvent): void {
    if (process.env.ANYPICK_DEBUG !== '1' && process.env.ANYPICK_DEBUG !== 'true') {
      return;
    }
    const loc = [event.code, event.opId, ...(event.resourceIds ?? [])].filter(Boolean).join(' ');
    process.stderr.write(`[anypick:event:${event.severity}] ${loc}: ${event.message}\n`);
  }
}
