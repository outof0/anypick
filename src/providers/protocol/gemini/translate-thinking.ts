import type { ReasoningIntent } from '../../reasoning';
import type { AnthropicMessageRequest } from '../anthropic';
import {
  EMPTY_THOUGHT_CARRIER,
  TOOL_SIGNATURE_CARRIER,
  type GeminiGenerateRequest,
  type GeminiPart,
} from './translate-types';
import { mapToGeminiModel, parseGeminiModelVersion } from './translate-models';
import { isRecord } from './translate-schema';

export function applyGeminiThinkingConfig(
  request: GeminiGenerateRequest,
  intent: ReasoningIntent,
  model: string | undefined,
): void {
  if (
    intent.effort == null &&
    intent.enabled == null &&
    intent.budgetTokens == null &&
    intent.includeSummary == null
  ) {
    return;
  }
  request.generationConfig ??= {};
  const thinkingConfig: NonNullable<
    NonNullable<GeminiGenerateRequest['generationConfig']>['thinkingConfig']
  > = {};
  if (intent.includeSummary) {
    thinkingConfig.includeThoughts = true;
  }
  if (intent.budgetTokens != null) {
    // Preserve Claude's exact manual budget. Gemini accepts a token budget on
    // 2.5 and retains it for compatibility on newer generateContent models.
    thinkingConfig.thinkingBudget = intent.budgetTokens;
  } else {
    const effort = intent.enabled === false ? 'none' : (intent.effort ?? 'medium');
    const major = parseGeminiModelVersion(mapToGeminiModel(model))[0];
    if (major === 0 || major >= 3) {
      thinkingConfig.thinkingLevel =
        effort === 'none' || effort === 'minimal'
          ? 'MINIMAL'
          : effort === 'low'
            ? 'LOW'
            : effort === 'medium'
              ? 'MEDIUM'
              : 'HIGH';
    } else {
      // Gemini 2.5 uses token budgets rather than levels. -1 asks Gemini to
      // choose dynamically and avoids inventing a fixed ceiling for high modes.
      thinkingConfig.thinkingBudget =
        effort === 'none' || effort === 'minimal'
          ? 0
          : effort === 'low'
            ? 1024
            : effort === 'medium'
              ? 4096
              : -1;
    }
  }
  request.generationConfig.thinkingConfig = thinkingConfig;
}

/** Rebuild Claude assistant history without moving signatures between Gemini parts. */
export function restoreAnthropicThinkingHistory(
  request: GeminiGenerateRequest,
  source: AnthropicMessageRequest,
): void {
  const targetAssistantTurns = request.contents.filter((content) => content.role === 'model');
  let targetIndex = 0;
  for (const message of source.messages ?? []) {
    if (message.role !== 'assistant') {
      continue;
    }
    const target = targetAssistantTurns[targetIndex++];
    if (!target || !Array.isArray(message.content)) {
      continue;
    }
    const rebuilt: GeminiPart[] = [];
    let pendingToolSignature: string | undefined;
    for (const block of message.content) {
      if (block.type === 'thinking' && 'thinking' in block) {
        const thinking = String(block.thinking ?? '');
        const signature =
          'signature' in block && typeof block.signature === 'string' && block.signature
            ? block.signature
            : undefined;
        if (thinking === TOOL_SIGNATURE_CARRIER) {
          pendingToolSignature = signature;
          continue;
        }
        rebuilt.push({
          text: thinking === EMPTY_THOUGHT_CARRIER ? '' : thinking,
          thought: true,
          ...(signature ? { thoughtSignature: signature } : {}),
        });
        continue;
      }
      if (block.type === 'text' && 'text' in block) {
        rebuilt.push({ text: String(block.text ?? '') });
        continue;
      }
      if (block.type === 'tool_use' && 'name' in block) {
        const blockSignature =
          'thought_signature' in block &&
          typeof block.thought_signature === 'string' &&
          block.thought_signature
            ? block.thought_signature
            : undefined;
        const thoughtSignature = blockSignature ?? pendingToolSignature;
        rebuilt.push({
          ...(thoughtSignature ? { thoughtSignature } : {}),
          functionCall: {
            name: String(block.name),
            args: isRecord(block.input) ? block.input : {},
          },
        });
        pendingToolSignature = undefined;
      }
    }
    if (rebuilt.length) {
      target.parts = rebuilt;
    }
  }
}
