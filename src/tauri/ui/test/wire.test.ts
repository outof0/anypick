import { describe, expect, it } from 'vitest';

import {
  decodeFrame,
  describeResult,
  encodeBase64Utf8,
  encodeCommand,
  frameIsFor,
  invokeCommand,
  logsCommand,
  MESSAGE_VERSION,
  PROTOCOL_VERSION,
  modelRolesCommand,
  mutateCommand,
  partiallyMutated,
  newRequestId,
} from '../lib/wire';
import { snapshotFixture } from './fixture';

function frame(kind: string, payload: unknown): string {
  return `${kind}\t${encodeBase64Utf8(JSON.stringify(payload))}`;
}

/**
 * Decode a command the way the engine does: base64, then UTF-8.
 *
 * `atob` alone yields latin1, so a helper that stops there reports mojibake for
 * perfectly good UTF-8 and the real encoder gets blamed for it.
 */
function decodePayload(line: string): Record<string, unknown> {
  const tab = line.indexOf('\t');
  const binary = atob(line.slice(tab + 1));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

describe('frame decoding', () => {
  it('decodes the bare snapshot the engine sends first', () => {
    const decoded = decodeFrame(frame('snapshot', snapshotFixture()));
    expect(decoded?.kind).toBe('snapshot');
    if (decoded?.kind === 'snapshot') {
      expect(decoded.snapshot.revision).toBe(7);
      expect(decoded.snapshot.accounts).toHaveLength(2);
    }
  });

  it('decodes a snapshot event and keeps its reason', () => {
    const decoded = decodeFrame(
      frame('snapshot-event', {
        protocolVersion: 2,
        revision: 8,
        reason: 'state-changed',
        snapshot: snapshotFixture({ revision: 8 }),
      }),
    );
    expect(decoded?.kind).toBe('snapshot-event');
    if (decoded?.kind === 'snapshot-event') {
      expect(decoded.revision).toBe(8);
      expect(decoded.reason).toBe('state-changed');
    }
  });

  it('ignores a frame whose protocolVersion does not match', () => {
    expect(
      decodeFrame(
        frame('snapshot-event', {
          protocolVersion: PROTOCOL_VERSION + 1,
          revision: 8,
          reason: 'state-changed',
          snapshot: snapshotFixture({ revision: 8 }),
        }),
      ),
    ).toBeNull();
  });

  it('still decodes a frame whose protocolVersion matches', () => {
    const decoded = decodeFrame(
      frame('result', {
        protocolVersion: PROTOCOL_VERSION,
        version: 1,
        requestId: 'a',
        status: 'success',
        message: 'ok',
      }),
    );
    expect(decoded?.kind).toBe('result');
  });

  it('ignores a frame kind it does not act on', () => {
    // The engine is free to add frames. Dropping one is correct; rendering it
    // as an empty state is not.
    expect(decodeFrame(frame('something-new', { a: 1 }))).toBeNull();
    expect(decodeFrame(frame('hello', { protocolVersion: 2 }))).toBeNull();
  });

  it('returns null for a corrupt frame rather than throwing', () => {
    expect(decodeFrame('snapshot\tnot-base64!!')).toBeNull();
    expect(decodeFrame('snapshot\t')).toBeNull();
    expect(decodeFrame('nonsense')).toBeNull();
    expect(decodeFrame('')).toBeNull();
  });

  it('rejects a snapshot with no revision', () => {
    // A state frame without a revision cannot be ordered, so accepting it
    // would let a stale frame overwrite a newer one.
    expect(decodeFrame(frame('snapshot', { accounts: [] }))).toBeNull();
  });

  it('decodes a result with its code and suggestions', () => {
    const decoded = decodeFrame(
      frame('result', {
        version: 1,
        requestId: 'mutate-x-1',
        status: 'error',
        message: 'account not found',
        code: 'ACCOUNT_NOT_FOUND',
        suggestions: [{ text: 'Refresh your accounts list' }],
      }),
    );
    if (decoded?.kind !== 'result') throw new Error('expected a result frame');
    expect(decoded.result.status).toBe('error');
    expect(decoded.result.code).toBe('ACCOUNT_NOT_FOUND');
    expect(decoded.result.suggestions?.[0]?.text).toBe('Refresh your accounts list');
  });

  it('treats a cancelled result as a decision, not a failure', () => {
    // The engine clears code/suggestions/mutated on cancel. The status has to
    // be read before the code or a user gets an error for their own cancel.
    const decoded = decodeFrame(
      frame('result', { version: 1, requestId: 'login-1', status: 'cancelled', message: 'Sign-in cancelled.' }),
    );
    if (decoded?.kind !== 'result') throw new Error('expected a result frame');
    expect(decoded.result.status).toBe('cancelled');
    expect(decoded.result.code).toBeUndefined();
    expect(describeResult(decoded.result)).toBe('Sign-in cancelled.');
  });

  it('says so when a failed mutation still changed state', () => {
    const decoded = decodeFrame(
      frame('result', {
        version: 1,
        requestId: 'mutate-y-1',
        status: 'error',
        message: 'could not stop 1 of 2 proxies',
        mutated: true,
      }),
    );
    if (decoded?.kind !== 'result') throw new Error('expected a result frame');
    expect(partiallyMutated(decoded.result)).toBe(true);
    expect(describeResult(decoded.result)).toContain('partially changed');
  });

  it('decodes a backup preview with its staged entries', () => {
    const decoded = decodeFrame(
      frame('backup-preview', {
        version: 1,
        requestId: 'inspect-1',
        status: 'ready',
        inspectionId: 'insp-9',
        createdAt: '2026-09-30T10:00:00Z',
        entries: [{ id: '0', providerId: 'claude', name: 'work', label: 'Work', disposition: 'create', reason: '' }],
      }),
    );
    if (decoded?.kind !== 'backup-preview') throw new Error('expected a backup-preview frame');
    expect(decoded.preview.inspectionId).toBe('insp-9');
    expect(decoded.preview.entries[0]?.disposition).toBe('create');
  });

  it('decodes the installation check status sent by the engine', () => {
    const decoded = decodeFrame(
      frame('doctor', {
        version: 1,
        requestId: 'check-1',
        status: 'degraded',
        findings: [
          { check: 'permissions', status: 'warn', detail: 'One file needs safer permissions.' },
          { check: 'database', status: 'ok', detail: '' },
        ],
      }),
    );
    if (decoded?.kind !== 'doctor') throw new Error('expected a doctor frame');
    expect(decoded.report.requestId).toBe('check-1');
    expect(decoded.report.status).toBe('degraded');
    expect(decoded.report.findings).toHaveLength(2);
  });
});

describe('frame matching', () => {
  it('matches a terminal frame to the request that caused it', () => {
    const result = decodeFrame(frame('result', { version: 1, requestId: 'a', status: 'success', message: 'ok' }));
    const other = decodeFrame(frame('result', { version: 1, requestId: 'b', status: 'success', message: 'ok' }));
    expect(frameIsFor(result!, 'a')).toBe(true);
    expect(frameIsFor(result!, 'b')).toBe(false);
    expect(frameIsFor(other!, 'a')).toBe(false);
  });

  it('does not claim a snapshot for any request', () => {
    const snapshot = decodeFrame(frame('snapshot', snapshotFixture()));
    expect(frameIsFor(snapshot!, 'anything')).toBe(false);
  });
});

describe('command encoding', () => {
  it('sends the revision the action id came from', () => {
    // Action ids are revision-scoped and expire: sending a stale revision gets
    // STALE_ACTION with nothing useful to show the user.
    const line = invokeCommand('act-7-201', 7, 'invoke-1');
    expect(decodePayload(line)).toEqual({
      version: MESSAGE_VERSION,
      requestId: 'invoke-1',
      revision: 7,
      actionId: 'act-7-201',
    });
  });

  it('omits allowForeignConfig unless consent was given', () => {
    // The engine rejects a non-boolean value outright, so the key is either
    // absent or the boolean true.
    expect(decodePayload(invokeCommand('act-1', 1, 'r1'))).not.toHaveProperty('allowForeignConfig');
    expect(decodePayload(invokeCommand('act-1', 1, 'r2', true))).toEqual({
      version: MESSAGE_VERSION,
      requestId: 'r2',
      revision: 1,
      actionId: 'act-1',
      allowForeignConfig: true,
    });
  });

  it('sends only the keys a mutation documents', () => {
    // protocol_validate.go rejects any unlisted key with a MALFORMED_FRAME that
    // names nothing useful, so extras are never spread in blindly.
    const line = mutateCommand('hub-source-toggle', { providerId: 'claude', sourceId: 'work', enabled: true }, 'm1');
    expect(decodePayload(line)).toEqual({
      version: 1,
      requestId: 'm1',
      operation: 'hub-source-toggle',
      providerId: 'claude',
      sourceId: 'work',
      enabled: true,
    });
  });

  it('marks a setting mutation as enabled, not as a string', () => {
    expect(decodePayload(mutateCommand('setting-show-quota', { enabled: false }, 'm2'))).toEqual({
      version: MESSAGE_VERSION,
      requestId: 'm2',
      operation: 'setting-show-quota',
      enabled: false,
    });
  });

  it('sends model roles as action ids, keyed by role', () => {
    // The engine resolves an action id, never a model id, and a non-empty map
    // without a default is INVALID_SELECTION.
    const line = modelRolesCommand('claude', { default: 'act-7-101', sonnet: 'act-7-102' }, 7, 'mr-1');
    expect(decodePayload(line)).toEqual({
      version: MESSAGE_VERSION,
      requestId: 'mr-1',
      clientId: 'claude',
      roleActionIds: { default: 'act-7-101', sonnet: 'act-7-102' },
      revision: 7,
    });
  });

  it('bounds a log request to the lines the engine accepts', () => {
    // protocol_strict_test.go rejects lines: 201 and accepts 200.
    expect(decodePayload(logsCommand('claude', 'work', 200, 'lg-1'))).toEqual({
      version: MESSAGE_VERSION,
      requestId: 'lg-1',
      providerId: 'claude',
      name: 'work',
      lines: 200,
    });
  });

  it('encodes a bare command with no payload', () => {
    expect(encodeCommand('refresh')).toBe('refresh');
  });

  it('round-trips non-ascii text', () => {
    // Provider names and the copy in the macOS tree carry curly apostrophes.
    const value = 'Claude Code doesn’t have a working login — Z.ai (GLM)';
    // The engine reads these bytes as UTF-8. A latin1 encode would reach the
    // Go side as mojibake and land in a user-visible account label.
    const encoded = encodeBase64Utf8(value);
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe(value);
    const line = mutateCommand('account-edit', { providerId: 'claude', name: 'work', label: value }, 'm3');
    expect(decodePayload(line)).toEqual({
      version: MESSAGE_VERSION,
      requestId: 'm3',
      operation: 'account-edit',
      providerId: 'claude',
      name: 'work',
      label: value,
    });
  });

  it('gives each command a distinct request id', () => {
    // A retried requestId is STATE_CONFLICT: the engine would answer the first
    // one twice and treat the second as a replay.
    const ids = new Set(Array.from({ length: 50 }, () => newRequestId('mutate')));
    expect(ids.size).toBe(50);
  });
});
