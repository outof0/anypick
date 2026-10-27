import {
  COLUMN_WIDTH,
  accountIssue,
  accountRowSubtitle,
  showsPrimaryAction,
  type AccountRowView,
} from '../lib/account-row';
import type { ServicePort } from '../lib/service';
import { MenuDivider, MenuItem, RowMenu } from '../ui/RowMenu';
import { ProviderIcon } from '../shell/ProviderIcon';
import { ReservedColumn } from '../ui/ReservedColumns';
import { Button, RowActions, RowText } from '../ui/primitives';
import { refreshSaved } from '../lib/desktop-actions';

/**
 * One account or gateway row, in the four reserved trailing columns.
 *
 * `ReservedColumn` is what makes this a grid rather than a pile: macOS found
 * that a frame on an empty `Group` is dropped, so rows with no primary command
 * slid left and the columns stopped lining up
 * (`SharedUI.swift:313`). Each column holds its width whether or not this row
 * fills it, which is the whole reason the grid reads as a grid.
 *
 * Hover reveals the primary command on macOS. A keyboard user never hovers, so
 * the menu carries the same command and both call the same handler; a command
 * that exists only under a pointer does not exist for half the users.
 */
export function AccountRowGrid({
  row,
  t,
  tr,
  language,
  resolvedLanguage,
  service,
  paused,
  revision,
  onEdit,
  onRemove,
  onDetails,
}: {
  row: AccountRowView;
  t: (key: string) => string;
  tr: (source: string) => string;
  language: string;
  resolvedLanguage: string;
  service: ServicePort;
  paused: boolean;
  revision: number;
  onEdit: () => void;
  onRemove: () => void;
  onDetails: () => void;
}) {
  const issue = accountIssue(row);
  const warning = row.status === 'attention' || row.status === 'unavailable';
  const isGateway = row.kind === 'gateway';

  // Declared before the JSX because the menu's own items call them, and a
  // handler that only closed the menu would be a menu item that does nothing.
  const switchTo = () => service.invokeAction(row.switchActionId, revision);
  const test = () => {
    const action = refreshSaved(row);
    service.mutate(action.operation, action.extra);
  };

  return (
    <>
      {/* `DesignProviderIcon` at 28pt, as `AccountsView.swift:270` — the
          account's own mark, so a list of fourteen rows across six providers
          reads as six providers rather than fourteen anonymous entries. */}
      <ProviderIcon provider={row.providerId} size={26} className="mr-1" />
      <RowText
        title={row.label}
        detail={tr(accountRowSubtitle(row))}
        issue={issue ? tr(issue) : undefined}
        language={language}
        resolvedLanguage={resolvedLanguage}
      />
      <RowActions>
        {/* Column 1 — the primary command. */}
        <ReservedColumn width={COLUMN_WIDTH.action}>
          {showsPrimaryAction(row) ? (
            <Button
              kind="secondary"
              disabled={paused || (!isGateway && !row.switchActionId)}
              testId={`${isGateway ? 'accounts.connect' : 'accounts.switch'}.${row.id}`}
              ariaLabel={`${isGateway ? t('connect') : t('switch_account')}: ${row.label}`}
              onClick={isGateway ? onDetails : switchTo}
            >
              {isGateway ? t('connect') : t('switch_account')}
            </Button>
          ) : null}
        </ReservedColumn>

        {/* Column 2 — the row's state. */}
        <ReservedColumn width={COLUMN_WIDTH.status}>
          {row.active ? (
            <span className="text-green" role="img" aria-label={t('current')}>
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
                <circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.18" />
                <path
                  d="M8 12l3 3 5-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          ) : null}
        </ReservedColumn>

        {/* Column 3 — the row's other commands. */}
        <ReservedColumn width={COLUMN_WIDTH.menu}>
          <RowMenu
            label={t('more_actions_for').replace('{name}', row.label)}
            language={language}
            resolvedLanguage={resolvedLanguage}
            testId={`accounts.more.${row.id}`}
          >
            {(close) => (
              <>
                <MenuItem
                  onSelect={() => {
                    close();
                    onDetails();
                  }}
                >
                  {t('show_details')}
                </MenuItem>
                {isGateway ? (
                  <MenuItem
                    disabled={paused || !showsPrimaryAction(row)}
                    onSelect={() => {
                      close();
                      onDetails();
                    }}
                  >
                    {t('connect')}
                  </MenuItem>
                ) : null}
                {!isGateway && !row.active ? (
                  <MenuItem
                    disabled={paused || !row.switchActionId}
                    onSelect={() => {
                      close();
                      switchTo();
                    }}
                  >
                    {t('switch_account')}
                  </MenuItem>
                ) : null}
                <MenuItem
                  disabled={paused}
                  onSelect={() => {
                    close();
                    onEdit();
                  }}
                >
                  {t('edit')}
                </MenuItem>
                <MenuItem
                  disabled={paused || !row.canRefresh}
                  onSelect={() => {
                    close();
                    test();
                  }}
                >
                  {t(isGateway ? 'test_connection' : 'refresh_login')}
                </MenuItem>
                <MenuDivider />
                <MenuItem
                  destructive
                  disabled={paused}
                  onSelect={() => {
                    close();
                    onRemove();
                  }}
                >
                  {t('remove_action')}
                </MenuItem>
              </>
            )}
          </RowMenu>
        </ReservedColumn>

        {/* Column 4 — the drill-in disclosure. A System Settings row that opens
            something always says so. */}
        <ReservedColumn width={COLUMN_WIDTH.chevron}>
          <button
            type="button"
            className="flex size-full cursor-default items-center justify-center border-0 bg-transparent p-0 text-tertiary hover:bg-hover"
            aria-label={t('show_details_for').replace('{name}', row.label)}
            title={t('show_details_for').replace('{name}', row.label)}
            data-testid={`accounts.detail-${row.id}`}
            onClick={onDetails}
          >
            <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false">
              <path
                d="M9 5l7 7-7 7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </ReservedColumn>
      </RowActions>
    </>
  );
}
