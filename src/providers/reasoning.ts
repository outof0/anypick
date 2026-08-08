/**
 * Protocol-neutral reasoning controls shared by the compatibility proxies.
 *
 * The public APIs use different names for the same intent:
 * OpenAI uses `reasoning_effort` / `reasoning.effort`, Anthropic uses
 * `output_config.effort` plus `thinking`, and Gemini uses `thinkingConfig`.
 * Keep extraction and the necessarily lossy level mapping in one place so a
 * proxy translation never silently drops the caller's intent.
 */

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ReasoningIntent {
  effort?: ReasoningEffort;
  /** Explicit thinking switch. Undefined means the client did not specify it. */
  enabled?: boolean;
  /** Exact Anthropic manual thinking budget, when supplied. */
  budgetTokens?: number;
  /** The client requested a visible reasoning/thinking summary. */
  includeSummary?: boolean;
}

export function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'none':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return normalized;
    default:
      return undefined;
  }
}

export function reasoningFromOpenAI(request: Record<string, unknown>): ReasoningIntent {
  const reasoning = isRecord(request.reasoning) ? request.reasoning : undefined;
  const effort =
    normalizeReasoningEffort(request.reasoning_effort) ??
    normalizeReasoningEffort(reasoning?.effort) ??
    normalizeReasoningEffort(request.effort);
  const summary = reasoning?.summary ?? reasoning?.generate_summary;
  return {
    ...(effort ? { effort, enabled: effort !== 'none' } : {}),
    ...(summary === 'auto' || summary === 'concise' || summary === 'detailed'
      ? { includeSummary: true }
      : {}),
  };
}

export function reasoningFromAnthropic(request: Record<string, unknown>): ReasoningIntent {
  const thinking = isRecord(request.thinking) ? request.thinking : undefined;
  const outputConfig = isRecord(request.output_config) ? request.output_config : undefined;
  const effort = normalizeReasoningEffort(outputConfig?.effort);
  const thinkingType = typeof thinking?.type === 'string' ? thinking.type.toLowerCase() : undefined;
  const budget =
    typeof thinking?.budget_tokens === 'number' &&
    Number.isFinite(thinking.budget_tokens) &&
    thinking.budget_tokens >= 0
      ? Math.trunc(thinking.budget_tokens)
      : undefined;
  const enabled =
    thinkingType === 'disabled'
      ? false
      : thinkingType === 'enabled' || thinkingType === 'adaptive'
        ? true
        : undefined;
  return {
    ...(effort ? { effort } : {}),
    ...(enabled != null ? { enabled } : {}),
    ...(budget != null ? { budgetTokens: budget } : {}),
    ...(enabled === true && thinking?.display !== 'omitted' ? { includeSummary: true } : {}),
  };
}

/** Convert Anthropic controls to the closest OpenAI Chat effort value. */
export function anthropicToOpenAIEffort(
  request: Record<string, unknown>,
): Exclude<ReasoningEffort, 'max'> | undefined {
  const intent = reasoningFromAnthropic(request);
  if (intent.enabled === false) {
    return 'none';
  }
  if (intent.effort) {
    return intent.effort === 'max' ? 'xhigh' : intent.effort;
  }
  if (intent.budgetTokens != null) {
    const maxTokens =
      typeof request.max_tokens === 'number' && request.max_tokens > 0
        ? request.max_tokens
        : undefined;
    const ratio = maxTokens ? intent.budgetTokens / maxTokens : undefined;
    if (intent.budgetTokens <= 1024 || (ratio != null && ratio <= 0.25)) {
      return 'low';
    }
    if (ratio != null && ratio <= 0.6) {
      return 'medium';
    }
    return 'high';
  }
  return intent.enabled ? 'medium' : undefined;
}

/** Convert OpenAI's extra levels to an Anthropic API effort value. */
export function openAIToAnthropicEffort(
  effort: ReasoningEffort | undefined,
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  if (!effort) {
    return undefined;
  }
  if (effort === 'none' || effort === 'minimal') {
    return 'low';
  }
  return effort;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
