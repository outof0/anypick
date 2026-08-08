import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { executeActivation, type ExecutorDeps } from '../src/core/activation-executor';
import { OperationJournal } from '../src/core/journal';
import { accountRef } from '../src/core/refs';
import { createTestEnv } from './helpers';
import type { ActivationPlan, SourceAdapter } from '../src/types';

let cleanupRoot = '';

afterEach(async () => {
  if (cleanupRoot) {
    await rm(cleanupRoot, { recursive: true, force: true });
    cleanupRoot = '';
  }
});

describe('ephemeral native-auth lifecycle', () => {
  it('refuses a malformed ephemeral plan that attempts to mutate live auth', async () => {
    const env = await createTestEnv(['fake']);
    cleanupRoot = env.root;
    await env.fakes.fake.setLive({ email: 'work@example.test', token: 'work' });
    await env.service.save('fake', 'work');
    await env.fakes.fake.setLive({ email: 'personal@example.test', token: 'personal' });
    await env.service.save('fake', 'personal');
    await env.fakes.fake.setLive({ email: 'work@example.test', token: 'work' });

    const adapter: SourceAdapter = {
      sourceRef: accountRef('fake', 'personal'),
      capabilities: {
        sourceKind: 'account',
        provider: 'fake',
        nativeClients: ['codex'],
        protocols: ['openai'],
        canRefresh: false,
        supportsModelDiscovery: false,
        requiresNativeAuthWrite: true,
      },
      transportFor: () => 'direct',
    };
    const plan: ActivationPlan = {
      mode: 'ephemeral',
      client: 'codex',
      resolvedSource: {
        ref: accountRef('fake', 'personal'),
        kind: 'account',
        adapter,
        display: 'fake/personal',
      },
      transport: { capability: 'direct', protocol: 'openai' },
      model: { mode: 'omitted' },
      steps: [{ kind: 'WriteNativeAuth' }],
      rollback: [{ kind: 'RestoreNativeAuth' }],
      warnings: [],
    };
    const deps = {
      accounts: env.service,
      proxy: env.service.proxy,
      journal: new OperationJournal(env.store.db),
      runtime: { root: env.root },
    } as unknown as ExecutorDeps;

    await expect(executeActivation(plan, deps)).rejects.toMatchObject({
      code: 'UNSUPPORTED_TRANSPORT',
    });
    expect(await env.fakes.fake.readLive()).toEqual({ email: 'work@example.test', token: 'work' });
    expect(await env.service.getActive('fake')).toBe('work');
  });
});
