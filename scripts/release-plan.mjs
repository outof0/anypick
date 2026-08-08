import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cargoManifestPath = resolve(root, 'src/tray/tauri/src-tauri/Cargo.toml');
const cargoLockPath = resolve(root, 'src/tray/tauri/src-tauri/Cargo.lock');
const packagePath = resolve(root, 'package.json');
const tauriConfigPath = resolve(root, 'src/tray/tauri/src-tauri/tauri.conf.json');
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(message) {
  throw new Error(`Release planning failed: ${message}`);
}

function parseVersion(value, source) {
  const match = stableVersionPattern.exec(value);
  if (!match) {
    fail(`${source} must use a stable x.y.z version; received ${JSON.stringify(value)}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    text: value,
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readCargoManifestVersion(source) {
  const packageStart = source.search(/^\[package\]\s*$/m);
  const nextSection = source.indexOf('\n[', packageStart + '[package]'.length);
  const packageSection = source.slice(packageStart, nextSection === -1 ? undefined : nextSection);
  const version = packageSection?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!version) fail('Cargo.toml does not contain package.version');
  return version;
}

function readCargoLockVersion(source) {
  const entry = source.match(
    /^\[\[package\]\]\s*\nname\s*=\s*"anypick-tray"\s*\nversion\s*=\s*"([^"]+)"/m,
  );
  if (!entry) fail('Cargo.lock does not contain the anypick-tray package');
  return entry[1];
}

function readVersions() {
  const versions = {
    'package.json': readJson(packagePath).version,
    'Cargo.toml': readCargoManifestVersion(readFileSync(cargoManifestPath, 'utf8')),
    'Cargo.lock': readCargoLockVersion(readFileSync(cargoLockPath, 'utf8')),
    'tauri.conf.json': readJson(tauriConfigPath).version,
  };

  for (const [source, version] of Object.entries(versions)) parseVersion(version, source);
  const unique = new Set(Object.values(versions));
  if (unique.size !== 1) {
    fail(`version files disagree: ${JSON.stringify(versions)}`);
  }

  return Object.values(versions)[0];
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', options.allowStderr ? 'inherit' : 'pipe'],
  }).trim();
}

function latestStableTag() {
  const tags = git(['tag', '--merged', 'HEAD', '--sort=-version:refname', '--list', 'v*']);
  return tags
    .split('\n')
    .filter(Boolean)
    .find((tag) => stableVersionPattern.test(tag.slice(1)));
}

function releaseBump(commits) {
  let bump;

  for (const commit of commits) {
    const [header = '', ...bodyLines] = commit.split('\n');
    const conventional = header.match(/^([a-z]+)(?:\([^\n)]+\))?(!)?:\s+.+$/);
    const breakingFooter = bodyLines.some((line) => /^BREAKING(?: |-)?CHANGE:\s*\S/.test(line));

    if (conventional?.[2] || breakingFooter) return 'major';
    if (conventional?.[1] === 'feat') bump = bump === 'major' ? bump : 'minor';
    if (['fix', 'perf'].includes(conventional?.[1]) && !bump) bump = 'patch';
  }

  return bump;
}

function commitsInRange(range) {
  const log = git(['log', '--format=%B%x1e', range]);
  return log
    .split('\x1e')
    .map((commit) => commit.trim())
    .filter(Boolean);
}

function increment(version, bump) {
  const parsed = parseVersion(version, 'current release');
  if (bump === 'major') return `${parsed.major + 1}.0.0`;
  if (bump === 'minor') return `${parsed.major}.${parsed.minor + 1}.0`;
  if (bump === 'patch') return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  fail(`unknown release bump ${JSON.stringify(bump)}`);
}

function tagCommit(tag) {
  return git(['rev-list', '-n', '1', tag]);
}

function headCommit() {
  return git(['rev-parse', 'HEAD']);
}

function pendingReleasePlan(current, latestTag, subject, commits) {
  if (subject !== `chore(release): v${current}`) return undefined;
  const previousVersion = latestTag.slice(1);
  const bump = releaseBump(commits);
  if (!bump || increment(previousVersion, bump) !== current) return undefined;

  return { bump, mode: 'pending', previousTag: latestTag, tag: `v${current}`, version: current };
}

function planRelease({
  commits = [],
  current,
  head = '',
  headSubject = '',
  latestTag,
  latestTagCommit = '',
  pendingCommits = [],
}) {
  if (!latestTag) {
    return {
      bump: 'current',
      mode: 'initial',
      previousTag: '',
      tag: `v${current}`,
      version: current,
    };
  }

  const previousVersion = latestTag.slice(1);
  parseVersion(previousVersion, latestTag);

  if (latestTagCommit === head) {
    if (previousVersion !== current) {
      fail(`${latestTag} points at HEAD but the source version is ${current}`);
    }
    return {
      bump: 'current',
      mode: 'resume',
      previousTag: latestTag,
      tag: latestTag,
      version: current,
    };
  }

  if (previousVersion !== current) {
    const pending = pendingReleasePlan(current, latestTag, headSubject, pendingCommits);
    if (pending) return pending;
    fail(`latest tag ${latestTag} disagrees with the source version ${current}`);
  }

  const bump = releaseBump(commits);
  if (!bump) {
    fail(`no feat, fix, perf or breaking Conventional Commit exists after ${latestTag}`);
  }

  const version = increment(current, bump);
  return { bump, mode: 'release', previousTag: latestTag, tag: `v${version}`, version };
}

function createPlan() {
  const current = readVersions();
  const latestTag = latestStableTag();
  if (!latestTag) return planRelease({ current });

  const latestTagCommit = tagCommit(latestTag);
  const head = headCommit();
  const previousVersion = latestTag.slice(1);

  if (latestTagCommit === head) {
    return planRelease({ current, head, latestTag, latestTagCommit });
  }

  if (previousVersion !== current) {
    return planRelease({
      current,
      head,
      headSubject: git(['log', '-1', '--format=%s']),
      latestTag,
      latestTagCommit,
      pendingCommits: commitsInRange(`${latestTag}..HEAD^`),
    });
  }

  return planRelease({
    commits: commitsInRange(`${latestTag}..HEAD`),
    current,
    head,
    latestTag,
    latestTagCommit,
  });
}

function replaceExactlyOnce(source, pattern, version, path) {
  const matches = source.match(
    new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`),
  );
  if (matches?.length !== 1)
    fail(`expected one version field in ${path}, found ${matches?.length ?? 0}`);
  return source.replace(pattern, (_match, prefix, suffix) => `${prefix}${version}${suffix}`);
}

function writeJsonVersion(path, version) {
  const value = readJson(path);
  value.version = version;
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeVersions(version) {
  writeJsonVersion(packagePath, version);
  writeJsonVersion(tauriConfigPath, version);

  const manifest = readFileSync(cargoManifestPath, 'utf8');
  const nextManifest = replaceExactlyOnce(
    manifest,
    /(^\[package\]\s*$[\s\S]*?^version\s*=\s*")[^"]+("\s*$)/m,
    version,
    'Cargo.toml',
  );
  writeFileSync(cargoManifestPath, nextManifest);

  const lock = readFileSync(cargoLockPath, 'utf8');
  const nextLock = replaceExactlyOnce(
    lock,
    /(^\[\[package\]\]\s*\nname\s*=\s*"anypick-tray"\s*\nversion\s*=\s*")[^"]+("\s*$)/m,
    version,
    'Cargo.lock',
  );
  writeFileSync(cargoLockPath, nextLock);

  const written = readVersions();
  if (written !== version) fail(`wrote ${version}, then read back ${written}`);
}

function emitPlan(plan) {
  const lines = [
    `mode=${plan.mode}`,
    `previous_tag=${plan.previousTag}`,
    `bump=${plan.bump}`,
    `version=${plan.version}`,
    `tag=${plan.tag}`,
  ];
  process.stdout.write(`Release plan\n  ${lines.join('\n  ')}\n`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  }
}

function main() {
  const command = process.argv[2] ?? 'plan';

  if (command === 'check') {
    const version = readVersions();
    process.stdout.write(`Release versions are synchronized at ${version}.\n`);
  } else if (command === 'plan' || command === 'prepare') {
    const plan = createPlan();
    if (command === 'prepare' && plan.version !== readVersions()) writeVersions(plan.version);
    emitPlan(plan);
  } else {
    fail(`expected "check", "plan" or "prepare"; received ${JSON.stringify(command)}`);
  }
}

export { increment, planRelease, releaseBump };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
