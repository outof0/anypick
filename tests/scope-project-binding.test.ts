import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppReady } from '../src/core/app';
import { ClientRegistry } from '../src/clients/registry';
import { createClaudeCodeClient } from '../src/clients/claude-code';

// SCOPE-01: a project binding (`link`) records project-scoped metadata only.
// It must NOT write the global live client config (e.g. ~/.claude/settings.json).
// `run` inside the project resolves the binding into an isolated ephemeral
// session; the global client home stays untouched.

describe('project binding scope isolation', () => {
  let root: string;
  let home: string;
  let project: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hotplug-scope-'));
    home = await mkdtemp(join(tmpdir(), 'hotplug-scope-home-'));
    project = await mkdtemp(join(tmpdir(), 'hotplug-scope-proj-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  async function seedGateway(app: Awaited<ReturnType<typeof createAppReady>>): Promise<void> {
    await app.profiles.create('openrouter-work', {
      provider: 'openrouter',
      endpoint: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      defaultModel: 'claude-sonnet-5',
    });
  }

  it('link records a project binding and leaves the global client config untouched', async () => {
    const clients = new ClientRegistry();
    clients.register(createClaudeCodeClient(home));
    const app = await createAppReady({ root, skipMigrate: true, clients });

    await seedGateway(app);

    // Pre-existing unrelated global client config (must survive link).
    const settingsPath = join(home, '.claude', 'settings.json');
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: { MY_GLOBAL_VAR: 'keep-me', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
      }),
      { mode: 0o600 },
    );

    await app.bindingService.link('claude', { with: 'openrouter-work', cwd: project });

    // Project binding exists
    const projectBinding = app.bindings.getProject(project, 'claude');
    expect(projectBinding).toBeTruthy();
    expect(projectBinding?.spec.source.kind).toBe('gateway');

    // No global binding was created
    expect(app.bindings.getGlobal('claude') ?? undefined).toBeUndefined();

    // Global client config is byte-for-byte equivalent (no managed keys added)
    const after = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    expect(after.env).toEqual({
      MY_GLOBAL_VAR: 'keep-me',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    });
    expect(JSON.stringify(after)).not.toContain('HOTPLUG_MANAGED');
  });

  it('link from a global binding records a project binding and still leaves global config untouched', async () => {
    const clients = new ClientRegistry();
    clients.register(createClaudeCodeClient(home));
    const app = await createAppReady({ root, skipMigrate: true, clients });

    await seedGateway(app);
    await app.bindingService.use('claude', { with: 'openrouter-work' });

    const settingsPath = join(home, '.claude', 'settings.json');
    const beforeRaw = await readFile(settingsPath, 'utf8');

    await app.bindingService.link('claude', { cwd: project });

    const projectBinding = app.bindings.getProject(project, 'claude');
    expect(projectBinding).toBeTruthy();
    // The global config that `use` wrote is preserved except for the marker
    // timestamp — link must NOT rewrite global client env keys.
    const afterRaw = await readFile(settingsPath, 'utf8');
    const afterEnv = JSON.parse(afterRaw).env;
    const beforeEnv = JSON.parse(beforeRaw).env;
    expect(afterEnv).toEqual(beforeEnv);
  });

  it('run inside a linked project resolves the binding into an isolated session (no global write)', async () => {
    const clients = new ClientRegistry();
    clients.register(createClaudeCodeClient(home));
    const app = await createAppReady({ root, skipMigrate: true, clients });

    await seedGateway(app);
    await app.bindingService.link('claude', { with: 'openrouter-work', cwd: project });

    const settingsPath = join(home, '.claude', 'settings.json');
    const beforeRaw = (await fileMaybe(settingsPath)) ?? '{}';

    const result = await app.bindingService.runPrepare('claude', { cwd: project });
    expect(result.plan.mode).toBe('ephemeral');
    expect(result.isolated).toBeDefined();
    expect(result.isolated?.directory).toBeTruthy();

    const afterRaw = (await fileMaybe(settingsPath)) ?? '{}';
    expect(afterRaw).toBe(beforeRaw);

    // Cleanup removes the isolated dir
    await result.isolated?.cleanup();
    const { pathExists } = await import('../src/utils/fs');
    expect(await pathExists(result.isolated!.directory)).toBe(false);
  });
});

async function fileMaybe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
