export function safeUpstreamErrorForLog(raw: string): string {
  let detail = '';
  try {
    const parsed = JSON.parse(raw) as {
      error?: string | { type?: string; message?: string };
      message?: string;
    };
    if (typeof parsed.error === 'string') {
      detail = parsed.error;
    } else if (parsed.error?.message) {
      detail = parsed.error.type
        ? `${parsed.error.type}: ${parsed.error.message}`
        : parsed.error.message;
    } else if (parsed.message) {
      detail = parsed.message;
    }
  } catch {
    // Plain-text upstream errors are handled below.
  }
  if (!detail) {
    detail = raw.trim() || '(empty error body)';
  }
  return detail
    .replace(/\s+/g, ' ')
    .replace(/("(?:token|api[_-]?key|authorization)"\s*:\s*")[^"]+/gi, '$1<redacted>')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer <redacted>')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g, '<redacted>')
    .replace(/\b[a-f0-9]{48,}\b/gi, '<redacted>')
    .slice(0, 320);
}

export function formatUpstreamModelError(raw: string, model: string | undefined): string {
  const slice = raw.slice(0, 500);
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string }; message?: string };
    const message = parsed.error?.message ?? parsed.message;
    if (message) {
      return message;
    }
  } catch {
    // fall through
  }
  if (/not exist|access|invalid model|unknown model/i.test(slice)) {
    return `Model "${model ?? '?'}" rejected by OpenCode: ${slice}. Pick another via anypick model map or Claude /model.`;
  }
  return slice || `OpenCode error for model ${model ?? '?'}`;
}

export function isOpenCodeFreeTierModel(model: string): boolean {
  return /(?:^|[-_/])free(?:$|[-_/])/i.test(model.trim());
}

export function freeTierIpLimitResponse(remainingMs: number): Response {
  const retryAfter = Math.max(1, Math.ceil(remainingMs / 1000));
  return new Response(
    JSON.stringify({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: `OpenCode free-tier IP quota reached. Retry after ${retryAfter}s or use an eligible paid model.`,
      },
    }),
    {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(retryAfter) },
    },
  );
}
