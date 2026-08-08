import { describe, expect, it } from 'vitest';
import { terminalLaunchCandidates } from '../src/tray/terminal-launcher';

describe('tray terminal launcher', () => {
  it('prefers iTerm2 and falls back to Terminal on macOS', () => {
    expect(terminalLaunchCandidates('darwin', {}, '/node', '/anypick.js')).toEqual([
      { kind: 'mac-app', application: 'iTerm2' },
      { kind: 'mac-app', application: 'Terminal' },
    ]);
  });

  it('uses the configured Linux terminal before standard desktop candidates', () => {
    const candidates = terminalLaunchCandidates(
      'linux',
      { TERMINAL: 'kitty' },
      '/node',
      '/anypick.js',
    );
    expect(candidates[0]).toEqual({
      kind: 'process',
      command: 'kitty',
      args: ['--', '/node', '/anypick.js'],
    });
    expect(candidates.some((candidate) => candidate.kind === 'mac-app')).toBe(false);
  });

  it('prefers Windows Terminal and keeps PowerShell/cmd fallbacks', () => {
    const candidates = terminalLaunchCandidates('win32', {}, 'node.exe', 'anypick.js');
    expect(candidates[0]).toEqual({
      kind: 'process',
      command: 'wt.exe',
      args: ['new-tab', 'node.exe', 'anypick.js'],
    });
    expect(candidates.map((candidate) => candidate.kind)).toEqual([
      'process',
      'process',
      'process',
    ]);
  });
});
