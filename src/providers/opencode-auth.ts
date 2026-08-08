/**
 * OpenCode auth.json helpers.
 *
 * OpenCode is a multi-provider CLI (like Codex), not just API keys.
 * Each key in auth.json is a provider id with one of:
 *
 *   oauth:     { type: "oauth", access, refresh, expires, accountId? }
 *   api:       { type: "api", key, metadata? }
 *   wellknown: { type: "wellknown", key, token }
 *
 * ChatGPT Plus/Pro OAuth uses the same OpenAI client_id as Codex.
 * Zen/Go are just `type: "api"` entries under opencode / opencode-go.
 */

export type OpenCodeAuthEntry = OpenCodeOauthAuth | OpenCodeApiAuth | OpenCodeWellKnownAuth;

export interface OpenCodeOauthAuth {
  type: 'oauth';
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  enterpriseUrl?: string;
  methodID?: string;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface OpenCodeApiAuth {
  type: 'api';
  key: string;
  metadata?: Record<string, string>;
  [k: string]: unknown;
}

export interface OpenCodeWellKnownAuth {
  type: 'wellknown';
  key: string;
  token: string;
  [k: string]: unknown;
}

export function isAuthEntry(v: unknown): v is OpenCodeAuthEntry {
  if (!v || typeof v !== 'object') {
    return false;
  }
  const t = (v as { type?: unknown }).type;
  return t === 'oauth' || t === 'api' || t === 'wellknown';
}

export function listAuthEntries(
  data: Record<string, unknown>,
): Array<{ provider: string; entry: OpenCodeAuthEntry }> {
  const out: Array<{ provider: string; entry: OpenCodeAuthEntry }> = [];
  for (const [provider, raw] of Object.entries(data)) {
    if (isAuthEntry(raw)) {
      out.push({ provider, entry: raw });
    }
  }
  return out;
}

export function hasAnyAuth(data: Record<string, unknown>): boolean {
  return listAuthEntries(data).length > 0;
}

/** Summarize credentials for status lines: "openai:oauth, opencode-go:api". */
export function summarizeAuth(data: Record<string, unknown>): string | undefined {
  const entries = listAuthEntries(data);
  if (entries.length === 0) {
    return undefined;
  }
  return entries.map((e) => `${e.provider}:${e.entry.type}`).join(', ');
}

/**
 * Best-effort identity for display (email / account / short summary).
 * Prefer OAuth email from JWT, then accountId.
 * For API-key bags, do NOT join provider ids as identity — that drifts and
 * breaks live matching. Use a stable short label instead.
 */
export function extractOpenCodeIdentity(data: Record<string, unknown>): string | undefined {
  const entries = listAuthEntries(data);

  // Prefer openai oauth email
  for (const { provider, entry } of entries) {
    if (entry.type !== 'oauth') {
      continue;
    }
    const email =
      emailFromJwtRobust(entry.access) ??
      emailFromJwt(entry.access) ??
      (typeof entry.metadata?.email === 'string' ? entry.metadata.email : undefined);
    if (email) {
      return email;
    }
    if (entry.accountId) {
      return `${provider}:${entry.accountId.slice(0, 12)}`;
    }
  }

  // Any oauth with accountId
  for (const { provider, entry } of entries) {
    if (entry.type === 'oauth' && entry.accountId) {
      return `${provider}:${entry.accountId.slice(0, 12)}`;
    }
  }

  if (entries.length === 0) {
    return undefined;
  }

  // API-only (or mixed without oauth email): stable short label, not a provider dump.
  const apiOnly = entries.every((e) => e.entry.type === 'api');
  if (apiOnly) {
    if (entries.length === 1) {
      return entries[0].provider;
    }
    return `${entries.length} api keys`;
  }
  return `${entries.length} credentials`;
}

/** Improve JWT decode for OpenCode (padding-safe base64). */
export function emailFromJwtRobust(token: string | undefined): string | undefined {
  if (!token) {
    return undefined;
  }
  try {
    const parts = token.split('.');
    if (parts.length < 2 || !parts[1]) {
      return undefined;
    }
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4;
    if (pad) {
      b64 += '='.repeat(4 - pad);
    }
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (typeof payload.email === 'string' && payload.email.trim()) {
      return payload.email.trim();
    }
    if (typeof payload.preferred_username === 'string' && payload.preferred_username.trim()) {
      return payload.preferred_username.trim();
    }
    const profile = payload['https://api.openai.com/profile'];
    if (profile && typeof profile === 'object') {
      const email = (profile as { email?: unknown }).email;
      if (typeof email === 'string' && email.trim()) {
        return email.trim();
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

export function emailFromJwt(token: string | undefined): string | undefined {
  if (!token) {
    return undefined;
  }
  try {
    const parts = token.split('.');
    if (parts.length < 2) {
      return undefined;
    }
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (typeof payload.email === 'string') {
      return payload.email;
    }
    if (typeof payload.preferred_username === 'string') {
      return payload.preferred_username;
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Refresh OpenCode OAuth entries in-place.
 * OpenAI ChatGPT OAuth uses Codex client_id / token URL.
 * Other oauth providers without a known refresh path are left untouched.
 */
export async function refreshOpenCodeAuth(
  data: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
): Promise<{
  data: Record<string, unknown>;
  refreshed: string[];
  skipped: string[];
  identity?: string;
}> {
  const next = { ...data };
  const refreshed: string[] = [];
  const skipped: string[] = [];

  for (const [provider, raw] of Object.entries(data)) {
    if (!isAuthEntry(raw) || raw.type !== 'oauth') {
      continue;
    }

    // OpenAI ChatGPT OAuth (same as Codex)
    if (provider === 'openai' || looksLikeOpenAiOauth(raw)) {
      const updated = await refreshOpenAiOauth(raw, fetchFn);
      next[provider] = updated;
      refreshed.push(provider);
      continue;
    }

    skipped.push(provider);
  }

  if (refreshed.length === 0 && skipped.length > 0) {
    throw new Error(
      `No refreshable OAuth in OpenCode auth (found: ${skipped.join(', ')}). Re-login: opencode auth login`,
    );
  }
  if (refreshed.length === 0) {
    throw new Error(
      "No OAuth credentials to refresh. API keys don't need refresh. Login: opencode auth login",
    );
  }

  return {
    data: next,
    refreshed,
    skipped,
    identity: extractOpenCodeIdentity(next),
  };
}

function looksLikeOpenAiOauth(entry: OpenCodeOauthAuth): boolean {
  // methodID from opencode binary: chatgpt-browser / chatgpt-headless
  if (typeof entry.methodID === 'string' && entry.methodID.includes('chatgpt')) {
    return true;
  }
  // access token JWT iss
  try {
    const parts = entry.access.split('.');
    if (parts.length < 2) {
      return false;
    }
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      iss?: string;
    };
    return Boolean(payload.iss?.includes('openai') || payload.iss?.includes('auth0'));
  } catch {
    return false;
  }
}

async function refreshOpenAiOauth(
  entry: OpenCodeOauthAuth,
  fetchFn: typeof fetch,
): Promise<OpenCodeOauthAuth> {
  const { CODEX_OAUTH_TOKEN_URL, CODEX_OAUTH_CLIENT_ID } = await import('./codex-refresh');

  if (!entry.refresh) {
    throw new Error('OpenAI OAuth entry has no refresh token');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: entry.refresh,
    client_id: CODEX_OAUTH_CLIENT_ID,
  });

  const res = await fetchFn(CODEX_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'user-agent': 'hotplug-opencode/0.8',
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenCode OpenAI OAuth refresh failed (${res.status}): ${text.slice(0, 240)}`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
  };

  if (!data.access_token) {
    throw new Error('OpenAI OAuth refresh returned no access_token');
  }

  return {
    ...entry,
    type: 'oauth',
    access: data.access_token,
    refresh: data.refresh_token ?? entry.refresh,
    expires: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}
