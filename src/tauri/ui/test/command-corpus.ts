/**
 * Every command shape the UI can send, built by the same code the panes call.
 *
 * `command-contract.test.ts` writes these to
 * `src/go/testdata/parity/ui-commands.json`, and the Go engine's own decoder
 * must accept every entry (`internal/desktop/ui_command_corpus_test.go`). The
 * fake bridge refuses any line whose shape is not in that file, so a click in a
 * UI test that sends something these cases do not cover fails where it is sent.
 *
 * Cover each optional field both present and absent when the builder can emit
 * either: the engine's allowlists are per key, and an absent key and an empty
 * one are validated differently.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { HubSource } from '../lib/contract';
import * as actions from '../lib/desktop-actions';
import type { DesktopAction } from '../lib/desktop-actions';
import {
  backupInspectCommand,
  cancelCommand,
  doctorCommand,
  invokeCommand,
  logsCommand,
  modelRolesCommand,
  mutateCommand,
} from '../lib/wire';

export const CORPUS_PATH = resolve(__dirname, '../../../go/testdata/parity/ui-commands.json');

/** The fixed id every corpus line carries, so the golden is stable. */
export const CORPUS_REQUEST_ID = 'corpus';

export type CorpusCase = {
  /** Which builder produced it; also the golden's sort key. */
  builder: string;
  name: string;
  line: string;
};

function mutate(builder: string, name: string, action: DesktopAction | null): CorpusCase {
  if (!action) throw new Error(`${builder}/${name} built no action`);
  return { builder, name, line: mutateCommand(action.operation, action.extra, CORPUS_REQUEST_ID) };
}

const accountSource = {
  id: 'hub/default/claude/work',
  providerId: 'claude',
  name: 'work',
  label: 'Work',
  detail: '',
  enabled: true,
  hub: 'default',
} as HubSource;
const poolSource = { ...accountSource, name: 'pool:claude', poolSource: true } as HubSource;
const rotationSource = { ...accountSource, name: 'rotation', rotates: true } as unknown as HubSource;

export const MUTATE_CASES: CorpusCase[] = [
  mutate('detectAccount', 'with source', actions.detectAccount('claude', 'cli')),
  mutate('detectAccount', 'without source', actions.detectAccount('claude')),
  mutate(
    'loginAccount',
    'named',
    actions.loginAccount({ providerId: 'claude', methodId: 'subscription', name: 'work', label: 'Work' }),
  ),
  mutate('loginAccount', 'unnamed', actions.loginAccount({ providerId: 'claude', methodId: 'subscription' })),
  mutate(
    'loginAccount',
    'named, no label',
    actions.loginAccount({ providerId: 'claude', methodId: 'subscription', name: 'work' }),
  ),
  mutate(
    'loginAccount',
    'from a source',
    actions.loginAccount({ providerId: 'codex', methodId: 'chatgpt', sourceId: 'cli', name: 'work' }),
  ),
  mutate(
    'savePastedAuth',
    'new',
    actions.savePastedAuth({ providerId: 'codex', name: 'work', path: '/tmp/anypick-auth-paste/paste.json' }),
  ),
  mutate(
    'savePastedAuth',
    'unnamed overwrite',
    actions.savePastedAuth({ providerId: 'codex', path: '/tmp/anypick-auth-paste/paste.json', overwrite: true }),
  ),
  mutate(
    'savePastedAuth',
    'unnamed',
    actions.savePastedAuth({ providerId: 'codex', path: '/tmp/anypick-auth-paste/paste.json' }),
  ),
  mutate(
    'saveCredentialInput',
    'with profile',
    actions.saveCredentialInput({ providerId: 'claude', name: 'work', kind: 'api-key', apiKey: 'sk-test', profile: 'intl' }),
  ),
  mutate(
    'saveCredentialInput',
    'default profile',
    actions.saveCredentialInput({ providerId: 'claude', name: 'work', kind: 'api-key', apiKey: 'sk-test', profile: '' }),
  ),
  mutate(
    'saveCredentialInput',
    'key-optional product, no key',
    actions.saveCredentialInput({ providerId: 'ollama', name: 'local', kind: 'server', apiKey: '', profile: 'default' }),
  ),
  mutate(
    'saveLiveLogin',
    'with source',
    actions.saveLiveLogin({ providerId: 'claude', name: 'work', identity: 'alex@example.test', sourceId: 'cli' }),
  ),
  mutate(
    'saveLiveLogin',
    'without source',
    actions.saveLiveLogin({ providerId: 'claude', name: 'work', identity: 'Current Claude login' }),
  ),
  mutate('removeAccount', 'account', actions.removeAccount('claude', 'work')),
  mutate('refreshSaved', 'account', actions.refreshSaved({ kind: 'account', providerId: 'claude', name: 'work' })),
  mutate('refreshSaved', 'gateway', actions.refreshSaved({ kind: 'gateway', providerId: 'openrouter', name: 'team' })),
  mutate('editAccount', 'label', actions.editAccount({ providerId: 'claude', name: 'work' }, 'Work')),
  mutate('editAccount', 'cleared label', actions.editAccount({ providerId: 'claude', name: 'work' }, '')),
  mutate('clearLiveLogin', 'with source', actions.clearLiveLogin('claude', 'cli')),
  mutate('clearLiveLogin', 'without source', actions.clearLiveLogin('claude')),
  mutate(
    'createGateway',
    'gateway, every field',
    actions.createGateway({
      providerId: 'cloudflare',
      name: 'team',
      label: 'team',
      endpoint: 'https://gateway.example.test/v1',
      apiKey: 'sk-test',
      defaultModel: 'gpt-test',
      gatewayId: 'default',
      profile: 'account-123',
    }),
  ),
  mutate(
    'createGateway',
    'gateway, no key',
    actions.createGateway({ providerId: 'ollama', name: 'local', label: 'local', endpoint: 'http://127.0.0.1:11434' }),
  ),
  mutate(
    'createGateway',
    'gateway, endpoint and key',
    actions.createGateway({
      providerId: 'openrouter',
      name: 'team',
      label: 'team',
      endpoint: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
    }),
  ),
  mutate(
    'createGateway',
    'gateway, account-derived',
    actions.createGateway({
      providerId: 'cloudflare',
      name: 'team',
      label: 'team',
      apiKey: 'sk-test',
      gatewayId: 'default',
      profile: 'account-123',
    }),
  ),
  mutate(
    'testGateway',
    'with key',
    actions.testGateway({ providerId: 'openrouter', endpoint: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' }),
  ),
  mutate('testGateway', 'without key', actions.testGateway({ providerId: 'ollama', endpoint: 'http://127.0.0.1:11434' })),
  mutate(
    'testGateway',
    'account-derived',
    actions.testGateway({ providerId: 'cloudflare', endpoint: '', apiKey: 'sk-test', profile: 'account-123' }),
  ),
  mutate('editGateway', 'label', actions.editGateway('team', 'Team')),
  mutate('refreshGateway', 'name', actions.refreshGateway('team')),
  mutate('removeGateway', 'with provider', actions.removeGateway('team', 'openrouter')),
  mutate('backupAll', 'temp file', actions.backupAll()),
  mutate(
    'exportBackup',
    'selection',
    actions.exportBackup('/tmp/anypick-backup.json', [{ provider: 'claude', name: 'work' }], false),
  ),
  mutate('importBackup', 'confirmed', actions.importBackup('inspection-1', ['0', '1'], true)),
  mutate('forgetBackup', 'inspection', actions.forgetBackup('inspection-1')),
  mutate('refreshModels', 'account', actions.refreshModels('account/claude/work')),
  mutate('refreshModels', 'gateway', actions.refreshModels('gateway/team')),
  mutate('resetClient', 'client', actions.resetClient('claude')),
  mutate(
    'saveCodexProfile',
    'every field',
    actions.saveCodexProfile({ name: 'work', sourceId: 'account/codex/work', modelId: 'gpt-test', transportPolicy: 'auto' }),
  ),
  mutate(
    'saveCodexProfile',
    'defaults',
    actions.saveCodexProfile({ name: 'work', sourceId: 'account/codex/work', modelId: '', transportPolicy: '' }),
  ),
  mutate(
    'saveCodexProfile',
    'policy, default model',
    actions.saveCodexProfile({ name: 'work', sourceId: 'account/codex/work', modelId: '', transportPolicy: 'direct' }),
  ),
  mutate(
    'updateCodexProfile',
    'every field',
    actions.updateCodexProfile({ name: 'work', sourceId: 'account/codex/work', modelId: 'gpt-test', transportPolicy: 'proxy' }),
  ),
  mutate('removeCodexProfile', 'name', actions.removeCodexProfile('work')),
  mutate('openCodexProfile', 'name', actions.openCodexProfile('work')),
  mutate('syncCodexProfiles', 'sources', actions.syncCodexProfiles(['account/codex/work', 'account/codex/home'])),
  mutate('proxyBulk', 'start', actions.proxyBulk('proxy-start-all')),
  mutate('proxyBulk', 'restart', actions.proxyBulk('proxy-restart-all')),
  mutate('proxyBulk', 'stop', actions.proxyBulk('proxy-stop-all')),
  mutate('proxyToken', 'proxy', actions.proxyToken({ providerId: 'claude', name: 'work' })),
  ...actions.SETTING_ROWS.flatMap((row) => [
    mutate('settingChange', `${row.operation} on`, actions.settingChange(row.operation, true)),
    mutate('settingChange', `${row.operation} off`, actions.settingChange(row.operation, false)),
  ]),
  mutate('languageChange', 'explicit', actions.languageChange('vi')),
  // The options come from the engine's snapshot; `auto` is its follow-the-OS value.
  mutate('languageChange', 'auto', actions.languageChange('auto')),
  mutate('hubStrategyChange', 'failover', actions.hubStrategyChange('default', 'failover')),
  mutate('hubStrategyChange', 'round-robin', actions.hubStrategyChange('default', 'round-robin')),
  mutate('hubStrategyChange', 'soonest-reset', actions.hubStrategyChange('', 'soonest-reset')),
  mutate('hubSourceChange', 'account', actions.hubSourceChange({ hub: 'default', source: accountSource, enabled: false })),
  mutate('hubSourceChange', 'pool', actions.hubSourceChange({ hub: 'default', source: poolSource, enabled: true })),
  mutate('hubSourceChange', 'rotation', actions.hubSourceChange({ hub: '', source: rotationSource, enabled: true })),
];

/** The non-mutate kinds, built by the encoders `lib/service.ts` calls. */
export const OTHER_CASES: CorpusCase[] = [
  { builder: 'invokeCommand', name: 'plain', line: invokeCommand('switch:claude:work', 3, CORPUS_REQUEST_ID) },
  { builder: 'invokeCommand', name: 'with consent', line: invokeCommand('connect:codex', 3, CORPUS_REQUEST_ID, true) },
  {
    builder: 'modelRolesCommand',
    name: 'connection scope',
    line: modelRolesCommand('claude', { main: 'model:opus' }, 3, CORPUS_REQUEST_ID, 'connection'),
  },
  {
    builder: 'modelRolesCommand',
    name: 'provider scope',
    line: modelRolesCommand('claude', { main: 'model:opus', fast: '' }, 3, CORPUS_REQUEST_ID, 'provider'),
  },
  { builder: 'modelRolesCommand', name: 'no scope', line: modelRolesCommand('claude', {}, 3, CORPUS_REQUEST_ID) },
  { builder: 'logsCommand', name: 'tail', line: logsCommand('claude', 'work', 200, CORPUS_REQUEST_ID) },
  { builder: 'backupInspectCommand', name: 'path', line: backupInspectCommand('/tmp/anypick-backup.json', CORPUS_REQUEST_ID) },
  { builder: 'cancelCommand', name: 'request', line: cancelCommand(CORPUS_REQUEST_ID) },
  { builder: 'doctorCommand', name: 'report', line: doctorCommand(CORPUS_REQUEST_ID) },
];

export const CORPUS: CorpusCase[] = [...MUTATE_CASES, ...OTHER_CASES];

/** The simple commands `service.ts` sends bare; the engine has no payload to check. */
export const BARE_COMMANDS = new Set(['open', 'refresh', 'restart', 'stop', 'quit']);

function decodePayload(encoded: string): Record<string, unknown> {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

/** A parsed line: its kind and decoded payload. */
export function parseLine(line: string): { kind: string; payload: Record<string, unknown> } | null {
  const tab = line.indexOf('\t');
  if (tab < 0) return null;
  return { kind: line.slice(0, tab), payload: decodePayload(line.slice(tab + 1)) };
}

/**
 * What the engine's validator decides on: the kind, the mutate operation, the
 * keys present, and which of them are empty strings. Values otherwise do not
 * change the verdict, so two lines with one shape stand or fall together.
 */
export function commandShape(line: string): string {
  if (BARE_COMMANDS.has(line)) return line;
  const parsed = parseLine(line);
  if (!parsed) return `unparseable:${line}`;
  const keys = Object.keys(parsed.payload).sort();
  const empty = keys.filter((key) => parsed.payload[key] === '');
  const operation = parsed.kind === 'mutate' ? String(parsed.payload.operation) : '';
  return [parsed.kind, operation, keys.join(','), empty.length ? `empty:${empty.join(',')}` : ''].join('|');
}

let goldenShapes: Set<string> | null = null;

/**
 * The shapes in the committed golden — the set the Go engine has accepted.
 * Read from the file, not recomputed from `CORPUS`, so a builder change the
 * golden has not caught up with fails here as well as in the golden test.
 */
export function acceptedShape(line: string): boolean {
  if (BARE_COMMANDS.has(line)) return true;
  if (!goldenShapes) {
    const entries = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Array<{ kind: string; payload: unknown }>;
    goldenShapes = new Set(
      entries.map((entry) => commandShape(`${entry.kind}\t${btoa(JSON.stringify(entry.payload))}`)),
    );
  }
  return goldenShapes.has(commandShape(line));
}

/**
 * Lines a test sent that the engine has never been shown to accept. The bridge
 * records rather than throws: `service.ts` turns a failed send into a notice,
 * so a throw would be swallowed and the test would pass. `setup.ts` fails the
 * test after it runs instead.
 */
export const unacceptedLines: string[] = [];
