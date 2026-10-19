import { writeFile } from 'node:fs/promises';

// Refresh before deployment so the static links target a published release,
// including releases that intentionally omit a desktop platform.
const response = await fetch('https://api.github.com/repos/outof0/anypick/releases/latest', {
  headers: { Accept: 'application/vnd.github+json' },
  signal: AbortSignal.timeout(15000),
});
if (!response.ok) throw new Error(`GitHub release lookup failed: ${response.status}`);
const release = await response.json();
if (!/^v\d+\.\d+\.\d+$/.test(release.tag_name) || release.draft || release.prerelease || !release.assets?.length) {
  throw new Error('Expected a published stable release with assets');
}
const prefix = `https://github.com/outof0/anypick/releases/download/${release.tag_name}/`;
const assets = release.assets.map(({ name, size, browser_download_url }) => {
  if (!browser_download_url.startsWith(prefix) || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error(`Invalid release asset: ${name}`);
  }
  return { name, size, browser_download_url };
});
await writeFile(new URL('../src/data/release.json', import.meta.url), JSON.stringify({
  version: release.tag_name,
  url: release.html_url,
  assets,
}, null, 2) + '\n');
console.log(`Download links refreshed: ${release.tag_name}, ${assets.length} assets`);
