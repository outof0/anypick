import { describe, expect, it } from 'vitest';

import {
  accountFromSource,
  backupImportEntryIDs,
  clearLiveLogin,
  createGateway,
  detectAccount,
  editAccount,
  editGateway,
  exportBackup,
  forgetBackup,
  gatewayConnectInvokes,
  gatewayConnectRoutes,
  gatewayFromSource,
  importBackup,
  languageChange,
  loginAccount,
  missingCodexProfileSources,
  refreshGateway,
  refreshModels,
  openCodexProfile,
  removeCodexProfile,
  removeGateway,
  resetClient,
  saveCodexProfile,
  saveCredentialInput,
  savePastedAuth,
  settingChange,
  syncCodexProfiles,
  testGateway,
  updateCodexProfile,
  validCodexProfileName,
} from '../lib/desktop-actions';
import type { Snapshot } from '../lib/contract';

describe('desktop actions', () => {
  it('detects a live login with the sentinel name the engine requires', () => {
    expect(detectAccount('claude', 'cli')).toEqual({
      operation: 'account-detect',
      extra: { name: 'detect', providerId: 'claude', sourceId: 'cli' },
    });
    expect(detectAccount('claude')).toEqual({
      operation: 'account-detect',
      extra: { name: 'detect', providerId: 'claude' },
    });
  });

  it('signs in with the chosen method and omits a blank name', () => {
    expect(loginAccount({ providerId: 'claude', methodId: 'subscription', name: '  ' })).toEqual({
      operation: 'account-login',
      extra: { providerId: 'claude', methodId: 'subscription' },
    });
  });

  it('sends pasted auth as a path and omits a blank name', () => {
    expect(
      savePastedAuth({
        providerId: 'codex',
        name: '  ',
        path: '/tmp/anypick-auth-paste/a.json',
      }),
    ).toEqual({
      operation: 'account-save-auth',
      extra: { providerId: 'codex', path: '/tmp/anypick-auth-paste/a.json' },
    });
    expect(
      savePastedAuth({
        providerId: 'codex',
        name: 'work',
        path: '/tmp/anypick-auth-paste/a.json',
        overwrite: true,
      }),
    ).toEqual({
      operation: 'account-save-auth',
      extra: {
        providerId: 'codex',
        name: 'work',
        path: '/tmp/anypick-auth-paste/a.json',
        overwrite: true,
      },
    });
  });

  it('saves a typed credential with its kind', () => {
    expect(
      saveCredentialInput({
        providerId: 'grok',
        name: 'work',
        kind: 'api-key',
        apiKey: 'sk-test',
        profile: '',
      }),
    ).toEqual({
      operation: 'account-save-input',
      extra: { providerId: 'grok', name: 'work', kind: 'api-key', apiKey: 'sk-test' },
    });
  });

  it('keeps an empty label on edit so the engine can clear it', () => {
    expect(editAccount({ providerId: 'claude', name: 'work' }, '')).toEqual({
      operation: 'account-edit',
      extra: { providerId: 'claude', name: 'work', label: '' },
    });
  });

  it('clears a live login under the sentinel name', () => {
    expect(clearLiveLogin('claude', 'cli')).toEqual({
      operation: 'account-clear',
      extra: { name: 'live', providerId: 'claude', sourceId: 'cli' },
    });
  });

  it('creates a gateway with the provider id and only the fields the user filled', () => {
    expect(
      createGateway({
        providerId: 'openrouter',
        name: 'team',
        endpoint: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-test',
        label: '',
        defaultModel: '',
      }),
    ).toEqual({
      operation: 'gateway-create',
      extra: {
        providerId: 'openrouter',
        name: 'team',
        endpoint: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-test',
      },
    });
  });

  it('tests, edits, refreshes, and removes a gateway by the fields the handler reads', () => {
    expect(testGateway({ providerId: 'openrouter', endpoint: 'https://example.test', apiKey: 'sk-test' })).toEqual({
      operation: 'gateway-test',
      extra: { name: 'test', providerId: 'openrouter', endpoint: 'https://example.test', apiKey: 'sk-test' },
    });
    expect(editGateway('team', 'Team')).toEqual({
      operation: 'gateway-edit',
      extra: { name: 'team', label: 'Team' },
    });
    expect(refreshGateway('team')).toEqual({
      operation: 'gateway-refresh',
      extra: { name: 'team' },
    });
    expect(removeGateway('team', 'openrouter')).toEqual({
      operation: 'gateway-remove',
      extra: { name: 'team', providerId: 'openrouter' },
    });
  });

  it('exports the selected accounts and requires the overwrite flag', () => {
    expect(
      exportBackup('/tmp/accounts.anypick-backup', [{ provider: 'claude', name: 'work' }], false),
    ).toEqual({
      operation: 'account-backup-export',
      extra: {
        path: '/tmp/accounts.anypick-backup',
        accounts: [{ provider: 'claude', name: 'work' }],
        overwrite: false,
      },
    });
  });

  it('imports only the entries that would change', () => {
    expect(
      backupImportEntryIDs(['b', 'a', 'c'], { a: 'new', b: 'replace', c: 'new' }, false),
    ).toEqual(['a', 'c']);
    expect(
      backupImportEntryIDs(['b', 'a'], { a: 'new', b: 'replace' }, true),
    ).toEqual(['a', 'b']);
    expect(
      importBackup('insp-1', ['a'], true),
    ).toEqual({
      operation: 'account-backup-import',
      extra: { inspectionId: 'insp-1', entryIds: ['a'], overwriteConfirmed: true },
    });
    expect(forgetBackup('insp-1')).toEqual({
      operation: 'account-backup-forget',
      extra: { inspectionId: 'insp-1' },
    });
  });

  it('refreshes models from the selected route source', () => {
    expect(accountFromSource('account/claude/work')).toEqual({ provider: 'claude', name: 'work' });
    expect(gatewayFromSource('gateway/or-work')).toBe('or-work');
    expect(refreshModels('account/claude/work')).toEqual({
      operation: 'account-refresh',
      extra: { providerId: 'claude', name: 'work' },
    });
    expect(refreshModels('gateway/or-work')).toEqual({
      operation: 'gateway-refresh',
      extra: { name: 'or-work' },
    });
    expect(refreshModels('claude')).toBeNull();
  });

  it('resets a client and edits Codex profiles with the engine field names', () => {
    expect(resetClient('codex')).toEqual({
      operation: 'client-reset',
      extra: { name: 'codex', providerId: 'codex' },
    });
    expect(validCodexProfileName('work_1')).toBe(true);
    expect(validCodexProfileName('has space')).toBe(false);
    expect(saveCodexProfile({ name: 'work', sourceId: 'account/codex/work', modelId: '', transportPolicy: 'proxy' })).toEqual({
      operation: 'codex-profile-save',
      extra: { name: 'work', sourceId: 'account/codex/work', transportPolicy: 'proxy' },
    });
    expect(updateCodexProfile({ name: 'work', sourceId: 'account/codex/work', modelId: 'gpt-5', transportPolicy: 'auto' })).toEqual({
      operation: 'codex-profile-update',
      extra: { name: 'work', sourceId: 'account/codex/work', defaultModel: 'gpt-5', transportPolicy: 'auto' },
    });
    expect(removeCodexProfile('work')).toEqual({
      operation: 'codex-profile-remove',
      extra: { name: 'work' },
    });
    expect(openCodexProfile('work')).toEqual({
      operation: 'codex-profile-open',
      extra: { name: 'work' },
    });
    expect(syncCodexProfiles(['account/codex/work'])).toEqual({
      operation: 'codex-profile-sync',
      extra: { sourceIds: ['account/codex/work'] },
    });
  });

  it('sends a settings change with the sentinel name and the new boolean', () => {
    expect(settingChange('setting-show-quota', false)).toEqual({
      operation: 'setting-show-quota',
      extra: { name: 'settings', enabled: false },
    });
  });

  it('sends a language preference with the settings sentinel', () => {
    expect(languageChange('vi')).toEqual({
      operation: 'setting-language',
      extra: { name: 'settings', language: 'vi' },
    });
  });

  it('lists Codex account sources that do not have a profile yet', () => {
    const snapshot = {
      codexProfiles: [{ sourceId: 'account/codex/work' }],
      codexProfileSources: [
        { sourceId: 'account/codex/work', kind: 'account' },
        { sourceId: 'account/codex/personal', kind: 'account' },
        { sourceId: 'gateway/team', kind: 'gateway' },
      ],
    } as unknown as Snapshot;
    expect(missingCodexProfileSources(snapshot)).toEqual(['account/codex/personal']);
  });

  it('connects only the apps whose route source is this gateway', () => {
    const snapshot = {
      actions: [
        {
          id: 'use-team',
          clientId: 'claude',
          sourceId: 'gateway/team',
          client: 'Claude Code',
          kind: 'gateway',
          selected: false,
          enabled: true,
        },
        {
          id: 'use-other',
          clientId: 'codex',
          sourceId: 'gateway/other',
          client: 'Codex',
          kind: 'gateway',
          selected: false,
          enabled: true,
        },
        {
          id: 'native-claude',
          clientId: 'claude',
          sourceId: 'account/claude/work',
          client: 'Claude Code',
          kind: 'native',
          selected: true,
          enabled: true,
        },
        {
          id: 'using-team',
          clientId: 'opencode',
          sourceId: 'gateway/team',
          client: 'OpenCode',
          kind: 'gateway',
          selected: true,
          enabled: true,
        },
        {
          id: 'native-opencode',
          clientId: 'opencode',
          sourceId: 'account/opencode/work',
          client: 'OpenCode',
          kind: 'native',
          selected: false,
          enabled: true,
        },
      ],
    } as unknown as Snapshot;
    expect(gatewayConnectRoutes(snapshot, 'team').map((route) => route.clientId)).toEqual(['claude', 'opencode']);
    expect(gatewayConnectInvokes(snapshot, 'team', ['claude'])).toEqual(['use-team', 'native-opencode']);
    expect(gatewayConnectInvokes(snapshot, 'team', ['claude', 'opencode'])).toEqual(['use-team']);
  });
});
