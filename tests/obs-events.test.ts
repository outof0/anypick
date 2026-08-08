import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppReady } from '../src/core/app';
import { OperationJournal } from '../src/core/journal';
import { recoverIncompleteOperations } from '../src/core/activation-executor';
import { makeEmitter, type AnyPickEventSink } from '../src/core/events';

// OBS-01: observable degraded state & lifecycle.
// Degraded conditions (startup recovery failure, lease reap failure, recovery
// refusal) are emitted as structured, sanitized events through an injectable
// sink. Library consumers receive ordered, redacted events; secret material is
// never placed into an event.

class CollectingSink implements AnyPickEventSink {
  readonly events: Array<{
    code: string;
    severity: string;
    opId?: string;
    context?: Record<string, unknown>;
  }> = [];
  emit(e: {
    code: string;
    severity: string;
    opId?: string;
    context?: Record<string, unknown>;
  }): void {
    this.events.push({ code: e.code, severity: e.severity, opId: e.opId, context: e.context });
  }
}

describe('OBS-01 structured events', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-obs-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('delivers recovery refusal to an injected sink', async () => {
    const sink = new CollectingSink();
    const app = await createAppReady({ root, skipMigrate: true, events: sink });
    // Seed an incomplete journal entry whose source cannot be re-resolved exactly.
    // Recovery must refuse forward execution and surface it as a structured event
    // rather than swallowing it.
    const journal = new OperationJournal(app.db);
    const op = journal.create('acc', {
      params: { source: 'account/unresolvable/does-not-exist' },
      affectedResources: ['account/unresolvable/does-not-exist'],
      backupPaths: [],
    });

    await recoverIncompleteOperations({ journal, events: sink });

    const codes = sink.events.map((e) => e.code);
    expect(codes).toContain('recovery_refused');
    const refused = sink.events.find((e) => e.code === 'recovery_refused');
    expect(refused?.opId).toBe(op.id);
  });

  it('sanitizes secret material out of event context', () => {
    const sink = new CollectingSink();
    const emit = makeEmitter(sink);
    emit('warn', 'lease_mismatch', 'proxy lease did not match running instance', {
      context: {
        provider: 'grok',
        token: 'super-secret-token-value-here-1234567890',
        endpoint: 'http://127.0.0.1:4120',
        account: 'work',
      },
    });
    const ev = sink.events[0];
    expect(ev?.code).toBe('lease_mismatch');
    // Sensitive key redacted.
    expect(ev?.context?.token).toBe('<redacted>');
    // Non-sensitive context preserved.
    expect(ev?.context?.provider).toBe('grok');
    expect(ev?.context?.endpoint).toBe('http://127.0.0.1:4120');
    expect(ev?.context?.account).toBe('work');
  });

  it('rejects a value that looks like a long bearer/token even under an unknown key', () => {
    const sink = new CollectingSink();
    const emit = makeEmitter(sink);
    emit('error', 'auth_file', 'could not read auth file', {
      context: { note: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789verylong' },
    });
    expect(sink.events[0]?.context?.note).toBe('<redacted>');
  });

  it('emits no events to a null sink (library can opt out)', () => {
    const sink = new CollectingSink();
    const emit = makeEmitter(undefined);
    emit('warn', 'x', 'should not be delivered');
    expect(sink.events).toHaveLength(0);
  });
});
