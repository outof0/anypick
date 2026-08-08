import { reasoningFromOpenAI } from '../../reasoning';
import {
  type OpenAIChatRequest,
  type OpenAIChatResponse,
  type OpenAITool,
  type OpenAIToolCall,
} from '../anthropic';
import type {
  GeminiContent,
  GeminiGenerateRequest,
  GeminiGenerateResponse,
  GeminiPart,
} from './translate-types';
import { sanitizeGeminiSchema } from './translate-schema';
import { applyGeminiThinkingConfig } from './translate-thinking';
import { messageText, safeParseObject, mapGeminiFinish, randomId } from './translate-shared';

export function openAIToGemini(
  req: OpenAIChatRequest,
  resolvedModel = req.model,
): GeminiGenerateRequest {
  const contents: GeminiContent[] = [];
  const toolNamesById = new Map<string, string>();
  let systemText = '';

  for (const msg of req.messages ?? []) {
    if (msg.role === 'system') {
      const t = messageText(msg);
      if (t) {
        systemText = systemText ? `${systemText}\n${t}` : t;
      }
      continue;
    }
    if (msg.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name:
                (msg.tool_call_id ? toolNamesById.get(msg.tool_call_id) : undefined) ??
                msg.name ??
                'tool',
              response: { result: messageText(msg) },
            },
          },
        ],
      });
      continue;
    }
    if (msg.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (msg.reasoning_content) {
        parts.push({
          text: msg.reasoning_content,
          thought: true,
          ...(msg.reasoning_signature ? { thoughtSignature: msg.reasoning_signature } : {}),
        });
      }
      const text = messageText(msg);
      if (text) {
        parts.push({ text });
      }
      if (msg.tool_calls?.length) {
        let attachedFallbackSignature = false;
        for (const tc of msg.tool_calls) {
          toolNamesById.set(tc.id, tc.function.name);
          const fallbackSignature: string | undefined =
            !msg.reasoning_content && !attachedFallbackSignature
              ? msg.reasoning_signature
              : undefined;
          const thoughtSignature = tc.thought_signature ?? fallbackSignature;
          attachedFallbackSignature ||= Boolean(fallbackSignature);
          parts.push({
            ...(thoughtSignature ? { thoughtSignature } : {}),
            functionCall: {
              name: tc.function.name,
              args: safeParseObject(tc.function.arguments),
            },
          });
        }
      }
      if (parts.length === 0) {
        parts.push({ text: '' });
      }
      contents.push({ role: 'model', parts });
      continue;
    }
    // user
    contents.push({
      role: 'user',
      parts: [{ text: messageText(msg) || '' }],
    });
  }

  // Gemini requires alternating user/model; ensure starts with user
  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: '' }] });
  }
  if (contents[0]?.role === 'model') {
    contents.unshift({ role: 'user', parts: [{ text: '(continue)' }] });
  }

  const out: GeminiGenerateRequest = { contents };

  if (systemText) {
    out.systemInstruction = { parts: [{ text: systemText }] };
  }

  out.generationConfig = {};
  if (req.max_tokens != null) {
    out.generationConfig.maxOutputTokens = req.max_tokens;
  }
  if (req.temperature != null) {
    out.generationConfig.temperature = req.temperature;
  }
  if (req.top_p != null) {
    out.generationConfig.topP = req.top_p;
  }
  if (req.stop) {
    out.generationConfig.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  }
  applyGeminiThinkingConfig(out, reasoningFromOpenAI(req), resolvedModel);
  if (Object.keys(out.generationConfig).length === 0) {
    delete out.generationConfig;
  }

  if (req.tools?.length) {
    out.tools = [
      {
        functionDeclarations: req.tools
          .filter((t): t is OpenAITool => t.type === 'function')
          .map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: sanitizeGeminiSchema(
              t.function.parameters ?? { type: 'object', properties: {} },
            ),
          })),
      },
    ];
  }

  return out;
}

export function geminiToOpenAI(res: GeminiGenerateResponse, model: string): OpenAIChatResponse {
  if (res.error) {
    return {
      error: {
        message: res.error.message ?? 'Gemini error',
        type: res.error.status ?? 'api_error',
        code: res.error.code != null ? String(res.error.code) : undefined,
      },
    };
  }

  const cand = res.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  let text = '';
  let reasoning = '';
  let reasoningSignature: string | undefined;
  const tools: OpenAIToolCall[] = [];

  for (const p of parts) {
    if (p.text) {
      if (p.thought) {
        reasoning += p.text;
        reasoningSignature ??= p.thoughtSignature;
      } else {
        text += p.text;
      }
    }
    if (p.functionCall?.name) {
      tools.push({
        id: `call_${randomId()}`,
        type: 'function',
        ...(p.thoughtSignature ? { thought_signature: p.thoughtSignature } : {}),
        function: {
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args ?? {}),
        },
      });
    }
  }

  return {
    id: `chatcmpl_${randomId()}`,
    object: 'chat.completion',
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(reasoningSignature || tools[0]?.thought_signature
            ? { reasoning_signature: reasoningSignature ?? tools[0]?.thought_signature }
            : {}),
          ...(tools.length ? { tool_calls: tools } : {}),
        },
        finish_reason: mapGeminiFinish(cand?.finishReason, tools.length > 0),
      },
    ],
    usage: {
      prompt_tokens: res.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: res.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: res.usageMetadata?.totalTokenCount ?? 0,
    },
  };
}
