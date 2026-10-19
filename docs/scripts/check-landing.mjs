import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const release = JSON.parse(await read('src/data/release.json'));
const locales = { '': 'en', 'zh-cn/': 'zh-CN', 'vi/': 'vi', 'de/': 'de', 'es/': 'es', 'fr/': 'fr', 'ja/': 'ja', 'ko/': 'ko', 'pt-br/': 'pt-BR' };
const sitemap = await read('dist/sitemap-0.xml');
const origin = 'https://anypick.dev/';
const releasePrefix = `https://github.com/outof0/anypick/releases/download/${release.version}/`;
const knownAssets = new Set(release.assets.map((asset) => asset.browser_download_url));
assert(knownAssets.size > 0, 'Release must include downloadable assets');
for (const asset of release.assets) {
  assert(asset.browser_download_url.startsWith(releasePrefix), `Unexpected asset origin: ${asset.name}`);
  assert(asset.size > 0, `Empty asset: ${asset.name}`);
}
for (const [path, lang] of Object.entries(locales)) {
  const html = await read(`dist/${path}index.html`);
  const page = new URL(path, origin).href;
  assert(html.includes(`lang="${lang}"`), `${path}: document language`);
  assert.equal((html.match(/<h1(?:\s|>)/g) ?? []).length, 1, `${path}: exactly one main heading`);
  assert.match(html, /<title>[^<]+<\/title>/, `${path}: title`);
  assert.match(html, /name="description" content="[^"]+"/, `${path}: description`);
  assert(html.includes(`rel="canonical" href="${page}"`), `${path}: self canonical`);
  assert(!html.includes('content="noindex"'), `${path}: indexable`);
  assert(sitemap.includes(`<loc>${page}</loc>`), `${path}: sitemap entry`);
  assert.equal((html.match(/hreflang=/g) ?? []).length, 10, `${path}: nine languages and x-default`);
  for (const [alternate, language] of Object.entries(locales)) {
    assert(html.includes(`hreflang="${language}" href="${new URL(alternate, origin).href}"`), `${path}: alternate ${language}`);
  }
  assert(html.includes('href="#download"'), `${path}: no-JS platform picker`);
  const downloads = [...html.matchAll(/href="(https:\/\/github\.com\/outof0\/anypick\/releases\/download\/[^\"]+)"/g)].map((match) => match[1]);
  assert(downloads.length >= 3, `${path}: direct downloads must be rendered without JavaScript`);
  for (const url of downloads) assert(knownAssets.has(url), `${path}: unknown release asset ${url}`);
  const structured = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)].map((match) => JSON.parse(match[1]));
  const app = structured.find((item) => item['@type'] === 'SoftwareApplication');
  assert(app, `${path}: application schema`);
  assert.equal(app.softwareVersion, release.version.replace(/^v/, ''), `${path}: current app version`);
  assert.equal(app.downloadUrl, `${page}#download`, `${path}: schema download destination`);
  assert(html.includes('property="og:image" content="https://anypick.dev/og-landing.png"'), `${path}: social preview`);
}
assert((await read('dist/robots.txt')).includes('Sitemap: https://anypick.dev/sitemap-index.xml'));
console.log(`Landing checks passed: ${Object.keys(locales).length} locales, SEO, sitemap, static download links (${release.version}).`);
