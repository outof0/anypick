import { translate, translateSource } from '../lib/i18n';

export type NoticeSuggestion = { text: string; action?: string };

export type Notice = {
  kind: 'error' | 'warning' | 'info';
  text: string;
  suggestions?: NoticeSuggestion[];
  code?: string;
};

const TONE = {
  error: 'border-red/30 bg-red/7 text-text',
  warning: 'border-orange/30 bg-orange/7 text-text',
  info: 'border-green/30 bg-green/7 text-text',
} as const;

const ACCENT = {
  error: 'text-red',
  warning: 'text-orange',
  info: 'text-green',
} as const;

/**
 * Errors only.
 *
 * The macOS app shows failures in a native `.alert` and keeps success silent,
 * because a success toast duplicates the row's own state and fires before the
 * snapshot confirms anything. This mirrors that: a banner appears for a
 * failure, never for "Started…".
 *
 * The engine's `suggestions` ride along because they are the recovery step it
 * already knows about, and a user should not have to guess it.
 */
export function NoticeBanner({
  notice,
  onDismiss,
  language,
  resolvedLanguage,
}: {
  notice: Notice;
  onDismiss: () => void;
  language: string;
  resolvedLanguage: string;
}) {
  const suggestions = notice.suggestions ?? [];
  const t = (key: string) => translate(`desktop.${key}`, language, resolvedLanguage);
  return (
    <div
      className={`mx-5 mt-4 mb-4 flex items-start gap-2 rounded-group border px-3 py-2 text-[13px] leading-[1.35] ${TONE[notice.kind]}`}
      role={notice.kind === 'error' ? 'alert' : 'status'}
      data-testid="notice"
    >
      <span className="mt-0.5 flex-none">
        <WarningOrInfo kind={notice.kind} />
      </span>
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {translateSource(notice.text, language, resolvedLanguage)}
      </span>
      {suggestions.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-0.5 pl-0 text-[12px] text-secondary">
          {suggestions.map((suggestion) => (
            <li key={suggestion.text}>{translateSource(suggestion.text, language, resolvedLanguage)}</li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        className="-mt-1 -mr-0.5 flex-none cursor-default rounded-full border-0 bg-transparent p-1 text-tertiary hover:text-text"
        onClick={onDismiss}
        aria-label={t('common.dismiss_notification')}
        title={t('common.dismiss_notification')}
      >
        ×
      </button>
    </div>
  );
}

function WarningOrInfo({ kind }: { kind: Notice['kind'] }) {
  if (kind === 'info') {
    return (
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        aria-hidden="true"
        focusable="false"
        className={ACCENT[kind]}
      >
        <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 12l3 3 5-6" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
      focusable="false"
      className={ACCENT[kind]}
    >
      <path d="M12 4 21 20H3L12 4z M12 10v4 M12 17h.01" />
    </svg>
  );
}
