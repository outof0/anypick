import { useEffect, useState } from 'react';

import type { Preferences } from '../lib/contract';
import { translate } from '../lib/i18n';
import {
  SETTING_ROWS,
  languageChange,
  settingChange,
} from '../lib/desktop-actions';
import type { ServicePort } from '../lib/service';
import { Button, Group, Pane, Row, RowActions, RowText, Select, Switch } from '../ui/primitives';

/**
 * App-wide preferences as one regular content pane. Settings is a UI route in
 * the app shell, not an engine destination, so the data protocol remains
 * limited to the seven engine-backed views.
 */
export function SettingsPane({
  settings,
  service,
  busy = false,
  onShowGettingStarted,
}: {
  settings: Preferences;
  service: ServicePort;
  busy?: boolean;
  onShowGettingStarted: () => void;
}) {
  const [pending, setPending] = useState<Partial<Record<(typeof SETTING_ROWS)[number]['key'], boolean>>>({});
  const [pendingLanguage, setPendingLanguage] = useState<string | null>(null);
  const language = pendingLanguage ?? settings.language ?? 'auto';
  const t = (key: string) => translate(key, language, settings.resolvedLanguage ?? 'en');
  const settingLabels: Record<(typeof SETTING_ROWS)[number]['key'], string> = {
    launchAtLogin: 'desktop.settings.open_at_login',
    startEnabledProxies: 'desktop.settings.start_enabled_proxies',
    showQuota: 'desktop.settings.show_usage',
    quotaGuardEnabled: 'desktop.settings.quota_guard',
  };
  const settingDetails: Record<(typeof SETTING_ROWS)[number]['key'], string> = {
    launchAtLogin: 'desktop.settings.open_at_login_help',
    startEnabledProxies: 'desktop.settings.start_enabled_proxies_help',
    showQuota: 'desktop.settings.show_usage_help',
    quotaGuardEnabled: 'desktop.settings.quota_guard_help',
  };
  // A failed change does not publish a new snapshot. Dropping the optimistic
  // value when the request finishes puts the switch back on the last truth.
  useEffect(() => {
    if (!busy) {
      setPending({});
      setPendingLanguage(null);
    }
  }, [busy, settings]);

  const toggle = (row: (typeof SETTING_ROWS)[number]) => (enabled: boolean) => {
    setPending((current) => ({ ...current, [row.key]: enabled }));
    const action = settingChange(row.operation, enabled);
    service.mutate(action.operation, action.extra);
  };

  const startup = SETTING_ROWS.filter((row) => row.key === 'launchAtLogin' || row.key === 'startEnabledProxies');
  const usage = SETTING_ROWS.filter((row) => row.key === 'showQuota' || row.key === 'quotaGuardEnabled');

  return (
    <Pane title={t('desktop.nav.settings')} testId="settings-pane">
      <Group title={t('desktop.settings.startup')} testId="settings-startup">
        {startup.map((row) => (
          <Row key={row.operation} testId={`setting-${row.key}`}>
            <RowText
              title={t(settingLabels[row.key])}
              detail={t(settingDetails[row.key])}
            />
            <RowActions>
              <Switch
                label={t(settingLabels[row.key])}
                checked={pending[row.key] ?? settings[row.key]}
                disabled={busy}
                onChange={toggle(row)}
              />
            </RowActions>
          </Row>
        ))}
      </Group>

      <Group
        title={t('desktop.settings.usage')}
        testId="settings-usage"
      >
        {usage.map((row) => (
          <Row key={row.operation} testId={`setting-${row.key}`}>
            <RowText
              title={t(settingLabels[row.key])}
              detail={t(settingDetails[row.key])}
            />
            <RowActions>
              <Switch
                label={t(settingLabels[row.key])}
                checked={pending[row.key] ?? settings[row.key]}
                disabled={busy}
                onChange={toggle(row)}
              />
            </RowActions>
          </Row>
        ))}
      </Group>

      <Group title={t('desktop.settings.language')}>
        <Row>
          <RowText
            title={t('desktop.settings.language')}
            detail={t('desktop.settings.language_detail')}
          />
          <RowActions>
            <Select
              label=""
              ariaLabel={t('desktop.settings.language')}
              value={language}
              options={settings.languageOptions.map((option) => ({
                ...option,
                label: option.value === 'auto' ? t('desktop.language.auto') : option.label,
              }))}
              disabled={busy}
              testId="settings.language"
              onChange={(language) => {
                setPendingLanguage(language);
                const action = languageChange(language);
                service.mutate(action.operation, action.extra);
              }}
            />
          </RowActions>
        </Row>
      </Group>

      <Group title={t('desktop.settings.getting_started')} testId="settings-getting-started">
        <Row>
          <RowText
            title={t('desktop.settings.setup_checklist')}
            detail={t('desktop.settings.setup_checklist_help')}
          />
          <RowActions>
            <Button testId="settings.show-getting-started" onClick={onShowGettingStarted}>
              {t('desktop.settings.show_checklist')}
            </Button>
          </RowActions>
        </Row>
      </Group>
    </Pane>
  );
}
