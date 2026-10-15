import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Symbol } from '../shell/Symbol';
import { translate } from '../lib/i18n';
import { buttonTooltipText, IconButton } from './primitives';
import { POPOVER_PANEL_CLASS } from './popover';
import { usePopover } from './usePopover';

/**
 * A row's secondary commands, in a menu rather than a wall of buttons.
 *
 * The Accounts and Apps rows had four buttons each, always visible. Every row
 * shouting its own commands is the control-panel look the macOS contract bans;
 * macOS reserves a trailing column and puts the rest behind one control.
 */
export function RowMenu({
  label,
  children,
  align = 'end',
  clipboard,
  language = 'auto',
  resolvedLanguage = 'en',
  testId,
}: {
  /** The accessible name. A menu with no name is a button that says "…". */
  label: string;
  children: (close: () => void, copy: (value: string, description: string) => void) => ReactNode;
  align?: 'start' | 'end';
  /** Enables menu copy commands and their shared live announcement. */
  clipboard?: (value: string) => Promise<boolean>;
  language?: string;
  resolvedLanguage?: string;
  testId?: string;
}) {
  const pop = usePopover(align);
  const [announcement, setAnnouncement] = useState('');
  const t = (key: string) => translate(`desktop.common.${key}`, language, resolvedLanguage);
  const copy = (value: string, description: string) => {
    pop.close();
    void Promise.resolve(clipboard?.(value) ?? false).then(
      (ok) => setAnnouncement(t(ok ? 'copy_succeeded_for' : 'copy_failed_for').replace('{description}', description)),
      () => setAnnouncement(t('copy_failed_for').replace('{description}', description)),
    );
  };

  return (
    <div className="relative flex-none" ref={pop.root}>
      <IconButton
        buttonRef={pop.trigger}
        label={label}
        language={language}
        resolvedLanguage={resolvedLanguage}
        ariaHasPopup="menu"
        ariaExpanded={pop.open}
        ariaControls={pop.open ? pop.panelId : undefined}
        testId={testId}
        onClick={() => pop.setOpen((current: boolean) => !current)}
      >
        <Symbol name="ellipsis.circle" size={15} />
      </IconButton>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="row-menu-copy-status">
        {announcement}
      </span>
      {pop.open
        ? createPortal(
            <div
              ref={pop.panel}
              id={pop.panelId}
              data-dialog-owner={pop.dialogOwner}
              role="menu"
              onKeyDown={pop.onPanelKeyDown}
              style={{
                top: pop.placement?.top ?? -10000,
                left: pop.placement?.left ?? -10000,
                visibility: pop.placement ? 'visible' : 'hidden',
              }}
              className={POPOVER_PANEL_CLASS}
            >
              {children(pop.close, copy)}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** One item in a `RowMenu`. `destructive` is red text, not a filled block. */
export function MenuItem({
  children,
  onSelect,
  destructive = false,
  disabled = false,
  testId,
}: {
  children: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /**
   * A literal, in the JSX, at the call site.
   *
   * `test/parity.test.ts` finds Tauri elements by scanning source for
   * `data-testid` literals, so a menu item that carries its id through a
   * runtime-built array is invisible to it — and the parity row then reads as
   * "the UI does not emit this" when the control is right there.
   */
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      title={buttonTooltipText(children) || undefined}
      disabled={disabled}
      className={`block w-full cursor-default rounded-control border-0 bg-transparent px-2.5 py-1 text-left text-[12px] hover:not-disabled:bg-accent hover:not-disabled:text-white disabled:cursor-default disabled:opacity-50 ${
        destructive ? 'text-red hover:not-disabled:bg-red hover:not-disabled:text-white' : 'text-text'
      }`}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}

/** A divider, so a destructive item is never adjacent to a live one. */
export function MenuDivider() {
  return <div role="separator" className="my-1 border-t border-separator-soft" />;
}
