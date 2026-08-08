import { describe, expect, it, vi } from 'vitest';
import {
  decodeTrayCommand,
  MAX_TRAY_COMMAND_BYTES,
  trayLogSourceId,
  TRAY_PROTOCOL_VERSION,
} from '../src/tray/protocol';
import { trayMutationError } from '../src/tray/supervisor-errors';
import { redactTrayProxyLogs } from '../src/tray/supervisor-logs';
import { detectTrayAccount } from '../src/tray/supervisor-mutations';
import { AnyPickError } from '../src/utils/errors';
import type { AnyPickApp } from '../src/core/app';

function encodeInvoke(payload: unknown): string {
  return `invoke\t${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`;
}

function encodeMutation(payload: unknown): string {
  return `mutate\t${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`;
}

function encodeModelRoles(payload: unknown): string {
  return `model-roles\t${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`;
}

function encodeLogs(payload: unknown): string {
  return `logs\t${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`;
}

describe('tray command protocol', () => {
  it('uses one canonical identity for a log source and response', () => {
    expect(trayLogSourceId('proxy-hub', 'default')).toBe('proxy-hub/default');
    expect(trayLogSourceId('tray-supervisor', 'main')).toBe('tray-supervisor/main');
  });

  it('decodes the exact legacy commands', () => {
    expect(decodeTrayCommand('open')).toEqual({ kind: 'open' });
    expect(decodeTrayCommand('refresh')).toEqual({ kind: 'refresh' });
    expect(decodeTrayCommand('restart')).toEqual({ kind: 'restart' });
    expect(decodeTrayCommand('stop')).toEqual({ kind: 'stop' });
    expect(decodeTrayCommand('quit')).toEqual({ kind: 'quit' });
  });

  it('decodes only the supported tray destinations', () => {
    expect(decodeTrayCommand('navigate\taccounts')).toEqual({
      kind: 'navigate',
      screen: 'accounts',
    });
    expect(decodeTrayCommand('navigate\tgateways')).toEqual({
      kind: 'navigate',
      screen: 'gateways',
    });
    expect(decodeTrayCommand('navigate\tproxy')).toEqual({ kind: 'navigate', screen: 'proxy' });
    expect(decodeTrayCommand('navigate\tproxy-hub')).toEqual({
      kind: 'navigate',
      screen: 'proxy-hub',
    });
    expect(decodeTrayCommand('navigate\tadd-account')).toEqual({
      kind: 'navigate',
      screen: 'add-account',
    });
    expect(decodeTrayCommand('navigate\tadd-gateway')).toEqual({
      kind: 'navigate',
      screen: 'add-gateway',
    });
    expect(decodeTrayCommand('navigate\tsettings')).toBeUndefined();
    expect(decodeTrayCommand('navigate\taccounts\textra')).toBeUndefined();
  });

  it('rejects non-exact or unknown commands', () => {
    for (const line of [' open', 'open\n', 'restart\t', 'invoke', 'status\t1', 'unknown']) {
      expect(decodeTrayCommand(line)).toBeUndefined();
    }
  });

  it('decodes a valid invoke request and permits additional payload fields', () => {
    const payload = {
      version: TRAY_PROTOCOL_VERSION,
      requestId: 'request-1',
      revision: 0,
      actionId: 'refresh',
      futureField: true,
    };
    expect(decodeTrayCommand(encodeInvoke(payload))).toEqual({
      kind: 'invoke',
      payload,
    });
  });

  it('rejects malformed, truncated, and non-canonical base64', () => {
    for (const encoded of ['not base64!', 'eyJ2ZXJzaW9uIjox', 'TQ', 'TWE=', 'TWFu====']) {
      expect(decodeTrayCommand(`invoke\t${encoded}`)).toBeUndefined();
    }
  });

  it('rejects base64 that does not contain JSON', () => {
    expect(
      decodeTrayCommand(`invoke\t${Buffer.from('not json').toString('base64')}`),
    ).toBeUndefined();
  });

  it('rejects oversized command lines, payloads, and decoded payloads', () => {
    const valid = {
      version: TRAY_PROTOCOL_VERSION,
      requestId: 'r',
      revision: 1,
      actionId: 'a',
    };
    expect(decodeTrayCommand(`open${'x'.repeat(MAX_TRAY_COMMAND_BYTES)}`)).toBeUndefined();
    expect(decodeTrayCommand(`invoke\t${'A'.repeat(MAX_TRAY_COMMAND_BYTES + 1)}`)).toBeUndefined();
    expect(
      decodeTrayCommand(encodeInvoke({ ...valid, extra: 'x'.repeat(MAX_TRAY_COMMAND_BYTES) })),
    ).toBeUndefined();
  });

  it('rejects invalid invoke fields and accepts their stated bounds', () => {
    const valid = {
      version: TRAY_PROTOCOL_VERSION,
      requestId: 'r'.repeat(128),
      revision: Number.MAX_SAFE_INTEGER,
      actionId: 'a'.repeat(128),
    };
    expect(decodeTrayCommand(encodeInvoke(valid))).toEqual({ kind: 'invoke', payload: valid });

    for (const payload of [
      { ...valid, version: 2 },
      { ...valid, version: '1' },
      { ...valid, requestId: '' },
      { ...valid, requestId: 'r'.repeat(129) },
      { ...valid, revision: -1 },
      { ...valid, revision: 1.5 },
      { ...valid, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, actionId: '' },
      { ...valid, actionId: 'a'.repeat(129) },
    ]) {
      expect(decodeTrayCommand(encodeInvoke(payload))).toBeUndefined();
    }
  });

  it('decodes bounded opaque model-role selections without accepting source refs or model ids', () => {
    const payload = {
      version: TRAY_PROTOCOL_VERSION,
      requestId: 'models-1',
      revision: 7,
      clientId: 'claude',
      roleActionIds: {
        default: 'action-default',
        sonnet: 'action-sonnet',
        opus: 'action-opus',
        haiku: 'action-haiku',
      },
    };
    expect(decodeTrayCommand(encodeModelRoles(payload))).toEqual({
      kind: 'apply-model-roles',
      payload,
    });

    for (const invalid of [
      { ...payload, revision: -1 },
      { ...payload, clientId: '' },
      { ...payload, roleActionIds: {} },
      { ...payload, roleActionIds: { sonnet: 'action-sonnet' } },
      { ...payload, roleActionIds: { default: '' } },
      { ...payload, roleActionIds: { default: 'x'.repeat(129) } },
      { ...payload, roleActionIds: { default: 'action', bad: 'line\nbreak' } },
      { ...payload, source: 'hub/default' },
      { ...payload, model: 'raw-model-id' },
    ]) {
      expect(decodeTrayCommand(encodeModelRoles(invalid))).toBeUndefined();
    }
  });

  it('decodes bounded account and gateway mutations without exposing interpretation gaps', () => {
    const detect = {
      version: TRAY_PROTOCOL_VERSION,
      requestId: 'detect-account',
      operation: 'account-detect',
      providerId: 'gemini',
      sourceId: 'antigravity',
      name: 'detect',
    };
    expect(decodeTrayCommand(encodeMutation(detect))).toEqual({
      kind: 'mutate',
      payload: detect,
    });

    const account = {
      version: TRAY_PROTOCOL_VERSION,
      requestId: 'save-account',
      operation: 'account-save',
      providerId: 'gemini',
      sourceId: 'antigravity',
      name: 'lentaunao',
      label: 'Lentaunao',
      overwrite: true,
    };
    expect(decodeTrayCommand(encodeMutation(account))).toEqual({
      kind: 'mutate',
      payload: account,
    });

    const gateway = {
      version: TRAY_PROTOCOL_VERSION,
      requestId: 'save-gateway',
      operation: 'gateway-create',
      providerId: 'openrouter',
      name: 'work',
      endpoint: 'https://openrouter.ai/api/v1',
      apiKey: 'secret-value',
      defaultModel: 'openai/gpt-5',
    };
    expect(decodeTrayCommand(encodeMutation(gateway))).toEqual({
      kind: 'mutate',
      payload: gateway,
    });

    const apiKeyAccount = {
      version: TRAY_PROTOCOL_VERSION,
      requestId: 'save-kiro',
      operation: 'account-save',
      providerId: 'kiro',
      name: 'work',
      apiKey: 'ksk_a_reasonably_long_key',
      region: 'us-east-1',
    };
    expect(decodeTrayCommand(encodeMutation(apiKeyAccount))).toEqual({
      kind: 'mutate',
      payload: apiKeyAccount,
    });

    const reset = {
      version: TRAY_PROTOCOL_VERSION,
      requestId: 'reset-client',
      operation: 'client-reset',
      name: 'claude',
    };
    expect(decodeTrayCommand(encodeMutation(reset))).toEqual({
      kind: 'mutate',
      payload: reset,
    });

    const hubSource = {
      version: TRAY_PROTOCOL_VERSION,
      requestId: 'hub-source',
      operation: 'hub-source-toggle',
      providerId: 'gemini',
      name: 'work',
      enabled: true,
    } as const;
    expect(decodeTrayCommand(encodeMutation(hubSource))).toEqual({
      kind: 'mutate',
      payload: hubSource,
    });

    const clearLive = {
      version: TRAY_PROTOCOL_VERSION,
      requestId: 'clear-account',
      operation: 'account-clear',
      providerId: 'kiro',
      name: 'clear',
    };
    expect(decodeTrayCommand(encodeMutation(clearLive))).toEqual({
      kind: 'mutate',
      payload: clearLive,
    });

    const clearLiveSource = {
      version: TRAY_PROTOCOL_VERSION,
      requestId: 'clear-antigravity',
      operation: 'account-clear',
      providerId: 'gemini',
      sourceId: 'antigravity',
      name: 'clear',
    };
    expect(decodeTrayCommand(encodeMutation(clearLiveSource))).toEqual({
      kind: 'mutate',
      payload: clearLiveSource,
    });

    const remove = {
      version: TRAY_PROTOCOL_VERSION,
      requestId: 'remove-account',
      operation: 'account-remove',
      providerId: 'grok',
      name: 'work',
    };
    expect(decodeTrayCommand(encodeMutation(remove))).toEqual({
      kind: 'mutate',
      payload: remove,
    });

    const removeGateway = {
      version: TRAY_PROTOCOL_VERSION,
      requestId: 'remove-gateway',
      operation: 'gateway-remove',
      name: 'work-relay',
    } as const;
    expect(decodeTrayCommand(encodeMutation(removeGateway))).toEqual({
      kind: 'mutate',
      payload: removeGateway,
    });
  });

  it('rejects malformed tray mutations', () => {
    const valid = {
      version: TRAY_PROTOCOL_VERSION,
      requestId: 'request',
      operation: 'account-edit',
      providerId: 'codex',
      name: 'work',
    };
    for (const payload of [
      { ...valid, operation: 'account-delete' },
      { ...valid, operation: 'account-remove', providerId: undefined },
      { ...valid, providerId: undefined },
      { ...valid, name: '' },
      { ...valid, name: 'bad\nname' },
      { ...valid, apiKey: 'x'.repeat(8193) },
      { ...valid, region: 'x'.repeat(65) },
      { ...valid, overwrite: 'yes' },
      { ...valid, unknown: true },
      {
        version: TRAY_PROTOCOL_VERSION,
        requestId: 'hub-source',
        operation: 'hub-source-toggle',
        providerId: 'gemini',
        name: 'work',
      },
    ]) {
      expect(decodeTrayCommand(encodeMutation(payload))).toBeUndefined();
    }
  });

  it('requires an explicit boolean for settings mutations', () => {
    const setting = {
      version: TRAY_PROTOCOL_VERSION,
      requestId: 'setting-1',
      operation: 'setting-show-quota',
      name: 'settings',
      enabled: false,
    };
    expect(decodeTrayCommand(encodeMutation(setting))).toEqual({
      kind: 'mutate',
      payload: setting,
    });
    expect(decodeTrayCommand(encodeMutation({ ...setting, enabled: undefined }))).toBeUndefined();
    expect(decodeTrayCommand(encodeMutation({ ...setting, enabled: 'false' }))).toBeUndefined();
    expect(
      decodeTrayCommand(
        encodeMutation({ ...setting, operation: 'setting-quota-guard', enabled: true }),
      ),
    ).toEqual({
      kind: 'mutate',
      payload: { ...setting, operation: 'setting-quota-guard', enabled: true },
    });
  });

  it('decodes only bounded proxy log requests', () => {
    const payload = {
      version: TRAY_PROTOCOL_VERSION,
      requestId: 'logs-1',
      providerId: 'opencode',
      name: 'work',
      lines: 80,
    };
    expect(decodeTrayCommand(encodeLogs(payload))).toEqual({ kind: 'logs', payload });
    expect(decodeTrayCommand(encodeLogs({ ...payload, lines: 0 }))).toBeUndefined();
    expect(decodeTrayCommand(encodeLogs({ ...payload, lines: 201 }))).toBeUndefined();
    expect(decodeTrayCommand(encodeLogs({ ...payload, extra: true }))).toBeUndefined();
  });

  it('redacts runtime and upstream secrets before logs cross into the tray helper', () => {
    const runtimeToken = 'runtime-secret-that-must-never-cross';
    const visible = redactTrayProxyLogs(
      [
        `Authorization: Bearer ${runtimeToken}`,
        'https://example.test/v1?api_key=sk-super-secret-value',
        '{"token":"another-secret-value"}',
      ].join('\n'),
      runtimeToken,
    );
    expect(visible).not.toContain(runtimeToken);
    expect(visible).not.toContain('sk-super-secret-value');
    expect(visible).not.toContain('another-secret-value');
    expect(visible).toContain('<redacted>');
  });

  it('turns account failures into actionable, secret-free tray messages', () => {
    const noLogin = trayMutationError(
      new AnyPickError('/Users/me/.config contained token sk-do-not-leak', 'NO_LIVE_AUTH'),
      {
        operation: 'account-detect',
        providerId: 'gemini',
        sourceId: 'antigravity',
      },
    );
    expect(noLogin).toBe(
      'No signed-in account was found in Antigravity. Open Antigravity, sign in, then click Detect login again.',
    );
    expect(noLogin).not.toContain('sk-do-not-leak');
    expect(
      trayMutationError(new Error('HTTP 401: upstream body with secrets'), {
        operation: 'account-save',
        providerId: 'codex',
      }),
    ).toBe(
      'AnyPick could not save that account. Nothing was changed; check the official app login and try again.',
    );
  });

  it('detects a live source without invoking any account mutation service', async () => {
    const detectLiveSource = vi.fn(async () => ({ present: true, identity: 'user@example.test' }));
    const app = {
      accountRegistry: {
        get: () => ({ name: 'Gemini', detectLive: vi.fn(), detectLiveSource }),
      },
    } as unknown as Pick<AnyPickApp, 'accountRegistry'>;

    await expect(detectTrayAccount(app, 'gemini', 'antigravity')).resolves.toBe(
      'Detected user@example.test in Antigravity.',
    );
    expect(detectLiveSource).toHaveBeenCalledExactlyOnceWith('antigravity');
    expect(app).not.toHaveProperty('accounts');
  });

  it('never throws for invalid runtime input', () => {
    expect(() => decodeTrayCommand(null as unknown as string)).not.toThrow();
    expect(decodeTrayCommand(null as unknown as string)).toBeUndefined();
  });
});
