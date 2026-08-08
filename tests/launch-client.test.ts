import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchClient } from '../src/cli/launch-client';
import type { HotplugApp } from '../src/core/app';

describe('launch-client JSON output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts managed proxy bearer tokens and lease ids', async () => {
    const runPrepare = vi.fn().mockResolvedValue({
      dryRun: true,
      plan: {
        resolvedSource: { display: 'gemini/work' },
        transport: {
          capability: 'managed_builtin_proxy',
          protocol: 'openai',
          endpoint: 'http://127.0.0.1:18080',
          managedProxy: {
            provider: 'gemini',
            account: 'work',
            port: 18080,
            leaseId: 'lease-secret',
            token: 'bearer-secret',
          },
        },
        steps: [],
      },
    });
    const app = { bindingService: { runPrepare } } as unknown as HotplugApp;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await launchClient(app, 'codex', { json: true });

    const output = String(log.mock.calls[0]?.[0]);
    expect(output).not.toContain('bearer-secret');
    expect(output).not.toContain('lease-secret');
    expect(JSON.parse(output).transport.managedProxy).toEqual({
      provider: 'gemini',
      account: 'work',
      port: 18080,
    });
  });
});
