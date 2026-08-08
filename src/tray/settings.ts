import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { unlink } from 'node:fs/promises';
import type { GlobalConfig } from '../types';
import { pathExists, writeTextFile } from '../utils/fs';
import { quotaGuardPolicy } from '../core/quota-guard-policy';

export { DEFAULT_QUOTA_GUARD_POLICY, quotaGuardPolicy } from '../core/quota-guard-policy';
export {
  launchSurface,
  updateLaunchSurface,
  updateQuotaGuardEnabled,
  updateTrayPreference,
  type LaunchSurface,
} from '../core/config-service';

export interface TrayPreferences {
  launchAtLogin: boolean;
  startEnabledProxies: boolean;
  showQuota: boolean;
  quotaGuardEnabled: boolean;
}

export function desktopTraySurfaceAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin';
}

const LAUNCH_AGENT_NAME = 'com.anypick.tray.plist';

export function trayPreferences(config: GlobalConfig, launchAtLogin = false): TrayPreferences {
  return {
    launchAtLogin,
    startEnabledProxies: config.ui?.tray?.startEnabledProxies ?? true,
    showQuota: config.ui?.tray?.showQuota ?? true,
    quotaGuardEnabled: quotaGuardPolicy(config).enabled,
  };
}

export function trayLaunchAgentPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', LAUNCH_AGENT_NAME);
}

export async function trayLaunchAtLoginEnabled(): Promise<boolean> {
  return pathExists(trayLaunchAgentPath());
}

export async function setTrayLaunchAtLogin(
  root: string,
  cliEntry: string,
  enabled: boolean,
): Promise<void> {
  const path = trayLaunchAgentPath();
  if (!enabled) {
    await unlink(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    });
    return;
  }

  const entry = resolve(cliEntry);
  const logPath = join(root, 'runtime', 'tray', 'login-item.log');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.anypick.tray</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(entry)}</string>
    <string>tray</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ANYPICK_HOME</key>
    <string>${escapeXml(root)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(dirname(entry))}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
  await writeTextFile(path, plist, 0o600);
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
