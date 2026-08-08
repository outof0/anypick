import { join } from 'node:path';
import { homedir } from 'node:os';
import { rm } from 'node:fs/promises';
import type {
  Account,
  AccountMeta,
  LiveAuthStatus,
  LiveUsage,
  Provider,
  SourceAdapter,
} from '../types';
import { parseCodexUsage } from './codex-usage';
import { OPENAI_MODELS } from '../catalog/providers';
import { codexAccountAdapter } from '../sources/account-adapters';
import {
  backupRequiredFile,
  expandHome,
  pathExists,
  readJsonFile,
  restoreRequiredFile,
  writeJsonFile,
} from '../utils/fs';
import { refreshCodexAuth, type CodexAuthFile } from './codex-refresh';
import { fingerprintLiveAuth, fingerprintSnapshot } from './auth-fingerprint';
import { hasCodexAuth, codexAccountId, extractCodexIdentity } from './codex-identity';

/**
 * OpenAI Codex CLI + Desktop
 *
 * CLI live auth: ~/.codex/auth.json
 * Desktop app may keep a different in-memory ChatGPT account (multi-account),
 * but AnyPick can only back up and restore ~/.codex/auth.json. Therefore
 * detectLive() deliberately reports that file, keeping detection, backup,
 * restore, and snapshot matching on one authority.
 */
export class CodexProvider implements Provider {
  readonly id = 'codex';
  readonly name = 'OpenAI Codex';
  readonly shortName = 'Codex';
  readonly description = 'Manages ~/.codex/auth.json';

  roleDefaults(): Record<string, string> {
    return { default: 'gpt-5.6-sol' };
  }

  suggestModels(): Record<string, string> {
    return { ...OPENAI_MODELS };
  }

  roleFriendlyModels(): readonly string[] {
    return ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.3-codex'];
  }

  staticFallbackModels(): readonly string[] {
    return ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.3-codex'];
  }

  constructor(
    private readonly home = homedir(),
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  sourceAdapter(account: Account): SourceAdapter {
    return codexAccountAdapter(account);
  }

  private get authPath(): string {
    return process.env.CODEX_AUTH_PATH ?? join(this.home, '.codex', 'auth.json');
  }

  async detectLive(): Promise<LiveAuthStatus> {
    return this.detectFromAuthFile();
  }

  /**
   * Read the Codex/ChatGPT rate-limit snapshot for auth.json only. When
   * Codex Desktop reports another account as active, auth.json may be stale;
   * in that case return nothing rather than risk showing another account's
   * quota.
   */
  async liveUsage(): Promise<LiveUsage | null> {
    const file = await this.detectFromAuthFile();
    if (!file.present || !file.accountId) {
      return null;
    }
    const desktop = await this.detectFromDesktopApp();
    if (desktop?.accountId && desktop.accountId !== file.accountId) {
      return null;
    }

    try {
      const auth = await readJsonFile<CodexAuthFile>(this.authPath);
      const accessToken = auth.tokens?.access_token;
      if (!accessToken) {
        return null;
      }
      const response = await this.fetchFn('https://chatgpt.com/backend-api/wham/usage', {
        headers: {
          authorization: `Bearer ${accessToken}`,
          'chatgpt-account-id': file.accountId,
        },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        return null;
      }
      return parseCodexUsage(await response.json());
    } catch {
      // Usage is optional; account detection/switching must remain available.
      return null;
    }
  }

  /** CLI / file-based session (~/.codex/auth.json). */
  private async detectFromAuthFile(): Promise<LiveAuthStatus & { accountId?: string }> {
    const path = this.authPath;
    if (!(await pathExists(path))) {
      return { present: false };
    }
    try {
      const data = await readJsonFile<Record<string, unknown>>(path);
      if (!hasCodexAuth(data)) {
        return { present: false };
      }
      const identity = extractCodexIdentity(data);
      const accountId = codexAccountId(data);
      const mode = typeof data.auth_mode === 'string' ? data.auth_mode : undefined;
      return {
        present: true,
        identity,
        accountId,
        details: [mode, accountId ? `acct:${accountId.slice(0, 8)}` : null]
          .filter(Boolean)
          .join(' '),
      };
    } catch {
      return { present: true, details: 'auth.json present (unreadable)' };
    }
  }

  /**
   * Codex Desktop writes the signed-in ChatGPT account into Sentry scope
   * (and rate-limit UI state). That is often ahead of ~/.codex/auth.json
   * after an in-app account switch.
   */
  private async detectFromDesktopApp(): Promise<{
    accountId: string;
    identity?: string;
  } | null> {
    const candidates = [
      join(this.home, 'Library', 'Application Support', 'Codex', 'sentry', 'scope_v3.json'),
      // Linux / other
      join(this.home, '.config', 'Codex', 'sentry', 'scope_v3.json'),
    ];

    for (const path of candidates) {
      if (!(await pathExists(path))) {
        continue;
      }
      try {
        const raw = await readJsonFile<Record<string, unknown>>(path);
        const scope = (raw.scope ?? raw) as Record<string, unknown>;
        const user = scope.user as Record<string, unknown> | undefined;
        if (!user || typeof user !== 'object') {
          continue;
        }
        const accountId = typeof user.account_id === 'string' ? user.account_id.trim() : '';
        if (!accountId) {
          continue;
        }
        // Optional: only trust ChatGPT auth method
        const method = typeof user.authMethod === 'string' ? user.authMethod : undefined;
        if (method && method !== 'chatgpt') {
          continue;
        }
        return {
          accountId,
          identity: typeof user.email === 'string' ? user.email : undefined,
        };
      } catch {
        // try next path
      }
    }

    // Fallback: rate-limit dismissal map keys are ChatGPT account ids the app knows.
    // Prefer the most recently dismissed / only key when sentry is missing.
    try {
      const statePath = join(this.home, '.codex', '.codex-global-state.json');
      if (await pathExists(statePath)) {
        const state = await readJsonFile<Record<string, unknown>>(statePath);
        const atom = state['electron-persisted-atom-state'] as Record<string, unknown> | undefined;
        const map = atom?.['rate-limit-reset-home-announcement-dismissal-by-account-id'] as
          | Record<string, { dismissedAtMs?: number }>
          | undefined;
        if (map && typeof map === 'object') {
          const entries = Object.entries(map);
          if (entries.length === 1 && entries[0]?.[0]) {
            return { accountId: entries[0][0] };
          }
          // most recently dismissed
          let best: { id: string; ts: number } | null = null;
          for (const [id, v] of entries) {
            const ts = typeof v?.dismissedAtMs === 'number' ? v.dismissedAtMs : 0;
            if (!best || ts > best.ts) {
              best = { id, ts };
            }
          }
          if (best?.id) {
            return { accountId: best.id };
          }
        }
      }
    } catch {
      // ignore
    }

    return null;
  }

  async backup(
    destDir: string,
  ): Promise<Partial<Pick<AccountMeta, 'identity' | 'label' | 'notes'>>> {
    const dest = join(destDir, 'auth.json');
    await backupRequiredFile(this.authPath, dest, 'Codex auth.json');
    try {
      const data = await readJsonFile<Record<string, unknown>>(dest);
      return { identity: extractCodexIdentity(data) };
    } catch {
      return {};
    }
  }

  async restore(srcDir: string): Promise<void> {
    await restoreRequiredFile(join(srcDir, 'auth.json'), expandHome(this.authPath), 'auth.json');
  }

  async describeSnapshot(
    srcDir: string,
  ): Promise<Partial<Pick<AccountMeta, 'identity' | 'label' | 'notes'>>> {
    const path = join(srcDir, 'auth.json');
    if (!(await pathExists(path))) {
      return {};
    }
    try {
      const data = await readJsonFile<Record<string, unknown>>(path);
      return { identity: extractCodexIdentity(data) };
    } catch {
      return {};
    }
  }

  /**
   * Delete local auth.json only — does NOT call OpenAI logout/revoke.
   * Saved anypick snapshots remain valid for restore.
   */
  async clearLive(): Promise<void> {
    const path = expandHome(this.authPath);
    for (const p of [path, `${path}.lock`]) {
      try {
        await rm(p, { force: true });
      } catch {
        // ignore
      }
    }
  }

  /**
   * Refresh ChatGPT OAuth tokens inside a snapshot dir (auth.json).
   */
  async refreshAuth(
    authDir: string,
  ): Promise<Partial<Pick<AccountMeta, 'identity' | 'label' | 'notes'>>> {
    const path = join(authDir, 'auth.json');
    if (!(await pathExists(path))) {
      throw new Error(`No auth.json in ${authDir}`);
    }
    const current = await readJsonFile<CodexAuthFile>(path);
    const { auth, identity } = await refreshCodexAuth(current);
    await writeJsonFile(path, auth, 0o600);
    return { identity };
  }

  /**
   * Compare this snapshot's session material against the live Codex login.
   * Prefers refresh_token (unique per session) over account_id so two
   * snapshots of the same ChatGPT account are not both marked live.
   */
  async snapshotMatchesLive(snapshotDir: string): Promise<boolean> {
    const liveFp = await fingerprintLiveAuth('codex', this.home);
    if (!liveFp) {
      return false;
    }
    const snap = await fingerprintSnapshot('codex', snapshotDir);
    return snap != null && snap === liveFp;
  }
}

export const codexProvider = new CodexProvider();
