import { describe, expect, it } from 'vitest';
import {
  assignDesktopAliases,
  desktopAwareRouteModels,
  desktopConfigModelId,
  expandHubRoutesWithDesktopAliases,
  FALLBACK_NATIVE_LIST_SLUGS,
  orderHubModelsForDesktop,
} from '../src/clients/codex-desktop-catalog';
import type { ProxyHubRouteTarget } from '../src/types';

describe('codex desktop catalog aliases', () => {
  const slots = FALLBACK_NATIVE_LIST_SLUGS.map((slug) => ({ slug }));

  it('prefers the selected hub model for the first native slot', () => {
    const ordered = orderHubModelsForDesktop(
      ['claude-sonnet-4', 'big-pickle', 'gemini-3-flash'],
      'big-pickle',
    );
    expect(ordered[0]).toBe('big-pickle');
    expect(ordered).toEqual(['big-pickle', 'claude-sonnet-4', 'gemini-3-flash']);
  });

  it('pins Default + List 2–5 before the rest of the hub catalog', () => {
    const ordered = orderHubModelsForDesktop(
      ['claude-sonnet-4', 'big-pickle', 'gemini-3-flash', 'extra'],
      ['big-pickle', 'gemini-3-flash', 'claude-sonnet-4'],
    );
    expect(ordered).toEqual(['big-pickle', 'gemini-3-flash', 'claude-sonnet-4', 'extra']);
  });

  it('maps non-GPT hub models onto native GPT slots even when hub also lists gpt-*', () => {
    const aliases = assignDesktopAliases(
      [
        'big-pickle',
        'gpt-5.6-sol', // real hub gpt route — not used as an alias *target*
        'claude-sonnet-4',
        'gemini-3-flash',
      ],
      slots,
    );
    expect(aliases).toEqual([
      { nativeSlug: 'gpt-5.6-sol', hubModel: 'big-pickle' },
      { nativeSlug: 'gpt-5.6-terra', hubModel: 'claude-sonnet-4' },
      { nativeSlug: 'gpt-5.6-luna', hubModel: 'gemini-3-flash' },
    ]);
  });

  it('expands hub routes so Desktop GPT slugs rewrite via upstreamModel', () => {
    const routes: ProxyHubRouteTarget[] = [
      {
        model: 'big-pickle',
        source: { kind: 'account', provider: 'opencode', name: 'default' },
        upstreamModel: 'big-pickle',
      },
      {
        model: 'claude-sonnet-4',
        source: { kind: 'account', provider: 'opencode', name: 'default' },
        upstreamModel: 'claude-sonnet-4',
      },
      {
        model: 'gpt-5.6-sol',
        source: { kind: 'account', provider: 'opencode', name: 'default' },
        upstreamModel: 'gpt-5.6-sol',
      },
    ];
    const aliases = assignDesktopAliases(['big-pickle', 'claude-sonnet-4'], slots.slice(0, 2));
    const expanded = expandHubRoutesWithDesktopAliases(routes, aliases);
    expect(expanded.find((route) => route.model === 'gpt-5.6-sol')).toMatchObject({
      model: 'gpt-5.6-sol',
      upstreamModel: 'big-pickle',
      source: { kind: 'account', provider: 'opencode', name: 'default' },
    });
    expect(expanded.find((route) => route.model === 'gpt-5.6-terra')).toMatchObject({
      upstreamModel: 'claude-sonnet-4',
    });
  });

  it('builds catalog entries with native slugs and Hub display names', () => {
    const slotsWithReasoning = [
      {
        slug: 'gpt-5.6-sol',
        template: {
          slug: 'gpt-5.6-sol',
          default_reasoning_level: 'medium',
          support_verbosity: true,
          supported_reasoning_levels: [
            { effort: 'low', description: 'Fast' },
            { effort: 'medium', description: 'Balanced' },
            { effort: 'high', description: 'Deep' },
            { effort: 'ultra', description: 'Max' },
          ],
        },
      },
    ];
    const aliases = assignDesktopAliases(['big-pickle'], slotsWithReasoning);
    const models = desktopAwareRouteModels(
      [
        { slug: 'big-pickle', displayName: 'big-pickle' },
        { slug: 'gpt-5.6-sol', displayName: 'gpt-5.6-sol' },
      ],
      aliases,
      slotsWithReasoning,
    );
    expect(models[0]).toMatchObject({
      slug: 'gpt-5.6-sol',
      displayName: 'big-pickle · Hub',
      defaultReasoningLevel: 'medium',
      supportsVerbosity: true,
    });
    expect(models[0]?.supportedReasoningLevels?.map((level) => level.effort)).toEqual([
      'low',
      'medium',
      'high',
      'ultra',
    ]);
    // Real hub gpt row is dropped when the alias claimed that slug.
    expect(models.filter((model) => model.slug === 'gpt-5.6-sol')).toHaveLength(1);
    expect(models.some((model) => model.slug === 'big-pickle')).toBe(true);
  });

  it('picks the native slug for config model so Desktop highlights the selection', () => {
    const aliases = assignDesktopAliases(['big-pickle', 'claude-sonnet-4'], slots.slice(0, 2));
    expect(desktopConfigModelId('claude-sonnet-4', aliases)).toBe('gpt-5.6-terra');
    expect(desktopConfigModelId(undefined, aliases)).toBe('gpt-5.6-sol');
  });
});
