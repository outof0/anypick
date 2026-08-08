/**
 * Load + refresh Grok OIDC session from ~/.grok/auth.json.
 */
import { readFile } from 'node:fs/promises';
import { pathExists, writeTextFile } from '../../utils/fs';
import { withFileLock } from '../../utils/lock';

export interface GrokSession {
  /** Access token (JWT) sent as Bearer to cli-chat-proxy. */
  accessToken: string;
  refreshToken: string;
  expiresAt?: string;
  email?: string;
  oidcIssuer: string;
  oidcClientId: string;
  /** Map key in auth.json (issuer::clientId). */
  storageKey: string;
  raw: Record<string, unknown>;
}

export interface GrokAuthFile {
  [key: string]: Record<string, unknown>;
}

const REFRESH_SKEW_MS = 60_000; // refresh 1 min before expiry

export async function loadGrokSession(authPath: string): Promise<GrokSession> {
  if (!(await pathExists(authPath))) {
    throw new Error(`Grok auth not found at ${authPath}. Run: grok login`);
  }
  const data = JSON.parse(await readFile(authPath, 'utf8')) as GrokAuthFile;
  const entry = pickSession(data);
  if (!entry) {
    throw new Error(`No OIDC session in ${authPath}. Run: grok login`);
  }
  const [storageKey, raw] = entry;
  const accessToken =
    (typeof raw.key === 'string' && raw.key) ||
    (typeof raw.access_token === 'string' && raw.access_token) ||
    '';
  const refreshToken = (typeof raw.refresh_token === 'string' && raw.refresh_token) || '';
  const oidcIssuer =
    (typeof raw.oidc_issuer === 'string' && raw.oidc_issuer) || 'https://auth.x.ai';
  const oidcClientId =
    (typeof raw.oidc_client_id === 'string' && raw.oidc_client_id) ||
    storageKey.split('::')[1] ||
    '';

  if (!accessToken && !refreshToken) {
    throw new Error('Grok session has no access or refresh token.');
  }
  if (!oidcClientId) {
    throw new Error('Grok session missing oidc_client_id.');
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: typeof raw.expires_at === 'string' ? raw.expires_at : undefined,
    email: typeof raw.email === 'string' ? raw.email : undefined,
    oidcIssuer,
    oidcClientId,
    storageKey,
    raw,
  };
}

function pickSession(data: GrokAuthFile): [string, Record<string, unknown>] | null {
  const entries = Object.entries(data).filter(([, v]) => v && typeof v === 'object');
  if (entries.length === 0) {
    return null;
  }
  // Prefer sessions that look like xAI OIDC
  const preferred = entries.find(
    ([, v]) =>
      typeof v.key === 'string' || typeof v.refresh_token === 'string' || v.auth_mode === 'oidc',
  );
  return preferred ?? entries[0];
}

export function isExpired(session: GrokSession, now = Date.now()): boolean {
  if (!session.expiresAt) {
    return false;
  }
  const exp = Date.parse(session.expiresAt);
  if (Number.isNaN(exp)) {
    return false;
  }
  return exp - REFRESH_SKEW_MS <= now;
}

/**
 * Ensure a valid access token, refreshing via OIDC if needed.
 * Writes refreshed tokens back to authPath so Grok CLI stays in sync.
 */
export async function ensureAccessToken(
  authPath: string,
  session?: GrokSession,
): Promise<{ token: string; session: GrokSession }> {
  let s = session ?? (await loadGrokSession(authPath));
  if (s.accessToken && !isExpired(s)) {
    return { token: s.accessToken, session: s };
  }
  if (!s.refreshToken) {
    throw new Error('Grok access token expired and no refresh_token available. Run: grok login');
  }
  s = await refreshSession(authPath, s);
  return { token: s.accessToken, session: s };
}

export async function refreshSession(authPath: string, session: GrokSession): Promise<GrokSession> {
  // Refresh-token rotation is destructive at many OIDC providers. Serialize
  // across proxy requests and CLI processes, then reload the file inside the
  // lock so a waiter returns the winner's newly rotated token instead of
  // redeeming the old refresh token a second time.
  return withFileLock(
    `${authPath}.refresh.lock`,
    async () => {
      const latest = await loadGrokSession(authPath);
      if (
        latest.storageKey === session.storageKey &&
        (latest.accessToken !== session.accessToken || latest.refreshToken !== session.refreshToken)
      ) {
        return latest;
      }
      return refreshSessionUnlocked(authPath, latest);
    },
    { resource: `Grok auth refresh ${authPath}` },
  );
}

async function refreshSessionUnlocked(
  authPath: string,
  session: GrokSession,
): Promise<GrokSession> {
  const tokenUrl = await resolveTokenEndpoint(session.oidcIssuer);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
    client_id: session.oidcClientId,
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Grok OIDC refresh failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!data.access_token) {
    throw new Error('Grok OIDC refresh returned no access_token.');
  }

  const expiresAt =
    typeof data.expires_in === 'number'
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : session.expiresAt;

  const updated: GrokSession = {
    ...session,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? session.refreshToken,
    expiresAt,
    raw: {
      ...session.raw,
      key: data.access_token,
      refresh_token: data.refresh_token ?? session.refreshToken,
      expires_at: expiresAt,
    },
  };

  await writeSession(authPath, updated);
  return updated;
}

async function resolveTokenEndpoint(issuer: string): Promise<string> {
  try {
    const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const conf = (await res.json()) as { token_endpoint?: string };
      if (conf.token_endpoint) {
        return conf.token_endpoint;
      }
    }
  } catch {
    // fall through
  }
  return `${issuer.replace(/\/$/, '')}/oauth2/token`;
}

async function writeSession(authPath: string, session: GrokSession): Promise<void> {
  let data: GrokAuthFile = {};
  if (await pathExists(authPath)) {
    try {
      data = JSON.parse(await readFile(authPath, 'utf8')) as GrokAuthFile;
    } catch {
      data = {};
    }
  }
  data[session.storageKey] = session.raw;
  await writeTextFile(authPath, `${JSON.stringify(data, null, 2)}\n`, 0o600);
}
