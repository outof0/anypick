import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BRAND_TAGLINE, brandTint } from '../core/brand';

const ROOT_INFO_ONLY_ARGS = new Set([
  '--version',
  '-V',
  '--help',
  '-h',
  '--json',
  '--no-input',
  '--quiet',
  '-q',
  '--verbose',
  '-v',
  '--dry-run',
  '--yes',
  '-y',
  '--trace',
  '--reveal',
]);

/** Run the regular Hotplug CLI after internal process commands are dispatched. */
export async function runHotplugCli(args: string[]): Promise<void> {
  const rootInfoOnly = args.length > 0 && args.every((arg) => ROOT_INFO_ONLY_ARGS.has(arg));
  const versionOnly = rootInfoOnly && args.some((arg) => arg === '--version' || arg === '-V');
  const helpOnly = rootInfoOnly && args.some((arg) => arg === '--help' || arg === '-h');
  if (versionOnly || helpOnly) {
    const version = packageVersion();
    if (versionOnly) {
      process.stdout.write(`${version}\n`);
    } else {
      process.stdout.write(rootHelp(version));
    }
    return;
  }

  const { createAppReady } = await import('../core/app');
  const { runCli } = await import('./commands');
  await runCli(await createAppReady());
}

function packageVersion(): string {
  try {
    const packagePath = fileURLToPath(new URL('../../package.json', import.meta.url));
    return (
      (JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: string }).version ?? '0.0.0'
    );
  } catch {
    return '0.0.0';
  }
}

function rootHelp(version: string): string {
  return `${brandTint('hotplug')} ${version}

${BRAND_TAGLINE}

Usage: hotplug [options] <command>

Core commands:
  use <client>       Set a client's default source
  run <client>       Launch with the effective source
  current            Show effective bindings
  list               List accounts, gateways, or presets
  add                Add an account or gateway
  link/unlink        Manage project-scoped bindings
  proxy              Manage local compatibility proxies
  doctor             Diagnose and repair safe local state
  update             Update Hotplug to the latest npm release

Options:
  --json             Machine-readable output
  --dry-run          Plan only; no writes
  --no-input         Never prompt
  -h, --help         Show help
  -V, --version      Show version
`;
}
