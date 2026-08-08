/** Persistence decoders for bindings, leases, and journal records. */
import { describe, expect, it } from 'vitest';

import { CodecError, decode, decoders } from '../src/core/codec';

describe('decoder: bindingProvenance', () => {
  it('accepts valid provenance with any kind', () => {
    const r = decoders.bindingProvenance({ kind: 'tui' }, 'k');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('tui');
    }
  });

  it('rejects missing kind', () => {
    expect(decoders.bindingProvenance({}, 'k').ok).toBe(false);
  });
});

describe('decoder: presetSpec', () => {
  const valid = {
    client: 'c',
    source: { kind: 'account', provider: 'p', name: 'n' },
    model: { mode: 'explicit', id: 'm' },
    transportPolicy: 'auto',
    clientOptions: {},
  };

  it('accepts valid preset spec', () => {
    expect(decoders.presetSpec(valid, 'k').ok).toBe(true);
  });

  it('accepts omitted model', () => {
    expect(decoders.presetSpec({ ...valid, model: { mode: 'omitted' } }, 'k').ok).toBe(true);
  });

  it('rejects invalid model mode', () => {
    expect(decoders.presetSpec({ ...valid, model: { mode: 'random' } }, 'k').ok).toBe(false);
  });
});

describe('decoder: poolMembers', () => {
  it('accepts valid member list', () => {
    const r = decoders.poolMembers([{ account: 'a', enabled: true }, { account: 'b' }], 'k');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(2);
      expect(r.value[0].enabled).toBe(true);
      expect(r.value[1].enabled).toBe(true);
    }
  });

  it('defaults enabled to true when missing', () => {
    const r = decoders.poolMembers([{ account: 'x' }], 'k');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value[0].enabled).toBe(true);
    }
  });

  it('rejects non-array', () => {
    expect(decoders.poolMembers({}, 'k').ok).toBe(false);
  });

  it('rejects member without account', () => {
    expect(decoders.poolMembers([{ enabled: true }], 'k').ok).toBe(false);
  });
});

describe('decoder: proxyLease', () => {
  const valid = {
    leaseId: 'id-1',
    provider: 'p',
    port: 8080,
    host: '127.0.0.1',
    ownerPid: 1234,
    createdAt: 't',
    updatedAt: 't',
  };

  it('accepts valid lease', () => {
    const r = decoders.proxyLease(valid, 'k');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.leaseId).toBe('id-1');
      expect(r.value.bindingRefs).toEqual([]);
    }
  });

  it('rejects missing leaseId', () => {
    const { leaseId: _leaseId, ...rest } = valid;
    expect(decoders.proxyLease(rest, 'k').ok).toBe(false);
  });

  it('rejects non-number port', () => {
    expect(decoders.proxyLease({ ...valid, port: '8080' }, 'k').ok).toBe(false);
  });

  it('accepts optional account and instanceId', () => {
    const r = decoders.proxyLease({ ...valid, account: 'a', instanceId: 'inst' }, 'k');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.account).toBe('a');
      expect(r.value.instanceId).toBe('inst');
    }
  });
});

describe('decoder: journalEntry', () => {
  const valid = {
    id: 'j-1',
    type: 'save',
    state: 'committed',
    affectedResources: ['account:a'],
    backupPaths: [],
    startedAt: 't',
    updatedAt: 't',
  };

  it('accepts valid journal entry', () => {
    expect(decoders.journalEntry(valid, 'k').ok).toBe(true);
  });

  it('rejects invalid state', () => {
    expect(decoders.journalEntry({ ...valid, state: 'bogus' }, 'k').ok).toBe(false);
  });

  it('accepts all valid states', () => {
    for (const state of [
      'planned',
      'executing',
      'verifying',
      'rolling_back',
      'rolled_back',
      'failed',
      'committed',
    ]) {
      expect(decoders.journalEntry({ ...valid, state }, 'k').ok).toBe(true);
    }
  });

  it('rejects non-string affectedResources', () => {
    expect(decoders.journalEntry({ ...valid, affectedResources: 123 }, 'k').ok).toBe(false);
  });
});

describe('decoder: bindingSpecFromJson', () => {
  const valid = JSON.stringify({
    client: 'c',
    source: { kind: 'account', provider: 'p', name: 'n' },
    model: { mode: 'omitted' },
    transportPolicy: 'auto',
  });

  it('accepts valid JSON string', () => {
    expect(decoders.bindingSpecFromJson(valid, 'k').ok).toBe(true);
  });

  it('rejects corrupt JSON', () => {
    const r = decoders.bindingSpecFromJson('{bad', 'k');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('json parse');
    }
  });
});

describe('codec error redaction', () => {
  it('AccountMeta error does not contain identity value', () => {
    const r = decoders.accountMeta(
      { name: 'x', provider: 'p', identity: 'SECRET_ID', createdAt: 't' },
      'mykey',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain('SECRET_ID');
      expect(r.error).toContain('mykey');
    }
  });

  it('RuntimeProfileSecrets error does not contain apiKey', () => {
    expect(decoders.runtimeProfileSecrets({ apiKey: 'sk-12345' }, 'mykey').ok).toBe(true);
    const r = decoders.accountMeta({ apiKey: 'sk-leaked' }, 'mykey');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain('sk-leaked');
    }
  });

  it('CodecError message never contains secret material', () => {
    try {
      decode('{"secret":"sk-12345"}', decoders.accountMeta, 'leak-test');
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CodecError);
      expect((e as CodecError).message).not.toContain('sk-12345');
    }
  });
});

describe('decoder: globalBinding', () => {
  const valid = {
    client: 'c',
    spec: {
      client: 'c',
      source: { kind: 'account', provider: 'p', name: 'n' },
      model: { mode: 'omitted' },
      transportPolicy: 'auto',
    },
    provenance: { kind: 'tui' },
    createdAt: 't',
    updatedAt: 't',
  };

  it('accepts valid global binding', () => {
    expect(decoders.globalBinding(valid, 'k').ok).toBe(true);
  });

  it('rejects nested spec error with full path', () => {
    const r = decoders.globalBinding({ ...valid, spec: { client: 'c' } }, 'k');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('spec');
    }
  });
});

describe('decoder: projectBinding', () => {
  const valid = {
    projectRoot: '/tmp/proj',
    client: 'c',
    spec: {
      client: 'c',
      source: { kind: 'preset', name: 'default' },
      model: { mode: 'omitted' },
      transportPolicy: 'direct',
    },
    provenance: { kind: 'cli' },
    createdAt: 't',
    updatedAt: 't',
  };

  it('accepts valid project binding', () => {
    expect(decoders.projectBinding(valid, 'k').ok).toBe(true);
  });

  it('rejects missing projectRoot', () => {
    const { projectRoot: _projectRoot, ...rest } = valid;
    expect(decoders.projectBinding(rest, 'k').ok).toBe(false);
  });
});
