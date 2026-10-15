import { isValidElement, useCallback, useEffect, useRef, useState, type AriaAttributes, type ReactNode, type Ref } from 'react';

import { detectLanguage, translate } from '../lib/i18n';
import { STATUS_LABEL, type DesignStatus } from '../lib/model';
import { Symbol } from '../shell/Symbol';

/**
 * The System Settings building blocks, ported from `macos/SharedUI.swift`.
 *
 * These are the only chrome a pane is allowed to use. The metrics live in
 * `styles.css` as theme tokens rather than here, so a value is changed in one
 * place and the same number reaches every row.
 *
 * A pane composes these; it does not style a row itself. That rule is what
 * keeps a Linux pane looking like a Settings pane instead of a web page.
 */

/**
 * A command that puts text on the clipboard, and the one place a copy
 * confirms itself.
 *
 * Eight of these reported nothing at all, and one swapped its own glyph by
 * hand, so "did it land" had no owner. Making that a component rather than a
 * prop means a pane cannot grow a fourth spelling, and `IconButton` already
 * guarantees the help tag, the `aria-busy` and the fixed box.
 *
 * A refused clipboard write shows nothing and reports nothing, because every
 * address here is also selectable text and nothing was interrupted. An API key
 * is not selectable, which is why the key copies go through the engine and
 * answer with a notice instead of coming through here.
 */
export function CopyButton({
  value,
  label,
  copy,
  language = 'auto',
  resolvedLanguage = 'en',
  disabled = false,
  testId,
}: {
  value: string;
  /** The help tag, and what the confirmation announces. */
  label: string;
  copy: (text: string) => Promise<boolean>;
  language?: string;
  resolvedLanguage?: string;
  disabled?: boolean;
  testId?: string;
}) {
  const { phase, begin, report } = useCopyConfirmation();
  const copyValue = async () => {
    if (!begin()) return;
    try {
      report(await copy(value));
    } catch {
      // A host clipboard can reject instead of returning false. Keep the
      // control honest and let the user retry from its idle state.
      report(false);
    }
  };
  return (
    <IconButton
      label={label}
      language={language}
      resolvedLanguage={resolvedLanguage}
      phase={phase}
      confirmed={<Symbol name="checkmark" size={13} />}
      disabled={disabled || value === ''}
      testId={testId}
      onClick={() => void copyValue()}
    >
      <Symbol name="doc.on.doc" size={13} />
    </IconButton>
  );
}

export function Pane({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      className="mx-auto flex w-full max-w-[760px] flex-col gap-row-gutter px-5 pt-[18px] pb-6"
      data-testid={testId}
      aria-label={title}
    >
      {children}
    </section>
  );
}

export function Group({
  title,
  footer,
  children,
  testId,
}: {
  title?: string;
  footer?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section data-testid={testId}>
      {/*
        The header is the pane's only hierarchy: 11px secondary, with real air
        above it. At 12px it read as another line of row text, and the eye could
        not tell a section from its contents — which is what made a screen of
        groups look like one long undifferentiated list.
      */}
      {title ? (
        <h2 className="mb-2 ml-[3px] mt-1 text-[11px] leading-tight font-semibold tracking-[0.01em] text-secondary">
          {title}
        </h2>
      ) : null}
      {/*
        Hairlines between rows. SwiftUI's `.formStyle(.grouped)` draws them, and
        without them a section is one undifferentiated block: nothing tells the
        eye where one row ends and the next begins. `divide-y` puts the rule on
        every child but the last, which is exactly the macOS rule, and it works
        on DOM children — so a component returning several rows still divides.
      */}
      <div className="flex flex-col divide-y divide-separator-soft/70 overflow-hidden rounded-group border border-separator-soft bg-group">
        {children}
      </div>
      {footer ? (
        <p className="mt-1.5 ml-0.5 text-[11px] leading-[1.35] text-secondary">{footer}</p>
      ) : null}
    </section>
  );
}

export function Row({
  children,
  warning = false,
  onClick,
  testId,
}: {
  children: ReactNode;
  warning?: boolean;
  onClick?: () => void;
  testId?: string;
}) {
  // A warning row tints the surface rather than recoloring the text: macOS keeps
  // the title legible and lets the background carry the state.
  const className = `flex w-full min-h-[34px] items-center gap-row-gutter bg-group px-row-inline py-row-block text-left text-inherit ${
    warning ? 'bg-orange/4' : ''
  }`;

  if (!onClick) {
    return (
      <div className={className} data-testid={testId}>
        {children}
      </div>
    );
  }
  return (
    <div
      role="button"
      tabIndex={0}
      className={`${className} cursor-default`}
      onClick={(e) => {
        const target = e.target as HTMLElement | null;
        if (target?.closest('button, input, select, textarea, a, [role="menuitem"]')) {
          return;
        }
        onClick();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          const target = e.target as HTMLElement | null;
          if (target?.closest('button, input, select, textarea, a, [role="menuitem"]')) {
            return;
          }
          e.preventDefault();
          onClick();
        }
      }}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/**
 * The one warning row a pane needs, ported from macOS's `Label` +
 * `DesignWarningSymbol` pair (`BackupsView.swift:37-49`).
 *
 * A standing warning that every section repeats in its own footer stops being a
 * warning and becomes a disclaimer printed three times. macOS says it once, with
 * a symbol beside it, and the section footers go back to saying what is actually
 * different about that section.
 */
export function WarningRow({
  title,
  detail,
  testId,
}: {
  title: ReactNode;
  detail: ReactNode;
  testId?: string;
}) {
  return (
    <Row testId={testId}>
      {/* `symbolRenderingMode(.multicolor)` — the filled triangle is two-tone,
          which is why macOS sizes it `.medium` rather than matching the 7pt
          status dot the other rows use. */}
      <span className="flex-none text-orange" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="17" height="17">
          <path
            d="M12 3.2 22.4 20.4H1.6z"
            fill="currentColor"
            fillOpacity="0.28"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path d="M12 9.4v4.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          <path d="M12 16.6h.01" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </span>
      <RowText title={title} detail={detail} />
    </Row>
  );
}

export function RowText({
  title,
  detail,
  issue,
  language = 'auto',
  resolvedLanguage = 'en',
  testId,
}: {
  title?: ReactNode;
  detail?: ReactNode;
  issue?: ReactNode;
  language?: string;
  resolvedLanguage?: string;
  testId?: string;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-row-stack" data-testid={testId}>
      {title ? <div className="text-[13px] leading-[1.25] text-text">{title}</div> : null}
      {detail ? (
        <div className="select-text overflow-hidden text-[12px] leading-[1.3] text-ellipsis whitespace-nowrap text-secondary">
          {detail}
        </div>
      ) : null}
      {issue ? (
        <div className="flex items-baseline gap-1 text-[12px] leading-[1.3] text-secondary">
          <WarningGlyph language={language} resolvedLanguage={resolvedLanguage} />
          <span>{issue}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The trailing column. macOS reserves the width of a hidden control
 * (`ReservedColumn`) so a row does not reflow when a button appears on hover,
 * which is why the `auto` margin is on the container and not on a control.
 */
export function RowActions({ children }: { children: ReactNode }) {
  return <div className="ml-auto flex flex-none items-center gap-2">{children}</div>;
}

/**
 * A pane's own commands, in a plain row under the last group.
 *
 * macOS keeps these out of the toolbar and off the window bottom; a second
 * inset container around them is exactly the dashboard look the contract bans.
 * They are **trailing** — `SharedUI.swift:424` pins the action row with
 * `.frame(maxWidth: .infinity, alignment: .trailing)` — and content-sized, so
 * they follow the last group rather than sitting against the window edge.
 */
export function PaneActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap justify-end gap-2.5 px-0.5 py-2">{children}</div>;
}

/*
 * The button bezel is one control with four roles, not four controls.
 *
 * macOS sets `hasDestructiveAction` on a rounded `NSButton`
 * (`macos/SharedUI.swift:541`), which draws red *text* on the normal bezel.
 * A filled red button is a different control: a row of them reads as a web app
 * shouting, and the screenshot of the Accounts pane is what showed it. Only a
 * confirmation's default action earns a fill, and that is `primary` plus the
 * dialog's own placement.
 */
const BUTTON_KIND = {
  primary:
    'border-transparent bg-accent text-white shadow-[0_0.5px_1px_rgba(0,0,0,0.15)] hover:brightness-105 active:brightness-95 disabled:border-control-border/50 disabled:bg-control/50 disabled:text-secondary/40 disabled:shadow-none',
  secondary:
    'border-control-border bg-control text-text shadow-[0_0.5px_1px_rgba(0,0,0,0.06)] hover:brightness-105 active:brightness-95 dark:hover:bg-[#48484a] dark:active:bg-[#323234] disabled:opacity-40 disabled:bg-control disabled:text-secondary',
  quiet: 'border-transparent bg-transparent text-text shadow-none hover:bg-hover active:bg-black/5 dark:active:bg-white/10',
  destructive: 'border-control-border bg-control text-red hover:brightness-105 active:brightness-95 dark:hover:bg-[#48484a] dark:active:bg-[#323234]',
} as const;

export function Button({
  children,
  onClick,
  kind = 'secondary',
  quiet = false,
  disabled = false,
  icon,
  title,
  ariaLabel,
  testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'primary' | 'secondary' | 'quiet' | 'destructive';
  /** A borderless trailing command. Distinct from `kind`: macOS reserves the
   *  rounded bezel for a real action and uses plain text for a dismissal. */
  quiet?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  title?: string;
  /**
   * Overrides the accessible name when the visible label is ambiguous. A row
   * of twenty services all reading "Stop" is unusable without one, and
   * `title` alone is not reliably announced.
   */
  ariaLabel?: string;
  testId?: string;
}) {
  const tooltip = title ?? ariaLabel ?? buttonTooltipText(children);
  return (
    <button
      type="button"
      className={`inline-flex min-h-control cursor-default items-center justify-center gap-1.5 rounded-control border px-[11px] py-0.5 text-[12px] whitespace-nowrap disabled:cursor-default disabled:opacity-50 ${
        quiet ? 'min-h-auto border-transparent bg-transparent px-1 text-accent shadow-none hover:text-accent hover:brightness-110' : BUTTON_KIND[kind]
      }`}
      onClick={onClick}
      disabled={disabled}
      title={tooltip || undefined}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {icon}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

/** Text label for the browser tooltip when a call site has no more specific help. */
export function buttonTooltipText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(buttonTooltipText).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (isValidElement<{ children?: ReactNode }>(node)) return buttonTooltipText(node.props.children);
  return '';
}

/**
 * What an icon-only command is doing right now.
 *
 * One union rather than a pair of booleans. Eight copy commands in this app
 * reported nothing at all and one swapped its own glyph by hand, so "did it
 * land" and "is it in flight" were two unrelated facts that a call site could
 * disagree with itself about. Three cases cannot disagree.
 */
export type IconCommandPhase = 'idle' | 'working' | 'confirmed';

/** The help tag and the accessible name while `phase` is `confirmed`. */
export const CONFIRMED_LABEL = 'Copied';

/** The help tag and the accessible name while `phase` is `working`. */
export const WORKING_LABEL = 'Working';

/**
 * How long a copy confirmation stays on screen. The macOS control holds the
 * same 1.4s on `DesignIconButton.confirmationDuration`, so the two apps stop
 * at the same beat rather than drifting apart a second at a time.
 */
export const COPY_CONFIRMATION_MS = 1400;

/**
 * The transient "it landed" state of a copy command, and the single timer
 * every copy in the app shares.
 *
 * Eight copy commands reported nothing at all, and adding a confirmation to
 * each would have meant eight copies of the same pair of lines. The refusal
 * case matters as much as the success case: `service.copy` reports whether the
 * text reached the clipboard, and a control that confirmed a refused write
 * would be lying to the one user who cannot select the text and read it back.
 */
export function useCopyConfirmation(duration: number = COPY_CONFIRMATION_MS): {
  phase: IconCommandPhase;
  begin: () => boolean;
  report: (ok: boolean) => void;
} {
  const [phase, setPhase] = useState<IconCommandPhase>('idle');
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );
  const begin = useCallback(() => {
    if (pending.current) return false;
    pending.current = true;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setPhase('working');
    return true;
  }, []);
  const report = useCallback((ok: boolean) => {
    pending.current = false;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setPhase(ok ? 'confirmed' : 'idle');
    if (ok) {
      timer.current = setTimeout(() => {
        timer.current = null;
        setPhase('idle');
      }, duration);
    }
  }, [duration]);
  return {
    phase,
    begin,
    report,
  };
}

/**
 * An icon-only command, and the one place its state is drawn.
 *
 * macOS reaches for an `NSButton` here so AppKit paints the hover, the press
 * and the disabled bezel. A web button already paints all three from CSS, so
 * the parity problem was never the control kind — it was that eight call
 * sites drew nothing for `confirmed` and one drew it by hand. A fixed
 * `size-[22px]` box also makes the phase swap free: unlike the macOS control,
 * no canvas is needed, because the box never changes size.
 */
export function IconButton({
  children,
  confirmed,
  onClick,
  label,
  phase = 'idle',
  language = 'auto',
  resolvedLanguage = 'en',
  disabled = false,
  ariaHasPopup,
  ariaExpanded,
  ariaControls,
  buttonRef,
  testId,
}: {
  children: ReactNode;
  /** Drawn instead of `children` while `phase` is `confirmed`. */
  confirmed?: ReactNode;
  onClick?: () => void;
  /**
   * The help tag and the accessible name. Required, so an unnamed icon-only
   * control is a type error rather than something a review has to catch.
   */
  label: string;
  language?: string;
  resolvedLanguage?: string;
  phase?: IconCommandPhase;
  disabled?: boolean;
  ariaHasPopup?: AriaAttributes['aria-haspopup'];
  ariaExpanded?: boolean;
  ariaControls?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  testId?: string;
}) {
  const working = phase === 'working';
  const landed = phase === 'confirmed' && confirmed !== undefined;
  const confirmedLabel = translate('desktop.common.copied', language, resolvedLanguage);
  const workingLabel = translate('desktop.common.working', language, resolvedLanguage);
  const announced = landed ? confirmedLabel : working ? `${label} — ${workingLabel}` : label;
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`inline-flex size-[22px] cursor-default items-center justify-center rounded-full border-0 bg-transparent p-0 hover:not-disabled:bg-hover active:not-disabled:bg-active disabled:text-tertiary ${
        landed ? 'text-green' : 'text-secondary'
      }`}
      onClick={onClick}
      // A second click while the first request is in flight lands on the same
      // single-flight slot, so the disabled state is the gate, not decoration.
      disabled={disabled || working}
      aria-label={announced}
      title={announced}
      aria-busy={working || undefined}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      data-testid={testId}
    >
      {working ? (
        <span
          className="spinner size-[13px] rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
      ) : landed ? (
        confirmed
      ) : (
        children
      )}
    </button>
  );
}

/** `DesignStatusLabel`. A 7pt dot plus the macOS label, verbatim. */
export function StatusLabel({
  status,
  labels,
  language = 'en',
  resolvedLanguage = language,
}: {
  status: DesignStatus;
  labels?: Partial<Record<DesignStatus, string>>;
  language?: string;
  resolvedLanguage?: string;
}) {
  const label = labels?.[status]
    || translate(`desktop.overview.status_${status}`, language, resolvedLanguage)
    || STATUS_LABEL[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] whitespace-nowrap text-secondary">
      <span className={`size-status-dot flex-none rounded-full ${STATUS_TONE[status]}`} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

/** A stopped service is a hollow ring, not a filled dot: absence, not failure. */
const STATUS_TONE: Record<DesignStatus, string> = {
  running: 'bg-green',
  ready: 'bg-green',
  attention: 'bg-orange',
  unavailable: 'bg-red',
  stopped: 'border-[1.5px] border-secondary/60 bg-transparent',
};

export function WarningGlyph({
  language = 'auto',
  resolvedLanguage = 'en',
}: {
  language?: string;
  resolvedLanguage?: string;
} = {}) {
  return (
    <span
      className="inline-flex items-center text-orange"
      role="img"
      aria-label={translate('desktop.common.warning', language, resolvedLanguage)}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
        <path
          d="M12 4 21 20H3L12 4z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d="M12 10v4M12 17h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/** `DesignEmptyState`. A message and one way out, never a decorative panel. */
export function EmptyState({
  title,
  detail,
  actionTitle,
  onAction,
  testId,
  actions,
}: {
  title: string;
  detail: string;
  actionTitle?: string;
  onAction?: () => void;
  testId?: string;
  /** Extra trailing commands, next to `actionTitle`. */
  actions?: ReactNode;
}) {
  return (
    <div
      className="flex flex-col items-center gap-3 px-5 py-10 text-center"
      data-testid={testId}
    >
      <div className="flex flex-col gap-3">
        <div className="text-[15px] font-semibold text-text">{title}</div>
        {/* The bare "nothing here" line, named apart from the panel around it:
            an inventory that sees only the panel cannot tell an empty state
            from any other container. */}
        <p className="mx-0 mb-0 max-w-[44ch] text-[12px] leading-[1.4] text-secondary" data-testid="state.empty-row">
          {detail}
        </p>
      </div>
      {actionTitle ? <Button onClick={onAction}>{actionTitle}</Button> : null}
      {actions}
    </div>
  );
}

export function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  help,
  testId,
  className = '',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password';
  placeholder?: string;
  /** Short guidance shown by the browser/webview when the field is hovered. */
  help?: string;
  testId?: string;
  className?: string;
}) {
  return (
    <label className={`flex min-w-0 flex-1 items-center justify-between gap-3 ${className}`}>
      <span className="shrink-0 text-[13px] text-text">{label}</span>
      <input
        className="min-h-control w-full max-w-[280px] rounded-control border border-control-border bg-field px-2 py-0.5 text-[12px] text-text placeholder:text-tertiary focus:border-accent"
        type={type}
        value={value}
        placeholder={placeholder}
        title={help}
        onChange={(event) => onChange(event.target.value)}
        data-testid={testId}
      />
    </label>
  );
}

/** The picker bezel. A select, a model picker and a log source are one control. */
const SELECT = 'min-h-control max-w-55 min-w-40 rounded-control border border-control-border bg-control px-2 text-[12px] text-text';

export function Select({
  label,
  value,
  onChange,
  options,
  ariaLabel,
  disabled = false,
  testId,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  /**
   * Overrides the visible label as the accessible name. A form that shows one
   * "Kind" per provider repeats the word, and "Kind" alone does not say which
   * provider a screen reader is on.
   */
  ariaLabel?: string;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <label className="flex items-center gap-2">
      {label ? <span className="text-[13px] text-text">{label}</span> : null}
      <select
        className={SELECT}
        value={value}
        aria-label={ariaLabel}
        title={ariaLabel ?? label}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        data-testid={testId}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * A labelled checkbox on its own row. macOS's `Form` binds the label to the
 * control, so a checkbox row is not a row with a checkbox in it: the whole row
 * is the target.
 *
 * The label comes first and `detail` after it. The reverse order reads as
 * "Google's AI coding tool Gemini" — a sentence with its subject at the end.
 */
export function CheckRow({
  label,
  checked,
  disabled = false,
  onChange,
  detail,
  testId,
}: {
  label: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  detail?: ReactNode;
  testId?: string;
}) {
  return (
    <label className="flex min-w-0 w-full cursor-default items-center gap-2.5 text-[13px] text-text has-disabled:opacity-50">
      <input
        type="checkbox"
        className="m-0 size-4 flex-none rounded-[4px] border border-control-border accent-accent cursor-default"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        data-testid={testId}
      />
      <span className="min-w-0 flex-none">{label}</span>
      {detail ? <span className="min-w-0 truncate text-secondary">{detail}</span> : null}
    </label>
  );
}

/**
 * A read-only trailing value: a transport name, a quota reset, a status word.
 * macOS keeps these in `LabeledContent` with `secondary`, never as the row's
 * title, so the title stays the thing the row is about.
 */
export function ValueText({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <span className="text-[12px] whitespace-nowrap text-secondary" data-testid={testId}>
      {children}
    </span>
  );
}

/**
 * A row mirroring macOS SwiftUI's `LabeledContent(label, value: ...)`:
 * label text on the left, trailing value or controls on the right.
 */
export function LabeledRow({
  label,
  value,
  children,
  testId,
}: {
  label: string;
  value?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <Row testId={testId}>
      <span className="shrink-0 text-[13px] text-text">{label}</span>
      <RowActions>
        {value !== undefined ? <ValueText>{value}</ValueText> : null}
        {children}
      </RowActions>
    </Row>
  );
}

/** A Settings switch. The label is the accessible name; the control itself is wordless. */
export function Switch({
  checked,
  label,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      // 38x22 is the macOS switch. The thumb is a pseudo-element on the track
      // so the travel distance is fixed rather than a translate on a child.
      //
      // One of the two track colours is emitted, never both. Two
      // `bg-*` utilities on one element resolve by stylesheet order, not by
      // the order they appear in the class attribute, so appending `bg-green`
      // to a `bg-switch-off` string renders an off switch when the utility
      // happens to be generated first.
      className={`group relative h-[22px] w-[38px] cursor-default rounded-[11px] border-0 p-0 transition-colors duration-120 disabled:opacity-45 ${
        checked ? 'bg-green after:translate-x-4' : 'bg-switch-off after:translate-x-0'
      } after:absolute after:top-0.5 after:left-0.5 after:size-[18px] after:rounded-full after:bg-white after:shadow-[0_1px_3px_rgb(0_0_0/0.25)] after:transition-transform after:duration-120`}
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function LoadingState({ label = translate('desktop.main.loading', 'auto', detectLanguage()) }: { label?: string }) {
  return (
    <div
      className="flex items-center justify-center gap-2.5 px-5 py-12 text-[13px] text-secondary"
      role="status"
      data-testid="state.loading"
    >
      <span className="spinner size-[15px] rounded-full border-2 border-separator border-t-secondary" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
