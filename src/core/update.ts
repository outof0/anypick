/**
 * Self-update against the npm registry.
 *
 * npm-only on purpose: the binary ships through npm, and asking a different
 * package manager to update a global install it did not create leaves two
 * copies on PATH.
 */
import { spawn } from 'node:child_process';
import { ExitCode, AnyPickError } from '../utils/errors';

export const PACKAGE_NAME = 'anypick';

const REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const FETCH_TIMEOUT_MS = 10_000;

export interface UpdateStatus {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

export interface RegistryOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface VersionParts {
  release: number[];
  prerelease: string[];
}

function parseVersion(version: string): VersionParts {
  const core = version.trim().replace(/^v/, '').split('+')[0] ?? '';
  const dash = core.indexOf('-');
  const release = dash === -1 ? core : core.slice(0, dash);
  const prerelease = dash === -1 ? '' : core.slice(dash + 1);
  return {
    release: release.split('.').map((part) => Number.parseInt(part, 10) || 0),
    prerelease: prerelease === '' ? [] : prerelease.split('.'),
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  // Semver §11: a release outranks any prerelease of the same triple.
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) {
      return 0;
    }
    return left.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) {
      return -1;
    }
    if (r === undefined) {
      return 1;
    }
    if (l === r) {
      continue;
    }
    const lNumeric = /^\d+$/.test(l);
    const rNumeric = /^\d+$/.test(r);
    if (lNumeric && rNumeric) {
      return Number(l) < Number(r) ? -1 : 1;
    }
    if (lNumeric !== rNumeric) {
      return lNumeric ? -1 : 1;
    }
    return l < r ? -1 : 1;
  }
  return 0;
}

/** Semver ordering: -1 when `a` is older, 0 when equal, 1 when `a` is newer. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.release[i] ?? 0) - (right.release[i] ?? 0);
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** Read the `latest` dist-tag from the npm registry. */
export async function fetchLatestVersion(options: RegistryOptions = {}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${REGISTRY_ORIGIN}/${PACKAGE_NAME}/latest`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new AnyPickError(
      `Could not reach the npm registry: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        code: 'UPDATE_REGISTRY_UNREACHABLE',
        suggestions: [
          'Check your network or npm proxy, then retry',
          `Or install by hand: ${installCommand()}`,
        ],
      },
    );
  }
  if (response.status === 404) {
    throw new AnyPickError(`npm has no published package named "${PACKAGE_NAME}".`, {
      code: 'UPDATE_NOT_PUBLISHED',
      suggestions: ['Nothing to update. Builds installed from source update with git + pnpm build'],
    });
  }
  if (!response.ok) {
    throw new AnyPickError(`npm registry returned HTTP ${response.status} for ${PACKAGE_NAME}.`, {
      code: 'UPDATE_REGISTRY_UNREACHABLE',
      suggestions: [`Retry shortly, or install by hand: ${installCommand()}`],
    });
  }
  const body = (await response.json()) as { version?: unknown };
  if (typeof body.version !== 'string' || body.version === '') {
    throw new AnyPickError(`npm registry returned no version for ${PACKAGE_NAME}.`, {
      code: 'UPDATE_REGISTRY_UNREACHABLE',
      suggestions: [`Install by hand: ${installCommand()}`],
    });
  }
  return body.version;
}

export async function checkForUpdate(
  currentVersion: string,
  options: RegistryOptions = {},
): Promise<UpdateStatus> {
  const latest = await fetchLatestVersion(options);
  return {
    current: currentVersion,
    latest,
    updateAvailable: compareVersions(latest, currentVersion) > 0,
  };
}

export function installCommand(version = 'latest'): string {
  return `npm install -g ${PACKAGE_NAME}@${version}`;
}

/**
 * Hand the install to npm and let its own output be the progress report.
 * `silent` drops npm's stdout so `--json` and `--quiet` keep a clean stream;
 * stderr stays attached either way so failures are never swallowed.
 */
export async function installLatest(
  options: { version?: string; silent?: boolean } = {},
): Promise<void> {
  const version = options.version ?? 'latest';
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn('npm', ['install', '--global', `${PACKAGE_NAME}@${version}`], {
      stdio: ['ignore', options.silent ? 'ignore' : 'inherit', 'inherit'],
    });
    child.on('error', (cause: NodeJS.ErrnoException) => {
      reject(
        new AnyPickError(`Could not run npm: ${cause.message}`, {
          code: 'UPDATE_NPM_UNAVAILABLE',
          exitCode: ExitCode.MISSING_DEPENDENCY,
          suggestions: ['npm must be on PATH to self-update'],
        }),
      );
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new AnyPickError(`npm exited with code ${exitCode}.`, {
      code: 'UPDATE_INSTALL_FAILED',
      suggestions: [
        `Run it directly to see npm's own error: ${installCommand(version)}`,
        'A permission error means the global prefix is not user-owned',
      ],
    });
  }
}
