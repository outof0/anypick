import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathExists } from '../utils/fs';
import { HotplugError } from '../utils/errors';

const execFileAsync = promisify(execFile);

export type TerminalLaunchCandidate =
  | { kind: 'mac-app'; application: 'iTerm2' | 'Terminal' }
  | { kind: 'process'; command: string; args: string[] };

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function powershellQuote(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

/** Return platform-specific terminal options without touching the host. */
export function terminalLaunchCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  nodePath = process.execPath,
  cliEntry = '',
): TerminalLaunchCandidate[] {
  const nodeArgs = [nodePath, cliEntry];
  if (platform === 'darwin') {
    return [
      { kind: 'mac-app', application: 'iTerm2' },
      { kind: 'mac-app', application: 'Terminal' },
    ];
  }
  if (platform === 'win32') {
    const powershell = '& ' + powershellQuote(nodePath) + ' ' + powershellQuote(cliEntry);
    return [
      { kind: 'process', command: 'wt.exe', args: ['new-tab', ...nodeArgs] },
      { kind: 'process', command: 'powershell.exe', args: ['-NoExit', '-Command', powershell] },
      {
        kind: 'process',
        command: 'cmd.exe',
        args: ['/k', '"' + nodePath + '" "' + cliEntry + '"'],
      },
    ];
  }

  const preferred = env.TERMINAL?.trim();
  const commands = [
    ...(preferred && !/\s/.test(preferred) ? [preferred] : []),
    'x-terminal-emulator',
    'gnome-terminal',
    'konsole',
    'xfce4-terminal',
    'kitty',
    'alacritty',
    'xterm',
  ];
  return [...new Set(commands)].map((command): TerminalLaunchCandidate => {
    const args =
      command === 'gnome-terminal'
        ? ['--', ...nodeArgs]
        : command === 'konsole'
          ? ['-e', ...nodeArgs]
          : command === 'xfce4-terminal'
            ? ['--command', shellQuote(nodePath) + ' ' + shellQuote(cliEntry)]
            : command === 'kitty'
              ? ['--', ...nodeArgs]
              : command === 'alacritty'
                ? ['-e', ...nodeArgs]
                : ['-e', ...nodeArgs];
    return { kind: 'process', command, args };
  });
}

async function executableAvailable(command: string): Promise<boolean> {
  if (command.includes('/') || (process.platform === 'win32' && command.includes('\\'))) {
    return pathExists(command);
  }
  try {
    await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', [command]);
    return true;
  } catch {
    return false;
  }
}

async function macAppAvailable(application: string): Promise<boolean> {
  try {
    await execFileAsync('/usr/bin/open', ['-Ra', application]);
    return true;
  } catch {
    return false;
  }
}

function macAppleScript(application: 'iTerm2' | 'Terminal', command: string): string {
  if (application === 'iTerm2') {
    return [
      'tell application "iTerm2"',
      'activate',
      'if (count of windows) = 0 then',
      'create window with default profile',
      'end if',
      'tell current session of current window to write text ' + JSON.stringify(command),
      'end tell',
    ].join('\n');
  }
  return (
    'tell application "Terminal"\nactivate\ndo script ' + JSON.stringify(command) + '\nend tell'
  );
}

async function spawnTerminal(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('error', rejectSpawn);
    child.once('spawn', () => {
      child.unref();
      resolveSpawn();
    });
  });
}

export async function openHotplugTerminal(cliEntry: string): Promise<void> {
  const candidates = terminalLaunchCandidates(
    process.platform,
    process.env,
    process.execPath,
    cliEntry,
  );
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      if (candidate.kind === 'mac-app') {
        if (!(await macAppAvailable(candidate.application))) {
          continue;
        }
        const command = shellQuote(process.execPath) + ' ' + shellQuote(cliEntry);
        await execFileAsync('/usr/bin/osascript', [
          '-e',
          macAppleScript(candidate.application, command),
        ]);
        return;
      }
      if (!(await executableAvailable(candidate.command))) {
        continue;
      }
      await spawnTerminal(candidate.command, candidate.args);
      return;
    } catch (err) {
      errors.push(
        (candidate.kind === 'mac-app' ? candidate.application : candidate.command) +
          ': ' +
          String(err),
      );
    }
  }
  throw new HotplugError(
    'Could not find a supported terminal to open Hotplug on ' +
      process.platform +
      '.' +
      (errors.length ? ' ' + errors.join(' · ') : ''),
    'TRAY_TERMINAL_OPEN_FAILED',
  );
}
