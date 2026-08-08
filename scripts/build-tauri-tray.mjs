import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifest = resolve(root, 'src/tray/tauri/src-tauri/Cargo.toml');
const executable = process.platform === 'win32' ? 'anypick-tray.exe' : 'anypick-tray';
const source = resolve(root, 'src/tray/tauri/src-tauri/target/release', executable);
const extension = process.platform === 'win32' ? '.exe' : '';
const destination = resolve(
  root,
  'dist/tray/bin',
  `anypick-tray-${process.platform}-${process.arch}${extension}`,
);

if (!['linux', 'win32'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) {
  throw new Error('The packaged Tauri tray is built on Linux or Windows x64/arm64 runners.');
}

execFileSync('cargo', ['build', '--release', '--manifest-path', manifest], {
  cwd: root,
  stdio: 'inherit',
});
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
console.log(`Copied ${destination}`);
