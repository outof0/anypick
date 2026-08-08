import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { isAnyPickError } from '../utils/errors';

const DUMB = process.env.TERM === 'dumb';

/** Mirrors the TUI glyph set so both surfaces degrade the same way. */
export const MARK = DUMB
  ? ({
      ok: 'OK',
      info: 'i',
      warn: '!',
      fail: 'x',
      done: '*',
      live: '*',
      open: 'o',
      focus: '>',
    } as const)
  : ({
      ok: '✔',
      info: 'ℹ',
      warn: '⚠',
      fail: '✖',
      done: '✓',
      live: '●',
      open: '○',
      focus: '›',
    } as const);

export type UxMode = {
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  /** No spinner when not a TTY or quiet/json */
  interactive: boolean;
};

let mode: UxMode = {
  json: false,
  quiet: false,
  verbose: false,
  interactive: Boolean(process.stdout.isTTY && process.stdin.isTTY),
};

export function setUxMode(partial: Partial<UxMode>): void {
  mode = { ...mode, ...partial };
  if (mode.json || mode.quiet) {
    mode.interactive = false;
  }
}

export function getUxMode(): UxMode {
  return mode;
}

/** Map error codes → actionable next steps (Claude/Codex-style recovery). */
const ERROR_HINTS: Record<string, string[]> = {
  NO_LIVE_AUTH: [
    'Log in with the tool first (e.g. codex login / grok login)',
    'Then: anypick add account <provider> --current --name <name>',
  ],
  ACCOUNT_NOT_FOUND: [
    'List accounts: anypick list accounts',
    'Or save current: anypick add account <provider> --current --name <name>',
  ],
  PROFILE_NOT_FOUND: [
    'List gateways: anypick list gateways',
    'Or create: anypick add gateway <name> --provider custom --endpoint …',
  ],
  GATEWAY_NOT_FOUND: [
    'List gateways: anypick list gateways',
    'Or create: anypick add gateway <name> --provider openrouter --endpoint …',
  ],
  PROFILE_EXISTS: ['Use --force to overwrite, or pick another name'],
  STASH_BACKUP_FAILED: ['Fix the backup error, or: anypick add account <provider> --new'],
  STASH_UNSUPPORTED: ['This provider cannot clear live auth for a new login'],
  REFRESH_UNSUPPORTED: [
    'Only codex/grok/opencode support refresh today',
    'Re-login if tokens expired: anypick add account <provider> --new',
  ],
  REFRESH_EMPTY: [
    'Save an account first: anypick add account <provider> --current --name <name>',
    'Or refresh live: anypick account refresh <provider>',
  ],
  UNKNOWN_PROVIDER: ['See: anypick providers'],
  UNKNOWN_CLIENT: ['See: anypick clients'],
  UNKNOWN_CATALOG_PROVIDER: ['See: anypick providers'],
  PROXY_UNSUPPORTED: [
    'This tool has no compatibility proxy',
    'Proxy is available for grok / kiro / opencode today',
  ],
  PROXY_DISABLED: [
    'Enable first: anypick proxy enable <provider> <name> -p <port>',
    'Then: anypick proxy start',
  ],
  PROXY_PORT_IN_USE: [
    'Pick another port: anypick proxy config <provider> <name> -p <port>',
    'Or: anypick proxy enable <provider> <name> -p <port>',
  ],
  PROXY_PORT_INVALID: ['Port must be an integer between 1 and 65535'],
  PROXY_CONFIG_EMPTY: ['Example: anypick proxy config grok work -p 8081'],
  NO_ACTIVE_ACCOUNT: ['Pass an account name, or: anypick use <client> --with <provider>/<name>'],
  CLIENT_CONFIG_INVALID: [
    'Edit gateway: anypick gateway edit <name> --endpoint … --model …',
    'Or reset: anypick reset <client>',
  ],
};

export function hintsForError(err: unknown): string[] {
  if (isAnyPickError(err) && err.code && ERROR_HINTS[err.code]) {
    return ERROR_HINTS[err.code];
  }
  return [];
}

export function printError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (!mode.quiet) {
    console.error(pc.red(MARK.fail), msg);
    for (const h of hintsForError(err)) {
      console.error(pc.dim(`  → ${h}`));
    }
    if (mode.verbose && err instanceof Error && err.stack) {
      console.error(pc.dim(err.stack));
    }
  }
}

/** Suggest a follow-up command after success. */
export function next(cmd: string, note?: string): void {
  if (mode.json || mode.quiet) {
    return;
  }
  const line = note ? `${note}  ${pc.cyan(cmd)}` : pc.cyan(cmd);
  console.log(pc.dim('  next'), line);
}

/**
 * Run an async op with a spinner when interactive; plain otherwise.
 */
export async function withSpin<T>(
  label: string,
  fn: () => Promise<T>,
  opts?: { success?: string | ((result: T) => string) },
): Promise<T> {
  if (!mode.interactive || mode.json || mode.quiet) {
    return fn();
  }
  const s = clack.spinner();
  s.start(label);
  const t0 = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - t0;
    const ok =
      typeof opts?.success === 'function' ? opts.success(result) : (opts?.success ?? label);
    s.stop(mode.verbose ? `${ok} ${pc.dim(`${ms}ms`)}` : ok);
    return result;
  } catch (err) {
    s.stop(pc.red('Failed'));
    throw err;
  }
}

export function success(msg: string): void {
  if (mode.json || mode.quiet) {
    return;
  }
  console.log(pc.green(MARK.ok), msg);
}

export function info(msg: string): void {
  if (mode.json || mode.quiet) {
    return;
  }
  console.log(pc.cyan(MARK.info), msg);
}

export function warn(msg: string): void {
  if (mode.json || mode.quiet) {
    return;
  }
  console.log(pc.yellow(MARK.warn), msg);
}
