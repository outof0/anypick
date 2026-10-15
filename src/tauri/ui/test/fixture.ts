import type { Snapshot } from '../lib/contract';

/**
 * A snapshot shaped exactly like the one the Go engine serialises.
 *
 * It is not a mock: every field here is one `snapshot.go` sends, and
 * `contract-drift.test.ts` fails if that stops being true. It exists so a pane
 * can be rendered in a test without a Tauri shell, which is the only way to
 * assert on what a user would actually see.
 *
 * Override with `snapshotWith` for the one section a test cares about.
 */
export function snapshotFixture(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    proxyCount: 2,
    revision: 7,
    routes: [
      { clientId: 'claude', client: 'Claude Code', status: 'ready', source: 'Work', model: 'claude-sonnet' },
      { clientId: 'codex', client: 'Codex', status: 'native', source: 'native login' },
    ],
    actions: [
      {
        id: 'act-7-001',
        clientId: 'claude',
        sourceId: 'account/claude/work',
        client: 'Claude Code',
        label: 'Work',
        detail: 'alex@studio.example',
        kind: 'native',
        presentation: 'native-account',
        selected: true,
        enabled: true,
        routeKind: 'managed-account',
      },
      {
        id: 'act-7-002',
        clientId: 'claude',
        sourceId: 'gateway/team',
        client: 'Claude Code',
        label: 'Team gateway',
        kind: 'gateway',
        presentation: 'app-route',
        selected: false,
        enabled: true,
        routeKind: 'gateway',
      },
    ],
    clientModelConfigs: [
      {
        clientId: 'claude',
        client: 'Claude Code',
        roles: [
          { id: 'default', label: 'Default' },
          { id: 'sonnet', label: 'Sonnet' },
        ],
        modelRoles: { default: 'claude-sonnet', sonnet: 'claude-sonnet' },
        options: [
          { actionId: 'act-7-101', modelId: 'claude-sonnet', providerId: 'claude' },
          { actionId: 'act-7-102', modelId: 'claude-opus', providerId: 'claude' },
        ],
        editable: true,
        sourceLabel: 'Work',
      },
    ],
    usage: [
      {
        client: 'Claude',
        account: 'Work',
        windows: [{ label: '', remainingPercent: 42, limitWindowSeconds: 18000, resetsAtMs: 0 }],
      },
    ],
    proxies: [
      {
        id: 'claude/work',
        providerId: 'claude',
        label: 'Claude proxy · Work',
        detail: 'running on port 5150',
        address: 'http://127.0.0.1:5150',
        running: true,
        enabled: true,
        logsAvailable: true,
        toggleActionId: 'act-7-201',
        restartActionId: 'act-7-202',
        rotateActionId: 'act-7-203',
        hasToken: true,
      },
      {
        id: 'codex/team',
        providerId: 'codex',
        label: 'Codex proxy · Team',
        detail: 'stopped',
        running: false,
        enabled: false,
        toggleActionId: 'act-7-211',
        restartActionId: 'act-7-212',
      },
      {
        id: 'proxy-hub/default',
        providerId: 'proxy-hub',
        label: 'Proxy Hub · default',
        detail: 'running on port 5200',
        address: 'http://127.0.0.1:5200',
        running: true,
        enabled: true,
        toggleActionId: 'act-7-221',
        restartActionId: 'act-7-222',
        rotateActionId: 'act-7-223',
        hasToken: true,
      },
    ],
    accounts: [
      {
        id: 'claude/work',
        providerId: 'claude',
        sourceId: 'account/claude/work',
        name: 'work',
        label: 'Work',
        detail: 'alex@studio.example',
        active: true,
        canRefresh: true,
        switchActionId: 'act-7-301',
      },
      {
        id: 'claude/personal',
        providerId: 'claude',
        sourceId: 'account/claude/personal',
        name: 'personal',
        label: 'Personal',
        detail: 'sam@studio.example',
        active: false,
        canRefresh: true,
        switchActionId: 'act-7-302',
      },
    ],
    hubSources: [
      {
        id: 'hub/default/claude/work',
        providerId: 'claude',
        name: 'work',
        label: 'Work',
        detail: '2 models',
        enabled: true,
        hub: 'default',
      },
      {
        id: 'hub/default/rotation',
        providerId: '',
        name: 'rotation',
        label: 'Rotate across accounts',
        detail: 'Round robin',
        enabled: false,
        hub: 'default',
        rotates: true,
        accountCount: 2,
      },
    ],
    hubConflicts: [],
    hubPublishedModels: [
      { id: 'claude-sonnet', ownerLabel: 'Work', ownerProviderId: 'claude', needsChoice: false },
      { id: 'claude-opus', ownerLabel: 'Work', ownerProviderId: 'claude', needsChoice: false },
    ],
    hubCatalogs: [
      { accountID: 'hub/default/claude/work', catalog: 'claude', models: ['claude-opus', 'claude-sonnet'] },
    ],
    codexProfiles: [],
    codexProfileSources: [],
    logSources: [
      { id: 'claude/work', providerId: 'claude', name: 'work', label: 'Work', detail: 'Claude proxy logs' },
    ],
    gateways: [
      {
        id: 'team',
        providerId: 'openrouter',
        name: 'team',
        detail: 'Team gateway',
        ready: true,
        defaultModel: 'openai/gpt-4o',
      },
    ],
    accountProviders: [
      {
        id: 'claude',
        providerId: 'claude',
        label: 'Claude',
        detail: 'Anthropic Claude',
        installed: true,
        livePresent: true,
        liveIdentity: 'alex@studio.example',
        loginMethods: [
          { id: 'subscription', label: 'Subscription', provenance: 'official', preferred: true, available: true },
        ],
      },
    ],
    gatewayProviders: [
      {
        id: 'openrouter',
        label: 'OpenRouter',
        detail: 'Hosted models',
        requiresApiKey: true,
        providesEndpoint: true,
        firstPartyClientIds: ['claude', 'codex'],
        kind: 'custom',
      },
    ],
    settings: {
      launchAtLogin: false,
      startEnabledProxies: true,
      showQuota: true,
      quotaGuardEnabled: false,
      language: 'auto',
      resolvedLanguage: 'en',
      languageOptions: [
        { value: 'auto', label: 'Auto Detect' },
        { value: 'en', label: 'English' },
        { value: 'zh-CN', label: '简体中文' },
        { value: 'es', label: 'Español' },
        { value: 'fr', label: 'Français' },
        { value: 'de', label: 'Deutsch' },
        { value: 'ja', label: '日本語' },
        { value: 'ko', label: '한국어' },
        { value: 'pt-BR', label: 'Português (Brasil)' },
        { value: 'vi', label: 'Tiếng Việt' },
      ],
    },
    activity: [
      {
        id: 'evt-1',
        createdAt: '2026-09-30T09:42:00Z',
        message: 'Claude Code now uses Work.',
        isError: false,
        kind: 'activation',
        provider: 'claude',
      },
    ],
    degradedConditions: [],
    ...overrides,
  };
}
