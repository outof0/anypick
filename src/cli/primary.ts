/**
 * Primary DX command surface (spec §5): use, run, current, list, add, link, unlink, reset.
 */

import { Command } from 'commander';
import type { AnyPickApp } from '../core/app';
import type { ResolvedTransport } from '../types';
import { parseNativeAccountShorthand, displayRef } from '../core/refs';
import { resolveProjectRoot } from '../core/project-root';
import { ExitCode, anypickError } from '../utils/errors';
import { formatModel, formatUseSuccess, handleCliError } from './errors';
import { MARK, info, success, warn } from './ux';
import pc from 'picocolors';

export interface GlobalOpts {
  json?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  reveal?: boolean;
  quiet?: boolean;
  /** Commander exposes a negated --no-input option as `input: false`. */
  input?: boolean;
  yes?: boolean;
  trace?: boolean;
}

function canPrompt(g: GlobalOpts): boolean {
  return (
    Boolean(process.stdin.isTTY && process.stderr.isTTY) &&
    !g.json &&
    g.input !== false &&
    !process.env.CI
  );
}

function printDryRun(
  g: GlobalOpts,
  action: string,
  detail: string,
  extra?: Record<string, unknown>,
): void {
  if (g.json) {
    console.log(JSON.stringify({ dryRun: true, action, ...extra }));
  } else {
    info(`[dry-run] ${detail}`);
  }
}

const API_KEY_INPUT = 'api-key';

/**
 * Save an API key as an account. The key is credential material the user holds
 * rather than a login on this machine, so there is nothing to detect, stash, or
 * restore — the account exists only to be served through the provider's proxy.
 */
async function addApiKeyAccount(
  accounts: AnyPickApp['accounts'],
  provider: string,
  opts: {
    name?: string;
    current?: boolean;
    new?: boolean;
    apiKey?: string | boolean;
    region?: string;
  },
  g: GlobalOpts,
): Promise<void> {
  if (opts.current || opts.new) {
    throw anypickError(
      '--api-key saves a key you already hold; drop --current and --new.',
      'INVALID_USAGE',
      { exitCode: ExitCode.INVALID_USAGE },
    );
  }
  if (opts.apiKey == null) {
    throw anypickError('--region only applies together with --api-key.', 'INVALID_USAGE', {
      exitCode: ExitCode.INVALID_USAGE,
    });
  }

  const target = accounts.provider(provider);
  if (!target.credentialInputs?.includes(API_KEY_INPUT)) {
    throw anypickError(`Provider "${provider}" does not accept an API key.`, 'INVALID_USAGE', {
      exitCode: ExitCode.INVALID_USAGE,
    });
  }

  let secret = typeof opts.apiKey === 'string' ? opts.apiKey.trim() : '';
  if (!secret) {
    if (!canPrompt(g)) {
      throw anypickError(
        `An API key is required.\n\n  anypick add account ${provider} --api-key <key> --name work`,
        'INVALID_USAGE',
        { exitCode: ExitCode.INVALID_USAGE },
      );
    }
    const { isCancel, password } = await import('@clack/prompts');
    const entered = await password({ message: `${target.name} API key` });
    if (isCancel(entered) || !entered.trim()) {
      process.exit(ExitCode.CANCELLED);
    }
    secret = entered.trim();
  }

  const name = opts.name ?? API_KEY_INPUT;
  if (g.dryRun) {
    printDryRun(g, 'account.save', `Would save ${provider}/${name} from an API key`, {
      provider,
      name,
      mode: API_KEY_INPUT,
    });
    return;
  }

  const meta = await accounts.save(provider, name, {
    force: true,
    input: {
      kind: API_KEY_INPUT,
      secret,
      ...(opts.region ? { options: { region: opts.region } } : {}),
    },
  });
  if (g.json) {
    console.log(JSON.stringify({ saved: meta, mode: API_KEY_INPUT }));
  } else {
    success(`Saved ${provider}/${meta.name}`);
  }
}

function transportLabel(plan: {
  transport: {
    capability: string;
    endpoint?: string;
    managedProxy?: { port: number };
  };
}): string {
  const t = plan.transport;
  switch (t.capability) {
    case 'direct':
      return t.endpoint ? `direct · ${t.endpoint}` : 'direct';
    case 'managed_builtin_proxy':
      return `managed proxy · ${t.endpoint ?? `127.0.0.1:${t.managedProxy?.port ?? '?'}`}`;
    case 'managed_external_proxy':
      return `managed external proxy · ${t.endpoint ?? ''}`;
    case 'external_manual_proxy':
      return 'external proxy (manual)';
    default:
      return t.capability;
  }
}

/** Serialize transport metadata without bearer/API secrets or lease internals. */
function publicTransport(transport: ResolvedTransport): Omit<ResolvedTransport, 'managedProxy'> & {
  managedProxy?: Omit<NonNullable<ResolvedTransport['managedProxy']>, 'token' | 'leaseId'>;
} {
  const { managedProxy, ...rest } = transport;
  return {
    ...rest,
    ...(managedProxy
      ? {
          managedProxy: {
            provider: managedProxy.provider,
            ...(managedProxy.account ? { account: managedProxy.account } : {}),
            port: managedProxy.port,
          },
        }
      : {}),
  };
}

export function registerPrimaryCommands(
  program: Command,
  app: AnyPickApp,
  globals: () => GlobalOpts,
): void {
  const { bindingService, clients, accounts, profiles, presets, bindings } = app;

  // ── use ────────────────────────────────────────────────────────
  program
    .command('use')
    .description('Set what a client uses by default')
    .argument('[client]', 'Client id (claude, codex, kiro)')
    .option('--with <source>', 'Account (provider/name), gateway, or @preset')
    .option('--current', 'Re-apply the stored global binding', false)
    .option('--model <model>', 'Explicit model id')
    .option('--save <name>', 'Also save as a named preset')
    .action(
      async (
        clientArg: string | undefined,
        opts: {
          with?: string;
          current?: boolean;
          model?: string;
          save?: string;
        },
      ) => {
        try {
          const g = globals();
          let client = clientArg;
          let withSource = opts.with;

          // Native shorthand: anypick use codex/personal
          if (client && !withSource && !opts.current && client.includes('/')) {
            const sh = parseNativeAccountShorthand(client, {
              accountProviders: new Set(app.accountRegistry.ids()),
              clientIds: new Set(clients.ids()),
            });
            if (sh) {
              client = sh.client;
              withSource = displayRef(sh.source);
            }
          }

          if (!client) {
            if (canPrompt(g)) {
              // Interactive: pick client then source — minimal for now
              const { select } = await import('@clack/prompts');
              const picked = await select({
                message: 'Which client?',
                options: clients.list().map((c) => ({
                  value: c.id,
                  label: c.name,
                })),
              });
              if (typeof picked !== 'string') {
                process.exit(ExitCode.CANCELLED);
              }
              client = picked;
            } else {
              throw anypickError(
                'A client is required.\n\nTry:\n  anypick use claude --with grok/work',
                'MISSING_CLIENT',
                {
                  exitCode: ExitCode.INVALID_USAGE,
                  suggestions: ['anypick use claude --with grok/work'],
                },
              );
            }
          }

          // TTY bare client: allow re-apply or picker via allowMissingSource
          const ttyBare = !withSource && !opts.current && canPrompt(g);

          let result;
          try {
            result = await bindingService.use(client, {
              with: withSource,
              current: opts.current,
              model: opts.model,
              save: opts.save,
              dryRun: g.dryRun,
              verbose: g.verbose,
              allowMissingSource: ttyBare,
            });
          } catch (err) {
            // TTY: no binding → open source picker then retry
            if (
              ttyBare &&
              err &&
              typeof err === 'object' &&
              'details' in err &&
              (err as { details?: { needsPicker?: boolean } }).details?.needsPicker
            ) {
              const { select, text } = await import('@clack/prompts');
              const kind = await select({
                message: `What should ${clients.get(client).name} use?`,
                options: [
                  { value: 'account', label: 'An account (provider/name)' },
                  { value: 'gateway', label: 'A gateway' },
                  { value: 'preset', label: 'A preset (@name)' },
                ],
              });
              if (typeof kind !== 'string') {
                process.exit(ExitCode.CANCELLED);
              }
              if (kind === 'preset') {
                const name = await text({ message: 'Preset name (without @)' });
                if (typeof name !== 'string') {
                  process.exit(ExitCode.CANCELLED);
                }
                withSource = `@${name}`;
              } else {
                const raw = await text({
                  message: kind === 'account' ? 'Account (provider/name)' : 'Gateway name',
                });
                if (typeof raw !== 'string') {
                  process.exit(ExitCode.CANCELLED);
                }
                withSource = raw;
              }
              result = await bindingService.use(client, {
                with: withSource,
                model: opts.model,
                save: opts.save,
                dryRun: g.dryRun,
                verbose: g.verbose,
              });
            } else {
              throw err;
            }
          }

          if (g.json) {
            console.log(
              JSON.stringify({
                client,
                source: result.plan.resolvedSource.display,
                model: result.plan.model,
                transport: publicTransport(result.plan.transport),
                alreadyActive: result.alreadyActive,
                dryRun: result.dryRun,
                savedPreset: result.savedPreset,
                steps: g.verbose ? result.plan.steps.map((s) => s.kind) : undefined,
              }),
            );
            return;
          }

          if (result.dryRun) {
            info('Dry run — plan only:');
            for (const step of result.plan.steps) {
              console.log(`  · ${step.kind}${step.detail ? ` — ${step.detail}` : ''}`);
            }
            return;
          }

          const clientName = clients.get(client).name;
          const endpoint = result.proxyEndpoint ?? result.plan.transport.endpoint ?? undefined;
          if (result.alreadyActive) {
            success(
              formatUseSuccess({
                clientName,
                sourceDisplay: result.plan.resolvedSource.display,
                alreadyActive: true,
                model: formatModel(result.plan.model),
                transport: transportLabel(result.plan),
                configEndpoint: endpoint,
                savedPreset: result.savedPreset,
              }),
            );
            return;
          }

          success(
            formatUseSuccess({
              clientName,
              sourceDisplay: result.plan.resolvedSource.display,
              model: formatModel(result.plan.model),
              transport: transportLabel(result.plan),
              configEndpoint: endpoint,
              scope: 'global default',
              savedPreset: result.savedPreset,
            }),
          );
        } catch (err) {
          handleCliError(err);
        }
      },
    );

  // ── run ────────────────────────────────────────────────────────
  program
    .command('run')
    .description('Launch a client with its effective AnyPick binding')
    .argument('[client]', 'Client id')
    .option('--with <source>', 'Temporary source override')
    .option('--model <model>', 'Explicit model id')
    .allowUnknownOption(true)
    .action(
      async (
        clientArg: string | undefined,
        opts: { with?: string; model?: string },
        cmd: Command,
      ) => {
        try {
          const g = globals();
          let client = clientArg;

          // Pass-through args after --
          const raw = cmd.args;
          // commander puts remainder differently; use process.argv after --
          const dd = process.argv.indexOf('--');
          const childArgs = dd >= 0 ? process.argv.slice(dd + 1) : [];

          if (!client) {
            if (canPrompt(g)) {
              const { select } = await import('@clack/prompts');
              const options = clients.list().map((c) => {
                const b = bindings.getGlobal(c.id);
                return {
                  value: c.id,
                  label: b ? `${c.name} · ${displayRef(b.spec.source)}` : `${c.name} · no binding`,
                };
              });
              const picked = await select({
                message: 'Which client?',
                options,
              });
              if (typeof picked !== 'string') {
                process.exit(ExitCode.CANCELLED);
              }
              client = picked;
            } else {
              throw anypickError(
                'A client is required.\n\nTry:\n  anypick run claude\n  anypick run codex',
                'MISSING_CLIENT',
                {
                  exitCode: ExitCode.INVALID_USAGE,
                  suggestions: ['anypick run claude', 'anypick run codex'],
                },
              );
            }
          }

          // Ignore unknown clientArg when it's actually a flag remnant
          void raw;

          const { launchClient } = await import('./launch-client');
          const code = await launchClient(app, client, {
            with: opts.with,
            model: opts.model,
            dryRun: g.dryRun,
            verbose: g.verbose,
            json: g.json,
            childArgs,
          });
          process.exit(code);
        } catch (err) {
          handleCliError(err);
        }
      },
    );

  // ── current ────────────────────────────────────────────────────
  program
    .command('current')
    .description('Show effective AnyPick bindings')
    .argument('[client]', 'Optional client filter')
    .action(async (clientArg: string | undefined) => {
      try {
        const g = globals();
        const rows = bindingService.current(clientArg);
        if (g.json) {
          console.log(
            JSON.stringify(
              {
                projectRoot: resolveProjectRoot(),
                clients: rows.map((r) => ({
                  client: r.client,
                  name: r.clientName,
                  scope: r.scope,
                  source: r.binding ? displayRef(r.binding.spec.source) : null,
                  model: r.binding?.spec.model ?? null,
                  provenance: r.binding?.provenance ?? null,
                })),
              },
              null,
              2,
            ),
          );
          return;
        }

        if (rows.length === 0) {
          info('No clients registered.');
          return;
        }

        console.log(pc.bold('AnyPick current'));
        console.log(pc.dim(`Project root: ${resolveProjectRoot()}`));
        console.log();
        for (const r of rows) {
          console.log(pc.bold(r.clientName) + pc.dim(` (${r.client})`));
          if (!r.binding) {
            console.log(pc.dim('  No AnyPick binding'));
            console.log(pc.dim(`  Set one: anypick use ${r.client} --with <source>`));
          } else {
            console.log(`  Source   ${displayRef(r.binding.spec.source)}`);
            console.log(`  Model    ${formatModel(r.binding.spec.model)}`);
            console.log(`  Scope    ${r.scope}`);
          }
          console.log();
        }
      } catch (err) {
        handleCliError(err);
      }
    });

  // ── list ───────────────────────────────────────────────────────
  program
    .command('list')
    .alias('ls')
    .description('List accounts, gateways, clients, or presets')
    .argument('[kind]', 'accounts | gateways | clients | presets')
    .action(async (kind: string | undefined) => {
      try {
        const g = globals();
        const k = (kind ?? 'all').toLowerCase();

        if (g.json) {
          const payload: Record<string, unknown> = {};
          if (k === 'all' || k === 'accounts') {
            payload.accounts = await accounts.list();
          }
          if (k === 'all' || k === 'gateways') {
            payload.gateways = (await profiles.list()).map((p) => ({
              name: p.meta.name,
              provider: p.meta.provider,
              endpoint: p.meta.endpoint,
              defaultModel: p.meta.defaultModel,
            }));
          }
          if (k === 'all' || k === 'clients') {
            payload.clients = clients.list().map((c) => ({
              id: c.id,
              name: c.name,
              binding: bindings.getGlobal(c.id)
                ? displayRef(bindings.getGlobal(c.id)!.spec.source)
                : null,
            }));
          }
          if (k === 'all' || k === 'presets') {
            payload.presets = presets.list().map((p) => ({
              name: p.name,
              client: p.spec.client,
              source: displayRef(p.spec.source),
              revision: p.revision,
            }));
          }
          console.log(JSON.stringify(payload, null, 2));
          return;
        }

        if (k === 'all' || k === 'accounts') {
          console.log(pc.bold('Accounts'));
          const list = await accounts.list();
          if (list.length === 0) {
            console.log(pc.dim('  (none)'));
          }
          for (const a of list) {
            const mark = a.active ? pc.green(MARK.live) : ' ';
            console.log(
              `  ${mark} ${a.provider}/${a.name}${a.identity ? pc.dim(` · ${a.identity}`) : ''}`,
            );
          }
          console.log();
        }
        if (k === 'all' || k === 'gateways') {
          console.log(pc.bold('Gateways'));
          const list = await profiles.list();
          if (list.length === 0) {
            console.log(pc.dim('  (none)'));
          }
          for (const p of list) {
            console.log(
              `    ${p.meta.name}${pc.dim(` · ${p.meta.provider}`)}${p.meta.defaultModel ? pc.dim(` · ${p.meta.defaultModel}`) : ''}`,
            );
          }
          console.log();
        }
        if (k === 'all' || k === 'clients') {
          console.log(pc.bold('Clients'));
          for (const c of clients.list()) {
            const b = bindings.getGlobal(c.id);
            console.log(
              `    ${c.name}${pc.dim(` (${c.id})`)}${b ? ` → ${displayRef(b.spec.source)}` : pc.dim(' · unbound')}`,
            );
          }
          console.log();
        }
        if (k === 'all' || k === 'presets') {
          console.log(pc.bold('Presets'));
          const list = presets.list();
          if (list.length === 0) {
            console.log(pc.dim('  (none)'));
          }
          for (const p of list) {
            console.log(
              `    @${p.name}${pc.dim(` · ${p.spec.client} · ${displayRef(p.spec.source)}`)}`,
            );
          }
        }
      } catch (err) {
        handleCliError(err);
      }
    });

  // ── add ────────────────────────────────────────────────────────
  const add = program.command('add').description('Add an account or gateway');

  add
    .command('account')
    .description('Add a saved account login')
    .argument('[provider]', 'Auth provider (codex, grok, …)')
    .option('--current', 'Save the currently live login', false)
    .option('--new', 'Start a new login flow', false)
    .option('--name <name>', 'Account name')
    .option('--source <source>', 'Gemini sign-in source: gemini-cli|antigravity')
    .option('--api-key [key]', 'Save an API key instead of a login; omit the value to be prompted')
    .option('--region <region>', 'API region for --api-key')
    .action(
      async (
        provider: string | undefined,
        opts: {
          current?: boolean;
          new?: boolean;
          name?: string;
          source?: string;
          apiKey?: string | boolean;
          region?: string;
        },
      ) => {
        try {
          const g = globals();
          if (!provider) {
            if (!canPrompt(g)) {
              throw anypickError(
                'Provider required.\n\n  anypick add account codex --current --name personal',
                'INVALID_USAGE',
                { exitCode: ExitCode.INVALID_USAGE },
              );
            }
            const { select } = await import('@clack/prompts');
            const picked = await select({
              message: 'Provider?',
              options: accounts.listProviders().map((p) => ({
                value: p.id,
                label: p.name,
              })),
            });
            if (typeof picked !== 'string') {
              process.exit(ExitCode.CANCELLED);
            }
            provider = picked;
          }

          if (opts.current && opts.new) {
            throw anypickError('--current and --new are mutually exclusive.', 'INVALID_USAGE', {
              exitCode: ExitCode.INVALID_USAGE,
            });
          }

          if (opts.apiKey != null || opts.region != null) {
            await addApiKeyAccount(accounts, provider, opts, g);
            return;
          }

          if (opts.source && opts.source !== 'gemini-cli' && opts.source !== 'antigravity') {
            throw anypickError(
              `Unknown source "${opts.source}". Use gemini-cli or antigravity.`,
              'INVALID_USAGE',
              { exitCode: ExitCode.INVALID_USAGE },
            );
          }
          const source = opts.source as 'gemini-cli' | 'antigravity' | undefined;
          if (source && !accounts.provider(provider).detectLiveSource) {
            throw anypickError(
              `Provider "${provider}" has a single sign-in source; drop --source.`,
              'INVALID_USAGE',
              { exitCode: ExitCode.INVALID_USAGE },
            );
          }

          if (!opts.current && !opts.new) {
            if (!canPrompt(g)) {
              throw anypickError(
                `Choose how to add the ${provider} account.\n\nSave the current login:\n  anypick add account ${provider} --current --name personal\n\nAdd another login:\n  anypick add account ${provider} --new --name work`,
                'INVALID_USAGE',
                { exitCode: ExitCode.INVALID_USAGE },
              );
            }
            const { select } = await import('@clack/prompts');
            const target = accounts.provider(provider);
            const live =
              source && target.detectLiveSource
                ? await target.detectLiveSource(source)
                : await target.detectLive();
            const label = source ?? provider;
            const choice = await select({
              message: live.present
                ? `${label} is currently logged in${live.identity ? ` as ${live.identity}` : ''}.\nWhat do you want to do?`
                : `No live ${label} login detected. What do you want to do?`,
              options: [
                { value: 'new', label: 'Add another account' },
                ...(live.present ? [{ value: 'current', label: 'Save the current account' }] : []),
                { value: 'cancel', label: 'Cancel' },
              ],
            });
            if (choice === 'cancel' || typeof choice !== 'string') {
              process.exit(ExitCode.CANCELLED);
            }
            if (choice === 'current') {
              opts.current = true;
            } else {
              opts.new = true;
            }
          }

          if (opts.current) {
            // A non-default source has no ~/.gemini identity to derive a name from.
            const name = source
              ? (opts.name ?? source)
              : await accounts.resolveCurrentSaveName(provider, opts.name);
            if (g.dryRun) {
              printDryRun(
                g,
                'account.save',
                `Would save ${provider}/${name} from the current login`,
                {
                  provider,
                  name,
                  mode: 'current',
                  ...(source ? { source } : {}),
                },
              );
              return;
            }
            const meta = source
              ? await accounts.save(provider, name, { force: true, source })
              : await accounts.saveCurrent(provider, name);
            if (g.json) {
              console.log(JSON.stringify({ saved: meta, mode: 'current' }));
            } else {
              success(`Saved ${provider}/${meta.name}`);
            }
            return;
          }

          if (opts.new) {
            const label = source ?? provider;
            const nextName = opts.name ?? (source === 'antigravity' ? 'antigravity-2' : 'work');
            const next = `anypick add account ${provider} --current --name ${nextName}${
              source ? ` --source ${source}` : ''
            }`;
            if (g.dryRun) {
              printDryRun(
                g,
                'account.stash',
                `Would clear the live ${label} login and start a new flow`,
                {
                  provider,
                  name: nextName,
                  mode: 'new',
                  ...(source ? { source } : {}),
                },
              );
              return;
            }
            // stash current, clear, let user login externally, then save
            await accounts.stash(provider, { source });
            if (!g.json) {
              info(
                `Live ${label} auth cleared. Log in with the official tool, then re-run:\n  ${next}`,
              );
            } else {
              console.log(JSON.stringify({ mode: 'new', next }));
            }
          }
        } catch (err) {
          handleCliError(err);
        }
      },
    );

  add
    .command('gateway')
    .description('Add an API gateway')
    .argument('[name]', 'Gateway name')
    .option('--provider <id>', 'Catalog provider id')
    .option('--endpoint <url>', 'API endpoint')
    .option('--api-key <key>', 'API key')
    .option('--api-key-env <var>', 'Env var holding the API key')
    .option('--model <model>', 'Default model')
    .option('--models <id...>', 'Models to expose in Codex /model')
    .action(
      async (
        name: string | undefined,
        opts: {
          provider?: string;
          endpoint?: string;
          apiKey?: string;
          apiKeyEnv?: string;
          model?: string;
          models?: string[];
        },
      ) => {
        try {
          const g = globals();
          if (!name || !opts.provider) {
            if (!canPrompt(g)) {
              throw anypickError(
                'Usage: anypick add gateway <name> --provider <id> --endpoint <url> --api-key <key>',
                'INVALID_USAGE',
                { exitCode: ExitCode.INVALID_USAGE },
              );
            }
            // Fall through to interactive is partial — require non-interactive for now if missing
            if (!name || !opts.provider) {
              throw anypickError(
                'Name and --provider are required for automation.',
                'INVALID_USAGE',
                { exitCode: ExitCode.INVALID_USAGE },
              );
            }
          }

          let apiKey = opts.apiKey;
          if (!apiKey && opts.apiKeyEnv) {
            apiKey = process.env[opts.apiKeyEnv];
          }

          if (g.dryRun) {
            printDryRun(g, 'gateway.create', `Would create gateway ${name}`, {
              name,
              provider: opts.provider,
              endpoint: opts.endpoint,
              model: opts.model,
              models: opts.models,
              hasApiKey: Boolean(apiKey),
            });
            return;
          }

          const profile = await profiles.create(name, {
            provider: opts.provider,
            endpoint: opts.endpoint,
            apiKey,
            defaultModel: opts.model,
            models: modelMap(opts.models),
          });

          if (g.json) {
            console.log(
              JSON.stringify({
                gateway: profile.meta.name,
                provider: profile.meta.provider,
              }),
            );
          } else {
            success(`Gateway ${profile.meta.name} created`);
            info(`Use it: anypick use claude --with ${profile.meta.name}`);
          }
        } catch (err) {
          handleCliError(err);
        }
      },
    );

  // ── link / unlink ──────────────────────────────────────────────
  program
    .command('link')
    .description('Set a project-specific client source')
    .argument('<client>', 'Client id')
    .option('--with <source>', 'Source or @preset')
    .option('--model <model>', 'Explicit model')
    .action(async (client: string, opts: { with?: string; model?: string }) => {
      try {
        const g = globals();
        const result = await bindingService.link(client, {
          with: opts.with,
          model: opts.model,
          dryRun: g.dryRun,
          verbose: g.verbose,
        });
        if (g.json) {
          console.log(
            JSON.stringify({
              client,
              source: result.plan.resolvedSource.display,
              dryRun: result.dryRun,
              scope: 'project',
            }),
          );
        } else if (result.dryRun) {
          info('Dry run — project link plan:');
          for (const s of result.plan.steps) {
            console.log(`  · ${s.kind}`);
          }
        } else {
          success(
            `Linked ${clients.get(client).name} → ${result.plan.resolvedSource.display} (project)`,
          );
        }
      } catch (err) {
        handleCliError(err);
      }
    });

  program
    .command('unlink')
    .description('Remove a project binding')
    .argument('[client]', 'Client id (omit for all in this project)')
    .action(async (client: string | undefined) => {
      try {
        const g = globals();
        if (g.dryRun) {
          const projectRoot = resolveProjectRoot();
          const existing = client
            ? bindings.getProject(projectRoot, client)
              ? 1
              : 0
            : bindings.listProject(projectRoot).length;
          printDryRun(g, 'binding.unlink', `Would remove ${existing} project binding(s)`, {
            client: client ?? null,
            removed: existing,
          });
          return;
        }
        const n = await bindingService.unlink(client);
        if (g.json) {
          console.log(JSON.stringify({ removed: n }));
        } else {
          success(n ? `Removed ${n} project binding(s)` : 'Nothing to unlink');
        }
      } catch (err) {
        handleCliError(err);
      }
    });

  // ── reset ──────────────────────────────────────────────────────
  program
    .command('reset')
    .description('Remove AnyPick-managed configuration for a client')
    .argument('[client]', 'Client id')
    .action(async (clientArg: string | undefined) => {
      try {
        const g = globals();
        let client = clientArg;
        if (!client) {
          if (!canPrompt(g)) {
            throw anypickError('Client required.\n\n  anypick reset claude', 'INVALID_USAGE', {
              exitCode: ExitCode.INVALID_USAGE,
            });
          }
          const { select } = await import('@clack/prompts');
          const picked = await select({
            message: 'Reset which client?',
            options: clients.list().map((c) => ({
              value: c.id,
              label: c.name,
            })),
          });
          if (typeof picked !== 'string') {
            process.exit(ExitCode.CANCELLED);
          }
          client = picked;
        }
        const result = await bindingService.reset(client, {
          dryRun: g.dryRun,
        });
        if (g.json) {
          console.log(JSON.stringify(result));
        } else if (result.dryRun) {
          info(
            result.removedGlobal
              ? `Would remove global binding for ${client}`
              : `No global binding for ${client}`,
          );
        } else {
          success(`Reset AnyPick-managed state for ${client}`);
        }
      } catch (err) {
        handleCliError(err);
      }
    });

  // ── preset namespace ───────────────────────────────────────────
  const presetCmd = program.command('preset').description('Manage saved presets');

  presetCmd
    .command('list')
    .description('List presets')
    .action(async () => {
      const list = presets.list();
      if (globals().json) {
        console.log(JSON.stringify(list, null, 2));
        return;
      }
      for (const p of list) {
        console.log(
          `@${p.name}  ${p.spec.client} → ${displayRef(p.spec.source)}  rev ${p.revision}`,
        );
      }
    });

  presetCmd
    .command('show')
    .argument('<name>', 'Preset name (without @)')
    .action(async (name: string) => {
      const p = presets.getByName(name);
      if (!p) {
        handleCliError(
          anypickError(`Preset @${name} not found`, 'PRESET_NOT_FOUND', {
            exitCode: ExitCode.NOT_FOUND,
            mutated: false,
          }),
        );
      }
      console.log(JSON.stringify(p, null, 2));
    });

  presetCmd
    .command('remove')
    .alias('rm')
    .argument('<name>', 'Preset name')
    .action(async (name: string) => {
      if (globals().dryRun) {
        printDryRun(globals(), 'preset.remove', `Would remove preset @${name}`, { name });
        return;
      }
      const ok = presets.remove(name);
      if (globals().json) {
        console.log(JSON.stringify({ removed: ok }));
      } else if (ok) {
        success(`Removed @${name}`);
      } else {
        warn(`Preset @${name} not found`);
      }
    });
}

function modelMap(modelIds: readonly string[] | undefined): Record<string, string> | undefined {
  const models = [...new Set((modelIds ?? []).map((model) => model.trim()).filter(Boolean))];
  return models.length ? Object.fromEntries(models.map((model) => [model, model])) : undefined;
}
