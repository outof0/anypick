import { afterEach, describe, expect, it, vi } from 'vitest';
import { runOpenCodeProxyCli } from '../src/providers/opencode-proxy/cli';

describe('opencode proxy CLI dispatch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('owns proxy serving under the main CLI command', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runOpenCodeProxyCli(['--help']);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('hotplug proxy serve opencode'));
  });
});
