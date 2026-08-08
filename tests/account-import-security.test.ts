import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestEnv } from './helpers';
import { AnyPickError } from '../src/utils/errors';

/** Assert that importing the envelope at `path` throws an IMPORT_* error and leaves no partial state. */
async function expectImportRejected(
  service: Awaited<ReturnType<typeof createTestEnv>>['service'],
  providerId: string,
  name: string,
  path: string,
): Promise<void> {
  let err: unknown;
  try {
    await service.importAccount(providerId, name, path);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(AnyPickError);
  expect((err as AnyPickError).code).toMatch(/^IMPORT_/);
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base64 = Buffer.from(
    JSON.stringify({ email: 'imported@example.test', token: 'secret' }),
  ).toString('base64');
  return {
    version: 1,
    kind: 'anypick-account',
    meta: {
      name: 'main',
      provider: 'fake',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    proxy: { enabled: false },
    files: { 'auth.json': base64 },
    ...overrides,
  };
}

async function writeEnvelope(dir: string, payload: unknown): Promise<string> {
  const p = join(dir, 'evil.anypick.json');
  await writeFile(p, JSON.stringify(payload));
  return p;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

describe('SEC-01 account import trust boundary', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-sec01-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips a valid v1 export', async () => {
    const { service, fakes } = await createTestEnv(['fake']);
    await fakes.fake.setLive({ email: 'ok@me', token: 's' });
    await service.save('fake', 'main');
    const out = join(root, 'main.anypick.json');
    await service.exportAccount('fake', 'main', out);

    await service.delete('fake', 'main');
    await fakes.fake.clearLive();

    const meta = await service.importAccount('fake', 'restored', out);
    expect(meta.name).toBe('restored');
    expect(meta.provider).toBe('fake');
    await service.use('fake', 'restored');
    expect((await fakes.fake.readLive())?.email).toBe('ok@me');
  });

  it('rejects a forged meta.provider that does not match the requested provider', async () => {
    const { service } = await createTestEnv(['fake']);
    const env = envelope();
    (env.meta as Record<string, unknown>).provider = 'other';
    const p = await writeEnvelope(root, env);
    await expectImportRejected(service, 'fake', 'x', p);
    expect(await service.list('fake')).toHaveLength(0);
  });

  it('rejects path traversal in a file key without writing outside the snapshot', async () => {
    const { service, fakes } = await createTestEnv(['fake']);
    await fakes.fake.setLive({ email: 'a@x', token: 't' });
    await service.save('fake', 'main');
    const sibling = join(root, 'exfiltrated.txt');
    const env = envelope({
      files: { '../exfiltrated.txt': Buffer.from('PWNED').toString('base64') },
    });
    const p = await writeEnvelope(root, env);
    await expectImportRejected(service, 'fake', 'attack', p);
    expect(await fileExists(sibling)).toBe(false);
    expect(await service.list('fake')).toHaveLength(1);
  });

  it('rejects absolute POSIX and Windows-style paths', async () => {
    const { service } = await createTestEnv(['fake']);
    for (const key of ['/etc/passwd', 'C:\\Windows\\system32\\x']) {
      const env = envelope({ files: { [key]: Buffer.from('x').toString('base64') } });
      const p = await writeEnvelope(root, env);
      await expectImportRejected(service, 'fake', 'a', p);
    }
  });

  it('rejects mixed separators and NUL bytes in file keys', async () => {
    const { service } = await createTestEnv(['fake']);
    for (const key of ['a/b\\c', 'a/\0c']) {
      const env = envelope({ files: { [key]: Buffer.from('x').toString('base64') } });
      const p = await writeEnvelope(root, env);
      await expectImportRejected(service, 'fake', 'a', p);
    }
  });

  it('rejects duplicate normalized paths and file/dir collisions', async () => {
    const { service } = await createTestEnv(['fake']);
    const env = envelope({
      files: {
        'a/b.json': Buffer.from('1').toString('base64'),
        'a\\b.json': Buffer.from('2').toString('base64'),
        'a/b.json/c': Buffer.from('3').toString('base64'),
      },
    });
    const p = await writeEnvelope(root, env);
    await expectImportRejected(service, 'fake', 'a', p);
  });

  it.each([
    ['a', 'a/b'],
    ['a/b', 'a'],
  ])('rejects file/directory collision regardless of key order (%s, %s)', async (first, second) => {
    const { service } = await createTestEnv(['fake']);
    const env = envelope({
      files: {
        [first]: Buffer.from('1').toString('base64'),
        [second]: Buffer.from('2').toString('base64'),
      },
    });
    const p = await writeEnvelope(root, env);
    await expectImportRejected(service, 'fake', 'collision', p);
    expect(await service.list('fake')).toHaveLength(0);
  });

  it('rejects malformed JSON, unknown kind, and unsupported version', async () => {
    const { service } = await createTestEnv(['fake']);
    const bad = join(root, 'bad.json');
    await writeFile(bad, '{not json');
    await expectImportRejected(service, 'fake', 'a', bad);

    const wrongKind = envelope({ kind: 'anypick-profile' });
    const kp = await writeEnvelope(root, wrongKind);
    await expectImportRejected(service, 'fake', 'a', kp);

    const future = envelope({ version: 99 });
    const fp = await writeEnvelope(root, future);
    await expectImportRejected(service, 'fake', 'a', fp);
  });

  it('rejects invalid base64 content', async () => {
    const { service } = await createTestEnv(['fake']);
    const env = envelope({ files: { 'auth.json': '!!!not-base64!!!' } });
    const p = await writeEnvelope(root, env);
    await expectImportRejected(service, 'fake', 'a', p);
  });

  it('rejects oversized total payload without writing', async () => {
    const { service, root: envRoot } = await createTestEnv(['fake']);
    const big = 'x'.repeat(200 * 1024); // 200 KiB; over the total limit across many files
    const files: Record<string, string> = {};
    for (let i = 0; i < 700; i++) {
      files[`f${i}.json`] = Buffer.from(big).toString('base64');
    }
    const env = envelope({ files });
    const p = await writeEnvelope(envRoot, env);
    await expectImportRejected(service, 'fake', 'a', p);
    expect(await service.list('fake')).toHaveLength(0);
    // Tripping the 128 MiB total without tripping the 192 MiB envelope check
    // means the payload really has to be built, so this one is slow by nature.
  }, 30000);

  it('leaves the active live account and current snapshot unchanged on rejection', async () => {
    const { service, fakes } = await createTestEnv(['fake']);
    await fakes.fake.setLive({ email: 'real@me', token: 'keep' });
    await service.save('fake', 'main');
    await service.use('fake', 'main');
    const before = await fakes.fake.readLive();

    const env = envelope({ meta: { name: 'intruder', provider: 'other' } });
    const p = await writeEnvelope(root, env);
    await expectImportRejected(service, 'fake', 'intruder', p);

    expect(await fakes.fake.readLive()).toEqual(before);
    expect(await service.list('fake')).toHaveLength(1);
  });

  it('does not import proxy activation state or opaque upstream options', async () => {
    const { service, store } = await createTestEnv(['fake']);
    const env = envelope({
      proxy: {
        enabled: true,
        port: 4123,
        host: '127.0.0.1',
        options: {
          upstream: 'https://attacker.invalid/v1',
          authPath: '/tmp/attacker-auth.json',
        },
      },
    });
    const p = await writeEnvelope(root, env);

    await service.importAccount('fake', 'imported', p);
    const account = await store.getAccount('fake', 'imported');
    expect(account).not.toBeNull();
    if (!account) {
      throw new Error('Expected imported account');
    }
    expect(account.proxy.enabled).toBe(false);
    expect(account.proxy.port).toBe(4123);
    expect(account.proxy.options).toBeUndefined();
  });

  it('rejects terminal control sequences in imported display metadata', async () => {
    const { service } = await createTestEnv(['fake']);
    const env = envelope({
      meta: {
        name: 'main',
        provider: 'fake',
        label: 'looks harmless\u001b]8;;https://attacker.invalid\u0007click',
      },
    });
    const p = await writeEnvelope(root, env);

    await expectImportRejected(service, 'fake', 'control', p);
    expect(await service.list('fake')).toHaveLength(0);
  });
});
