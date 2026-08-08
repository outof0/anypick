/**
 * Dual-protocol reverse proxy: OpenAI + Anthropic → Google Gemini API.
 *
 *   Codex  OPENAI_BASE_URL     → POST /v1/responses (and chat/completions)
 *   Claude ANTHROPIC_BASE_URL  → POST /v1/messages
 *
 * Auth: GEMINI_API_KEY (or GOOGLE_API_KEY) from snapshot .env / live path.
 * Upstream: generativelanguage.googleapis.com (generateContent).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathExists, writeJsonFile } from '../../utils/fs';
import { withFileLock } from '../../utils/lock';
import { readGeminiApiKeyFromEnvFile } from '../gemini';
import {
  loadAntigravityOAuthCredentials,
  type GeminiOAuthCredentials,
} from '../gemini-antigravity-oauth';
import type { AnthropicMessageRequest, OpenAIChatRequest } from '../protocol/anthropic';
import {
  anthropicToGemini,
  compareGeminiModelIds,
  geminiToAnthropic,
  geminiToOpenAI,
  geminiToOpenAIResponses,
  openAIToGemini,
  openAIResponsesToGemini,
  resolveGeminiModel,
  type GeminiModelCatalog,
  type GeminiModelDescriptor,
  type GeminiModelResolution,
  type GeminiGenerateRequest,
  type GeminiGenerateResponse,
  type OpenAIResponsesRequest,
  type OpenAIResponsesResponse,
} from '../protocol/gemini/translate';
import { normalizeLocalApiUrl, readBody, requireProxyAuth } from '../proxy-shared';
import { assertLoopbackHost } from '../../utils/network';
import { classifyUpstreamFailure, CooldownRegistry } from '../upstream-policy';
import {
  reasoningFromAnthropic,
  reasoningFromOpenAI,
  type ReasoningEffort,
  type ReasoningIntent,
} from '../reasoning';

export interface GeminiProxyServerOptions {
  host: string;
  port: number;
  /** Path to snapshot or live dir containing .env (and optionally oauth). */
  authDir: string;
  /**
   * Optional multi-account dirs (pool mode). Failover on 401/429.
   * When set, keys are loaded from each dir's .env.
   */
  authDirs?: string[];
  /** Override API key (tests). Single key — ignores dirs. */
  apiKey?: string;
  /** Optional Code Assist project for OAuth accounts. */
  oauthProject?: string;
  /** OAuth identity to use for Code Assist. Defaults to auto (CLI, then Antigravity). */
  oauthSource?: GeminiOAuthSource;
  /** Read Antigravity OAuth from this file instead of the OS keychain (tests/portable setups). */
  antigravityOAuthFile?: string;
  upstream?: string;
  /** Override the Code Assist base URL (primarily for tests). */
  codeAssistUpstream?: string;
  /** Per-instance high-entropy secret (PROXY-01) required on credentialed routes. */
  token?: string;
  log?: (line: string) => void;
  quiet?: boolean;
}

const COMPAT_LABEL = 'OpenAI + Anthropic → Gemini API';
const DEFAULT_UPSTREAM = 'https://generativelanguage.googleapis.com';
const CODE_ASSIST_UPSTREAM = 'https://cloudcode-pa.googleapis.com';
const ANTIGRAVITY_CODE_ASSIST_UPSTREAM = 'https://daily-cloudcode-pa.googleapis.com';
const OAUTH_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = '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';
const ANTIGRAVITY_OAUTH_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_OAUTH_CLIENT_SECRET = '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';

export type GeminiOAuthSource = 'auto' | 'gemini-cli' | 'antigravity';
type GeminiAuthRoute = 'api-key' | Exclude<GeminiOAuthSource, 'auto'>;

interface OAuthProfile {
  clientId: string;
  clientSecret: string;
  ideType: 'GEMINI_CLI' | 'ANTIGRAVITY';
  userAgent?: string;
}

interface OAuthRouteState {
  credentials?: GeminiOAuthCredentials | null;
  project?: string;
}

interface RoutedModelResolution extends GeminiModelResolution {
  route: GeminiAuthRoute;
}

const MODEL_CATALOG_TTL_MS = 10 * 60_000;
const MODEL_CATALOG_FAILURE_TTL_MS = 60_000;

function isAuthEntitlementRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:HTTP\s*)?\b(?:401|403)\b|unauthorized|forbidden|permission denied/i.test(message);
}

function reasoningIntentToModelEffort(intent: ReasoningIntent): ReasoningEffort | undefined {
  if (intent.budgetTokens != null) {
    // A manual token budget is already exact; do not silently replace it with
    // a catalog tier selected through a different control surface.
    return undefined;
  }
  if (intent.enabled === false) {
    return 'minimal';
  }
  return intent.effort ?? (intent.enabled === true ? 'medium' : undefined);
}

export function createGeminiProxyServer(opts: GeminiProxyServerOptions): Server {
  assertLoopbackHost(opts.host);
  const upstream = (opts.upstream ?? DEFAULT_UPSTREAM).replace(/\/$/, '');
  const oauthSource = opts.oauthSource ?? 'auto';
  const proxyToken = opts.token ?? process.env.HOTPLUG_PROXY_TOKEN ?? '';
  const oauthProfile = (source: Exclude<GeminiOAuthSource, 'auto'>): OAuthProfile =>
    source === 'antigravity'
      ? {
          clientId: process.env.ANTIGRAVITY_OAUTH_CLIENT_ID?.trim() || ANTIGRAVITY_OAUTH_CLIENT_ID,
          clientSecret:
            process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim() || ANTIGRAVITY_OAUTH_CLIENT_SECRET,
          ideType: 'ANTIGRAVITY',
          userAgent: 'antigravity/hub/2.3.1 (aidev_client)',
        }
      : {
          clientId: OAUTH_CLIENT_ID,
          clientSecret: OAUTH_CLIENT_SECRET,
          ideType: 'GEMINI_CLI',
        };
  const codeAssistBase = (source: Exclude<GeminiOAuthSource, 'auto'>): string =>
    (
      opts.codeAssistUpstream ??
      (source === 'antigravity' ? ANTIGRAVITY_CODE_ASSIST_UPSTREAM : CODE_ASSIST_UPSTREAM)
    ).replace(/\/$/, '');
  const log =
    opts.log ?? (opts.quiet ? () => {} : (line: string) => process.stderr.write(`${line}\n`));

  /** Ordered API keys for failover (sticky index until error). */
  let keyRing: string[] = [];
  const oauthStates = new Map<Exclude<GeminiOAuthSource, 'auto'>, OAuthRouteState>();
  const oauthRefreshInflight = new Map<Exclude<GeminiOAuthSource, 'auto'>, Promise<string>>();
  const modelCatalogs = new Map<
    GeminiAuthRoute,
    { value: GeminiModelCatalog; fetchedAt: number }
  >();
  const modelCatalogInflight = new Map<GeminiAuthRoute, Promise<GeminiModelCatalog>>();
  const modelCatalogFailures = new Map<GeminiAuthRoute, { error: unknown; fetchedAt: number }>();
  /**
   * Keep a proven auto-auth route sticky for this process. Without this, every
   * model-list poll starts at Gemini CLI again even after its account returned
   * 401/403 and Antigravity served the request successfully.
   */
  let autoActiveRoute: GeminiAuthRoute | undefined;
  const proxySessionId = randomUUID();
  const cooldowns = new CooldownRegistry();

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function loadKeyRing(): Promise<string[]> {
    if (opts.apiKey?.trim()) {
      return [opts.apiKey.trim()];
    }
    if (keyRing.length) {
      return keyRing;
    }
    const dirs = opts.authDirs && opts.authDirs.length > 0 ? opts.authDirs : [opts.authDir];
    const keys: string[] = [];
    for (const dir of dirs) {
      const envFile = dir.endsWith('.env') ? dir : join(dir, '.env');
      const k = await readGeminiApiKeyFromEnvFile(envFile);
      if (k && !keys.includes(k)) {
        keys.push(k);
      }
    }
    if (keys.length === 0) {
      const envKey = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
      if (envKey) {
        keys.push(envKey);
      }
    }
    if (keys.length === 0) {
      throw new Error(
        `No GEMINI_API_KEY in auth dir(s). Save an API-key Gemini login, or set GEMINI_API_KEY.`,
      );
    }
    keyRing = keys;
    return keys;
  }

  async function currentKey(): Promise<string> {
    const keys = await loadKeyRing();
    return keys[0];
  }

  function oauthState(source: Exclude<GeminiOAuthSource, 'auto'>): OAuthRouteState {
    const existing = oauthStates.get(source);
    if (existing) {
      return existing;
    }
    const created: OAuthRouteState = { project: opts.oauthProject };
    oauthStates.set(source, created);
    return created;
  }

  async function loadOAuthCredentials(
    source: Exclude<GeminiOAuthSource, 'auto'>,
  ): Promise<GeminiOAuthCredentials | null> {
    const state = oauthState(source);
    if (state.credentials !== undefined) {
      return state.credentials;
    }
    if (source === 'antigravity') {
      state.credentials = await loadAntigravityOAuthCredentials(opts.antigravityOAuthFile);
      return state.credentials;
    }
    const file = join(opts.authDir, 'oauth_creds.json');
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as GeminiOAuthCredentials;
      state.credentials = parsed.refresh_token || parsed.access_token ? parsed : null;
    } catch {
      state.credentials = null;
    }
    return state.credentials;
  }

  /** Respect the Gemini CLI's selected auth mode; a stale .env must not beat OAuth. */
  async function geminiCliRoute(): Promise<GeminiAuthRoute> {
    const credentials = await loadOAuthCredentials('gemini-cli');
    if (credentials && !opts.apiKey) {
      try {
        const raw = await readFile(join(opts.authDir, 'auth-settings.json'), 'utf8');
        const settings = JSON.parse(raw) as { security?: { auth?: { selectedType?: string } } };
        if (settings.security?.auth?.selectedType === 'oauth-personal') {
          return 'gemini-cli';
        }
      } catch {
        // OAuth credentials without auth-settings are still a complete CLI login.
        return 'gemini-cli';
      }
    }
    try {
      await currentKey();
      return 'api-key';
    } catch {
      if (credentials) {
        return 'gemini-cli';
      }
      throw new Error('No usable Gemini CLI OAuth or API-key credential was found.');
    }
  }

  function activateAutoRoute(route: GeminiAuthRoute, reason: string): void {
    if (oauthSource !== 'auto' || autoActiveRoute === route) {
      return;
    }
    autoActiveRoute = route;
    log(`  auth auto: active route=${route} (${reason})`);
  }

  function resetAutoRoute(route: GeminiAuthRoute, reason: string): void {
    if (oauthSource !== 'auto' || autoActiveRoute !== route) {
      return;
    }
    autoActiveRoute = undefined;
    log(`  auth auto: reset route=${route} (${reason})`);
  }

  async function authRoutes(includeAntigravity: boolean): Promise<GeminiAuthRoute[]> {
    if (oauthSource === 'gemini-cli') {
      return [await geminiCliRoute()];
    }
    if (oauthSource === 'antigravity') {
      if (!(await loadOAuthCredentials('antigravity'))) {
        throw new Error('No Antigravity OAuth credentials found in the OS keychain.');
      }
      return ['antigravity'];
    }
    if (autoActiveRoute === 'antigravity') {
      try {
        if (await loadOAuthCredentials('antigravity')) {
          return ['antigravity'];
        }
        resetAutoRoute('antigravity', 'credentials unavailable');
      } catch (err) {
        resetAutoRoute(
          'antigravity',
          err instanceof Error ? err.message : 'credentials unavailable',
        );
      }
    }
    const routes: GeminiAuthRoute[] = [];
    try {
      routes.push(await geminiCliRoute());
    } catch (err) {
      log(
        `  auth auto: Gemini CLI unavailable (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (includeAntigravity) {
      // A custom Code Assist endpoint is commonly an isolated test/dev server.
      // Do not leak a real desktop keychain credential into it unless the
      // operator also supplied the matching portable Antigravity credential.
      if (opts.codeAssistUpstream && !opts.antigravityOAuthFile) {
        if (routes.length === 0) {
          throw new Error(
            'Antigravity auto-discovery is disabled for a custom Code Assist endpoint; provide antigravityOAuthFile.',
          );
        }
        return [...new Set(routes)];
      }
      try {
        if (await loadOAuthCredentials('antigravity')) {
          routes.push('antigravity');
        }
      } catch (err) {
        log(
          `  auth auto: Antigravity unavailable (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
    if (routes.length === 0 && !includeAntigravity) {
      return authRoutes(true);
    }
    if (routes.length === 0) {
      throw new Error('No usable Gemini CLI or Antigravity credential was found.');
    }
    return [...new Set(routes)];
  }

  async function currentOAuthToken(source: Exclude<GeminiOAuthSource, 'auto'>): Promise<string> {
    const credentials = await loadOAuthCredentials(source);
    if (!credentials) {
      throw new Error(
        source === 'antigravity'
          ? 'No Antigravity OAuth credentials found in the OS keychain.'
          : 'No Gemini OAuth credentials found in oauth_creds.json.',
      );
    }
    const expiresSoon = !credentials.expiry_date || credentials.expiry_date < Date.now() + 60_000;
    if (!expiresSoon && credentials.access_token) {
      return credentials.access_token;
    }
    if (!credentials.refresh_token) {
      throw new Error('Gemini OAuth access token expired and no refresh token is available.');
    }
    const existing = oauthRefreshInflight.get(source);
    if (existing) {
      return existing;
    }
    const refresh = refreshOAuthToken(source, credentials).finally(() => {
      oauthRefreshInflight.delete(source);
    });
    oauthRefreshInflight.set(source, refresh);
    return refresh;
  }

  async function refreshOAuthToken(
    source: Exclude<GeminiOAuthSource, 'auto'>,
    initial: GeminiOAuthCredentials,
  ): Promise<string> {
    const refresh = async (credentials: GeminiOAuthCredentials): Promise<string> => {
      if (!credentials.refresh_token) {
        throw new Error('Gemini OAuth access token expired and no refresh token is available.');
      }
      const state = oauthState(source);
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: oauthProfile(source).clientId,
          client_secret: oauthProfile(source).clientSecret,
          refresh_token: credentials.refresh_token,
          grant_type: 'refresh_token',
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await response.json().catch(() => ({}))) as {
        access_token?: string;
        expires_in?: number;
        token_type?: string;
        error?: string;
        error_description?: string;
      };
      if (!response.ok || !body.access_token) {
        throw new GeminiUpstreamError(
          response.status || 401,
          response.headers,
          body.error_description || body.error || 'Gemini OAuth refresh failed',
        );
      }
      const refreshed: GeminiOAuthCredentials = {
        ...credentials,
        access_token: body.access_token,
        token_type: body.token_type ?? credentials.token_type ?? 'Bearer',
        expiry_date: Date.now() + (body.expires_in ?? 3600) * 1000,
      };
      state.credentials = refreshed;
      if (source === 'gemini-cli') {
        await writeJsonFile(join(opts.authDir, 'oauth_creds.json'), refreshed, 0o600);
      }
      return refreshed.access_token!;
    };

    if (source !== 'gemini-cli') {
      return refresh(initial);
    }

    const authPath = join(opts.authDir, 'oauth_creds.json');
    return withFileLock(
      `${authPath}.refresh.lock`,
      async () => {
        // Another process may have rotated the refresh token while this
        // request waited. Reload under the lock and reuse the fresh access
        // token instead of redeeming the old token again.
        const state = oauthState(source);
        state.credentials = undefined;
        const latest = await loadOAuthCredentials(source);
        if (!latest) {
          throw new Error('No Gemini OAuth credentials found in oauth_creds.json.');
        }
        const expiresSoon = !latest.expiry_date || latest.expiry_date < Date.now() + 60_000;
        if (!expiresSoon && latest.access_token) {
          return latest.access_token;
        }
        if (!latest.refresh_token) {
          throw new Error('Gemini OAuth access token expired and no refresh token is available.');
        }
        return refresh(latest);
      },
      { resource: `Gemini OAuth refresh ${authPath}` },
    );
  }

  async function resolveOAuthProject(
    source: Exclude<GeminiOAuthSource, 'auto'>,
    token: string,
  ): Promise<string | undefined> {
    const state = oauthState(source);
    const profile = oauthProfile(source);
    if (state.project) {
      return state.project;
    }
    const response = await fetch(`${codeAssistBase(source)}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(profile.userAgent ? { 'user-agent': profile.userAgent } : {}),
      },
      body: JSON.stringify({
        metadata:
          profile.ideType === 'ANTIGRAVITY'
            ? { ideType: profile.ideType }
            : {
                ideType: profile.ideType,
                platform: process.platform === 'darwin' ? 'DARWIN_ARM64' : 'PLATFORM_UNSPECIFIED',
                pluginType: 'GEMINI',
              },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json().catch(() => ({}))) as {
      cloudaicompanionProject?: string;
      currentTier?: { id?: string };
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new GeminiUpstreamError(
        response.status,
        response.headers,
        body.error?.message ?? `Code Assist loadCodeAssist HTTP ${response.status}`,
      );
    }
    state.project = body.cloudaicompanionProject || undefined;
    log(
      `  OAuth ${source} tier=${body.currentTier?.id ?? 'unknown'} project=${state.project ?? 'managed'}`,
    );
    return state.project;
  }

  async function refreshModelCatalog(route: GeminiAuthRoute): Promise<GeminiModelCatalog> {
    const existing = modelCatalogInflight.get(route);
    if (existing) {
      return existing;
    }
    const inflight = (async () => {
      let catalog: GeminiModelCatalog;
      if (route !== 'api-key') {
        const token = await currentOAuthToken(route);
        const project = await resolveOAuthProject(route, token);
        const profile = oauthProfile(route);
        catalog = await listGeminiModelsFromCodeAssist(
          codeAssistBase(route),
          token,
          project,
          log,
          profile.userAgent,
        );
      } else {
        catalog = {
          models: (await listGeminiModelsFromGoogle(upstream, await currentKey(), log)).map(
            (id) => ({
              id,
            }),
          ),
        };
      }
      catalog = {
        ...catalog,
        models: catalog.models.toSorted((a, b) => compareGeminiModelIds(a.id, b.id)),
      };
      modelCatalogs.set(route, { value: catalog, fetchedAt: Date.now() });
      modelCatalogFailures.delete(route);
      log(`  list models ← ${catalog.models.length} auth=${route}`);
      return catalog;
    })()
      .catch((error: unknown) => {
        modelCatalogFailures.set(route, { error, fetchedAt: Date.now() });
        resetAutoRoute(route, 'model catalog unavailable');
        throw error;
      })
      .finally(() => {
        modelCatalogInflight.delete(route);
      });
    modelCatalogInflight.set(route, inflight);
    return inflight;
  }

  async function liveModelCatalog(route: GeminiAuthRoute): Promise<GeminiModelCatalog> {
    const cached = modelCatalogs.get(route);
    if (cached && Date.now() - cached.fetchedAt < MODEL_CATALOG_TTL_MS) {
      return cached.value;
    }
    const failed = modelCatalogFailures.get(route);
    if (failed && Date.now() - failed.fetchedAt < MODEL_CATALOG_FAILURE_TTL_MS) {
      throw failed.error;
    }
    return refreshModelCatalog(route);
  }

  async function resolveRequestModel(
    requested: string | undefined,
    effort?: ReasoningEffort,
  ): Promise<RoutedModelResolution> {
    const primaryRoutes = await authRoutes(false);
    let passthrough: RoutedModelResolution | undefined;
    let lastError: unknown;
    let primaryEntitlementRejected = false;
    for (const route of primaryRoutes) {
      try {
        const catalog = await liveModelCatalog(route);
        const resolution = resolveGeminiModel(requested, catalog, effort);
        if (isCatalogResolution(resolution, catalog)) {
          return { ...resolution, route };
        }
        passthrough ??= { ...resolution, route };
      } catch (err) {
        lastError = err;
        if (route !== 'antigravity' && isAuthEntitlementRejection(err)) {
          primaryEntitlementRejected = true;
        }
        const resolution = resolveGeminiModel(requested, [], effort);
        if (resolution.id) {
          passthrough ??= { ...resolution, route };
        }
      }
    }

    // Only touch the app credential when CLI did not prove model entitlement.
    if (oauthSource === 'auto' && !opts.apiKey) {
      const fallbackRoutes = (await authRoutes(true)).filter(
        (route) => !primaryRoutes.includes(route),
      );
      for (const route of fallbackRoutes) {
        try {
          const catalog = await liveModelCatalog(route);
          const resolution = resolveGeminiModel(requested, catalog, effort);
          if (route === 'antigravity' && primaryEntitlementRejected) {
            activateAutoRoute(route, 'Gemini CLI entitlement rejected');
          }
          if (isCatalogResolution(resolution, catalog)) {
            log(`  auth auto: ${requested ?? '(default)'} resolved via ${route}`);
            return { ...resolution, route };
          }
          if (primaryEntitlementRejected && resolution.id) {
            passthrough = { ...resolution, route };
          } else {
            passthrough ??= { ...resolution, route };
          }
        } catch (err) {
          lastError = err;
        }
      }
    }
    if (passthrough?.id) {
      if (lastError) {
        log(
          `  model catalog unavailable; forwarding ${passthrough.id} unchanged (${lastError instanceof Error ? lastError.message : String(lastError)})`,
        );
      }
      return passthrough;
    }
    throw lastError ?? new Error('No model could be discovered for the available credentials.');
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = normalizeLocalApiUrl(req.url ?? '/');
    const path = url.split('?')[0] ?? '/';
    const method = req.method ?? 'GET';

    if (!checkCors(req, res)) {
      return;
    }
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if ((method === 'GET' || method === 'HEAD') && (path === '/' || path === '/health')) {
      json(res, 200, {
        ok: true,
        service: 'hotplug-gemini-proxy',
        compatibility: COMPAT_LABEL,
        instanceId: process.env.HOTPLUG_INSTANCE_ID ?? null,
        // Health is process/config state only; do not read the key here.
        auth: 'ok',
        clients: {
          codex: 'OPENAI_BASE_URL → /v1/responses',
          claude: 'ANTHROPIC_BASE_URL → /v1/messages',
        },
        endpoints: {
          openai: ['/v1/chat/completions', '/v1/responses', '/v1/models'],
          anthropic: ['/v1/messages'],
        },
        oauthSource,
        upstream,
      });
      return;
    }

    if (method === 'GET' && path === '/v1/models') {
      if (!requireProxyAuth(req, res, proxyToken)) {
        return;
      }
      await handleListModels(res);
      return;
    }

    if (method === 'POST' && path === '/v1/chat/completions') {
      if (!requireProxyAuth(req, res, proxyToken)) {
        return;
      }
      await handleOpenAI(req, res);
      return;
    }

    if (method === 'POST' && path === '/v1/responses') {
      if (!requireProxyAuth(req, res, proxyToken)) {
        return;
      }
      await handleResponses(req, res);
      return;
    }

    if (method === 'POST' && path === '/v1/messages') {
      if (!requireProxyAuth(req, res, proxyToken)) {
        return;
      }
      await handleAnthropic(req, res);
      return;
    }

    json(res, 404, {
      error: {
        message: `Not found: ${path}. Codex: /v1/responses · Claude: /v1/messages`,
        type: 'not_found_error',
      },
    });
  }

  /** List only models discovered for the active API-key/OAuth account. */
  async function handleListModels(res: ServerResponse): Promise<void> {
    try {
      const routes = await authRoutes(oauthSource === 'auto' && !opts.apiKey);
      const discovered: Array<{ route: GeminiAuthRoute; catalog: GeminiModelCatalog }> = [];
      let lastError: unknown;
      let primaryEntitlementRejected = false;
      for (const route of routes) {
        try {
          const catalog = await liveModelCatalog(route);
          discovered.push({ route, catalog });
          if (route === 'antigravity' && primaryEntitlementRejected) {
            activateAutoRoute(route, 'Gemini CLI entitlement rejected');
          }
        } catch (err) {
          lastError = err;
          if (route !== 'antigravity' && isAuthEntitlementRejection(err)) {
            primaryEntitlementRejected = true;
          }
          log(`  list models auth=${route} failed; trying next source`);
        }
      }
      if (discovered.length === 0) {
        throw lastError ?? new Error('No auth source returned a Gemini model catalog.');
      }
      const models = new Map<
        string,
        { descriptor: GeminiModelDescriptor; route: GeminiAuthRoute }
      >();
      for (const { route, catalog } of discovered) {
        for (const descriptor of catalog.models) {
          if (!models.has(descriptor.id)) {
            models.set(descriptor.id, { descriptor, route });
          }
        }
      }
      json(res, 200, {
        object: 'list',
        data: [...models.values()].map(({ descriptor, route }) => {
          const value: {
            id: string;
            object: 'model';
            owned_by: string;
            display_name?: string;
          } = {
            id: descriptor.id,
            object: 'model',
            owned_by: route === 'api-key' ? 'google' : 'google-code-assist',
          };
          if (descriptor.displayName) {
            value.display_name = descriptor.displayName;
          }
          return value;
        }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  list models ✗ ${msg}`);
      // Fail honestly — do not invent model ids
      json(res, 502, {
        error: {
          message: `Failed to list Gemini models from Google: ${msg}`,
          type: 'proxy_error',
        },
      });
    }
  }

  async function handleOpenAI(req: IncomingMessage, res: ServerResponse): Promise<void> {
    log('POST /v1/chat/completions → Gemini');
    try {
      const raw = await readBody(req);
      let body: OpenAIChatRequest;
      try {
        body = JSON.parse(raw.toString('utf8') || '{}') as OpenAIChatRequest;
      } catch {
        json(res, 400, {
          error: { message: 'Invalid JSON body', type: 'invalid_request_error' },
        });
        return;
      }

      const modelEffort = reasoningIntentToModelEffort(reasoningFromOpenAI(body));
      const resolution = await resolveRequestModel(body.model, modelEffort);
      if (!resolution.id) {
        json(res, 400, {
          error: {
            message: 'model is required and no model could be discovered for this account',
            type: 'invalid_request_error',
          },
        });
        return;
      }
      const model = resolution.id;
      if (resolution.remapped) {
        log(
          `  model ${body.model ?? '(empty)'} → ${model} (${resolution.reason ?? 'catalog'}${modelEffort ? `, effort=${modelEffort}` : ''})`,
        );
      }
      const geminiBody = openAIToGemini(body, model);
      if (body.stream) {
        // Non-stream call then fake single SSE chunk for basic clients
        const result = await callGeminiWithAutoFallback(
          body.model,
          resolution,
          geminiBody,
          false,
          modelEffort,
        );
        const responseModel = result.resolution.id;
        const openai = geminiToOpenAI(result.response, responseModel);
        if (openai.error) {
          json(res, 502, openai);
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const content = openai.choices?.[0]?.message?.content ?? '';
        const reasoning = openai.choices?.[0]?.message?.reasoning_content ?? '';
        if (reasoning) {
          res.write(
            `data: ${JSON.stringify({
              id: openai.id,
              object: 'chat.completion.chunk',
              model: responseModel,
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', reasoning_content: reasoning },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
        }
        res.write(
          `data: ${JSON.stringify({
            id: openai.id,
            object: 'chat.completion.chunk',
            model: responseModel,
            choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: openai.id,
            object: 'chat.completion.chunk',
            model: responseModel,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const result = await callGeminiWithAutoFallback(
        body.model,
        resolution,
        geminiBody,
        false,
        modelEffort,
      );
      const openai = geminiToOpenAI(result.response, result.resolution.id);
      if (openai.error) {
        json(res, 502, openai);
        return;
      }
      json(res, 200, openai);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ✗ ${msg}`);
      writeGeminiError(res, err, msg);
    }
  }

  async function handleAnthropic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    log('POST /v1/messages → Gemini');
    try {
      const raw = await readBody(req);
      let body: AnthropicMessageRequest;
      try {
        body = JSON.parse(raw.toString('utf8') || '{}') as AnthropicMessageRequest;
      } catch {
        json(res, 400, {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Invalid JSON body' },
        });
        return;
      }
      if (!body.model) {
        json(res, 400, {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'model is required' },
        });
        return;
      }
      if (body.max_tokens == null) {
        body.max_tokens = 4096;
      }

      const modelEffort = reasoningIntentToModelEffort(reasoningFromAnthropic(body));
      const resolution = await resolveRequestModel(body.model, modelEffort);
      if (!resolution.id) {
        json(res, 400, {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'No matching Gemini model is available for this account.',
          },
        });
        return;
      }
      if (resolution.remapped) {
        log(
          `  model ${body.model} → ${resolution.id} (${resolution.reason ?? 'catalog'}${modelEffort ? `, effort=${modelEffort}` : ''})`,
        );
      }
      const { gemini } = anthropicToGemini(body, resolution.id);
      const result = await callGeminiWithAutoFallback(
        body.model,
        resolution,
        gemini,
        false,
        modelEffort,
      );
      const responseModel = result.resolution.id;
      const anthropic = geminiToAnthropic(result.response, responseModel);
      if ('type' in anthropic && anthropic.type === 'error') {
        json(res, 502, anthropic);
        return;
      }

      if (body.stream) {
        // Minimal Anthropic SSE from non-stream Gemini response
        const msg = anthropic;
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const id = msg.id ?? `msg_${Date.now()}`;
        writeSse(res, 'message_start', {
          type: 'message_start',
          message: {
            id,
            type: 'message',
            role: 'assistant',
            model: responseModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: msg.usage?.input_tokens ?? 0, output_tokens: 0 },
          },
        });
        msg.content.forEach((block, index) => {
          if (block.type === 'thinking') {
            writeSse(res, 'content_block_start', {
              type: 'content_block_start',
              index,
              content_block: {
                type: 'thinking',
                thinking: '',
                signature: '',
              },
            });
            if (block.thinking) {
              writeSse(res, 'content_block_delta', {
                type: 'content_block_delta',
                index,
                delta: { type: 'thinking_delta', thinking: block.thinking },
              });
            }
            if (block.signature) {
              writeSse(res, 'content_block_delta', {
                type: 'content_block_delta',
                index,
                delta: { type: 'signature_delta', signature: block.signature },
              });
            }
          } else if (block.type === 'tool_use') {
            writeSse(res, 'content_block_start', {
              type: 'content_block_start',
              index,
              content_block: {
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: {},
                ...(block.thought_signature ? { thought_signature: block.thought_signature } : {}),
              },
            });
            writeSse(res, 'content_block_delta', {
              type: 'content_block_delta',
              index,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
            });
          } else if (block.type === 'redacted_thinking') {
            writeSse(res, 'content_block_start', {
              type: 'content_block_start',
              index,
              content_block: block,
            });
          } else {
            writeSse(res, 'content_block_start', {
              type: 'content_block_start',
              index,
              content_block: { type: 'text', text: '' },
            });
            if (block.text) {
              writeSse(res, 'content_block_delta', {
                type: 'content_block_delta',
                index,
                delta: { type: 'text_delta', text: block.text },
              });
            }
          }
          writeSse(res, 'content_block_stop', { type: 'content_block_stop', index });
        });
        writeSse(res, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: msg.stop_reason, stop_sequence: msg.stop_sequence },
          usage: { output_tokens: msg.usage?.output_tokens ?? 0 },
        });
        writeSse(res, 'message_stop', { type: 'message_stop' });
        res.end();
        return;
      }

      json(res, 200, anthropic);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ✗ ${msg}`);
      writeGeminiError(res, err, msg, true);
    }
  }

  async function handleResponses(req: IncomingMessage, res: ServerResponse): Promise<void> {
    log('POST /v1/responses → Gemini');
    try {
      const raw = await readBody(req);
      let body: OpenAIResponsesRequest;
      try {
        body = JSON.parse(raw.toString('utf8') || '{}') as OpenAIResponsesRequest;
      } catch {
        json(res, 400, {
          error: { message: 'Invalid JSON body', type: 'invalid_request_error' },
        });
        return;
      }
      const modelEffort = reasoningIntentToModelEffort(reasoningFromOpenAI(body));
      const resolution = await resolveRequestModel(body.model, modelEffort);
      if (!resolution.id) {
        json(res, 400, {
          error: {
            message: 'model is required and no model could be discovered for this account',
            type: 'invalid_request_error',
          },
        });
        return;
      }
      if (resolution.remapped) {
        log(
          `  model ${body.model ?? '(empty)'} → ${resolution.id} (${resolution.reason ?? 'catalog'}${modelEffort ? `, effort=${modelEffort}` : ''})`,
        );
      }
      const geminiBody = openAIResponsesToGemini(body, resolution.id);
      const result = await callGeminiWithAutoFallback(
        body.model,
        resolution,
        geminiBody,
        false,
        modelEffort,
      );
      const response = geminiToOpenAIResponses(result.response, result.resolution.id);
      if (body.stream) {
        writeOpenAIResponsesStream(res, response);
        return;
      }
      json(res, 200, response);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ✗ ${msg}`);
      writeGeminiError(res, err, msg);
    }
  }

  async function callGeminiWithAutoFallback(
    requested: string | undefined,
    resolution: RoutedModelResolution,
    body: GeminiGenerateRequest,
    stream: boolean,
    effort?: ReasoningEffort,
  ): Promise<{ response: GeminiGenerateResponse; resolution: RoutedModelResolution }> {
    try {
      return {
        response: await callGemini(resolution.route, resolution.id, body, stream),
        resolution,
      };
    } catch (err) {
      if (
        resolution.route === 'antigravity' &&
        err instanceof GeminiUpstreamError &&
        [401, 403, 404].includes(err.status)
      ) {
        resetAutoRoute('antigravity', `upstream returned ${err.status}`);
      }
      const canFallback =
        oauthSource === 'auto' &&
        !opts.apiKey &&
        resolution.route !== 'antigravity' &&
        err instanceof GeminiUpstreamError &&
        [401, 403, 404].includes(err.status);
      if (!canFallback) {
        throw err;
      }
      const routes = await authRoutes(true);
      if (!routes.includes('antigravity')) {
        throw err;
      }
      let fallback: RoutedModelResolution;
      try {
        const catalog = await liveModelCatalog('antigravity');
        fallback = {
          ...resolveGeminiModel(requested, catalog, effort),
          route: 'antigravity',
        };
      } catch {
        fallback = {
          ...resolveGeminiModel(requested, [], effort),
          route: 'antigravity',
        };
      }
      if (!fallback.id) {
        throw err;
      }
      log(
        `  auth auto: ${resolution.route} returned ${err.status}; retrying ${requested ?? resolution.id} via antigravity as ${fallback.id}`,
      );
      const response = await callGemini(fallback.route, fallback.id, body, stream);
      if ([401, 403].includes(err.status)) {
        activateAutoRoute('antigravity', `Gemini CLI returned ${err.status}`);
      }
      return {
        response,
        resolution: fallback,
      };
    }
  }

  async function callGemini(
    route: GeminiAuthRoute,
    model: string,
    body: GeminiGenerateRequest,
    stream: boolean,
  ): Promise<GeminiGenerateResponse> {
    const action = stream ? 'streamGenerateContent' : 'generateContent';
    const keyMode = route === 'api-key';
    const upstreamModel = model;
    const token = keyMode ? await currentKey() : await currentOAuthToken(route);
    const target = keyMode
      ? `${upstream}/v1beta/models/${encodeURIComponent(upstreamModel)}:${action}`
      : `${codeAssistBase(route)}/v1internal:${action}`;
    const routeKey = `gemini:${route}:${upstreamModel}`;
    const cooling = cooldowns.remainingMs(routeKey);
    if (cooling > 0) {
      throw new GeminiUpstreamError(
        429,
        new Headers({ 'retry-after': String(Math.ceil(cooling / 1000)) }),
        'Gemini route is cooling down after a rate limit.',
      );
    }
    const thinking = body.generationConfig?.thinkingConfig;
    const thinkingLog = thinking?.thinkingLevel
      ? ` thinking=${thinking.thinkingLevel.toLowerCase()}`
      : thinking?.thinkingBudget != null
        ? ` thinkingBudget=${thinking.thinkingBudget}`
        : '';
    log(`  → Gemini ${upstreamModel} ${action} auth=${route}${thinkingLog}`);
    const requestBody = keyMode
      ? body
      : {
          model: upstreamModel,
          project: await resolveOAuthProject(route, token),
          user_prompt_id: randomUUID(),
          request: { ...body, session_id: proxySessionId },
        };
    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(keyMode
            ? { 'x-goog-api-key': token }
            : {
                authorization: `Bearer ${token}`,
                ...(oauthProfile(route).userAgent
                  ? { 'user-agent': oauthProfile(route).userAgent }
                  : {}),
              }),
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(600_000),
        redirect: 'manual',
      });
    } catch (err) {
      throw new GeminiUpstreamError(
        502,
        undefined,
        `Gemini network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = await upstreamRes.text();
    log(`  ← ${upstreamRes.status}`);
    if (!upstreamRes.ok) {
      if (upstreamRes.status === 429) {
        const bodyPreview = text.slice(0, 2000);
        const failure = classifyUpstreamFailure(
          upstreamRes.status,
          upstreamRes.headers,
          bodyPreview,
        );
        if (failure.retryAfterMs) {
          cooldowns.set(routeKey, failure.retryAfterMs);
        }
      }
      const upstreamError = new GeminiUpstreamError(
        upstreamRes.status,
        upstreamRes.headers,
        extractGeminiErrorMessage(text, upstreamRes.status),
        text,
      );
      if (!keyMode && upstreamRes.status === 404) {
        // Force the next alias/default resolution to re-read account availability.
        modelCatalogs.delete(route);
        modelCatalogFailures.delete(route);
      }
      throw upstreamError;
    }
    try {
      const parsed = JSON.parse(text) as GeminiGenerateResponse & {
        response?: GeminiGenerateResponse;
      };
      return keyMode ? parsed : (parsed.response ?? parsed);
    } catch {
      throw new GeminiUpstreamError(
        502,
        upstreamRes.headers,
        `Gemini returned non-JSON response: ${text.slice(0, 300)}`,
        text,
      );
    }
  }

  return server;
}

export async function listenGeminiProxy(
  opts: GeminiProxyServerOptions,
): Promise<{ endpoint: string; server: Server }> {
  const server = createGeminiProxyServer(opts);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : opts.port;
  const endpoint = `http://${opts.host}:${port}`;
  return { endpoint, server };
}

function checkCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      const loopback =
        (parsed.hostname === 'localhost' ||
          parsed.hostname === '127.0.0.1' ||
          parsed.hostname === '[::1]') &&
        (parsed.protocol === 'http:' || parsed.protocol === 'https:');
      if (!loopback) {
        json(res, 403, {
          error: {
            type: 'forbidden_origin',
            message: 'Only loopback browser origins are allowed.',
          },
        });
        return false;
      }
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
    } catch {
      json(res, 403, {
        error: { type: 'forbidden_origin', message: 'Invalid browser origin.' },
      });
      return false;
    }
  }
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'access-control-allow-headers',
    'content-type,authorization,x-api-key,anthropic-version,anthropic-beta',
  );
  return true;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.byteLength,
  });
  res.end(payload);
}

function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Emit the minimal complete Responses SSE lifecycle consumed by Codex. */
function writeOpenAIResponsesStream(res: ServerResponse, response: OpenAIResponsesResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  let sequence = 0;
  const emit = (type: string, payload: Record<string, unknown>) => {
    writeSse(res, type, { type, sequence_number: sequence++, ...payload });
  };
  const inProgressResponse = {
    ...response,
    status: 'in_progress',
    output: [],
    usage: null,
  };
  emit('response.created', { response: inProgressResponse });
  emit('response.in_progress', { response: inProgressResponse });

  response.output.forEach((item, outputIndex) => {
    const addedItem: Record<string, unknown> = {
      ...item,
      status: 'in_progress',
    };
    if (item.type === 'reasoning') {
      addedItem.summary = [];
    } else if (item.type === 'message') {
      addedItem.content = [];
    } else if (item.type === 'function_call') {
      addedItem.arguments = '';
    }
    emit('response.output_item.added', {
      output_index: outputIndex,
      item: addedItem,
    });

    if (item.type === 'reasoning') {
      (item.summary ?? []).forEach((part, summaryIndex) => {
        emit('response.reasoning_summary_part.added', {
          item_id: item.id,
          output_index: outputIndex,
          summary_index: summaryIndex,
          part: { type: 'summary_text', text: '' },
        });
        if (part.text) {
          emit('response.reasoning_summary_text.delta', {
            item_id: item.id,
            output_index: outputIndex,
            summary_index: summaryIndex,
            delta: part.text,
          });
        }
        emit('response.reasoning_summary_text.done', {
          item_id: item.id,
          output_index: outputIndex,
          summary_index: summaryIndex,
          text: part.text,
        });
        emit('response.reasoning_summary_part.done', {
          item_id: item.id,
          output_index: outputIndex,
          summary_index: summaryIndex,
          part,
        });
      });
    } else if (item.type === 'message') {
      (item.content ?? []).forEach((part, contentIndex) => {
        const emptyPart = { ...part, text: '' };
        emit('response.content_part.added', {
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          part: emptyPart,
        });
        if (part.text) {
          emit('response.output_text.delta', {
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            delta: part.text,
            logprobs: [],
          });
        }
        emit('response.output_text.done', {
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          text: part.text,
          logprobs: [],
        });
        emit('response.content_part.done', {
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          part,
        });
      });
    } else if (item.type === 'function_call') {
      if (item.arguments) {
        emit('response.function_call_arguments.delta', {
          item_id: item.id,
          output_index: outputIndex,
          delta: item.arguments,
        });
      }
      emit('response.function_call_arguments.done', {
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments ?? '',
      });
    }
    emit('response.output_item.done', { output_index: outputIndex, item });
  });

  emit('response.completed', { response });
  res.end();
}

class GeminiUpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly headers?: Headers,
    message = 'Gemini upstream error',
    readonly body?: string,
  ) {
    super(message);
    this.name = 'GeminiUpstreamError';
  }
}

function extractGeminiErrorMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    return parsed.error?.message ?? parsed.message ?? `Gemini upstream returned HTTP ${status}`;
  } catch {
    return body.slice(0, 500) || `Gemini upstream returned HTTP ${status}`;
  }
}

function writeGeminiError(
  res: ServerResponse,
  err: unknown,
  fallback: string,
  anthropic = false,
): void {
  if (err instanceof GeminiUpstreamError) {
    const retryAfter = err.headers?.get('retry-after');
    const body = anthropic
      ? {
          type: 'error',
          error: {
            type: err.status === 429 ? 'rate_limit_error' : 'api_error',
            message: err.message,
          },
        }
      : {
          error: {
            type: err.status === 429 ? 'rate_limit_error' : 'api_error',
            message: err.message,
          },
        };
    const payload = JSON.stringify(body);
    res.writeHead(err.status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      ...(retryAfter ? { 'retry-after': retryAfter } : {}),
    });
    res.end(payload);
    return;
  }
  json(
    res,
    502,
    anthropic
      ? { type: 'error', error: { message: fallback, type: 'proxy_error' } }
      : { error: { message: fallback, type: 'proxy_error' } },
  );
}

/** Resolve API key from auth directory (snapshot or live ~/.gemini). */
export async function loadGeminiProxyApiKey(authDir: string): Promise<string | null> {
  const envFile = authDir.endsWith('.env') ? authDir : join(authDir, '.env');
  if (await pathExists(envFile)) {
    return (await readGeminiApiKeyFromEnvFile(envFile)) ?? null;
  }
  return null;
}

/**
 * Page through Google Generative Language ListModels.
 * Returns bare ids (no `models/` prefix) that support generateContent.
 */
export async function listGeminiModelsFromGoogle(
  upstream: string,
  apiKey: string,
  log: (line: string) => void = () => {},
): Promise<string[]> {
  const base = upstream.replace(/\/$/, '');
  const ids: string[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  let pages = 0;
  const maxPages = 20;

  do {
    const url = new URL(`${base}/v1beta/models`);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('pageSize', '100');
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }

    const upstreamRes = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!upstreamRes.ok) {
      const text = await upstreamRes.text().catch(() => '');
      throw new Error(
        `Google ListModels HTTP ${upstreamRes.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
      );
    }

    const body = (await upstreamRes.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
      nextPageToken?: string;
    };

    for (const m of body.models ?? []) {
      const name = m.name ?? '';
      const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
      if (!id) {
        continue;
      }
      const methods = m.supportedGenerationMethods ?? [];
      if (methods.length && !methods.includes('generateContent')) {
        continue;
      }
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      ids.push(id);
    }

    pageToken = body.nextPageToken?.trim() || undefined;
    pages += 1;
  } while (pageToken && pages < maxPages);

  if (pages > 1) {
    log(`  list models pages=${pages}`);
  }
  return ids;
}

/** Discover the account-scoped catalog exposed by Code Assist. */
export async function listGeminiModelsFromCodeAssist(
  upstream: string,
  accessToken: string,
  project: string | undefined,
  log: (line: string) => void = () => {},
  userAgent?: string,
): Promise<GeminiModelCatalog> {
  const base = upstream.replace(/\/$/, '');
  const headers = {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    accept: 'application/json',
    ...(userAgent ? { 'user-agent': userAgent } : {}),
  };
  const response = await fetch(`${base}/v1internal:fetchAvailableModels`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ project: project ?? '' }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (response.ok) {
    let body: CodeAssistModelCatalogResponse;
    try {
      body = JSON.parse(text) as CodeAssistModelCatalogResponse;
    } catch {
      throw new Error(`Code Assist returned non-JSON model metadata: ${text.slice(0, 200)}`);
    }
    const catalog = parseCodeAssistModelCatalog(body);
    log(`  Code Assist fetchAvailableModels models=${catalog.models.length}`);
    return catalog;
  }

  // Older Gemini CLI entitlements can deny fetchAvailableModels. Quota is a
  // partial fallback only: it supplies real ids but never proves that another
  // explicit id is unavailable.
  log(`  Code Assist fetchAvailableModels HTTP ${response.status}; using quota metadata`);
  return listGeminiModelsFromCodeAssistQuota(base, project, headers, text);
}

interface CodeAssistModelDetails {
  displayName?: unknown;
  recommended?: unknown;
  disabled?: unknown;
  apiProvider?: unknown;
  modelProvider?: unknown;
}

interface CodeAssistModelCatalogResponse {
  models?: Record<string, CodeAssistModelDetails>;
  defaultAgentModelId?: unknown;
  agentModelSorts?: Array<{ groups?: Array<{ modelIds?: unknown[] }> }>;
}

function parseCodeAssistModelCatalog(body: CodeAssistModelCatalogResponse): GeminiModelCatalog {
  const models: GeminiModelDescriptor[] = [];
  for (const [rawId, details] of Object.entries(body.models ?? {})) {
    const id = bareModelId(rawId);
    if (!id || details.disabled === true) {
      continue;
    }
    const knownNonGeminiProvider =
      typeof details.apiProvider === 'string' &&
      details.apiProvider !== 'API_PROVIDER_GOOGLE_GEMINI';
    const knownNonGoogleModel =
      typeof details.modelProvider === 'string' &&
      details.modelProvider !== 'MODEL_PROVIDER_GOOGLE';
    if (knownNonGeminiProvider || knownNonGoogleModel) {
      continue;
    }
    models.push({
      id,
      ...(typeof details.displayName === 'string' ? { displayName: details.displayName } : {}),
      ...(details.recommended === true ? { recommended: true } : {}),
    });
  }

  const available = new Set(models.map((model) => model.id));
  const preferredModelIds = (body.agentModelSorts ?? [])
    .flatMap((sort) => sort.groups ?? [])
    .flatMap((group) => group.modelIds ?? [])
    .filter((id): id is string => typeof id === 'string')
    .map(bareModelId)
    .filter((id) => available.has(id));
  const defaultModelId =
    typeof body.defaultAgentModelId === 'string'
      ? bareModelId(body.defaultAgentModelId)
      : undefined;

  return {
    models,
    ...(defaultModelId && available.has(defaultModelId) ? { defaultModelId } : {}),
    ...(preferredModelIds.length ? { preferredModelIds: [...new Set(preferredModelIds)] } : {}),
  };
}

async function listGeminiModelsFromCodeAssistQuota(
  base: string,
  project: string | undefined,
  headers: Record<string, string>,
  catalogError: string,
): Promise<GeminiModelCatalog> {
  const response = await fetch(`${base}/v1internal:retrieveUserQuota`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ project: project ?? '', userAgent: 'hotplug-gemini-proxy' }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Code Assist model discovery failed: fetchAvailableModels ${catalogError.slice(0, 120)}; ` +
        `retrieveUserQuota HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
    );
  }
  let body: {
    buckets?: Array<{ modelId?: unknown }>;
    models?: Array<{ id?: unknown; name?: unknown } | string>;
  };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(`Code Assist returned non-JSON model metadata: ${text.slice(0, 200)}`);
  }
  const models: GeminiModelDescriptor[] = [];
  const add = (value: unknown) => {
    if (typeof value !== 'string') {
      return;
    }
    const id = bareModelId(value);
    if (id && !models.some((model) => model.id === id)) {
      models.push({ id });
    }
  };
  for (const bucket of body.buckets ?? []) {
    add(bucket.modelId);
  }
  // Accept a future richer response shape without requiring a proxy release.
  for (const model of body.models ?? []) {
    if (typeof model === 'string') {
      add(model);
    } else {
      add(model.id ?? model.name);
    }
  }
  return { models };
}

function bareModelId(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('models/') ? trimmed.slice('models/'.length) : trimmed;
}

function isCatalogResolution(
  resolution: GeminiModelResolution,
  catalog: GeminiModelCatalog,
): boolean {
  return Boolean(resolution.id && catalog.models.some((model) => model.id === resolution.id));
}
