const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(value) {
  const bytes = encoder.encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decode(value) {
  const binary = atob(value);
  return JSON.parse(decoder.decode(Uint8Array.from(binary, (part) => part.charCodeAt(0))));
}

const compactDemoSnapshot = {
  proxyCount: 2,
  revision: 7,
  routes: [
    {
      clientId: 'claude',
      client: 'Claude Code',
      source: 'Proxy Hub',
      model: 'claude-sonnet-4-5',
      status: 'ready',
    },
    {
      clientId: 'codex',
      client: 'Codex',
      source: 'codex/allen',
      status: 'native',
    },
  ],
  actions: [
    {
      id: 'claude-native-zendigi',
      clientId: 'claude',
      sourceId: 'claude-code',
      client: 'Claude Code',
      label: 'zendigi',
      detail: 'Claude native account',
      kind: 'native',
      presentation: 'app-route',
      selected: false,
      enabled: true,
    },
    {
      id: 'claude-hub-sonnet',
      clientId: 'claude',
      sourceId: 'default',
      client: 'Claude Code',
      label: 'Proxy Hub · claude-sonnet-4-5',
      detail: '2 accounts · managed proxy',
      kind: 'gateway',
      presentation: 'app-route',
      selected: true,
      enabled: true,
    },
    {
      id: 'claude-hub-gemini',
      clientId: 'claude',
      sourceId: 'default',
      client: 'Claude Code',
      label: 'Proxy Hub · gemini-2.5-pro',
      detail: '2 accounts · managed proxy',
      kind: 'gateway',
      presentation: 'app-route',
      selected: false,
      enabled: true,
    },
    {
      id: 'claude-gateway-work',
      clientId: 'claude',
      sourceId: 'openrouter/work',
      client: 'Claude Code',
      label: 'OpenRouter · work',
      detail: 'claude-opus-4-1',
      kind: 'gateway',
      presentation: 'app-route',
      selected: false,
      enabled: true,
    },
    {
      id: 'codex-native-allen',
      clientId: 'codex',
      sourceId: 'codex',
      client: 'Codex',
      label: 'allen',
      detail: 'Codex native account',
      kind: 'native',
      presentation: 'app-route',
      selected: true,
      enabled: true,
    },
    {
      id: 'gemini-native-lentaunao',
      clientId: 'gemini',
      sourceId: 'antigravity',
      client: 'Gemini',
      label: 'lentaunao',
      detail: 'Antigravity native account',
      kind: 'native',
      presentation: 'native-account',
      selected: true,
      enabled: true,
    },
    {
      id: 'codex-hub-sonnet',
      clientId: 'codex',
      sourceId: 'default',
      client: 'Codex',
      label: 'Proxy Hub · claude-sonnet-4-5',
      detail: '2 accounts · managed proxy',
      kind: 'gateway',
      presentation: 'app-route',
      selected: false,
      enabled: true,
    },
    {
      id: 'codex-hub-gemini',
      clientId: 'codex',
      sourceId: 'default',
      client: 'Codex',
      label: 'Proxy Hub · gemini-2.5-pro',
      detail: '2 accounts · managed proxy',
      kind: 'gateway',
      presentation: 'app-route',
      selected: false,
      enabled: true,
    },
  ],
  usage: [
    {
      client: 'Claude Code',
      account: 'zendigi',
      windows: [
        { label: 'Session', remainingPercent: 78 },
        { label: 'Weekly', remainingPercent: 43 },
      ],
    },
    {
      client: 'Codex',
      account: 'allen',
      windows: [{ label: '5 hour', remainingPercent: 64 }],
    },
  ],
  proxies: [
    {
      id: 'proxy-hub/default',
      providerId: 'proxy-hub',
      label: 'Proxy Hub',
      detail: 'Running · 2 sources · 5 models',
      address: '127.0.0.1:4680',
      running: true,
      enabled: true,
      logsAvailable: false,
      sourceCount: 2,
      modelCount: 5,
      clientCount: 1,
      conflictCount: 0,
      toggleActionId: 'proxy-toggle-hub-default',
      restartActionId: 'proxy-restart-hub-default',
    },
    {
      id: 'claude/work',
      providerId: 'claude',
      label: 'Claude proxy',
      detail: 'Running · work',
      address: '127.0.0.1:4121',
      running: true,
      enabled: true,
      toggleActionId: 'proxy-toggle-claude-work',
      restartActionId: 'proxy-restart-claude-work',
    },
    {
      id: 'codex/personal',
      providerId: 'codex',
      label: 'Codex proxy',
      detail: 'Stopped · personal',
      address: '127.0.0.1:4122',
      running: false,
      enabled: false,
      toggleActionId: 'proxy-toggle-codex-personal',
      restartActionId: 'proxy-restart-codex-personal',
    },
  ],
  hubSources: [
    {
      id: 'gemini/lentaunao',
      providerId: 'gemini',
      name: 'lentaunao',
      label: 'Gemini Pro',
      detail: 'Gemini · lentaunao@example.test',
      enabled: true,
    },
    {
      id: 'opencode/work',
      providerId: 'opencode',
      name: 'work',
      label: 'OpenCode Work',
      detail: 'OpenCode · work@example.test',
      enabled: true,
    },
    {
      id: 'grok/personal',
      providerId: 'grok',
      name: 'personal',
      label: 'Grok Personal',
      detail: 'Grok · personal@example.test',
      enabled: false,
    },
  ],
  accounts: [
    {
      id: 'claude/zendigi',
      providerId: 'claude',
      sourceId: 'claude-code',
      name: 'zendigi',
      label: 'zendigi',
      detail: 'Claude Code · zen@example.test',
      active: true,
      canRefresh: true,
    },
    {
      id: 'gemini/lentaunao',
      providerId: 'gemini',
      sourceId: 'antigravity',
      name: 'lentaunao',
      label: 'lentaunao',
      detail: 'Antigravity · lentaunao@example.test',
      active: true,
      canRefresh: true,
    },
    {
      id: 'codex/allen',
      providerId: 'codex',
      sourceId: 'codex',
      name: 'allen',
      label: 'allen',
      detail: 'Codex · allen@example.test',
      active: true,
      canRefresh: true,
    },
    {
      id: 'opencode/work',
      providerId: 'opencode',
      name: 'work',
      label: 'OpenCode Work',
      detail: 'OpenCode · work@example.test',
      active: false,
      canRefresh: true,
    },
    {
      id: 'grok/personal',
      providerId: 'grok',
      name: 'personal',
      label: 'Grok Personal',
      detail: 'Grok · personal@example.test',
      active: false,
      canRefresh: true,
    },
  ],
  gateways: [
    {
      id: 'work',
      providerId: 'openrouter',
      name: 'work',
      detail: 'OpenRouter · claude-opus-4-1',
      ready: true,
      defaultModel: 'anthropic/claude-opus-4.1',
    },
    {
      id: 'claude-team',
      providerId: 'anthropic',
      name: 'claude-team',
      detail: 'Anthropic · claude-sonnet-4-5',
      ready: true,
      defaultModel: 'claude-sonnet-4-5',
    },
  ],
  accountProviders: [
    {
      id: 'claude:claude-code',
      providerId: 'claude',
      sourceId: 'claude-code',
      label: 'Claude Code',
      detail: 'Claude',
      installed: true,
    },
    {
      id: 'gemini:antigravity',
      providerId: 'gemini',
      sourceId: 'antigravity',
      label: 'Antigravity',
      detail: 'Gemini',
      installed: true,
    },
  ],
  gatewayProviders: [
    { id: 'openrouter', label: 'OpenRouter', detail: 'OpenAI-compatible gateway' },
    { id: 'anthropic', label: 'Anthropic', detail: 'Anthropic API gateway' },
  ],
  settings: {
    launchAtLogin: false,
    startEnabledProxies: true,
    showQuota: true,
    quotaGuardEnabled: false,
  },
  activity: [
    {
      id: 'demo-switch',
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      kind: 'switch',
      message: 'Switched Gemini to lentaunao.',
      isError: false,
    },
    {
      id: 'demo-proxy',
      createdAt: new Date(Date.now() - 420_000).toISOString(),
      kind: 'proxy',
      message: 'Restarted Claude proxy.',
      isError: false,
    },
  ],
};

const stressHubSources = [
  ['gemini', 'gemini-work', 'Gemini Work', true, 18],
  ['gemini', 'gemini-personal', 'Gemini Personal', true, 14],
  ['gemini', 'gemini-lab', 'Gemini Lab', false, 11],
  ['gemini', 'gemini-backup', 'Gemini Backup', true, 9],
  ['opencode', 'oc-work', 'OpenCode Work', true, 16],
  ['opencode', 'oc-personal', 'OpenCode Personal', true, 13],
  ['opencode', 'oc-team', 'OpenCode Team', false, 12],
  ['opencode', 'oc-sandbox', 'OpenCode Sandbox', true, 8],
  ['grok', 'grok-work', 'Grok Work', true, 10],
  ['grok', 'grok-personal', 'Grok Personal', false, 8],
  ['grok', 'grok-lab', 'Grok Lab', true, 7],
  ['grok', 'grok-backup', 'Grok Backup', false, 6],
  ['gemini', 'gemini-legacy', 'Gemini Legacy', true, 0],
  ['opencode', 'oc-archive', 'OpenCode Archive', false, 5],
  ['grok', 'grok-team', 'Grok Team', true, 9],
].map(([providerId, name, label, enabled, modelCount], index) => ({
  id: `${providerId}/${name}`,
  providerId,
  name,
  label,
  detail: `${providerNameForDemo(providerId)} · account-${index + 1}@example.test`,
  enabled,
  modelCount,
  status: index === 12 ? 'unavailable' : enabled ? 'ready' : 'off',
  ...(index === 12 ? { warning: 'Login expired. Sign in again before using its models.' } : {}),
}));

function providerNameForDemo(providerId) {
  if (providerId === 'opencode') return 'OpenCode';
  if (providerId === 'gemini') return 'Gemini';
  if (providerId === 'grok') return 'Grok';
  return providerId;
}

const stressModelCatalog = Array.from({ length: 60 }, (_, index) => {
  const source = stressHubSources[index % 12];
  const families = ['reasoning', 'fast', 'code', 'vision', 'preview'];
  return {
    modelId: `${source.providerId}-${families[index % families.length]}-${String(index + 1).padStart(2, '0')}`,
    providerId: source.providerId,
    sourceLabel: source.label,
  };
});

function hubActions(clientId, client, selected) {
  // Source-first: one Proxy Hub switch action. Full catalog stays in model options.
  const soft = stressModelCatalog[0];
  return [
    {
      id: `${clientId}-hub`,
      clientId,
      sourceId: 'proxy-hub',
      client,
      label: 'Proxy Hub',
      detail: `${stressModelCatalog.length} models · ${stressHubSources.length} sources`,
      kind: 'gateway',
      routeKind: 'hub',
      modelId: soft?.modelId,
      upstreamProviderId: 'proxy-hub',
      upstreamSourceLabel: 'Proxy Hub',
      presentation: 'app-route',
      selected: Boolean(selected),
      enabled: true,
    },
  ];
}

function modelOptions(clientId) {
  return stressModelCatalog.map((model, index) => ({
    actionId: `${clientId}-hub-model-${index + 1}`,
    modelId: model.modelId,
    providerId: model.providerId,
    sourceLabel: model.sourceLabel,
  }));
}

const directActions = [
  {
    id: 'claude-native-zendigi',
    clientId: 'claude',
    sourceId: 'claude-code',
    client: 'Claude Code',
    label: 'zendigi',
    detail: 'Claude native account',
    kind: 'native',
    routeKind: 'direct-account',
    presentation: 'app-route',
    selected: false,
    enabled: true,
  },
  {
    id: 'claude-native-team',
    clientId: 'claude',
    sourceId: 'claude-code',
    client: 'Claude Code',
    label: 'team',
    detail: 'Claude native account',
    kind: 'native',
    routeKind: 'direct-account',
    presentation: 'app-route',
    selected: false,
    enabled: true,
  },
  {
    id: 'claude-gateway-work',
    clientId: 'claude',
    sourceId: 'openrouter/work',
    client: 'Claude Code',
    label: 'OpenRouter Work',
    detail: 'anthropic/claude-opus-4.1',
    kind: 'gateway',
    routeKind: 'gateway',
    presentation: 'app-route',
    selected: false,
    enabled: true,
  },
  {
    id: 'codex-native-allen',
    clientId: 'codex',
    sourceId: 'codex',
    client: 'Codex',
    label: 'allen',
    detail: 'Codex native account',
    kind: 'native',
    routeKind: 'direct-account',
    presentation: 'app-route',
    selected: true,
    enabled: true,
  },
  {
    id: 'codex-native-team',
    clientId: 'codex',
    sourceId: 'codex',
    client: 'Codex',
    label: 'team',
    detail: 'Codex native account',
    kind: 'native',
    routeKind: 'direct-account',
    presentation: 'app-route',
    selected: false,
    enabled: true,
  },
  {
    id: 'codex-gateway-work',
    clientId: 'codex',
    sourceId: 'openrouter/work',
    client: 'Codex',
    label: 'OpenRouter Work',
    detail: 'openai/gpt-5.6',
    kind: 'gateway',
    routeKind: 'gateway',
    presentation: 'app-route',
    selected: false,
    enabled: true,
  },
  {
    id: 'gemini-native-lentaunao',
    clientId: 'gemini',
    sourceId: 'antigravity',
    client: 'Gemini',
    label: 'lentaunao',
    detail: 'Antigravity native account',
    kind: 'native',
    routeKind: 'direct-account',
    presentation: 'native-account',
    selected: true,
    enabled: true,
  },
];

export const demoSnapshot = {
  ...compactDemoSnapshot,
  proxyCount: 2,
  revision: 19,
  routes: [
    {
      clientId: 'claude',
      client: 'Claude Code',
      source: 'Proxy Hub',
      model: stressModelCatalog[7].modelId,
      status: 'ready',
    },
    {
      clientId: 'codex',
      client: 'Codex',
      source: 'codex/allen',
      status: 'native',
    },
  ],
  actions: [
    ...directActions,
    ...hubActions('claude', 'Claude Code', true),
    ...hubActions('codex', 'Codex', false),
  ],
  proxies: [
    {
      id: 'proxy-hub/default',
      providerId: 'proxy-hub',
      label: 'Proxy Hub',
      detail: 'Running · 10 accounts · 60 models · 1 conflict group',
      address: '127.0.0.1:4680',
      running: true,
      enabled: true,
      logsAvailable: true,
      sourceCount: 10,
      modelCount: 60,
      clientCount: 1,
      conflictCount: 6,
      toggleActionId: 'proxy-toggle-hub-default',
      restartActionId: 'proxy-restart-hub-default',
      testActionId: 'proxy-test-hub-default',
    },
    {
      id: 'opencode/oc-work',
      providerId: 'opencode',
      label: 'OpenCode proxy',
      detail: 'Running · OpenCode Work',
      address: '127.0.0.1:4121',
      running: true,
      enabled: true,
      logsAvailable: true,
      toggleActionId: 'proxy-toggle-opencode-work',
      restartActionId: 'proxy-restart-opencode-work',
      testActionId: 'proxy-test-opencode-work',
    },
    {
      id: 'grok/grok-personal',
      providerId: 'grok',
      label: 'Grok proxy',
      detail: 'Stopped · Grok Personal',
      address: '127.0.0.1:4122',
      running: false,
      enabled: false,
      logsAvailable: true,
      toggleActionId: 'proxy-toggle-grok-personal',
      restartActionId: 'proxy-restart-grok-personal',
      testActionId: 'proxy-test-grok-personal',
    },
  ],
  hubSources: stressHubSources,
  hubConflicts: [
    {
      id: 'shared-premium-models',
      kind: 'model-overlap',
      title: '6 models are offered by multiple providers',
      models: [
        'shared-reasoning-pro',
        'shared-code-pro',
        'shared-fast-preview',
        'shared-vision-pro',
        'shared-agent-preview',
        'shared-long-context',
      ],
      candidates: [
        {
          id: 'gemini-work',
          providerId: 'gemini',
          label: 'Gemini Work',
          detail: '18 models · account-1@example.test',
          actionId: 'conflict-owner-gemini-work',
        },
        {
          id: 'oc-work',
          providerId: 'opencode',
          label: 'OpenCode Work',
          detail: '16 models · account-5@example.test',
          actionId: 'conflict-owner-opencode-work',
        },
      ],
    },
  ],
  logSources: [
    {
      id: 'proxy-hub/default',
      label: 'Proxy Hub',
      detail: 'Unified routing and upstream account traffic',
      providerId: 'proxy-hub',
      name: 'default',
    },
    {
      id: 'opencode/oc-work',
      label: 'OpenCode Work proxy',
      detail: 'OpenCode compatibility proxy',
      providerId: 'opencode',
      name: 'oc-work',
    },
    {
      id: 'tray-supervisor/main',
      label: 'Tray supervisor',
      detail: 'Startup, account refresh, and desktop integration',
      providerId: 'tray-supervisor',
      name: 'main',
    },
  ],
  clientModelConfigs: [
    {
      clientId: 'claude',
      client: 'Claude Code',
      sourceLabel: 'Proxy Hub',
      editable: true,
      roles: [
        { id: 'default', label: 'Default' },
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'opus', label: 'Opus' },
        { id: 'haiku', label: 'Haiku' },
      ],
      defaultModel: stressModelCatalog[7].modelId,
      modelRoles: {
        default: stressModelCatalog[7].modelId,
        opus: stressModelCatalog[22].modelId,
        haiku: stressModelCatalog[33].modelId,
      },
      options: modelOptions('claude'),
    },
    {
      clientId: 'codex',
      client: 'Codex',
      sourceLabel: 'Native account',
      editable: false,
      unavailableReason: 'Choose a model-routed source before editing the default model.',
      roles: [{ id: 'default', label: 'Default' }],
      modelRoles: {},
      options: [],
    },
  ],
  accounts: [
    ...compactDemoSnapshot.accounts,
    ...stressHubSources.map((source, index) => ({
      id: source.id,
      providerId: source.providerId,
      name: source.name,
      label: source.label,
      detail: source.detail,
      active: index === 0,
      canRefresh: true,
    })),
  ],
  activity: [
    {
      id: 'demo-check-warning',
      createdAt: new Date(Date.now() - 45_000).toISOString(),
      kind: 'proxy',
      message: 'Proxy Hub check found one account that needs sign-in.',
      isError: true,
    },
    ...compactDemoSnapshot.activity,
  ],
};

export const emptyDemoSnapshot = {
  ...structuredClone(demoSnapshot),
  proxyCount: 0,
  routes: [],
  actions: [],
  usage: [],
  proxies: [],
  hubSources: [],
  hubConflicts: [],
  logSources: [],
  accounts: [],
  gateways: [],
  accountProviders: [],
  gatewayProviders: [],
  clientModelConfigs: [],
  activity: [],
};

function commandPayload(command) {
  const separator = command.indexOf('\t');
  return separator < 0 ? null : decode(command.slice(separator + 1));
}

export function createDemoBridge(initialSnapshot = demoSnapshot) {
  const listeners = new Set();
  const snapshot = structuredClone(initialSnapshot);
  const publish = (kind, payload) => {
    const line = `${kind}\t${typeof payload === 'number' ? payload : encode(payload)}`;
    for (const listener of listeners) {
      listener({ payload: line });
    }
    return line;
  };
  const publishSnapshot = () => {
    snapshot.proxyCount = snapshot.proxies.filter((proxy) => proxy.running).length;
    publish('snapshot', snapshot);
  };
  const result = (requestId, message, status = 'success') =>
    publish('result', { version: 1, requestId, status, message });

  const invoke = async (name, args = {}) => {
    if (name === 'last_supervisor_line') {
      return `snapshot\t${encode(snapshot)}`;
    }
    if (name !== 'send_command') {
      throw new Error(`Unknown demo bridge command: ${name}`);
    }
    const command = args.command;
    if (command === 'refresh') {
      publishSnapshot();
      return;
    }
    if (!command.includes('\t')) {
      return;
    }
    const payload = commandPayload(command);
    if (command.startsWith('logs\t')) {
      const source = snapshot.logSources?.find(
        (item) => item.providerId === payload.providerId && item.name === payload.name,
      );
      const sourceName = source?.label ?? `${payload.providerId}/${payload.name}`;
      const logState =
        payload.providerId === 'tray-supervisor'
          ? 'error'
          : payload.providerId === 'opencode'
            ? 'empty'
            : 'ready';
      const text =
        logState === 'error'
          ? 'Could not read Tray supervisor logs. Refresh and try again.'
          : logState === 'empty'
            ? 'OpenCode proxy is running. No log entries yet.'
            : [
                `12:41:02 INFO  ${sourceName} ready`,
                '12:41:05 INFO  GET /health 200 3ms',
                '12:41:06 INFO  GET /v1/models 200 148ms',
                '12:41:09 INFO  claude-code gemini-fast-08 → gemini/Gemini Work 200 912ms',
                '12:41:18 WARN  gemini/Gemini Legacy catalog unavailable; sign-in required',
                '12:41:24 INFO  codex opencode-code-17 → opencode/OpenCode Work 200 1.2s',
                '12:41:31 INFO  request metadata only · prompts and secrets are not logged',
              ].join('\n');
      publish('logs', {
        version: 1,
        requestId: payload.requestId,
        proxyId: `${payload.providerId}/${payload.name}`,
        state: logState,
        text,
      });
      return;
    }
    if (command.startsWith('model-roles\t')) {
      const config = snapshot.clientModelConfigs?.find(
        (item) => item.clientId === payload.clientId,
      );
      const selected = Object.fromEntries(
        Object.entries(payload.roleActionIds ?? {}).map(([roleId, actionId]) => {
          const option = config?.options?.find((item) => item.actionId === actionId);
          return [roleId, option?.modelId];
        }),
      );
      if (!config || !selected.default || Object.values(selected).some((model) => !model)) {
        result(payload.requestId, 'The demo model selection is stale.', 'error');
        return;
      }
      config.defaultModel = selected.default;
      config.modelRoles = selected;
      const route = snapshot.routes.find((item) => item.clientId === payload.clientId);
      if (route) route.model = selected.default;
      // Model roles update the binding default; Switch source stays selected.
      snapshot.revision += 1;
      snapshot.activity.unshift({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        kind: 'switch',
        message: `Updated ${config.client} model roles atomically.`,
        isError: false,
      });
      publishSnapshot();
      result(payload.requestId, `Saved ${config.client} models.`);
      return;
    }
    if (command.startsWith('invoke\t')) {
      const action = snapshot.actions.find((item) => item.id === payload.actionId);
      const proxy = snapshot.proxies.find(
        (item) =>
          item.toggleActionId === payload.actionId ||
          item.restartActionId === payload.actionId ||
          item.testActionId === payload.actionId,
      );
      const conflictCandidate = (snapshot.hubConflicts ?? [])
        .flatMap((conflict) =>
          (conflict.candidates ?? []).map((candidate) => ({ conflict, candidate })),
        )
        .find(({ candidate }) => candidate.actionId === payload.actionId);
      if (action) {
        for (const item of snapshot.actions) {
          if (item.clientId === action.clientId) {
            item.selected = item.id === action.id;
          }
        }
        const config = snapshot.clientModelConfigs?.find(
          (item) => item.clientId === action.clientId,
        );
        if (config) {
          config.defaultModel =
            action.routeKind === 'hub' ? action.modelId : action.modelId || undefined;
          config.modelRoles = config.defaultModel ? { default: config.defaultModel } : {};
        }
        snapshot.revision += 1;
        const route = snapshot.routes.find((item) => item.clientId === action.clientId);
        if (route) {
          route.source = action.routeKind === 'hub' ? 'Proxy Hub' : action.label;
          route.model = action.modelId || undefined;
          route.status = action.routeKind === 'direct-account' ? 'native' : 'ready';
        }
        snapshot.activity.unshift({
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          kind: 'switch',
          message: `Switched ${action.client} to ${action.label}.`,
          isError: false,
        });
        publishSnapshot();
        result(payload.requestId, `Switched to ${action.label}.`);
      } else if (conflictCandidate) {
        snapshot.hubConflicts = snapshot.hubConflicts.filter(
          (item) => item.id !== conflictCandidate.conflict.id,
        );
        const hub = snapshot.proxies.find((item) => item.providerId === 'proxy-hub');
        if (hub) hub.conflictCount = 0;
        snapshot.revision += 1;
        snapshot.activity.unshift({
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          kind: 'proxy',
          message: `Assigned ${conflictCandidate.conflict.models.length} overlapping models to ${conflictCandidate.candidate.label}.`,
          isError: false,
        });
        publishSnapshot();
        result(
          payload.requestId,
          `Resolved ${conflictCandidate.conflict.models.length} models with ${conflictCandidate.candidate.label}.`,
        );
      } else if (proxy) {
        if (payload.actionId === proxy.testActionId) {
          snapshot.activity.unshift({
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            kind: 'proxy',
            message:
              proxy.providerId === 'proxy-hub'
                ? 'Proxy Hub route check passed for 8 accounts; 1 account needs sign-in.'
                : `${proxy.label} connection check passed.`,
            isError: false,
          });
          publishSnapshot();
          result(payload.requestId, `${proxy.label} check completed. Open Monitor for details.`);
        } else {
          proxy.running = payload.actionId === proxy.restartActionId ? true : !proxy.running;
          proxy.enabled = proxy.running;
          publishSnapshot();
          result(payload.requestId, `${proxy.running ? 'Started' : 'Stopped'} ${proxy.label}.`);
        }
      } else {
        result(payload.requestId, 'That demo action is no longer available.', 'error');
      }
      return;
    }
    if (!command.startsWith('mutate\t')) {
      return;
    }
    if (payload.operation === 'account-detect') {
      result(payload.requestId, 'Detected demo@example.test. Nothing was saved.');
      return;
    }
    if (payload.operation === 'account-save') {
      snapshot.accounts.push({
        id: `${payload.providerId}/${payload.name}`,
        providerId: payload.providerId,
        sourceId: payload.sourceId,
        name: payload.name,
        label: payload.label || payload.name,
        detail: 'Demo account · demo@example.test',
        active: false,
        canRefresh: true,
      });
    } else if (payload.operation === 'account-edit') {
      const account = snapshot.accounts.find(
        (item) => item.providerId === payload.providerId && item.name === payload.name,
      );
      if (account) {
        account.label = payload.label || payload.name;
      }
    } else if (payload.operation === 'gateway-create') {
      snapshot.gateways.push({
        id: payload.name,
        providerId: payload.providerId,
        name: payload.name,
        detail: `${payload.providerId} · ${payload.defaultModel || 'No default model'}`,
        ready: Boolean(payload.apiKey),
        defaultModel: payload.defaultModel,
      });
    } else if (payload.operation === 'gateway-edit') {
      const gateway = snapshot.gateways.find((item) => item.name === payload.name);
      if (gateway) {
        gateway.defaultModel = payload.defaultModel || gateway.defaultModel;
        gateway.detail = `${gateway.providerId} · ${gateway.defaultModel || 'No default model'}`;
      }
    } else if (payload.operation === 'hub-source-toggle') {
      const source = snapshot.hubSources.find(
        (item) => item.providerId === payload.providerId && item.name === payload.name,
      );
      if (source) source.enabled = payload.enabled;
      const hub = snapshot.proxies.find((item) => item.providerId === 'proxy-hub');
      if (hub) {
        hub.sourceCount = snapshot.hubSources.filter((item) => item.enabled).length;
        hub.enabled = hub.sourceCount > 0;
        if (!hub.enabled) hub.running = false;
      }
    } else if (payload.operation === 'proxy-restart-all') {
      for (const proxy of snapshot.proxies.filter((item) => item.enabled)) {
        proxy.running = true;
      }
    } else if (payload.operation === 'proxy-stop-all') {
      for (const proxy of snapshot.proxies) {
        proxy.running = false;
      }
    } else if (payload.operation === 'setting-launch-at-login') {
      snapshot.settings.launchAtLogin = payload.enabled;
    } else if (payload.operation === 'setting-auto-start-proxies') {
      snapshot.settings.startEnabledProxies = payload.enabled;
    } else if (payload.operation === 'setting-show-quota') {
      snapshot.settings.showQuota = payload.enabled;
    } else if (payload.operation === 'setting-quota-guard') {
      snapshot.settings.quotaGuardEnabled = payload.enabled;
    }
    snapshot.revision += 1;
    publishSnapshot();
    result(payload.requestId, `Demo completed: ${payload.operation}.`);
  };

  return {
    isDemo: true,
    invoke,
    async listen(event, listener) {
      if (event === 'supervisor-line') {
        listeners.add(listener);
      }
      return () => listeners.delete(listener);
    },
  };
}
