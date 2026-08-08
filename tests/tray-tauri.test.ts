import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { tauriTrayBinaryCandidates, tauriTrayBinaryName } from '../src/tray/supervisor-tauri';
import { nativeTrayNeedsRestart } from '../src/tray/supervisor-native';

describe('Tauri tray helper resolution', () => {
  it('maps supported Linux and Windows targets to packaged binary names', () => {
    expect(tauriTrayBinaryName('linux', 'x64')).toBe('anypick-tray-linux-x64');
    expect(tauriTrayBinaryName('linux', 'arm64')).toBe('anypick-tray-linux-arm64');
    expect(tauriTrayBinaryName('win32', 'x64')).toBe('anypick-tray-win32-x64.exe');
    expect(tauriTrayBinaryName('win32', 'arm64')).toBe('anypick-tray-win32-arm64.exe');
    expect(tauriTrayBinaryName('darwin', 'arm64')).toBeUndefined();
    expect(tauriTrayBinaryName('linux', 'ia32')).toBeUndefined();
  });

  it('resolves the packaged location without probing the host platform', () => {
    expect(
      tauriTrayBinaryCandidates({
        platform: 'win32',
        arch: 'x64',
        moduleDirectory: '/package/dist/tray',
      }),
    ).toEqual([join('/package/dist/tray', 'bin', 'anypick-tray-win32-x64.exe')]);
  });

  it('only accepts an absolute explicit helper path', () => {
    expect(
      tauriTrayBinaryCandidates({
        platform: 'linux',
        arch: 'x64',
        override: '/opt/anypick/anypick-tray',
      }),
    ).toEqual(['/opt/anypick/anypick-tray']);
    expect(() =>
      tauriTrayBinaryCandidates({ platform: 'linux', arch: 'x64', override: './tray' }),
    ).toThrow('must be an absolute path');
  });

  it('treats a missing native helper fingerprint as stale on macOS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anypick-tray-fingerprint-'));
    try {
      await expect(nativeTrayNeedsRestart(root, 'darwin')).resolves.toBe(true);
      await expect(nativeTrayNeedsRestart(root, 'linux')).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
