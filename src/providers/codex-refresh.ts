/**
 * ChatGPT / Codex OAuth token refresh (no browser).
 *
 * Endpoint + client_id match the official Codex CLI binary
 * (https://auth.openai.com/oauth/token, app_EMoamEEZ73f0CkXaXp7hrann).
 */

export const CODEX_OAUTH_TOKEN_URL =
  process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE?.trim() || 'https://auth.openai.com/oauth/token';

export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

export interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
    [key: string]: unknown;
  };
  last_refresh?: string;
  [key: string]: unknown;
}

export interface CodexRefreshResult {
  auth: CodexAuthFile;
  identity?: string;
}

/**
 * Refresh Codex ChatGPT OAuth tokens in-memory from an auth.json object.
 */
export async function refreshCodexAuth(
  auth: CodexAuthFile,
  fetchFn: typeof fetch = fetch,
): Promise<CodexRefreshResult> {
  const refreshToken = auth.tokens?.refresh_token;
  if (!refreshToken) {
    throw new Error('No refresh_token in Codex auth. Re-login with: codex login');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CODEX_OAUTH_CLIENT_ID,
  });

  const res = await fetchFn(CODEX_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Codex token refresh failed (${res.status}): ${text.slice(0, 240)}`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };

  if (!data.access_token) {
    throw new Error('Codex token refresh returned no access_token.');
  }

  const next: CodexAuthFile = {
    ...auth,
    auth_mode: auth.auth_mode ?? 'chatgpt',
    tokens: {
      ...auth.tokens,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? refreshToken,
      id_token: data.id_token ?? auth.tokens?.id_token,
    },
    last_refresh: new Date().toISOString(),
  };

  return {
    auth: next,
    identity: identityFromAuth(next),
  };
}

function identityFromAuth(auth: CodexAuthFile): string | undefined {
  const idToken = auth.tokens?.id_token;
  if (!idToken) {
    return undefined;
  }
  try {
    const parts = idToken.split('.');
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
