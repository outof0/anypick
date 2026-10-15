import { useState, useRef } from 'react';

import type { AccountRow } from '../lib/contract';
import { backupImportEntryIDs } from '../lib/desktop-actions';
import { translate, translateSource } from '../lib/i18n';
import type { BackupPreviewFrame } from '../lib/wire';
import { Dialog } from '../ui/Dialog';
import { Button, CheckRow, Field, Group, Row, RowActions, RowText, WarningGlyph } from '../ui/primitives';
import { ProviderIcon } from '../shell/ProviderIcon';

/**
 * CreateBackupSheet: mirrors macOS `CreateBackupSheet` (`BackupFlows.swift:10-101`).
 *
 * Allows user to select saved accounts to export, set destination path,
 * and choose whether to replace an existing file.
 */
export function CreateBackupSheet({
  accounts,
  language,
  resolvedLanguage,
  busy = false,
  onClose,
  onExport,
  onQuickBackup,
}: {
  accounts: readonly AccountRow[];
  language: string;
  resolvedLanguage: string;
  busy?: boolean;
  onClose: () => void;
  onExport: (path: string, accountIds: string[], overwrite: boolean) => void;
  onQuickBackup?: () => void;
}) {
  const [path, setPath] = useState('');
  const [selected, setSelected] = useState<string[]>(() => accounts.map((a) => a.id));
  const [overwrite, setOverwrite] = useState(false);
  const t = (key: string) => translate(`desktop.backups.${key}`, language, resolvedLanguage);
  const selectedCount = (selected: number, total: number) =>
    t('selection_count').replace('%1$d', String(selected)).replace('%2$d', String(total));

  const toggleAll = () => {
    if (selected.length === accounts.length) {
      setSelected([]);
    } else {
      setSelected(accounts.map((a) => a.id));
    }
  };

  const handleExport = () => {
    if (!path.trim() || selected.length === 0 || busy) return;
    onExport(path.trim(), selected, overwrite);
  };

  return (
    <Dialog
      title={t('export_title')}
      width="form"
      onCancel={onClose}
      testId="backups-export"
      actions={
        <>
          <Button kind="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            kind="primary"
            disabled={busy || !path.trim() || selected.length === 0}
            testId="backup-export-submit"
            onClick={handleExport}
          >
            {t('export')}
          </Button>
        </>
      }
    >
      <Group title={t('destination')}>
        <Row>
          <Field
            label={t('file')}
            value={path}
            placeholder="~/Desktop/backup.json"
            onChange={setPath}
            testId="backup-export-path"
          />
        </Row>
        <Row>
          <CheckRow
            label={t('replace_existing_file')}
            checked={overwrite}
            testId="backup-export-overwrite"
            onChange={setOverwrite}
          />
        </Row>
      </Group>

      <Group
        title={t('saved_accounts')}
        footer={
          accounts.length === 0
            ? t('add_login')
            : t('unencrypted')
        }
      >
        {accounts.length > 1 ? (
          <Row>
            <RowText detail={selectedCount(selected.length, accounts.length)} />
            <RowActions>
              <button
                type="button"
                className="cursor-default bg-transparent text-[11px] font-medium text-accent hover:underline"
                title={t(selected.length === accounts.length ? 'deselect_saved_help' : 'select_saved_help')}
                onClick={toggleAll}
              >
                {t(selected.length === accounts.length ? 'deselect_all' : 'select_all')}
              </button>
            </RowActions>
          </Row>
        ) : null}
        {accounts.length === 0 ? (
          <Row>
            <RowText detail={t('no_saved_accounts')} />
          </Row>
        ) : (
          accounts.map((account) => {
            const checked = selected.includes(account.id);
            return (
              <Row key={account.id} testId={`backup-account-${account.id}`}>
                <label className="flex min-w-0 w-full cursor-default items-center gap-3 text-[13px] text-text">
                  <input
                    type="checkbox"
                    className="m-0 size-4 flex-none rounded-[4px] border border-control-border accent-accent cursor-default"
                    checked={checked}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked ? [...current, account.id] : current.filter((id) => id !== account.id),
                      )
                    }
                  />
                  <span className="grid size-[20px] flex-none place-items-center text-secondary">
                    <ProviderIcon provider={account.providerId} size={18} />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[13px] font-medium text-text">{account.label || account.name}</span>
                    <span className="text-[11px] text-secondary truncate">{account.detail || account.providerId}</span>
                  </div>
                </label>
              </Row>
            );
          })
        )}
      </Group>
    </Dialog>
  );
}

/**
 * RestoreBackupSheet: mirrors macOS `RestoreBackupSheet` (`BackupFlows.swift:103-245`).
 *
 * Allows inspecting a backup file, previewing accounts contained in the backup,
 * selecting which accounts to restore/import, and handling replace options.
 */
export function RestoreBackupSheet({
  preview,
  language,
  resolvedLanguage,
  busy = false,
  initialPath = '',
  onClose,
  onReview,
  onImport,
  onDiscard,
}: {
  preview: BackupPreviewFrame | null;
  language: string;
  resolvedLanguage: string;
  busy?: boolean;
  initialPath?: string;
  onClose: () => void;
  onReview: (path: string) => void;
  onImport: (inspectionId: string, entryIds: string[], overwrite: boolean) => void;
  onDiscard: (inspectionId: string) => void;
}) {
  const [path, setPath] = useState(initialPath);
  const [overwrite, setOverwrite] = useState(false);
  const [selectedEntries, setSelectedEntries] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [pickError, setPickError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const t = (key: string) => translate(`desktop.backups.${key}`, language, resolvedLanguage);
  const selectedCount = (selected: number, total: number) =>
    t('selection_count').replace('%1$d', String(selected)).replace('%2$d', String(total));

  /**
   * Turn a chosen or dropped file into a review path.
   *
   * The engine inspects a path on disk, and a webview `File` exposes one only
   * when the host attaches it. The old code read the file and POSTed it to
   * `/_api/stage-file`, a route that exists only in the Vite dev plugin: in the
   * packaged app the fetch 404s, and the fallback then handed the engine
   * `file.name` — a bare filename that is not a path, so the review failed
   * against the wrong file. A path the user typed is the honest answer; a
   * fabricated one is not.
   */
  const processFile = (file: File) => {
    const nativePath = (file as unknown as { path?: string }).path;
    if (nativePath) {
      setPickError('');
      setPath(nativePath);
      onReview(nativePath);
      return;
    }
    setPickError(t('picker_error'));
  };

  const handleFileChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    processFile(file);
  };

  const isReady = preview?.status === 'ready';
  const entries = isReady ? preview.entries : [];
  const dispositions = Object.fromEntries(entries.map((entry) => [entry.id, entry.disposition]));
  const importIds = backupImportEntryIDs(selectedEntries, dispositions, overwrite);

  const toggleAll = () => {
    if (selectedEntries.length === entries.length) {
      setSelectedEntries([]);
    } else {
      setSelectedEntries(entries.map((e) => e.id));
    }
  };

  const handleImport = () => {
    if (!isReady || !preview.inspectionId || importIds.length === 0 || busy) return;
    onImport(preview.inspectionId, importIds, overwrite);
  };

  return (
    <Dialog
      title={isReady ? t('restore_title') : t('review_modal_title')}
      width="form"
      onCancel={onClose}
      testId="backups-import"
      actions={
        <>
          <Button kind="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          {isReady && preview.inspectionId ? (
            <Button
              kind="quiet"
              disabled={busy}
              testId="backup-forget"
              onClick={() => onDiscard(preview.inspectionId)}
            >
              {t('discard_review')}
            </Button>
          ) : null}
          {isReady ? (
            <Button
              kind="primary"
              disabled={busy || importIds.length === 0 || !preview.inspectionId}
              testId="backup-import-submit"
              onClick={handleImport}
            >
              {t('import')}
            </Button>
          ) : (
            <Button
              kind="primary"
              disabled={busy || !path.trim()}
              testId="backup-review"
              onClick={() => onReview(path.trim())}
            >
              {t('review')}
            </Button>
          )}
        </>
      }
    >
      <Group title={t('backup_file')} footer={t('review_before_write')}>
        <Row>
          <div
            className={`flex min-w-0 flex-1 items-center gap-3 transition-colors ${
              isDragging ? 'rounded-control ring-2 ring-accent' : ''
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file) processFile(file);
            }}
          >
            <span className="shrink-0 text-[13px] text-text">{t('file')}</span>
            <input
              className="min-h-control w-full flex-1 rounded-control border border-control-border bg-field px-2 py-0.5 text-[12px] text-text placeholder:text-tertiary focus:border-accent"
              type="text"
              value={path}
              placeholder="~/Desktop/backup.json"
              onChange={(e) => setPath(e.target.value)}
              data-testid="backup-import-path"
            />
          </div>
          <RowActions>
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept=".json,.anypick-backup,application/json"
              onChange={handleFileChosen}
              data-testid="backup-file-picker"
            />
            <Button
              kind="secondary"
              testId="backup-choose-file"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
            >
              {t('choose_file')}
            </Button>
          </RowActions>
          <p className="text-secondary" data-testid="backup-path-hint">
            {t('choose_hint')}
          </p>
        </Row>
        {pickError ? (
          <Row warning testId="backup-pick-error">
            <WarningGlyph language={language} resolvedLanguage={resolvedLanguage} />
            <RowText title={t('picker_error_title')} detail={translateSource(pickError, language, resolvedLanguage)} />
          </Row>
        ) : null}
      </Group>

      {preview?.status === 'error' ? (
        <Group>
          <Row warning testId="backup-review-error">
            <WarningGlyph language={language} resolvedLanguage={resolvedLanguage} />
            <RowText
              title={t('nothing_imported')}
              detail={preview.message
                ? translateSource(preview.message, language, resolvedLanguage)
                : preview.reason
                  ? translateSource(preview.reason, language, resolvedLanguage)
                  : t('choose_another')}
            />
          </Row>
        </Group>
      ) : null}

      {isReady && entries.length > 0 ? (
        <>
          <Group
            title={t('accounts_in_backup')}
            footer={t('accounts_in_backup_help')}
          >
            {entries.length > 1 ? (
              <Row>
                <RowText detail={selectedCount(selectedEntries.length, entries.length)} />
                <RowActions>
                  <button
                    type="button"
                    className="cursor-default bg-transparent text-[11px] font-medium text-accent hover:underline"
                    title={t(selectedEntries.length === entries.length ? 'deselect_backup_help' : 'select_backup_help')}
                    onClick={toggleAll}
                  >
                    {t(selectedEntries.length === entries.length ? 'deselect_all' : 'select_all')}
                  </button>
                </RowActions>
              </Row>
            ) : null}
            {entries.map((entry) => {
              const checked = selectedEntries.includes(entry.id);
              const isReplace = entry.disposition === 'replace';
              return (
                <Row key={entry.id} testId={`backup-entry-${entry.id}`}>
                  <label className="flex min-w-0 w-full cursor-default items-center gap-3 text-[13px] text-text">
                    <input
                      type="checkbox"
                      className="m-0 size-4 flex-none rounded-[4px] border border-control-border accent-accent cursor-default"
                      checked={checked}
                      onChange={(event) =>
                        setSelectedEntries((current) =>
                          event.target.checked ? [...current, entry.id] : current.filter((id) => id !== entry.id),
                        )
                      }
                    />
                    <span className="grid size-[20px] flex-none place-items-center text-secondary">
                      <ProviderIcon provider={entry.providerId} size={18} />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[13px] font-medium text-text">{entry.label || entry.name}</span>
                        {isReplace ? (
                          <span className="rounded-control bg-badge px-1 py-0.2 text-[10px] font-medium text-secondary">
                            {t('existing')}
                          </span>
                        ) : null}
                      </div>
                      <span className="text-[11px] text-secondary truncate">{entry.providerId}</span>
                    </div>
                  </label>
                </Row>
              );
            })}
          </Group>

          <Group title={t('options')}>
            <Row>
              <CheckRow
                label={t('replace_saved_accounts')}
                checked={overwrite}
                testId="backup-import-overwrite"
                onChange={setOverwrite}
              />
            </Row>
          </Group>
        </>
      ) : null}
    </Dialog>
  );
}
