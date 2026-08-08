import { describe, expect, it } from 'vitest';
import {
  classifyUpstreamFailure,
  CooldownRegistry,
  isInsufficientBalanceFailure,
  isCredentialQuotaFailure,
  parseRetryAfter,
} from '../src/providers/upstream-policy';

describe('upstream policy', () => {
  it('parses seconds and HTTP dates without clamping', () => {
    expect(parseRetryAfter('10', 1000)).toBe(10000);
    expect(parseRetryAfter(new Date(61000).toUTCString(), 1000)).toBe(60000);
    expect(parseRetryAfter('-1', 1000)).toBeUndefined();
  });
  it('does not infer scope from a generic 429', () => {
    expect(classifyUpstreamFailure(429, new Headers(), 'rate limited').scope).toBe('unknown');
    expect(classifyUpstreamFailure(429, new Headers(), 'FreeUsageLimitError for IP').scope).toBe(
      'ip',
    );
  });
  it('distinguishes billing exhaustion from a generic forbidden response', () => {
    expect(
      isInsufficientBalanceFailure(
        403,
        '{"error":{"message":"Sorry, your account balance is insufficient"}}',
      ),
    ).toBe(true);
    expect(isInsufficientBalanceFailure(403, 'model is not allowed for this account')).toBe(false);
    expect(isInsufficientBalanceFailure(429, 'account balance is insufficient')).toBe(false);
  });
  it('allows account failover only for an explicit credential quota signal', () => {
    expect(
      isCredentialQuotaFailure(
        429,
        new Headers(),
        '{"error":{"status":"RESOURCE_EXHAUSTED","message":"API key quota exceeded"}}',
      ),
    ).toBe(true);
    expect(
      isCredentialQuotaFailure(403, new Headers(), 'Your account balance is insufficient.'),
    ).toBe(true);
    expect(isCredentialQuotaFailure(429, new Headers(), 'Too many requests')).toBe(false);
    expect(
      isCredentialQuotaFailure(429, new Headers(), 'FreeUsageLimitError: IP address exceeded'),
    ).toBe(false);
  });
  it('tracks an injected cooldown clock', () => {
    let now = 100;
    const registry = new CooldownRegistry(() => now);
    registry.set('route', 5000);
    expect(registry.remainingMs('route')).toBe(5000);
    now += 5001;
    expect(registry.remainingMs('route')).toBe(0);
  });
});
