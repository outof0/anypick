import { describe, it, expect } from 'vitest';
import { hintsForError } from '../src/cli/ux';
import { AnyPickError } from '../src/utils/errors';
import { completionScript } from '../src/cli/completion';

describe('error hints', () => {
  it('maps known codes to next steps', () => {
    const hints = hintsForError(new AnyPickError('nope', 'NO_LIVE_AUTH'));
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.some((h) => h.includes('login'))).toBe(true);
  });

  it('returns empty for unknown errors', () => {
    expect(hintsForError(new Error('boom'))).toEqual([]);
  });
});

describe('completion scripts', () => {
  it('emits zsh/bash/fish for primary commands', () => {
    for (const shell of ['zsh', 'bash', 'fish'] as const) {
      const script = completionScript(shell);
      expect(script).toContain('anypick');
      expect(script).toMatch(/use|run|current/);
      expect(script).not.toMatch(/\bswitch\b.*stash|\bapply\b.*profile/);
      expect(script.length).toBeGreaterThan(100);
    }
  });
});
