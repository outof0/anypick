import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mapToGeminiModel,
  openAIToGemini,
  geminiToOpenAI,
  geminiToAnthropic,
  geminiToOpenAIResponses,
  openAIResponsesToGemini,
  anthropicToGemini,
  compareGeminiModelIds,
  resolveGeminiModel,
  sanitizeGeminiSchema,
} from '../src/providers/protocol/gemini/translate';
import { listenGeminiProxy } from '../src/providers/gemini-proxy/server';
import { geminiAccountAdapter } from '../src/sources/account-adapters';
import type { Account } from '../src/types';

describe('mapToGeminiModel', () => {
  it('passes explicit versioned gemini ids through', () => {
    expect(mapToGeminiModel('gemini-2.5-flash')).toBe('gemini-2.5-flash');
    expect(mapToGeminiModel('google/gemini-2.5-pro')).toBe('gemini-2.5-pro');
  });

  it('normalizes without silently changing aliases or future ids', () => {
    expect(mapToGeminiModel('gemini')).toBe('gemini');
    expect(mapToGeminiModel('gemini-pro')).toBe('gemini-pro');
    expect(mapToGeminiModel('gemini-9.2-ultra')).toBe('gemini-9.2-ultra');
    expect(mapToGeminiModel(undefined)).toBe('');
  });

  it('resolves role aliases only from the live catalog', () => {
    const live = ['gemini-9.2-pro', 'gemini-9.3-flash', 'gemini-9.1-flash-lite'];
    expect(resolveGeminiModel('claude-sonnet-next', live).id).toBe('gemini-9.2-pro');
    expect(resolveGeminiModel('gemini-flash', live).id).toBe('gemini-9.3-flash');
    expect(resolveGeminiModel('claude-haiku-next', live).id).toBe('gemini-9.1-flash-lite');
  });

  it('resolves display-name aliases to opaque Code Assist ids', () => {
    const catalog = {
      defaultModelId: 'gemini-3.5-flash-low',
      preferredModelIds: ['gemini-3.5-flash-low', 'gemini-3.5-flash-extra-low'],
      models: [
        {
          id: 'gemini-3.5-flash-extra-low',
          displayName: 'Gemini 3.5 Flash (Low)',
          recommended: true,
        },
        {
          id: 'gemini-3.5-flash-low',
          displayName: 'Gemini 3.5 Flash (Medium)',
          recommended: true,
        },
      ],
    };
    expect(resolveGeminiModel('gemini-3.5-flash', catalog)).toEqual({
      id: 'gemini-3.5-flash-low',
      remapped: true,
      reason: 'alias',
    });
    expect(resolveGeminiModel('gemini-3.5-flash-extra-low', catalog).remapped).toBe(false);
  });

  it('resolves effort variants from live display metadata without inferring opaque ids', () => {
    const catalog = {
      defaultModelId: 'opaque-medium-rollout',
      preferredModelIds: ['opaque-medium-rollout', 'opaque-high-rollout', 'opaque-low-rollout'],
      models: [
        { id: 'opaque-low-rollout', displayName: 'Gemini Future Flash (Low)' },
        { id: 'opaque-medium-rollout', displayName: 'Gemini Future Flash (Medium)' },
        { id: 'opaque-high-rollout', displayName: 'Gemini Future Flash (High)' },
      ],
    };
    expect(resolveGeminiModel('gemini-future-flash', catalog, 'xhigh')).toEqual({
      id: 'opaque-high-rollout',
      remapped: true,
      reason: 'effort',
    });
    expect(resolveGeminiModel('gemini-future-flash', catalog, 'low').id).toBe('opaque-low-rollout');
    expect(resolveGeminiModel('gemini-future-flash', catalog, 'medium').id).toBe(
      'opaque-medium-rollout',
    );
    // An explicitly requested catalog id remains authoritative.
    expect(resolveGeminiModel('opaque-low-rollout', catalog, 'xhigh').id).toBe(
      'opaque-low-rollout',
    );
  });

  it('passes through current Gemini ids', () => {
    expect(mapToGeminiModel('gemini-3.5-flash')).toBe('gemini-3.5-flash');
    expect(mapToGeminiModel('models/gemini-3.1-pro')).toBe('gemini-3.1-pro');
  });
});

describe('compareGeminiModelIds', () => {
  it('ranks higher version ids before older ones', () => {
    const ids = ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.1-pro', 'gemini-2.5-pro'];
    // 3.5 > 3.1 > 2.5; within same version pro before flash
    expect(ids.toSorted(compareGeminiModelIds)).toEqual([
      'gemini-3.5-flash',
      'gemini-3.1-pro',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ]);
  });
});

describe('openAIToGemini / geminiToOpenAI', () => {
  it('round-trips text chat', () => {
    const gemini = openAIToGemini({
      model: 'gemini-2.5-pro',
      messages: [
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'Hi' },
      ],
      max_tokens: 100,
    });
    expect(gemini.systemInstruction?.parts[0]?.text).toBe('Be brief');
    expect(gemini.contents[0]?.role).toBe('user');
    expect(gemini.contents[0]?.parts[0]?.text).toBe('Hi');

    const openai = geminiToOpenAI(
      {
        candidates: [{ content: { parts: [{ text: 'Hello' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      },
      'gemini-2.5-pro',
    );
    expect(openai.choices?.[0]?.message?.content).toBe('Hello');
  });

  it('sanitizes JSON Schema keywords unsupported by Gemini tools', () => {
    const schema = sanitizeGeminiSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      propertyNames: { pattern: '^[a-z]+$' },
      properties: {
        value: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
            },
          },
        },
      },
    });
    expect(schema).toEqual({
      type: 'object',
      properties: {
        value: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' } },
          },
        },
      },
    });
    expect(JSON.stringify(schema)).not.toMatch(/\$(schema|ref)|additionalProperties|propertyNames/);
  });

  it('sanitizes tool parameters in OpenAI requests', () => {
    const request = openAIToGemini({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'use the tool' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            parameters: {
              $schema: 'draft-07',
              type: 'object',
              additionalProperties: false,
              properties: { query: { type: 'string' } },
            },
          },
        },
      ],
    });
    expect(request.tools?.[0]?.functionDeclarations[0]?.parameters).toEqual({
      type: 'object',
      properties: { query: { type: 'string' } },
    });
  });

  it('maps Codex reasoning effort to the Gemini generation API', () => {
    const modern = openAIToGemini({
      model: 'gemini-3.5-flash',
      messages: [{ role: 'user', content: 'think' }],
      reasoning_effort: 'xhigh',
      reasoning: { summary: 'auto' },
    });
    expect(modern.generationConfig?.thinkingConfig).toEqual({
      thinkingLevel: 'HIGH',
      includeThoughts: true,
    });

    const legacy = openAIToGemini({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'fast' }],
      reasoning_effort: 'minimal',
    });
    expect(legacy.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('exposes Gemini thought summaries without mixing them into answer text', () => {
    const response = {
      candidates: [
        {
          content: {
            parts: [
              { text: 'checking', thought: true, thoughtSignature: 'opaque-signature' },
              { text: 'final answer' },
            ],
          },
        },
      ],
    };
    expect(geminiToOpenAI(response, 'gemini-3.5-flash').choices?.[0]?.message).toMatchObject({
      reasoning_content: 'checking',
      content: 'final answer',
    });
    expect(geminiToAnthropic(response, 'gemini-3.5-flash')).toMatchObject({
      content: [
        { type: 'thinking', thinking: 'checking', signature: 'opaque-signature' },
        { type: 'text', text: 'final answer' },
      ],
    });
  });

  it('round-trips the signature attached to each Gemini function call through Claude', () => {
    const first = geminiToAnthropic(
      {
        candidates: [
          {
            content: {
              parts: [
                { text: 'checking', thought: true, thoughtSignature: 'thought-signature' },
                {
                  functionCall: { name: 'default_api__Bash', args: { command: 'pwd' } },
                  thoughtSignature: 'function-signature',
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
      'gemini-3.5-flash-low',
    );
    if (first.type === 'error') {
      throw new Error(first.error.message);
    }
    const tool = first.content.find((block) => block.type === 'tool_use');
    expect(tool).toMatchObject({
      type: 'tool_use',
      name: 'default_api__Bash',
      thought_signature: 'function-signature',
    });
    expect(first.content).toContainEqual({
      type: 'thinking',
      thinking: '\u200B',
      signature: 'function-signature',
    });

    const replay = anthropicToGemini(
      {
        model: 'gemini-3.5-flash',
        max_tokens: 512,
        messages: [
          { role: 'assistant', content: first.content },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: tool?.id ?? '', content: '/repo' }],
          },
        ],
      },
      'gemini-3.5-flash-low',
    ).gemini;
    const assistant = replay.contents.find((content) => content.role === 'model');
    expect(assistant?.parts).toEqual([
      { text: 'checking', thought: true, thoughtSignature: 'thought-signature' },
      {
        functionCall: { name: 'default_api__Bash', args: { command: 'pwd' } },
        thoughtSignature: 'function-signature',
      },
    ]);
    expect(
      replay.contents
        .filter((content) => content.role === 'user')
        .flatMap((content) => content.parts),
    ).toContainEqual({
      functionResponse: { name: 'default_api__Bash', response: { result: '/repo' } },
    });
  });

  it('translates Codex Responses reasoning and preserves encrypted thought state', () => {
    const request = openAIResponsesToGemini(
      {
        model: 'gemini-3.5-flash',
        instructions: 'Be concise',
        reasoning: { effort: 'high', summary: 'auto' },
        input: [
          {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: 'prior thought' }],
            encrypted_content: 'prior-signature',
          },
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'lookup',
            arguments: '{"q":"x"}',
          },
          { type: 'function_call_output', call_id: 'call_1', output: 'found' },
        ],
      },
      'gemini-3.5-flash-low',
    );
    expect(request.generationConfig?.thinkingConfig).toEqual({
      thinkingLevel: 'HIGH',
      includeThoughts: true,
    });
    expect(request.contents.find((content) => content.role === 'model')?.parts).toMatchObject([
      { text: 'prior thought', thought: true, thoughtSignature: 'prior-signature' },
      { functionCall: { name: 'lookup', args: { q: 'x' } } },
    ]);

    const response = geminiToOpenAIResponses(
      {
        candidates: [
          {
            content: {
              parts: [
                { text: 'new thought', thought: true, thoughtSignature: 'new-signature' },
                { text: 'answer' },
                {
                  functionCall: { name: 'next', args: { id: 1 } },
                  thoughtSignature: 'function-signature',
                },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 3,
          candidatesTokenCount: 5,
          thoughtsTokenCount: 2,
          totalTokenCount: 8,
        },
      },
      'gemini-3.5-flash-low',
    );
    expect(response.output.map((item) => item.type)).toEqual([
      'reasoning',
      'message',
      'reasoning',
      'function_call',
    ]);
    expect(response.output[0]).toMatchObject({
      summary: [{ text: 'new thought' }],
      encrypted_content: 'new-signature',
    });
    expect(response.output[2]).toMatchObject({
      type: 'reasoning',
      summary: [],
      encrypted_content: 'function-signature',
    });
    const call = response.output.find((item) => item.type === 'function_call');
    const replay = openAIResponsesToGemini(
      {
        model: 'gemini-3.5-flash',
        input: [
          ...response.output,
          {
            id: call?.id ?? 'call_1',
            type: 'function_call_output',
            call_id: call?.call_id,
            output: 'done',
          },
        ],
      },
      'gemini-3.5-flash-low',
    );
    expect(
      replay.contents
        .filter((content) => content.role === 'model')
        .flatMap((content) => content.parts)
        .find((part) => part.functionCall?.name === 'next'),
    ).toMatchObject({
      functionCall: { name: 'next', args: { id: 1 } },
      thoughtSignature: 'function-signature',
    });
    expect(response.usage.output_tokens_details.reasoning_tokens).toBe(2);
  });
});

describe('anthropicToGemini', () => {
  it('converts messages', () => {
    const { gemini, model } = anthropicToGemini(
      {
        model: 'claude-sonnet-next',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'ping' }],
        system: 'sys',
      },
      'gemini-9.2-pro',
    );
    expect(model).toBe('gemini-9.2-pro');
    expect(gemini.systemInstruction?.parts[0]?.text).toBe('sys');
    expect(gemini.contents.some((c) => c.parts.some((p) => p.text === 'ping'))).toBe(true);
  });

  it('preserves Claude adaptive effort and manual thinking budgets', () => {
    const adaptive = anthropicToGemini(
      {
        model: 'claude-future',
        max_tokens: 8192,
        messages: [{ role: 'user', content: 'analyze' }],
        thinking: { type: 'adaptive' },
        output_config: { effort: 'max' },
      },
      'gemini-3.5-flash',
    );
    expect(adaptive.gemini.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: 'HIGH',
    });

    const manual = anthropicToGemini(
      {
        model: 'claude-legacy',
        max_tokens: 8192,
        messages: [{ role: 'user', content: 'analyze' }],
        thinking: { type: 'enabled', budget_tokens: 2048 },
      },
      'gemini-2.5-pro',
    );
    expect(manual.gemini.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 2048,
    });
  });
});

describe('geminiAccountAdapter proxy transport', () => {
  it('exposes managed_builtin_proxy for claude and codex', () => {
    const account: Account = {
      meta: {
        name: 'work',
        provider: 'gemini',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      snapshotDir: '/tmp/x',
      accountDir: '/tmp/x',
      proxy: { enabled: false },
    };
    const a = geminiAccountAdapter(account);
    expect(a.transportFor('claude')).toBe('managed_builtin_proxy');
    expect(a.transportFor('codex')).toBe('managed_builtin_proxy');
    expect(a.transportFor('gemini')).toBe('direct');
  });
});

describe('listenGeminiProxy (mock upstream)', () => {
  const TEST_TOKEN = 'test-proxy-token-gemini-123';
  const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
  const servers: Server[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    for (const d of dirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('serves health and translates OpenAI chat via mock Gemini API', async () => {
    let lastGenerateBody: Record<string, unknown> | undefined;
    // Fake Gemini upstream
    const upstream = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const c of req) {
          chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
        }
        if (chunks.length) {
          lastGenerateBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
            string,
            unknown
          >;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: 'from-gemini' }] },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: 3,
              candidatesTokenCount: 2,
              totalTokenCount: 5,
            },
          }),
        );
      })();
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
    servers.push(upstream);
    const u = upstream.address();
    const upPort = u && typeof u === 'object' ? u.port : 0;

    const dir = await mkdtemp(join(tmpdir(), 'anypick-gproxy-'));
    dirs.push(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.env'), 'GEMINI_API_KEY=test-key\n', { mode: 0o600 });

    const { endpoint, server } = await listenGeminiProxy({
      token: TEST_TOKEN,
      host: '127.0.0.1',
      port: 0,
      authDir: dir,
      apiKey: 'test-key',
      upstream: `http://127.0.0.1:${upPort}`,
      quiet: true,
    });
    servers.push(server);

    const health = await fetch(`${endpoint}/health`);
    expect(health.status).toBe(200);
    const h = (await health.json()) as { ok: boolean; auth: string };
    expect(h.ok).toBe(true);
    expect(h.auth).toBe('ok');

    const chat = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(chat.status).toBe(200);
    const body = (await chat.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    expect(body.choices?.[0]?.message?.content).toBe('from-gemini');

    // Codex model-provider base_url appends /responses (without /v1).
    const responses = await fetch(`${endpoint}/responses`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.5-flash',
        input: 'hi',
        stream: true,
        reasoning: { effort: 'high', summary: 'auto' },
      }),
    });
    expect(responses.status).toBe(200);
    const events = await responses.text();
    expect(events).toContain('event: response.output_text.delta');
    expect(events).toContain('event: response.completed');
    expect(lastGenerateBody?.generationConfig).toMatchObject({
      thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true },
    });
  });

  it('uses a second pooled key only for an explicit credential quota response', async () => {
    const seenKeys: string[] = [];
    const upstream = createServer((req, res) => {
      if (!(req.url ?? '').includes(':generateContent')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'models/gemini-3.5-flash' }] }));
        return;
      }
      const key = String(req.headers['x-goog-api-key'] ?? '');
      seenKeys.push(key);
      if (key === 'first-key') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' });
        res.end(
          JSON.stringify({
            error: { status: 'RESOURCE_EXHAUSTED', message: 'API key quota exceeded' },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: 'served by backup' }] }, finishReason: 'STOP' },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    servers.push(upstream);
    const address = upstream.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    const firstDir = await mkdtemp(join(tmpdir(), 'anypick-gproxy-quota-'));
    const secondDir = await mkdtemp(join(tmpdir(), 'anypick-gproxy-quota-'));
    dirs.push(firstDir, secondDir);
    await writeFile(join(firstDir, '.env'), 'GEMINI_API_KEY=first-key\n', { mode: 0o600 });
    await writeFile(join(secondDir, '.env'), 'GEMINI_API_KEY=second-key\n', { mode: 0o600 });

    const { endpoint, server } = await listenGeminiProxy({
      token: TEST_TOKEN,
      host: '127.0.0.1',
      port: 0,
      authDir: firstDir,
      authDirs: [firstDir, secondDir],
      authAccountNames: ['first', 'second'],
      upstream: `http://127.0.0.1:${port}`,
      quiet: true,
      quotaGuard: {
        enabled: true,
        cooldownMs: 60_000,
        statePath: join(firstDir, 'quota-guard.json'),
        providerId: 'gemini',
      },
    });
    servers.push(server);

    const response = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(response.status).toBe(200);
    expect(seenKeys).toEqual(['first-key', 'second-key']);
  });

  it('GET /v1/models requests Google ListModels and ranks live ids (no hardcode inject)', async () => {
    let listHits = 0;
    const upstream = createServer((req, res) => {
      const url = req.url ?? '';
      if (url.includes('/v1beta/models') && !url.includes('generateContent')) {
        listHits += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-2.5-flash',
                supportedGenerationMethods: ['generateContent'],
              },
              {
                name: 'models/gemini-2.5-pro',
                supportedGenerationMethods: ['generateContent'],
              },
              {
                name: 'models/gemini-3.5-flash',
                supportedGenerationMethods: ['generateContent'],
              },
              {
                name: 'models/gemini-3.1-pro',
                supportedGenerationMethods: ['generateContent'],
              },
              {
                name: 'models/embedding-001',
                supportedGenerationMethods: ['embedContent'],
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
    servers.push(upstream);
    const u = upstream.address();
    const upPort = u && typeof u === 'object' ? u.port : 0;

    const dir = await mkdtemp(join(tmpdir(), 'anypick-gproxy-list-'));
    dirs.push(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.env'), 'GEMINI_API_KEY=test-key\n', { mode: 0o600 });

    const { endpoint, server } = await listenGeminiProxy({
      token: TEST_TOKEN,
      host: '127.0.0.1',
      port: 0,
      authDir: dir,
      apiKey: 'test-key',
      upstream: `http://127.0.0.1:${upPort}`,
      quiet: true,
    });
    servers.push(server);

    const res = await fetch(`${endpoint}/v1/models`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(listHits).toBeGreaterThanOrEqual(1);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((m) => m.id);
    // Only what Google returned (chat models) — never inject missing ids
    expect(ids).toEqual([
      'gemini-3.5-flash',
      'gemini-3.1-pro',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ]);
    expect(ids).not.toContain('embedding-001');
    expect(ids).not.toContain('gemini-3.1-flash-lite'); // not in Google response
  });

  it('discovers OAuth models and display names from fetchAvailableModels', async () => {
    let quotaHits = 0;
    const codeAssist = createServer((req, res) => {
      if (req.url === '/v1internal:loadCodeAssist') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ cloudaicompanionProject: 'managed-project' }));
        return;
      }
      if (req.url === '/v1internal:fetchAvailableModels') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            models: {
              'gemini-9.3-flash': {
                displayName: 'Gemini 9.3 Flash (Medium)',
                recommended: true,
                apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                modelProvider: 'MODEL_PROVIDER_GOOGLE',
              },
              'gemini-9.2-pro': {
                displayName: 'Gemini 9.2 Pro',
                apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                modelProvider: 'MODEL_PROVIDER_GOOGLE',
              },
              'claude-not-gemini': {
                displayName: 'Claude',
                apiProvider: 'API_PROVIDER_ANTHROPIC_VERTEX',
                modelProvider: 'MODEL_PROVIDER_ANTHROPIC',
              },
            },
            defaultAgentModelId: 'gemini-9.3-flash',
            agentModelSorts: [{ groups: [{ modelIds: ['gemini-9.3-flash'] }] }],
          }),
        );
        return;
      }
      if (req.url === '/v1internal:retrieveUserQuota') {
        quotaHits += 1;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => codeAssist.listen(0, '127.0.0.1', resolve));
    servers.push(codeAssist);
    const address = codeAssist.address();
    const codeAssistPort = address && typeof address === 'object' ? address.port : 0;

    const dir = await mkdtemp(join(tmpdir(), 'anypick-gproxy-oauth-list-'));
    dirs.push(dir);
    await writeFile(
      join(dir, 'oauth_creds.json'),
      JSON.stringify({ access_token: 'oauth-token', expiry_date: Date.now() + 3_600_000 }),
      { mode: 0o600 },
    );
    await writeFile(
      join(dir, 'auth-settings.json'),
      JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }),
      { mode: 0o600 },
    );

    const { endpoint, server } = await listenGeminiProxy({
      token: TEST_TOKEN,
      host: '127.0.0.1',
      port: 0,
      authDir: dir,
      codeAssistUpstream: `http://127.0.0.1:${codeAssistPort}`,
      quiet: true,
    });
    servers.push(server);

    const response = await fetch(`${endpoint}/v1/models`, { headers: AUTH });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{ id: string; owned_by: string; display_name?: string }>;
    };
    expect(body.data).toEqual([
      {
        id: 'gemini-9.3-flash',
        object: 'model',
        owned_by: 'google-code-assist',
        display_name: 'Gemini 9.3 Flash (Medium)',
      },
      {
        id: 'gemini-9.2-pro',
        object: 'model',
        owned_by: 'google-code-assist',
        display_name: 'Gemini 9.2 Pro',
      },
    ]);
    expect(quotaHits).toBe(0);
  });

  it('falls back to account quota ids when the OAuth catalog is forbidden', async () => {
    const codeAssist = createServer((req, res) => {
      if (req.url === '/v1internal:loadCodeAssist') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ cloudaicompanionProject: 'managed-project' }));
        return;
      }
      if (req.url === '/v1internal:fetchAvailableModels') {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'forbidden' } }));
        return;
      }
      if (req.url === '/v1internal:retrieveUserQuota') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ buckets: [{ modelId: 'gemini-9.3-flash' }] }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => codeAssist.listen(0, '127.0.0.1', resolve));
    servers.push(codeAssist);
    const address = codeAssist.address();
    const codeAssistPort = address && typeof address === 'object' ? address.port : 0;
    const dir = await createOAuthDir('anypick-gproxy-oauth-quota-');

    const { endpoint, server } = await listenGeminiProxy({
      token: TEST_TOKEN,
      host: '127.0.0.1',
      port: 0,
      authDir: dir,
      codeAssistUpstream: `http://127.0.0.1:${codeAssistPort}`,
      quiet: true,
    });
    servers.push(server);

    const response = await fetch(`${endpoint}/v1/models`, { headers: AUTH });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((model) => model.id)).toEqual(['gemini-9.3-flash']);
  });

  it('uses an explicit Antigravity OAuth credential and request profile', async () => {
    let loadMetadata: unknown;
    let userAgent: string | undefined;
    const codeAssist = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.from(chunk));
        }
        if (req.url === '/v1internal:loadCodeAssist') {
          loadMetadata = (
            JSON.parse(Buffer.concat(chunks).toString('utf8')) as { metadata?: unknown }
          ).metadata;
          userAgent = req.headers['user-agent'];
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ cloudaicompanionProject: 'app-project' }));
          return;
        }
        if (req.url === '/v1internal:fetchAvailableModels') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              models: {
                'gemini-rollout-id': {
                  displayName: 'Gemini Future',
                  apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                  modelProvider: 'MODEL_PROVIDER_GOOGLE',
                },
              },
            }),
          );
          return;
        }
        res.writeHead(404).end();
      })();
    });
    await new Promise<void>((resolve) => codeAssist.listen(0, '127.0.0.1', resolve));
    servers.push(codeAssist);
    const address = codeAssist.address();
    const codeAssistPort = address && typeof address === 'object' ? address.port : 0;
    const dir = await mkdtemp(join(tmpdir(), 'anypick-gproxy-antigravity-'));
    dirs.push(dir);
    const credentialFile = join(dir, 'antigravity-oauth.json');
    await writeFile(
      credentialFile,
      JSON.stringify({ access_token: 'app-oauth-token', expiry_date: Date.now() + 3_600_000 }),
      { mode: 0o600 },
    );

    const { endpoint, server } = await listenGeminiProxy({
      token: TEST_TOKEN,
      host: '127.0.0.1',
      port: 0,
      authDir: dir,
      oauthSource: 'antigravity',
      antigravityOAuthFile: credentialFile,
      codeAssistUpstream: `http://127.0.0.1:${codeAssistPort}`,
      quiet: true,
    });
    servers.push(server);

    expect((await fetch(`${endpoint}/v1/models`, { headers: AUTH })).status).toBe(200);
    expect(loadMetadata).toEqual({ ideType: 'ANTIGRAVITY' });
    expect(userAgent).toContain('antigravity/hub/');
  });

  it('sends the effort-selected Code Assist id and session id for Claude', async () => {
    let generateBody: Record<string, unknown> | undefined;
    let generateHits = 0;
    const codeAssist = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.from(chunk));
        }
        if (req.url === '/v1internal:loadCodeAssist') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ cloudaicompanionProject: 'managed-project' }));
          return;
        }
        if (req.url === '/v1internal:fetchAvailableModels') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              models: {
                'gemini-3.5-flash-low': {
                  displayName: 'Gemini 3.5 Flash (Medium)',
                  recommended: true,
                  apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                  modelProvider: 'MODEL_PROVIDER_GOOGLE',
                },
                'opaque-high-rollout': {
                  displayName: 'Gemini 3.5 Flash (High)',
                  recommended: true,
                  apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                  modelProvider: 'MODEL_PROVIDER_GOOGLE',
                },
              },
              defaultAgentModelId: 'gemini-3.5-flash-low',
            }),
          );
          return;
        }
        if (req.url === '/v1internal:generateContent') {
          generateHits += 1;
          generateBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
            string,
            unknown
          >;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              response: {
                candidates: [{ content: { parts: [{ text: 'from-code-assist' }] } }],
              },
            }),
          );
          return;
        }
        res.writeHead(404).end();
      })();
    });
    await new Promise<void>((resolve) => codeAssist.listen(0, '127.0.0.1', resolve));
    servers.push(codeAssist);
    const address = codeAssist.address();
    const codeAssistPort = address && typeof address === 'object' ? address.port : 0;
    const dir = await createOAuthDir('anypick-gproxy-oauth-alias-');

    const { endpoint, server } = await listenGeminiProxy({
      token: TEST_TOKEN,
      host: '127.0.0.1',
      port: 0,
      authDir: dir,
      codeAssistUpstream: `http://127.0.0.1:${codeAssistPort}`,
      quiet: true,
    });
    servers.push(server);

    const response = await fetch(`${endpoint}/v1/messages`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.5-flash',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'adaptive' },
        output_config: { effort: 'xhigh' },
      }),
    });
    expect(response.status).toBe(200);
    expect(generateHits).toBe(1);
    expect(generateBody?.model).toBe('opaque-high-rollout');
    expect(generateBody?.request).toMatchObject({
      session_id: expect.any(String),
      generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } },
    });
  });

  it('auto-selects Gemini CLI first and uses Antigravity when only its catalog has the model', async () => {
    let generateAuth = '';
    let generatedModel = '';
    const codeAssist = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.from(chunk));
        }
        const auth = String(req.headers.authorization ?? '');
        if (req.url === '/v1internal:loadCodeAssist') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ cloudaicompanionProject: `${auth}-project` }));
          return;
        }
        if (req.url === '/v1internal:fetchAvailableModels') {
          const app = auth === 'Bearer app-oauth-token';
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              models: app
                ? {
                    'gemini-3.5-flash-low': {
                      displayName: 'Gemini 3.5 Flash (Medium)',
                      apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                      modelProvider: 'MODEL_PROVIDER_GOOGLE',
                    },
                  }
                : {
                    'gemini-cli-only': {
                      displayName: 'Gemini CLI Only',
                      apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                      modelProvider: 'MODEL_PROVIDER_GOOGLE',
                    },
                  },
            }),
          );
          return;
        }
        if (req.url === '/v1internal:generateContent') {
          generateAuth = auth;
          generatedModel = String(
            (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: string }).model ?? '',
          );
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              response: { candidates: [{ content: { parts: [{ text: 'from app' }] } }] },
            }),
          );
          return;
        }
        res.writeHead(404).end();
      })();
    });
    await new Promise<void>((resolve) => codeAssist.listen(0, '127.0.0.1', resolve));
    servers.push(codeAssist);
    const address = codeAssist.address();
    const codeAssistPort = address && typeof address === 'object' ? address.port : 0;
    const dir = await createOAuthDir('anypick-gproxy-auto-auth-');
    const credentialFile = join(dir, 'antigravity-oauth.json');
    await writeFile(
      credentialFile,
      JSON.stringify({ access_token: 'app-oauth-token', expiry_date: Date.now() + 3_600_000 }),
      { mode: 0o600 },
    );

    const { endpoint, server } = await listenGeminiProxy({
      token: TEST_TOKEN,
      host: '127.0.0.1',
      port: 0,
      authDir: dir,
      oauthSource: 'auto',
      antigravityOAuthFile: credentialFile,
      codeAssistUpstream: `http://127.0.0.1:${codeAssistPort}`,
      quiet: true,
    });
    servers.push(server);

    const response = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(response.status).toBe(200);
    expect(generateAuth).toBe('Bearer app-oauth-token');
    expect(generatedModel).toBe('gemini-3.5-flash-low');
  });

  it('keeps Antigravity active after the Gemini CLI catalog rejects entitlement', async () => {
    let cliCatalogHits = 0;
    let cliQuotaHits = 0;
    let appCatalogHits = 0;
    let generateAuth = '';
    const logs: string[] = [];
    const codeAssist = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.from(chunk));
        }
        const auth = String(req.headers.authorization ?? '');
        const app = auth === 'Bearer app-oauth-token';
        if (req.url === '/v1internal:loadCodeAssist') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ cloudaicompanionProject: app ? 'app-project' : 'cli-project' }));
          return;
        }
        if (req.url === '/v1internal:fetchAvailableModels') {
          if (!app) {
            cliCatalogHits += 1;
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'forbidden' } }));
            return;
          }
          appCatalogHits += 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              models: {
                'gemini-3.5-flash-low': {
                  displayName: 'Gemini 3.5 Flash (Medium)',
                  apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                  modelProvider: 'MODEL_PROVIDER_GOOGLE',
                },
              },
            }),
          );
          return;
        }
        if (req.url === '/v1internal:retrieveUserQuota') {
          cliQuotaHits += 1;
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'forbidden' } }));
          return;
        }
        if (req.url === '/v1internal:generateContent') {
          generateAuth = auth;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              response: { candidates: [{ content: { parts: [{ text: 'from app' }] } }] },
            }),
          );
          return;
        }
        res.writeHead(404).end();
      })();
    });
    await new Promise<void>((resolve) => codeAssist.listen(0, '127.0.0.1', resolve));
    servers.push(codeAssist);
    const address = codeAssist.address();
    const codeAssistPort = address && typeof address === 'object' ? address.port : 0;
    const dir = await createOAuthDir('anypick-gproxy-sticky-auth-');
    const credentialFile = join(dir, 'antigravity-oauth.json');
    await writeFile(
      credentialFile,
      JSON.stringify({ access_token: 'app-oauth-token', expiry_date: Date.now() + 3_600_000 }),
      { mode: 0o600 },
    );

    const { endpoint, server } = await listenGeminiProxy({
      token: TEST_TOKEN,
      host: '127.0.0.1',
      port: 0,
      authDir: dir,
      oauthSource: 'auto',
      antigravityOAuthFile: credentialFile,
      codeAssistUpstream: `http://127.0.0.1:${codeAssistPort}`,
      log: (line) => logs.push(line),
    });
    servers.push(server);

    const generated = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(generated.status).toBe(200);
    expect(generateAuth).toBe('Bearer app-oauth-token');
    expect(logs).toContain(
      '  auth auto: active route=antigravity (Gemini CLI entitlement rejected)',
    );

    expect((await fetch(`${endpoint}/v1/models`, { headers: AUTH })).status).toBe(200);
    expect((await fetch(`${endpoint}/v1/models`, { headers: AUTH })).status).toBe(200);
    expect(cliCatalogHits).toBe(1);
    expect(cliQuotaHits).toBe(1);
    expect(appCatalogHits).toBe(1);
    expect(logs.filter((line) => line.includes('list models auth=gemini-cli failed'))).toEqual([]);
  });

  it('GET /v1/models returns 502 when Google ListModels fails (no fake catalog)', async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unavailable' } }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
    servers.push(upstream);
    const u = upstream.address();
    const upPort = u && typeof u === 'object' ? u.port : 0;

    const dir = await mkdtemp(join(tmpdir(), 'anypick-gproxy-list-fail-'));
    dirs.push(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.env'), 'GEMINI_API_KEY=test-key\n', { mode: 0o600 });

    const { endpoint, server } = await listenGeminiProxy({
      token: TEST_TOKEN,
      host: '127.0.0.1',
      port: 0,
      authDir: dir,
      apiKey: 'test-key',
      upstream: `http://127.0.0.1:${upPort}`,
      quiet: true,
    });
    servers.push(server);

    const res = await fetch(`${endpoint}/v1/models`, { headers: AUTH });
    expect(res.status).toBe(502);
  });

  async function createOAuthDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(dir);
    await writeFile(
      join(dir, 'oauth_creds.json'),
      JSON.stringify({ access_token: 'oauth-token', expiry_date: Date.now() + 3_600_000 }),
      { mode: 0o600 },
    );
    await writeFile(
      join(dir, 'auth-settings.json'),
      JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }),
      { mode: 0o600 },
    );
    return dir;
  }
});
