/**
 * Tray-local settings that are not part of the SQLite global config document.
 * Owns the `tray/login-item` mutation scope (ADR 0009).
 */
import { setTrayLaunchAtLogin, trayLaunchAtLoginEnabled } from '../tray/settings';
import { withMutationLock } from './mutation-lock';

const LOGIN_ITEM_SCOPE = 'tray/login-item';

export class TraySettingsService {
  constructor(private readonly root: string) {}

  async launchAtLoginEnabled(): Promise<boolean> {
    return trayLaunchAtLoginEnabled();
  }

  async setLaunchAtLogin(cliEntry: string, enabled: boolean): Promise<void> {
    await withMutationLock(this.root, LOGIN_ITEM_SCOPE, () =>
      setTrayLaunchAtLogin(this.root, cliEntry, enabled),
    );
  }
}
