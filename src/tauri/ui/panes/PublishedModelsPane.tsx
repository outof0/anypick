import { useMemo, useState } from 'react';

import type { HubCatalog, HubConflict, HubPublishedModel, HubSource, ProxyRow, Snapshot } from '../lib/contract';
import { hubProxy } from '../lib/hub';
import {
  allRouteCandidates,
  hubProviderDisplayName,
  needsChoiceModels,
  parseModelIdentity,
  routableModels,
  seedExpanded,
  switchableModels,
  vendorGroups,
  type RouteCandidate,
} from '../lib/published';
import type { ServicePort } from '../lib/service';
import { translate } from '../lib/i18n';
import { Dialog } from '../ui/Dialog';
import {
  Button,
  CopyButton,
  EmptyState,
  Group,
  IconButton,
  Pane,
  Row,
  RowActions,
  RowText,
  Select,
} from '../ui/primitives';

/**
 * Every model the hub publishes, and who can serve each one.
 *
 * macOS reaches this from the hub's Published Models row and from a proxy
 * detail. It is a destination rather than a dialog because the list is long
 * enough to search and filter, and the per-row endpoint detail belongs in an
 * inspector sheet rather than on every row.
 */
export function PublishedModelsPane({
  service,
  snapshot,
  query = '',
  busy = new Set<string>(),
  onNavigate,
  onClearQuery,
}: {
  service: ServicePort;
  snapshot: Snapshot;
  query?: string;
  busy?: ReadonlySet<string>;
  onNavigate?: (destination: 'proxies') => void;
  /** Clears the shell's search field. Reset Filters resets both, as on macOS. */
  onClearQuery?: () => void;
}) {
  const t = (key: string) =>
    translate(`desktop.published.${key}`, snapshot.settings.language, snapshot.settings.resolvedLanguage);
  const language = snapshot.settings.language;
  const resolvedLanguage = snapshot.settings.resolvedLanguage;
  const [vendor, setVendor] = useState('all');
  const [inspecting, setInspecting] = useState<HubPublishedModel | null>(null);

  const needle = query.trim().toLocaleLowerCase();
  const revision = snapshot.revision;
  const hub = hubProxy(snapshot.proxies);
  const candidates = useMemo(
    () => allRouteCandidates(snapshot.hubCatalogs, snapshot.hubSources),
    [snapshot.hubCatalogs, snapshot.hubSources],
  );

  const routable = routableModels(snapshot.hubPublishedModels, snapshot.hubConflicts);
  const matches = (model: HubPublishedModel) => {
    if (!needle) return true;
    const identity = parseModelIdentity(model.id, model.ownerProviderId);
    return (
      model.id.toLocaleLowerCase().includes(needle) ||
      identity.cleanName.toLocaleLowerCase().includes(needle) ||
      identity.vendorName.toLocaleLowerCase().includes(needle) ||
      model.ownerLabel.toLocaleLowerCase().includes(needle)
    );
  };

  const searched = routable.filter(matches);
  const visible = searched.filter((model) => {
    if (vendor === 'all') return true;
    if (vendor === 'switchable') return (candidates.get(model.id)?.length ?? 0) > 1;
    return parseModelIdentity(model.id, model.ownerProviderId).vendorKey === vendor;
  });

  const groups = vendorGroups(visible);
  const unresolved = needsChoiceModels(snapshot.hubPublishedModels, snapshot.hubConflicts).filter(matches);
  const switchable = switchableModels(searched, snapshot.hubCatalogs, snapshot.hubSources);
  const vendors = vendorGroups(routable);

  // A search or a vendor filter opens every group: filtering to one vendor and
  // then showing that vendor collapsed reads as an empty result. Otherwise the
  // group is open when the list is short enough to read, which is macOS's own
  // rule (`initializeExpansionIfNeeded`, ProxyFlows.swift). Two models behind a
  // collapsed "2 models" row says nothing about what the list holds; a hundred
  // rows already open is a wall.
  const filtering = needle !== '' || vendor !== 'all';
  const openByDefault = filtering || seedExpanded(searched.length);
  // Explicit user intent, keyed by vendor. A record here overrides the default,
  // in both directions: without one, `openByDefault` decides. Tracking only
  // "collapsed" cannot express "open this long list", which is the case the
  // seed rule actually produces.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const isExpanded = (key: string) => overrides.get(key) ?? openByDefault;
  const toggle = (key: string) =>
    setOverrides((current) => new Map(current).set(key, !isExpanded(key)));

  const nothingToShow =
    snapshot.hubPublishedModels.length === 0 && unresolved.length === 0 && snapshot.hubConflicts.length === 0;

  if (nothingToShow) {
    return (
      <Pane title={t('title')} testId="published-models">
        <EmptyState
          title={t('no_models')}
          detail={t('empty_detail')}
          actionTitle={t('open_hub')}
          onAction={() => onNavigate?.('proxies')}
          testId="published-models-empty"
        />
      </Pane>
    );
  }

  return (
    <Pane title={t('title')} testId="published-models">
      <Group title={t('filter')} testId="published-models-filters">
        <Row>
          <RowText title={t('catalog')} />
          <RowActions>
            <Select
              label=""
              testId="published-models.vendor-picker"
              value={vendor}
              onChange={setVendor}
              options={[
                { value: 'all', label: t('all_catalogs').replace('{count}', String(routable.length)) },
                ...(switchable.length > 0
                  ? [{ value: 'switchable', label: t('multi_routes_count').replace('{count}', String(switchable.length)) }]
                  : []),
                ...vendors.map((group) => ({
                  value: group.vendorKey,
                  label: `${group.vendorName} (${group.models.length})`,
                })),
              ]}
            />
          </RowActions>
        </Row>
      </Group>

      {unresolved.length > 0 ? (
        <Group
          title={t('needs_provider')}
          footer={t('conflict_footer')}
          testId="published-models.conflicts"
        >
          {unresolved.map((model) => (
            <ConflictRow
              key={model.id}
              model={model}
              t={t}
              conflicts={snapshot.hubConflicts}
              revision={revision}
              service={service}
              busy={busy}
            />
          ))}
        </Group>
      ) : null}

      {groups.length === 0 ? (
        <EmptyState
          title={t('no_results')}
          detail={t('no_results_detail')}
          actionTitle={t('reset_filters')}
          // macOS resets both halves (`ProxyFlows.swift:305`). Resetting only
          // the vendor leaves the search that produced the empty result.
          onAction={() => {
            setVendor('all');
            onClearQuery?.();
          }}
          testId="published-models-no-results"
        />
      ) : (
        groups.map((group) => {
          const open = isExpanded(group.vendorKey);
          return (
            <Group
              key={group.vendorKey}
              title={group.vendorName}
              footer={group.footer.startsWith('Serving source: ')
                ? t('serving_source').replace('{source}', group.footer.slice('Serving source: '.length))
                : group.footer.startsWith('Published via ')
                  ? t('published_via').replace('{provider}', group.footer.slice('Published via '.length))
                  : group.footer}
              testId={`published-models.group-${group.vendorKey}`}
            >
              {!open ? (
                <Row>
                  <RowText title={translate(
                    `desktop.hub.${group.models.length === 1 ? 'model_count' : 'models_count'}`,
                    snapshot.settings.language,
                    snapshot.settings.resolvedLanguage,
                  ).replace('{count}', String(group.models.length))} />
                  <RowActions>
                    <Button kind="quiet" onClick={() => toggle(group.vendorKey)}>
                      {t('show')}
                    </Button>
                  </RowActions>
                </Row>
              ) : (
                group.models.map((model) => (
                  <ModelRow
                    key={model.id}
                    model={model}
                    t={t}
                    language={language}
                    resolvedLanguage={resolvedLanguage}
                    candidates={routeCandidatesFor(model.id, candidates)}
                    revision={revision}
                    service={service}
                    busy={busy}
                    onInspect={() => setInspecting(model)}
                  />
                ))
              )}
            </Group>
          );
        })
      )}

      {inspecting ? (
        <InspectDialog
          model={inspecting}
          t={t}
          language={language}
          resolvedLanguage={resolvedLanguage}
          hub={hub}
          candidates={routeCandidatesFor(inspecting.id, candidates)}
          revision={revision}
          service={service}
          busy={busy}
          onClose={() => setInspecting(null)}
        />
      ) : null}
    </Pane>
  );
}

function routeCandidatesFor(
  modelId: string,
  candidates: Map<string, RouteCandidate[]>,
): RouteCandidate[] {
  return candidates.get(modelId) ?? [];
}

function ModelRow({
  model,
  t,
  language,
  resolvedLanguage,
  candidates,
  revision,
  service,
  busy,
  onInspect,
}: {
  model: HubPublishedModel;
  t: (key: string) => string;
  language: string;
  resolvedLanguage: string;
  candidates: RouteCandidate[];
  revision: number;
  service: ServicePort;
  busy: ReadonlySet<string>;
  onInspect: () => void;
}) {
  const identity = parseModelIdentity(model.id, model.ownerProviderId);
  const multiProvider = candidates.length > 1;

  return (
    <Row testId={`published-models.row-${model.id}`}>
      <RowText
        title={
          <span className="inline-flex items-baseline gap-1.5">
            <span>{identity.cleanName}</span>
            {identity.tag ? <span className="text-[11px] text-tertiary">{identity.tag}</span> : null}
            {multiProvider ? (
              <span className="text-[11px] text-secondary">{t('multi_provider')}</span>
            ) : null}
          </span>
        }
        detail={`${model.id} · ${model.ownerLabel || t('no_owner')}`}
      />
      <RowActions>
        {multiProvider ? (
          <Select
            label=""
            testId={`published-models.row-picker-${model.id}`}
            value=""
            disabled={busy.size > 0}
            onChange={(actionId) => {
              // A select that emits its placeholder would invoke an empty id.
              if (actionId) service.invokeAction(actionId, revision);
            }}
            options={[
            { value: '', label: t('route_to') + '…' },
              ...candidates.map((candidate) => ({ value: candidate.actionId, label: candidate.label })),
            ]}
          />
        ) : null}
        <CopyButton
          label={`${t('copy_model_id')} ${identity.cleanName}`}
          testId={`published-models.copy-${model.id}`}
          value={model.id}
          copy={service.copy}
          language={language}
          resolvedLanguage={resolvedLanguage}
        />
        <IconButton
          label={`${t('inspect_model')} ${identity.cleanName}`}
          language={language}
          resolvedLanguage={resolvedLanguage}
          testId={`published-models.inspect-${model.id}`}
          onClick={onInspect}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M12 11v5 M12 8h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </IconButton>
      </RowActions>
    </Row>
  );
}

function ConflictRow({
  model,
  t,
  conflicts,
  revision,
  service,
  busy,
}: {
  model: HubPublishedModel;
  t: (key: string) => string;
  conflicts: readonly HubConflict[];
  revision: number;
  service: ServicePort;
  busy: ReadonlySet<string>;
}) {
  const conflict = conflicts.find((row) => (row.models ?? []).includes(model.id));
  const identity = parseModelIdentity(model.id, model.ownerProviderId);
  return (
    <Row testId={`published-models.conflict-${model.id}`}>
      <RowText title={identity.cleanName} detail={`${model.id} · ${t('needs_provider').toLocaleLowerCase()}`} />
      <RowActions>
        <Select
          label=""
          testId={`published-models.conflict-${model.id}.picker`}
          value=""
          disabled={busy.size > 0 || !conflict}
          onChange={(actionId) => {
            if (actionId) service.invokeAction(actionId, revision);
          }}
          options={[
            { value: '', label: t('select_provider') },
            ...(conflict?.candidates ?? []).map((candidate) => ({
              value: candidate.actionId,
              label: candidate.label || hubProviderDisplayName(candidate.providerId),
            })),
          ]}
        />
      </RowActions>
    </Row>
  );
}

function InspectDialog({
  model,
  t,
  language,
  resolvedLanguage,
  hub,
  candidates,
  revision,
  service,
  busy,
  onClose,
}: {
  model: HubPublishedModel;
  t: (key: string) => string;
  language: string;
  resolvedLanguage: string;
  hub: ProxyRow | undefined;
  candidates: RouteCandidate[];
  revision: number;
  service: ServicePort;
  busy: ReadonlySet<string>;
  onClose: () => void;
}) {
  const identity = parseModelIdentity(model.id, model.ownerProviderId);
  const base = hub?.address ?? '';
  const chat = base ? `${base}/v1/chat/completions` : '';

  return (
    <Dialog
      title={identity.cleanName}
      onCancel={onClose}
      testId="published-models.inspect-dialog"
      width="form"
      actions={
        <Button kind="primary" onClick={onClose}>
          {t('done')}
        </Button>
      }
    >
      <Row testId="published-models.inspect-identity">
        <RowText
          title={identity.cleanName}
          detail={`${model.id} · ${identity.vendorName}`}
        />
        <RowActions>
          <span className="text-[12px] whitespace-nowrap text-secondary">{t('active')}</span>
        </RowActions>
      </Row>

      <Row testId="published-models.inspect-route">
        <RowText title={t('route_to')} />
        <RowActions>
          {candidates.length > 1 ? (
            <Select
              label=""
              value=""
              disabled={busy.size > 0}
              onChange={(actionId) => {
                if (actionId) service.invokeAction(actionId, revision);
              }}
              options={[
              { value: '', label: t('select_provider') },
                ...candidates.map((candidate) => ({ value: candidate.actionId, label: candidate.label })),
              ]}
            />
          ) : (
            <span className="text-[12px] whitespace-nowrap text-secondary">
              {model.ownerLabel || hubProviderDisplayName(model.ownerProviderId)}
            </span>
          )}
        </RowActions>
      </Row>

      <Row testId="published-models.base-url">
        <RowText title={t('base_url')} detail={base ? `${base}/v1` : t('hub_not_running')} />
        <RowActions>
          {base ? (
            <CopyButton
              label={`${t('copy')} ${t('base_url')}`}
              testId={`model-inspect.copy-${'base-url'}`}
              value={`${base}/v1`}
              copy={service.copy}
              language={language}
              resolvedLanguage={resolvedLanguage}
            />
          ) : null}
        </RowActions>
      </Row>

      <Row testId="published-models.chat-url">
        <RowText title={t('chat_url')} detail={chat || t('hub_not_running')} />
        <RowActions>
          {chat ? (
            <CopyButton
              label={`${t('copy')} ${t('chat_url')}`}
              testId={`model-inspect.copy-${'chat-url'}`}
              value={chat}
              copy={service.copy}
              language={language}
              resolvedLanguage={resolvedLanguage}
            />
          ) : null}
        </RowActions>
      </Row>

      <Row testId="model-inspect.copy-curl">
        <RowText title={t('test_terminal')} detail={t('openai_compatible')} />
        <RowActions>
          <CopyButton
            label={t('copy_curl')}
            testId="published-models.copy-curl"
            value={curlTemplate(chat, model.id)}
            copy={service.copy}
            language={language}
            resolvedLanguage={resolvedLanguage}
          />
        </RowActions>
      </Row>
    </Dialog>
  );
}

/**
 * The cURL is built with a placeholder for the key, never a real one. The hub
 * requires authentication (ADR 0006), and a template carrying a bearer would
 * put a live secret on the clipboard and then in the user's shell history.
 */
function curlTemplate(chatUrl: string, modelId: string): string {
  return [
    `curl ${chatUrl} \\`,
    '  -H "Authorization: Bearer $ANYPICK_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"model":"${modelId}","messages":[{"role":"user","content":"hi"}]}'`,
  ].join('\n');
}
