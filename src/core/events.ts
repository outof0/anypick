/**
 * Structured event sink for degraded / lifecycle conditions (spec OBS-01).
 *
 * Hotplug surfaces partial failures — startup recovery refusal, lease mismatch,
 * proxy realignment failure, unverified processes, cleanup failure — as typed
 * events rather than swallowing them or leaking them into stderr with secrets.
 * Library consumers can supply their own sink (e.g. to feed a TUI status bar);
 * when none is supplied, events are recorded in an in-memory ring that `doctor`
 * / `status` can read, and (optionally) echoed to stderr behind HOTPLUG_DEBUG.
 *
 * All event context is sanitized at the boundary: secret material (keys,
 * tokens, auth files, full headers, complete imported payloads) is never placed
 * into an event.
 */

export type HotplugEventSeverity = 'info' | 'warn' | 'error';

export interface HotplugEvent {
  /** Correlation id (e.g. a journal operation id) when available. */
  opId?: string;
  /** Resource ids touched by the condition (scoped, not secret). */
  resourceIds?: string[];
  /** Lifecycle step the event corresponds to, when relevant. */
  step?: string;
  severity: HotplugEventSeverity;
  /** Stable machine-readable code (no spaces). */
  code: string;
  /** Human-readable message; must not contain secrets. */
  message: string;
  /** Sanitized context (no keys/tokens/paths-to-credentials). */
  context?: Record<string, unknown>;
  /** ISO timestamp. */
  timestamp: string;
}

export interface HotplugEventSink {
  emit(event: HotplugEvent): void;
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
export function makeEmitter(sink: HotplugEventSink | undefined) {
  return function emit(
    severity: HotplugEventSeverity,
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
export class InMemoryEventSink implements HotplugEventSink {
  private readonly events: HotplugEvent[] = [];
  private readonly max: number;

  constructor(max = 200) {
    this.max = max;
  }

  emit(event: HotplugEvent): void {
    this.events.push(event);
    if (this.events.length > this.max) {
      this.events.shift();
    }
  }

  list(): readonly HotplugEvent[] {
    return this.events;
  }

  clear(): void {
    this.events.length = 0;
  }
}

/** Sink that echoes to stderr (only when HOTPLUG_DEBUG is set). */
export class DebugStderrEventSink implements HotplugEventSink {
  emit(event: HotplugEvent): void {
    if (process.env.HOTPLUG_DEBUG !== '1' && process.env.HOTPLUG_DEBUG !== 'true') {
      return;
    }
    const loc = [event.code, event.opId, ...(event.resourceIds ?? [])].filter(Boolean).join(' ');
    process.stderr.write(`[hotplug:event:${event.severity}] ${loc}: ${event.message}\n`);
  }
}
