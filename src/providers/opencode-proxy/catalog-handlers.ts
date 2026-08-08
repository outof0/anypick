import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolveOpenCodeModel } from './models';
import { modelObject } from './types';
import { estimateAnthropicInputTokens, readBody } from './body';
import { json } from './http';
import type { OpenCodeRuntime } from './runtime';

export async function handleHealth(runtime: OpenCodeRuntime, res: ServerResponse): Promise<void> {
  let service = runtime.authMode === 'public' ? 'public' : 'unavailable';
  let poolSize = 0;
  try {
    const ring = await runtime.credentials();
    poolSize = ring.length;
    service = (await runtime.credential()).service;
  } catch {
    // Health remains available while auth is unavailable.
  }
  json(res, 200, {
    ok: true,
    service: 'anypick-opencode-proxy',
    compatibility: 'OpenAI + Anthropic API',
    instanceId: process.env.ANYPICK_INSTANCE_ID ?? null,
    clients: {
      codex: 'OPENAI_BASE_URL → /v1/responses',
      claude: 'ANTHROPIC_BASE_URL → /v1/messages',
    },
    endpoints: {
      openai: ['/v1/chat/completions', '/v1/responses', '/v1/models'],
      anthropic: ['/v1/messages'],
    },
    credential: {
      authMode: runtime.authMode,
      service,
      poolSize,
      exhausted: runtime.exhaustedCount,
    },
  });
}

/** A `?refresh=1` model-list request must always refetch, never serve the 10-min cache. */
function wantsFreshCatalog(req: IncomingMessage): boolean {
  const raw = req.url ?? '';
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
  return new URLSearchParams(query).get('refresh') === '1';
}

export async function handleListModels(
  runtime: OpenCodeRuntime,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (wantsFreshCatalog(req)) {
      runtime.catalog.invalidate();
    }
    const catalog = await runtime.catalog.live();
    json(res, 200, {
      object: 'list',
      data: catalog.ids.map((id) => modelObject(id, catalog.byModel.get(id))),
    });
  } catch (err) {
    json(res, 502, {
      error: { message: err instanceof Error ? err.message : String(err), type: 'proxy_error' },
    });
  }
}

export async function handleGetModel(
  runtime: OpenCodeRuntime,
  rawId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const id = decodeURIComponent(rawId).trim();
    if (!id) {
      json(res, 404, {
        type: 'error',
        error: { type: 'not_found_error', message: 'Model id required' },
      });
      return;
    }
    if (wantsFreshCatalog(req)) {
      runtime.catalog.invalidate();
    }
    const catalog = await runtime.catalog.live();
    const resolved = resolveOpenCodeModel(id, catalog.ids);
    if (catalog.ids.length > 0 && !catalog.byModel.has(resolved.id)) {
      json(res, 404, {
        type: 'error',
        error: {
          type: 'not_found_error',
          message: `Model "${resolved.id}" is not present in the live OpenCode catalog.`,
        },
      });
      return;
    }
    json(res, 200, modelObject(resolved.id, catalog.byModel.get(resolved.id)));
  } catch (err) {
    json(res, 502, {
      type: 'error',
      error: { type: 'proxy_error', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

export async function handleCountTokens(
  runtime: OpenCodeRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  log: (line: string) => void,
): Promise<void> {
  try {
    let body: {
      model?: string;
      system?: unknown;
      messages?: unknown;
      tools?: unknown;
      [key: string]: unknown;
    };
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as typeof body;
    } catch {
      json(res, 400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Invalid JSON body' },
      });
      return;
    }
    const catalog = await runtime.catalog.live();
    const resolved = resolveOpenCodeModel(body.model, catalog.ids);
    const inputTokens = estimateAnthropicInputTokens(body);
    log(`POST /v1/messages/count_tokens → ${inputTokens} (model ${resolved.id})`);
    json(res, 200, { input_tokens: inputTokens });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`✗ count_tokens: ${message}`);
    if (!res.headersSent) {
      json(res, 502, { type: 'error', error: { type: 'proxy_error', message } });
    }
  }
}
