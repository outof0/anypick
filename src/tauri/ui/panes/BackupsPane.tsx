import { useEffect, useState } from 'react';

import type { Snapshot } from '../lib/contract';
import {
  backupAll,
  exportBackup,
  forgetBackup,
  importBackup,
  mutateAction,
} from '../lib/desktop-actions';
import { translate } from '../lib/i18n';
import type { ServicePort } from '../lib/service';
import type { BackupPreviewFrame } from '../lib/wire';
import { Button, Group, Pane, PaneActions, Row, RowActions, RowText, WarningRow } from '../ui/primitives';
import { MenuDivider, MenuItem, RowMenu } from '../ui/RowMenu';
import { CreateBackupSheet, RestoreBackupSheet } from './BackupSheets';

export function BackupsPane({
  service,
  snapshot,
  preview = null,
  busy = new Set<string>(),
  initialExportOpen = false,
  initialReviewOpen = false,
}: {
  service: ServicePort;
  snapshot: Snapshot;
  preview?: BackupPreviewFrame | null;
  busy?: ReadonlySet<string>;
  initialExportOpen?: boolean;
  initialReviewOpen?: boolean;
}) {
  const [exportOpen, setExportOpen] = useState(initialExportOpen);
  const [reviewOpen, setReviewOpen] = useState(() => initialReviewOpen || Boolean(preview && preview.status === 'ready'));
  const [lastReviewedPath, setLastReviewedPath] = useState('');
  const t = (key: string) =>
    translate(`desktop.backups.${key}`, snapshot.settings.language, snapshot.settings.resolvedLanguage);
  const accountCount = (count: number) =>
    translate(
      `desktop.backups.${count === 1 ? 'account_one' : 'account_many'}`,
      snapshot.settings.language,
      snapshot.settings.resolvedLanguage,
    ).replace('%d', String(count));

  useEffect(() => {
    if (preview && (preview.status === 'ready' || preview.status === 'error')) {
      setReviewOpen(true);
    }
  }, [preview]);

  const handleExport = (path: string, accountIds: string[], overwrite: boolean) => {
    const accounts = snapshot.accounts
      .filter((account) => accountIds.includes(account.id))
      .map((account) => ({ provider: account.providerId, name: account.name }));
    const action = exportBackup(path, accounts, overwrite);
    service.mutate(action.operation, action.extra);
    setExportOpen(false);
  };

  const handleQuickBackup = () => {
    mutateAction(service, backupAll());
    setExportOpen(false);
  };

  const handleReview = (path: string) => {
    setLastReviewedPath(path);
    service.inspectBackup(path);
  };

  const handleImport = (inspectionId: string, entryIds: string[], overwrite: boolean) => {
    const action = importBackup(inspectionId, entryIds, overwrite);
    service.mutate(action.operation, action.extra);
    setReviewOpen(false);
  };

  const handleDiscard = (inspectionId: string) => {
    const action = forgetBackup(inspectionId);
    service.mutate(action.operation, action.extra);
    setReviewOpen(false);
  };

  return (
    <Pane title={translate('desktop.nav.backups', snapshot.settings.language, snapshot.settings.resolvedLanguage)} testId="backups">
      {/* Warning section matching macOS `BackupsView.swift:38-50` */}
      <Group testId="backups-warning">
        <WarningRow
          title={t('warning_title')}
          detail={t('warning_detail')}
        />
      </Group>

      {/* Reviewed backups section matching macOS `BackupsView.swift:52-134` */}
      <Group
        title={t('reviewed_title')}
        footer={t('reviewed_footer')}
      >
        {preview?.status === 'ready' ? (
          <Row testId={`backups.inventory.${preview.inspectionId || 'preview'}`}>
            <div className="flex h-7 w-7 items-center justify-center rounded text-accent">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="13" rx="2" />
                <path d="M6 13h.01M10 13h.01" />
                <path d="M15 8l2 2 4-4" />
                <line x1="2" y1="11" x2="22" y2="11" />
              </svg>
            </div>
            <RowText
              title={formatBackupDate(
                preview.createdAt,
                snapshot.settings.language === 'auto' ? snapshot.settings.resolvedLanguage : snapshot.settings.language,
                t('reviewed_backup'),
              )}
              detail={`${accountCount(preview.entries.length)} · ${lastReviewedPath || t('staged_backup')}`}
            />
            <RowActions>
              <Button kind="secondary" onClick={() => setReviewOpen(true)}>
                {t('review')}
              </Button>
              <RowMenu
                label={t('more_options')}
                clipboard={service.copy}
                language={snapshot.settings.language}
                resolvedLanguage={snapshot.settings.resolvedLanguage}
                testId="backups.more-menu"
              >
                {(close, copy) => (
                  <>
                    <MenuItem onSelect={() => {
                        close();
                        setReviewOpen(true);
                      }}>
                      {t('review_backup')}
                    </MenuItem>
                    {lastReviewedPath ? (
                      <MenuItem onSelect={() => {
                          copy(
                            lastReviewedPath,
                            t('backup_file').toLocaleLowerCase(
                              snapshot.settings.language === 'auto'
                                ? snapshot.settings.resolvedLanguage
                                : snapshot.settings.language,
                            ),
                          );
                        }}>
                        {t('copy_path')}
                      </MenuItem>
                    ) : null}
                    <MenuDivider />
                    <MenuItem destructive onSelect={() => {
                        close();
                        if (preview.inspectionId) handleDiscard(preview.inspectionId);
                      }}>
                      {t('forget_review')}
                    </MenuItem>
                  </>
                )}
              </RowMenu>
              <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false" className="text-tertiary">
                <path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </RowActions>
          </Row>
        ) : (
          <Row>
            <RowText detail={t('empty_reviewed')} />
          </Row>
        )}
      </Group>

      {/* Quick backup section */}
      <Group
        title={t('quick_title')}
        footer={t('quick_footer')}
        testId="backups-create-quick"
      >
        <Row testId="backup-create-row">
          <RowText
            title={t('quick_create_title')}
            detail={t('quick_create_detail')}
          />
          <RowActions>
            <Button
              kind="secondary"
              disabled={busy.size > 0}
              onClick={handleQuickBackup}
            >
              {t('quick_create_action')}
            </Button>
          </RowActions>
        </Row>
      </Group>

      {/* Bottom pane actions matching macOS `BackupsView.swift:204-216` */}
      <PaneActions>
        <Button
          kind="secondary"
          testId="backups-create"
          disabled={busy.size > 0 || snapshot.accounts.length === 0}
          onClick={() => setExportOpen(true)}
        >
          {t('export_accounts')}
        </Button>
        <Button
          kind="secondary"
          testId="backups-import"
          disabled={busy.size > 0}
          onClick={() => setReviewOpen(true)}
        >
          {t('review_backup')}
        </Button>
      </PaneActions>

      {/* Sheets matching macOS `CreateBackupSheet` & `RestoreBackupSheet` */}
      {exportOpen ? (
        <CreateBackupSheet
          accounts={snapshot.accounts}
          language={snapshot.settings.language}
          resolvedLanguage={snapshot.settings.resolvedLanguage}
          busy={busy.size > 0}
          onClose={() => setExportOpen(false)}
          onExport={handleExport}
        />
      ) : null}

      {reviewOpen ? (
        <RestoreBackupSheet
          preview={preview}
          language={snapshot.settings.language}
          resolvedLanguage={snapshot.settings.resolvedLanguage}
          busy={busy.size > 0}
          initialPath={lastReviewedPath}
          onClose={() => setReviewOpen(false)}
          onReview={handleReview}
          onImport={handleImport}
          onDiscard={handleDiscard}
        />
      ) : null}
    </Pane>
  );
}

function formatBackupDate(isoString: string | undefined, locale: string, fallback: string): string {
  if (!isoString) return fallback;
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    return d.toLocaleString(locale, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}
