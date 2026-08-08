import { describe, it, expect, afterEach } from 'vitest';
import { createTestEnv, type FakeProvider } from './helpers';

const fakesToClean: FakeProvider[] = [];

afterEach(async () => {
  for (const f of fakesToClean.splice(0)) {
    await f.dispose();
  }
});

describe('proxy lifecycle', () => {
  it('enable / switch starts proxy and reports endpoint', async () => {
    const { service, fakes } = await createTestEnv(['grok'], {
      supportsProxy: true,
    });
    fakesToClean.push(fakes.grok);

    await fakes.grok.setLive({ email: 'a@x', token: '1' });
    await service.save('grok', 'work');

    const { started } = await service.proxy.enableProxy('grok', 'work', {
      port: 0,
    });
    expect(started?.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const status = await service.proxy.proxyStatus('grok', 'work');
    expect(status.enabled).toBe(true);
    expect(status.running).toBe(true);
    expect(status.endpoint).toBe(started?.endpoint);
    expect(status.compatibility).toBe('Test API');

    // Live endpoint responds
    const res = await fetch(started!.endpoint);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: string };
    expect(body.account).toBe('work');
  });

  it('uses the live runtime endpoint when saved port drifts', async () => {
    const { service, fakes, store } = await createTestEnv(['grok'], {
      supportsProxy: true,
    });
    fakesToClean.push(fakes.grok);

    await fakes.grok.setLive({ email: 'a@x', token: '1' });
    await service.save('grok', 'work');
    const result = await service.proxy.enableProxy('grok', 'work', {
      port: 0,
    });
    expect(result.started?.endpoint).toBeTruthy();

    await store.setProxyConfig('grok', 'work', { enabled: true, port: 19999 });
    const status = await service.proxy.proxyStatus('grok', 'work');

    expect(status.running).toBe(true);
    expect(status.endpoint).toBe(result.started?.endpoint);
    expect(status.port).toBe(Number(new URL(result.started!.endpoint).port));
  });

  it('switch stops previous proxy and starts next', async () => {
    const { service, fakes } = await createTestEnv(['grok'], {
      supportsProxy: true,
    });
    fakesToClean.push(fakes.grok);

    await fakes.grok.setLive({ email: 'a@x', token: '1' });
    await service.save('grok', 'work');
    await service.proxy.enableProxy('grok', 'work', { port: 0 });

    await fakes.grok.setLive({ email: 'b@x', token: '2' });
    await service.save('grok', 'personal');
    await service.proxy.enableProxy('grok', 'personal', {
      port: 0,
      start: false,
    });

    const result = await service.use('grok', 'personal');
    expect(result.proxy?.running).toBe(true);
    expect(result.proxy?.endpoint).toMatch(/^http:\/\//);

    const workStatus = await service.proxy.proxyStatus('grok', 'work');
    expect(workStatus.running).toBe(false);

    const personalStatus = await service.proxy.proxyStatus('grok', 'personal');
    expect(personalStatus.running).toBe(true);
  });

  it('disable stops a running proxy', async () => {
    const { service, fakes } = await createTestEnv(['grok'], {
      supportsProxy: true,
    });
    fakesToClean.push(fakes.grok);

    await fakes.grok.setLive({ email: 'a@x', token: '1' });
    await service.save('grok', 'work');
    await service.proxy.enableProxy('grok', 'work', { port: 0 });

    await service.proxy.disableProxy('grok', 'work');
    const status = await service.proxy.proxyStatus('grok', 'work');
    expect(status.enabled).toBe(false);
    expect(status.running).toBe(false);
  });

  it('stop without a target stops every running account, including inactive ones', async () => {
    const { service, fakes } = await createTestEnv(['grok'], {
      supportsProxy: true,
    });
    fakesToClean.push(fakes.grok);

    await fakes.grok.setLive({ email: 'a@x', token: '1' });
    await service.save('grok', 'work');
    await service.proxy.enableProxy('grok', 'work', { port: 0 });
    await fakes.grok.setLive({ email: 'b@x', token: '2' });
    await service.save('grok', 'personal');
    await service.proxy.enableProxy('grok', 'personal', { port: 0 });
    await service.proxy.startProxy('grok', 'personal');

    expect((await service.proxy.proxyStatus('grok', 'work')).running).toBe(true);
    expect((await service.proxy.proxyStatus('grok', 'personal')).running).toBe(true);

    const stopped = await service.proxy.stopProxies();
    expect(stopped).toEqual([
      expect.objectContaining({ provider: 'grok', name: 'personal', ok: true }),
      expect.objectContaining({ provider: 'grok', name: 'work', ok: true }),
    ]);
    expect((await service.proxy.proxyStatus('grok', 'work')).running).toBe(false);
    expect((await service.proxy.proxyStatus('grok', 'personal')).running).toBe(false);
  });

  it('providers without proxy support reject proxy commands', async () => {
    const { service, fakes } = await createTestEnv(['codex'], {
      supportsProxy: false,
    });
    fakesToClean.push(fakes.codex);

    await fakes.codex.setLive({ email: 'c@x', token: 'c' });
    await service.save('codex', 'work');

    await expect(service.proxy.enableProxy('codex', 'work')).rejects.toMatchObject({
      code: 'PROXY_UNSUPPORTED',
    });
  });

  it('switch without proxy enabled does not start proxy', async () => {
    const { service, fakes } = await createTestEnv(['grok'], {
      supportsProxy: true,
    });
    fakesToClean.push(fakes.grok);

    await fakes.grok.setLive({ email: 'a@x', token: '1' });
    await service.save('grok', 'work');

    const result = await service.use('grok', 'work');
    expect(result.proxy?.enabled).toBe(false);
    expect(result.proxy?.running).toBe(false);
  });

  it('preserves proxy config across save (token refresh)', async () => {
    const { service, fakes, store } = await createTestEnv(['grok'], {
      supportsProxy: true,
    });
    fakesToClean.push(fakes.grok);

    await fakes.grok.setLive({ email: 'a@x', token: '1' });
    await service.save('grok', 'work');
    await service.proxy.enableProxy('grok', 'work', {
      port: 9999,
      host: '127.0.0.1',
      start: false,
    });

    await fakes.grok.setLive({ email: 'a@x', token: 'refreshed' });
    await service.save('grok', 'work');

    const cfg = await store.getProxyConfig('grok', 'work');
    expect(cfg.enabled).toBe(true);
    expect(cfg.port).toBe(9999);
  });

  it('reads proxy logs', async () => {
    const { service, fakes } = await createTestEnv(['grok'], {
      supportsProxy: true,
    });
    fakesToClean.push(fakes.grok);

    await fakes.grok.setLive({ email: 'a@x', token: '1' });
    await service.save('grok', 'work');
    await service.proxy.enableProxy('grok', 'work', { port: 0 });

    const logs = await service.proxy.proxyLogs('grok', 'work');
    expect(logs).toContain('started');
    expect(logs).toContain('work');
  });

  it('delete stops proxy', async () => {
    const { service, fakes } = await createTestEnv(['grok'], {
      supportsProxy: true,
    });
    fakesToClean.push(fakes.grok);

    await fakes.grok.setLive({ email: 'a@x', token: '1' });
    await service.save('grok', 'work');
    const { started } = await service.proxy.enableProxy('grok', 'work', {
      port: 0,
    });
    expect(started).toBeTruthy();

    await service.delete('grok', 'work');
    // server map should be empty after dispose path
    const status = await fakes.grok.proxyStatus?.({
      providerId: 'grok',
      accountName: 'work',
      snapshotDir: '',
      runtimeDir: '/tmp',
      config: { enabled: true },
    });
    expect(status?.running).toBe(false);
  });

  it('auto-allocates distinct ports per account', async () => {
    const { service, fakes } = await createTestEnv(['grok'], {
      supportsProxy: true,
    });
    fakesToClean.push(fakes.grok);

    await fakes.grok.setLive({ email: 'a@x', token: '1' });
    await service.save('grok', 'work');
    await fakes.grok.setLive({ email: 'b@x', token: '2' });
    await service.save('grok', 'personal');

    const a = await service.proxy.enableProxy('grok', 'work', { start: false });
    const b = await service.proxy.enableProxy('grok', 'personal', {
      start: false,
    });

    expect(a.config.port).toBeTypeOf('number');
    expect(b.config.port).toBeTypeOf('number');
    expect(a.config.port).not.toBe(b.config.port);
  });

  it('rejects duplicate explicit ports', async () => {
    const { service, fakes } = await createTestEnv(['grok'], {
      supportsProxy: true,
    });
    fakesToClean.push(fakes.grok);

    await fakes.grok.setLive({ email: 'a@x', token: '1' });
    await service.save('grok', 'work');
    await fakes.grok.setLive({ email: 'b@x', token: '2' });
    await service.save('grok', 'personal');

    await service.proxy.enableProxy('grok', 'work', {
      port: 19001,
      start: false,
    });
    await expect(
      service.proxy.enableProxy('grok', 'personal', {
        port: 19001,
        start: false,
      }),
    ).rejects.toMatchObject({ code: 'PROXY_PORT_IN_USE' });
  });

  it('configureProxy changes port', async () => {
    const { service, fakes } = await createTestEnv(['grok'], {
      supportsProxy: true,
    });
    fakesToClean.push(fakes.grok);

    await fakes.grok.setLive({ email: 'a@x', token: '1' });
    await service.save('grok', 'work');
    await service.proxy.enableProxy('grok', 'work', {
      port: 19010,
      start: false,
    });

    const { config } = await service.proxy.configureProxy('grok', 'work', {
      port: 19011,
      restart: false,
    });
    expect(config.port).toBe(19011);

    const status = await service.proxy.proxyStatus('grok', 'work');
    expect(status.port).toBe(19011);
  });

  it('configureProxy actually replaces a running process', async () => {
    const { service, fakes } = await createTestEnv(['grok'], {
      supportsProxy: true,
    });
    fakesToClean.push(fakes.grok);

    await fakes.grok.setLive({ email: 'a@x', token: '1' });
    await service.save('grok', 'work');
    await service.proxy.enableProxy('grok', 'work', { port: 0 });

    const result = await service.proxy.configureProxy('grok', 'work', {
      options: { transport: 'changed' },
    });

    expect(result.wasRunning).toBe(true);
    expect(result.restarted?.startedNow).toBe(true);
    expect((await service.proxy.proxyStatus('grok', 'work')).running).toBe(true);
  });
});
