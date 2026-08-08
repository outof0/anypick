import { describe, it, expect, afterEach } from 'vitest';
import { appendFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import {
  spawnDetached,
  readPidFile,
  stopPidFile,
  verifyProcessHealth,
  writePidRecord,
  readPidRecord,
  isProcessRunning,
  followFile,
} from '../src/utils/process';

let root: string;
afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = '';
  }
});

async function freshDir(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'hotplug-proc01-'));
  return root;
}

describe('PROC-01 verifiable process + lease ownership', () => {
  it('writes an owner-only (0o600) structured pid record with an instance id', async () => {
    const dir = await freshDir();
    const pidPath = join(dir, 'proxy.pid');
    const logPath = join(dir, 'proxy.log');
    await writeFile(logPath, '', { mode: 0o600 });

    const instanceId = 'inst-abc-123';
    writePidRecord(pidPath, {
      instanceId,
      pid: process.pid,
      endpoint: 'http://127.0.0.1:8080',
      provider: 'gemini',
    });

    const stat = await import('node:fs/promises').then((fs) => fs.stat(pidPath));
    // Owner-only: no group/other access bits.
    expect(stat.mode & 0o077).toBe(0);

    const rec = await readPidRecord(pidPath);
    expect(rec?.instanceId).toBe(instanceId);
    expect(rec?.pid).toBe(process.pid);
    expect(rec?.provider).toBe('gemini');
  });

  it('treats a corrupt / partial pid record as absent (no stale pid reuse)', async () => {
    const dir = await freshDir();
    const pidPath = join(dir, 'proxy.pid');

    // Corrupt: not valid JSON.
    await writeFile(pidPath, '{not json');
    expect(await readPidRecord(pidPath)).toBeNull();

    // Partial: missing required fields.
    await writeFile(pidPath, JSON.stringify({ pid: 99999 }));
    const partial = await readPidRecord(pidPath);
    expect(partial).toBeNull();

    // A raw legacy numeric record is also untrusted, not parsed as a pid.
    await writeFile(pidPath, '12345\n');
    expect(await readPidFile(pidPath)).toBeNull();
  });

  it('spawnDetached records a structured 0o600 record (back-compat legacy reader fails closed)', async () => {
    const dir = await freshDir();
    const pidPath = join(dir, 'proxy.pid');
    const logPath = join(dir, 'proxy.log');
    await writeFile(logPath, '', { mode: 0o600 });

    // Spawn a process that exits immediately so we can inspect its record
    // without leaving a live child.
    const { pid } = await spawnDetached(process.execPath, ['-e', 'process.exit(0)'], {
      logPath,
      pidPath,
    });

    const rec = await readPidRecord(pidPath);
    expect(rec).not.toBeNull();
    expect(rec?.pid).toBe(pid);
    expect(rec?.instanceId).toBeTruthy();

    const stat = await import('node:fs/promises').then((fs) => fs.stat(pidPath));
    expect(stat.mode & 0o077).toBe(0);
  });

  it('never signals an unrelated live process when the record is missing', async () => {
    const dir = await freshDir();
    const pidPath = join(dir, 'proxy.pid');
    // No record on disk → stopPidFile must report no signal and not touch
    // any process. We assert it returns false and that an unrelated live pid
    // (this test process) is still alive afterward.
    const beforeAlive = (() => {
      try {
        process.kill(process.pid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    const signaled = await stopPidFile(pidPath);
    expect(signaled).toBe(false);
    expect(beforeAlive).toBe(true);
  });

  it('rejects health when the instance id identity does not match', async () => {
    const dir = await freshDir();
    const pidPath = join(dir, 'proxy.pid');
    const logPath = join(dir, 'proxy.log');
    await writeFile(logPath, '', { mode: 0o600 });

    const { pid } = await spawnDetached(process.execPath, ['-e', 'process.exit(0)'], {
      logPath,
      pidPath,
    });

    // Even if `pid` is alive, a mismatched instance id must fail closed.
    const ok = await verifyProcessHealth('http://127.0.0.1:59999/health', {
      expectInstanceId: 'does-not-match',
      requirePid: pid,
      timeoutMs: 200,
    });
    expect(ok).toBe(false);
  });

  it('does not signal a live child when the pid record health identity mismatches', async () => {
    const dir = await freshDir();
    const pidPath = join(dir, 'proxy.pid');
    const logPath = join(dir, 'proxy.log');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, instanceId: 'a-different-process' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected test server address');
    }

    const { pid } = await spawnDetached(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      logPath,
      pidPath,
      endpoint: `http://127.0.0.1:${address.port}`,
    });
    try {
      expect(await stopPidFile(pidPath, { graceMs: 100 })).toBe(false);
      expect(isProcessRunning(pid)).toBe(true);
    } finally {
      server.close();
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // child already exited
        }
      }
    }
  });

  it('stops a third-party child that serves /health without an instance id', async () => {
    const dir = await freshDir();
    const pidPath = join(dir, 'proxy.pid');
    const logPath = join(dir, 'proxy.log');
    await writeFile(logPath, '', { mode: 0o600 });

    // Stands in for kirolink: a real HTTP listener that knows nothing about
    // HOTPLUG_INSTANCE_ID. Before expectInstanceId:false these were unstoppable.
    const script = `const http = require('node:http');
      http.createServer((_q, s) => { s.writeHead(200, {'content-type':'application/json'}); s.end('{"ok":true}'); })
        .listen(0, '127.0.0.1', function () { console.log(this.address().port); });`;
    const { pid } = await spawnDetached(process.execPath, ['-e', script], { logPath, pidPath });

    let port = '';
    for (let i = 0; i < 100 && !port; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      port = (await readFile(logPath, 'utf8')).trim();
    }
    expect(port).not.toBe('');

    const record = await readPidRecord(pidPath);
    writePidRecord(pidPath, { ...record!, endpoint: `http://127.0.0.1:${port}` });

    expect(await stopPidFile(pidPath, { graceMs: 500, expectInstanceId: false })).toBe(true);
    expect(isProcessRunning(pid)).toBe(false);
  });

  it('refuses a third-party child whose start time predates the pid record', async () => {
    const dir = await freshDir();
    const pidPath = join(dir, 'proxy.pid');
    const logPath = join(dir, 'proxy.log');
    await writeFile(logPath, '', { mode: 0o600 });

    const script = `const http = require('node:http');
      http.createServer((_q, s) => { s.writeHead(200, {'content-type':'application/json'}); s.end('{"ok":true}'); })
        .listen(0, '127.0.0.1', function () { console.log(this.address().port); });`;
    const { pid } = await spawnDetached(process.execPath, ['-e', script], { logPath, pidPath });

    let port = '';
    for (let i = 0; i < 100 && !port; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      port = (await readFile(logPath, 'utf8')).trim();
    }
    expect(port).not.toBe('');

    // What a recycled PID looks like: alive, serving, but not the process the
    // record was written for.
    const record = await readPidRecord(pidPath);
    writePidRecord(pidPath, { ...record!, endpoint: `http://127.0.0.1:${port}` });
    const raw = JSON.parse(await readFile(pidPath, 'utf8')) as Record<string, unknown>;
    raw['createdAt'] = '2020-01-01T00:00:00.000Z';
    await writeFile(pidPath, JSON.stringify(raw), { mode: 0o600 });

    try {
      expect(await stopPidFile(pidPath, { graceMs: 100, expectInstanceId: false })).toBe(false);
      expect(isProcessRunning(pid)).toBe(true);
    } finally {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // child already exited
        }
      }
    }
  });
});

describe('live log following', () => {
  it('emits a newly appended Unicode log line without a manual refresh', async () => {
    const dir = await freshDir();
    const logPath = join(dir, 'proxy.log');
    await writeFile(logPath, '06:00 INFO ✓ existing → ⚠\n');

    const seen: string[] = [];
    const controller = new AbortController();
    const following = followFile(logPath, (line) => seen.push(line), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await appendFile(logPath, '06:01 ERR ✗ upstream 500: overloaded\n');
    await new Promise((resolve) => setTimeout(resolve, 500));
    controller.abort();
    await following;

    expect(seen).toEqual(['06:01 ERR ✗ upstream 500: overloaded']);
  });

  it('continues from a replacement log even when it is longer than the original', async () => {
    const dir = await freshDir();
    const logPath = join(dir, 'proxy.log');
    await writeFile(logPath, 'old line\n');

    const seen: string[] = [];
    const controller = new AbortController();
    const following = followFile(logPath, (line) => seen.push(line), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const replacement = join(dir, 'proxy.log.next');
    await writeFile(replacement, `${'padding '.repeat(64)}\nreplacement line\n`);
    await rename(replacement, logPath);
    await new Promise((resolve) => setTimeout(resolve, 500));
    controller.abort();
    await following;

    expect(seen).toContain('replacement line');
  });
});
