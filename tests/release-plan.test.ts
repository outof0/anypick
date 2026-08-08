import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { increment, planRelease, releaseBump } from '../scripts/release-plan.mjs';

const releaseWorkflow = readFileSync(
  join(import.meta.dirname, '..', '.github', 'workflows', 'release.yml'),
  'utf8',
);
const ciWorkflow = readFileSync(
  join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'),
  'utf8',
);
const tauriSmoke = readFileSync(
  join(import.meta.dirname, '..', 'scripts', 'smoke-tauri-tray.mjs'),
  'utf8',
);

describe('release plan', () => {
  it('uses the checked-in 1.0.0 version for the initial release', () => {
    expect(planRelease({ current: '1.0.0' })).toEqual({
      bump: 'current',
      mode: 'initial',
      previousTag: '',
      tag: 'v1.0.0',
      version: '1.0.0',
    });
  });

  it('selects the highest Conventional Commit bump', () => {
    expect(releaseBump(['fix(proxy): preserve errors', 'feat(tui): add route builder'])).toBe(
      'minor',
    );
    expect(releaseBump(['feat(core)!: replace the account codec'])).toBe('major');
    expect(releaseBump(['fix: correct a race'])).toBe('patch');
    expect(releaseBump(['docs: clarify installation'])).toBeUndefined();
  });

  it('increments stable versions without carrying lower components', () => {
    expect(increment('1.2.3', 'patch')).toBe('1.2.4');
    expect(increment('1.2.3', 'minor')).toBe('1.3.0');
    expect(increment('1.2.3', 'major')).toBe('2.0.0');
  });

  it('plans the next release from commits after the latest tag', () => {
    expect(
      planRelease({
        commits: ['feat(tui): add route builder'],
        current: '1.0.0',
        head: 'next',
        latestTag: 'v1.0.0',
        latestTagCommit: 'previous',
      }),
    ).toMatchObject({ bump: 'minor', mode: 'release', tag: 'v1.1.0', version: '1.1.0' });
  });

  it('recognizes a release commit whose tag push needs to be resumed', () => {
    expect(
      planRelease({
        current: '1.0.1',
        head: 'release-commit',
        headSubject: 'chore(release): v1.0.1',
        latestTag: 'v1.0.0',
        latestTagCommit: 'previous',
        pendingCommits: ['fix(proxy): preserve streaming errors'],
      }),
    ).toMatchObject({ bump: 'patch', mode: 'pending', tag: 'v1.0.1' });
  });

  it('resumes an existing tag without creating another version', () => {
    expect(
      planRelease({
        current: '1.0.0',
        head: 'same',
        latestTag: 'v1.0.0',
        latestTagCommit: 'same',
      }),
    ).toMatchObject({ bump: 'current', mode: 'resume', tag: 'v1.0.0' });
  });

  it('stops when there is no release-worthy Conventional Commit', () => {
    expect(() =>
      planRelease({
        commits: ['docs: clarify installation'],
        current: '1.0.0',
        head: 'next',
        latestTag: 'v1.0.0',
        latestTagCommit: 'previous',
      }),
    ).toThrow(/no feat, fix, perf or breaking Conventional Commit/);
  });

  it('publishes the verified tarball through an unambiguous local path', () => {
    expect(releaseWorkflow).toContain(
      'tarball="$(realpath "dist/anypick-${RELEASE_VERSION}.tgz")"',
    );
    expect(releaseWorkflow).toContain('npm publish "$tarball" --access public --ignore-scripts');
    expect(releaseWorkflow).not.toMatch(/npm publish ["']?dist\//);
  });

  it('runs infrastructure preflight before the first release mutation', () => {
    const preflight = releaseWorkflow.indexOf('- name: Validate release infrastructure');
    const mutation = releaseWorkflow.indexOf('- name: Commit version and push tag');
    expect(preflight).toBeGreaterThan(-1);
    expect(mutation).toBeGreaterThan(preflight);
  });

  it('publishes and deploys before exposing the GitHub Release', () => {
    const publish = releaseWorkflow.indexOf('- name: Publish the verified tarball to npm');
    const deploy = releaseWorkflow.indexOf('- name: Deploy verified docs to Cloudflare Pages');
    const githubRelease = releaseWorkflow.indexOf('- name: Create or update GitHub Release');
    expect(publish).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(publish);
    expect(githubRelease).toBeGreaterThan(deploy);
  });

  it('builds the Tauri frontend before compiling generate_context in CI and release', () => {
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      const frontend = workflow.indexOf('pnpm tray:ui:build');
      const cargoTest = workflow.indexOf(
        'cargo test --locked --manifest-path src/tray/tauri/src-tauri/Cargo.toml',
      );
      expect(frontend).toBeGreaterThan(-1);
      expect(cargoTest).toBeGreaterThan(frontend);
    }
  });

  it('keeps the headless Tauri protocol smoke out of demo mode', () => {
    expect(tauriSmoke).not.toContain("ANYPICK_TRAY_DEMO: '1'");
    expect(tauriSmoke).toContain("ANYPICK_TRAY_PROBE: '1'");
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      expect(workflow).toContain('pnpm tray:smoke');
      expect(workflow).not.toContain('xvfb-run');
    }
  });
});
