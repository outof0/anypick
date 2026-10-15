import { useEffect, useMemo, useState } from 'react';

import type { Snapshot } from '../lib/contract';
import {
  ACTIVITY_CATEGORIES,
  activityMatchesCategory,
  visibleLogLines,
  type ActivityCategoryId,
} from '../lib/model';
import type { ServicePort } from '../lib/service';
import type { LogsFrame } from '../lib/wire';
import { translate, translateSource } from '../lib/i18n';
import { SegmentedControl } from '../ui/SegmentedControl';
import { ProviderIcon } from '../shell/ProviderIcon';
import { Button, EmptyState, Group, Pane, PaneActions, Row, RowActions, RowText, Select } from '../ui/primitives';

/** How often a live log is re-read while its tab is showing. */
const POLL_MS = 1750;

/**
 * Recent events, or the tail of one proxy log.
 *
 * Clear hides what is on screen. It does not ask the engine to delete history,
 * which is the same rule the macOS activity pane follows.
 *
 * macOS puts a segmented Events/Live Logs control at the top of the pane and
 * never shows both at once. Two panes of unrelated content in one scroll is
 * the dashboard look the macOS contract bans, so this ports the segmented
 * control rather than the two stacked sections.
 */
export function ActivityPane({
  snapshot,
  service,
  logs = {},
  query = '',
  busy = new Set<string>(),
}: {
  snapshot: Snapshot;
  service?: ServicePort;
  logs?: Readonly<Record<string, LogsFrame>>;
  query?: string;
  busy?: ReadonlySet<string>;
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  // Log tails are hidden per source, the same way events are hidden per id.
  // Clearing is local: the engine keeps the log file.
  const [hiddenLogs, setHiddenLogs] = useState<ReadonlySet<string>>(() => new Set());
  const [mode, setMode] = useState<'events' | 'logs'>('events');
  const [category, setCategory] = useState<ActivityCategoryId>('all');
  const [sourceId, setSourceId] = useState(snapshot.logSources[0]?.id ?? '');
  const needle = query.trim().toLocaleLowerCase();
  const t = (key: string) =>
    translate(`desktop.activity.${key}`, snapshot.settings.language, snapshot.settings.resolvedLanguage);
  const tr = (source: string) =>
    translateSource(source, snapshot.settings.language, snapshot.settings.resolvedLanguage);

  const source = snapshot.logSources.find((row) => row.id === sourceId) ?? snapshot.logSources[0];
  const log = source ? logs[source.id] : undefined;
  // Hidden per source id, which is what the pane selects on. Keying it by the
  // engine's `proxyId` would hide the log only if the two names happened to
  // agree, and they do not: the fixture already ships `claude/work` for the
  // source and the engine may namespace it differently.
  const cleared = Boolean(source && hiddenLogs.has(source.id));

  const rows = snapshot.activity.filter((row) => {
    if (hidden.has(row.id)) return false;
    if (!activityMatchesCategory(category, row)) return false;
    const haystack = `${row.message} ${row.kind} ${row.provider ?? ''}`.toLocaleLowerCase();
    return !needle || haystack.includes(needle);
  });

  // Live means live. The engine answers a `logs` request with the current
  // tail, so a log view that never re-reads is a snapshot labelled "live".
  // Polling stops when the tab is hidden so a background tab costs nothing.
  const canPoll = mode === 'logs' && Boolean(service && source);
  useEffect(() => {
    if (!canPoll || !service || !source) return;
    service.fetchLogs(source.providerId, source.name);
    const timer = setInterval(
      () => service.fetchLogs(source.providerId, source.name),
      POLL_MS,
    );
    return () => clearInterval(timer);
  }, [canPoll, service, source?.id]);

  const lines = useMemo(() => {
    if (!log || (source && hiddenLogs.has(source.id))) {
      return { visible: [] as string[], hidden: 0 };
    }
    return visibleLogLines(log.text.split('\n'), 0);
  }, [log?.text, source?.id, hiddenLogs]);

  const filtered = useMemo(
    () => (needle ? lines.visible.filter((line) => line.toLocaleLowerCase().includes(needle)) : lines.visible),
    [lines.visible, needle],
  );

  return (
    <Pane title={translate('desktop.nav.activity', snapshot.settings.language, snapshot.settings.resolvedLanguage)} testId="activity">
      <Group testId="activity-mode">
        <Row>
          <RowText title={t('view')} />
          <RowActions>
            <SegmentedControl
              value={mode}
              onChange={(value) => setMode(value === 'logs' ? 'logs' : 'events')}
              options={[
                { value: 'events', label: t('events') },
                { value: 'logs', label: t('live_logs') },
              ]}
              testId="activity-mode.picker"
            />
          </RowActions>
        </Row>
        {mode === 'events' && snapshot.activity.length > 0 ? (
          <Row>
            <RowText title={t('filter_events')} />
            <RowActions>
              <Select
                label=""
                value={category}
                testId="activity.logs.filter"
                onChange={(value) => setCategory(value as ActivityCategoryId)}
                options={ACTIVITY_CATEGORIES.map((row) => ({
                  value: row.id,
                  label: translate(`desktop.activity.category_${row.id}`, snapshot.settings.language, snapshot.settings.resolvedLanguage),
                }))}
              />
            </RowActions>
          </Row>
        ) : null}
        {mode === 'logs' && snapshot.logSources.length > 0 ? (
          <Row>
            <RowText title={t('log_source')} />
            <RowActions>
              <Select
                label=""
                value={source?.id ?? ''}
                testId="activity.log-source"
                onChange={setSourceId}
                options={snapshot.logSources.map((row) => ({ value: row.id, label: row.label }))}
              />
            </RowActions>
          </Row>
        ) : null}
      </Group>

      {mode === 'events' ? (
        rows.length === 0 ? (
          <EmptyState
            title={needle || category !== 'all' ? t('no_results') : t('no_activity')}
            detail={
              needle || category !== 'all'
                ? t('no_results_detail')
                : hidden.size > 0
                  ? t('cleared_events')
                  : t('no_events')
            }
            testId="activity-empty"
          />
        ) : (
          <Group title={t('recent_activity')} testId="activity-list">
            {rows.map((row) => {
              const provider = row.provider || row.message.match(/uses ([a-z0-9_-]+)\//i)?.[1];
              return (
                <Row key={row.id} warning={row.isError} testId={`activity.event-${row.id}`}>
                  {provider ? (
                    <ProviderIcon provider={provider} size={18} className="mr-1.5 flex-none" />
                  ) : null}
                  <RowText
                    title={tr(row.message)}
                    detail={formatActivityTimestamp(
                      row.createdAt,
                      snapshot.settings.language === 'auto'
                        ? snapshot.settings.resolvedLanguage
                        : snapshot.settings.language,
                    )}
                  />
                </Row>
              );
            })}
          </Group>
        )
      ) : (
        <Group
          title={t('live_logs')}
          footer={t('sensitive_redacted')}
          testId="activity-logs"
        >
          <Row>
            <RowText
              title={logReadyLabel(log, t)}
              // The macOS pane renders "Status: Live" while the source is
              // answering, which is the only thing the label has to say. The
              // proxy id is the source the engine echoed, not the request.
              detail={log?.state === 'ready' ? t('status_live') : log?.proxyId}
              issue={log?.state === 'error' ? t('could_not_read') : undefined}
              language={snapshot.settings.language}
              resolvedLanguage={snapshot.settings.resolvedLanguage}
            />
            {/* The liveness is its own labelled value, as on macOS: a title that
                happens to read "Live" is not the same fact as a status the user
                can find on its own. */}
            {log?.state === 'ready' ? (
              <span className="text-[12px] whitespace-nowrap text-secondary" data-testid="activity.logs.live">
                {t('live')}
              </span>
            ) : null}
            <RowActions>
              <Button
                kind="quiet"
                testId="activity-show-logs"
                disabled={busy.size > 0 || !source}
                onClick={() => {
                  if (!source) return;
                  service?.fetchLogs(source.providerId, source.name);
                }}
              >
                {translate('desktop.common.refresh', snapshot.settings.language, snapshot.settings.resolvedLanguage)}
              </Button>
            </RowActions>
          </Row>
          {/* The clear applies to what is on screen. It does not ask the engine
              to delete history, and it is only offered once there is something
              to clear: an always-present Clear on an empty log reads as a
              command that failed. */}
          {log && (log.state === 'ready' || log.state === 'empty') && !cleared ? (
            <Row>
              <RowActions>
                <Button
                  kind="destructive"
                  testId="activity-clear-log"
                  onClick={() => {
                    if (source) setHiddenLogs(new Set([source.id]));
                  }}
                >
                  {t('clear_log')}
                </Button>
              </RowActions>
            </Row>
          ) : null}
          {cleared ? (
            <Row testId="activity.logs">
              <RowText
                title={t('cleared_log')}
                detail={t('cleared_log_detail')}
              />
            </Row>
          ) : log?.state === 'ready' || log?.state === 'empty' ? (
            <Row testId="activity.logs">
              {filtered.length === 0 ? (
                <RowText
                  title={needle ? t('no_matching_lines') : t('no_entries')}
                  detail={needle ? t('clear_search_detail') : undefined}
                />
              ) : (
                <pre className="m-0 max-h-60 overflow-auto font-mono text-[11px] leading-[1.45] break-words whitespace-pre-wrap text-text">
                  {filtered.join('\n')}
                </pre>
              )}
            </Row>
          ) : null}
          {lines.hidden > 0 ? (
            <Row>
              <RowText
                detail={t('earlier_lines').replace('{count}', String(lines.hidden))}
                title={t('log_truncated')}
              />
            </Row>
          ) : null}
        </Group>
      )}

      {/* PaneActions, not an inline row: the contract pins these trailing and
          content-sized, and hand-rolling the container is how two panes ended
          up left-aligned while the third was right-aligned. */}
      {rows.length > 0 && mode === 'events' ? (
        <PaneActions>
          <Button
            kind="destructive"
            testId="activity-clear-events"
            onClick={() => setHidden(new Set(snapshot.activity.map((row) => row.id)))}
          >
            {t('clear_events')}
          </Button>
        </PaneActions>
      ) : null}
    </Pane>
  );
}

function logReadyLabel(log: LogsFrame | undefined, t: (key: string) => string): string {
  if (!log) return t('waiting');
  if (log.state === 'ready') return t('live');
  if (log.state === 'empty') return t('no_entries');
  if (log.state === 'not-running') return t('not_running');
  return t('unavailable');
}

function formatActivityTimestamp(iso: string, locale: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

