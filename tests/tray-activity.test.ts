import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TrayActivityService } from '../src/tray/activity';

describe('tray activity', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it('persists bounded, single-line events below an explicit temporary root', async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-tray-activity-'));
    const activity = new TrayActivityService(root);
    const written = await activity.record('Switched\nto work account.', false, 'switch');

    const reloaded = await new TrayActivityService(root).list();

    expect(reloaded).toEqual([written]);
    expect(reloaded[0]).toMatchObject({
      message: 'Switched to work account.',
      isError: false,
      kind: 'switch',
    });
    expect(reloaded[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('deduplicates imported Quota Guard audit events across tray refreshes', async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-tray-activity-'));
    const activity = new TrayActivityService(root);
    const first = await activity.record(
      'Quota Guard switched gemini/a → b.',
      false,
      'quota',
      'q-1',
    );
    const second = await activity.record(
      'Quota Guard switched gemini/a → b.',
      false,
      'quota',
      'q-1',
    );
    expect(second).toEqual(first);
    expect(await activity.list()).toHaveLength(1);
  });
});
