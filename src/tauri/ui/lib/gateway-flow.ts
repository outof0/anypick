/**
 * `AddGatewaySheet`'s rules, ported from `src/macos/AddGatewaySheet.swift` and
 * `DesignDisplay.swift:547-665`.
 *
 * The sheet this replaces asked for a name, a key, an account id, a gateway id
 * and a URL for every provider, and disabled Save until the lot was filled in.
 * What a gateway actually needs differs per provider: one supplies its own
 * endpoint, one derives the URL from an account id, one reads a local login and
 * wants no key at all. These rules are what let the sheet ask for one of those
 * instead of all five.
 */

import type { AccountRow, GatewayProviderRow } from './contract';

export type ConnectionState = 'untested' | 'testing' | 'available' | 'unavailable';

/**
 * `providerSuppliesEndpoint`. The provider knows its own base URL.
 *
 * A field here would ask the user to type what the engine already has, and a
 * wrong answer silently points the proxy at someone else's endpoint.
 */
export function providerSuppliesEndpoint(provider: GatewayProviderRow | undefined): boolean {
  return Boolean(provider?.providesEndpoint || provider?.defaultEndpoint);
}

/**
 * `usesCustomEndpoint`. Only a provider without a base of its own asks for one.
 *
 * An account-derived provider is excluded even though it publishes no default:
 * its URL is built from the account id, so a URL field would ask the user to
 * type what the engine derives — and would reject a value the engine ignores.
 */
export function usesCustomEndpoint(provider: GatewayProviderRow | undefined): boolean {
  if (providerSuppliesEndpoint(provider)) return false;
  return !provider?.requiresAccountId;
}

/** `requiresApiKey`, with the Grok exemption: it reads `~/.grok/auth.json`. */
export function requiresApiKey(provider: GatewayProviderRow | undefined): boolean {
  if (provider?.id === 'grok') return false;
  return provider?.requiresApiKey ?? true;
}

/** The endpoint the sheet will send: the provider's own, else the typed one. */
export function resolvedEndpoint(provider: GatewayProviderRow | undefined, endpoint: string): string {
  return providerSuppliesEndpoint(provider) ? (provider?.defaultEndpoint ?? '') : endpoint;
}

/**
 * `canSave`.
 *
 * Every clause is a field the engine will reject an empty value for, so this is
 * the same set of conditions the server enforces — asking first is what keeps
 * the button from being a way to produce an error.
 */
export function gatewayCanSave(input: {
  provider: GatewayProviderRow | undefined;
  name: string;
  apiKey: string;
  accountId: string;
  endpoint: string;
  busy: boolean;
}): boolean {
  if (input.busy || !input.provider) return false;
  if (input.name.trim() === '') return false;
  if (requiresApiKey(input.provider) && input.apiKey.trim() === '') return false;
  if (input.provider.requiresAccountId && input.accountId.trim() === '') return false;
  if (usesCustomEndpoint(input.provider) && input.endpoint.trim() === '') return false;
  return true;
}

/** `gatewayConnectionTestEnabled`. What Test Connection needs before it can run. */
export function connectionTestEnabled(input: {
  provider: GatewayProviderRow | undefined;
  apiKey: string;
  accountId: string;
  busy: boolean;
}): boolean {
  if (input.busy) return false;
  if (requiresApiKey(input.provider) && input.apiKey.trim() === '') return false;
  if (input.provider?.requiresAccountId && input.accountId.trim() === '') return false;
  return true;
}

/**
 * `suggestedGatewayName`. A name that is not already taken.
 *
 * Two gateways both called "Production" is a list the user cannot read, and
 * the name is the only thing distinguishing them.
 */
export function suggestedGatewayName(
  accounts: readonly AccountRow[],
  providerLabel: string,
  custom: boolean,
): string {
  const taken = (candidate: string) =>
    accounts.some((account) => account.name.toLowerCase() === candidate.toLowerCase());
  if (!taken(custom ? providerLabel : 'Production')) return custom ? providerLabel : 'Production';
  const base = providerLabel || 'Gateway';
  let suffix = 2;
  while (taken(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}

/**
 * `connectionFooter`. One line about what Test Connection is doing, or what the
 * chosen shape means when nothing has been tested.
 */
export function connectionFooter(input: {
  state: ConnectionState;
  provider: GatewayProviderRow | undefined;
  message: string;
  endpoint: string;
  busy: boolean;
}): string {
  switch (input.state) {
    case 'testing': {
      const endpoint = resolvedEndpoint(input.provider, input.endpoint);
      return endpoint === ''
        ? `Contacting ${input.provider?.label ?? ''}…`
        : `Contacting ${endpoint}…`;
    }
    case 'available':
      return input.message || 'Connected successfully. The gateway returned a live model catalog.';
    case 'unavailable':
      return (
        input.message || 'Could not connect to the gateway. Please check the endpoint URL and API key.'
      );
    case 'untested': {
      if (input.provider?.requiresAccountId) return 'The endpoint is derived from your Account ID.';
      if (!usesCustomEndpoint(input.provider)) {
        return `${input.provider?.label ?? 'The provider'} supplies the endpoint.`;
      }
      return 'AnyPick detects the API format automatically.';
    }
  }
}

/** What the connection row's button is called in each state. */
export const TEST_LABEL: Record<ConnectionState, string> = {
  untested: 'Test Connection',
  testing: 'Test Connection',
  available: 'Test Again',
  unavailable: 'Try Again',
};

/** The label the connection state is announced under. */
export const TEST_STATE_LABEL: Record<Exclude<ConnectionState, 'untested' | 'testing'>, string> = {
  available: 'Connected',
  unavailable: 'Not Connected',
};