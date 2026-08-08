export function hasCodexAuth(data: Record<string, unknown>): boolean {
  if (typeof data.OPENAI_API_KEY === 'string' && data.OPENAI_API_KEY.trim()) {
    return true;
  }
  const tokens = data.tokens;
  if (tokens && typeof tokens === 'object') {
    const t = tokens as Record<string, unknown>;
    return Boolean(t.access_token || t.refresh_token || t.id_token);
  }
  return false;
}

export function codexAccountId(data: Record<string, unknown>): string | undefined {
  const tokens = data.tokens;
  if (tokens && typeof tokens === 'object') {
    const id = (tokens as Record<string, unknown>).account_id;
    if (typeof id === 'string' && id.trim()) {
      return id.trim();
    }
  }
  return undefined;
}

/**
 * Best-effort identity for display.
 *
 * Codex CLI writes ~/.codex/auth.json with either:
 * - ChatGPT OAuth: `tokens.{id_token,access_token,refresh_token,account_id}` + auth_mode
 * - API key: `OPENAI_API_KEY` string
 *
 * Email lives on id_token.email or access_token["https://api.openai.com/profile"].email.
 */
export function extractCodexIdentity(data: Record<string, unknown>): string | undefined {
  const tokens = data.tokens;
  if (tokens && typeof tokens === 'object') {
    const t = tokens as Record<string, unknown>;
    const fromId = claimsFromJwt(typeof t.id_token === 'string' ? t.id_token : null);
    const fromAccess = claimsFromJwt(typeof t.access_token === 'string' ? t.access_token : null);

    const email =
      stringClaim(fromId, 'email') ??
      stringClaim(fromAccess, 'email') ??
      nestedEmail(fromAccess, 'https://api.openai.com/profile') ??
      nestedEmail(fromId, 'https://api.openai.com/profile');
    if (email) {
      return email;
    }

    const name = stringClaim(fromId, 'name') ?? stringClaim(fromAccess, 'name');
    if (name) {
      return name;
    }

    if (typeof t.account_id === 'string' && t.account_id) {
      return `chatgpt:${t.account_id.slice(0, 8)}`;
    }
  }

  if (typeof data.OPENAI_API_KEY === 'string' && data.OPENAI_API_KEY.trim()) {
    return 'API key';
  }
  return undefined;
}

function claimsFromJwt(token: string | null): Record<string, unknown> | null {
  if (!token) {
    return null;
  }
  try {
    const parts = token.split('.');
    if (parts.length < 2 || !parts[1]) {
      return null;
    }
    // Accept base64url or standard base64 (with/without padding).
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4;
    if (pad) {
      b64 += '='.repeat(4 - pad);
    }
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringClaim(claims: Record<string, unknown> | null, key: string): string | undefined {
  if (!claims) {
    return undefined;
  }
  const v = claims[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function nestedEmail(claims: Record<string, unknown> | null, key: string): string | undefined {
  if (!claims) {
    return undefined;
  }
  const nest = claims[key];
  if (!nest || typeof nest !== 'object') {
    return undefined;
  }
  const email = (nest as Record<string, unknown>).email;
  return typeof email === 'string' && email.trim() ? email.trim() : undefined;
}
