import { describe, expect, it } from 'vitest';

import {
  CLAUDE_MODEL_ROLES,
  defaultModelRolesForProxy,
  modelDefaultsForSuggestions,
  modelRolesForClient,
  modelRolesFromClientOptions,
  normalizeModelRoles,
  suggestModelsForProxyProvider,
} from '../src/clients/model-roles';
import { syntheticProxyProfile } from '../src/clients/isolation';
import { ProviderRegistry } from '../src/core/registry';
import { CatalogRegistry, registerBuiltinCatalog } from '../src/catalog/providers';
import { registerBuiltinProviders } from '../src/providers/index';
import { modelPolicyLookup } from '../src/core/model-policy';
import { filterModelSuggestions } from '../src/tui/screens/proxy-models';

/**
 * Model policy lives on the providers themselves, so these helpers take a
 * lookup resolved from the registries rather than consulting a central switch.
 */
const accountRegistry = new ProviderRegistry();
const catalog = new CatalogRegistry();
registerBuiltinProviders(accountRegistry);
registerBuiltinCatalog(catalog);
const policy = modelPolicyLookup({ accountRegistry, catalog });

describe('modelRolesForClient', () => {
  it('claude exposes default + sonnet/opus/haiku', () => {
    const roles = modelRolesForClient('claude');
    expect(roles.map((r) => r.id)).toEqual(['default', 'sonnet', 'opus', 'haiku']);
    expect(CLAUDE_MODEL_ROLES).toHaveLength(4);
  });

  it('codex and kiro expose default only', () => {
    expect(modelRolesForClient('codex').map((r) => r.id)).toEqual(['default']);
    expect(modelRolesForClient('kiro').map((r) => r.id)).toEqual(['default']);
  });
});

describe('defaultModelRolesForProxy', () => {
  it('does not pin Grok Claude roles to a release-specific model', () => {
    const m = defaultModelRolesForProxy('grok', 'claude', policy);
    expect(m).toEqual({});
  });

  it('does not pin the Grok Codex default', () => {
    const m = defaultModelRolesForProxy('grok', 'codex', policy);
    expect(m).toEqual({});
  });

  it('leaves Grok autocomplete to live proxy discovery', () => {
    const s = suggestModelsForProxyProvider('grok', policy);
    expect(s).toEqual([]);
  });
});

describe('modelDefaultsForSuggestions', () => {
  it('maps Gemini Claude roles to live pro/flash ids', () => {
    const result = modelDefaultsForSuggestions(
      'gemini',
      {
        default: 'gemini-3.1-pro',
        sonnet: 'stale',
        opus: 'stale',
        haiku: 'stale',
      },
      ['gemini-2.5-flash', 'gemini-2.5-pro'],
      policy,
    );
    expect(result).toEqual({
      default: 'gemini-2.5-pro',
      sonnet: 'gemini-2.5-flash',
      opus: 'gemini-2.5-pro',
      haiku: 'gemini-2.5-flash',
    });
  });
});

describe('normalizeModelRoles', () => {
  it('merges user overrides over defaults and drops empty', () => {
    const out = normalizeModelRoles(
      { sonnet: 'custom-sonnet', haiku: '  ' },
      { default: 'd', sonnet: 's', opus: 'o', haiku: 'h' },
    );
    expect(out).toEqual({
      default: 'd',
      sonnet: 'custom-sonnet',
      opus: 'o',
      haiku: 'h',
    });
  });

  it('reads modelRoles from clientOptions', () => {
    expect(
      modelRolesFromClientOptions({
        modelRoles: { default: 'grok-4.5', sonnet: 'x' },
      }),
    ).toEqual({ default: 'grok-4.5', sonnet: 'x' });
    expect(modelRolesFromClientOptions({})).toBeUndefined();
  });
});

describe('filterModelSuggestions', () => {
  it('ranks prefix matches first and caps results', () => {
    const all = [
      'claude-sonnet-5',
      'anthropic/claude-sonnet-5',
      'grok-4.5',
      'grok-4.3',
      'gpt-5.6-sol',
      'x-ai/grok-4.5',
    ];
    const grok = filterModelSuggestions(all, 'grok');
    expect(grok[0]).toMatch(/^grok/);
    expect(grok).toContain('grok-4.5');
    expect(filterModelSuggestions(all, 'sonnet')[0]).toContain('sonnet');
    expect(filterModelSuggestions(all, '').length).toBeLessThanOrEqual(9);
  });

  it('keeps the newest generation on top rather than sorting alphabetically', () => {
    // The list arrives newest-first, and enter picks whatever is highlighted, so
    // alphabetical order within a tier would hand the user claude-opus-4-6.
    const all = ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6'];
    expect(filterModelSuggestions(all, 'claude-op')[0]).toBe('claude-opus-5');
    expect(filterModelSuggestions(all, 'opus')[0]).toBe('claude-opus-5');
    expect(filterModelSuggestions(all, '')[0]).toBe('claude-opus-5');
  });

  it('still puts bare ids ahead of gateway-prefixed aliases', () => {
    const all = ['anthropic/claude-sonnet-5', 'claude-sonnet-5'];
    expect(filterModelSuggestions(all, '')[0]).toBe('claude-sonnet-5');
  });
});

describe('syntheticProxyProfile roles', () => {
  it('fills RuntimeProfile role fields from modelRoles', () => {
    const p = syntheticProxyProfile({
      name: 'proxy:grok/work',
      endpoint: 'http://127.0.0.1:8080',
      modelRoles: {
        default: 'grok-4.5',
        sonnet: 'grok-4.5',
        opus: 'grok-4.5',
        haiku: 'grok-4.3',
      },
    });
    expect(p.meta.defaultModel).toBe('grok-4.5');
    expect(p.meta.sonnetModel).toBe('grok-4.5');
    expect(p.meta.opusModel).toBe('grok-4.5');
    expect(p.meta.haikuModel).toBe('grok-4.3');
  });
});
