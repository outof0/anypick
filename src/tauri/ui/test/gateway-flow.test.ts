import { describe, expect, it } from 'vitest';

import type { AccountRow, GatewayProviderRow } from '../lib/contract';
import {
  TEST_LABEL,
  connectionFooter,
  connectionTestEnabled,
  gatewayCanSave,
  providerSuppliesEndpoint,
  requiresApiKey,
  resolvedEndpoint,
  suggestedGatewayName,
  usesCustomEndpoint,
} from '../lib/gateway-flow';

/**
 * The Add API Gateway sheet's rules, tested without a webview.
 *
 * The sheet this replaces showed a name, a key, an account id, a gateway id and
 * a URL for every provider, and disabled Save until all five were filled in.
 * What a gateway needs differs per provider; these rules are what let the sheet
 * ask for one shape instead of all of them.
 */

function provider(overrides: Partial<GatewayProviderRow> = {}): GatewayProviderRow {
  return { id: 'openrouter', label: 'OpenRouter', detail: 'Multi-model API gateway', requiresApiKey: true, ...overrides };
}

function account(name: string): AccountRow {
  return {
    id: `account/claude/${name}`,
    providerId: 'claude',
    name,
    label: name,
    detail: name,
    active: false,
    canRefresh: true,
    switchActionId: `switch-${name}`,
  };
}

describe('what shape a gateway takes', () => {
  const hosted = provider({ defaultEndpoint: 'https://openrouter.ai/api/v1', providesEndpoint: true });
  const custom = provider({ id: 'litellm', label: 'LiteLLM', kind: 'custom' });
  const accountDerived = provider({
    id: 'cloudflare-aigateway',
    label: 'Cloudflare AI Gateway',
    requiresAccountId: true,
    requiresGatewayId: true,
  });

  it('asks for a URL only from a provider that publishes none', () => {
    expect(usesCustomEndpoint(custom)).toBe(true);
    expect(usesCustomEndpoint(hosted)).toBe(false);
  });

  it('never asks for a URL the engine derives from the account id', () => {
    // It publishes no default endpoint, but the URL is built from the account
    // id — a field here would ask for a value the engine ignores.
    expect(providerSuppliesEndpoint(accountDerived)).toBe(false);
    expect(usesCustomEndpoint(accountDerived)).toBe(false);
  });

  it('exempts Grok from the key, because it reads a local login', () => {
    expect(requiresApiKey(provider({ id: 'grok', requiresApiKey: true }))).toBe(false);
    expect(requiresApiKey(provider({ id: 'gemini' }))).toBe(true);
    // An unlisted provider is treated as needing one: failing closed asks for a
    // key rather than saving a gateway that cannot authenticate.
    expect(requiresApiKey(undefined)).toBe(true);
  });

  it('sends the provider own endpoint rather than the typed one', () => {
    expect(resolvedEndpoint(hosted, 'https://elsewhere.example')).toBe('https://openrouter.ai/api/v1');
    expect(resolvedEndpoint(custom, 'https://elsewhere.example')).toBe('https://elsewhere.example');
  });
});

describe('when Add Gateway is enabled', () => {
  const base = {
    provider: provider(),
    name: 'Production',
    apiKey: 'sk-test',
    accountId: '',
    endpoint: 'https://openrouter.ai/api/v1',
    busy: false,
  };

  it('needs a name', () => {
    expect(gatewayCanSave({ ...base, name: '  ' })).toBe(false);
  });

  it('needs a key when the provider takes one', () => {
    expect(gatewayCanSave({ ...base, apiKey: ' ' })).toBe(false);
  });

  it('needs a URL only when the provider publishes none', () => {
    const custom = { ...base, provider: provider({ id: 'litellm', kind: 'custom' }), endpoint: '' };
    expect(gatewayCanSave(custom)).toBe(false);
    expect(
      gatewayCanSave({
        ...base,
        provider: provider({ defaultEndpoint: 'https://api.openai.com/v1', providesEndpoint: true }),
        endpoint: '',
      }),
    ).toBe(true);
  });

  it('needs the account id the endpoint is derived from', () => {
    const cloudflare = {
      ...base,
      provider: provider({ id: 'cloudflare-aigateway', requiresAccountId: true }),
      accountId: '',
    };
    expect(gatewayCanSave(cloudflare)).toBe(false);
    expect(gatewayCanSave({ ...cloudflare, accountId: 'acct-1' })).toBe(true);
  });

  it('never needs an account id from a provider that does not use one', () => {
    expect(gatewayCanSave(base)).toBe(true);
  });

  it('refuses while the engine is busy', () => {
    expect(gatewayCanSave({ ...base, busy: true })).toBe(false);
  });

  it('refuses with no provider', () => {
    expect(gatewayCanSave({ ...base, provider: undefined })).toBe(false);
  });
});

describe('when Test Connection is enabled', () => {
  const base = { provider: provider(), apiKey: 'sk-test', accountId: '', busy: false };

  it('needs what the request will carry', () => {
    expect(connectionTestEnabled(base)).toBe(true);
    expect(connectionTestEnabled({ ...base, apiKey: '' })).toBe(false);
    expect(connectionTestEnabled({ ...base, busy: true })).toBe(false);
  });

  it('needs no key for a provider that reads a local login', () => {
    expect(connectionTestEnabled({ ...base, provider: provider({ id: 'grok' }), apiKey: '' })).toBe(true);
  });

  it('needs the account id when the endpoint is derived from it', () => {
    expect(
      connectionTestEnabled({
        ...base,
        provider: provider({ id: 'cloudflare-aigateway', requiresAccountId: true }),
        accountId: '',
      }),
    ).toBe(false);
  });
});

describe('the suggested name', () => {
  it('is Production for a provider that supplies its own endpoint', () => {
    expect(suggestedGatewayName([], 'OpenRouter', false)).toBe('Production');
  });

  it('is the provider name for one that needs a typed URL', () => {
    // "My Gateway" is macOS's prompt for that case; the label is at least as
    // honest and needs no lookup.
    expect(suggestedGatewayName([], 'LiteLLM', true)).toBe('LiteLLM');
  });

  it('is not a name already taken', () => {
    expect(suggestedGatewayName([account('Production')], 'OpenRouter', false)).toBe('OpenRouter 2');
    expect(suggestedGatewayName([account('Production'), account('OpenRouter 2')], 'OpenRouter', false)).toBe(
      'OpenRouter 3',
    );
  });

  it('compares case-insensitively', () => {
    expect(suggestedGatewayName([account('production')], 'OpenRouter', false)).toBe('OpenRouter 2');
  });
});

describe('the connection footer', () => {
  const hosted = provider({ defaultEndpoint: 'https://openrouter.ai/api/v1', providesEndpoint: true });
  const custom = provider({ id: 'litellm', kind: 'custom' });
  const cloudflare = provider({ id: 'cloudflare-aigateway', requiresAccountId: true });
  const base = { message: '', endpoint: '', busy: false };

  it('says what is being contacted while testing', () => {
    expect(
      connectionFooter({ ...base, state: 'testing', provider: hosted, endpoint: 'ignored' }),
    ).toBe('Contacting https://openrouter.ai/api/v1…');
    expect(connectionFooter({ ...base, state: 'testing', provider: custom, endpoint: 'http://127.0.0.1:4000' })).toBe(
      'Contacting http://127.0.0.1:4000…',
    );
  });

  it('reports success with the engine own sentence when it gave one', () => {
    expect(
      connectionFooter({ ...base, state: 'available', provider: hosted, message: '200 OK, 42 models.' }),
    ).toBe('200 OK, 42 models.');
  });

  it('says something useful when the engine gave no sentence', () => {
    expect(connectionFooter({ ...base, state: 'available', provider: hosted })).toContain('Connected successfully');
    expect(connectionFooter({ ...base, state: 'unavailable', provider: hosted })).toContain(
      'Could not connect',
    );
  });

  it('explains the untested shape instead of sitting blank', () => {
    expect(connectionFooter({ ...base, state: 'untested', provider: cloudflare })).toContain(
      'derived from your Account ID',
    );
    expect(connectionFooter({ ...base, state: 'untested', provider: hosted })).toContain('supplies the endpoint');
    expect(connectionFooter({ ...base, state: 'untested', provider: custom })).toContain('detects the API format');
  });
});

describe('the test button label', () => {
  it('offers a retry that reads as a retry', () => {
    expect(TEST_LABEL.untested).toBe('Test Connection');
    expect(TEST_LABEL.available).toBe('Test Again');
    expect(TEST_LABEL.unavailable).toBe('Try Again');
  });
});