import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppReady, type AnyPickApp } from '../src/core/app';
import { buildTrayGatewayProviders } from '../src/tray/snapshot-resources';

describe('tray gateway providers include api-key account providers', () => {
  let root: string;
  let app: AnyPickApp;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anypick-tray-gw-'));
    app = await createAppReady({ root, skipMigrate: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('surfaces Kiro as an account-api-key entry carrying its regions', () => {
    const providers = buildTrayGatewayProviders(app);
    const kiro = providers.find((provider) => provider.id === 'kiro');

    // Regions come from the provider's own credentialInputFields — no hardcoding.
    const regionField = app.accountRegistry
      .get('kiro')
      .credentialInputFields?.('api-key')
      .find((field) => field.name === 'region');

    expect(kiro).toBeDefined();
    expect(kiro?.kind).toBe('account-api-key');
    expect(kiro?.regions).toEqual(regionField?.choices);
    expect(kiro?.regionDefault).toBe(regionField?.default);
  });

  it('marks catalog gateway providers as kind gateway', () => {
    const providers = buildTrayGatewayProviders(app);
    const gateways = providers.filter((provider) => provider.kind === 'gateway');

    expect(gateways.length).toBeGreaterThan(0);
    // A catalog gateway is never mistaken for an api-key account.
    expect(gateways.every((provider) => provider.regions === undefined)).toBe(true);
  });
});
