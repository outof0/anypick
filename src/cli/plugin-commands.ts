import type { Command } from 'commander';
import pc from 'picocolors';
import type { AnyPickApp } from '../core/app';
import type { PluginRecord } from '../types';
import { ExitCode, anypickError } from '../utils/errors';
import { info, next, success, warn } from './ux';

interface PluginGlobals {
  json?: boolean;
  yes?: boolean;
}

function shortDigest(digest: string): string {
  return digest.slice(0, 12);
}

/**
 * Confirm a decision that grants a plugin the ability to run in-process.
 *
 * Deliberately not `confirmDelete`: the dangerous direction here is *enabling*,
 * so the prompt is required for the constructive verb rather than the
 * destructive one (ADR 0012).
 */
async function confirmTrust(gerund: string, question: string, yes?: boolean): Promise<boolean> {
  if (yes) {
    return true;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw anypickError(
      `${gerund} requires --yes in non-interactive mode.`,
      'CONFIRMATION_REQUIRED',
      {
        exitCode: ExitCode.INVALID_USAGE,
        mutated: false,
      },
    );
  }
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    info('Cancelled.');
    return false;
  }
  return true;
}

function printRecord(record: PluginRecord, state: string): void {
  console.log(
    `  ${state} ${pc.bold(record.name.padEnd(20))} ${pc.dim(record.version.padEnd(10))} ${pc.dim(shortDigest(record.digest))}`,
  );
  console.log(`    ${pc.dim(record.path)}`);
}

export function registerPluginGroup(program: Command, app: AnyPickApp): void {
  const { plugins } = app;
  const group = program.command('plugin').description('Manage plugins that extend AnyPick');

  const opts = (): PluginGlobals => program.optsWithGlobals();
  const jsonOut = (): boolean => Boolean(opts().json);
  const yesFlag = (): boolean | undefined => opts().yes;

  group
    .command('list')
    .alias('ls')
    .description('List installed plugins and their load status')
    .action(() => {
      const records = plugins.list();
      const { loaded, failures } = app.pluginRuntime;
      const loadedNames = new Set(loaded.map((l) => l.record.name));
      const failureByName = new Map(failures.map((f) => [f.name, f]));

      if (jsonOut()) {
        console.log(
          JSON.stringify(
            records.map((r) => {
              const failure = failureByName.get(r.name);
              return {
                name: r.name,
                version: r.version,
                path: r.path,
                enabled: r.enabled,
                digest: r.digest,
                loaded: loadedNames.has(r.name),
                failure: failure ? { reason: failure.reason, untrusted: failure.untrusted } : null,
                addedAt: r.addedAt,
                updatedAt: r.updatedAt,
              };
            }),
            null,
            2,
          ),
        );
        return;
      }

      if (records.length === 0) {
        console.log(pc.dim('No plugins installed.'));
        next('anypick plugin add <dir>', 'install a plugin directory');
        return;
      }
      for (const r of records) {
        const failure = failureByName.get(r.name);
        const state = !r.enabled
          ? pc.dim('off ')
          : failure
            ? pc.red('fail')
            : loadedNames.has(r.name)
              ? pc.green('on  ')
              : pc.yellow('?   ');
        printRecord(r, state);
        if (failure) {
          console.log(`    ${pc.red(failure.reason)}`);
          if (failure.untrusted) {
            console.log(`    ${pc.dim(`→ anypick plugin trust ${r.name}`)}`);
          }
        }
      }
    });

  group
    .command('add')
    .description('Install a plugin directory (disabled until you enable it)')
    .argument('<dir>', `directory containing anypick.plugin.json`)
    .action(async (dir: string) => {
      const record = await plugins.add(dir);
      if (jsonOut()) {
        console.log(JSON.stringify(record, null, 2));
        return;
      }
      success(`Added ${record.name} ${record.version} (${shortDigest(record.digest)})`);
      if (!record.enabled) {
        next(`anypick plugin enable ${record.name}`, 'plugins do not run until enabled');
      }
    });

  group
    .command('remove')
    .alias('rm')
    .description('Uninstall a plugin')
    .argument('<name>')
    .action(async (name: string) => {
      await plugins.remove(name);
      if (jsonOut()) {
        console.log(JSON.stringify({ name, removed: true }, null, 2));
        return;
      }
      success(`Removed ${name}`);
    });

  group
    .command('enable')
    .description('Allow a plugin to load into the AnyPick process')
    .argument('<name>')
    .action(async (name: string) => {
      const existing = plugins.get(name);
      if (existing?.enabled) {
        if (jsonOut()) {
          console.log(JSON.stringify(existing, null, 2));
          return;
        }
        info(`${name} is already enabled.`);
        return;
      }
      if (!jsonOut() && existing) {
        warn(`${name} runs in-process with full access to every credential AnyPick manages.`);
        console.log(`  ${pc.dim(existing.path)}`);
        console.log(
          `  ${pc.dim('Treat enable like installing a shell plugin — not a config toggle.')}`,
        );
        console.log(
          `  ${pc.dim('Package digest is re-checked before every import; changes require trust.')}`,
        );
      }
      if (
        !(await confirmTrust(
          `Enabling ${name}`,
          `Enable ${name} and grant it access to your credentials?`,
          yesFlag(),
        ))
      ) {
        process.exitCode = 130;
        return;
      }
      const record = await plugins.setEnabled(name, true);
      if (jsonOut()) {
        console.log(JSON.stringify(record, null, 2));
        return;
      }
      success(`Enabled ${name}`);
      next('anypick plugin list', 'confirm it loads on the next run');
    });

  group
    .command('disable')
    .description('Stop loading a plugin without uninstalling it')
    .argument('<name>')
    .action(async (name: string) => {
      const record = await plugins.setEnabled(name, false);
      if (jsonOut()) {
        console.log(JSON.stringify(record, null, 2));
        return;
      }
      success(`Disabled ${name}`);
    });

  group
    .command('trust')
    .description('Re-pin a plugin digest after reviewing changed code')
    .argument('<name>')
    .action(async (name: string) => {
      const existing = plugins.get(name);
      if (!jsonOut() && existing) {
        warn(`This approves the code currently at ${existing.path}.`);
      }
      if (
        !(await confirmTrust(`Trusting ${name}`, `Trust the current code of ${name}?`, yesFlag()))
      ) {
        process.exitCode = 130;
        return;
      }
      const { record, previousDigest } = await plugins.trust(name);
      if (jsonOut()) {
        console.log(JSON.stringify({ ...record, previousDigest }, null, 2));
        return;
      }
      success(`Trusted ${name} ${record.version}`);
      console.log(
        `  ${pc.dim(shortDigest(previousDigest))} → ${pc.bold(shortDigest(record.digest))}`,
      );
    });
}
