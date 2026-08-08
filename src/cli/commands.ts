import { Command } from 'commander';
import { createRequire } from 'node:module';
import type { AnyPickApp } from '../core/app';
import type { ProxyHandle } from '../types';
import { printAccounts, printProviders, printProxyStatus } from './format';
import { MARK, setUxMode, withSpin, printError, next, success, info, warn } from './ux';
import { runInteractive } from './interactive';
import { afterHelpText, proxyHelp } from './help';
import { completionScript, type Shell } from './completion';
import { registerPrimaryCommands, type GlobalOpts as PrimaryGlobalOpts } from './primary';
import { registerPluginGroup } from './plugin-commands';
import { BRAND_TAGLINE } from '../core/brand';
import { providerCanProxy } from '../core/capabilities';
import { ExitCode, isAnyPickError, anypickError } from '../utils/errors';
import pc from 'picocolors';
import { desktopTraySurfaceAvailable, launchSurface, type LaunchSurface } from '../tray/settings';

export interface GlobalOpts extends PrimaryGlobalOpts {
  json?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  reveal?: boolean;
  quiet?: boolean;
  /** Commander exposes a negated --no-input option as `input: false`. */
  input?: boolean;
  yes?: boolean;
  trace?: boolean;
  tui?: boolean;
  tray?: boolean;
}

function globals(program: Command): GlobalOpts {
  return program.optsWithGlobals() as GlobalOpts;
}

function applyUxFromProgram(program: Command): void {
  const g = globals(program);
  setUxMode({
    json: Boolean(g.json),
    quiet: Boolean(g.quiet),
    verbose: Boolean(g.verbose),
    interactive: Boolean(process.stdout.isTTY && !g.json && !g.quiet),
  });
}

function pkgVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Proxy handles contain the per-instance bearer token used by local clients.
 * That token is intentionally transient and must never cross a CLI output
 * boundary (especially JSON, which is routinely captured in CI logs).
 */
function publicProxyHandle(
  handle: ProxyHandle | undefined,
): Omit<ProxyHandle, 'token'> | undefined {
  if (!handle) {
    return undefined;
  }
  const { token: _token, ...safe } = handle;
  return safe;
}

function printDryRunCommand(
  program: Command,
  action: string,
  detail: string,
  extra?: Record<string, unknown>,
): void {
  const g = globals(program);
  if (g.json) {
    console.log(JSON.stringify({ dryRun: true, action, ...extra }));
  } else {
    info(`[dry-run] ${detail}`);
  }
}

export function requestedLaunchSurface(
  options: { tui?: boolean; tray?: boolean },
  envValue: string | undefined,
  configured: LaunchSurface | undefined,
): LaunchSurface | undefined {
  if (options.tui && options.tray) {
    throw anypickError('Choose only one of --tui or --tray.', 'INVALID_USAGE', {
      exitCode: ExitCode.INVALID_USAGE,
      suggestions: ['anypick --tui', 'anypick --tray'],
    });
  }
  if (options.tui) {
    return 'tui';
  }
  if (options.tray) {
    return 'tray';
  }
  if (envValue != null && envValue !== '') {
    if (envValue === 'tui' || envValue === 'tray') {
      return envValue;
    }
    throw anypickError('ANYPICK_UI must be "tui" or "tray".', 'INVALID_USAGE', {
      exitCode: ExitCode.INVALID_USAGE,
    });
  }
  return configured;
}

async function saveLaunchSurface(app: AnyPickApp, surface: LaunchSurface): Promise<void> {
  await app.config.setLaunchSurface(surface);
}

async function chooseLaunchSurface(): Promise<LaunchSurface | undefined> {
  if (!desktopTraySurfaceAvailable()) {
    return 'tui';
  }
  const { isCancel, select } = await import('@clack/prompts');
  const selected = await select<LaunchSurface>({
    message: 'How do you want to use AnyPick by default?',
    options: [
      {
        value: 'tray',
        label: 'Menu bar Tray',
        hint: 'recommended for daily switching',
      },
      { value: 'tui', label: 'Terminal UI', hint: 'stay in this terminal' },
    ],
  });
  if (isCancel(selected)) {
    process.exitCode = ExitCode.CANCELLED;
    return undefined;
  }
  return selected;
}

async function openTui(app: AnyPickApp): Promise<void> {
  const { runTuiApp } = await import('../tui/app-ui');
  runTuiApp(app);
}

async function openTray(app: AnyPickApp, json = false): Promise<void> {
  if (!desktopTraySurfaceAvailable()) {
    throw anypickError(
      'The desktop Tray is not available on this installation.',
      'UNSUPPORTED_PLATFORM',
      {
        suggestions: ['anypick tui'],
      },
    );
  }
  const { startTray } = await import('../tray/supervisor');
  const result = await startTray(app.root, process.argv[1] ?? '');
  if (json) {
    console.log(JSON.stringify({ surface: 'tray', running: true, ...result }));
    return;
  }
  success(
    result.started
      ? `AnyPick Tray started (pid ${result.pid}). Look for it in the menu bar.`
      : `AnyPick Tray is already running (pid ${result.pid}).`,
  );
}

/**
 * CLI surface (DX redesign §5):
 *   use / run / current / list / add / link / unlink / reset / preset
 *   doctor / proxy / providers / clients / completion
 */
export function buildProgram(app: AnyPickApp): Command {
  const program = new Command();
  const { accounts, profiles, catalog, clients, doctor } = app;

  program
    .name('anypick')
    .description(BRAND_TAGLINE)
    .version(pkgVersion())
    .option('--json', 'JSON output', false)
    .option('-v, --verbose', 'Verbose logging', false)
    .option('-q, --quiet', 'Minimal output', false)
    .option('--dry-run', 'Plan only; no writes', false)
    .option('--reveal', 'Show secrets (dangerous)', false)
    .option('--no-input', 'Never prompt')
    .option('-y, --yes', 'Skip destructive confirmation', false)
    .option('--trace', 'Internal step names (no secrets)', false)
    .option('--tui', 'Open the Terminal UI for this run', false)
    .option('--tray', 'Open the desktop Tray for this run', false)
    .showSuggestionAfterError(true)
    .action(async () => {
      applyUxFromProgram(program);
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        program.outputHelp();
        process.exitCode = 2;
        return;
      }
      if (process.env.ANYPICK_TUI === '0') {
        await runInteractive(app);
        return;
      }
      const configured = launchSurface(await app.config.read());
      const requested = requestedLaunchSurface(
        globals(program),
        process.env.ANYPICK_UI,
        configured,
      );
      const surface = requested ?? (await chooseLaunchSurface());
      if (!surface) {
        return;
      }
      if (surface === 'tray') {
        await openTray(app, Boolean(globals(program).json));
      } else {
        if (!requested) {
          await saveLaunchSurface(app, surface);
        }
        await openTui(app);
      }
      if (!requested && surface === 'tray') {
        await saveLaunchSurface(app, surface);
      }
    })
    .addHelpText('after', afterHelpText());

  program.hook('preAction', (_thisCommand, actionCommand) => {
    const root = actionCommand.parent ?? actionCommand;
    let p: Command | null = actionCommand;
    while (p?.parent) {
      p = p.parent;
    }
    applyUxFromProgram(p ?? root);
  });

  registerPrimaryCommands(program, app, () => globals(program));

  program
    .command('tui')
    .description('Open the AnyPick Terminal UI')
    .action(async () => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw anypickError('The Terminal UI requires an interactive terminal.', 'TTY_REQUIRED', {
          exitCode: ExitCode.INVALID_USAGE,
        });
      }
      await openTui(app);
    });

  const tray = program
    .command('tray')
    .description('Open the AnyPick Tray or manage its background supervisor')
    .action(async () => {
      await openTray(app, Boolean(globals(program).json));
    });

  tray
    .command('start')
    .description('Start the AnyPick proxy supervisor (menu-bar icon on macOS)')
    .action(async () => {
      const g = globals(program);
      if (g.dryRun) {
        printDryRunCommand(program, 'tray.start', 'Would start the AnyPick tray supervisor');
        return;
      }
      try {
        const { startTray } = await import('../tray/supervisor');
        const result = await startTray(app.root, process.argv[1] ?? '');
        if (g.json) {
          console.log(JSON.stringify({ running: true, ...result }));
          return;
        }
        const subject = process.platform === 'darwin' ? 'AnyPick tray' : 'AnyPick supervisor';
        success(
          result.started
            ? `${subject} started (pid ${result.pid})`
            : `${subject} already running (pid ${result.pid})`,
        );
      } catch (err) {
        printError(err);
        process.exitCode = 1;
      }
    });

  tray
    .command('status')
    .description('Show proxy supervisor status')
    .action(async () => {
      const { trayStatus } = await import('../tray/supervisor');
      const status = await trayStatus(app.root);
      if (globals(program).json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      if (!status.running) {
        info(
          `${process.platform === 'darwin' ? 'AnyPick tray' : 'AnyPick supervisor'} is stopped.`,
        );
        return;
      }
      const mode =
        status.mode === 'headless'
          ? 'headless'
          : status.mode === 'tauri'
            ? 'Tauri tray'
            : 'menu-bar';
      success(
        `AnyPick supervisor running (pid ${status.pid}, ${status.proxyCount ?? '?'} proxies, ${mode})`,
      );
    });

  tray
    .command('stop')
    .description('Stop the supervisor and gracefully stop all AnyPick proxies')
    .action(async () => {
      const g = globals(program);
      if (g.dryRun) {
        printDryRunCommand(
          program,
          'tray.stop',
          'Would stop the AnyPick tray supervisor and proxies',
        );
        return;
      }
      const { stopTray } = await import('../tray/supervisor');
      const stopped = await stopTray(app.root);
      if (g.json) {
        console.log(JSON.stringify({ stopped }));
        return;
      }
      if (stopped) {
        success(
          `${process.platform === 'darwin' ? 'AnyPick tray' : 'AnyPick supervisor'} and proxies stopped.`,
        );
      } else {
        info(
          `${process.platform === 'darwin' ? 'AnyPick tray' : 'AnyPick supervisor'} is not running.`,
        );
      }
    });

  tray
    .command('run', { hidden: true })
    .description('Run the foreground proxy supervisor')
    .action(async () => {
      const { runTraySupervisor } = await import('../tray/supervisor');
      await runTraySupervisor(app);
    });

  // Dynamic completion helper
  program
    .command('__complete', { hidden: true })
    .argument('<kind>', 'providers | accounts | gateways | clients')
    .argument('[arg]', 'provider id for accounts')
    .action(async (kind: string, arg?: string) => {
      setUxMode({ quiet: true, json: false, interactive: false });
      if (kind === 'providers') {
        for (const p of accounts.listProviders()) {
          console.log(p.id);
        }
        return;
      }
      if (kind === 'clients') {
        for (const c of clients.list()) {
          console.log(c.id);
        }
        return;
      }
      if (kind === 'gateways' || kind === 'profiles') {
        for (const p of await profiles.list()) {
          console.log(p.meta.name);
        }
        return;
      }
      if (kind === 'accounts') {
        const list = await accounts.list(arg);
        for (const a of list) {
          console.log(a.name);
        }
        return;
      }
      process.exitCode = 1;
    });

  program
    .command('update')
    .description('Update AnyPick to the latest npm release')
    .option('--check', 'Only report whether a newer release exists', false)
    .action(async (opts: { check?: boolean }) => {
      const g = globals(program);
      const { checkForUpdate, installCommand, installLatest } = await import('../core/update');
      const status = await withSpin('Checking npm for a newer release', () =>
        checkForUpdate(pkgVersion()),
      );
      const command = installCommand(status.latest);

      if (!status.updateAvailable) {
        if (g.json) {
          console.log(JSON.stringify({ ...status, updated: false }, null, 2));
        } else {
          success(`Already on the latest release (${status.current})`);
        }
        return;
      }

      if (opts.check) {
        if (g.json) {
          console.log(JSON.stringify({ ...status, updated: false }, null, 2));
          return;
        }
        info(`Update available: ${status.current} → ${pc.bold(status.latest)}`);
        next('anypick update');
        return;
      }

      if (g.dryRun) {
        printDryRunCommand(program, 'update', `Would run ${command}`, { latest: status.latest });
        return;
      }

      info(`Updating ${status.current} → ${pc.bold(status.latest)} via ${command}`);
      await installLatest({
        version: status.latest,
        silent: Boolean(g.json || g.quiet),
      });
      if (g.json) {
        console.log(JSON.stringify({ ...status, updated: true }, null, 2));
        return;
      }
      success(`Updated to ${status.latest}`);
      next('anypick --version');
    });

  program
    .command('completion')
    .description('Shell completion (zsh | bash | fish)')
    .argument('<shell>', 'zsh | bash | fish')
    .action((shell: string) => {
      const s = shell.toLowerCase() as Shell;
      if (!['zsh', 'bash', 'fish'].includes(s)) {
        console.error(pc.red(MARK.fail), `Unknown shell "${shell}"`);
        console.error(pc.dim('  → Use one of: anypick completion zsh|bash|fish'));
        process.exitCode = 1;
        return;
      }
      process.stdout.write(completionScript(s));
    });

  program
    .command('doctor')
    .description('Diagnose setup; auto-fix only safe AnyPick-owned state')
    .argument('[target]', 'Optional filter (client, provider, …)')
    .option('--fix', 'Apply hard-allowlisted fixes only', false)
    .action(async (target: string | undefined, opts: { fix?: boolean }) => {
      const g = globals(program);
      const report = await doctor.run(target);

      if (g.json && !opts.fix) {
        console.log(JSON.stringify(report, null, 2));
        if (!report.ok) {
          process.exitCode = 1;
        }
        return;
      }

      if (!opts.fix) {
        console.log(pc.bold('anypick doctor'));
        console.log(pc.dim(report.root));
        console.log();
        for (const c of report.checks) {
          console.log(`${c.ok ? pc.green(MARK.ok) : pc.red(MARK.fail)} ${c.message}`);
          if (c.detail && g.verbose) {
            console.log(pc.dim(`    ${c.detail}`));
          }
          if (!c.ok && c.forbidden && c.suggestions?.length) {
            console.log(pc.dim('    Doctor will not auto-fix this. Manual:'));
            for (const s of c.suggestions) {
              console.log(pc.dim(`      ${s}`));
            }
          }
        }
        console.log();
        if (report.ok) {
          success('All checks passed');
        } else {
          warn('Some checks failed — re-run with --fix for safe repairs');
          process.exitCode = 1;
        }
        return;
      }

      const { enrichFixPlan, formatForbiddenManual } = await import('../core/doctor');
      const plan = enrichFixPlan(await doctor.planFixes(target));

      if (g.json) {
        if (!g.dryRun && !g.yes) {
          console.log(
            JSON.stringify(
              {
                error: {
                  code: 'CONFIRMATION_REQUIRED',
                  message: 'doctor --fix in JSON/non-interactive mode requires --yes',
                  plan,
                  mutated: false,
                },
              },
              null,
              2,
            ),
          );
          process.exitCode = 2;
          return;
        }
        const result = await doctor.applyFixes(plan, {
          dryRun: g.dryRun,
          yes: g.yes,
        });
        console.log(JSON.stringify(result, null, 2));
        if (result.applied.some((a) => !a.ok)) {
          process.exitCode = 1;
        }
        return;
      }

      console.log(pc.bold('anypick doctor --fix'));
      console.log(pc.dim(report.root));
      console.log();

      if (plan.manual.length) {
        console.log(pc.bold('Will not auto-fix (manual required):'));
        for (const m of plan.manual) {
          console.log();
          console.log(formatForbiddenManual(m));
        }
        console.log();
      }

      if (plan.actions.length === 0) {
        if (plan.manual.length === 0 && report.ok) {
          success('Nothing to fix');
        } else {
          info('No allowlisted auto-fixes available');
        }
        if (!report.ok) {
          process.exitCode = 1;
        }
        return;
      }

      console.log(pc.bold('Allowlisted fix plan:'));
      for (const a of plan.actions) {
        console.log(`  · [${a.kind}] ${a.description}`);
        if (g.verbose) {
          console.log(pc.dim(`      target: ${a.target}`));
        }
      }
      console.log();

      if (g.dryRun) {
        const result = await doctor.applyFixes(plan, { dryRun: true });
        for (const a of result.applied) {
          console.log(pc.dim(a.message));
        }
        info('Dry run — no changes made');
        return;
      }

      if (!g.yes) {
        if (!process.stdin.isTTY || !process.stderr.isTTY) {
          warn('Non-interactive doctor --fix requires --yes (or --dry-run)');
          process.exitCode = 2;
          return;
        }
        const ok = await confirmDelete(`${plan.actions.length} allowlisted fix(es)`, false);
        if (!ok) {
          info('Cancelled.');
          process.exitCode = 130;
          return;
        }
      }

      const result = await doctor.applyFixes(plan, { dryRun: false, yes: true });
      for (const a of result.applied) {
        if (a.ok) {
          success(a.message);
        } else {
          warn(a.message);
        }
      }
      if (result.applied.some((a) => !a.ok)) {
        process.exitCode = 1;
      }
    });

  registerProxyGroup(program, app);
  registerAccountGroup(program, app);
  registerGatewayGroup(program, app);
  registerPluginGroup(program, app);

  program
    .command('providers')
    .description('List account providers + gateway catalog')
    .action(() => {
      const auth = accounts.listProviders();
      if (globals(program).json) {
        console.log(
          JSON.stringify(
            {
              accounts: auth.map((p) => ({
                id: p.id,
                name: p.name,
                proxy: providerCanProxy(p),
              })),
              catalog: catalog.list().map((c) => ({
                id: c.id,
                name: c.name,
                apiStyle: c.apiStyle,
              })),
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(pc.bold('Accounts') + pc.dim('  (native logins)'));
      printProviders(auth, false);
      console.log();
      console.log(pc.bold('Catalog') + pc.dim('  (gateways)'));
      for (const c of catalog.list()) {
        console.log(`${pc.bold(c.id.padEnd(12))} ${pc.dim(c.name)}`);
      }
    });

  program
    .command('clients')
    .description('List supported clients')
    .action(() => {
      if (globals(program).json) {
        console.log(
          JSON.stringify(
            clients.list().map((c) => ({
              id: c.id,
              name: c.name,
              description: c.description,
            })),
            null,
            2,
          ),
        );
        return;
      }
      for (const c of clients.list()) {
        console.log(`${pc.bold(c.id.padEnd(10))} ${pc.dim(c.name)}`);
        if (c.description) {
          console.log(`${''.padEnd(10)} ${pc.dim(c.description)}`);
        }
      }
    });

  return program;
}

// ── account (CRUD helpers beyond `add account`) ──────────────────

function registerAccountGroup(program: Command, app: AnyPickApp): void {
  const { accounts } = app;
  const account = program.command('account').description('Manage saved accounts');

  account
    .command('list')
    .alias('ls')
    .description('List saved accounts')
    .argument('[provider]', 'Filter by provider')
    .action(async (provider?: string) => {
      const list = await accounts.list(provider);
      if (globals(program).json) {
        console.log(JSON.stringify(list, null, 2));
        return;
      }
      printAccounts(list, false);
    });

  account
    .command('remove')
    .alias('rm')
    .description('Delete a saved account')
    .argument('<provider>')
    .argument('<name>')
    .action(async (provider: string, name: string) => {
      const g = globals(program);
      if (g.dryRun) {
        printDryRunCommand(program, 'account.remove', `Would remove ${provider}/${name}`, {
          provider,
          name,
        });
        return;
      }
      if (!(await confirmDelete(`${provider}/${name}`, g.yes))) {
        return;
      }
      await accounts.delete(provider, name);
      success(`Removed ${provider}/${name}`);
    });

  account
    .command('refresh')
    .description('Refresh OAuth tokens (live or saved)')
    .argument('<provider>', 'codex | grok | opencode | …')
    .argument('[name]', 'Saved account (default: live)')
    .option('--all', 'Every saved account', false)
    .action(async (provider: string, name: string | undefined, opts: { all?: boolean }) => {
      if (globals(program).dryRun) {
        printDryRunCommand(
          program,
          'account.refresh',
          `Would refresh ${provider}${name ? `/${name}` : opts.all ? ' (all)' : ' live'}`,
          { provider, name: name ?? null, all: Boolean(opts.all) },
        );
        return;
      }
      const results = await withSpin(
        `Refreshing ${provider}${name ? `/${name}` : opts.all ? ' (all)' : ' live'}…`,
        () => accounts.refresh(provider, name, { all: opts.all }),
        { success: 'Refresh done' },
      );
      if (globals(program).json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }
      let failed = 0;
      for (const r of results) {
        if (r.ok) {
          success(`Refreshed ${r.target}` + (r.identity ? ` (${r.identity})` : ''));
        } else {
          failed += 1;
          console.error(pc.red(MARK.fail), `${r.target}: ${r.error}`);
        }
      }
      if (failed > 0) {
        process.exitCode = 1;
      }
    });

  account
    .command('export')
    .description('Export a saved account snapshot')
    .argument('<provider>')
    .argument('<name>')
    .requiredOption('-o, --out <path>', 'Output path')
    .action(async (provider: string, name: string, opts: { out: string }) => {
      if (globals(program).dryRun) {
        printDryRunCommand(
          program,
          'account.export',
          `Would export ${provider}/${name} → ${opts.out}`,
          {
            provider,
            name,
            out: opts.out,
          },
        );
        return;
      }
      await accounts.exportAccount(provider, name, opts.out);
      success(`Exported ${provider}/${name} → ${opts.out}`);
    });

  account
    .command('import')
    .description('Import an account snapshot')
    .argument('<provider>')
    .argument('<name>')
    .requiredOption('-i, --in <path>', 'Input path')
    .option('-f, --force', 'Overwrite existing', false)
    .action(async (provider: string, name: string, opts: { in: string; force?: boolean }) => {
      if (globals(program).dryRun) {
        printDryRunCommand(
          program,
          'account.import',
          `Would import ${provider}/${name} from ${opts.in}`,
          {
            provider,
            name,
            input: opts.in,
            force: Boolean(opts.force),
          },
        );
        return;
      }
      const meta = await accounts.importAccount(provider, name, opts.in, {
        force: Boolean(opts.force),
      });
      success(`Imported ${provider}/${meta.name}`);
    });
}

// ── gateway (CRUD helpers beyond `add gateway`) ──────────────────

function registerGatewayGroup(program: Command, app: AnyPickApp): void {
  const { profiles } = app;
  const gateway = program.command('gateway').description('Manage API gateways');

  gateway
    .command('list')
    .alias('ls')
    .description('List gateways')
    .action(async () => {
      const list = await profiles.list();
      if (globals(program).json) {
        console.log(
          JSON.stringify(
            list.map((p) => ({
              name: p.meta.name,
              provider: p.meta.provider,
              endpoint: p.meta.endpoint,
              defaultModel: p.meta.defaultModel,
            })),
            null,
            2,
          ),
        );
        return;
      }
      if (list.length === 0) {
        console.log(pc.dim('No gateways.'));
        console.log(pc.dim('  → anypick add gateway <name> --provider openrouter --endpoint …'));
        return;
      }
      for (const p of list) {
        const key = p.secrets.apiKey ? pc.green('key') : pc.yellow('no-key');
        console.log(
          `  ${pc.bold(p.meta.name.padEnd(18))} ${pc.cyan(p.meta.provider.padEnd(10))} ${key}  ${pc.dim(p.meta.defaultModel ?? '')}`,
        );
      }
    });

  gateway
    .command('show')
    .description('Show a gateway')
    .argument('<name>')
    .action(async (name: string) => {
      const p = await profiles.get(name);
      const redacted = profiles.redact(p, globals(program).reveal);
      if (globals(program).json) {
        console.log(JSON.stringify(redacted, null, 2));
        return;
      }
      console.log(pc.bold(p.meta.name));
      console.log(`  provider  ${p.meta.provider}`);
      console.log(`  endpoint  ${p.meta.endpoint ?? '—'}`);
      console.log(`  apiKey    ${redacted.secrets.apiKey ?? '—'}`);
      console.log(`  model     ${p.meta.defaultModel ?? '—'}`);
    });

  gateway
    .command('edit')
    .description('Edit gateway fields')
    .argument('<name>')
    .option('--endpoint <url>')
    .option('--api-key <key>')
    .option('-m, --model <id>', 'Default model')
    .option('--models <id...>', 'Models to expose in Codex /model')
    .action(
      async (
        name: string,
        opts: { endpoint?: string; apiKey?: string; model?: string; models?: string[] },
      ) => {
        if (globals(program).dryRun) {
          printDryRunCommand(program, 'gateway.edit', `Would update gateway ${name}`, {
            name,
            endpoint: opts.endpoint,
            model: opts.model,
            models: opts.models,
            hasApiKey: opts.apiKey !== undefined,
          });
          return;
        }
        const edited = await profiles.edit(name, {
          endpoint: opts.endpoint,
          apiKey: opts.apiKey,
          defaultModel: opts.model,
          models: modelMap(opts.models),
        });
        success(`Updated gateway ${edited.meta.name}`);
      },
    );

  gateway
    .command('remove')
    .alias('rm')
    .description('Delete a gateway')
    .argument('<name>')
    .action(async (name: string) => {
      const g = globals(program);
      if (g.dryRun) {
        if (g.json) {
          console.log(JSON.stringify({ dryRun: true, action: 'gateway.remove', name }));
        } else {
          info(`[dry-run] Would remove gateway ${name}`);
        }
        return;
      }
      if (!(await confirmDelete(`gateway ${name}`, g.yes))) {
        return;
      }
      await profiles.delete(name);
      success(`Removed gateway ${name}`);
    });

  gateway
    .command('reset')
    .description('Clear AnyPick-managed client config that pointed at a gateway')
    .option('-c, --client <id>', 'Client id', 'claude')
    .action(async (opts: { client: string }) => {
      // Route through bindingService.reset so binding + runtime client config are
      // reconciled together (runtime.reset alone leaves the binding store stale).
      const result = await app.bindingService.reset(opts.client, {
        dryRun: globals(program).dryRun,
      });
      if (globals(program).json) {
        console.log(JSON.stringify(result));
        return;
      }
      if (result.dryRun) {
        info(`[dry-run] reset ${result.client}`);
      } else {
        success(`Reset ${result.client}`);
      }
    });
}

function modelMap(modelIds: readonly string[] | undefined): Record<string, string> | undefined {
  const models = [...new Set((modelIds ?? []).map((model) => model.trim()).filter(Boolean))];
  return models.length ? Object.fromEntries(models.map((model) => [model, model])) : undefined;
}

// ── proxy ────────────────────────────────────────────────────────

function registerProxyGroup(program: Command, app: AnyPickApp): void {
  const proxy = program
    .command('proxy')
    .description('Local compatibility proxies')
    .addHelpText('after', proxyHelp())
    .action(async () => {
      await printProxyOverview(app, globals(program).json);
    });

  proxy
    .command('status')
    .description('Show proxy status (default: all)')
    .argument('[provider]', 'codex | grok | gemini | kiro | …')
    .argument('[name]', 'Account (default: active)')
    .action(async (provider?: string, name?: string) => {
      const g = globals(program);
      if (provider && name) {
        const p = app.proxy.requireProxyProvider(provider);
        const status = await app.proxy.proxyStatus(provider, name);
        printProxyStatus(provider, name, p.name, status, g.json);
        return;
      }
      if (provider && !name) {
        try {
          const active = (await app.accounts.current(provider)).active;
          if (active) {
            const p = app.proxy.requireProxyProvider(provider);
            const status = await app.proxy.proxyStatus(provider, active);
            printProxyStatus(provider, active, p.name, status, g.json);
            return;
          }
        } catch {
          // fall through
        }
      }
      await printProxyOverview(app, g.json, provider);
    });

  const hub = proxy.command('hub').description('Unified local Proxy Hub (opt-in)');

  hub
    .command('status')
    .description('Show unified Proxy Hub status')
    .action(async () => {
      const status = await app.hub.status();
      if (globals(program).json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      console.log(
        `Proxy Hub  ${status.running ? pc.green('running') : status.enabled ? pc.yellow('enabled') : pc.dim('off')}`,
      );
      if (status.endpoint) {
        console.log(`  ${pc.cyan(status.endpoint)}`);
      }
      console.log(
        `  ${status.sourceCount} sources · ${status.modelCount} routed models · ${status.conflictCount} conflicts`,
      );
    });

  hub
    .command('enable')
    .description('Enable the unified Hub without changing existing bindings')
    .option('-p, --port <port>', 'Public Hub port', (value: string) => Number(value))
    .option('--host <host>', 'Loopback bind host')
    .option('--start', 'Start the Hub now')
    .action(async (opts: { port?: number; host?: string; start?: boolean }) => {
      try {
        const current = await app.hub.get();
        if (globals(program).dryRun) {
          printDryRunCommand(program, 'proxy.hub.enable', 'Would enable the unified Proxy Hub', {
            host: opts.host ?? current.host,
            port: opts.port ?? current.port,
            start: opts.start === true,
          });
          return;
        }
        const nextHub = await app.hub.save({
          ...current,
          enabled: true,
          host: opts.host ?? current.host,
          port: opts.port ?? current.port,
        });
        const started = opts.start ? await app.hub.ensureRunning(nextHub.name) : undefined;
        if (globals(program).json) {
          console.log(
            JSON.stringify(
              {
                hub: { ...nextHub, endpoint: started?.endpoint },
                started: Boolean(started?.startedNow),
              },
              null,
              2,
            ),
          );
          return;
        }
        success(`Proxy Hub enabled at ${nextHub.host}:${nextHub.port}`);
        info('Add sources, then bind an app with: anypick use claude --with hub:default');
      } catch (error) {
        printError(error);
        process.exitCode = 1;
      }
    });

  hub
    .command('source')
    .description('Enable or disable a saved account behind Proxy Hub')
    .argument('<provider>')
    .argument('<account>')
    .argument('<on|off>')
    .action(async (provider: string, account: string, state: string) => {
      const enabled = state === 'on' || state === 'enable' || state === '1';
      if (!enabled && state !== 'off' && state !== 'disable' && state !== '0') {
        throw anypickError('Expected on or off.', 'INVALID_USAGE', {
          exitCode: ExitCode.INVALID_USAGE,
        });
      }
      const current = await app.hub.get();
      const ref = { kind: 'account' as const, provider, name: account };
      const sourceId = `account/${provider}/${account}`;
      const sources = current.sources.filter(
        (source) =>
          !(
            source.ref.kind === 'account' &&
            `account/${source.ref.provider}/${source.ref.name}` === sourceId
          ),
      );
      sources.push({ ref, enabled });
      if (globals(program).dryRun) {
        printDryRunCommand(
          program,
          'proxy.hub.source',
          `Would ${enabled ? 'enable' : 'disable'} ${provider}/${account} behind Proxy Hub`,
          { provider, account, enabled },
        );
        return;
      }
      const nextHub = await app.hub.setSources(current.name, sources);
      if (globals(program).json) {
        console.log(JSON.stringify({ hub: nextHub, source: ref, enabled }, null, 2));
        return;
      }
      success(`${provider}/${account} ${enabled ? 'enabled' : 'disabled'} in Proxy Hub`);
    });

  hub
    .command('owner')
    .description('Choose the source for a duplicate raw model id')
    .argument('<model>')
    .argument('<provider>')
    .argument('<account>')
    .action(async (model: string, provider: string, account: string) => {
      const current = await app.hub.get();
      if (globals(program).dryRun) {
        printDryRunCommand(
          program,
          'proxy.hub.owner',
          `Would route ${model} through ${provider}/${account}`,
          {
            model,
            provider,
            account,
          },
        );
        return;
      }
      const source = {
        kind: 'account',
        provider,
        name: account,
      } as const;
      const nextHub = await app.hub.setModelOwner(current.name, model, source);
      if (globals(program).json) {
        console.log(JSON.stringify({ hub: nextHub, model, source }, null, 2));
        return;
      }
      success(`${model} → ${provider}/${account}`);
    });

  hub
    .command('preview')
    .description('Refresh source catalogs and show routed models/conflicts')
    .action(async () => {
      const preview = await withSpin('Refreshing Proxy Hub catalogs…', () => app.hub.preview());
      if (globals(program).json) {
        console.log(JSON.stringify(preview, null, 2));
        return;
      }
      console.log(`${preview.routes.length} routed models`);
      for (const conflict of preview.conflicts) {
        console.log(
          pc.yellow(
            `  conflict  ${conflict.model}  ${conflict.candidates
              .map((source) =>
                source.kind === 'account'
                  ? `${source.provider}/${source.name}`
                  : `pool:${source.provider}`,
              )
              .join(' · ')}`,
          ),
        );
      }
      for (const unavailable of preview.unavailable) {
        console.log(pc.red(`  unavailable  ${unavailable.reason}`));
      }
    });

  hub
    .command('start')
    .description('Start the unified Proxy Hub')
    .action(async () => {
      const started = await app.hub.ensureRunning();
      if (globals(program).json) {
        console.log(
          JSON.stringify({ endpoint: started.endpoint, started: started.startedNow }, null, 2),
        );
        return;
      }
      success(`${started.startedNow ? 'Started' : 'Using'} Proxy Hub at ${started.endpoint}`);
    });

  hub
    .command('stop')
    .description('Stop the unified Proxy Hub')
    .action(async () => {
      if (globals(program).dryRun) {
        printDryRunCommand(program, 'proxy.hub.stop', 'Would stop the unified Proxy Hub');
        return;
      }
      await app.hub.stop();
      if (globals(program).json) {
        console.log(JSON.stringify({ stopped: true }));
        return;
      }
      success('Proxy Hub stopped');
    });

  // Multi-account pool (opt-in; default remains single account proxy)
  const pool = proxy.command('pool').description('Multi-account proxy pool (opt-in)');

  pool
    .command('status')
    .description('Show pool mode and members')
    .argument('<provider>', 'Proxy-capable provider')
    .action(async (provider: string) => {
      const p = await app.proxy.getPool(provider);
      if (globals(program).json) {
        console.log(JSON.stringify(p, null, 2));
        return;
      }
      console.log(`${provider} pool  mode=${p.mode}  enabled=${p.enabled}`);
      if (p.port) {
        console.log(`  listen  ${p.host ?? '127.0.0.1'}:${p.port}`);
      }
      if (p.members.length === 0) {
        console.log(pc.dim('  (no members)'));
        return;
      }
      for (const m of p.members) {
        console.log(`  ${m.enabled ? '[x]' : '[ ]'} ${m.account}`);
      }
      if (p.mode === 'single') {
        console.log(
          pc.dim(
            '\nDefault is single account. Enable multi: anypick proxy pool enable ' + provider,
          ),
        );
      }
    });

  pool
    .command('enable')
    .description('Opt-in multi-account pool for a provider')
    .argument('<provider>')
    .option('-p, --port <port>', 'Shared listen port', (v: string) => Number(v))
    .option('--host <host>', 'Listen host')
    .option('--no-start', 'Configure only; do not start')
    .action(async (provider: string, opts: { port?: number; host?: string; start?: boolean }) => {
      try {
        if (globals(program).dryRun) {
          printDryRunCommand(
            program,
            'proxy.pool.enable',
            `Would enable the ${provider} multi-account pool`,
            {
              provider,
              port: opts.port,
              host: opts.host,
              start: opts.start !== false,
            },
          );
          return;
        }
        const { pool: p, started } = await withSpin(
          'Enabling multi-account pool…',
          () =>
            app.proxy.enablePoolMulti(provider, {
              port: opts.port,
              host: opts.host,
              start: opts.start !== false,
            }),
          { success: 'Pool multi-mode on' },
        );
        if (globals(program).json) {
          console.log(JSON.stringify({ pool: p, started: publicProxyHandle(started) }, null, 2));
          return;
        }
        success(
          `${provider} pool multi  ${p.members.filter((m) => m.enabled).length}/${p.members.length} accounts` +
            (started?.endpoint ? `  ${pc.cyan(started.endpoint)}` : ''),
        );
        info(`Bind apps with: anypick use claude --with pool:${provider}`);
      } catch (err) {
        printError(err);
        process.exitCode = 1;
      }
    });

  pool
    .command('disable')
    .description('Back to single-account proxies (default)')
    .argument('<provider>')
    .action(async (provider: string) => {
      try {
        if (globals(program).dryRun) {
          printDryRunCommand(program, 'proxy.pool.disable', `Would disable the ${provider} pool`, {
            provider,
          });
          return;
        }
        await app.proxy.disablePoolMulti(provider);
        success(`${provider} pool → single-account mode`);
      } catch (err) {
        printError(err);
        process.exitCode = 1;
      }
    });

  pool
    .command('member')
    .description('Enable or pause a pool member')
    .argument('<provider>')
    .argument('<account>')
    .argument('<on|off>', 'on = in rotation, off = paused')
    .action(async (provider: string, account: string, state: string) => {
      const enabled = state === 'on' || state === 'enable' || state === '1';
      if (!enabled && state !== 'off' && state !== 'disable' && state !== '0') {
        console.error(pc.red(MARK.fail), `Unknown state "${state}"`);
        console.error(pc.dim(`  → anypick proxy pool member ${provider} ${account} on|off`));
        process.exitCode = 1;
        return;
      }
      try {
        if (globals(program).dryRun) {
          printDryRunCommand(
            program,
            'proxy.pool.member',
            `Would ${enabled ? 'enable' : 'pause'} ${provider}/${account}`,
            {
              provider,
              account,
              enabled,
            },
          );
          return;
        }
        const p = await app.proxy.setPoolMemberEnabled(provider, account, enabled);
        success(
          `${provider}/${account}  ${enabled ? 'in pool' : 'paused'}  (${p.members.filter((m) => m.enabled).length} active)`,
        );
      } catch (err) {
        printError(err);
        process.exitCode = 1;
      }
    });

  proxy
    .command('start')
    .description('Start proxy (default: active accounts with proxy enabled)')
    .argument('[provider]')
    .argument('[name]')
    .option('-p, --port <port>', 'Set listen port (persisted)', (v: string) => Number(v))
    .option('--host <host>', 'Set listen host (persisted)')
    .action(
      async (
        provider: string | undefined,
        name: string | undefined,
        opts: { port?: number; host?: string },
      ) => {
        if (globals(program).dryRun) {
          printDryRunCommand(
            program,
            'proxy.start',
            `Would start ${provider ? `${provider}/${name ?? 'active'}` : 'configured proxies'}`,
            {
              provider: provider ?? null,
              name: name ?? null,
              port: opts.port,
              host: opts.host,
            },
          );
          return;
        }
        if ((opts.port != null || opts.host != null) && provider) {
          try {
            const handle = await withSpin(
              'Starting proxy…',
              () =>
                app.proxy.startProxy(provider, name, {
                  port: opts.port,
                  host: opts.host,
                }),
              { success: 'Proxy started' },
            );
            if (globals(program).json) {
              console.log(JSON.stringify(publicProxyHandle(handle), null, 2));
              return;
            }
            success(`${provider}/${name ?? 'active'}  ${pc.cyan(handle.endpoint)}`);
            if (handle.realignedClients?.length) {
              info(
                `  clients updated → ${handle.realignedClients.join(', ')}  (${handle.endpoint})`,
              );
            }
          } catch (err) {
            printError(err);
            process.exitCode = 1;
          }
          return;
        }

        const results = await withSpin(
          'Starting proxy…',
          () => app.proxy.startProxies(provider, name),
          { success: 'Proxy start done' },
        );
        if (globals(program).json) {
          console.log(JSON.stringify(results, null, 2));
          return;
        }
        if (results.length === 0) {
          info('Nothing to start. Enable first: anypick proxy enable <provider> <name> -p <port>');
          return;
        }
        for (const r of results) {
          if (r.ok) {
            success(`${r.provider}/${r.name}  ${pc.cyan(r.endpoint ?? '')}`);
            if (r.realignedClients?.length) {
              info(`  clients updated → ${r.realignedClients.join(', ')}  (${r.endpoint})`);
            }
          } else {
            console.error(pc.red(MARK.fail), `${r.provider}/${r.name}: ${r.error}`);
            process.exitCode = 1;
          }
        }
      },
    );

  proxy
    .command('stop')
    .description('Stop proxy (default: running proxies)')
    .argument('[provider]')
    .argument('[name]')
    .action(async (provider?: string, name?: string) => {
      if (globals(program).dryRun) {
        printDryRunCommand(
          program,
          'proxy.stop',
          `Would stop ${provider ? `${provider}/${name ?? 'active'}` : 'running proxies'}`,
          {
            provider: provider ?? null,
            name: name ?? null,
          },
        );
        return;
      }
      const results = await withSpin(
        'Stopping proxy…',
        () => app.proxy.stopProxies(provider, name),
        { success: 'Proxy stop done' },
      );
      if (globals(program).json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }
      if (results.length === 0) {
        info('No proxy running.');
        return;
      }
      for (const r of results) {
        if (r.ok) {
          success(`Stopped ${r.provider}/${r.name}`);
        } else {
          console.error(pc.red(MARK.fail), `${r.provider}/${r.name}: ${r.error}`);
          process.exitCode = 1;
        }
      }
    });

  proxy
    .command('enable')
    .description('Enable proxy for an account')
    .argument('<provider>')
    .argument('<name>')
    .option('-p, --port <port>', 'Listen port (auto free port if omitted)', (v: string) =>
      Number(v),
    )
    .option('--host <host>', 'Listen host', '127.0.0.1')
    .option('--auth-mode <mode>', 'OpenCode auth mode: auto|public|api')
    .option('--oauth-source <source>', 'Gemini OAuth source: auto|gemini-cli|antigravity')
    .option('--no-start', 'Config only')
    .action(
      async (
        provider: string,
        name: string,
        opts: {
          port?: number;
          host?: string;
          start?: boolean;
          authMode?: string;
          oauthSource?: string;
        },
      ) => {
        if (globals(program).dryRun) {
          printDryRunCommand(program, 'proxy.enable', `Would enable ${provider}/${name}`, {
            provider,
            name,
            port: opts.port,
            host: opts.host,
            start: opts.start !== false,
          });
          return;
        }
        const providerOptions = {
          ...(opts.authMode ? { authMode: opts.authMode } : {}),
          ...(opts.oauthSource ? { oauthSource: opts.oauthSource } : {}),
        };
        const { config, started } = await app.proxy.enableProxy(provider, name, {
          port: opts.port,
          host: opts.host,
          options: Object.keys(providerOptions).length ? providerOptions : undefined,
          start: opts.start !== false,
        });
        const bind = `${config.host ?? '127.0.0.1'}:${config.port}`;
        success(`Enabled ${provider}/${name}  ${pc.cyan(bind)}`);
        if (started) {
          console.log(`  ${pc.green('running')}  ${pc.cyan(started.endpoint)}`);
        } else if (config.enabled) {
          next(`anypick proxy start ${provider} ${name}`, 'start when ready');
        }
      },
    );

  proxy
    .command('config')
    .alias('set')
    .description('Set proxy port/host for an account (restarts if running)')
    .argument('<provider>')
    .argument('<name>')
    .option('-p, --port <port>', 'Listen port', (v: string) => Number(v))
    .option('--host <host>', 'Listen host')
    .option('--auth-mode <mode>', 'OpenCode auth mode: auto|public|api')
    .option('--oauth-source <source>', 'Gemini OAuth source: auto|gemini-cli|antigravity')
    .option('--no-restart', 'Save only; do not restart a running proxy')
    .action(
      async (
        provider: string,
        name: string,
        opts: {
          port?: number;
          host?: string;
          restart?: boolean;
          authMode?: string;
          oauthSource?: string;
        },
      ) => {
        if (globals(program).dryRun) {
          printDryRunCommand(program, 'proxy.config', `Would configure ${provider}/${name}`, {
            provider,
            name,
            port: opts.port,
            host: opts.host,
            restart: opts.restart !== false,
          });
          return;
        }
        const providerOptions = {
          ...(opts.authMode ? { authMode: opts.authMode } : {}),
          ...(opts.oauthSource ? { oauthSource: opts.oauthSource } : {}),
        };
        const { config, restarted, wasRunning } = await app.proxy.configureProxy(provider, name, {
          port: opts.port,
          host: opts.host,
          restart: opts.restart !== false,
          options: Object.keys(providerOptions).length ? providerOptions : undefined,
        });
        const bind = `${config.host ?? '127.0.0.1'}:${config.port}`;
        success(`Configured ${provider}/${name}  ${pc.cyan(bind)}`);
        if (restarted) {
          console.log(`  ${pc.green('restarted')}  ${pc.cyan(restarted.endpoint)}`);
        } else if (wasRunning && opts.restart === false) {
          info(`Port saved; restart later: anypick proxy start ${provider} ${name}`);
        }
      },
    );

  proxy
    .command('disable')
    .description('Disable + stop proxy for an account')
    .argument('<provider>')
    .argument('<name>')
    .action(async (provider: string, name: string) => {
      if (globals(program).dryRun) {
        printDryRunCommand(program, 'proxy.disable', `Would disable ${provider}/${name}`, {
          provider,
          name,
        });
        return;
      }
      await app.proxy.disableProxy(provider, name);
      success(`Disabled ${provider}/${name}`);
    });

  proxy
    .command('logs')
    .description('Show proxy logs (use -f to stream live)')
    .argument('<provider>')
    .argument('[name]')
    .option('-n, --lines <n>', 'Lines to show before following', (v: string) => Number(v), 50)
    .option('-f, --follow', 'Stream new log lines live (Ctrl-C to stop)')
    .action(
      async (
        provider: string,
        name: string | undefined,
        opts: { lines: number; follow?: boolean },
      ) => {
        if (!opts.follow) {
          console.log(await app.proxy.proxyLogs(provider, name, opts.lines));
          return;
        }
        const ac = new AbortController();
        process.once('SIGINT', () => ac.abort());
        process.once('SIGTERM', () => ac.abort());
        console.log(
          pc.dim(`— following ${provider}/${name ?? 'active'} proxy log (Ctrl-C to stop) —`),
        );
        await app.proxy.proxyLogsFollow(provider, name, (line) => console.log(line), {
          lines: opts.lines,
          signal: ac.signal,
        });
      },
    );
}

async function printProxyOverview(
  app: AnyPickApp,
  json?: boolean,
  providerId?: string,
): Promise<void> {
  const rows = await app.proxy.listProxyRows(providerId);
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(pc.dim('No proxies configured.'));
    console.log(
      pc.dim('  → anypick proxy enable grok <account> -p 8080   then  anypick proxy start'),
    );
    return;
  }
  for (const r of rows) {
    const mark = r.active ? pc.green(MARK.live) : pc.dim(MARK.open);
    const run = r.status.running
      ? pc.green('running')
      : r.status.enabled
        ? pc.yellow('enabled')
        : pc.dim('off');
    const bind =
      r.status.port != null ? pc.dim(`  ${r.status.host ?? '127.0.0.1'}:${r.status.port}`) : '';
    const ep = r.status.running && r.status.endpoint ? pc.cyan(`  ${r.status.endpoint}`) : '';
    console.log(`  ${mark} ${pc.bold(`${r.provider}/${r.name}`)}  ${run}${bind}${ep}`);
  }
}

async function confirmDelete(label: string, yes?: boolean): Promise<boolean> {
  if (yes) {
    return true;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw anypickError(
      `Deleting ${label} requires --yes in non-interactive mode.`,
      'CONFIRMATION_REQUIRED',
      { exitCode: ExitCode.INVALID_USAGE, mutated: false },
    );
  }
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await rl.question(`Delete ${label}? [y/N] `);
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    info('Cancelled.');
    return false;
  }
  return true;
}

export async function runCli(app: AnyPickApp, argv = process.argv): Promise<void> {
  const program = buildProgram(app);
  program.exitOverride();

  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err) {
      const code = (err as { code?: string }).code;
      if (code === 'commander.helpDisplayed' || code === 'commander.version') {
        return;
      }
      if (
        code === 'commander.unknownCommand' ||
        code === 'commander.unknownOption' ||
        code === 'commander.missingArgument' ||
        code === 'commander.invalidArgument'
      ) {
        process.exitCode = 2;
        return;
      }
    }
    if (isAnyPickError(err)) {
      const mode = (await import('./ux')).getUxMode();
      if (mode.json) {
        console.log(JSON.stringify(err.toJson()));
      } else {
        printError(err.toHuman());
      }
      process.exitCode = err.exitCode;
      return;
    }
    printError(err);
    process.exitCode = 1;
  }
}
