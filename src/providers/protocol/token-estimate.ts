/**
 * Best-effort Anthropic input-token estimate for local `/v1/messages/count_tokens`.
 *
 * Claude Code calls this endpoint frequently for context budgeting. Several
 * upstreams (xAI cli-chat-proxy, some OpenAI-compat gateways) do not implement
 * it and return 404. Proxying those 404s is wasteful and can look like probing
 * traffic; answer locally instead (~4 chars/token, same heuristic as before).
 */
export function estimateAnthropicInputTokens(body: {
  system?: unknown;
  messages?: unknown;
  tools?: unknown;
  [k: string]: unknown;
}): number {
  let chars = 0;
  const add = (value: unknown) => {
    if (value == null) {
      return;
    }
    if (typeof value === 'string') {
      chars += value.length;
      return;
    }
    try {
      chars += JSON.stringify(value).length;
    } catch {
      chars += 16;
    }
  };
  add(body.system);
  add(body.messages);
  add(body.tools);
  if (body.tool_choice != null) {
    add(body.tool_choice);
  }
  if (body.metadata != null) {
    add(body.metadata);
  }
  return Math.max(1, Math.ceil(chars / 4) + 8);
}
