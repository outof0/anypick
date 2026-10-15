import { useState } from 'react';

import { appShortDescription } from '../lib/app-preferences';
import type { Snapshot } from '../lib/contract';
import { translate } from '../lib/i18n';
import { Dialog } from '../ui/Dialog';
import { ProviderIcon } from '../shell/ProviderIcon';
import { Button, CheckRow, Group, Row, RowText } from '../ui/primitives';

/**
 * `AddAppSheet`. Pick one supported app to manage.
 *
 * macOS uses a radio group rather than a picker: the list is short, and every
 * option carries a name and a one-line description, which a collapsed dropdown
 * would hide. Adding is one choice at a time because the point of the sheet is
 * to add *an* app — a multi-select here would say something else.
 */
export function AddAppSheet({
  available,
  snapshot,
  onAdd,
  onClose,
}: {
  available: readonly string[];
  snapshot: Snapshot;
  onAdd: (clientId: string) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(available[0] ?? '');
  const t = (key: string) =>
    translate(`desktop.apps.${key}`, snapshot.settings.language, snapshot.settings.resolvedLanguage);

  return (
    <Dialog
      title={t('add_title')}
      onCancel={onClose}
      testId="app.add.primary"
      width="form"
      actions={
        <>
          <Button kind="secondary" onClick={onClose}>
            {translate('desktop.common.cancel', snapshot.settings.language, snapshot.settings.resolvedLanguage)}
          </Button>
          <Button
            kind="primary"
            testId="app.add.submit"
            disabled={selected === ''}
            onClick={() => onAdd(selected)}
          >
            {t('add_app')}
          </Button>
        </>
      }
    >
      <Group
        title={t('supported_tools')}
        footer={t('supported_footer')}
      >
        {available.length === 0 ? (
          <Row testId="app.add.none">
            <RowText detail={t('all_added')} />
          </Row>
        ) : (
          available.map((clientId) => (
            <Row key={clientId} testId={`app.add.option-${clientId}`}>
              {/* `DesignProviderIcon` (`AppSheets.swift:765`): the app's own
                  mark leads its name, so the list of things you can add reads as
                  a list of apps rather than a list of words. */}
              <ProviderIcon provider={clientId} size={24} className="mr-1" />
              <CheckRow
                label={titleFor(clientId)}
                detail={localizedDescription(clientId, t)}
                checked={selected === clientId}
                onChange={() => setSelected(clientId)}
                testId={`app.add.picker-${clientId}`}
              />
            </Row>
          ))
        )}
      </Group>
    </Dialog>
  );
}

function localizedDescription(clientId: string, t: (key: string) => string): string {
  const translated = t(`about_${clientId.toLowerCase()}`);
  return translated.startsWith('desktop.apps.') ? appShortDescription(clientId) : translated;
}

/** macOS names the client with its product name, not its registry id. */
function titleFor(clientId: string): string {
  switch (clientId.toLowerCase()) {
    case 'claude':
      return 'Claude Code';
    case 'zcode':
    case 'zai':
      return 'ZCode';
    case 'dsh':
      return 'DSH';
    case 'pi':
      return 'Pi';
    case 'omp':
      return 'Omp';
    case 'commandcode':
      return 'CommandCode';
    case 'codebuddy':
      return 'CodeBuddy';
    default:
      return clientId.charAt(0).toUpperCase() + clientId.slice(1);
  }
}
