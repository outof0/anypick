/**
 * Spec §28.4 Golden / snapshot tests.
 * Snapshots strip ANSI so they are stable across TTY/color settings.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterHelpText } from '../src/cli/help';
import { formatUseSuccess, formatModel } from '../src/cli/errors';
import { createAppReady } from '../src/core/app';
import { DOCTOR_FIX_ALLOWLIST, formatForbiddenManual } from '../src/core/doctor';
import { hotplugError, ExitCode } from '../src/utils/errors';
import { planActivation } from '../src/core/activation-planner';
import { gatewayRef } from '../src/core/refs';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

function normalize(s: string): string {
  return stripAnsi(s)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trimEnd();
}

describe('§28.4 golden snapshots', () => {
  it('root help after-text is stable', () => {
    expect(normalize(afterHelpText())).toMatchSnapshot();
  });

  it('no-binding error is stable', () => {
    const err = hotplugError(
      'No Hotplug binding for claude. `run` will not use unmanaged native config.',
      'NO_ACTIVE_BINDING',
      {
        exitCode: ExitCode.CAPABILITY_CONFLICT,
        suggestions: ['hotplug use claude --with <source>', 'hotplug run claude --with <source>'],
        mutated: false,
      },
    );
    expect(normalize(err.toHuman())).toMatchSnapshot();
    expect(err.toJson()).toMatchSnapshot();
  });

  it('missing-dependency error is stable', () => {
    const err = hotplugError(
      'Required external proxy for kiro/work is not installed.',
      'MISSING_DEPENDENCY',
      {
        exitCode: ExitCode.MISSING_DEPENDENCY,
        suggestions: ['hotplug doctor claude'],
        mutated: false,
      },
    );
    expect(normalize(err.toHuman())).toMatchSnapshot();
  });

  it('deterministic not-found errors are stable', () => {
    const account = hotplugError('Account `grok/missing` was not found.', 'ACCOUNT_NOT_FOUND', {
      exitCode: ExitCode.NOT_FOUND,
      suggestions: ['hotplug list accounts'],
      mutated: false,
    });
    const gateway = hotplugError('Gateway `nope` was not found.', 'GATEWAY_NOT_FOUND', {
      exitCode: ExitCode.NOT_FOUND,
      suggestions: ['hotplug list gateways'],
      mutated: false,
    });
    expect(normalize(account.toHuman())).toMatchSnapshot();
    expect(normalize(gateway.toHuman())).toMatchSnapshot();
  });

  it('use success + model formatting are stable', () => {
    expect(
      normalize(
        formatUseSuccess({
          clientName: 'claude',
          sourceDisplay: 'grok/work',
          model: 'grok-4',
          transport: 'managed_builtin_proxy',
          scope: 'global',
        }),
      ),
    ).toMatchSnapshot();
    expect(formatModel({ mode: 'omitted' })).toMatchSnapshot();
    expect(formatModel({ mode: 'unknown', reason: 'legacy_migration' })).toMatchSnapshot();
    expect(formatModel({ mode: 'explicit', id: 'gpt-5' })).toMatchSnapshot();
  });

  it('doctor fix allowlist snapshot', () => {
    expect(DOCTOR_FIX_ALLOWLIST).toMatchSnapshot();
  });
});

describe('§28.4 dry-run plan + doctor report golden', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hotplug-golden-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Guards planner *composition* only: that this source/client pair yields this
  // step sequence. It deliberately proves nothing about whether each step does
  // work at execution time — see tests/plan-step-execution.test.ts for that.
  // Historically this snapshot was the only assertion touching
  // ValidateCredential/VerifyEffectiveState, which let both remain unimplemented.
  it('dry-run plan steps for gateway are stable', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    await app.profiles.create('openrouter-work', {
      provider: 'openrouter',
      endpoint: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
    });

    const plan = await planActivation(
      {
        mode: 'persistent',
        client: 'claude',
        source: gatewayRef('openrouter-work'),
      },
      {
        accounts: app.accounts,
        accountRegistry: app.accountRegistry,
        profiles: app.profiles,
        profileStore: app.profileStore,
        bindings: app.bindings,
        presets: app.presets,
        catalog: app.catalog,
        clients: app.clients,
        proxy: app.proxy,
      },
    );

    expect(plan.steps.map((s) => s.kind)).toMatchSnapshot();
    expect(plan.transport.capability).toMatchSnapshot();
  });

  it('doctor report shape is stable on empty root', async () => {
    const app = await createAppReady({ root, skipMigrate: true });
    const report = await app.doctor.run();
    // Stabilize: overlays are intentionally scanned from the process-wide temp
    // directory, so sibling tests (or another Hotplug process) may create them.
    // Doctor-specific tests cover the overlay finding itself.
    const stableChecks = report.checks.filter((c) => !c.id.startsWith('overlay:'));
    const checks = stableChecks.map((c) => ({
      id: c.id,
      ok: c.ok,
      message: c.message.replaceAll(root, '<ROOT>'),
      fixable: c.fixable,
      forbidden: c.forbidden,
    }));
    expect({ ok: stableChecks.every((c) => c.ok), checks }).toMatchSnapshot();
  });

  it('forbidden findings formatter is stable', () => {
    expect(
      normalize(
        formatForbiddenManual({
          id: 'x',
          kind: 'modify_native_auth',
          message: 'Would modify native auth',
          suggestions: ['hotplug use codex --with codex/personal'],
        }),
      ),
    ).toMatchSnapshot();
  });
});
