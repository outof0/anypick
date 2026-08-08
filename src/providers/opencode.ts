import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  Account,
  AccountMeta,
  LiveAuthStatus,
  ModelDiscoveryContext,
  Provider,
  ProxyContext,
  ProxyHubBackendContext,
  ProxyHubBackendHandle,
  ProxyHandle,
  ProxyStatus,
  SourceAdapter,
} from '../types';
import { opencodeAccountAdapter, poolAdapterFor } from '../sources/account-adapters';
import {
  backupRequiredFile,
  copyFileSafe,
  ensureDir,
  pathExists,
  readJsonFile,
  restoreRequiredFile,
  writeJsonFile,
} from '../utils/fs';
import { snapshotMatchesLiveDefault } from './auth-fingerprint';
import {
  extractOpenCodeIdentity,
  hasAnyAuth,
  refreshOpenCodeAuth,
  summarizeAuth,
} from './opencode-auth';
import { rolesFromLiveDiscovery } from './model-policy';
import {
  startOpenCodeProxy,
  stopOpenCodeProxy,
  openCodeProxyStatus,
  readOpenCodeProxyLogs,
} from './opencode-proxy-lifecycle';
import { listenOpenCodeProxy } from './opencode-proxy/server';
import { closeProxyHubBackend } from './proxy-hub-backend';
import { fetchOpenAiStyleModels } from '../catalog/model-fetch';
import { loadOpenCodeCredential } from './opencode-proxy/auth';

/**
 * OpenCode CLI — multi-provider auth (like Codex) + optional Zen/Go proxy.
 *
 * Live auth: ~/.local/share/opencode/auth.json
 *
 * Auth entry types (per provider id):
 *   oauth     — ChatGPT Plus/Pro, GitLab, xAI SuperGrok, … (refreshable)
 *   api       — API keys (OpenCode Zen/Go, DeepSeek, MiniMax, …)
 *   wellknown — remote org tokens
 *
 * Optional companion: account.json (multi-account map)
 *
 * Built-in proxy (optional) uses Zen/Go **api** keys only:
 *   Go:  https://opencode.ai/zen/go/v1
 *   Zen: https://opencode.ai/zen/v1
 *   Dual protocol for Codex + Claude Code.
 */
const DEFAULT_PORT = 4120;

export class OpenCodeProvider implements Provider {
  readonly id = 'opencode';
  readonly name = 'OpenCode';
  readonly shortName = 'OpenCode';
  readonly description = 'Manages OpenCode CLI auth (oauth + api keys) + optional Zen/Go proxy';
  readonly defaultProxyPort = DEFAULT_PORT;
  readonly proxyCompatibility = 'OpenAI + Anthropic API';

  // Static Claude maps mislead the OpenCode proxy — the real list comes from
  // /v1/models, which reflects the account's Zen/Go entitlements.
  roleDefaults(): Record<string, string> {
    return rolesFromLiveDiscovery();
  }

  async fetchLiveModels(ctx: ModelDiscoveryContext): Promise<readonly string[]> {
    let apiKey = ctx.apiKey;
    if (!apiKey && (await pathExists(this.authPath))) {
      try {
        const cred = await loadOpenCodeCredential(this.authPath);
        apiKey = cred.apiKey;
      } catch {
        // ignore
      }
    }
    const discoveryCtx = { ...ctx, ...(apiKey ? { apiKey } : {}) };
    const zenModels = await fetchOpenAiStyleModels({
      ...discoveryCtx,
      endpoint: ctx.endpoint ?? 'https://opencode.ai/zen',
    });
    const goModels = await fetchOpenAiStyleModels({
      ...discoveryCtx,
      endpoint: ctx.endpoint
        ? `${ctx.endpoint.replace(/\/$/, '')}/go`
        : 'https://opencode.ai/zen/go',
    });
    return [...new Set([...zenModels, ...goModels])];
  }

  constructor(private readonly home = homedir()) {}

  sourceAdapter(account: Account): SourceAdapter {
    return opencodeAccountAdapter(account);
  }

  poolSourceAdapter(): SourceAdapter {
    return poolAdapterFor(this.id, this);
  }

  async createProxyHubBackend(ctx: ProxyHubBackendContext): Promise<ProxyHubBackendHandle> {
    const [primary, ...rest] = ctx.accounts;
    if (!primary) {
      throw new Error('OpenCode Hub backend requires at least one account');
    }
    const options = primary.proxy.options ?? {};
    const authMode =
      options.authMode === 'public' || options.authMode === 'api' || options.authMode === 'auto'
        ? options.authMode
        : 'auto';
    const { server, endpoint } = await listenOpenCodeProxy({
      host: '127.0.0.1',
      port: 0,
      authPath: join(primary.snapshotDir, 'auth.json'),
      authPaths: rest.map((account) => join(account.snapshotDir, 'auth.json')),
      authAccountNames: ctx.accounts.map((account) => account.name),
      authMode,
      upstream: typeof options.upstream === 'string' ? options.upstream : undefined,
      modelMetadataUrl:
        options.modelMetadataUrl === false || typeof options.modelMetadataUrl === 'string'
          ? options.modelMetadataUrl
          : undefined,
      token: ctx.token,
      log: ctx.log,
    });
    return { endpoint, close: () => closeProxyHubBackend(server) };
  }

  private get dataDir(): string {
    if (process.env.OPENCODE_DATA_DIR) {
      return process.env.OPENCODE_DATA_DIR;
    }
    const xdgShare =
      this.home === homedir() && process.env.XDG_DATA_HOME
        ? process.env.XDG_DATA_HOME
        : join(this.home, '.local', 'share');
    return join(xdgShare, 'opencode');
  }

  private get authPath(): string {
    return process.env.OPENCODE_AUTH_PATH ?? join(this.dataDir, 'auth.json');
  }

  private get accountPath(): string {
    return join(this.dataDir, 'account.json');
  }

  async detectLive(): Promise<LiveAuthStatus> {
    if (!(await pathExists(this.authPath))) {
      return { present: false };
    }
    try {
      const data = await readJsonFile<Record<string, unknown>>(this.authPath);
      if (!hasAnyAuth(data)) {
        return { present: false };
      }
      return {
        present: true,
        identity: extractOpenCodeIdentity(data),
        details: summarizeAuth(data),
      };
    } catch {
      return { present: true, details: 'auth.json present (unreadable)' };
    }
  }

  async backup(
    destDir: string,
  ): Promise<Partial<Pick<AccountMeta, 'identity' | 'label' | 'notes'>>> {
    await ensureDir(destDir);
    await backupRequiredFile(this.authPath, join(destDir, 'auth.json'), 'OpenCode auth.json');
    // Best-effort multi-account map (OpenCode may keep parallel accounts)
    if (await pathExists(this.accountPath)) {
      await copyFileSafe(this.accountPath, join(destDir, 'account.json'));
    }
    try {
      const data = await readJsonFile<Record<string, unknown>>(join(destDir, 'auth.json'));
      return { identity: extractOpenCodeIdentity(data) };
    } catch {
      return {};
    }
  }

  async restore(srcDir: string): Promise<void> {
    await ensureDir(this.dataDir);
    await restoreRequiredFile(join(srcDir, 'auth.json'), this.authPath, 'auth.json');
    const accountSrc = join(srcDir, 'account.json');
    if (await pathExists(accountSrc)) {
      await copyFileSafe(accountSrc, this.accountPath);
    }
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
      return { identity: extractOpenCodeIdentity(data) };
    } catch {
      return {};
    }
  }

  /**
   * Clear local OpenCode auth only — does NOT revoke OAuth / API keys server-side.
   * Saved anypick snapshots stay valid for later restore (same as codex stash).
   */
  async clearLive(): Promise<void> {
    const { rm } = await import('node:fs/promises');
    for (const p of [this.authPath, this.accountPath]) {
      try {
        await rm(p, { force: true });
      } catch {
        // ignore
      }
    }
  }

  /**
   * Refresh OAuth tokens inside a snapshot (openai ChatGPT, etc.).
   * API-key providers are left as-is.
   */
  async refreshAuth(
    authDir: string,
  ): Promise<Partial<Pick<AccountMeta, 'identity' | 'label' | 'notes'>>> {
    const path = join(authDir, 'auth.json');
    if (!(await pathExists(path))) {
      throw new Error(`No auth.json in ${authDir}`);
    }
    const current = await readJsonFile<Record<string, unknown>>(path);
    const { data, identity } = await refreshOpenCodeAuth(current);
    await writeJsonFile(path, data, 0o600);
    return { identity };
  }

  async snapshotMatchesLive(snapshotDir: string): Promise<boolean> {
    return snapshotMatchesLiveDefault('opencode', snapshotDir);
  }

  // ── Built-in proxy (Zen/Go API keys → Codex + Claude) ───────────

  async startProxy(ctx: ProxyContext): Promise<ProxyHandle> {
    return startOpenCodeProxy(ctx, {
      authPath: this.authPath,
      compatibility: this.proxyCompatibility,
      defaultPort: DEFAULT_PORT,
    });
  }

  async stopProxy(ctx: ProxyContext): Promise<void> {
    await stopOpenCodeProxy(ctx);
  }

  async proxyStatus(ctx: ProxyContext): Promise<ProxyStatus> {
    return openCodeProxyStatus(ctx, this.proxyCompatibility, DEFAULT_PORT);
  }

  async readProxyLogs(ctx: ProxyContext, lines = 50): Promise<string> {
    return readOpenCodeProxyLogs(ctx, lines);
  }
}

export const opencodeProvider = new OpenCodeProvider();
