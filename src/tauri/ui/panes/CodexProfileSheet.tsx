import { useState } from 'react';

import type { CodexProfileRow, Snapshot } from '../lib/contract';
import { cleanModelDisplayName } from '../lib/model';
import { validCodexProfileName } from '../lib/desktop-actions';
import { translate } from '../lib/i18n';
import { Dialog } from '../ui/Dialog';
import { Button, Field, Group, Row, Select } from '../ui/primitives';

/** Mirrors macOS `CodexProfileSheet` in `src/macos/AppSheets.swift:793-920`. */
export function CodexProfileSheet({
  profile,
  sources,
  existingProfiles,
  busy,
  language,
  resolvedLanguage,
  onClose,
  onSave,
}: {
  profile?: CodexProfileRow | null;
  sources: Snapshot['codexProfileSources'];
  existingProfiles: Snapshot['codexProfiles'];
  busy: ReadonlySet<string>;
  language: string;
  resolvedLanguage: string;
  onClose: () => void;
  onSave: (payload: {
    name: string;
    sourceId: string;
    modelId: string;
    transportPolicy: string;
    isUpdate: boolean;
  }) => void;
}) {
  const t = (key: string) => translate(`desktop.codex_profile.${key}`, language, resolvedLanguage);
  const ta = (key: string) => translate(`desktop.app_detail.${key}`, language, resolvedLanguage);
  const tc = (key: string) => translate(`desktop.common.${key}`, language, resolvedLanguage);
  const isEdit = Boolean(profile);
  const [name, setName] = useState(profile?.name ?? '');
  const [sourceId, setSourceId] = useState(profile?.sourceId ?? sources[0]?.sourceId ?? '');
  const [modelId, setModelId] = useState(profile?.modelId ?? '');
  const [transport, setTransport] = useState(profile?.transportPolicy || 'auto');

  const selectedSource = sources.find((s) => s.sourceId === sourceId);
  const availableModels = selectedSource?.models ?? [];

  const nameAlreadyExists =
    !isEdit && existingProfiles.some((p) => p.name.toLowerCase() === name.trim().toLowerCase());
  const invalidName = name.length > 0 && !validCodexProfileName(name);
  const canSave =
    validCodexProfileName(name) &&
    !nameAlreadyExists &&
    Boolean(selectedSource) &&
    busy.size === 0;

  return (
    <Dialog
      title={t(isEdit ? 'edit_title' : 'add_title')}
      onCancel={onClose}
      testId="codex-profile-dialog"
      width="form"
      actions={
        <>
          <Button kind="secondary" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button
            kind="primary"
            disabled={!canSave}
            testId="codex-profile-save"
            onClick={() => {
              onSave({
                name,
                sourceId,
                modelId,
                transportPolicy: transport,
                isUpdate: isEdit,
              });
            }}
          >
            {isEdit ? t('save_changes') : ta('add_profile')}
          </Button>
        </>
      }
    >
      <Group title={t('profile')} footer={isEdit ? t('name_immutable') : undefined}>
        <Row>
          {isEdit ? (
            <div className="flex min-w-0 flex-1 items-center justify-between py-1">
              <span className="text-[13px] text-text">{t('name')}</span>
              <span className="text-[13px] font-medium text-text">{name}</span>
            </div>
          ) : (
            <div className="flex w-full flex-col gap-1">
              <Field
                label={t('name')}
                value={name}
                placeholder={t('name_example')}
                onChange={setName}
                testId="codex-profile-name"
              />
              <span className="text-[11px] text-secondary">
                {t('name_rules')}
              </span>
              {invalidName ? (
                <span className="text-[11px] text-red">{t('invalid_name')}</span>
              ) : nameAlreadyExists ? (
                <span className="text-[11px] text-red">{t('name_exists')}</span>
              ) : null}
            </div>
          )}
        </Row>
      </Group>

      <Group title={ta('connection')}>
        <Row>
          <Select
            label={t('account_or_route')}
            value={sourceId}
            options={sources.map((s) => ({
              value: s.sourceId,
              label: s.label + (s.detail ? ` (${s.detail})` : ''),
            }))}
            ariaLabel={t('account_or_route')}
            testId="codex-profile.source"
            disabled={busy.size > 0}
            onChange={(nextSource) => {
              setSourceId(nextSource);
              setModelId('');
            }}
          />
        </Row>
      </Group>

      <Group title={t('transport')}>
        <Row>
          <Select
            label={t('transport')}
            value={transport}
            options={[
              { value: 'auto', label: ta('automatic') },
              { value: 'proxy', label: t('local_proxy') },
              { value: 'direct', label: t('direct_vendor') },
            ]}
            ariaLabel={t('transport')}
            testId="codex-profile.transport"
            disabled={busy.size > 0}
            onChange={setTransport}
          />
        </Row>
      </Group>

      <Group title={t('model')}>
        <Row>
          <Select
            label={t('model')}
            value={modelId}
            options={[
              { value: '', label: ta('source_default') },
              ...availableModels.map((m) => ({ value: m, label: cleanModelDisplayName(m) })),
            ]}
            ariaLabel={t('model')}
            testId="codex-profile.model"
            disabled={busy.size > 0}
            onChange={setModelId}
          />
        </Row>
      </Group>
    </Dialog>
  );
}
