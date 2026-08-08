import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const tauri = join(root, 'src/tray/tauri');
const srcMain = join(tauri, 'frontend/main.js');
const srcDemo = join(tauri, 'frontend/demo-bridge.js');
const ui = join(tauri, 'ui');
const demo = join(tauri, 'demo');

mkdirSync(join(ui, 'lib'), { recursive: true });
mkdirSync(demo, { recursive: true });
copyFileSync(srcDemo, join(demo, 'bridge.js'));

writeFileSync(
  join(ui, 'lib/html.ts'),
  `export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function encodePayload(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodePayload(value: string): unknown {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function requestId(): string {
  return crypto.randomUUID();
}
`,
);

writeFileSync(
  join(ui, 'lib/provider.ts'),
  `import { escapeHtml } from './html';

export function initials(value: unknown): string {
  return String(value || '?')
    .split(/[-_\\s]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

export function providerFamily(value: unknown): string {
  const normalized = String(value || '')
    .toLocaleLowerCase()
    .split(/[/:]/u)[0];
  if (['anthropic', 'claude', 'claude-code'].includes(normalized)) return 'claude';
  if (['codex', 'openai'].includes(normalized)) return 'openai';
  if (['gemini', 'gemini-cli', 'antigravity'].includes(normalized)) return 'gemini';
  return normalized;
}

export function providerName(value: unknown): string {
  const family = providerFamily(value);
  if (family === 'claude') return 'Claude';
  if (family === 'openai') return 'OpenAI';
  if (family === 'gemini') return 'Google Gemini';
  if (family === 'kiro') return 'Kiro';
  if (family === 'openrouter') return 'OpenRouter';
  if (family === 'opencode') return 'OpenCode';
  return String(family || 'Provider')
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

export function providerIcon(value: unknown, size = ''): string {
  const normalized = String(value || '')
    .toLocaleLowerCase()
    .split(/[/:]/u)[0];
  const file = ['anthropic', 'claude', 'claude-code'].includes(normalized)
    ? 'claude.svg'
    : ['codex', 'openai'].includes(normalized)
      ? 'openai.svg'
      : ['gemini', 'gemini-cli', 'antigravity'].includes(normalized)
        ? 'googlegemini.svg'
        : normalized === 'openrouter'
          ? 'openrouter.svg'
          : normalized === 'opencode'
            ? 'opencode.svg'
            : normalized === 'kiro'
              ? 'kiro.svg'
              : ['grok', 'xai', 'x-ai'].includes(normalized)
                ? 'grok.svg'
                : null;
  const className = \`provider provider-\${normalized.replaceAll(/[^a-z0-9]/gu, '-')} \${size}\`;
  return file
    ? \`<span class="\${className}" aria-hidden="true"><img src="./icons/\${file}" alt="" /></span>\`
    : \`<span class="\${className}" aria-hidden="true">\${escapeHtml(initials(value))}</span>\`;
}
`,
);

let app = readFileSync(srcMain, 'utf8');

app = app.replace(
  "import { createDemoBridge, emptyDemoSnapshot } from './demo-bridge.js';\n\n",
  `import { createDemoBridge, emptyDemoSnapshot } from '../demo/bridge.js';
import type {
  TrayActionSnapshot,
  TrayClientModelConfigSnapshot,
  TrayHubConflictSnapshot,
  TrayLogSourceSnapshot,
  TrayProxySnapshot,
  TraySnapshot,
} from '../../snapshot-types';
import type { TrayMutationOperation } from '../../protocol';
import { decodePayload, encodePayload, escapeHtml, requestId } from './lib/html';
import { providerFamily, providerIcon, providerName } from './lib/provider';
import './styles.css';

`,
);

app = app.replace(
  /const bridge = window\.__TAURI__[\s\S]*?const \{ invoke, listen \} = bridge;\n\n/,
  `declare global {
  interface Window {
    __TAURI__?: {
      core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
      event: {
        listen: (
          event: string,
          handler: (event: { payload: string }) => void,
        ) => Promise<() => void>;
      };
    };
  }
}

export type TrayTab =
  | 'Apps'
  | 'Proxies'
  | 'Activity'
  | 'Saved accounts'
  | 'Hub Sources'
  | 'Routing Issues'
  | 'Models'
  | 'Logs'
  | 'Settings';

interface TrayBridge {
  isDemo: boolean;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen: (
    event: string,
    handler: (event: { payload: string }) => void,
  ) => Promise<() => void>;
}

const bridge: TrayBridge = window.__TAURI__
  ? {
      isDemo: false,
      invoke: window.__TAURI__.core.invoke,
      listen: window.__TAURI__.event.listen,
    }
  : createDemoBridge(
      new URLSearchParams(window.location.search).has('empty') ? emptyDemoSnapshot : undefined,
    );
const { invoke, listen } = bridge;

`,
);

// Drop helpers now imported from lib/*
for (const name of [
  'escapeHtml',
  'initials',
  'providerFamily',
  'providerName',
  'providerIcon',
  'encodePayload',
  'decodePayload',
]) {
  app = app.replace(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}\\n\\n`), '');
}
app = app.replace(/function requestId\(\) \{\n  return crypto\.randomUUID\(\);\n\}\n\n/, '');

app = app.replace(
  `const tabs = ['Apps', 'Proxies', 'Activity'];
const state = {`,
  `const tabs: TrayTab[] = ['Apps', 'Proxies', 'Activity'];
const state: {
  tab: TrayTab;
  query: string;
  snapshot: TraySnapshot | null;
  busyRequestId: string | null;
  noticeTimer: ReturnType<typeof setTimeout> | null;
  pending: Map<string, (payload?: { message?: string; status?: string }) => void>;
  proxyLogs: Map<string, string>;
  pendingLogRequests: Map<string, string>;
  logRequestTimers: Map<string, ReturnType<typeof setTimeout>>;
  latestLogRequestBySource: Map<string, string>;
  proxyLogStates: Map<string, string>;
  selectedLogSourceId: string | null;
  form: Record<string, any> | null;
  manageProvider: string;
  routePicker: string | null;
  overflowMenu: string | null;
  routeResetConfirmation: { actionId: string; customRoleCount: number } | null;
  clientResetConfirmation: { client: string; title: string } | null;
  routeQuery: string;
  routeGroup: string | null;
  hubAccountQuery: string;
  hubAccountFilter: string;
  routingCandidateConflictId: string | null;
  routingCandidateQuery: string;
  modelEditorClientId: string | null;
  modelDraftRoleActions: Record<string, string | null>;
  modelPickerRole: string | null;
  modelQuery: string;
  modelGroup: string | null;
} = {`,
);

app = app.replace(
  `const elements = {
  tabs: document.querySelector('#tabs'),
  status: document.querySelector('#status'),
  notice: document.querySelector('#notice'),
  content: document.querySelector('#content'),
  settings: document.querySelector('#open-settings'),
};`,
  `function requireEl<T extends Element>(selector: string): T {
  const el = document.querySelector(selector);
  if (!el) throw new Error(\`Missing element \${selector}\`);
  return el as T;
}

const elements = {
  tabs: requireEl<HTMLElement>('#tabs'),
  status: requireEl<HTMLElement>('#status'),
  notice: requireEl<HTMLElement>('#notice'),
  content: requireEl<HTMLElement>('#content'),
  settings: requireEl<HTMLButtonElement>('#open-settings'),
};`,
);

const replacements = [
  ['async function send(command) {', 'async function send(command: string) {'],
  [
    'async function sendBusyCommand(command, requestId) {',
    'async function sendBusyCommand(command: string, requestId: string) {',
  ],
  [
    'function notify(message, isError = false) {',
    'function notify(message: string, isError = false) {',
  ],
  [
    'function runOpaqueAction(actionId, label) {',
    'function runOpaqueAction(actionId: string | undefined, label: string) {',
  ],
  [
    'function runAction(action) {',
    'function runAction(action: TrayActionSnapshot | { id: string; label: string; enabled?: boolean } | undefined) {',
  ],
  [
    'function mutate(operation, payload, label, onSuccess) {',
    'function mutate(operation: TrayMutationOperation | string, payload: Record<string, any>, label: string, onSuccess?: () => void) {',
  ],
  [
    'function applyModelRoles(config) {',
    'function applyModelRoles(config: TrayClientModelConfigSnapshot | undefined) {',
  ],
  [
    'function requestLogs(source) {',
    'function requestLogs(source: TrayLogSourceSnapshot | undefined) {',
  ],
  [
    'function failLogRequest(requestId, sourceId) {',
    'function failLogRequest(requestId: string, sourceId: string) {',
  ],
  ['function consume(line) {', 'function consume(line: string) {'],
  ['function matches(...values) {', 'function matches(...values: unknown[]) {'],
  [
    "function sectionHeading(title, detail = '', action = '') {",
    "function sectionHeading(title: string, detail = '', action = '') {",
  ],
  [
    'function statusLine(proxyCount = state.snapshot?.proxyCount ?? 0) {',
    'function statusLine(proxyCount: number = state.snapshot?.proxyCount ?? 0) {',
  ],
  ['function usageSummary(client) {', 'function usageSummary(client: string) {'],
  ['function shortAccountLabel(label) {', 'function shortAccountLabel(label: string) {'],
  [
    'function customRoleCount(config, routeModel) {',
    'function customRoleCount(config: TrayClientModelConfigSnapshot | undefined, routeModel?: string) {',
  ],
  [
    'function chipActionsFor(actions, limit = 4) {',
    'function chipActionsFor(actions: TrayActionSnapshot[], limit = 4) {',
  ],
  ['function chipTitle(action) {', 'function chipTitle(action: TrayActionSnapshot) {'],
  [
    'function accountLine(selected, route) {',
    'function accountLine(selected: TrayActionSnapshot | undefined, route: { source?: string } | null | undefined) {',
  ],
  [
    'function modelLine(selected, route, config) {',
    'function modelLine(selected: TrayActionSnapshot | undefined, route: { model?: string } | null | undefined, config: TrayClientModelConfigSnapshot | undefined) {',
  ],
  [
    'function renderRouteChips(key, actions) {',
    'function renderRouteChips(key: string, actions: TrayActionSnapshot[]) {',
  ],
  ['function routeKind(action) {', 'function routeKind(action: TrayActionSnapshot) {'],
  ['function routeTitle(action) {', 'function routeTitle(action: TrayActionSnapshot) {'],
  ['function routeSubtitle(action) {', 'function routeSubtitle(action: TrayActionSnapshot) {'],
  ['function routeProvider(action) {', 'function routeProvider(action: TrayActionSnapshot) {'],
  [
    'function renderPickerAction(action) {',
    'function renderPickerAction(action: TrayActionSnapshot) {',
  ],
  [
    "function pickerSection(title, items, note = '') {",
    "function pickerSection(title: string, items: TrayActionSnapshot[], note = '') {",
  ],
  [
    'function renderRoutePicker(key, actions, options = {}) {',
    'function renderRoutePicker(key: string, actions: TrayActionSnapshot[], options: { extras?: string; selected?: TrayActionSnapshot } = {}) {',
  ],
  [
    "function renderSwitchMenu(key, actions, { configureModelsId = null, openLabel = 'Open App…' } = {}) {",
    "function renderSwitchMenu(key: string, actions: TrayActionSnapshot[], { configureModelsId = null, openLabel = 'Open App…' }: { configureModelsId?: string | null; openLabel?: string } = {}) {",
  ],
  [
    'function renderRouteRow(key, title, actions, sourceId, usageClient) {',
    'function renderRouteRow(key: string, title: string, actions: TrayActionSnapshot[], sourceId: string, usageClient: string) {',
  ],
  [
    'function modelConfigFor(clientId, client) {',
    'function modelConfigFor(clientId?: string | null, client?: string) {',
  ],
  [
    'function orderedModelRoles(config) {',
    'function orderedModelRoles(config: TrayClientModelConfigSnapshot | undefined) {',
  ],
  [
    'function modelOption(config, actionId) {',
    'function modelOption(config: TrayClientModelConfigSnapshot | undefined, actionId: string | null | undefined) {',
  ],
  [
    'function modelOptionForId(config, modelId) {',
    'function modelOptionForId(config: TrayClientModelConfigSnapshot | undefined, modelId: string | undefined) {',
  ],
  [
    'function modelSummary(config) {',
    'function modelSummary(config: TrayClientModelConfigSnapshot | undefined) {',
  ],
  ['function openModelEditor(clientId) {', 'function openModelEditor(clientId: string) {'],
  [
    'function renderAppCard(clientId, client, actions) {',
    'function renderAppCard(clientId: string, client: string, actions: TrayActionSnapshot[]) {',
  ],
  ['function renderHubRow(hub) {', 'function renderHubRow(hub: TrayProxySnapshot) {'],
  [
    'function renderModelOption(option, selected) {',
    'function renderModelOption(option: { actionId: string; modelId: string; providerId: string; sourceLabel?: string }, selected: boolean) {',
  ],
  [
    'function renderModelPicker(config) {',
    'function renderModelPicker(config: TrayClientModelConfigSnapshot) {',
  ],
  [
    "function field(label, name, value, placeholder = '', type = 'text') {",
    "function field(label: string, name: string, value: string, placeholder = '', type = 'text') {",
  ],
  [
    'function overflowMenu(key, items) {',
    'function overflowMenu(key: string, items: Array<{ label: string; attrs: string; disabled?: boolean; title?: string; danger?: boolean }>) {',
  ],
  [
    'function activityIcon(event) {',
    'function activityIcon(event: { isError?: boolean; kind?: string }) {',
  ],
  [
    'function settingRow(title, detail, fieldName, checked) {',
    'function settingRow(title: string, detail: string, fieldName: string, checked: boolean | undefined) {',
  ],
  [
    'function clientResetRow(client, title, detail) {',
    'function clientResetRow(client: string, title: string, detail: string) {',
  ],
  [
    'function renderConflictCandidate(candidate, sourceChoice) {',
    'function renderConflictCandidate(candidate: { actionId: string; label: string; detail: string; providerId: string }, sourceChoice: boolean) {',
  ],
  [
    'function renderRoutingCandidatePicker(conflict, sourceChoice) {',
    'function renderRoutingCandidatePicker(conflict: TrayHubConflictSnapshot, sourceChoice: boolean) {',
  ],
];

for (const [from, to] of replacements) {
  if (!app.includes(from)) {
    console.warn('missing pattern:', from.slice(0, 80));
  }
  app = app.replaceAll(from, to);
}

app = app
  .replaceAll(
    "elements.tabs.addEventListener('click', (event) => {",
    "elements.tabs.addEventListener('click', (event: Event) => {",
  )
  .replaceAll(
    "elements.content.addEventListener('input', (event) => {",
    "elements.content.addEventListener('input', (event: Event) => {",
  )
  .replaceAll(
    "elements.content.addEventListener('keydown', (event) => {",
    "elements.content.addEventListener('keydown', (event: KeyboardEvent) => {",
  )
  .replaceAll(
    "elements.content.addEventListener('change', (event) => {",
    "elements.content.addEventListener('change', (event: Event) => {",
  )
  .replaceAll(
    "elements.content.addEventListener('click', async (event) => {",
    "elements.content.addEventListener('click', async (event: Event) => {",
  )
  .replaceAll(
    "document.addEventListener('keydown', (event) => {",
    "document.addEventListener('keydown', (event: KeyboardEvent) => {",
  )
  .replaceAll('event.target.closest(', '(event.target as Element | null)?.closest(')
  .replaceAll(
    `const button = (event.target as Element | null)?.closest('button');
  if (!button) return;`,
    `const button = (event.target as Element | null)?.closest('button') as HTMLButtonElement | null;
  if (!button) return;`,
  )
  .replaceAll(
    `const button = (event.target as Element | null)?.closest('[data-tab]');
  if (!button) return;`,
    `const button = (event.target as Element | null)?.closest('[data-tab]') as HTMLButtonElement | null;
  if (!button) return;`,
  )
  .replaceAll('state.tab = button.dataset.tab;', 'state.tab = button.dataset.tab as TrayTab;')
  .replaceAll(
    "await listen('supervisor-line', (event) => consume(event.payload));",
    "await listen('supervisor-line', (event) => consume(String(event.payload)));",
  )
  .replaceAll(
    `const initial = await invoke('last_supervisor_line');
if (initial) consume(initial);`,
    `const initial = await invoke('last_supervisor_line');
if (typeof initial === 'string' && initial) consume(initial);`,
  )
  .replaceAll(
    `.querySelector('#restart-proxies')
  .addEventListener`,
    `.querySelector('#restart-proxies')!
  .addEventListener`,
  )
  .replaceAll(
    `.querySelector('#stop-proxies')
  .addEventListener`,
    `.querySelector('#stop-proxies')!
  .addEventListener`,
  )
  .replaceAll(
    "document.querySelector('#quit').addEventListener",
    "document.querySelector('#quit')!.addEventListener",
  );

// icon path in remaining code used icons/ — vite publicDir will serve icons/
app = app.replaceAll('src="icons/', 'src="./icons/');

writeFileSync(join(ui, 'main.ts'), app);

writeFileSync(
  join(ui, 'index.html'),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <title>AnyPick</title>
  </head>
  <body>
    <main class="shell">
      <header class="header">
        <div class="brand-mark" aria-hidden="true"><span></span></div>
        <div class="brand-copy">
          <h1>AnyPick</h1>
          <p id="status">Connecting to supervisor…</p>
        </div>
        <div class="header-actions">
          <button id="open-settings" title="Settings" aria-label="Settings">⚙</button>
        </div>
      </header>

      <nav id="tabs" class="tabs" aria-label="AnyPick sections"></nav>
      <section id="notice" class="notice" hidden aria-live="polite"></section>
      <section id="content" class="content" aria-live="polite"></section>

      <footer class="footer">
        <div class="footer-primary">
          <button id="add-account" class="primary">＋ Add account</button>
          <span id="footer-status">Ready</span>
        </div>
        <div>
          <button id="restart-proxies">↻ Restart proxies</button>
          <button id="stop-proxies">□ Stop proxies</button>
          <button id="quit" class="danger">⌁ Quit</button>
        </div>
      </footer>
    </main>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
`,
);

console.log('migrated ui/main.ts bytes', app.length);
