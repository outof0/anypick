/**
 * Global test setup: redirect HOME to a throwaway directory so that any code
 * path which writes into the user's real home (notably ~/.claude/settings.json
 * via the claude client) can never clobber the developer's live config while
 * the test suite runs.
 *
 * Tests that need a writable home should still create their own mkdtemp home on
 * top of this; this is a safety net for clients that fall back to HOME.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'anypick-test-home-'));
process.env.HOME = fakeHome;
// Snapshot/render assertions exercise the normal Unicode UI. The desktop test
// runner itself uses TERM=dumb, which would otherwise make import-time glyph
// selection depend on the host rather than the test contract.
process.env.TERM = 'xterm-256color';

// The Kiro provider reads and *writes* the macOS keychain, which no HOME
// redirect can sandbox. Tests exercise the SQLite tier only.
process.env.ANYPICK_KIRO_NO_KEYCHAIN = '1';
// Claude Code uses macOS Keychain as its native auth authority. Tests exercise
// a temp HOME/file store unless they inject an explicit fake store.
process.env.ANYPICK_CLAUDE_NO_KEYCHAIN = '1';

// Best-effort cleanup of the fake home when the test process exits.
process.once('exit', () => {
  try {
    rmSync(fakeHome, { recursive: true, force: true });
  } catch {
    // nothing we can do on the way out
  }
});
