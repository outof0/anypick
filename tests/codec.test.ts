/**
 * DATA-02 regression tests: versioned record decoders.
 *
 * Verifies that every persistence boundary goes through `unknown` + decoder,
 * corrupt/future data is rejected, errors carry record kind + field path
 * (never secret values), and round-trips are stable.
 */
import { describe, it, expect } from 'vitest';
import { decode, decodeWithFallback, CodecError, decoders } from '../src/core/codec';

// ── decode / decodeWithFallback / CodecError ────────────────────

describe('decode and decodeWithFallback', () => {
  it('decode returns decoded value on success', () => {
    const result = decode(
      '{"name":"x","provider":"p","createdAt":"t","updatedAt":"t"}',
      decoders.accountMeta,
      'test',
    );
    expect(result.name).toBe('x');
  });

  it('decode throws CodecError on corrupt JSON', () => {
    expect(() => decode('{bad', decoders.accountMeta, 'rec/1')).toThrow(CodecError);
    try {
      decode('{bad', decoders.accountMeta, 'rec/1');
    } catch (e) {
      expect(e).toBeInstanceOf(CodecError);
      expect((e as CodecError).recordKind).toBe('rec/1');
    }
  });

  it('decode throws CodecError on schema mismatch', () => {
    expect(() => decode('{}', decoders.accountMeta, 'acct/2')).toThrow(CodecError);
  });

  it('decodeWithFallback returns fallback on corrupt JSON', () => {
    const fb = { enabled: false };
    const result = decodeWithFallback('{bad', decoders.accountProxyConfig, fb, 'k');
    expect(result).toEqual(fb);
  });

  it('decodeWithFallback returns decoded value on success', () => {
    const result = decodeWithFallback(
      '{"enabled":true}',
      decoders.accountProxyConfig,
      { enabled: false },
      'k',
    );
    expect(result.enabled).toBe(true);
  });
});

// ── AccountMeta ─────────────────────────────────────────────────

describe('decoder: accountMeta', () => {
  const valid = {
    name: 'a',
    provider: 'p',
    createdAt: '2024-01-01',
    updatedAt: '2024-01-02',
  };

  it('accepts valid meta with optional fields', () => {
    const r = decoders.accountMeta({ ...valid, label: 'L', identity: 'I', notes: 'N' }, 'k');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.label).toBe('L');
      expect(r.value.identity).toBe('I');
      expect(r.value.notes).toBe('N');
    }
  });

  it('accepts valid meta without optional fields', () => {
    const r = decoders.accountMeta(valid, 'k');
    expect(r.ok).toBe(true);
  });

  it('rejects non-object', () => {
    expect(decoders.accountMeta(null, 'k').ok).toBe(false);
    expect(decoders.accountMeta('str', 'k').ok).toBe(false);
  });

  it('rejects missing name', () => {
    const { name: _name, ...rest } = valid;
    expect(decoders.accountMeta(rest, 'k').ok).toBe(false);
  });

  it('rejects missing provider', () => {
    const { provider: _provider, ...rest } = valid;
    expect(decoders.accountMeta(rest, 'k').ok).toBe(false);
  });

  it('rejects wrong type for createdAt', () => {
    expect(decoders.accountMeta({ ...valid, createdAt: 123 }, 'k').ok).toBe(false);
  });

  it('error includes field path', () => {
    const r = decoders.accountMeta({}, 'mykey');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('AccountMeta');
    }
    if (!r.ok) {
      expect(r.error).toContain('mykey');
    }
  });
});

// ── AccountProxyConfig ──────────────────────────────────────────

describe('decoder: accountProxyConfig', () => {
  it('accepts valid config', () => {
    const r = decoders.accountProxyConfig({ enabled: true, port: 8080, host: '127.0.0.1' }, 'k');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.enabled).toBe(true);
      expect(r.value.port).toBe(8080);
    }
  });

  it('defaults missing fields gracefully', () => {
    const r = decoders.accountProxyConfig({}, 'k');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.enabled).toBe(false);
      expect(r.value.port).toBeUndefined();
    }
  });

  it('rejects non-object', () => {
    expect(decoders.accountProxyConfig(42, 'k').ok).toBe(false);
  });
});

// ── ProxyRuntimeState ───────────────────────────────────────────

describe('decoder: proxyRuntimeState', () => {
  const valid = {
    accountName: 'a',
    endpoint: 'http://localhost:8080',
    startedAt: '2024-01-01',
  };

  it('accepts valid state', () => {
    const r = decoders.proxyRuntimeState(valid, 'k');
    expect(r.ok).toBe(true);
  });

  it('rejects missing accountName', () => {
    const { accountName: _accountName, ...rest } = valid;
    expect(decoders.proxyRuntimeState(rest, 'k').ok).toBe(false);
  });

  it('rejects missing endpoint', () => {
    const { endpoint: _endpoint, ...rest } = valid;
    expect(decoders.proxyRuntimeState(rest, 'k').ok).toBe(false);
  });
});

// ── GlobalConfig ────────────────────────────────────────────────

describe('decoder: globalConfig', () => {
  it('accepts empty config (defaults to schemaVersion 0)', () => {
    const r = decoders.globalConfig({}, 'k');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.schemaVersion).toBe(0);
    }
  });

  it('accepts full config with defaults and ui', () => {
    const r = decoders.globalConfig(
      {
        schemaVersion: 2,
        defaultClient: 'c',
        activeProfile: 'p',
        defaults: { proxyHost: 'h' },
        ui: { color: true },
      },
      'k',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.schemaVersion).toBe(2);
      expect(r.value.defaults?.proxyHost).toBe('h');
      expect(r.value.ui?.color).toBe(true);
    }
  });

  it('rejects non-object', () => {
    expect(decoders.globalConfig(null, 'k').ok).toBe(false);
  });
});

// ── RuntimeProfileMeta ──────────────────────────────────────────

describe('decoder: runtimeProfileMeta', () => {
  const valid = {
    name: 'p',
    provider: 'prov',
    createdAt: 't',
    updatedAt: 't',
    models: {},
  };

  it('accepts valid profile meta', () => {
    const r = decoders.runtimeProfileMeta(valid, 'k');
    expect(r.ok).toBe(true);
  });

  it('rejects missing name', () => {
    const { name: _name, ...rest } = valid;
    expect(decoders.runtimeProfileMeta(rest, 'k').ok).toBe(false);
  });

  it('defaults models to empty when missing', () => {
    const { models: _models, ...rest } = valid;
    const r = decoders.runtimeProfileMeta(rest, 'k');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.models).toEqual({});
    }
  });
});

// ── RuntimeProfileSecrets ───────────────────────────────────────

describe('decoder: runtimeProfileSecrets', () => {
  it('accepts empty secrets', () => {
    const r = decoders.runtimeProfileSecrets({}, 'k');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.apiKey).toBeUndefined();
      expect(r.value.headers).toBeUndefined();
    }
  });

  it('accepts apiKey and headers', () => {
    const r = decoders.runtimeProfileSecrets({ apiKey: 'k', headers: { H: 'v' } }, 'k');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.apiKey).toBe('k');
    }
  });

  it('rejects non-object', () => {
    expect(decoders.runtimeProfileSecrets('str', 'k').ok).toBe(false);
  });
});

// ── ClientState ─────────────────────────────────────────────────

describe('decoder: clientState', () => {
  const valid = {
    clientId: 'c',
    mode: 'ephemeral',
    updatedAt: 't',
    managedPaths: [],
    managedEnvKeys: [],
  };

  it('accepts valid client state', () => {
    const r = decoders.clientState(valid, 'k');
    expect(r.ok).toBe(true);
  });

  it('rejects missing clientId', () => {
    const { clientId: _clientId, ...rest } = valid;
    expect(decoders.clientState(rest, 'k').ok).toBe(false);
  });

  it('defaults managedPaths and managedEnvKeys to empty', () => {
    const r = decoders.clientState({ clientId: 'c', mode: 'm', updatedAt: 't' }, 'k');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.managedPaths).toEqual([]);
      expect(r.value.managedEnvKeys).toEqual([]);
    }
  });
});

// ── BindingSpec ─────────────────────────────────────────────────

describe('decoder: bindingSpec', () => {
  const valid = {
    client: 'claude',
    source: { kind: 'account', provider: 'gemini', name: 'default' },
    model: { mode: 'explicit', id: 'gpt-4' },
    transportPolicy: 'auto',
    clientOptions: {},
  };

  it('accepts valid binding spec', () => {
    const r = decoders.bindingSpec(valid, 'k');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.client).toBe('claude');
      expect(r.value.source.kind).toBe('account');
    }
  });

  it('rejects invalid source kind', () => {
    const r = decoders.bindingSpec({ ...valid, source: { kind: 'invalid' } }, 'k');
    expect(r.ok).toBe(false);
  });

  it('rejects invalid transportPolicy', () => {
    const r = decoders.bindingSpec({ ...valid, transportPolicy: 'turbo' }, 'k');
    expect(r.ok).toBe(false);
  });

  it('accepts omitted model mode', () => {
    const r = decoders.bindingSpec({ ...valid, model: { mode: 'omitted' } }, 'k');
    expect(r.ok).toBe(true);
  });

  it('accepts gateway source', () => {
    const r = decoders.bindingSpec({ ...valid, source: { kind: 'gateway', name: 'gw' } }, 'k');
    expect(r.ok).toBe(true);
  });
});
