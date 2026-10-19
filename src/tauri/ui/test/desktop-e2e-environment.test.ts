import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { driverEnvironment, resolveExecutable } from '../scripts/desktop-e2e-environment.mjs';

const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })));

it('launches absolute tooling while keeping developer executables off the child PATH', async () => {
  const home = mkdtempSync(join(tmpdir(), 'anypick-e2e-env-'));
  homes.push(home);
  const tools = join(home, 'developer-tools');
  mkdirSync(tools);
  const name = process.platform === 'win32' ? 'tauri-driver.exe' : 'tauri-driver';
  writeFileSync(join(tools, name), 'driver marker', { mode: 0o700 });
  const parent = { ...process.env, PATH: `${tools}${delimiter}${process.env.PATH ?? ''}`, CODEX_HOME: '/real-login' };
  expect(await resolveExecutable(name, parent)).toBe(join(tools, name));
  const environment = driverEnvironment(home, parent);
  mkdirSync(environment.PATH);
  expect(Object.keys(environment).filter((key) => key.toUpperCase() === 'PATH')).toEqual(['PATH']);
  expect(environment.PATH).not.toContain(tools);
  expect(environment).not.toHaveProperty('CODEX_HOME');
  await expect(resolveExecutable(name, environment)).rejects.toThrow('was not found');

  // Starting an already resolved process must still work with the restricted
  // environment, while lookups performed by that process must fail closed.
  const result = execFileSync(process.execPath, ['-e', `
    const { spawnSync } = require('node:child_process');
    const names = ['node', 'go', 'cargo', 'rustc', 'swift', 'anypick-core'];
    console.log(JSON.stringify(names.map(name => spawnSync(name, ['--version']).error?.code)));
  `], { env: environment, encoding: 'utf8' });
  expect(JSON.parse(result)).toEqual(Array(6).fill('ENOENT'));
});

it('finds Windows native drivers through a case-insensitive Path key', async () => {
  const home = mkdtempSync(join(tmpdir(), 'anypick-driver-path-'));
  homes.push(home);
  const driver = join(home, 'msedgedriver.exe');
  writeFileSync(driver, 'driver marker', { mode: 0o700 });
  expect(await resolveExecutable('msedgedriver.exe', { Path: home }, 'win32')).toBe(driver);
});
