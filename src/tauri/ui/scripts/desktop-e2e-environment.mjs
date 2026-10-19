import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Resolve tooling before removing the runner's developer PATH (ADR 0020 §8).
export async function resolveExecutable(name, parent = process.env, platform = process.platform) {
  const path = parent.PATH ?? parent.Path ?? Object.entries(parent).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const directory of path.split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    const candidate = resolve(directory, name);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* Try the next PATH entry. */ }
  }
  throw new Error(`Required native E2E tool was not found: ${name}`);
}

export function driverEnvironment(home, parent = process.env) {
  const environment = {};
  for (const key of ['PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS']) {
    if (parent[key]) environment[key] = parent[key];
  }
  return Object.assign(environment, {
    // The directory stays empty. Both drivers are launched by absolute path;
    // the app and its Go child must work without any executable on PATH.
    PATH: join(home, 'empty-path'),
    HOME: home, USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    TMPDIR: join(home, 'tmp'), TEMP: join(home, 'tmp'), TMP: join(home, 'tmp'),
    ANYPICK_HOME: join(home, '.anypick'),
    ANYPICK_CLAUDE_NO_KEYCHAIN: '1', ANYPICK_KIRO_NO_KEYCHAIN: '1',
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
  });
}
