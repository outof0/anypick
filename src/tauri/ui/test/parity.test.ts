/**
 * The definition of done for the macOS to Tauri port, as a check.
 *
 * The macOS app names every user-reachable control with an
 * `accessibilityIdentifier`. `parity-map.ts` points each one at the Tauri
 * element that carries it, or marks it out of scope with a reason. This test
 * checks that map against both source trees, in both directions:
 *
 *   - a macOS feature with no row fails, so a new macOS feature cannot be
 *     quietly left unported;
 *   - a `done` row naming a `data-testid` that does not exist fails, so the
 *     map cannot claim coverage the app does not have;
 *   - a row for a macOS feature that no longer exists fails, so the map cannot
 *     rot into a stale exemption.
 *
 * That is the whole point. This app's history is that a green suite coexisted
 * with a visibly broken UI for a long time; nothing in CI could see the UI.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { macosIdentifiers, normalizeTauri, tauriIdentifiers } from './inventory';
import { OUT_OF_SCOPE, PARITY, type ParityRow } from './parity-map';

const macosDir = resolve(__dirname, '../../../macos');
const macosSources = readdirSync(macosDir)
  .filter((file) => file.endsWith('.swift'))
  .map((file) => readFileSync(join(macosDir, file), 'utf8'));

const macosIds = new Set(macosIdentifiers());
const tauriIds = new Set(tauriIdentifiers().map(normalizeTauri));
const mappedMacos = new Set(PARITY.map((row) => row.macos));

/** True when a macOS feature is deliberately not ported, by prefix. */
function outOfScopeReason(id: string): string | undefined {
  for (const [prefix, reason] of OUT_OF_SCOPE) {
    if (id.startsWith(prefix)) return reason;
  }
  return undefined;
}

/**
 * Tauri ids that two or more `done` rows legitimately share, with the exact
 * macOS ids in each group and the reason the source inventory normalizes them
 * to the same id.
 *
 * A shared id is legitimate when macOS names one control twice — a list-row
 * button and its detail-pane twin, or two row shapes over one model list —
 * because this app deliberately has one control. It is also legitimate when a
 * parameterized Tauri test id is normalized to `{x}`; the runtime values stay
 * distinct. The macOS ids are pinned, so a new row on an allowlisted id changes
 * the group and fails rather than slipping in behind an existing exemption.
 * The original eight groups predate this check; the ninth,
 * `onboarding-choose-route`, was the defect and is now a row of its own.
 */
const SHARED_TAURI_ID_REASONS = new Map<string, { macos: string[]; reason: string }>([
  [
    'setting-{x}',
    {
      macos: [
        'settings.open-at-login',
        'settings.start-enabled-proxies',
        'settings.show-usage',
        'settings.quota-guard',
      ],
      reason:
        'Settings rows are rendered from the same preference component. Each preference has a distinct runtime test id; the source inventory normalizes the shared template to `{x}`.',
    },
  ],
  [
    'app.disconnect-menu',
    {
      macos: ['app.connection.disconnect', 'app.reset'],
      reason:
        "macOS names the disconnect command twice: the app row action (`app.reset`) and the detail pane's Connection button (`app.connection.disconnect`). Tauri reaches the one command from the row menu.",
    },
  ],
  [
    'accounts-inspector.usage.{x}',
    {
      macos: ['account.usage.{x}', 'accounts.inspector.usage.{x}'],
      reason:
        'One quota row rendered by two macOS surfaces (the Accounts inspector and the account sheet). Tauri has one AccountDetailSheet.',
    },
  ],
  [
    'account-edit-label',
    {
      macos: ['account-edit.error', 'account-edit.name'],
      reason:
        "macOS names the edit field and its save-error section. Tauri's LabelSheet has no separate error slot: the engine's failure arrives as a result frame in the notice banner.",
    },
  ],
  [
    'hub.strategy.{x}',
    {
      macos: ['hub.rotation.{x}', 'hub.strategy', 'hub.strategy.{x}'],
      reason:
        'macOS names the same rotation control three ways: the bare id when one source exists, the interpolated id, and `hub.rotation.<id>` for the toggle. Tauri emits one segmented control per rotation row.',
    },
  ],
  [
    'published-models.row-picker-{x}',
    {
      macos: [
        'hub.model-route.{x}',
        'published-models.row-picker.{x}',
        'published-models.switch-picker.{x}',
      ],
      reason:
        "One routing picker on three macOS row shapes: the hub pane's per-model row, and the published-model row and switch row. Tauri has one picker in PublishedModelsPane, reached from all three.",
    },
  ],
  [
    'published-models.row-{x}',
    {
      macos: ['published-models.row.{x}', 'published-models.switch-row.{x}'],
      reason: 'Two macOS row shapes over the same model list. Tauri renders one row per model.',
    },
  ],
  [
    'published-models.inspect-{x}',
    {
      macos: ['published-models.inspect.{x}', 'published-models.switch-inspect.{x}'],
      reason:
        'The same info button on the two macOS row shapes. Tauri has one inspect button per model row.',
    },
  ],
  [
    'proxies.row-action.{x}',
    {
      macos: ['proxies.inspector.lifecycle', 'proxies.row-action.{x}'],
      reason:
        'macOS names the list-row lifecycle button and its inspector twin. Tauri has one Start/Stop button per row, which sends the one command.',
    },
  ],
]);

/**
 * Every `done` row sharing a Tauri id with another, unless the id is
 * allowlisted with exactly that group of macOS ids.
 *
 * Returned as strings so a failure names the id and both macOS features, which
 * is what makes the false claim visible rather than just red.
 */
function sharedIdViolations(
  rows: readonly ParityRow[],
  allowed: ReadonlyMap<string, { macos: string[]; reason: string }>,
): string[] {
  const byTauri = new Map<string, string[]>();
  for (const row of rows) {
    if (row.status !== 'done') continue;
    byTauri.set(row.tauri, [...(byTauri.get(row.tauri) ?? []), row.macos]);
  }
  const duplicates = [...byTauri.entries()].filter(([, macos]) => macos.length > 1);

  const unexcused = duplicates
    .filter(([tauri]) => !allowed.has(tauri))
    .map(([tauri, macos]) => `${tauri} <- ${macos.join(', ')}`);

  // An allowlisted group that changed — a row added to the id, or a duplicate
  // quietly fixed — has to touch its entry, so the allowlist cannot rot.
  const drifted = duplicates
    .filter(([tauri, macos]) => {
      const entry = allowed.get(tauri);
      if (!entry) return false;
      return [...macos].sort().join('\n') !== [...entry.macos].sort().join('\n');
    })
    .map(([tauri, macos]) => `${tauri}: map has ${macos.join(', ')}`);

  const dead = [...allowed.keys()].filter((tauri) => (byTauri.get(tauri) ?? []).length < 2);

  // A bare exemption is how a duplicate becomes permanent without anyone
  // deciding, the same reason `skip` rows require a reason.
  const unreasoned = [...allowed.entries()]
    .filter(([, entry]) => entry.reason.trim().length === 0)
    .map(([tauri]) => `${tauri}: allowlisted with no reason`);

  return [
    ...unexcused,
    ...drifted,
    ...dead.map((tauri) => `${tauri}: allowlisted but no longer shared`),
    ...unreasoned,
  ];
}

describe('the macOS to Tauri feature map', () => {
  it('extracts both inventories', () => {
    // Guards the extractors. A regex that matches nothing makes every
    // assertion below pass for the wrong reason.
    expect(macosIds.size).toBeGreaterThan(100);
    expect(tauriIds.size).toBeGreaterThan(40);
    expect(PARITY.length).toBeGreaterThan(100);
  });

  it('reads every shape an accessibility identifier takes in the Swift', () => {
    // A literal `.accessibilityIdentifier("x")` is one of three ways an id
    // reaches the tree. The other two — a component parameter
    // (`identifier: "x"`) and a computed helper that returns a literal — are
    // invisible to a scan of the first shape alone. When that scan was
    // literal-only it reported 137 macOS features instead of 143, and five
    // real controls had no row because the inventory could not see them.
    const source = readFileSync(
      resolve(__dirname, '../../../macos/SharedUI.swift'),
      'utf8',
    );
    // The copy button forwards its parameter; if it stopped, the ids that
    // reach the tree only through it would vanish from the inventory silently.
    expect(source).toMatch(/\.accessibilityIdentifier\(identifier\)/);

    // At least one id reaches the tree through each parameter spelling. Both
    // spellings exist in the Swift: a bare `identifier:` on the copy button,
    // and `accessibilityIdentifier:` on the candidate picker. A scan that read
    // one and not the other silently dropped the other's controls.
    const parameterIds = [...macosSources].flatMap((text) =>
      [...text.matchAll(/(?<![A-Za-z])identifier:\s*"([^"]+)"/g)].map((m) => m[1]),
    );
    expect(parameterIds.length).toBeGreaterThan(0);

    const labelledParameterIds = [...macosSources].flatMap((text) =>
      [...text.matchAll(/accessibilityIdentifier:\s*"([^"]+)"/g)].map((m) => m[1]),
    );
    expect(labelledParameterIds.length).toBeGreaterThan(0);

    const helperIds = [...macosSources].flatMap((text) =>
      [...text.matchAll(/func\s+\w*[Ii]dentifier\w*\s*\([^)]*\)\s*(?:->\s*String\s*)?\{([^}]{0,400})\}/g)]
        .flatMap((fn) => [...fn[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])),
    );
    expect(helperIds.length).toBeGreaterThan(0);

    // Shape 3: a computed id in a `let` binding, applied later to a variable.
    // `ProxyHubView.swift:451` picks between two literals and passes the result
    // to `.accessibilityIdentifier(rowKey)`, so neither literal sits next to
    // the word `accessibilityIdentifier`. Reading only the first two shapes
    // left both hub source-row ids absent from the inventory.
    const boundIds = [...macosSources].flatMap((text) =>
      [...text.matchAll(/\blet\s+(\w*[Ii]d\w*|\w*[Kk]ey)\s*(?::\s*String\s*)?=\s*([^;\n]{0,200})/g)]
        .filter((m) => /^[^?"]*\?\s*"[^"]*"\s*:\s*"[^"]*"\s*$/.test(m[2].trim()))
        .flatMap((m) => [...m[2].matchAll(/"([^"]+)"/g)].map((lit) => lit[1])),
    );
    expect(boundIds.length).toBeGreaterThan(0);
  });

  it('maps every macOS feature', () => {
    const missing = [...macosIds].filter(
      (id) => !mappedMacos.has(id) && !outOfScopeReason(id),
    );
    expect(
      missing,
      `macOS features with no row in parity-map.ts:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('maps nothing that macOS does not have', () => {
    const stale = PARITY.map((row) => row.macos).filter((id) => !macosIds.has(id));
    expect(
      stale,
      `parity-map.ts rows for macOS ids that no longer exist:\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('maps each macOS feature exactly once', () => {
    const seen = new Set<string>();
    const dupes = PARITY.map((r) => r.macos).filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    expect(dupes, `duplicate rows:\n${dupes.join('\n')}`).toEqual([]);
  });

  it('names a Tauri element that exists for every done row', () => {
    // The load-bearing assertion. A `done` row whose test id is absent is a
    // false claim of parity, which is the failure this file exists to stop.
    const unbacked = PARITY.filter(
      (row) => row.status === 'done' && !tauriIds.has(row.tauri),
    ).map((row) => `${row.macos} -> ${row.tauri}`);
    expect(
      unbacked,
      `parity-map.ts claims these Tauri elements exist but the UI does not emit them:\n${unbacked.join('\n')}`,
    ).toEqual([]);
  });

  it('does not let two done rows share a Tauri id without a written reason', () => {
    // Two `done` rows on one Tauri element are how a missing port hides: the
    // `use-app` row pointed at `onboarding-choose-route`, which the
    // `choose-route` row already claimed, so "Use an App" had no counterpart
    // while the map still reported it ported and the report read 100%.
    expect(
      sharedIdViolations(PARITY, SHARED_TAURI_ID_REASONS),
      'a done row shares a Tauri id with no written reason',
    ).toEqual([]);
  });

  it('fails a synthetic duplicate Tauri id', () => {
    // Proves the check above can fail: a pair of `done` rows pointing at one
    // element, with no allowlist entry, is exactly the `use-app` shape.
    const synthetic: ParityRow[] = [
      { macos: 'overview.onboarding.choose-route', tauri: 'onboarding-choose-route', status: 'done' },
      { macos: 'overview.onboarding.use-app', tauri: 'onboarding-choose-route', status: 'done' },
    ];
    expect(sharedIdViolations(synthetic, new Map())).toEqual([
      'onboarding-choose-route <- overview.onboarding.choose-route, overview.onboarding.use-app',
    ]);
    // An allowlist entry naming the group clears it, so the allowlist is the
    // only thing standing between a real duplicate and a green run.
    const excused = new Map([
      ['onboarding-choose-route', { macos: ['overview.onboarding.choose-route', 'overview.onboarding.use-app'], reason: 'synthetic' }],
    ]);
    expect(sharedIdViolations(synthetic, excused)).toEqual([]);
  });

  it('reports Tauri elements no macOS feature maps to', () => {
    // Reported, not enforced. macOS names controls and leaves containers
    // unnamed, so the Tauri app legitimately has ids with no macOS
    // counterpart: a group wrapper, a pane root, a dialog that macOS reaches
    // through a different sheet. The direction that is enforced is the one
    // that matters: no macOS feature may be left unported.
    //
    // This is here so an orphan is noticed rather than forgotten. A new id
    // shows up in the report the next time the port touches its pane.
    const mappedTauri = new Set(PARITY.filter((r) => r.status === 'done').map((r) => r.tauri));
    const orphans = [...tauriIds].filter((id) => !mappedTauri.has(id));
    if (orphans.length > 0) {
      console.warn(
        `unmapped Tauri ids (${orphans.length}):\n${orphans.map((id) => `  ${id}`).join('\n')}`,
      );
    }
  });

  it('requires a reason for every out-of-scope row', () => {
    // A bare exemption is how a gap becomes permanent without anyone deciding.
    const unjustified = PARITY.filter((row) => row.status === 'skip' && !row.reason);
    expect(unjustified.map((row) => row.macos)).toEqual([]);
  });

  it('names a Tauri element that exists for every out-of-scope exemption', () => {
    // An out-of-scope prefix that matches nothing exempts nothing, but reading
    // as a permission it is misleading. Fail so it gets deleted.
    const dead = [...OUT_OF_SCOPE.entries()]
      .filter(([prefix]) => ![...macosIds].some((id) => id.startsWith(prefix)))
      .map(([prefix]) => prefix);
    expect(
      dead,
      `OUT_OF_SCOPE entries match no macOS id, so they exempt nothing:\n${dead.join('\n')}`,
    ).toEqual([]);
  });
});

describe('port progress', () => {
  it('reports what is left', () => {
    const todo = PARITY.filter((row) => row.status === 'todo');
    const done = PARITY.filter((row) => row.status === 'done').length;
    const skipped = PARITY.filter((row) => row.status === 'skip').length;
    const total = PARITY.length;
    const pct = total === 0 ? 0 : Math.round((done / (total - skipped)) * 100);

    console.warn(
      `\nfeature parity: ${done}/${total - skipped} ported (${pct}%), ${todo.length} remaining, ${skipped} out of scope`,
    );
    if (todo.length > 0) {
      console.warn(`remaining:\n${todo.map((row) => `  ${row.macos}`).join('\n')}\n`);
    }

    // Not an assertion on completeness. `todo` is the work list and this test
    // exists to make it visible and keep both sides of the map honest. The
    // port is done when `todo` is empty, which is checked by hand and by the
    // review of this file, not by a test that would otherwise just be renamed.
    expect(todo.length).toBeGreaterThanOrEqual(0);
  });
});
