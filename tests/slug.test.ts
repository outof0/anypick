import { describe, it, expect } from 'vitest';
import {
  normalizeAccountName,
  normalizeProfileName,
  displayLabelFromName,
} from '../src/utils/slug';

describe('normalizeSlug (auto-slugify)', () => {
  it('normalizes case and trims', () => {
    expect(normalizeAccountName(' Work ')).toBe('work');
  });

  it('allows dots, underscores, hyphens', () => {
    expect(normalizeAccountName('alice.work-01')).toBe('alice.work-01');
  });

  it('slugifies human-friendly names instead of rejecting them', () => {
    expect(normalizeProfileName('Kiro Key - 1k')).toBe('kiro-key-1k');
    expect(normalizeProfileName('OpenRouter Work')).toBe('openrouter-work');
    expect(normalizeProfileName('  My   API  ')).toBe('my-api');
    expect(normalizeAccountName('Team (Prod)')).toBe('team-prod');
  });

  it('strips path tricks safely', () => {
    expect(normalizeAccountName('../etc')).toBe('etc');
    expect(normalizeAccountName('foo/bar')).toBe('foo-bar');
  });

  it('rejects empty / unusable input', () => {
    expect(() => normalizeAccountName('')).toThrow();
    expect(() => normalizeAccountName('   ')).toThrow();
    expect(() => normalizeAccountName('---')).toThrow();
  });

  it('preserves display label when different from slug', () => {
    const slug = normalizeProfileName('Kiro Key - 1k');
    expect(displayLabelFromName('Kiro Key - 1k', slug)).toBe('Kiro Key - 1k');
    expect(displayLabelFromName('work', 'work')).toBeUndefined();
  });
});
