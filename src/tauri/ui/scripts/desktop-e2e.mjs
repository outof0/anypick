// Native WebDriver, production IPC, and the app-owned Go sidecar. Browser
// fixtures cannot prove that the native host accepts the engine's replies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { driverEnvironment, resolveExecutable } from './desktop-e2e-environment.mjs';
import { createNativeSession } from './desktop-e2e-session.mjs';

assert(['linux', 'win32'].includes(process.platform), 'native desktop E2E requires Linux or Windows');
const application = resolve(process.argv[2] ?? `src/tauri/app/target/debug/anypick${process.platform === 'win32' ? '.exe' : ''}`);
const embeddedDriver = process.platform === 'win32';
const driverPath = embeddedDriver ? undefined : await resolveExecutable('tauri-driver');
const nativeDriverPath = embeddedDriver ? undefined : await resolveExecutable('WebKitWebDriver');
const home = await mkdtemp(join(tmpdir(), 'anypick-desktop-e2e-'));
const environment = driverEnvironment(home);
const port = await freePort();
if (embeddedDriver) environment.TAURI_WEBDRIVER_PORT = String(port);
// Root containers need this WebKit setting; it is not needed or injected on
// normal desktops. All other fixture/test-mode variables stay absent.
if (process.getuid?.() === 0) environment.WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS = '1';
for (const path of [environment.PATH, environment.APPDATA, environment.LOCALAPPDATA, environment.XDG_CONFIG_HOME, environment.XDG_DATA_HOME, environment.XDG_CACHE_HOME, environment.TMPDIR]) {
  await mkdir(path, { recursive: true });
}
// This is deliberately only an id_token-shaped marker: Codex can detect it as
// a file-backed login, but it has no access token that could make a network
// request. Saving it through the real sheet exercises account-save's optional
// display hint across the Tauri → Go command boundary without promoting it
// into an account identity used by backup/import collision detection.
const codexHome = join(home, '.codex');
await mkdir(codexHome, { recursive: true });
await writeFile(join(codexHome, 'auth.json'), JSON.stringify({
  auth_mode: 'chatgpt', tokens: { id_token: 'anypick-e2e-no-network-marker' },
}), { mode: 0o600 });

async function freePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

let output = '';
let driver;
let applicationProcess;
let driverError;
let applicationError;
function captureOutput(child, onError) {
  child.on('error', onError);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + chunk).slice(-64 * 1024); });
}
if (!embeddedDriver) {
  const nativePort = await freePort();
  driver = spawn(driverPath, ['--native-driver', nativeDriverPath, '--port', String(port), '--native-port', String(nativePort)], {
    env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  captureOutput(driver, (error) => { driverError = error; });
}
let session;

async function request(method, path, body) {
  if (driverError) throw driverError;
  if (applicationError) throw applicationError;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45_000),
  });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(`${method} ${path}: ${JSON.stringify(result)}`);
  return result.value;
}

async function wait(label, check) {
  const deadline = Date.now() + 45_000;
  let last;
  while (Date.now() < deadline) {
    if (driverError) throw driverError;
    if (driver && driver.exitCode !== null) throw new Error(`tauri-driver exited ${driver.exitCode}: ${output}`);
    if (applicationError) throw applicationError;
    if (applicationProcess && (applicationProcess.exitCode !== null || applicationProcess.signalCode !== null)) {
      const result = applicationProcess.signalCode ?? applicationProcess.exitCode;
      throw new Error(`desktop app exited ${result}: ${output}`);
    }
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}${last ? `: ${last.message}` : ''}`);
}

const command = (method, path, body) => request(method, `/session/${session}${path}`, body);
const execute = (script, args = []) => command('POST', '/execute/sync', { script, args });
const present = (selector) => execute('return !!document.querySelector(arguments[0])', [selector]);
const selector = (id) => `[data-testid="${id}"]`;
async function findElement(css) {
  const element = await wait(css, () => command('POST', '/element', { using: 'css selector', value: css }));
  return element['element-6066-11e4-a52e-4f735466cecf'];
}

async function snapshot() {
  const frame = await command('POST', '/execute/async', { script: `
    const done = arguments[arguments.length - 1];
    window.__TAURI__.core.invoke('last_service_line').then(done, error => done({error:String(error)}));
  `, args: [] });
  assert.equal(typeof frame, 'string');
  const wire = JSON.parse(Buffer.from(frame.split('\t')[1], 'base64').toString('utf8'));
  return wire.snapshot ?? wire;
}

async function click(css) {
  const id = await findElement(css);
  await command('POST', `/element/${id}/click`, {});
}

async function typeText(css, text) {
  const id = await findElement(css);
  await command('POST', `/element/${id}/value`, { text, value: [...text] });
}

async function open() {
  if (embeddedDriver && (!applicationProcess || applicationProcess.exitCode !== null || applicationProcess.signalCode !== null)) {
    applicationError = undefined;
    applicationProcess = spawn(application, [], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    captureOutput(applicationProcess, (error) => { applicationError = error; });
  }
  const capabilities = embeddedDriver ? {} : { 'tauri:options': { application } };
  const value = await createNativeSession(request, wait, capabilities);
  session = value.sessionId;
  assert(session, 'WebDriver did not create a native app session');
  await wait('first real snapshot rendered', () => present(selector('overview')));
  await execute('if (!window.__TAURI__) throw new Error("native Tauri IPC missing"); return true');
}

async function waitForExit(child, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100);
  return child.exitCode !== null || child.signalCode !== null;
}

async function stopEmbeddedApplication() {
  const child = applicationProcess;
  if (!embeddedDriver || !child) return;
  if (session && child.exitCode === null && child.signalCode === null) {
    try {
      await command('POST', '/execute/async', { script: `
        const done = arguments[arguments.length - 1];
        window.__TAURI__.core.invoke('send_command', { command: 'quit' }).then(() => done(true), error => done({error:String(error)}));
      `, args: [] });
    } catch { /* The app may already be shutting down. */ }
  }
  if (!(await waitForExit(child))) {
    child.kill();
    await waitForExit(child, 5_000);
  }
  if (applicationProcess === child) applicationProcess = undefined;
}

async function checkNoServiceError() {
  const message = await execute(`return [...document.querySelectorAll('[role="alert"]')]
    .map((element) => element.textContent?.trim() ?? '').filter(Boolean).join('\\n')`);
  assert.equal(message, '', `native service error: ${message}`);
}

try {
  await open();
  const doctor = selector('overview.run-doctor');
  await click(doctor);
  await wait('Doctor report reached the webview and released its button', () => execute(`
    const report = document.querySelector('[data-testid="overview.doctor-summary"], [data-testid^="overview.doctor-finding."]');
    const button = document.querySelector(arguments[0]);
    return !!report && !!button && !button.disabled;
  `, [doctor]));
  await checkNoServiceError();
  const revision = (await snapshot()).revision;
  await click(selector('toolbar-refresh'));
  await wait('new engine snapshot after Doctor and refresh', async () => (await snapshot()).revision > revision);

  for (const [destination, pane] of [['apps', 'apps'], ['accounts', 'accounts'], ['proxyHub', 'proxy-hub'], ['proxies', 'proxies'], ['activity', 'activity'], ['backups', 'backups'], ['settings', 'settings-pane']]) {
    await click(selector(`sidebar-${destination}`));
    await wait(`${destination} pane rendered`, () => present(selector(pane)));
    await checkNoServiceError();
    if (destination === 'accounts') {
      const codex = (await snapshot()).accountProviders.find((provider) => provider.providerId === 'codex');
      assert.equal(codex?.livePresent, true, 'isolated Codex auth fixture was not detected as live');
      await click(selector('accounts-add'));
      await wait('Add Login sheet rendered', () => present(selector('account-flow.provider')));
      await click(selector('account-flow.provider.picker'));
      await click('[role="option"][data-value="codex"]');
      // Detect is a separate command from Save. Built inline without the name
      // account-detect requires, it was refused as MALFORMED_FRAME on every
      // install while every fake-bridge test passed.
      await click(selector('account-flow.detect'));
      await wait('real account-detect answered', () => execute(`
        const button = document.querySelector(arguments[0]);
        const card = document.querySelector(arguments[1]);
        return !!button && !button.disabled && !!card && !/Checking/.test(card.textContent ?? '');
      `, [selector('account-flow.detect'), selector('account-flow.identity')]));
      assert.equal(await present(selector('account-flow.error')), false, 'account-detect failed in the Add Login sheet');
      await checkNoServiceError();
      await typeText(selector('account-flow.name'), 'e2e-account');
      await click(selector('account-flow.save'));
      const saved = await wait('real Add Login account-save persisted in the engine', async () => {
        return (await snapshot()).accounts.find((account) => account.providerId === 'codex' && account.name === 'e2e-account');
      });
      assert(!saved.detail, 'account-save persisted the display hint as an account identity');
      await checkNoServiceError();
    }
    if (destination === 'backups') {
      const quickBackup = '[data-testid="backup-create-row"] button';
      await wait('Quick Backup enabled after Add Login', () => execute(`
        const button = document.querySelector(arguments[0]);
        return button && !button.disabled;
      `, [quickBackup]));
      await click(quickBackup);
      const notice = await wait('real Quick Backup completed and returned its destination', () => execute(`
        const notice = document.querySelector('[data-testid="notice"]');
        const text = notice?.querySelector('span.flex-1')?.textContent?.trim() ?? '';
        return text.startsWith('Saved 1 account to ') ? text : false;
      `));
      const match = notice.match(/^Saved 1 account to (.+)\. The file contains account credentials\.$/);
      assert(match, `unexpected Quick Backup result: ${notice}`);
      const backupPath = resolve(match[1]);
      assert(backupPath.startsWith(`${resolve(home)}${sep}`), 'Quick Backup escaped the isolated test home');
      await access(backupPath);
      await checkNoServiceError();
    }
    if (destination === 'activity') {
      const source = (await snapshot()).logSources.find((row) => row.providerId === 'codex' && row.name === 'e2e-account');
      assert(source, 'saved Codex account did not produce an Activity log source');
      await click(`${selector('activity-mode.picker')} button:nth-of-type(2)`);
      await wait('real Activity log response rendered for the stopped fixture proxy', () => execute(`
        const logs = document.querySelector('[data-testid="activity-logs"]');
        return Boolean(logs?.textContent?.includes(arguments[0]) && !logs.querySelector('svg'));
      `, [`${source.providerId}/${source.name}`]));
      await checkNoServiceError();
    }
  }
  const setting = `${selector('setting-showQuota')} [role="switch"]`;
  const before = await execute('return document.querySelector(arguments[0]).getAttribute("aria-checked")', [setting]);
  await click(setting);
  await wait('setting mutation answered', () => execute(`
    const button = document.querySelector(arguments[0]);
    return button && !button.disabled && button.getAttribute('aria-checked') !== arguments[1];
  `, [setting, before]));
  // Wait for the engine's snapshot, rather than accepting the switch's
  // optimistic local state as proof that persistence worked.
  await wait('setting persisted in the engine snapshot', async () => (await snapshot()).settings.showQuota === (before !== 'true'));
  await checkNoServiceError();
  if (embeddedDriver) {
    await stopEmbeddedApplication();
  } else {
    await command('DELETE', '');
    session = undefined;
  }
  await open();
  await click(selector('sidebar-settings'));
  await wait('persisted setting after a real app restart', () => execute(`
    const button = document.querySelector(arguments[0]);
    return button && button.getAttribute('aria-checked') !== arguments[1];
  `, [setting, before]));
  const reopenedAccount = (await snapshot()).accounts.find((account) => account.providerId === 'codex' && account.name === 'e2e-account');
  assert(reopenedAccount, 'account-save did not persist across app restart');
  assert(!reopenedAccount.detail, 'display hint became an account identity after app restart');
  await checkNoServiceError();
  console.log(`PASS native desktop E2E (${process.platform}): real webview -> Rust -> Go -> Doctor -> Add Login/account-save -> Activity/logs -> Quick Backup -> panes -> persisted setting and account -> app restart`);
} catch (error) {
  if (session) {
    try { console.error(await execute('return document.body.innerText')); } catch { /* Connection already closed. */ }
    try {
      const png = await command('GET', '/screenshot');
      const file = resolve(process.env.ANYPICK_E2E_SCREENSHOT ?? join(tmpdir(), `anypick-e2e-${process.platform}.png`));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, Buffer.from(png, 'base64'));
      console.error(`Failure screenshot: ${file}`);
    } catch { /* The native driver may already have closed the app. */ }
  }
  console.error(output);
  throw error;
} finally {
  if (embeddedDriver) await stopEmbeddedApplication();
  else if (session) { try { await command('DELETE', ''); } catch { /* Already exited. */ } }
  if (driver?.pid) {
    const exit = once(driver, 'exit').catch(() => {});
    try { process.kill(-driver.pid, 'SIGTERM'); } catch { /* Already exited. */ }
    await Promise.race([exit, delay(3000)]);
    try { process.kill(-driver.pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
