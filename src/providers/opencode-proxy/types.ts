import type { ServerResponse } from 'node:http';
import type { EgressTransport } from '../../network/egress/types';
import type { OpenCodeAuthMode, OpenCodeCatalog, OpenCodeCredential } from './auth';
import type { OpenCodeModelDescriptor, OpenCodeModelProtocol } from './models';

export interface OpenCodeProxyServerOptions {
  host: string;
  port: number;
  authPath: string;
  authPaths?: string[];
  authMode?: OpenCodeAuthMode;
  upstream?: string;
  zenUpstream?: string;
  goUpstream?: string;
  modelMetadataUrl?: string | false;
  token?: string;
  log?: (line: string) => void;
  quiet?: boolean;
  egress?: EgressTransport;
}

export interface CatalogModel extends OpenCodeModelDescriptor {
  catalog: OpenCodeCatalog;
}

export interface CatalogCache {
  byModel: Map<string, CatalogModel>;
  ids: string[];
  fetchedAt: number;
}

export interface OpenCodeModelResponse {
  id: string;
  object: 'model';
  owned_by: string;
  created?: number;
  protocol?: OpenCodeModelProtocol;
  /** Best-effort limit hints for clients that inspect OpenAI-compatible model metadata. */
  context_window?: number;
  max_context_window?: number;
  auto_compact_token_limit?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
}

export interface OpenCodeRequestContext {
  runtime: OpenCodeProxyRuntime;
  log: (line: string) => void;
  proxyToken: string;
  sessionId: string;
}

export interface OpenCodeProxyRuntime {
  readonly authMode: OpenCodeAuthMode;
  readonly catalog: OpenCodeCatalogStore;
  readonly egress: EgressTransport;
  readonly sessionId: string;
  credential(): Promise<OpenCodeCredential>;
  credentials(): Promise<OpenCodeCredential[]>;
  inferenceFetch(
    target: string,
    init: RequestInit,
    model: string,
    preferredCredential: OpenCodeCredential,
  ): Promise<Response>;
  baseFor(catalog: OpenCodeCatalog): string;
}

export interface OpenCodeCatalogStore {
  live(): Promise<CatalogCache>;
  route(modelId: string): Promise<{ catalog: OpenCodeCatalog; base: string }>;
}

export interface OpenAIResponsesResult {
  id?: string;
  model?: string;
  output?: Array<{
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: Array<{ type?: string; text?: string }>;
    summary?: Array<{ type?: string; text?: string }>;
  }>;
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string; code?: string };
}

export interface AnthropicErrorResult {
  type: 'error';
  error: { type: string; message: string; code?: string };
}

export type AnthropicResult =
  | import('../protocol/anthropic').AnthropicMessageResponse
  | AnthropicErrorResult;

export function modelObject(id: string, model: CatalogModel | undefined): OpenCodeModelResponse {
  const contextWindow = model?.limits?.context;
  const autoCompactLimit =
    model && contextWindow != null ? autoCompactTokenLimit(model) : undefined;
  return {
    id,
    object: 'model',
    owned_by: model?.ownedBy ?? (model?.catalog === 'go' ? 'opencode-go' : 'opencode'),
    ...(model?.created != null ? { created: model.created } : {}),
    ...(model?.protocol ? { protocol: model.protocol } : {}),
    ...(contextWindow != null
      ? {
          context_window: contextWindow,
          max_context_window: contextWindow,
          ...(autoCompactLimit != null ? { auto_compact_token_limit: autoCompactLimit } : {}),
        }
      : {}),
    ...(model?.limits?.input != null ? { max_input_tokens: model.limits.input } : {}),
    ...(model?.limits?.output != null ? { max_output_tokens: model.limits.output } : {}),
  };
}

/**
 * Publish the same usable-input boundary OpenCode uses before compaction.
 * OpenCode caps generation at 32k, reserves up to 20k when the provider has a
 * separate input limit, and otherwise subtracts the full generation budget
 * from the context window. This is metadata only—the proxy never rewrites a
 * caller's generation budget.
 */
function autoCompactTokenLimit(model: CatalogModel): number | undefined {
  const context = model.limits?.context;
  if (context == null || !Number.isFinite(context) || context <= 0) {
    return undefined;
  }
  const outputMax = Math.min(model.limits?.output ?? 32_000, 32_000);
  const input = model.limits?.input;
  const usable =
    input != null && Number.isFinite(input) && input > 0
      ? input - Math.min(20_000, outputMax)
      : context - outputMax;
  return Number.isFinite(usable) && usable > 0 ? Math.floor(usable) : undefined;
}

export type ResponseWriter = ServerResponse;
