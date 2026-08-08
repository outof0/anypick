import { describe, expect, it } from 'vitest';
import { CLAUDE_MODEL_ROLES } from '../src/clients/model-roles';
import { resolveTrayModelRoleActions } from '../src/tray/model-role-actions';
import type { TrayActionTarget, TrayProxyActionTarget } from '../src/tray/snapshot-types';

const client = {
  id: 'claude',
  modelRoles: () => CLAUDE_MODEL_ROLES,
};

function targets(
  entries: Array<[string, TrayActionTarget | TrayProxyActionTarget]>,
): ReadonlyMap<string, TrayActionTarget | TrayProxyActionTarget> {
  return new Map(entries);
}

describe('Tray model-role actions', () => {
  it('resolves four opaque model actions on one Hub source', () => {
    const selection = resolveTrayModelRoleActions(
      client,
      targets([
        ['default-action', { clientId: 'claude', source: 'hub/default', model: 'gemini-pro' }],
        ['sonnet-action', { clientId: 'claude', source: 'hub/default', model: 'gemini-flash' }],
        ['opus-action', { clientId: 'claude', source: 'hub/default', model: 'grok-heavy' }],
        ['haiku-action', { clientId: 'claude', source: 'hub/default', model: 'grok-fast' }],
      ]),
      'claude',
      {
        default: 'default-action',
        sonnet: 'sonnet-action',
        opus: 'opus-action',
        haiku: 'haiku-action',
      },
    );

    expect(selection).toEqual({
      source: 'hub/default',
      defaultModel: 'gemini-pro',
      modelRoles: {
        default: 'gemini-pro',
        sonnet: 'gemini-flash',
        opus: 'grok-heavy',
        haiku: 'grok-fast',
      },
    });
  });

  it('keeps optional roles absent so the client inherits Default', () => {
    expect(
      resolveTrayModelRoleActions(
        client,
        targets([
          ['default-action', { clientId: 'claude', source: 'hub/default', model: 'gemini-pro' }],
        ]),
        'claude',
        { default: 'default-action' },
      ),
    ).toEqual({
      source: 'hub/default',
      defaultModel: 'gemini-pro',
      modelRoles: { default: 'gemini-pro' },
    });
  });

  it('rejects stale, cross-client, cross-source, model-less, and unknown-role actions', () => {
    const actionTargets = targets([
      ['default-action', { clientId: 'claude', source: 'hub/default', model: 'gemini-pro' }],
      ['codex-action', { clientId: 'codex', source: 'hub/default', model: 'gpt-5' }],
      ['gateway-action', { clientId: 'claude', source: 'gateway/work', model: 'grok-fast' }],
      ['native-action', { clientId: 'claude', source: 'claude/work' }],
      ['proxy-action', { operation: 'hub-test', name: 'default' }],
    ]);

    const invalidSelections: Array<Record<string, string>> = [
      { default: 'missing' },
      { default: 'codex-action' },
      { default: 'default-action', sonnet: 'gateway-action' },
      { default: 'native-action' },
      { default: 'proxy-action' },
      { default: 'default-action', futureRole: 'default-action' },
    ];
    for (const roleActionIds of invalidSelections) {
      expect(() =>
        resolveTrayModelRoleActions(client, actionTargets, 'claude', roleActionIds),
      ).toThrow();
    }
  });
});
