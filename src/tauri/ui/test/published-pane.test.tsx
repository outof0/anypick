import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { HubPublishedModel, Snapshot } from '../lib/contract';
import { createService, type ServicePort } from '../lib/service';
import { PublishedModelsPane } from '../panes';
import { FakeBridge, snapshotFixture } from './harness';

/**
 * The Published Models pane.
 *
 * The unit tests next door cover identity and routing arithmetic with no
 * webview. This file covers the part that only renders: which rows appear, what
 * the disclosure seed does, and that the inspector never hands a live secret to
 * the clipboard.
 */

const bridges: FakeBridge[] = [];

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
});

function serviceFor(onCopy?: (text: string) => void): ServicePort {
  const bridge = new FakeBridge();
  bridges.push(bridge);
  bridge.lastLine = null;
  const port = createService({ bridge }).port;
  return onCopy ? { ...port, copy: async (text: string) => { onCopy(text); return true; } } : port;
}

const twoModels: HubPublishedModel[] = [
  { id: 'claude-opus', ownerLabel: 'Work', ownerProviderId: 'claude', needsChoice: false },
  { id: 'claude-sonnet', ownerLabel: 'Work', ownerProviderId: 'claude', needsChoice: false },
];

function manyModels(count: number): HubPublishedModel[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `claude-model-${index}`,
    ownerLabel: 'Work',
    ownerProviderId: 'claude',
    needsChoice: false,
  }));
}

/**
 * The shell owns the search field, so the pane takes the query as a prop.
 * This harness owns it the way the shell does, which is what lets a test type
 * into it and then check that Reset Filters clears it.
 */
function Harness({
  snapshot,
  query = '',
  onCopy,
  onClearQuery,
}: {
  snapshot: Snapshot;
  query?: string;
  onCopy?: (text: string) => void;
  onClearQuery?: () => void;
}) {
  const [value, setValue] = useState(query);
  return (
    <>
      <input
        data-testid="toolbar-search-probe"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <PublishedModelsPane
        service={serviceFor(onCopy)}
        snapshot={snapshot}
        query={value}
        onClearQuery={() => {
          setValue('');
          onClearQuery?.();
        }}
      />
    </>
  );
}

function renderPane(snapshot: Snapshot, onCopy?: (text: string) => void, query = '') {
  const result = render(<Harness snapshot={snapshot} query={query} onCopy={onCopy} />);
  return { ...result, user: userEvent.setup() };
}

describe('vendor groups', () => {
  it('shows the rows without a click when the list is short', () => {
    // The screenshot of this pane is what caught it. Seeding the open set in an
    // effect meant the harness waited on the pane root, screenshotted the
    // collapsed state, and the image looked like a working list of nothing.
    const snapshot = snapshotFixture({ hubPublishedModels: twoModels });
    renderPane(snapshot);
    expect(screen.getByTestId('published-models.row-claude-opus')).toBeInTheDocument();
    expect(screen.getByTestId('published-models.row-claude-sonnet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull();
  });

  it('collapses a long list so it is not a wall', () => {
    const snapshot = snapshotFixture({ hubPublishedModels: manyModels(30) });
    renderPane(snapshot);
    expect(screen.queryByTestId('published-models.row-claude-model-0')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show' })).toBeInTheDocument();
  });

  it('opens a collapsed group on Show', async () => {
    const snapshot = snapshotFixture({ hubPublishedModels: manyModels(30) });
    const { user } = renderPane(snapshot);
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByTestId('published-models.row-claude-model-0')).toBeInTheDocument();
  });

  it('opens every group when a filter is active', async () => {
    // Filtering to one vendor and then showing that vendor collapsed reads as
    // an empty result.
    const snapshot = snapshotFixture({
      hubPublishedModels: [...twoModels, { id: 'gpt-4o', ownerLabel: 'Team', ownerProviderId: 'openai', needsChoice: false }],
    });
    const { user } = renderPane(snapshot);
    await user.selectOptions(screen.getByTestId('published-models.vendor-picker'), 'codex');
    expect(screen.getByTestId('published-models.row-gpt-4o')).toBeInTheDocument();
    expect(screen.queryByTestId('published-models.row-claude-opus')).toBeNull();
  });
});

describe('the catalog filter', () => {
  it('offers All, Multi-provider and one entry per vendor with counts', () => {
    const snapshot = snapshotFixture({
      hubPublishedModels: [
        ...twoModels,
        { id: 'gpt-4o', ownerLabel: 'Team', ownerProviderId: 'openai', needsChoice: false },
      ],
    });
    renderPane(snapshot);
    const picker = screen.getByTestId('published-models.vendor-picker') as HTMLSelectElement;
    const labels = [...picker.options].map((option) => option.textContent);
    expect(labels).toContain('All Catalogs (3)');
    expect(labels.some((label) => label?.startsWith('Anthropic Claude (2)'))).toBe(true);
    expect(labels.some((label) => label?.startsWith('OpenAI (1)'))).toBe(true);
  });
});

describe('the inspector', () => {
  it('shows the endpoint a client would call', async () => {
    const snapshot = snapshotFixture({ hubPublishedModels: twoModels });
    const { user } = renderPane(snapshot);
    await user.click(screen.getByTestId('published-models.inspect-claude-opus'));
    const dialog = within(screen.getByTestId('published-models.inspect-dialog'));
    expect(dialog.getByText('http://127.0.0.1:5200/v1')).toBeInTheDocument();
    expect(dialog.getByText('http://127.0.0.1:5200/v1/chat/completions')).toBeInTheDocument();
  });

  it('never copies a bearer into the cURL template', async () => {
    // ADR 0006. A template carrying a real key puts a live secret on the
    // clipboard and then in the user's shell history.
    const copied: string[] = [];
    const snapshot = snapshotFixture({ hubPublishedModels: twoModels });
    const { user } = renderPane(snapshot, (text) => copied.push(text));
    await user.click(screen.getByTestId('published-models.inspect-claude-opus'));
    await user.click(
      within(screen.getByTestId('published-models.inspect-dialog')).getByTestId('published-models.copy-curl'),
    );
    expect(copied.join('\n')).toContain('$ANYPICK_API_KEY');
    expect(copied.join('\n')).not.toMatch(/Bearer [A-Za-z0-9]/);
  });

  it('closes on Done', async () => {
    const snapshot = snapshotFixture({ hubPublishedModels: twoModels });
    const { user } = renderPane(snapshot);
    await user.click(screen.getByTestId('published-models.inspect-claude-opus'));
    await user.click(within(screen.getByTestId('published-models.inspect-dialog')).getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('published-models.inspect-dialog')).toBeNull();
  });
});

describe('routing', () => {
  it('offers a picker for a model two providers can serve, and invokes the chosen one', async () => {
    // The action id is the contract with `hub_routing.go:488`.
    const base = snapshotFixture();
    const snapshot = snapshotFixture({
      hubPublishedModels: [{ id: 'shared', ownerLabel: 'Work', ownerProviderId: 'claude', needsChoice: false }],
      hubCatalogs: [
        { accountID: 'hub/default/claude/work', catalog: 'claude', models: ['shared'] },
        { accountID: 'hub/default/openai/team', catalog: 'codex', models: ['shared'] },
      ],
      hubSources: [
        ...base.hubSources.filter((source) => !('rotates' in source)),
        {
          id: 'hub/default/openai/team',
          providerId: 'openai',
          name: 'team',
          label: 'Team',
          detail: 'team@studio.example',
          enabled: true,
          hub: 'default',
        },
      ],
    });

    const bridge = new FakeBridge();
    bridges.push(bridge);
    bridge.lastLine = null;
    const service = createService({ bridge }).port;
    render(<PublishedModelsPane service={service} snapshot={snapshot} />);
    const user = userEvent.setup();

    const picker = screen.getByTestId('published-models.row-picker-shared');
    await user.selectOptions(picker, 'model-route:shared:provider/openai');
    expect(bridge.commands().find((entry) => entry.kind === 'invoke')?.payload?.actionId).toBe(
      'model-route:shared:provider/openai',
    );
  });

  it('offers no picker for a model only one provider can serve', () => {
    const snapshot = snapshotFixture({ hubPublishedModels: twoModels });
    renderPane(snapshot);
    expect(screen.queryByTestId('published-models.row-picker-claude-opus')).toBeNull();
  });
});

describe('the empty state', () => {
  it('says nothing is published rather than showing an empty list', () => {
    const snapshot = snapshotFixture({ hubPublishedModels: [], hubConflicts: [] });
    renderPane(snapshot);
    expect(screen.getByTestId('published-models-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('published-models-filters')).toBeNull();
  });

  it('distinguishes no results from no models', async () => {
    // The picker only offers vendors that have models, so reaching the empty
    // result means searching for something absent rather than picking a filter.
    const snapshot = snapshotFixture({ hubPublishedModels: twoModels });
    const { user } = renderPane(snapshot);
    await user.type(screen.getByTestId('toolbar-search-probe'), 'nothing matches this');
    expect(screen.getByTestId('published-models-no-results')).toBeInTheDocument();
    expect(screen.queryByTestId('published-models-empty')).toBeNull();
  });

  it('resets the vendor and the search together', async () => {
    // macOS resets both halves. Clearing only the vendor leaves the search that
    // produced the empty result, so the button appears not to work.
    const snapshot = snapshotFixture({ hubPublishedModels: twoModels });
    const user = userEvent.setup();
    render(<Harness snapshot={snapshot} />);
    await user.type(screen.getByTestId('toolbar-search-probe'), 'absent');
    expect(screen.getByTestId('published-models-no-results')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset Filters' }));
    expect(screen.getByTestId('toolbar-search-probe')).toHaveValue('');
    expect(screen.getByTestId('published-models.row-claude-opus')).toBeInTheDocument();
  });
});

describe('models that need an owner', () => {
  const conflicted = {
    id: 'overlap-1',
    kind: 'model-overlap',
    title: 'shared',
    models: ['shared'],
    candidates: [
      { id: 'provider/claude', providerId: 'claude', label: 'Claude', detail: '1 account', actionId: 'a-claude', providerChoice: true },
      { id: 'provider/openai', providerId: 'openai', label: 'OpenAI', detail: '1 account', actionId: 'a-openai', providerChoice: true },
    ],
  };

  it('shows them in their own group, not twice under a vendor', () => {
    const snapshot = snapshotFixture({
      hubPublishedModels: [
        { id: 'shared', ownerLabel: '', ownerProviderId: 'claude', needsChoice: true },
        ...twoModels,
      ],
      hubConflicts: [conflicted],
    });
    renderPane(snapshot);
    expect(screen.getByTestId('published-models.conflict-shared')).toBeInTheDocument();
    expect(screen.queryByTestId('published-models.row-shared')).toBeNull();
  });

  it('invokes the chosen candidate', async () => {
    const bridge = new FakeBridge();
    bridges.push(bridge);
    bridge.lastLine = null;
    const snapshot = snapshotFixture({
      hubPublishedModels: [
        { id: 'shared', ownerLabel: '', ownerProviderId: 'claude', needsChoice: true },
        ...twoModels,
      ],
      hubConflicts: [conflicted],
    });
    render(<PublishedModelsPane service={createService({ bridge }).port} snapshot={snapshot} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('published-models.conflict-shared.picker'), 'a-openai');
    expect(bridge.commands().find((entry) => entry.kind === 'invoke')?.payload?.actionId).toBe('a-openai');
  });
});
