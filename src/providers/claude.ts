import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readFile, rm } from 'node:fs/promises';
import type { Account, LiveAuthStatus, Provider, SnapshotMeta, SourceAdapter } from '../types';
import { claudeAccountAdapter } from '../sources/account-adapters';
import { AnyPickError } from '../utils/errors';
import { pathExists, readJsonFile, writeJsonFile, writeTextFile } from '../utils/fs';

const execFileAsync = promisify(execFile);
const SECURITY_BIN = '/usr/bin/security';
const SECURITY_TIMEOUT_MS = 5_000;
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const SNAPSHOT_FILE = 'credentials.json';

interface ClaudeCredentialSnapshot {
  version: 1;
  account: string;
  credential: string;
}

export interface ClaudeCredentialStore {
  read(): Promise<{ account: string; credential: string } | null>;
  write(account: string, credential: string): Promise<void>;
  clear(account: string): Promise<void>;
}

interface ClaudeProviderOptions {
  credentialStore?: ClaudeCredentialStore;
  isOwnerRunning?: () => Promise<boolean>;
}

/**
 * Claude Code keeps OAuth/API credentials in macOS Keychain and falls back to
 * ~/.claude/.credentials.json on file-backed platforms. This store mirrors
 * those two authorities without ever putting the secret in process argv.
 */
export function createClaudeCredentialStore(home = homedir()): ClaudeCredentialStore {
  const account = userInfo().username;
  const file =
    process.env.ANYPICK_CLAUDE_CREDENTIALS_PATH ?? join(home, '.claude', '.credentials.json');
  const useKeychain =
    process.platform === 'darwin' && process.env.ANYPICK_CLAUDE_NO_KEYCHAIN !== '1';

  if (!useKeychain) {
    return {
      async read() {
        if (!(await pathExists(file))) {
          return null;
        }
        const credential = await readFile(file, 'utf8');
        return credential.trim() ? { account, credential } : null;
      },
      async write(_account, credential) {
        await writeTextFile(
          file,
          credential.endsWith('\n') ? credential : `${credential}\n`,
          0o600,
        );
      },
      async clear() {
        await rm(file, { force: true });
      },
    };
  }

  return {
    async read() {
      try {
        const { stdout } = await execFileAsync(
          SECURITY_BIN,
          ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-a', account, '-w'],
          { encoding: 'utf8', timeout: SECURITY_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        );
        const credential = stdout.trim();
        return credential ? { account, credential } : null;
      } catch {
        return null;
      }
    },
    async write(keychainAccount, credential) {
      const hex = Buffer.from(credential, 'utf8').toString('hex');
      await securityStdin(
        `add-generic-password -U -s ${quoteSecurityArgument(CLAUDE_KEYCHAIN_SERVICE)} -a ${quoteSecurityArgument(
          keychainAccount,
        )} -X ${hex}\n`,
      );
    },
    async clear(keychainAccount) {
      await securityStdin(
        `delete-generic-password -s ${quoteSecurityArgument(CLAUDE_KEYCHAIN_SERVICE)} -a ${quoteSecurityArgument(
          keychainAccount,
        )}\n`,
      );
    },
  };
}

export class ClaudeProvider implements Provider {
  readonly id = 'claude';
  readonly name = 'Anthropic Claude Code';
  readonly shortName = 'Claude';
  readonly description = 'Manages Claude Code native login credentials';

  private readonly credentials: ClaudeCredentialStore;
  private readonly isOwnerRunning: () => Promise<boolean>;

  constructor(home = homedir(), opts: ClaudeProviderOptions = {}) {
    this.credentials = opts.credentialStore ?? createClaudeCredentialStore(home);
    this.isOwnerRunning = opts.isOwnerRunning ?? claudeCodeApplicationRunning;
  }

  sourceAdapter(account: Account): SourceAdapter {
    return claudeAccountAdapter(account);
  }

  async detectLive(): Promise<LiveAuthStatus> {
    const current = await this.credentials.read();
    if (!current) {
      return { present: false };
    }
    return {
      present: true,
      identity: claudeCredentialIdentity(current.credential),
      details: 'Claude Code secure credential store',
    };
  }

  async backup(destDir: string): Promise<SnapshotMeta> {
    const current = await this.credentials.read();
    if (!current) {
      throw new AnyPickError('No signed-in Claude Code account was found.', 'NO_LIVE_AUTH');
    }
    await writeJsonFile(
      join(destDir, SNAPSHOT_FILE),
      {
        version: 1,
        account: current.account,
        credential: current.credential,
      } satisfies ClaudeCredentialSnapshot,
      0o600,
    );
    return { identity: claudeCredentialIdentity(current.credential) };
  }

  async preflightRestore(_srcDir: string): Promise<void> {
    if (await this.isOwnerRunning()) {
      throw new AnyPickError('Claude Code is still running.', {
        code: 'RESTORE_OWNER_RUNNING',
        suggestions: ['Quit Claude Code completely, then retry the account switch.'],
      });
    }
  }

  async restoreOwnerStatus(_srcDir: string): Promise<{ name: string; running: boolean }> {
    return { name: 'Claude Code', running: await this.isOwnerRunning() };
  }

  async restore(srcDir: string): Promise<void> {
    const snapshot = await readClaudeSnapshot(srcDir);
    await this.credentials.write(snapshot.account, snapshot.credential);
  }

  async clearLive(): Promise<void> {
    const current = await this.credentials.read();
    if (current) {
      await this.credentials.clear(current.account);
    }
  }

  async describeSnapshot(srcDir: string): Promise<SnapshotMeta> {
    const snapshot = await readClaudeSnapshot(srcDir).catch(() => null);
    return snapshot ? { identity: claudeCredentialIdentity(snapshot.credential) } : {};
  }

  async snapshotMatchesLive(srcDir: string): Promise<boolean> {
    const [current, snapshot] = await Promise.all([
      this.credentials.read().catch(() => null),
      readClaudeSnapshot(srcDir).catch(() => null),
    ]);
    if (!current || !snapshot) {
      return false;
    }
    return (
      claudeCredentialFingerprint(current.credential) ===
      claudeCredentialFingerprint(snapshot.credential)
    );
  }
}

async function readClaudeSnapshot(srcDir: string): Promise<ClaudeCredentialSnapshot> {
  const snapshot = await readJsonFile<ClaudeCredentialSnapshot>(join(srcDir, SNAPSHOT_FILE));
  if (
    snapshot.version !== 1 ||
    typeof snapshot.account !== 'string' ||
    !snapshot.account ||
    typeof snapshot.credential !== 'string' ||
    !snapshot.credential
  ) {
    throw new Error('Claude Code credential snapshot is invalid.');
  }
  return snapshot;
}

function claudeCredentialIdentity(raw: string): string | undefined {
  try {
    const root = JSON.parse(raw) as Record<string, unknown>;
    const oauth = root.claudeAiOauth as Record<string, unknown> | undefined;
    for (const candidate of [root.email, oauth?.email]) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
    const plan = oauth?.subscriptionType;
    return typeof plan === 'string' && plan.trim() ? `Claude ${plan.trim()}` : undefined;
  } catch {
    return undefined;
  }
}

function claudeCredentialFingerprint(raw: string): string {
  let stable = raw;
  try {
    const root = JSON.parse(raw) as Record<string, unknown>;
    const oauth = root.claudeAiOauth as Record<string, unknown> | undefined;
    const refresh = oauth?.refreshToken ?? oauth?.refresh_token;
    if (typeof refresh === 'string' && refresh.trim()) {
      stable = refresh.trim();
    }
  } catch {
    // A future credential envelope is still safely comparable as opaque text.
  }
  return createHash('sha256').update(stable).digest('hex');
}

async function claudeCodeApplicationRunning(): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return false;
  }
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'comm='], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.split(/\r?\n/gu).some((line) => {
      const executable = line.trim();
      return executable === 'claude' || executable.endsWith('/Claude.app/Contents/MacOS/Claude');
    });
  } catch {
    return false;
  }
}

function quoteSecurityArgument(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "'\\\\''")}'`;
}

function securityStdin(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(SECURITY_BIN, ['-i'], { timeout: SECURITY_TIMEOUT_MS }, (err) => {
      if (err) {
        reject(new Error('macOS Keychain rejected the Claude Code credential update.'));
      } else {
        resolve();
      }
    });
    child.stdin?.end(command);
  });
}

export const claudeProvider = new ClaudeProvider();
