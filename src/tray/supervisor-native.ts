import { createHash } from 'node:crypto';
import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { trayRuntimeDir } from '../core/tray-runtime';
import { ensureDir, pathExists } from '../utils/fs';
import { AnyPickError } from '../utils/errors';
import type { TraySnapshot } from './snapshot-types';
import type { TrayProxyLogsResult } from './protocol';
import { nativeTraySwiftFiles } from './native-sources';

const execFileAsync = promisify(execFile);

/** Minimal .app so Dock shows "AnyPick" + brand icon instead of a bare binary. */
const NATIVE_APP_NAME = 'AnyPick.app';
const NATIVE_EXEC_NAME = 'AnyPick';

export function assertNativeTrayPlatform(): void {
  if (process.platform !== 'darwin') {
    throw new AnyPickError(
      'The native AnyPick menu-bar tray requires macOS.',
      'UNSUPPORTED_PLATFORM',
    );
  }
}

export async function nativeTrayBinary(root: string): Promise<string> {
  const { sources, assets, appIcons, hash } = await nativeTrayBundleFingerprint();
  const runtime = trayRuntimeDir(root);
  const appDir = join(runtime, NATIVE_APP_NAME);
  const contentsDir = join(appDir, 'Contents');
  const macosDir = join(contentsDir, 'MacOS');
  const resourcesDir = join(contentsDir, 'Resources');
  const binaryPath = join(macosDir, NATIVE_EXEC_NAME);
  const hashPath = join(runtime, 'native.sha256');
  const sourcesDir = join(runtime, 'native');
  await ensureDir(runtime);
  await ensureDir(sourcesDir);
  await ensureDir(macosDir);
  await ensureDir(resourcesDir);
  const iconDirectory = join(runtime, 'icons');
  await ensureDir(iconDirectory);
  await Promise.all(
    assets.map((asset) => writeFile(join(iconDirectory, asset.name), asset.data, { mode: 0o600 })),
  );

  const cachedHash = await readFile(hashPath, 'utf8').catch(() => '');
  if (cachedHash.trim() === hash && (await pathExists(binaryPath))) {
    return binaryPath;
  }

  const stagedPaths: string[] = [];
  for (const source of sources) {
    const dest = join(sourcesDir, source.name);
    await writeFile(dest, source.data, { mode: 0o600 });
    stagedPaths.push(dest);
  }

  try {
    await execFileAsync('/usr/bin/xcrun', [
      'swiftc',
      '-parse-as-library',
      ...stagedPaths,
      '-o',
      binaryPath,
      '-framework',
      'AppKit',
      '-framework',
      'SwiftUI',
    ]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new AnyPickError(
      `Could not build the native macOS tray helper. Install Xcode Command Line Tools and retry. ${detail}`,
      'TRAY_BUILD_FAILED',
    );
  }

  await writeFile(join(contentsDir, 'Info.plist'), nativeTrayInfoPlist(), { mode: 0o600 });
  await writeNativeAppIcon(resourcesDir, appIcons);

  await writeFile(hashPath, `${hash}\n`, { mode: 0o600 });
  return binaryPath;
}

/**
 * A running supervisor keeps its native helper alive across JavaScript rebuilds.
 * Let `anypick tray start` detect a changed Swift bundle and replace that old
 * helper instead of silently returning "already running" with stale UI.
 */
export async function nativeTrayNeedsRestart(
  root: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform !== 'darwin') {
    return false;
  }
  const cached = await readFile(join(trayRuntimeDir(root), 'native.sha256'), 'utf8').catch(
    () => '',
  );
  if (!cached.trim()) {
    return true;
  }
  const { hash } = await nativeTrayBundleFingerprint();
  return cached.trim() !== hash;
}

async function nativeTrayBundleFingerprint(): Promise<{
  sources: Array<{ name: string; data: string }>;
  assets: Array<{ name: string; data: Buffer }>;
  appIcons: Array<{ name: string; data: Buffer }>;
  hash: string;
}> {
  const nativePath = fileURLToPath(new URL('./native/', import.meta.url));
  const files = await nativeTraySwiftFiles(nativePath);
  const sources = await Promise.all(
    files.map(async (file) => ({
      name: basename(file),
      data: await readFile(file, 'utf8'),
    })),
  );
  const iconNames = [
    'claude.svg',
    'openai.svg',
    'googlegemini.svg',
    'opencode.svg',
    'openrouter.svg',
    'kiro.svg',
    'grok.svg',
  ];
  const assets = await Promise.all(
    iconNames.map(async (name) => ({
      name,
      data: await readFile(new URL(`./icons/${name}`, import.meta.url)),
    })),
  );
  // App / Dock icon PNGs: dist build copies assets → dist/tray/app-icons;
  // under tsx/dev, fall back to repo assets/.
  const appIconNames = [
    'icon-16.png',
    'icon-32.png',
    'icon-64.png',
    'icon-128.png',
    'icon-256.png',
    'icon-512.png',
    'icon-1024.png',
  ];
  const appIcons = await Promise.all(
    appIconNames.map(async (name) => {
      const candidates = [
        new URL(`./app-icons/${name}`, import.meta.url),
        new URL(`../../assets/${name}`, import.meta.url),
      ];
      for (const url of candidates) {
        try {
          return { name, data: await readFile(url) };
        } catch {
          // try next
        }
      }
      throw new AnyPickError(
        `Missing AnyPick app icon asset ${name} (expected dist/tray/app-icons or assets/).`,
        'TRAY_BUILD_FAILED',
      );
    }),
  );
  const hasher = createHash('sha256');
  for (const source of sources) {
    hasher.update(source.name).update(source.data);
  }
  for (const asset of assets) {
    hasher.update(asset.name).update(asset.data);
  }
  for (const icon of appIcons) {
    hasher.update(icon.name).update(icon.data);
  }
  hasher.update('bundle:AnyPick.app/v1');
  return { sources, assets, appIcons, hash: hasher.digest('hex') };
}

function nativeTrayInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>${NATIVE_EXEC_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>dev.anypick.tray</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>AnyPick</string>
  <key>CFBundleDisplayName</key>
  <string>AnyPick</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
`;
}

/** Build AppIcon.icns into Resources so Dock / Cmd-Tab use the brand mark. */
async function writeNativeAppIcon(
  resourcesDir: string,
  appIcons: Array<{ name: string; data: Buffer }>,
): Promise<void> {
  const bySize = new Map(
    appIcons.map((icon) => {
      const match = /^icon-(\d+)\.png$/.exec(icon.name);
      return [match ? Number(match[1]) : 0, icon.data] as const;
    }),
  );
  // iconutil requires the directory name to end with `.iconset`.
  const scratch = await mkdtemp(join(tmpdir(), 'anypick-icon-'));
  const iconset = join(scratch, 'AppIcon.iconset');
  await ensureDir(iconset);
  try {
    const entries: Array<[string, number]> = [
      ['icon_16x16.png', 16],
      ['diana.k@example.org', 32],
      ['icon_32x32.png', 32],
      ['ivan.p@example.net', 64],
      ['icon_128x128.png', 128],
      ['wendy.h@example.net', 256],
      ['icon_256x256.png', 256],
      ['wendy.h@example.net', 512],
      ['icon_512x512.png', 512],
      ['walt.e@example.net', 1024],
    ];
    for (const [fileName, size] of entries) {
      const data = bySize.get(size);
      if (!data) {
        continue;
      }
      await writeFile(join(iconset, fileName), data, { mode: 0o600 });
    }
    // Also keep a large PNG for runtime NSApp.applicationIconImage fallback.
    const png512 = bySize.get(512) ?? bySize.get(1024);
    if (png512) {
      await writeFile(join(resourcesDir, 'AppIcon.png'), png512, { mode: 0o600 });
    }
    const icnsPath = join(resourcesDir, 'AppIcon.icns');
    try {
      await execFileAsync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icnsPath]);
    } catch {
      // PNG fallback still covers Dock via NSApp.applicationIconImage.
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function sendSnapshot(native: ChildProcessWithoutNullStreams, snapshot: TraySnapshot): void {
  if (native.stdin.writable) {
    const payload = Buffer.from(JSON.stringify(snapshot), 'utf8').toString('base64');
    native.stdin.write(`snapshot\t${payload}\n`);
  }
}

export interface TrayCommandResult {
  version: 1;
  requestId: string;
  status: 'success' | 'error';
  message?: string;
}

export function sendResult(
  native: ChildProcessWithoutNullStreams,
  result: TrayCommandResult,
): void {
  if (native.stdin.writable) {
    const payload = Buffer.from(JSON.stringify(result), 'utf8').toString('base64');
    native.stdin.write(`result\t${payload}\n`);
  }
}

export function sendProxyLogs(
  native: ChildProcessWithoutNullStreams,
  result: TrayProxyLogsResult,
): void {
  if (native.stdin.writable) {
    const payload = Buffer.from(JSON.stringify(result), 'utf8').toString('base64');
    native.stdin.write(`logs\t${payload}\n`);
  }
}
