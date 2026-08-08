/**
 * Interactive session: root command-center launcher + Clack wizards for subflows.
 *
 * Root UI uses @clack/core custom render (no rails).
 * Wizards use @clack/prompts (password, confirm, select, text).
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { AnyPickApp } from '../core/app';
import { isAnyPickError, ExitCode } from '../utils/errors';
import { openRootLauncher, installLauncherSigint } from './launcher';
import { MARK } from './ux';
import type { LauncherAction } from './launcher-model';
import { launchClient } from './launch-client';
import { wizardAddAccount } from './interactive-accounts';
import { wizardDoctor, wizardViewDetails } from './interactive-maintenance';

function isCancel(value: unknown): boolean {
  return p.isCancel(value);
}

/**
 * Bare `anypick` entry (TTY).
 */
export async function runInteractive(app: AnyPickApp): Promise<void> {
  const removeSig = installLauncherSigint();
  let previousActionId: string | undefined;

  try {
    while (true) {
      const result = await openRootLauncher(app, { previousActionId });

      if (result.kind === 'quit') {
        process.exitCode = result.exitCode;
        return;
      }

      previousActionId = result.action.id;
      const done = await dispatchAction(app, result.action);
      if (done === 'exit') {
        return;
      }
      // otherwise rebuild launcher (selection restored via previousActionId)
    }
  } finally {
    removeSig();
  }
}

type DispatchResult = 'continue' | 'exit';

async function dispatchAction(app: AnyPickApp, action: LauncherAction): Promise<DispatchResult> {
  try {
    switch (action.kind) {
      case 'run': {
        if (!action.clientId) {
          return 'continue';
        }
        const code = await launchClient(app, action.clientId, {});
        process.exitCode = code;
        return 'exit';
      }

      case 'fix-attention': {
        // Guide user through re-binding the broken client
        if (action.clientId) {
          await wizardChangeDefault(app, action.clientId);
        } else {
          await wizardChangeDefault(app);
        }
        return 'continue';
      }

      case 'change-default':
        await wizardChangeDefault(app);
        return 'continue';

      case 'connect-client':
        await wizardChangeDefault(app, action.clientId);
        return 'continue';

      case 'add-connection':
        await wizardAddConnection(app);
        return 'continue';

      case 'add-account':
        await wizardAddAccount(app.accounts);
        return 'continue';

      case 'add-gateway':
        await wizardAddGateway(app);
        return 'continue';

      case 'link':
        await wizardLink(app);
        return 'continue';

      case 'view-details':
        await wizardViewDetails(app);
        return 'continue';

      case 'doctor':
        await wizardDoctor(app);
        return 'continue';

      default:
        return 'continue';
    }
  } catch (err) {
    // Wizards use clack; print error cleanly then return to launcher
    const msg = isAnyPickError(err)
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
    console.error(pc.red(`${MARK.fail} ${msg}`));
    return 'continue';
  }
}

// ── Wizards (@clack/prompts) ─────────────────────────────────────

async function wizardChangeDefault(app: AnyPickApp, preselectedClient?: string): Promise<void> {
  const { bindingService, clients } = app;
  let client = preselectedClient;

  if (!client) {
    const picked = await p.select({
      message: 'Which client?',
      options: clients.list().map((c) => {
        const b = app.bindings.getGlobal(c.id);
        return {
          value: c.id,
          label: c.name,
          hint: b
            ? b.spec.source.kind === 'account'
              ? `${b.spec.source.provider}/${b.spec.source.name}`
              : b.spec.source.kind === 'gateway'
                ? b.spec.source.name
                : undefined
            : 'unbound',
        };
      }),
    });
    if (isCancel(picked) || typeof picked !== 'string') {
      return;
    }
    client = picked;
  }

  const source = await pickSource(app, client);
  if (!source) {
    return;
  }

  const s = p.spinner();
  s.start(`Configuring ${client}…`);
  try {
    const result = await bindingService.use(client, { with: source });
    if (result.alreadyActive) {
      s.stop('Already active');
    } else {
      s.stop(`${clients.get(client).name} → ${result.plan.resolvedSource.display}`);
    }
  } catch (err) {
    s.stop('Failed');
    throw err;
  }
}

async function pickSource(app: AnyPickApp, client: string): Promise<string | null> {
  const options: { value: string; label: string; hint?: string }[] = [];

  for (const a of await app.accounts.list()) {
    options.push({
      value: `${a.provider}/${a.name}`,
      label: `${a.provider}/${a.name}`,
      hint: a.identity ?? 'account',
    });
  }
  for (const g of await app.profiles.list()) {
    options.push({
      value: g.meta.name,
      label: g.meta.name,
      hint: `gateway · ${g.meta.provider}`,
    });
  }
  for (const pr of app.presets.list()) {
    if (pr.spec.client === client) {
      options.push({
        value: `@${pr.name}`,
        label: `@${pr.name}`,
        hint: 'preset',
      });
    }
  }
  options.push({
    value: '__type__',
    label: 'Type a source…',
    hint: 'provider/name or gateway',
  });

  const picked = await p.select({
    message: `What should ${client} use?`,
    options,
  });
  if (isCancel(picked) || typeof picked !== 'string') {
    return null;
  }
  if (picked === '__type__') {
    const source = await p.text({
      message: 'Source',
      placeholder: 'grok/work  ·  openrouter-work  ·  @preset',
      validate: (v) => (v?.trim() ? undefined : 'Required'),
    });
    if (isCancel(source) || !source) {
      return null;
    }
    return String(source).trim();
  }
  return picked;
}

async function wizardAddConnection(app: AnyPickApp): Promise<void> {
  const kind = await p.select({
    message: 'Add connection',
    options: [
      { value: 'account', label: 'Account', hint: 'native login snapshot' },
      { value: 'gateway', label: 'Gateway', hint: 'API endpoint + key' },
    ],
  });
  if (isCancel(kind)) {
    return;
  }
  if (kind === 'account') {
    await wizardAddAccount(app.accounts);
  } else {
    await wizardAddGateway(app);
  }
}

async function wizardAddGateway(app: AnyPickApp): Promise<void> {
  const { profiles, catalog, bindingService, clients } = app;
  const name = await p.text({
    message: 'Gateway name',
    placeholder: 'openrouter-work',
    validate: (v) => (v?.trim() ? undefined : 'Required'),
  });
  if (isCancel(name)) {
    return;
  }

  const provider = await p.select({
    message: 'Provider',
    options: catalog.list().map((c) => ({
      value: c.id,
      label: c.name,
      hint: c.id,
    })),
  });
  if (isCancel(provider)) {
    return;
  }

  const cat = catalog.get(provider as string);
  const endpoint = await p.text({
    message: 'Endpoint',
    initialValue: cat.defaultEndpoint ?? '',
  });
  if (isCancel(endpoint)) {
    return;
  }

  const apiKey = await p.password({
    message: 'API key',
  });
  if (isCancel(apiKey)) {
    return;
  }

  const model = await p.text({
    message: 'Default model (optional)',
    placeholder: 'claude-sonnet-4',
  });
  if (isCancel(model)) {
    return;
  }

  const created = await profiles.create(name as string, {
    provider: provider as string,
    endpoint: (endpoint as string) || undefined,
    apiKey: typeof apiKey === 'string' ? apiKey : undefined,
    defaultModel: typeof model === 'string' && model.trim() ? model.trim() : undefined,
  });
  p.log.success(`Gateway ${created.meta.name} created`);

  const useNow = await p.confirm({
    message: 'Set as Claude default now?',
    initialValue: true,
  });
  if (!isCancel(useNow) && useNow) {
    const result = await bindingService.use('claude', { with: created.meta.name });
    p.log.success(`${clients.get('claude').name} → ${result.plan.resolvedSource.display}`);
  } else {
    p.log.message(pc.dim(`  anypick use claude --with ${created.meta.name}`));
  }
}

async function wizardLink(app: AnyPickApp): Promise<void> {
  const client = await p.select({
    message: 'Link which client?',
    options: app.clients.list().map((c) => ({
      value: c.id,
      label: c.name,
    })),
  });
  if (isCancel(client) || typeof client !== 'string') {
    return;
  }

  const custom = await p.confirm({
    message: 'Use a different source than the global binding?',
    initialValue: false,
  });
  if (isCancel(custom)) {
    return;
  }

  let source: string | undefined;
  if (custom) {
    const picked = await pickSource(app, client);
    if (!picked) {
      return;
    }
    source = picked;
  }

  const result = await app.bindingService.link(client, { with: source });
  p.log.success(`Linked ${client} → ${result.plan.resolvedSource.display} (project)`);
}

// re-export for tests
export { ExitCode };
