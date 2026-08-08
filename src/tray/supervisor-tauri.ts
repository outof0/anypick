import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnyPickError } from '../utils/errors';
import { resolveBinary } from '../utils/process';

export type TauriTrayPlatform = 'linux' | 'win32';
export type TauriTrayArch = 'x64' | 'arm64';

export interface TauriTrayResolutionOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  moduleDirectory?: string;
  override?: string;
}

export function tauriTrayBinaryName(platform: NodeJS.Platform, arch: string): string | undefined {
  if ((platform !== 'linux' && platform !== 'win32') || (arch !== 'x64' && arch !== 'arm64')) {
    return undefined;
  }
  const extension = platform === 'win32' ? '.exe' : '';
  return `anypick-tray-${platform}-${arch}${extension}`;
}

export function tauriTrayBinaryCandidates(opts: TauriTrayResolutionOptions = {}): string[] {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const override = opts.override ?? process.env.ANYPICK_TAURI_TRAY_BINARY;
  if (override) {
    if (!isAbsolute(override)) {
      throw new AnyPickError(
        'ANYPICK_TAURI_TRAY_BINARY must be an absolute path.',
        'TRAY_HELPER_INVALID',
      );
    }
    return [override];
  }
  const name = tauriTrayBinaryName(platform, arch);
  if (!name) {
    return [];
  }
  const moduleDirectory = opts.moduleDirectory ?? dirname(fileURLToPath(import.meta.url));
  return [join(moduleDirectory, 'bin', name)];
}

/** Resolve a prebuilt helper. End users never need a Rust toolchain at runtime. */
export async function tauriTrayBinary(
  opts: TauriTrayResolutionOptions = {},
): Promise<string | undefined> {
  const platform = opts.platform ?? process.platform;
  const mode = platform === 'win32' ? constants.F_OK : constants.X_OK;
  for (const candidate of tauriTrayBinaryCandidates(opts)) {
    try {
      await access(candidate, mode);
      return candidate;
    } catch {
      // Try the next packaged location when more are added in future releases.
    }
  }
  if (!opts.override && !process.env.ANYPICK_TAURI_TRAY_BINARY) {
    return (await resolveBinary(['anypick-tray'])) ?? undefined;
  }
  return undefined;
}
