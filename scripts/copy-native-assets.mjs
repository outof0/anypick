import { copyFile, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const nativeSourceDir = resolve('src/tray/native');
const nativeDestDir = resolve('dist/tray/native');
await mkdir(nativeDestDir, { recursive: true });

const manifest = await readFile(join(nativeSourceDir, 'sources.txt'), 'utf8').catch(() => '');
const names = manifest
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#') && line.endsWith('.swift'));

const files =
  names.length > 0
    ? names
    : (await readdir(nativeSourceDir)).filter((name) => name.endsWith('.swift')).sort();

for (const name of files) {
  await copyFile(join(nativeSourceDir, name), join(nativeDestDir, name));
}
await writeFile(join(nativeDestDir, 'sources.txt'), `${files.join('\n')}\n`);

// Keep a short pointer so older tooling that looks for AnyPickTray.swift fails loudly
// with a useful message instead of compiling a stale monolith.
await mkdir(resolve('dist/tray'), { recursive: true });
await writeFile(
  resolve('dist/tray/AnyPickTray.swift'),
  [
    '// AnyPickTray.swift was split into src/tray/native/*.swift',
    '// The build compiles every module listed in native/sources.txt.',
    '// Do not add code here.',
    '',
  ].join('\n'),
);

for (const icon of [
  'claude.svg',
  'openai.svg',
  'googlegemini.svg',
  'opencode.svg',
  'openrouter.svg',
  'kiro.svg',
  'grok.svg',
]) {
  const iconSource = resolve('src/tray/icons', icon);
  const iconDestination = resolve('dist/tray/icons', icon);
  await mkdir(dirname(iconDestination), { recursive: true });
  await copyFile(iconSource, iconDestination);
}

// Dock / Cmd-Tab brand mark for the minimal AnyPick.app bundle.
for (const icon of [
  'icon-16.png',
  'icon-32.png',
  'icon-64.png',
  'icon-128.png',
  'icon-256.png',
  'icon-512.png',
  'icon-1024.png',
]) {
  const iconSource = resolve('assets', icon);
  const iconDestination = resolve('dist/tray/app-icons', icon);
  await mkdir(dirname(iconDestination), { recursive: true });
  await copyFile(iconSource, iconDestination);
}
