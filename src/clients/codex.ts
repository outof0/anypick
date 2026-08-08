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
  ResolvedClientPlan,
} from '../types';
import { HotplugError } from '../utils/errors';
import { ensureDir, pathExists, writeJsonFile, writeTextFile } from '../utils/fs';
import { resolveFromContext } from './resolve';
import { removeClientEnvFiles, writeClientEnvFiles } from './env-files';
import {
  createTempRuntimeRoot,
  makeIsolatedRuntime,
  materializeIsolatablePaths,
  syntheticProxyProfile,
} from './isolation';
import { DEFAULT_MODEL_ROLE } from './model-roles';
const LEGACY_BEGIN = '# >>> hotplug:managed';
const LEGACY_END = '# <<< hotplug:managed';
const CODEX_OUTPUT_TOKEN_MAX = 32_000;
const LOCAL_MODEL_METADATA_TIMEOUT_MS = 8_000;
const LOCAL_MODEL_CATALOG_TIMEOUT_MS = 5_000;
const FALLBACK_MODEL_CONTEXT_WINDOW = 32_768;

interface CodexCatalogModel {
  slug: string;
  displayName?: string;
}

interface CodexModelLimits {
  contextWindow: number;
  autoCompactTokenLimit: number;
}

interface ModelMetadataResponse {
  context_window?: unknown;
  max_context_window?: unknown;
  auto_compact_token_limit?: unknown;
  max_input_tokens?: unknown;
  max_output_tokens?: unknown;
}

function codexDir(home = process.env.HOME ?? homedir()): string {
  return join(home, '.codex');
}

function configTomlPath(home = process.env.HOME ?? homedir()): string {
  return join(codexDir(home), 'config.toml');
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
  return `hotplug-${stem || 'provider'}-${fingerprint}`;
}

function codexProviderEnvKey(profileName: string): string {
  return `HOTPLUG_CODEX_${profileName
    .replace(/^hotplug-/, '')
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
          join(ctx.hotplugRoot, 'clients', 'codex', 'env.sh'),
          join(ctx.hotplugRoot, 'clients', 'codex', 'env.ps1'),
        ],
        managedEnvKeys,
        profileName,
      };
    }

    // Bridge the limits published by Hotplug's local proxy into Codex's
    // official top-level config knobs so Codex can compact its own stateful
    // history before the provider rejects the request.
    const modelLimits = await discoverLocalModelLimits(r.endpoint, r.apiKey, r.defaultModel);

    // Codex does not fetch the OpenAI-compatible /models catalog for a custom
    // provider. Publish the active gateway's configured models and the live
    // models from local proxies through Codex's supported catalog override.
    // This makes them available from `/model`, rather than only via an
    // explicit `--model` flag.
    const catalogModels = await codexCatalogModels(r);
    await writeJsonFile(catalogPath, buildCodexModelCatalog(catalogModels), 0o600);

    let envPaths: string[] = [];
    if (!ctx.isolatedHome) {
      envPaths = await writeClientEnvFiles(ctx.hotplugRoot, 'codex', env);
    }

    await ensureDir(codexDir(targetHome));
    const profileConfig = [
      '# Generated by Hotplug. Do not edit by hand.',
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
      `name = ${tomlString(`Hotplug: ${ctx.profile.meta.name}`)}`,
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
    description: 'OpenAI Codex CLI (API / gateway runtime)',
    supportedApiStyles: ['openai', 'custom'],
    capabilities: {
      id: 'codex',
      acceptedProtocols: ['openai'],
      supportsEnvironmentOverlay: false,
      supportsIsolatedHome: true,
      supportsPersistentConfig: true,
      protocolPreference: 'openai',
    },
    modelRoles: () => DEFAULT_MODEL_ROLE,

    async validate(ctx: ApplyContext): Promise<void> {
      const r = resolveFromContext(ctx);
      if (!r.endpoint) {
        throw new HotplugError(
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
      const runtimeRoot = await createTempRuntimeRoot('hotplug-codex-');
      const isoHome = join(runtimeRoot, 'home');
      await ensureDir(isoHome);
      await materializeIsolatablePaths(isoHome, paths);

      const profile =
        plan.profile ??
        syntheticProxyProfile({
          name: `ephemeral-${plan.source.display}`,
          endpoint: plan.transport.endpoint ?? '',
          apiKey: 'hotplug-proxy',
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
            apiKey: profile.secrets.apiKey ?? 'hotplug-proxy',
          },
        },
        clientId: 'codex',
        dryRun: plan.dryRun,
        verbose: plan.verbose,
        proxyEndpoint: endpoint || undefined,
        hotplugRoot: plan.hotplugRoot,
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
          apiKey: 'hotplug-proxy',
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
        hotplugRoot: plan.hotplugRoot,
      };
      await adapter.validate(ctx);
      return applyToHome(ctx, home);
    },

    async reset(state: ClientState): Promise<void> {
      const hotplugRoot =
        inferHotplugRoot(state) ?? process.env.HOTPLUG_HOME ?? join(homedir(), '.hotplug');
      await removeClientEnvFiles(hotplugRoot, 'codex');

      const { rm, readFile } = await import('node:fs/promises');
      for (const path of state.managedPaths) {
        if (isHotplugProfilePath(path)) {
          await rm(path, { force: true });
        }
      }

      // Clean up files written by the old singleton implementation.
      for (const legacyPath of [
        join(codexDir(home), 'hotplug.auth.json'),
        join(codexDir(home), 'hotplug-model-catalog.json'),
      ]) {
        if (await pathExists(legacyPath)) {
          await rm(legacyPath, { force: true });
        }
      }

      if (await pathExists(liveConfigPath)) {
        const existing = await readFile(liveConfigPath, 'utf8');
        const next = stripLegacyManagedBlock(existing);
        if (next !== existing) {
          if (next.trim().length === 0) {
            await rm(liveConfigPath, { force: true });
          } else {
            await writeTextFile(liveConfigPath, next, 0o600);
          }
        }
      }
    },

    async inspect(): Promise<ClientInspectResult> {
      const profilePaths = await hotplugProfilePaths(home);
      const hasBaseConfig = await pathExists(liveConfigPath);
      return {
        present: hasBaseConfig || profilePaths.length > 0,
        configPaths: [liveConfigPath, ...profilePaths],
        summary: profilePaths.length
          ? `${profilePaths.length} Hotplug Codex profile${profilePaths.length === 1 ? '' : 's'}`
          : hasBaseConfig
            ? 'config.toml present (no Hotplug profile)'
            : undefined,
      };
    },
  };

  return adapter;
}

function isHotplugProfilePath(path: string): boolean {
  const name = basename(path);
  return (
    /^hotplug-[a-z0-9_-]+\.config\.toml$/.test(name) ||
    /^hotplug-[a-z0-9_-]+\.model-catalog\.json$/.test(name)
  );
}

async function hotplugProfilePaths(home: string): Promise<string[]> {
  const dir = codexDir(home);
  try {
    const { readdir } = await import('node:fs/promises');
    return (await readdir(dir))
      .filter((name) => isHotplugProfilePath(name))
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
 * models. The values deliberately describe portable baseline capabilities;
 * provider-specific context limits remain an optional local-proxy hint.
 */
export function buildCodexModelCatalog(
  models: readonly CodexCatalogModel[],
): Record<string, unknown> {
  return {
    models: models.map((model, index) => ({
      slug: model.slug,
      display_name: model.displayName ?? model.slug,
      description: 'Model supplied by the active Hotplug gateway or proxy.',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses with lighter reasoning.' },
        { effort: 'medium', description: 'Balances speed and reasoning depth.' },
        { effort: 'high', description: 'Greater reasoning depth for complex tasks.' },
      ],
      visibility: 'list',
      supported_in_api: true,
      priority: index + 1,
      context_window: FALLBACK_MODEL_CONTEXT_WINDOW,
      max_context_window: FALLBACK_MODEL_CONTEXT_WINDOW,
      supports_reasoning_summaries: false,
      supports_search_tool: false,
      supports_parallel_tool_calls: true,
      support_verbosity: false,
      shell_type: 'shell_command',
      input_modalities: ['text'],
      base_instructions: 'You are Codex, a coding agent. Help the user complete their task.',
      model_messages: {},
      apply_patch_tool_type: 'freeform',
      web_search_tool_type: 'text_and_image',
      truncation_policy: { mode: 'tokens', limit: 10_000 },
      experimental_supported_tools: [],
      use_responses_lite: false,
      include_skills_usage_instructions: false,
      supports_image_detail_original: false,
    })),
  };
}

async function codexCatalogModels(
  r: ReturnType<typeof resolveFromContext>,
): Promise<CodexCatalogModel[]> {
  const configured: CodexCatalogModel[] = [];
  const addConfigured = (slug: string | undefined, displayName?: string) => {
    const normalized = slug?.trim();
    if (!normalized || configured.some((model) => model.slug === normalized)) {
      return;
    }
    configured.push({ slug: normalized, displayName });
  };

  for (const [alias, model] of Object.entries(r.models)) {
    addConfigured(model, alias === model ? undefined : `${alias} (${model})`);
  }
  addConfigured(r.defaultModel);
  addConfigured(r.roles.sonnet);
  addConfigured(r.roles.opus);
  addConfigured(r.roles.haiku);

  // Account-backed proxies are loopback-only. Query their live catalog so a
  // newly released model becomes selectable in Codex without a Hotplug update.
  // Gateway profiles stay deterministic: their saved model map is the source
  // of truth and activation never adds an unexpected external network probe.
  if (!isLoopbackEndpoint(r.endpoint)) {
    return configured.length ? configured : [{ slug: 'gpt-4o' }];
  }

  const live = await discoverLocalCatalogModels(r.endpoint, r.apiKey, r.headers);
  for (const model of live) {
    addConfigured(model.slug, model.displayName);
  }
  if (configured.length === 0) {
    addConfigured('gpt-4o');
  }
  return configured;
}

async function discoverLocalCatalogModels(
  endpoint: string,
  apiKey: string,
  headers: Record<string, string>,
): Promise<CodexCatalogModel[]> {
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
    const body = (await response.json()) as {
      data?: Array<{ id?: unknown; name?: unknown }>;
      models?: Array<{ id?: unknown; name?: unknown } | string>;
    };
    const models: CodexCatalogModel[] = [];
    const add = (id: unknown, name: unknown) => {
      if (
        typeof id !== 'string' ||
        !id.trim() ||
        models.some((model) => model.slug === id.trim())
      ) {
        return;
      }
      models.push({
        slug: id.trim(),
        displayName: typeof name === 'string' && name.trim() ? name.trim() : undefined,
      });
    };
    for (const item of body.data ?? []) {
      add(item?.id, item?.name);
    }
    for (const item of body.models ?? []) {
      if (typeof item === 'string') {
        add(item, undefined);
      } else {
        add(item?.id, item?.name);
      }
    }
    return models;
  } catch {
    return [];
  }
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

function inferHotplugRoot(state: ClientState): string | undefined {
  for (const p of state.managedPaths) {
    const idx = p.replace(/\\/g, '/').indexOf('/clients/codex/');
    if (idx > 0) {
      return p.slice(0, idx);
    }
  }
  return undefined;
}

export const codexClient = createCodexClient();
