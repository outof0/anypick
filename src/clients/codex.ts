import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import type {
  ApplyContext,
  ClientAdapter,
  ClientInspectResult,
  ClientLiveState,
  ClientState,
  IsolatablePath,
  IsolatedClientRuntime,
  ModelCatalogDescriptor,
  ModelInputModality,
  ModelReasoningLevel,
  ResolvedClientPlan,
} from '../types';
import { configuredModelCatalog, mergeModelCatalogs } from '../core/model-policy';
import { AnyPickError } from '../utils/errors';
import { ensureDir, pathExists, writeJsonFile, writeTextFile } from '../utils/fs';
import { resolveFromContext } from './resolve';
import { removeClientEnvFiles, writeClientEnvFiles } from './env-files';
import {
  createTempRuntimeRoot,
  makeIsolatedRuntime,
  materializeIsolatablePaths,
  syntheticProxyProfile,
} from './isolation';
import { CODEX_DESKTOP_MODEL_ROLES } from './model-roles';
const LEGACY_BEGIN = '# >>> anypick:managed';
const LEGACY_END = '# <<< anypick:managed';
/**
 * Live-config block: the single active AnyPick route, published into the user's
 * base ~/.codex/config.toml so plain `codex` (and the desktop app, where it
 * honors config) routes through the proxy/gateway without a `--profile` flag.
 * Distinct from the legacy per-install managed block so reset() can strip them
 * separately.
 *
 * Split into two markers because TOML scopes keys by position: a bare key after
 * a `[table]` header belongs to that table. Root keys must therefore be written
 * above the first table header, while the provider table goes at EOF.
 *
 * When a proxy/gateway is active the live root block *takes over* top-level
 * `model_provider` (and `model` when known). The user's previous values are
 * stashed beside the catalog and restored on native account / reset / clear.
 */
export const LIVE_BEGIN = '# >>> anypick:live';
export const LIVE_END = '# <<< anypick:live';
export const LIVE_PROVIDER_BEGIN = '# >>> anypick:provider';
export const LIVE_PROVIDER_END = '# <<< anypick:provider';

/** Top-level keys AnyPick takes over while a routed source is active. */
export const LIVE_TAKEOVER_KEYS = ['model', 'model_provider'] as const;
export type LiveTakeoverKey = (typeof LIVE_TAKEOVER_KEYS)[number];
const CODEX_OUTPUT_TOKEN_MAX = 32_000;
const LOCAL_MODEL_METADATA_TIMEOUT_MS = 8_000;
const LOCAL_MODEL_CATALOG_TIMEOUT_MS = 5_000;
export interface CodexCatalogModel extends Omit<ModelCatalogDescriptor, 'id'> {
  slug: string;
}

interface CodexModelLimits {
  contextWindow: number;
  autoCompactTokenLimit: number;
}

interface ModelMetadataResponse {
  id?: unknown;
  slug?: unknown;
  model?: unknown;
  name?: unknown;
  display_name?: unknown;
  description?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
  context_window?: unknown;
  max_context_window?: unknown;
  auto_compact_token_limit?: unknown;
  max_input_tokens?: unknown;
  max_output_tokens?: unknown;
  input_modalities?: unknown;
  supports_parallel_tool_calls?: unknown;
  supports_search_tool?: unknown;
  support_verbosity?: unknown;
  supports_image_detail_original?: unknown;
  capabilities?: unknown;
}

function codexDir(home = process.env.HOME ?? homedir()): string {
  return join(home, '.codex');
}

export function configTomlPath(home = process.env.HOME ?? homedir()): string {
  return join(codexDir(home), 'config.toml');
}

export function codexLiveCatalogPath(home = process.env.HOME ?? homedir()): string {
  return join(codexDir(home), 'anypick-live.model-catalog.json');
}

/** Sidecar: user's top-level model/model_provider before AnyPick takeover. */
export function codexUserDefaultsStashPath(home = process.env.HOME ?? homedir()): string {
  return join(codexDir(home), 'anypick-user-defaults.json');
}

/**
 * Whether Codex live config is in routed (proxy/gateway/hub) or native mode.
 * Proxy lifecycle re-sync must not re-publish while the user is on a native
 * Codex account.
 */
export function codexLiveModePath(home = process.env.HOME ?? homedir()): string {
  return join(codexDir(home), 'anypick-live-mode.json');
}

/**
 * Last explicitly published live route (gateway, or a sticky override). Used
 * when no hub route / running proxy is available but mode is still routed.
 */
export function codexLiveRoutePath(home = process.env.HOME ?? homedir()): string {
  return join(codexDir(home), 'anypick-live-route.json');
}

export type CodexLiveMode = 'routed' | 'native';

export interface CodexUserDefaultsStash {
  version: 1;
  /** Absent key → user had no top-level entry (restore must not invent one). */
  model?: string;
  model_provider?: string;
  /** True when the key existed; false/omitted when it did not. */
  had_model: boolean;
  had_model_provider: boolean;
}

export interface StoredLiveRoute {
  version: 1;
  source: string;
  endpoint: string;
  token: string;
  defaultModel?: string;
}

function modelCatalogPath(profileName: string, home = process.env.HOME ?? homedir()): string {
  return join(codexDir(home), `${profileName}.model-catalog.json`);
}

function profileConfigPath(profileName: string, home = process.env.HOME ?? homedir()): string {
  return join(codexDir(home), `${profileName}.config.toml`);
}

/**
 * Codex custom providers are global within one config layer. Derive a stable,
 * source-specific ID so a Grok proxy, Gemini proxy, and arbitrary gateway can
 * coexist without taking over one another's provider configuration.
 */
export function codexProfileName(sourceName: string): string {
  const stem = sourceName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const fingerprint = createHash('sha256').update(sourceName).digest('hex').slice(0, 10);
  return `anypick-${stem || 'provider'}-${fingerprint}`;
}

function codexProviderEnvKey(profileName: string): string {
  return `ANYPICK_CODEX_${profileName
    .replace(/^anypick-/, '')
    .toUpperCase()
    .replace(/-/g, '_')}_API_KEY`;
}

/**
 * Codex CLI client adapter (API runtime, not ChatGPT auth files).
 *
 * Persistent: one source-specific Codex profile + source-specific environment
 * file. Ephemeral: isolated CODEX_HOME / HOME with the same profile selected.
 */
export function createCodexClient(home = process.env.HOME ?? homedir()): ClientAdapter {
  const liveConfigPath = configTomlPath(home);

  async function applyToHome(ctx: ApplyContext, targetHome: string) {
    const r = resolveFromContext(ctx);
    const profileName = codexProfileName(ctx.profile.meta.name);
    const configPath = profileConfigPath(profileName, targetHome);
    const catalogPath = modelCatalogPath(profileName, targetHome);
    const envKey = codexProviderEnvKey(profileName);
    const env: Record<string, string> = {
      [envKey]: r.apiKey,
    };

    const extraEnv = r.overlay.env;
    if (extraEnv && typeof extraEnv === 'object' && !Array.isArray(extraEnv)) {
      for (const [k, v] of Object.entries(extraEnv)) {
        if (typeof v === 'string') {
          env[k] = v;
        }
      }
    }

    const managedPaths = [configPath, catalogPath];
    const managedEnvKeys = Object.keys(env);

    if (ctx.dryRun) {
      return {
        managedPaths: [
          ...managedPaths,
          join(ctx.anypickRoot, 'clients', 'codex', 'env.sh'),
          join(ctx.anypickRoot, 'clients', 'codex', 'env.ps1'),
        ],
        managedEnvKeys,
        profileName,
      };
    }

    // Bridge the limits published by AnyPick's local proxy into Codex's
    // official top-level config knobs so Codex can compact its own stateful
    // history before the provider rejects the request.
    const modelLimits = await discoverLocalModelLimits(r.endpoint, r.apiKey, r.defaultModel);

    // Codex does not fetch the OpenAI-compatible /models catalog for a custom
    // provider. Publish the active gateway's configured models and the live
    // models from local proxies through Codex's supported catalog override.
    // This makes them available from `/model`, rather than only via an
    // explicit `--model` flag.
    const catalogModels = await codexCatalogModels(r);
    await writeJsonFile(
      catalogPath,
      buildCodexModelCatalog(catalogModels, { provider: profileName }),
      0o600,
    );

    let envPaths: string[] = [];
    if (!ctx.isolatedHome) {
      envPaths = await writeClientEnvFiles(ctx.anypickRoot, 'codex', env);
    }

    await ensureDir(codexDir(targetHome));
    const profileConfig = [
      '# Generated by AnyPick. Do not edit by hand.',
      `# source: ${ctx.profile.meta.name}`,
      `model = ${tomlString(r.defaultModel ?? 'gpt-4o')}`,
      `model_catalog_json = ${tomlString(catalogPath)}`,
      ...(modelLimits
        ? [
            `model_context_window = ${modelLimits.contextWindow}`,
            `model_auto_compact_token_limit = ${modelLimits.autoCompactTokenLimit}`,
          ]
        : []),
      `model_provider = ${tomlString(profileName)}`,
      '',
      `[model_providers.${profileName}]`,
      `name = ${tomlString(`AnyPick: ${ctx.profile.meta.name}`)}`,
      `base_url = ${tomlString(r.endpoint)}`,
      `env_key = ${tomlString(envKey)}`,
      `wire_api = "responses"`,
      `requires_openai_auth = false`,
      `supports_websockets = false`,
      '',
    ].join('\n');

    await writeTextFile(configPath, profileConfig, 0o600);

    return {
      managedPaths: [configPath, catalogPath, ...envPaths],
      managedEnvKeys,
      profileName,
    };
  }

  const adapter: ClientAdapter = {
    id: 'codex',
    name: 'Codex CLI',
    shortName: 'Codex',
    binaryName: 'codex',
    binaryEnvVar: 'CODEX_BINARY',
    description: 'OpenAI Codex CLI (API / gateway runtime)',
    supportedApiStyles: ['openai', 'custom'],
    nativeInstallations: [
      {
        sourceId: 'codex',
        executables: ['codex'],
        macApplications: ['Codex.app'],
      },
    ],
    routingSurfacePolicy: 'all-compatible',
    capabilities: {
      id: 'codex',
      acceptedProtocols: ['openai'],
      supportsEnvironmentOverlay: false,
      supportsIsolatedHome: true,
      supportsPersistentConfig: true,
      protocolPreference: 'openai',
    },
    modelRoles: () => CODEX_DESKTOP_MODEL_ROLES,

    async validate(ctx: ApplyContext): Promise<void> {
      const r = resolveFromContext(ctx);
      if (!r.endpoint) {
        throw new AnyPickError(
          'Profile has no endpoint. Set with: profile edit <name> --endpoint …',
          'CLIENT_CONFIG_INVALID',
        );
      }
    },

    async apply(ctx: ApplyContext) {
      return applyToHome(ctx, ctx.isolatedHome ?? home);
    },

    async listIsolatablePaths(liveState: ClientLiveState): Promise<readonly IsolatablePath[]> {
      return [
        {
          sourcePath: configTomlPath(liveState.home),
          destinationPath: join('.codex', 'config.toml'),
          kind: 'file',
          required: false,
        },
        // Do not copy live ChatGPT auth.json — secrets stay out of ephemeral
        // gateway runs. Native account activation uses WriteNativeAuth separately.
      ];
    },

    async createIsolatedRuntime(
      plan: ResolvedClientPlan,
      paths: readonly IsolatablePath[],
    ): Promise<IsolatedClientRuntime> {
      const runtimeRoot = await createTempRuntimeRoot('anypick-codex-');
      const isoHome = join(runtimeRoot, 'home');
      await ensureDir(isoHome);
      await materializeIsolatablePaths(isoHome, paths);

      const profile =
        plan.profile ??
        syntheticProxyProfile({
          name: `ephemeral-${plan.source.display}`,
          endpoint: plan.transport.endpoint ?? '',
          apiKey: 'anypick-proxy',
          defaultModel: plan.model.mode === 'explicit' ? plan.model.id : undefined,
        });

      const endpoint =
        plan.transport.endpoint ??
        (plan.transport.managedProxy
          ? `http://127.0.0.1:${plan.transport.managedProxy.port}`
          : (profile.meta.endpoint ?? ''));

      const ctx: ApplyContext = {
        profile: {
          ...profile,
          meta: { ...profile.meta, endpoint },
          secrets: {
            ...profile.secrets,
            apiKey: profile.secrets.apiKey ?? 'anypick-proxy',
          },
        },
        clientId: 'codex',
        dryRun: plan.dryRun,
        verbose: plan.verbose,
        proxyEndpoint: endpoint || undefined,
        anypickRoot: plan.anypickRoot,
        isolatedHome: isoHome,
      };

      if (!plan.dryRun && endpoint) {
        await adapter.validate(ctx);
        await applyToHome(ctx, isoHome);
      }

      const codexHome = codexDir(isoHome);
      const profileName = codexProfileName(ctx.profile.meta.name);
      return {
        ...makeIsolatedRuntime(runtimeRoot, {
          HOME: isoHome,
          CODEX_HOME: codexHome,
          [codexProviderEnvKey(profileName)]: resolveFromContext(ctx).apiKey,
        }),
        args: ['--profile', profileName],
      };
    },

    async applyPersistent(plan: ResolvedClientPlan) {
      const profile =
        plan.profile ??
        syntheticProxyProfile({
          name: `proxy-${plan.source.display}`,
          endpoint: plan.transport.endpoint ?? '',
          apiKey: 'anypick-proxy',
          defaultModel: plan.model.mode === 'explicit' ? plan.model.id : undefined,
        });
      const endpoint =
        plan.transport.endpoint ??
        (plan.transport.managedProxy
          ? `http://127.0.0.1:${plan.transport.managedProxy.port}`
          : (profile.meta.endpoint ?? ''));
      const ctx: ApplyContext = {
        profile: {
          ...profile,
          meta: { ...profile.meta, endpoint },
        },
        clientId: 'codex',
        dryRun: plan.dryRun,
        verbose: plan.verbose,
        proxyEndpoint: endpoint || undefined,
        anypickRoot: plan.anypickRoot,
      };
      await adapter.validate(ctx);
      return applyToHome(ctx, home);
    },

    async reset(state: ClientState): Promise<void> {
      const anypickRoot =
        inferAnyPickRoot(state) ?? process.env.ANYPICK_HOME ?? join(homedir(), '.anypick');
      await removeClientEnvFiles(anypickRoot, 'codex');

      const { rm, readFile } = await import('node:fs/promises');
      for (const path of state.managedPaths) {
        if (isAnyPickProfilePath(path)) {
          await rm(path, { force: true });
        }
      }

      // Clean up files written by the old singleton implementation.
      for (const legacyPath of [
        join(codexDir(home), 'anypick.auth.json'),
        join(codexDir(home), 'anypick-model-catalog.json'),
      ]) {
        if (await pathExists(legacyPath)) {
          await rm(legacyPath, { force: true });
        }
      }

      // Drop managed live state and restore the user's stashed top-level defaults.
      await rm(codexLiveCatalogPath(home), { force: true });
      await rm(codexLiveModePath(home), { force: true });
      await rm(codexLiveRoutePath(home), { force: true });
      let stash: CodexUserDefaultsStash | null = null;
      const stashPath = codexUserDefaultsStashPath(home);
      if (await pathExists(stashPath)) {
        try {
          const raw = JSON.parse(await readFile(stashPath, 'utf8')) as CodexUserDefaultsStash;
          if (raw && raw.version === 1) {
            stash = raw;
          }
        } catch {
          stash = null;
        }
        await rm(stashPath, { force: true });
      }
      if (await pathExists(liveConfigPath)) {
        const existing = await readFile(liveConfigPath, 'utf8');
        const next = restoreUserTopLevelDefaults(stripLegacyManagedBlock(existing), stash);
        if (next.trim().length === 0) {
          await rm(liveConfigPath, { force: true });
        } else if (next !== existing) {
          await writeTextFile(liveConfigPath, next, 0o600);
        }
      }
    },

    async inspect(): Promise<ClientInspectResult> {
      const profilePaths = await anypickProfilePaths(home);
      const hasBaseConfig = await pathExists(liveConfigPath);
      return {
        present: hasBaseConfig || profilePaths.length > 0,
        configPaths: [liveConfigPath, ...profilePaths],
        summary: profilePaths.length
          ? `${profilePaths.length} AnyPick Codex profile${profilePaths.length === 1 ? '' : 's'}`
          : hasBaseConfig
            ? 'config.toml present (no AnyPick profile)'
            : undefined,
      };
    },
  };

  return adapter;
}

function isAnyPickProfilePath(path: string): boolean {
  const name = basename(path);
  return (
    /^anypick-[a-z0-9_-]+\.config\.toml$/.test(name) ||
    /^anypick-[a-z0-9_-]+\.model-catalog\.json$/.test(name)
  );
}

async function anypickProfilePaths(home: string): Promise<string[]> {
  const dir = codexDir(home);
  try {
    const { readdir } = await import('node:fs/promises');
    return (await readdir(dir))
      .filter((name) => isAnyPickProfilePath(name))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function stripLegacyManagedBlock(content: string): string {
  if (!content.includes(LEGACY_BEGIN)) {
    return content;
  }
  const re = new RegExp(
    `\\n*${escapeRegExp(LEGACY_BEGIN)}[\\s\\S]*?${escapeRegExp(LEGACY_END)}\\n?`,
  );
  return content
    .replace(re, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimStart();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the subset of Codex's model catalog schema needed for custom gateway
 * models. Required client-side fields use conservative values. Provider
 * capabilities and limits are only enabled when an authoritative descriptor
 * supplied them.
 *
 * `provider` must match the `model_providers.<id>` key: Desktop and recent CLI
 * builds bind catalog entries to a provider, and without it custom models are
 * filtered out of the picker (only stock GPT ids remain visible).
 */
export function buildCodexModelCatalog(
  models: readonly CodexCatalogModel[],
  opts: { provider?: string } = {},
): Record<string, unknown> {
  const provider = opts.provider?.trim();
  return {
    models: models.map((model, index) => {
      const contextWindow = positiveInteger(model.contextWindow);
      const maxContextWindow = positiveInteger(model.maxContextWindow);
      const autoCompactTokenLimit = positiveInteger(model.autoCompactTokenLimit);
      const displayName = model.displayName ?? model.slug;
      return {
        slug: model.slug,
        // snake_case for CLI; camelCase kept for Desktop catalog parsers.
        display_name: displayName,
        displayName,
        description: model.description ?? 'Model supplied by the active AnyPick gateway or proxy.',
        ...(provider ? { provider } : {}),
        hidden: false,
        ...(model.defaultReasoningLevel
          ? { default_reasoning_level: model.defaultReasoningLevel }
          : {}),
        supported_reasoning_levels: model.supportedReasoningLevels ?? [],
        visibility: 'list',
        supported_in_api: true,
        priority: index + 1,
        ...(contextWindow ? { context_window: contextWindow } : {}),
        ...(maxContextWindow ? { max_context_window: maxContextWindow } : {}),
        ...(autoCompactTokenLimit ? { auto_compact_token_limit: autoCompactTokenLimit } : {}),
        supports_search_tool: model.supportsSearchTool ?? false,
        supports_parallel_tool_calls: model.supportsParallelToolCalls ?? false,
        support_verbosity: model.supportsVerbosity ?? false,
        shell_type: 'shell_command',
        input_modalities: model.inputModalities ?? ['text'],
        base_instructions: 'You are Codex, a coding agent. Help the user complete their task.',
        model_messages: {},
        web_search_tool_type: 'text',
        truncation_policy: { mode: 'tokens', limit: 10_000 },
        experimental_supported_tools: [],
        use_responses_lite: false,
        include_skills_usage_instructions: false,
        supports_image_detail_original: model.supportsImageDetailOriginal ?? false,
      };
    }),
  };
}

async function codexCatalogModels(
  r: ReturnType<typeof resolveFromContext>,
): Promise<CodexCatalogModel[]> {
  const configured = configuredModelCatalog(r.models);

  // Account-backed proxies are loopback-only. Query their live catalog so a
  // newly released model becomes selectable in Codex without a AnyPick update.
  // Gateway profiles stay deterministic: their saved model map is the source
  // of truth and activation never adds an unexpected external network probe.
  if (!isLoopbackEndpoint(r.endpoint)) {
    return toCodexCatalog(configured.length ? configured : [fallbackCatalogModel(r.defaultModel)]);
  }

  const live = await discoverLocalCatalogModels(r.endpoint, r.apiKey, r.headers);
  const merged = mergeModelCatalogs(configured, live);
  return toCodexCatalog(merged.length ? merged : [fallbackCatalogModel(r.defaultModel)]);
}

function fallbackCatalogModel(defaultModel: string | undefined): ModelCatalogDescriptor {
  return { id: defaultModel?.trim() || 'gpt-4o' };
}

function toCodexCatalog(models: readonly ModelCatalogDescriptor[]): CodexCatalogModel[] {
  return models.map(({ id, ...descriptor }) => ({ slug: id, ...descriptor }));
}

/** A single active route to publish into the user's base Codex config. */
export interface LiveCodexProvider {
  /** Human label, e.g. the Proxy Hub name or `proxy:<provider>/<account>`. */
  source: string;
  endpoint: string;
  /** Per-instance Proxy Hub route / proxy secret (ADR 0006). */
  token: string;
  defaultModel?: string;
}

/**
 * Render the live managed blocks for the ONE active AnyPick provider. Codex
 * routes globally (top-level `model_provider`), so exactly one provider table
 * is published — pointing at the Proxy Hub / proxy / gateway, which dispatches
 * each model to its own upstream.
 *
 * The root block *takes over* top-level `model_provider` (and `model` when a
 * default is known) so plain `codex` and the desktop app route through AnyPick
 * without `--profile`. Callers must stash the user's previous top-level values
 * via {@link extractUserTopLevelDefaults} before the first takeover and restore
 * them with {@link restoreUserTopLevelDefaults} on native/reset.
 *
 * Returns the root-scope block and the provider table separately: TOML binds a
 * bare key to whatever `[table]` precedes it, so root keys have to be placed
 * above the user's first table header rather than appended at EOF.
 */
export function renderLiveManagedBlock(
  provider: LiveCodexProvider,
  catalogPath: string,
  opts: { includeCatalog?: boolean } = {},
): { root: string; providerTable: string } {
  const profileName = codexProfileName(provider.source);
  const includeCatalog = opts.includeCatalog ?? true;
  const defaultModel = provider.defaultModel?.trim();
  const root = [
    LIVE_BEGIN,
    `model_provider = ${tomlString(profileName)}`,
    ...(defaultModel ? [`model = ${tomlString(defaultModel)}`] : []),
    ...(includeCatalog ? [`model_catalog_json = ${tomlString(catalogPath)}`] : []),
    LIVE_END,
  ].join('\n');
  const providerTable = [
    LIVE_PROVIDER_BEGIN,
    `[model_providers.${profileName}]`,
    `name = ${tomlString(`AnyPick: ${provider.source}`)}`,
    `base_url = ${tomlString(codexProviderBaseUrl(provider.endpoint))}`,
    `http_headers = { "Authorization" = "Bearer ${provider.token}" }`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    LIVE_PROVIDER_END,
  ].join('\n');
  return { root, providerTable };
}

/**
 * Codex treats a model-provider `base_url` as a prefix and appends `/responses`.
 * The Proxy Hub and the per-provider proxies serve the canonical `/v1/*` paths,
 * so the published URL must carry the `/v1` suffix or every request 404s.
 */
export function codexProviderBaseUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/u, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function blockRegExp(begin: string, end: string): RegExp {
  return new RegExp(`\\n*${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, 'u');
}

/** Index of the first TOML table/array-of-tables header, or -1. */
function firstTableHeaderIndex(lines: readonly string[]): number {
  return lines.findIndex((line) => /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/u.test(line));
}

/**
 * Replace both managed blocks with `root` (above the user's first table header)
 * and `providerTable` (at EOF), leaving the rest of the config untouched.
 */
export function upsertLiveBlock(
  content: string,
  block: { root: string; providerTable: string },
): string {
  const stripped = stripLiveBlock(content);
  const lines = stripped.length ? stripped.split('\n') : [];
  const headerIndex = firstTableHeaderIndex(lines);
  const rootLines = block.root.split('\n');
  const withRoot =
    headerIndex === -1
      ? [...lines, ...rootLines]
      : [...lines.slice(0, headerIndex), ...rootLines, '', ...lines.slice(headerIndex)];
  const joined = [...withRoot, '', ...block.providerTable.split('\n')].join('\n');
  return `${joined
    .replace(/\n{3,}/gu, '\n\n')
    .trimStart()
    .trimEnd()}\n`;
}

/** Remove both live blocks, preserving the rest of the config. */
export function stripLiveBlock(content: string): string {
  return content
    .replace(blockRegExp(LIVE_PROVIDER_BEGIN, LIVE_PROVIDER_END), '\n')
    .replace(blockRegExp(LIVE_BEGIN, LIVE_END), '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trimStart();
}

/**
 * Read a bare top-level TOML string assignment outside managed blocks.
 * Returns the unquoted string value, or `undefined` if the key is absent.
 */
export function readTopLevelStringKey(content: string, key: string): string | undefined {
  const outside = stripLiveBlock(content).split('\n');
  const headerIndex = firstTableHeaderIndex(outside);
  const rootLines = headerIndex === -1 ? outside : outside.slice(0, headerIndex);
  const re = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*(.*)$`, 'u');
  for (const line of rootLines) {
    const match = re.exec(line.trimEnd());
    if (!match) {
      continue;
    }
    return parseTomlStringValue(match[1] ?? '');
  }
  return undefined;
}

/** Snapshot the user's top-level model / model_provider before takeover. */
export function extractUserTopLevelDefaults(content: string): CodexUserDefaultsStash {
  const model = readTopLevelStringKey(content, 'model');
  const modelProvider = readTopLevelStringKey(content, 'model_provider');
  return {
    version: 1,
    had_model: model !== undefined,
    had_model_provider: modelProvider !== undefined,
    ...(model !== undefined ? { model } : {}),
    ...(modelProvider !== undefined ? { model_provider: modelProvider } : {}),
  };
}

/**
 * Strip live blocks and remove top-level takeover keys so the managed block can
 * own `model` / `model_provider` without duplicating user assignments.
 */
export function prepareConfigForLiveTakeover(content: string): string {
  return removeTopLevelKeys(stripLiveBlock(content), LIVE_TAKEOVER_KEYS);
}

/**
 * Strip live blocks and put stashed user defaults back at root scope.
 * Keys the user never had are left absent. Without a stash, only the managed
 * blocks are removed — user top-level keys outside them stay put.
 */
export function restoreUserTopLevelDefaults(
  content: string,
  stash: CodexUserDefaultsStash | null | undefined,
): string {
  let next = stripLiveBlock(content);
  if (!stash) {
    return normalizeToml(next);
  }
  // Drop residual takeover keys (if any) before re-inserting the stashed ones.
  next = removeTopLevelKeys(next, LIVE_TAKEOVER_KEYS);
  const toInsert: Array<[string, string]> = [];
  if (stash.had_model && typeof stash.model === 'string') {
    toInsert.push(['model', stash.model]);
  }
  if (stash.had_model_provider && typeof stash.model_provider === 'string') {
    toInsert.push(['model_provider', stash.model_provider]);
  }
  if (toInsert.length === 0) {
    return normalizeToml(next);
  }
  return normalizeToml(insertTopLevelKeys(next, toInsert));
}

/** Remove bare root-scope assignments for the given keys (outside tables). */
export function removeTopLevelKeys(content: string, keys: readonly string[]): string {
  if (!content) {
    return content;
  }
  const keySet = new Set(keys);
  const lines = content.split('\n');
  const headerIndex = firstTableHeaderIndex(lines);
  const rootEnd = headerIndex === -1 ? lines.length : headerIndex;
  const next: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (i < rootEnd) {
      const trimmed = line.trim();
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        if (keySet.has(key)) {
          continue;
        }
      }
    }
    next.push(line);
  }
  return next.join('\n');
}

/** Insert bare root-scope string keys above the first table header. */
export function insertTopLevelKeys(
  content: string,
  entries: ReadonlyArray<readonly [string, string]>,
): string {
  if (entries.length === 0) {
    return content;
  }
  const lines = content.length ? content.split('\n') : [];
  const headerIndex = firstTableHeaderIndex(lines);
  const insertLines = entries.map(([key, value]) => `${key} = ${tomlString(value)}`);
  const withKeys =
    headerIndex === -1
      ? [...insertLines, ...lines]
      : [...lines.slice(0, headerIndex), ...insertLines, '', ...lines.slice(headerIndex)];
  return withKeys.join('\n');
}

function parseTomlStringValue(raw: string): string {
  const trimmed = raw.trim();
  // Strip trailing comments outside quotes: ` "gpt-5.2"  # note `
  let value = trimmed;
  if (value.startsWith('"')) {
    let end = 1;
    while (end < value.length) {
      if (value[end] === '\\') {
        end += 2;
        continue;
      }
      if (value[end] === '"') {
        break;
      }
      end += 1;
    }
    value = value.slice(0, end + 1);
  } else {
    const hash = value.indexOf('#');
    if (hash >= 0) {
      value = value.slice(0, hash).trim();
    }
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    const inner = value.slice(1, -1);
    return inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return value;
}

function normalizeToml(content: string): string {
  const next = content
    .replace(/\n{3,}/gu, '\n\n')
    .trimStart()
    .trimEnd();
  return next.length ? `${next}\n` : '';
}

/**
 * Catalog for live publishing: the active route's models only, tagged with the
 * live provider id so Codex binds them to the Hub/proxy provider table.
 *
 * Deliberately does **not** merge stock OpenAI GPT entries. With top-level
 * `model_provider` pointing at the AnyPick route, GPT ids would be sent to the
 * Hub and 404 — and they drowned out real Hub models in some pickers.
 */
export function buildLiveCatalog(
  routeModels: readonly CodexCatalogModel[],
  opts: { provider: string } | string,
): Record<string, unknown> {
  // Accept a bare provider string for call-site clarity.
  const provider = typeof opts === 'string' ? opts : opts.provider;
  const merged = new Map<string, CodexCatalogModel>();
  for (const model of routeModels) {
    merged.set(model.slug, model);
  }
  return buildCodexModelCatalog([...merged.values()], { provider });
}

/**
 * Discover the catalog the live route serves. Loopback hubs/proxies expose a
 * live /v1/models; fall back to a deterministic default when unavailable.
 */
export async function liveRouteCatalogModels(opts: {
  endpoint: string;
  token: string;
  defaultModel?: string;
}): Promise<CodexCatalogModel[]> {
  const configured = opts.defaultModel ? [{ id: opts.defaultModel }] : [];
  const live = await discoverLocalCatalogModels(opts.endpoint, opts.token, {});
  const merged = mergeModelCatalogs(configured, live);
  return toCodexCatalog(merged.length ? merged : [fallbackCatalogModel(opts.defaultModel)]);
}

/**
 * True when the given key exists at ROOT scope outside the managed blocks.
 * Keys under a `[table]` header are a different setting entirely and must not
 * suppress the managed `model_catalog_json`.
 */
export function hasTopLevelKeyOutsideLiveBlock(content: string, key: string): boolean {
  const outside = stripLiveBlock(content).split('\n');
  const headerIndex = firstTableHeaderIndex(outside);
  const rootLines = headerIndex === -1 ? outside : outside.slice(0, headerIndex);
  return rootLines.some((line) => new RegExp(`^${escapeRegExp(key)}\\s*=`, 'u').test(line));
}

async function discoverLocalCatalogModels(
  endpoint: string,
  apiKey: string,
  headers: Record<string, string>,
): Promise<ModelCatalogDescriptor[]> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return [];
  }
  if (!isLoopbackHost(url.hostname) || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return [];
  }

  const basePath = url.pathname.replace(/\/$/, '');
  url.pathname = basePath.endsWith('/v1') ? `${basePath}/models` : `${basePath}/v1/models`;
  url.search = '';
  url.hash = '';

  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...headers,
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(LOCAL_MODEL_CATALOG_TIMEOUT_MS),
    });
    if (!response.ok) {
      return [];
    }
    const body = (await response.json()) as { data?: unknown; models?: unknown };
    const discovered = [...unknownArray(body.data), ...unknownArray(body.models)]
      .map(modelDescriptorFromMetadata)
      .filter((model): model is ModelCatalogDescriptor => model != null);
    return mergeModelCatalogs(discovered);
  } catch {
    return [];
  }
}

function modelDescriptorFromMetadata(value: unknown): ModelCatalogDescriptor | undefined {
  if (typeof value === 'string') {
    const id = normalizeModelId(value);
    return id ? { id } : undefined;
  }
  const metadata = recordValue(value);
  if (!metadata) {
    return undefined;
  }

  const explicitId = firstString(metadata.id, metadata.slug, metadata.model);
  const name = nonEmptyString(metadata.name);
  const id = normalizeModelId(explicitId ?? name);
  if (!id) {
    return undefined;
  }
  const capabilities = recordValue(metadata.capabilities);
  const displayName = firstString(metadata.display_name, explicitId ? name : undefined);
  const description = nonEmptyString(metadata.description);
  const defaultReasoningLevel = nonEmptyString(metadata.default_reasoning_level);
  const supportedReasoningLevels = reasoningLevels(metadata.supported_reasoning_levels);
  const inputModalities = modelInputModalities(metadata.input_modalities);
  const supportsParallelToolCalls = firstBoolean(
    metadata.supports_parallel_tool_calls,
    capabilities?.supports_parallel_tool_calls,
  );
  const supportsSearchTool = firstBoolean(
    metadata.supports_search_tool,
    capabilities?.supports_search_tool,
  );

  return {
    id,
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}),
    ...(supportedReasoningLevels ? { supportedReasoningLevels } : {}),
    ...(positiveInteger(metadata.context_window)
      ? { contextWindow: positiveInteger(metadata.context_window) }
      : {}),
    ...(positiveInteger(metadata.max_context_window)
      ? { maxContextWindow: positiveInteger(metadata.max_context_window) }
      : {}),
    ...(positiveInteger(metadata.auto_compact_token_limit)
      ? { autoCompactTokenLimit: positiveInteger(metadata.auto_compact_token_limit) }
      : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(supportsParallelToolCalls != null ? { supportsParallelToolCalls } : {}),
    ...(supportsSearchTool != null ? { supportsSearchTool } : {}),
    ...(typeof metadata.support_verbosity === 'boolean'
      ? { supportsVerbosity: metadata.support_verbosity }
      : {}),
    ...(typeof metadata.supports_image_detail_original === 'boolean'
      ? { supportsImageDetailOriginal: metadata.supports_image_detail_original }
      : {}),
  };
}

function normalizeModelId(value: string | undefined): string | undefined {
  const id = value?.trim().replace(/^models\//, '');
  return id || undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function unknownArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const found = nonEmptyString(value);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === 'boolean');
}

function reasoningLevels(value: unknown): readonly ModelReasoningLevel[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const levels = value.flatMap((item) => {
    const level = recordValue(item);
    const effort = nonEmptyString(level?.effort);
    const description = nonEmptyString(level?.description);
    return effort && description ? [{ effort, description }] : [];
  });
  return levels.length ? levels : undefined;
}

function modelInputModalities(value: unknown): readonly ModelInputModality[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const allowed = new Set<ModelInputModality>(['text', 'image', 'audio']);
  const modalities = value.filter(
    (item): item is ModelInputModality =>
      typeof item === 'string' && allowed.has(item as ModelInputModality),
  );
  return modalities.length ? [...new Set(modalities)] : undefined;
}

async function discoverLocalModelLimits(
  endpoint: string,
  apiKey: string,
  model: string | undefined,
): Promise<CodexModelLimits | undefined> {
  if (!model) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (!isLoopbackHost(url.hostname) || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return undefined;
  }

  const basePath = url.pathname.replace(/\/$/, '');
  url.pathname = `${basePath}/models/${encodeURIComponent(model)}`;
  url.search = '';
  url.hash = '';

  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      // The first request may trigger the proxy's remote catalog refresh;
      // keep this in line with the proxy's model-fetch timeout while still
      // bounding activation if the local service is unavailable.
      signal: AbortSignal.timeout(LOCAL_MODEL_METADATA_TIMEOUT_MS),
    });
    if (!response.ok) {
      return undefined;
    }
    return codexLimitsFromMetadata((await response.json()) as ModelMetadataResponse);
  } catch {
    // Metadata is an optimization hint. Applying the client config must still
    // work if an older proxy is running or the local proxy is not ready yet.
    return undefined;
  }
}

function codexLimitsFromMetadata(metadata: ModelMetadataResponse): CodexModelLimits | undefined {
  const contextWindow = positiveInteger(metadata.context_window ?? metadata.max_context_window);
  if (!contextWindow) {
    return undefined;
  }

  const providerOutputLimit = positiveInteger(metadata.max_output_tokens);
  const outputReserve = Math.min(
    providerOutputLimit ?? CODEX_OUTPUT_TOKEN_MAX,
    CODEX_OUTPUT_TOKEN_MAX,
  );
  const providerInputLimit = positiveInteger(metadata.max_input_tokens);
  const advertisedCompactLimit = positiveInteger(metadata.auto_compact_token_limit);
  const candidates = [
    Math.floor(contextWindow * 0.9),
    contextWindow - outputReserve,
    providerInputLimit,
    advertisedCompactLimit,
  ].filter((value): value is number => value != null && value > 0);
  const autoCompactTokenLimit = Math.min(...candidates);
  if (!Number.isSafeInteger(autoCompactTokenLimit) || autoCompactTokenLimit <= 0) {
    return undefined;
  }
  return { contextWindow, autoCompactTokenLimit };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    return isLoopbackHost(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function inferAnyPickRoot(state: ClientState): string | undefined {
  for (const p of state.managedPaths) {
    const idx = p.replace(/\\/g, '/').indexOf('/clients/codex/');
    if (idx > 0) {
      return p.slice(0, idx);
    }
  }
  return undefined;
}

export const codexClient = createCodexClient();
