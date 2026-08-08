import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AnyPickApp } from '../core/app';
import { serializeRef } from '../core/refs';
import { AnyPickError } from '../utils/errors';
import type { TrayActivityService } from './activity';
import type { TrayMutationCommand } from './protocol';
import { activityKindForMutation, recordTrayActivity } from './supervisor-activity';
import { displayIdentifier, trayMutationError } from './supervisor-errors';
import type { TrayCommandResult } from './supervisor-native';
import { sendResult } from './supervisor-native';
import { startEnabledProxies, stopAllProxies } from './supervisor-proxies';

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

/**
 * Source selection is the Accounts-screen configuration action. The Hub
 * becomes available with the first source, while actual process startup stays
 * lazy until a client selects one of its models.
 */
export async function setTrayHubSourceEnabled(
  app: Pick<AnyPickApp, 'hub'>,
  providerId: string,
  accountName: string,
  enabled: boolean,
): Promise<void> {
  const ref = { kind: 'account' as const, provider: providerId, name: accountName };
  const sourceId = serializeRef(ref);
  const hub = await app.hub.get();
  const sources = hub.sources.some((source) => serializeRef(source.ref) === sourceId)
    ? hub.sources.map((source) =>
        serializeRef(source.ref) === sourceId ? { ...source, enabled } : source,
      )
    : [...hub.sources, { ref, enabled }];
  const hasEnabledSource = sources.some((source) => source.enabled);
  await app.hub.save({ ...hub, enabled: hasEnabledSource, sources });
  if (!hasEnabledSource) {
    await app.hub.stop(hub.name);
  }
}

/** Read-only login probe used before the tray allows a snapshot to be saved. */
export async function detectTrayAccount(
  app: Pick<AnyPickApp, 'accountRegistry'>,
  providerId: string,
  sourceId?: string,
): Promise<string> {
  const provider = app.accountRegistry.get(providerId);
  const source = cleanOptional(sourceId);
  const live =
    source && provider.detectLiveSource
      ? await provider.detectLiveSource(source)
      : await provider.detectLive();
  if (!live.present) {
    throw new AnyPickError(`No live ${provider.name} login was found.`, 'NO_LIVE_AUTH');
  }
  const location = source ? displayIdentifier(source) : provider.name;
  return live.identity
    ? `Detected ${live.identity} in ${location}.`
    : `Detected the current login in ${location}.`;
}

export async function invokeTrayMutation(
  app: AnyPickApp,
  native: ChildProcessWithoutNullStreams,
  payload: TrayMutationCommand,
  cliEntry: string,
  activity: TrayActivityService,
  refresh: () => Promise<void>,
  invalidateUsage: () => void,
): Promise<void> {
  const respond = (result: Omit<TrayCommandResult, 'version' | 'requestId'>) => {
    sendResult(native, { version: 1, requestId: payload.requestId, ...result });
  };

  try {
    let message: string;
    switch (payload.operation) {
      case 'account-detect': {
        message = await detectTrayAccount(app, payload.providerId!, payload.sourceId);
        break;
      }
      case 'account-save': {
        const providerId = payload.providerId!;
        app.accountRegistry.get(providerId);
        const apiKey = cleanOptional(payload.apiKey);
        const region = cleanOptional(payload.region);
        // A typed api-key (Kiro) saves as a proxy-only account via the credential
        // input path; the provider validates the key and region and throws on a
        // bad one. Otherwise this is a live-login capture.
        const saved = await app.accounts.save(providerId, payload.name, {
          label: cleanOptional(payload.label),
          force: payload.overwrite === true,
          ...(apiKey
            ? {
                input: {
                  kind: 'api-key',
                  secret: apiKey,
                  ...(region ? { options: { region } } : {}),
                },
              }
            : { source: cleanOptional(payload.sourceId) }),
        });
        message = `Saved ${saved.label ?? saved.name}.`;
        invalidateUsage();
        break;
      }
      case 'account-edit': {
        const providerId = payload.providerId!;
        const edited = await app.accounts.edit(providerId, payload.name, {
          label: payload.label === undefined ? undefined : payload.label.trim() || null,
        });
        message = `Updated ${edited.label ?? edited.name}.`;
        break;
      }
      case 'account-refresh': {
        const providerId = payload.providerId!;
        const results = await app.accounts.refresh(providerId, payload.name);
        const failed = results.filter((result) => !result.ok);
        if (failed.length > 0) {
          throw new AnyPickError(failed[0].error ?? 'Account refresh failed.', 'REFRESH_FAILED');
        }
        message = `Refreshed ${providerId}/${payload.name}.`;
        invalidateUsage();
        break;
      }
      case 'account-remove': {
        const providerId = payload.providerId!;
        app.accountRegistry.get(providerId);
        await app.accounts.delete(providerId, payload.name);
        message = `Removed ${providerId}/${payload.name}.`;
        invalidateUsage();
        break;
      }
      case 'account-clear': {
        // Stash: auto-backup the live login when present, then wipe local auth
        // only — no remote logout/revoke. Matches TUI "Add another login".
        const providerId = payload.providerId!;
        app.accountRegistry.get(providerId);
        const source = cleanOptional(payload.sourceId);
        const result = await app.accounts.stash(providerId, {
          ...(source === 'antigravity' || source === 'gemini-cli' ? { source } : {}),
        });
        const where = source ? displayIdentifier(source) : providerId;
        if (result.backedUpTo) {
          message = result.matchedByIdentity
            ? `Saved live ${where} login into ${result.backedUpTo} and cleared local auth.`
            : `Backed up live ${where} login as ${result.backedUpTo} and cleared local auth.`;
        } else if (result.cleared) {
          message = `Cleared the live ${where} login. Sign in with another account in the official app, then Detect.`;
        } else {
          message = `No live ${where} login to clear.`;
        }
        invalidateUsage();
        break;
      }
      case 'gateway-create': {
        const providerId = payload.providerId!;
        app.catalog.get(providerId);
        const profile = await app.profiles.create(payload.name, {
          provider: providerId,
          endpoint: cleanOptional(payload.endpoint),
          apiKey: cleanOptional(payload.apiKey),
          defaultModel: cleanOptional(payload.defaultModel),
          label: cleanOptional(payload.label),
        });
        message = `Created ${profile.meta.label ?? profile.meta.name}.`;
        break;
      }
      case 'gateway-edit': {
        const profile = await app.profiles.edit(payload.name, {
          endpoint: cleanOptional(payload.endpoint),
          ...(payload.apiKey !== undefined && payload.apiKey.trim()
            ? { apiKey: payload.apiKey }
            : {}),
          defaultModel: cleanOptional(payload.defaultModel),
          label: cleanOptional(payload.label),
        });
        message = `Updated ${profile.meta.label ?? profile.meta.name}.`;
        break;
      }
      case 'gateway-refresh': {
        const profile = await app.profiles.get(payload.name);
        const result = await app.modelDiscovery.list({
          providerId: profile.meta.provider,
          endpoint: profile.meta.endpoint,
          apiKey: profile.secrets.apiKey,
          refresh: true,
        });
        message = `Refreshed ${payload.name}: ${result.models.length} models.`;
        break;
      }
      case 'gateway-remove': {
        await app.profiles.delete(payload.name);
        message = `Removed gateway ${payload.name}.`;
        invalidateUsage();
        break;
      }
      case 'client-reset': {
        const clientId = payload.name;
        if (!app.clients.has(clientId)) {
          throw new AnyPickError(`Unknown client "${clientId}".`, {
            code: 'INVALID_USAGE',
          });
        }
        const client = app.clients.get(clientId);
        // BindingService owns the client/* coordinator lock (ADR 0009).
        await app.bindingService.reset(clientId);
        message = `Reset AnyPick overrides for ${
          client.shortName ?? client.name
        }. Your native login was kept.`;
        break;
      }
      case 'hub-source-toggle': {
        const providerId = payload.providerId!;
        await setTrayHubSourceEnabled(app, providerId, payload.name, payload.enabled === true);
        message = `${payload.enabled ? 'Included' : 'Removed'} ${providerId}/${payload.name} ${
          payload.enabled ? 'in' : 'from'
        } Proxy Hub.`;
        break;
      }
      case 'proxy-restart-all': {
        await stopAllProxies(app);
        await startEnabledProxies(app);
        message = 'Restarted enabled proxies.';
        break;
      }
      case 'proxy-stop-all': {
        await stopAllProxies(app);
        message = 'Stopped all proxies.';
        break;
      }
      case 'setting-launch-at-login': {
        await app.traySettings.setLaunchAtLogin(cliEntry, payload.enabled === true);
        message = payload.enabled ? 'AnyPick will open at login.' : 'Launch at login disabled.';
        break;
      }
      case 'setting-auto-start-proxies': {
        await app.config.setTrayPreference('startEnabledProxies', payload.enabled === true);
        if (payload.enabled) {
          await startEnabledProxies(app);
        }
        message = payload.enabled
          ? 'Enabled proxies will start with AnyPick.'
          : 'Proxy auto-start disabled.';
        break;
      }
      case 'setting-show-quota': {
        await app.config.setTrayPreference('showQuota', payload.enabled === true);
        invalidateUsage();
        message = payload.enabled ? 'Quota is visible.' : 'Quota is hidden.';
        break;
      }
      case 'setting-quota-guard': {
        await app.config.setQuotaGuardEnabled(payload.enabled === true);
        await app.proxy.restartRunningPools();
        message = payload.enabled
          ? 'Quota Guard enabled for multi-account compatibility proxy pools.'
          : 'Quota Guard disabled. Native app logins were not changed.';
        break;
      }
      default: {
        const exhaustive: never = payload.operation;
        return exhaustive;
      }
    }
    if (payload.operation !== 'account-detect') {
      await recordTrayActivity(
        activity,
        message,
        false,
        activityKindForMutation(payload.operation),
      );
    }
    await refresh();
    respond({ status: 'success', message });
  } catch (err) {
    const message = trayMutationError(err, payload);
    process.stderr.write(`[tray] ${message}\n`);
    await recordTrayActivity(activity, message, true, activityKindForMutation(payload.operation));
    await refresh().catch(() => {});
    respond({ status: 'error', message });
  }
}
