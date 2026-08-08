import type { HotplugApp } from '../../core/app';
import { normalizeProfileName } from '../../utils/slug';
import type { TextInputScreen } from '../model/screen';
import type { TuiShell } from '../use-tui-shell';
import type { TuiNav } from '../use-tui-nav';
import type { AccountActions } from './use-account-actions';

/**
 * What each text-entry purpose does with the value the user typed.
 *
 * One screen kind serves every purpose across three domains (accounts,
 * gateways, files), so the dispatch lives here rather than in the renderer or
 * in any one domain hook — every alternative would put a gateway step inside
 * the account flow or vice versa.
 */
export type TextInputSubmit = (screen: TextInputScreen, value: string) => Promise<void>;

export function useTextInputSubmit(
  app: HotplugApp,
  shell: TuiShell,
  nav: TuiNav,
  accounts: AccountActions,
): TextInputSubmit {
  const { go, withBusy, setError, setReceipt, reportOk, reportFail } = shell;
  const { openAccounts, openGateways } = nav;

  return async (screen, value) => {
    if (screen.purpose === 'gateway-name' && screen.gatewayDraft) {
      let name: string;
      try {
        name = normalizeProfileName(value);
      } catch {
        setError('Name needs at least one letter or number.');
        return;
      }
      go({
        kind: 'gateway-connection',
        providerId: screen.gatewayDraft.providerId,
        providerName: screen.gatewayDraft.providerName,
        name,
        endpoint: screen.gatewayDraft.defaultEndpoint,
        back: screen,
      });
      return;
    }

    if (screen.purpose === 'gateway-edit-endpoint' && screen.accountName) {
      const gateway = screen.accountName;
      await withBusy(`Updating ${gateway}`, async () => {
        try {
          await app.profiles.edit(gateway, { endpoint: value });
          reportOk(`Endpoint updated for ${gateway}`);
          await openGateways(gateway);
        } catch (err) {
          reportFail(err);
        }
      });
      return;
    }

    if (screen.purpose === 'save-name' && screen.providerId) {
      await accounts.doSave(screen.providerId, value, { source: screen.source });
      return;
    }

    if (screen.purpose === 'export-path' && screen.providerId && screen.accountName) {
      const { providerId, accountName } = screen;
      const ref = `${providerId}/${accountName}`;
      await withBusy(`Exporting ${ref}`, async () => {
        try {
          await app.accounts.exportAccount(providerId, accountName, value);
          setReceipt({
            title: '',
            lines: [
              { kind: 'ok', text: `Exported ${ref}` },
              { kind: 'warn', text: 'The exported file contains login secrets.' },
            ],
          });
          await openAccounts(ref);
        } catch (err) {
          reportFail(err);
          go(screen.back);
        }
      });
      return;
    }

    if (screen.purpose === 'import-name' && screen.providerId) {
      go({
        kind: 'text-input',
        purpose: 'import-path',
        providerId: screen.providerId,
        accountName: value,
        label: 'Import file',
        hint: 'This file should be a Hotplug login export.',
        back: screen.back,
      });
      return;
    }

    if (screen.purpose === 'import-path' && screen.providerId && screen.accountName) {
      const { providerId, accountName } = screen;
      await withBusy(`Importing ${providerId}/${accountName}`, async () => {
        try {
          const meta = await app.accounts.importAccount(providerId, accountName, value, {
            force: true,
          });
          reportOk(`Imported ${providerId}/${meta.name}`);
          await openAccounts(`${providerId}/${meta.name}`);
        } catch (err) {
          reportFail(err);
          go(screen.back);
        }
      });
    }
  };
}
