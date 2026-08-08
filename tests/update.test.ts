import { describe, it, expect } from 'vitest';
import { checkForUpdate, compareVersions, installCommand } from '../src/core/update';
import { isHotplugError } from '../src/utils/errors';

function registry(body: unknown, init?: { ok?: boolean; status?: number }): typeof fetch {
  return (async () =>
    ({
      ok: init?.ok ?? true,
      status: init?.status ?? 200,
      json: async () => body,
    }) as Response) as unknown as typeof fetch;
}

describe('compareVersions', () => {
  it('orders release triples', () => {
    expect(compareVersions('0.9.0', '0.8.0')).toBe(1);
    expect(compareVersions('0.8.0', '0.8.1')).toBe(-1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('0.8.0', '0.8.0')).toBe(0);
  });

  it('tolerates a v prefix, build metadata, and short versions', () => {
    expect(compareVersions('v0.8.0', '0.8.0')).toBe(0);
    expect(compareVersions('0.8.0+build.5', '0.8.0')).toBe(0);
    expect(compareVersions('0.9', '0.8.7')).toBe(1);
  });

  it('ranks a release above its own prerelease', () => {
    expect(compareVersions('0.8.0', '0.8.0-rc.1')).toBe(1);
    expect(compareVersions('0.8.0-rc.1', '0.8.0')).toBe(-1);
  });

  it('orders prerelease identifiers numerically, not lexically', () => {
    expect(compareVersions('0.8.0-rc.10', '0.8.0-rc.2')).toBe(1);
    expect(compareVersions('0.8.0-alpha.1', '0.8.0-beta.1')).toBe(-1);
  });
});

describe('checkForUpdate', () => {
  it('reports an available update', async () => {
    const status = await checkForUpdate('0.8.0', { fetchImpl: registry({ version: '0.9.0' }) });
    expect(status).toEqual({ current: '0.8.0', latest: '0.9.0', updateAvailable: true });
  });

  it('never suggests a downgrade when the registry is behind', async () => {
    const status = await checkForUpdate('0.9.0', { fetchImpl: registry({ version: '0.8.0' }) });
    expect(status.updateAvailable).toBe(false);
  });

  it('fails with a recoverable error on an HTTP error', async () => {
    await expect(
      checkForUpdate('0.8.0', {
        fetchImpl: registry({}, { ok: false, status: 503 }),
      }),
    ).rejects.toSatisfy((err) => isHotplugError(err) && err.code === 'UPDATE_REGISTRY_UNREACHABLE');
  });

  it('distinguishes an unpublished package from a registry outage', async () => {
    await expect(
      checkForUpdate('0.8.0', { fetchImpl: registry({}, { ok: false, status: 404 }) }),
    ).rejects.toSatisfy((err) => isHotplugError(err) && err.code === 'UPDATE_NOT_PUBLISHED');
  });

  it('fails when the registry payload has no version', async () => {
    await expect(
      checkForUpdate('0.8.0', { fetchImpl: registry({ name: 'hotplug' }) }),
    ).rejects.toSatisfy((err) => isHotplugError(err) && err.code === 'UPDATE_REGISTRY_UNREACHABLE');
  });

  it('wraps a network failure instead of leaking the fetch error', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(checkForUpdate('0.8.0', { fetchImpl: failing })).rejects.toSatisfy(
      (err) => isHotplugError(err) && err.code === 'UPDATE_REGISTRY_UNREACHABLE',
    );
  });
});

describe('installCommand', () => {
  it('pins the version it reported rather than re-resolving latest', () => {
    expect(installCommand('0.9.0')).toBe('npm install -g hotplug@0.9.0');
    expect(installCommand()).toBe('npm install -g hotplug@latest');
  });
});
