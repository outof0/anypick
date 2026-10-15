import type { Snapshot } from '../lib/contract';
import { translate } from '../lib/i18n';
import { IconButton } from '../ui/primitives';
import { Symbol } from './Symbol';

/**
 * The pane toolbar: the pane's title, a search field where the list is long
 * enough to need one, and a refresh.
 *
 * The macOS README keeps collection actions out of the titlebar and says why:
 * on macOS 26 a toolbar item lifts SwiftUI buttons into the chrome, so the
 * search field is an AppKit bridge. A webview has no such behaviour, which is
 * the one place this port is simpler than the source rather than different.
 */
export function Toolbar({
  title,
  searchable,
  query,
  onQuery,
  onRefresh,
  snapshot,
  busy,
  onBack,
}: {
  title: string;
  searchable: boolean;
  query: string;
  onQuery: (value: string) => void;
  onRefresh: () => void;
  snapshot: Snapshot | null;
  /**
   * Any command in flight. The refresh greys rather than spins: the engine
   * single-flights, so a second refresh lands on the same slot, and macOS
   * makes the same call on `OverviewView`'s Refresh.
   */
  busy: ReadonlySet<string>;
  onBack?: () => void;
}) {
  const language = snapshot?.settings?.language ?? 'auto';
  const resolvedLanguage = snapshot?.settings?.resolvedLanguage ?? 'en';
  const t = (key: string) => translate(`desktop.${key}`, language, resolvedLanguage);
  return (
    <header className="flex min-h-11 items-center justify-between gap-4 bg-transparent px-5 pt-2.5 pb-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {onBack ? (
          <IconButton
            label={t('common.back')}
            language={language}
            resolvedLanguage={resolvedLanguage}
            testId="toolbar-back"
            onClick={onBack}
          >
            <Symbol name="chevron.left" size={14} />
          </IconButton>
        ) : null}
        <h1 className="min-w-0 flex-1 overflow-hidden text-[15px] font-semibold tracking-[-0.01em] text-ellipsis whitespace-nowrap">
          {title}
        </h1>
      </div>
      <div className="flex flex-none items-center gap-2">
        {searchable ? (
          <label className="relative flex h-[22px] w-45 items-center gap-1.5 rounded-control border border-transparent bg-text/6 px-[7px] text-tertiary focus-within:border-accent focus-within:bg-group">
            {/* The label is spoken, not drawn. Without it the placeholder is
                the only name and a screen reader reads a bare "edit". */}
            <span className="sr-only">{`${t('common.search')} ${title}`}</span>
            <span className="flex-none text-tertiary" aria-hidden="true">
              <Symbol name="magnifyingglass" size={11} />
            </span>
            <input
              className="w-full min-w-0 border-0 bg-transparent p-0 text-[12px] text-text outline-none placeholder:text-tertiary"
              type="search"
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              placeholder={t('common.search')}
              data-testid="toolbar-search"
            />
            {query ? (
              <button
                type="button"
                className="flex-none cursor-default text-tertiary hover:text-text"
                onClick={() => onQuery('')}
                aria-label={t('common.clear_search')}
                title={t('common.clear_search')}
              >
                <Symbol name="xmark.circle" size={11} />
              </button>
            ) : null}
          </label>
        ) : null}
        <IconButton
          label={t('common.refresh')}
          language={language}
          resolvedLanguage={resolvedLanguage}
          testId="toolbar-refresh"
          onClick={onRefresh}
          disabled={!snapshot || busy.size > 0}
        >
          <Symbol name="arrow.clockwise" size={15} />
        </IconButton>
      </div>
    </header>
  );
}
