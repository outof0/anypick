import { describe, it, expect } from 'vitest';
import {
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  GROK_MODELS,
  OPENROUTER_MODELS,
  CatalogRegistry,
  registerBuiltinCatalog,
} from '../src/catalog/providers';

describe('catalog model suggestions (2026)', () => {
  it('anthropic aliases point at current GA models', () => {
    expect(ANTHROPIC_MODELS['claude-sonnet']).toBe('claude-sonnet-5');
    expect(ANTHROPIC_MODELS['claude-opus']).toBe('claude-opus-5');
    expect(ANTHROPIC_MODELS['claude-haiku']).toBe('claude-haiku-4-5');
    expect(ANTHROPIC_MODELS['claude-fable']).toBe('claude-fable-5');
  });

  it('openai aliases point at GPT-5.6 family', () => {
    expect(OPENAI_MODELS.gpt).toBe('gpt-5.6-sol');
    expect(OPENAI_MODELS['gpt-5']).toBe('gpt-5.6-sol');
    expect(OPENAI_MODELS['gpt-balanced']).toBe('gpt-5.6-terra');
    expect(OPENAI_MODELS['gpt-fast']).toBe('gpt-5.6-luna');
    expect(OPENAI_MODELS['gpt-codex']).toBe('gpt-5.3-codex');
  });

  it('grok aliases point at Grok 4.5 / 4.3 / 4.20', () => {
    expect(GROK_MODELS.grok).toBe('grok-4.5');
    expect(GROK_MODELS['grok-4.5']).toBe('grok-4.5');
    expect(GROK_MODELS['grok-4.3']).toBe('grok-4.3');
    expect(GROK_MODELS['grok-4.20']).toBe('grok-4.20-0309-reasoning');
  });

  it('openrouter uses prefixed gateway IDs', () => {
    expect(OPENROUTER_MODELS['claude-sonnet']).toBe('anthropic/claude-sonnet-5');
    expect(OPENROUTER_MODELS['claude-opus']).toBe('anthropic/claude-opus-5');
    expect(OPENROUTER_MODELS.gpt).toBe('openai/gpt-5.6-sol');
    expect(OPENROUTER_MODELS.grok).toBe('x-ai/grok-4.5');
  });

  it('profile create gets suggested models from catalog', () => {
    const reg = new CatalogRegistry();
    registerBuiltinCatalog(reg);
    const or = reg.get('openrouter').suggestModels?.() ?? {};
    expect(or['claude-sonnet']).toBe('anthropic/claude-sonnet-5');
    expect(or['claude-fable']).toBe('anthropic/claude-fable-5');
    expect(Object.keys(or).length).toBeGreaterThan(8);
  });
});
