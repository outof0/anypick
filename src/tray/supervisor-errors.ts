import { isAnyPickError } from '../utils/errors';
import type { TrayMutationCommand } from './protocol';
import type { TrayProxyActionTarget } from './snapshot-types';

export function displayIdentifier(value: string): string {
  return value
    .split(/[-_]/gu)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function trayMutationError(err: unknown, payload?: Partial<TrayMutationCommand>): string {
  const source = displayIdentifier(payload?.sourceId ?? payload?.providerId ?? 'selected app');
  if (isAnyPickError(err)) {
    switch (err.code) {
      case 'NO_LIVE_AUTH':
        return `No signed-in account was found in ${source}. Open ${source}, sign in, then click Detect login again.`;
      case 'ACCOUNT_IDENTITY_EXISTS':
        return 'That login is already saved. Use the existing account, or overwrite it from Manage.';
      case 'ACCOUNT_EXISTS':
      case 'PROFILE_EXISTS':
        return 'That name is already in use. Choose another name, or edit the existing item.';
      case 'CREDENTIAL_KIND_MISMATCH':
        return 'That saved item uses a different credential type. Choose another name.';
      case 'RESTORE_OWNER_RUNNING':
        return `Quit ${source} completely, then try again. Your saved account was not changed.`;
      case 'REFRESH_UNSUPPORTED':
        return 'This provider cannot refresh a saved login. Sign in with its official app and save it again.';
      case 'REFRESH_FAILED':
      case 'AUTH_REQUIRED':
        return `The saved login could not be refreshed. Sign in to ${source} again, then save the current login.`;
      case 'ACCOUNT_NOT_FOUND':
      case 'GATEWAY_NOT_FOUND':
      case 'RESOURCE_NOT_FOUND':
        return 'That item no longer exists. Refresh Manage and try again.';
      case 'UNSUPPORTED_CREDENTIAL_INPUT':
        return 'This provider does not accept that credential type.';
      default:
        break;
    }
  }

  switch (payload?.operation) {
    case 'account-detect':
      return `AnyPick could not read the login from ${source}. Make sure the official app is installed and signed in.`;
    case 'account-save':
    case 'account-edit':
    case 'account-refresh':
      return 'AnyPick could not save that account. Nothing was changed; check the official app login and try again.';
    case 'account-remove':
      return 'AnyPick could not remove that account. It is still saved; refresh Manage and try again.';
    case 'account-clear':
      return `AnyPick could not clear the live login from ${source}. The local app auth was left unchanged.`;
    case 'gateway-create':
    case 'gateway-edit':
    case 'gateway-refresh':
      return 'AnyPick could not update that gateway. Check its URL, API key, and model, then try again.';
    case 'gateway-remove':
      return 'AnyPick could not remove that gateway. It is still saved; refresh Manage and try again.';
    case 'client-reset':
      return 'AnyPick could not reset that client. Its previous route and configuration were kept.';
    case 'hub-source-toggle':
      return 'AnyPick could not update that Proxy Hub source. Its previous state was kept.';
    case 'proxy-restart-all':
    case 'proxy-stop-all':
      return 'AnyPick could not update the proxies. Open Proxy and check the inline logs.';
    case 'setting-launch-at-login':
    case 'setting-auto-start-proxies':
    case 'setting-show-quota':
    case 'setting-quota-guard':
      return 'AnyPick could not update that setting. Your previous setting is still active.';
    default:
      return 'AnyPick could not complete that change. Nothing was changed.';
  }
}

export function trayProxyActionError(
  err: unknown,
  operation?: TrayProxyActionTarget['operation'],
): string {
  if (isAnyPickError(err)) {
    switch (err.code) {
      case 'PROXY_PORT_BUSY':
        return 'That proxy port is already in use. Stop the conflicting process and retry.';
      case 'PROXY_UNSUPPORTED':
        return 'This provider does not support a compatibility proxy.';
      case 'PROXY_DISABLED':
        return 'Proxy Hub is disabled. Enable a model account, then retry.';
      case 'STATE_CONFLICT': {
        if (operation === 'hub-own-models') {
          return 'That overlap changed. Refresh Routing Issues and choose the account again.';
        }
        if (operation === 'hub-test') {
          return 'Hub check found an unavailable account or unresolved routes. Review Routing Issues, then retry.';
        }
        return 'Proxy Hub needs an enabled model account. Open Model Accounts, then retry.';
      }
      case 'ACCOUNT_NOT_FOUND':
      case 'RESOURCE_NOT_FOUND':
        return 'That proxy account is no longer available. Refresh AnyPick.';
      case 'PROXY_BINARY_MISSING':
      case 'MISSING_DEPENDENCY':
        return 'The Kiro proxy (kirolink) is not installed or is not on the tray’s PATH. Install it, then retry.';
      default:
        return 'Proxy action failed. Check its inline logs for details.';
    }
  }
  return 'Proxy action failed. Check its inline logs for details.';
}

export function trayModelRolesError(err: unknown): string {
  if (isAnyPickError(err)) {
    if (err.code === 'STATE_CONFLICT') {
      return 'Those model choices are stale or use different connections. Reopen Claude models and choose again.';
    }
    if (err.code === 'MODEL_UNKNOWN') {
      return 'One selected model is no longer available. Refresh the model list and choose again.';
    }
  }
  const activationMessage = trayActionError(err);
  return activationMessage.startsWith('Account switch failed')
    ? 'Claude model settings could not be applied. The previous mapping was kept.'
    : activationMessage;
}

/** Keep tray output useful without allowing secret-bearing error text to cross it. */
export function trayActionError(err: unknown): string {
  if (isAnyPickError(err)) {
    switch (err.code) {
      case 'RESTORE_OWNER_RUNNING':
        return 'The target app is running. Quit it completely, then try again.';
      case 'MODEL_UNKNOWN':
        return 'Choose a model in AnyPick before switching this gateway.';
      case 'ACCOUNT_NOT_FOUND':
      case 'GATEWAY_NOT_FOUND':
      case 'PRESET_NOT_FOUND':
      case 'RESOURCE_NOT_FOUND':
        return 'That account or gateway is no longer available. Refresh AnyPick.';
      case 'PROXY_BINARY_MISSING':
      case 'MISSING_DEPENDENCY':
        return 'This route needs the Kiro proxy (kirolink), which is not installed or not on the tray’s PATH. Install it, then retry.';
      case 'PROXY_START_FAILED':
        // Hub attach surfaces "sources are not ready: …" — keep that detail so
        // a stale Hub source is diagnosable without digging into Activity.
        return err.message.startsWith('Proxy Hub')
          ? err.message
          : 'The local proxy failed to start. Open Proxy and check its logs.';
      case 'STATE_CONFLICT':
        return err.message.startsWith('Proxy Hub')
          ? err.message
          : 'Account switch failed. Check Activity for details.';
      default:
        return 'Account switch failed. Check Activity for details.';
    }
  }
  return 'Account switch failed. Check Activity for details.';
}
