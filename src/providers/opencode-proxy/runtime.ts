import {
  resolveOpenCodeCredentials,
  type OpenCodeAuthMode,
  type OpenCodeCatalog as OpenCodeCatalogKind,
  type OpenCodeCredential,
} from './auth';
import { createDirectEgress } from '../../network/egress/index';
import type { EgressTransport } from '../../network/egress/types';
import {
  classifyUpstreamFailure,
  CooldownRegistry,
  isInsufficientBalanceFailure,
  parseRetryAfter,
} from '../upstream-policy';
import {
  DEFAULT_MODEL_METADATA_URL,
  FREE_TIER_IP_COOLDOWN_MS,
  TRANSIENT_UPSTREAM_ATTEMPTS,
  TRANSIENT_UPSTREAM_BACKOFF_MS,
} from './constants';
import { freeTierIpLimitResponse, isOpenCodeFreeTierModel } from './errors';
import { waitForRetry } from './body';
import { withUpstreamCredential } from './http';
import { CatalogStore } from './catalog';
import type { OpenCodeProxyServerOptions } from './types';

export class OpenCodeRuntime {
  readonly authMode: OpenCodeAuthMode;
  readonly egress: EgressTransport;
  readonly sessionId: string;
  readonly catalog: CatalogStore;
  private cachedCreds?: OpenCodeCredential[];
  private readonly exhaustedCredentials = new Set<string>();
  private readonly cooldowns = new CooldownRegistry();

  get exhaustedCount(): number {
    return this.exhaustedCredentials.size;
  }

  constructor(
    private readonly opts: OpenCodeProxyServerOptions,
    private readonly log: (line: string) => void,
  ) {
    this.authMode = opts.authMode ?? 'auto';
    const forced = strip(opts.upstream);
    const zenBase = strip(opts.zenUpstream);
    const goBase = strip(opts.goUpstream);
    this.egress =
      opts.egress ??
      createDirectEgress([
        new URL(zenBase ?? 'https://opencode.ai/zen/v1').origin,
        new URL(goBase ?? 'https://opencode.ai/zen/go/v1').origin,
        ...(forced ? [new URL(forced).origin] : []),
        ...(opts.modelMetadataUrl === false
          ? []
          : [new URL(opts.modelMetadataUrl ?? DEFAULT_MODEL_METADATA_URL).origin]),
      ]);
    this.sessionId = `ocp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    this.catalog = new CatalogStore({
      egress: this.egress,
      authMode: this.authMode,
      forcedUpstream: forced,
      zenUpstream: zenBase,
      goUpstream: goBase,
      metadataUrl: opts.modelMetadataUrl,
      credential: () => this.credential(),
      log,
    });
  }

  async credentials(): Promise<OpenCodeCredential[]> {
    if (!this.cachedCreds) {
      this.cachedCreds = await resolveOpenCodeCredentials(
        [this.opts.authPath, ...(this.opts.authPaths ?? [])],
        this.authMode,
      );
    }
    return this.cachedCreds;
  }

  async credential(): Promise<OpenCodeCredential> {
    const ring = await this.credentials();
    return ring.find((candidate) => !this.exhaustedCredentials.has(candidate.apiKey)) ?? ring[0];
  }

  baseFor(catalog: OpenCodeCatalogKind): string {
    return this.catalog.baseFor(catalog);
  }

  async inferenceFetch(
    target: string,
    init: RequestInit,
    model: string,
    preferredCredential: OpenCodeCredential,
  ): Promise<Response> {
    const freeTierKey = `opencode:free-tier-ip:${this.egress.descriptor.id}`;
    if (isOpenCodeFreeTierModel(model)) {
      const remaining = this.cooldowns.remainingMs(freeTierKey);
      if (remaining > 0) {
        return freeTierIpLimitResponse(remaining);
      }
    }
    const ring = await this.credentials();
    const candidates = [preferredCredential, ...ring].filter(
      (candidate, index, all) =>
        !this.exhaustedCredentials.has(candidate.apiKey) &&
        all.findIndex((entry) => entry.apiKey === candidate.apiKey) === index,
    );
    if (candidates.length === 0) {
      candidates.push(preferredCredential);
    }

    let lastBalanceResponse: Response | undefined;
    // Keep the caller's generation budget intact. OpenCode and the native
    // clients compact their state from authoritative usage/overflow signals;
    // a stateless gateway must not silently rewrite max_tokens and pretend it
    // compacted a conversation it does not own.
    const requestInit = init;
    for (const candidate of candidates) {
      const key = `opencode:${model}:${this.authMode}:${candidate.service}:${this.egress.descriptor.id}`;
      const remaining = this.cooldowns.remainingMs(key);
      if (remaining > 0) {
        return coolingResponse(remaining);
      }
      let response: Response | undefined;
      const acceptsStream = new Headers(init.headers).get('accept')?.includes('text/event-stream');
      const attempts = acceptsStream ? TRANSIENT_UPSTREAM_ATTEMPTS : 1;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        response = await this.egress.fetch(
          target,
          withUpstreamCredential(requestInit, candidate.apiKey),
          {
            operation: 'inference',
          },
        );
        const transient = [500, 502, 503, 504].includes(response.status);
        if (!transient || attempt === attempts || requestInit.signal?.aborted) {
          break;
        }
        const fallback =
          TRANSIENT_UPSTREAM_BACKOFF_MS[attempt - 1] ?? TRANSIENT_UPSTREAM_BACKOFF_MS.at(-1)!;
        const delay = Math.min(
          2_000,
          parseRetryAfter(response.headers.get('retry-after')) ?? fallback,
        );
        this.log(
          `↻ upstream ${response.status} ${model}; retrying in ${delay}ms (${attempt}/${attempts - 1})`,
        );
        await response.body?.cancel().catch(() => {});
        await waitForRetry(delay, requestInit.signal);
      }
      if (!response) {
        throw new Error(`No upstream response for ${model}`);
      }
      if (response.status === 429) {
        const body = await response.arrayBuffer();
        const failure = classifyUpstreamFailure(
          response.status,
          response.headers,
          new TextDecoder().decode(body),
        );
        if (failure.retryAfterMs) {
          this.cooldowns.set(key, failure.retryAfterMs);
        }
        return new Response(body, { status: response.status, headers: response.headers });
      }
      if (response.status !== 402 && response.status !== 403) {
        return response;
      }
      const body = await response.arrayBuffer();
      const bodyText = new TextDecoder().decode(body);
      const replayable = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      if (!isInsufficientBalanceFailure(response.status, bodyText)) {
        return replayable;
      }
      if (isOpenCodeFreeTierModel(model)) {
        const retryAfter =
          parseRetryAfter(response.headers.get('retry-after')) ?? FREE_TIER_IP_COOLDOWN_MS;
        this.cooldowns.set(freeTierKey, retryAfter);
        return freeTierIpLimitResponse(retryAfter);
      }
      this.exhaustedCredentials.add(candidate.apiKey);
      lastBalanceResponse = replayable;
    }
    return lastBalanceResponse!;
  }
}

function coolingResponse(remaining: number): Response {
  return new Response(
    JSON.stringify({
      error: { type: 'rate_limit_error', message: 'Upstream route is cooling down.' },
    }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(Math.ceil(remaining / 1000)),
      },
    },
  );
}

function strip(value: string | undefined): string | undefined {
  return value?.replace(/\/$/, '');
}
