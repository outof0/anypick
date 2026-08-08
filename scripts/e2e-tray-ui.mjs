/**
 * Browser E2E for the tray React UI against the in-memory demo bridge.
 *
 * Uses Playwright against Vite. Never touches ~/.anypick.
 *
 * Env:
 *   ANYPICK_TRAY_UI_BASE   override base URL (skip local Vite)
 *   ANYPICK_TRAY_E2E_HEADED=1  show browser
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const headed = Boolean(process.env.ANYPICK_TRAY_E2E_HEADED);
const externalBase = process.env.ANYPICK_TRAY_UI_BASE;

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a free port'));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
    server.on('error', reject);
  });
}

async function waitForUrl(url, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok || response.status === 404) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

let vite;
let base = externalBase;

if (!base) {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  vite = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    [
      'exec',
      'vite',
      '--config',
      'src/tray/tauri/ui/vite.config.ts',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    },
  );
  const viteLog = [];
  vite.stdout.on('data', (chunk) => viteLog.push(chunk.toString()));
  vite.stderr.on('data', (chunk) => viteLog.push(chunk.toString()));
  try {
    await waitForUrl(base);
  } catch (error) {
    vite.kill('SIGTERM');
    throw new Error(`${error.message}\nVite log:\n${viteLog.join('')}`);
  }
  console.log(`e2e-tray-ui: Vite ready at ${base}`);
} else {
  console.log(`e2e-tray-ui: using ${base}`);
}

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 520, height: 720 } });
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

async function clickTab(name) {
  await page.getByRole('button', { name, exact: true }).click();
}

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'AnyPick' }).waitFor({ timeout: 15_000 });

  const footer = await page.locator('#footer-status').textContent();
  assert(
    Boolean(footer && (footer.includes('Demo data only') || /proxy|Ready|Updating/i.test(footer))),
    `unexpected footer: ${footer}`,
  );

  for (const tab of ['Apps', 'Proxies', 'Activity']) {
    await clickTab(tab);
  }

  await clickTab('Apps');
  await page.getByText('Claude Code').first().waitFor({ timeout: 10_000 });
  assert((await page.getByText('Claude Code').count()) > 0, 'Apps missing Claude Code');
  assert((await page.getByText('Proxy Hub').count()) > 0, 'Apps missing Proxy Hub');

  const switchBtn = page.locator('button.popup').filter({ hasText: 'Switch' }).first();
  if ((await switchBtn.count()) > 0) {
    await switchBtn.click();
    const dialog = page.locator('[role="dialog"]');
    try {
      await dialog.first().waitFor({ timeout: 3_000 });
      await page.keyboard.press('Escape');
      await dialog
        .first()
        .waitFor({ state: 'detached', timeout: 3_000 })
        .catch(() => {});
    } catch {
      // picker optional if fixture has no multi-route cards
    }
  }

  await clickTab('Proxies');
  await page.locator('.content').waitFor({ timeout: 5_000 });

  await clickTab('Activity');
  await page.getByText('Activity').first().waitFor({ timeout: 5_000 });

  await page.locator('#open-settings').click();
  await page.getByText('Open at Login').waitFor({ timeout: 5_000 });
  assert((await page.getByText('Quota Guard').count()) > 0, 'Settings missing Quota Guard');
  assert(
    (await page.getByText('Secrets stay in the supervisor').count()) > 0,
    'Settings missing security row',
  );

  await page.getByRole('button', { name: '‹ Back' }).click();
  await page.getByRole('button', { name: 'Apps', exact: true }).waitFor({ timeout: 5_000 });

  const manage = page.getByRole('button', { name: 'Manage…' });
  if ((await manage.count()) > 0) {
    await manage.click();
  } else {
    await page.getByRole('button', { name: '＋ Add account' }).click();
  }
  const manageText = await page.locator('.content').innerText();
  assert(
    /Saved accounts|Add native account|Gateways|Provider|accounts/i.test(manageText),
    `Saved accounts view unexpected: ${manageText.slice(0, 120)}`,
  );

  await page.getByRole('button', { name: '⌁ Quit' }).click();
  await page.locator('.notice').waitFor({ timeout: 5_000 });
  const notice = (await page.locator('.notice').textContent()) || '';
  assert(/demo|quit/i.test(notice), `unexpected quit notice: ${notice}`);

  await page.goto(`${base}/?empty`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'AnyPick' }).waitFor({ timeout: 10_000 });
  const emptyText = await page.locator('.content').innerText();
  assert(emptyText.length > 0, `empty fixture unexpected: ${emptyText.slice(0, 120)}`);

  console.log(`e2e-tray-ui: assertions=${failures.length === 0 ? 'pass' : 'fail'}`);
  if (failures.length) {
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    throw new Error(`${failures.length} UI assertion(s) failed`);
  }
  console.log('e2e-tray-ui: ok');
} finally {
  await browser.close().catch(() => {});
  if (vite) {
    vite.kill('SIGTERM');
    setTimeout(() => {
      try {
        vite.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 800).unref?.();
  }
}
