import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];

if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) {
  throw new Error('Usage: node scripts/verify-release-artifacts.mjs <x.y.z>');
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
if (packageJson.version !== version) {
  throw new Error(`package.json is ${packageJson.version}; expected ${version}`);
}

const tarball = resolve(root, `dist/anypick-${version}.tgz`);
const packedPackage = JSON.parse(
  execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }),
);
if (packedPackage.name !== packageJson.name || packedPackage.version !== version) {
  throw new Error(
    `tarball identity is ${packedPackage.name}@${packedPackage.version}; expected ${packageJson.name}@${version}`,
  );
}

const tray = resolve(root, 'dist/tray/bin/anypick-tray-linux-x64');
const trayStat = statSync(tray);
if (!trayStat.isFile() || trayStat.size === 0 || (trayStat.mode & 0o111) === 0) {
  throw new Error('Linux tray artifact is missing, empty or not executable');
}

const docsIndex = resolve(root, 'docs/dist/index.html');
if (!statSync(docsIndex).isFile()) throw new Error('docs/dist/index.html is missing');

process.stdout.write(`Verified npm, Linux tray and docs artifacts for v${version}.\n`);
