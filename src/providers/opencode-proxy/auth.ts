/**
 * Load OpenCode Zen / Go API keys from ~/.local/share/opencode/auth.json
 *
 * Shape:
 *   {
 *     "opencode-go": { "type": "api", "key": "sk-..." },
 *     "opencode":    { "type": "api", "key": "sk-..." },
 *     "deepseek":    { … }  // ignored for this proxy
 *   }
 *
 * One key works on BOTH catalogs:
 *   Zen  https://opencode.ai/zen/v1
 *   Go   https://opencode.ai/zen/go/v1
 *
 * The proxy picks the endpoint per model id (not a user "plan" switch).
 */
import { readJsonFile, pathExists } from '../../utils/fs';
import { AnyPickError } from '../../utils/errors';

export type OpenCodeCatalog = 'zen' | 'go';
export type OpenCodeAuthMode = 'auto' | 'public' | 'api';

export type OpenCodeCredential =
  | { mode: 'public'; service: 'public'; apiKey: 'public'; accountName?: string }
  | { mode: 'api'; service: string; apiKey: string; accountName?: string };

export interface LegacyOpenCodeCredential {
  /** Which auth.json entry supplied the key (label only). */
  service: string;
  apiKey: string;
}

export const OPENCODE_ZEN_UPSTREAM = 'https://opencode.ai/zen/v1';
export const OPENCODE_GO_UPSTREAM = 'https://opencode.ai/zen/go/v1';

export function upstreamForCatalog(catalog: OpenCodeCatalog): string {
  return catalog === 'go' ? OPENCODE_GO_UPSTREAM : OPENCODE_ZEN_UPSTREAM;
}

/** OpenCode platform credential service ids in auth.json. */
const PLATFORM_SERVICES = new Set(['opencode-go', 'opencode', 'opencode-zen', 'zen']);

/**
 * Load any platform API key (Zen or Go login — same key works for both endpoints).
 */
export async function loadOpenCodeCredential(authPath: string): Promise<OpenCodeCredential> {
  return resolveOpenCodeCredential(authPath, 'api');
}

export async function resolveOpenCodeCredential(
  authPath: string,
  mode: OpenCodeAuthMode = 'auto',
): Promise<OpenCodeCredential> {
  const credentials = await resolveOpenCodeCredentials([authPath], mode);
  return credentials[0];
}

/**
 * Load an ordered credential ring from one or more auth.json files.
 *
 * The first path is normally the active account. Additional paths are used by
 * the optional proxy pool; they are deliberately kept ordered so failover is
 * deterministic and sticky for the lifetime of the proxy process.
 */
export async function resolveOpenCodeCredentials(
  authPaths: string[],
  mode: OpenCodeAuthMode = 'auto',
  accountNames?: string[],
): Promise<OpenCodeCredential[]> {
  if (mode === 'public') {
    return [{ mode: 'public', service: 'public', apiKey: 'public' }];
  }

  const paths = authPaths.filter(
    (path, index) => path.trim().length > 0 && authPaths.indexOf(path) === index,
  );
  const loaded: OpenCodeCredential[] = [];
  const unreadablePaths = new Set<string>();
  for (const authPath of paths) {
    const sourceIndex = authPaths.indexOf(authPath);
    const accountName = accountNames?.[sourceIndex];
    if (!(await pathExists(authPath))) {
      continue;
    }
    try {
      const data = await readJsonFile<Record<string, unknown>>(authPath);
      const platform = listPlatformCredentials(data);
      const preferred = pickPreferredKey(platform);
      if (preferred) {
        loaded.push({
          mode: 'api',
          service: preferred.service,
          apiKey: preferred.apiKey,
          accountName,
        });
        for (const entry of platform) {
          if (entry.apiKey !== preferred.apiKey) {
            loaded.push({ mode: 'api', service: entry.service, apiKey: entry.apiKey, accountName });
          }
        }
      }
    } catch {
      unreadablePaths.add(authPath);
      // A broken secondary pool member must not prevent the healthy members
      // from serving requests. The single-account error is handled below.
    }
  }

  const unique = loaded.filter(
    (credential, index) =>
      loaded.findIndex((candidate) => candidate.apiKey === credential.apiKey) === index,
  );
  if (unique.length > 0) {
    return unique;
  }
  if (mode === 'auto') {
    return [{ mode: 'public', service: 'public', apiKey: 'public' }];
  }

  const firstPath = authPaths[0] ?? '(none)';
  if (!(await pathExists(firstPath))) {
    throw new AnyPickError(
      `OpenCode auth not found at ${firstPath}. Run: opencode auth login`,
      'NO_LIVE_AUTH',
    );
  }
  if (unreadablePaths.has(firstPath)) {
    throw new AnyPickError(`Unreadable OpenCode auth: ${firstPath}`, 'NO_LIVE_AUTH');
  }
  throw new AnyPickError(
    'No OpenCode Zen/Go key in auth.json. Run: opencode auth login  (select OpenCode Zen or Go)',
    'NO_LIVE_AUTH',
  );
}

/** Platform keys only (for status lines). */
export function listApiCredentials(data: Record<string, unknown>): OpenCodeCredential[] {
  return listPlatformCredentials(data).map((e) => ({
    mode: 'api' as const,
    service: e.service,
    apiKey: e.apiKey,
  }));
}

export function listZenGoCredentials(data: Record<string, unknown>): OpenCodeCredential[] {
  return listApiCredentials(data);
}

function listPlatformCredentials(
  data: Record<string, unknown>,
): Array<{ service: string; apiKey: string }> {
  const out: Array<{ service: string; apiKey: string }> = [];
  for (const [service, raw] of Object.entries(data)) {
    if (!PLATFORM_SERVICES.has(service.toLowerCase())) {
      continue;
    }
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const key = extractKey(raw as Record<string, unknown>);
    if (!key) {
      continue;
    }
    out.push({ service, apiKey: key });
  }
  return out;
}

/** Prefer opencode-go key, else first platform key. */
function pickPreferredKey(platform: Array<{ service: string; apiKey: string }>):
  | {
      service: string;
      apiKey: string;
    }
  | undefined {
  return platform.find((e) => e.service.toLowerCase() === 'opencode-go') ?? platform[0];
}

function extractKey(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.key === 'string' && raw.key.trim()) {
    return raw.key.trim();
  }
  if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) {
    return raw.apiKey.trim();
  }
  if (typeof raw.token === 'string' && raw.token.trim()) {
    return raw.token.trim();
  }
  return undefined;
}
