/**
 * The Add Account flow's rules, ported from
 * `src/macos/AddSavedAccountSheet.swift` and `DesignDisplay.swift:669-717`.
 *
 * A sheet that shows a field per provider is not this. macOS picks one provider
 * and one *source* — read the login already on this Mac, sign in for a new one,
 * type an API key, or paste the provider's own auth file — then the fields on
 * screen are the fields that source needs. These rules decide which.
 */

import type { AccountProviderRow, CredentialKindRow, CredentialProfileRow, LoginMethodRow } from './contract';
import { displaySafeIdentity } from './model';

export type SourceMode = 'thisMac' | 'newAccount' | 'credential' | 'paste';

export const SOURCE_LABEL: Record<SourceMode, string> = {
  thisMac: 'On This Mac',
  newAccount: 'New Account',
  credential: 'API Key',
  paste: 'Paste Auth File',
};

/**
 * `availableSourceModes`.
 *
 * The order is fixed, and it is the order of how much the app does for you:
 * read what is here, then sign in, then type, then paste. "On This Mac" is
 * always offered because a provider can expose both a browser sign-in and a
 * local store, and a key-only form would replace the current-login path for
 * someone who just wanted their existing login saved.
 */
export function availableSourceModes(provider: AccountProviderRow | undefined): SourceMode[] {
  if (!provider) return [];
  const modes: SourceMode[] = ['thisMac'];
  if (provider.loginMethods.length > 0) modes.push('newAccount');
  if ((provider.credentialKinds ?? []).length > 0) modes.push('credential');
  if (provider.acceptsAuthPaste) modes.push('paste');
  return modes;
}

/** The credential kind for the current selection, falling back to the first. */
export function selectedCredentialKind(
  provider: AccountProviderRow | undefined,
  kind: string,
): CredentialKindRow | undefined {
  const kinds = provider?.credentialKinds ?? [];
  return kinds.find((row) => row.kind === kind) ?? kinds[0];
}

/**
 * The selected profile id, corrected when it is not one this kind offers.
 *
 * Switching credential kinds leaves the previous profile id behind, and sending
 * it would name a profile the new kind has never heard of.
 */
export function selectedProfileId(
  provider: AccountProviderRow | undefined,
  kind: string,
  profile: string,
): string {
  const profiles = selectedCredentialKind(provider, kind)?.profiles ?? [];
  return profiles.some((row) => row.id === profile) ? profile : (profiles[0]?.id ?? '');
}

/**
 * The login methods that read a *local* store, keyed by source id.
 *
 * A provider may expose a browser sign-in and a different local store that can
 * be imported without opening a browser. Keeping the local store explicit is
 * what stops Gemini CLI and Antigravity being conflated for one provider.
 */
export function localLoginMethods(provider: AccountProviderRow | undefined): LoginMethodRow[] {
  return (provider?.loginMethods ?? []).filter((method) => Boolean(method.sourceId));
}

export function selectedLocalLoginMethod(
  provider: AccountProviderRow | undefined,
  sourceId: string,
): LoginMethodRow | undefined {
  const methods = localLoginMethods(provider);
  return methods.find((method) => method.sourceId?.toLowerCase() === sourceId.toLowerCase()) ?? methods[0];
}

/**
 * `accountIdentity`. Parses "Detected <identity> in <source>".
 *
 * The last " in " wins, so an identity that contains the phrase survives. The
 * engine's sentinel `the current login` becomes a phrase the user can read.
 */
export function accountIdentityFromDetection(message: string | undefined): string | undefined {
  if (!message || !message.startsWith('Detected ')) return undefined;
  const body = message.slice('Detected '.length);
  const marker = body.lastIndexOf(' in ');
  if (marker < 0) return undefined;
  const identity = body.slice(0, marker).trim();
  if (!identity) return undefined;
  if (identity === 'the current login') return 'Current login';
  return displaySafeIdentity(identity) || undefined;
}

/** `addAccountBlockerMessage`. Why the primary action is disabled, said inline. */
export function blockerMessage(input: {
  provider: AccountProviderRow | undefined;
  method: LoginMethodRow | undefined;
  isNewAccountMode: boolean;
}): string | undefined {
  const { provider, method, isNewAccountMode } = input;
  if (!provider) {
    return 'No compatible providers are installed. Sign in with a supported app, then try again.';
  }
  if (!provider.installed) {
    return provider.detail || `${provider.label} is not available on this Mac.`;
  }
  if (isNewAccountMode && method && !method.available) {
    if (method.unavailableReason) return method.unavailableReason;
    return method.detail || `${method.label} is not available.`;
  }
  return undefined;
}

/** `addSavedAccountCanSubmit`. */
export function savedAccountCanSubmit(input: {
  name: string;
  isNewAccountMode: boolean;
  hasIdentity: boolean;
  hasLiveLogin: boolean;
  methodAvailable: boolean;
  providerInstalled: boolean;
  blocked: boolean;
}): boolean {
  if (input.blocked) return false;
  const named = input.name.trim() !== '';
  if (input.isNewAccountMode && !input.hasIdentity) {
    return named && input.methodAvailable && input.providerInstalled;
  }
  return named && (input.hasIdentity || input.hasLiveLogin) && input.providerInstalled;
}

/** `addCredentialInputCanSubmit`. */
export function credentialInputCanSubmit(input: {
  name: string;
  secret: string;
  providerInstalled: boolean;
  blocked: boolean;
  /** Cloudflare routes by account and gateway, so both are required. */
  routingComplete: boolean;
  /** A local model server needs no key; the engine still checks. */
  secretOptional?: boolean;
}): boolean {
  if (input.blocked || !input.providerInstalled) return false;
  if (!input.routingComplete) return false;
  if (input.name.trim() === '') return false;
  return input.secretOptional === true || input.secret.trim() !== '';
}

/**
 * `isCloudflareProvider` again, under the name the sheet reads better with.
 *
 * The routing pair is a credential-profile field the engine parses, not two
 * gateway fields: a Cloudflare account is saved as one provider account whose
 * base URL embeds the account id.
 */
export function needsCloudflareRouting(provider: AccountProviderRow | undefined): boolean {
  return isCloudflareProvider(provider);
}

/** `sourceFooterText`. One line saying what the chosen source will do. */
export function sourceFooter(mode: SourceMode, providerLabel: string): string {
  switch (mode) {
    case 'thisMac':
      return `Reads the ${providerLabel} login already on this Mac. It does not change it.`;
    case 'newAccount':
      return `Signs in to ${providerLabel} in a browser, then saves the login this Mac will use.`;
    case 'credential':
      return 'Stores the key with AnyPick. The provider keeps its own copy too.';
    case 'paste':
      return "Reads the provider's own auth file. This does not change the login already on this Mac.";
  }
}

/**
 * `primaryTitle`. What the button will do, which is not always "Add Login".
 *
 * A button that says Add Login while it starts a browser sign-in, or names
 * the exact account it will replace, is the difference between a form and a
 * flow.
 */
export function primaryTitle(input: {
  mode: SourceMode;
  providerLabel: string;
  accountName: string;
  isNewAccount: boolean;
  hasIdentity: boolean;
  blocked: boolean;
  /** True only after an `ACCOUNT_EXISTS` refusal, not merely a typed name. */
  replacing?: boolean;
}): string {
  if (input.blocked) return 'Checking';
  // Replace is a consequence of the engine having refused with a collision, so
  // it is driven by that and not by whether the user typed a name: a named
  // first attempt of a paste is still an Add, and naming it "Replace" would
  // promise to overwrite an account the engine has not yet collided with.
  if (input.mode === 'paste' && input.replacing) {
    const typed = input.accountName.trim();
    return typed === '' ? 'Replace Account' : `Replace ${typed}`;
  }
  if (input.mode === 'newAccount' && !input.hasIdentity) {
    return `Sign In with ${input.providerLabel}`;
  }
  return 'Add Login';
}

/** Whether this provider exposes more than one local store to read. */
export function showsLocalSourcePicker(provider: AccountProviderRow | undefined): boolean {
  return localLoginMethods(provider).length > 1;
}

/** The name the sheet uses for "the app whose login we read". */
export function sourceAppName(input: {
  provider: AccountProviderRow | undefined;
  localMethod: LoginMethodRow | undefined;
}): string {
  return input.localMethod?.sourceLabel ?? input.localMethod?.label ?? input.provider?.label ?? 'the app';
}

/**
 * `identityTitle`. The identity card's title.
 *
 * A card that says "Current login" while the engine is still looking tells the
 * user nothing; the app being read is the fact worth naming while it works.
 */
export function identityTitle(input: {
  identity: string;
  appName: string;
  isChecking: boolean;
  isNewAccountMode: boolean;
}): string {
  if (input.isChecking) return `Checking ${input.appName}`;
  if (input.identity) return input.identity;
  if (input.isNewAccountMode) return input.appName;
  return 'No login on this Mac';
}

/**
 * `identityDetail`.
 *
 * "<app> on this Mac" is the distinction the whole On This Mac source rests on:
 * the login is read from disk and nothing about it changes.
 */
export function identityDetail(input: {
  identity: string;
  detectedSource: string;
  appName: string;
  isChecking: boolean;
  isNewAccountMode: boolean;
  providerLabel: string;
  isCommunityFlow: boolean;
  zcodeAppInstalled: boolean;
}): string {
  if (input.isChecking) return 'This usually takes a few seconds.';
  if (input.identity) {
    const source = input.detectedSource || input.appName;
    return input.isNewAccountMode ? source : `${source} on this Mac`;
  }
  if (input.isNewAccountMode) {
    return input.isCommunityFlow
      ? `Opens ${input.providerLabel}’s community-supported browser flow`
      : `Opens ${input.providerLabel}’s official browser flow`;
  }
  if (input.zcodeAppInstalled) {
    return 'ZCode login was not detected — try New Account to sign in in the browser';
  }
  return input.appName;
}

/** `checkAgainHelp`. What the Check Again button will actually do. */
export function checkAgainHelp(input: {
  appName: string;
  isNewAccountMode: boolean;
  hasIdentity: boolean;
  providerLabel: string;
  isCommunityFlow: boolean;
}): string {
  if (input.isNewAccountMode && !input.hasIdentity) {
    return input.isCommunityFlow
      ? `Opens ${input.providerLabel}’s community-supported browser flow`
      : `Opens ${input.providerLabel}’s official browser flow`;
  }
  return `Checks the ${input.appName} account currently active on this Mac.`;
}

/** `sourceFooter` for the modes that are not about reading a local store. */
export function sourceFooterFor(input: {
  mode: SourceMode;
  providerLabel: string;
  appName: string;
  isChecking: boolean;
  isNewAccountMode: boolean;
  hasIdentity: boolean;
}): string {
  if (input.mode === 'paste') {
    return "Paste the provider's own auth file. AnyPick saves it as an account and leaves the login on this Mac unchanged.";
  }
  if (input.isChecking || (input.isNewAccountMode && !input.hasIdentity)) {
    return 'AnyPick saves the account when the browser flow finishes.';
  }
  if (input.mode === 'credential') {
    return 'AnyPick stores this key with the account. The provider keeps its own copy too.';
  }
  if (input.mode === 'thisMac') {
    return `This reads the local ${input.appName} login on this Mac. It does not read the account currently open in your browser.`;
  }
  return 'AnyPick saves this account so you can switch back anytime.';
}

/** `isCloudflareProvider`. The id is the engine's, not the label's. */
export function isCloudflareProvider(provider: AccountProviderRow | undefined): boolean {
  return provider?.id.toLowerCase() === 'cloudflare-aigateway';
}

export function isZaiProvider(provider: AccountProviderRow | undefined): boolean {
  return provider?.id.toLowerCase() === 'zai';
}

/**
 * `isCommunityFlow`. A browser flow the provider does not own.
 *
 * The two flows are not interchangeable and the sheet has to say which one it
 * is about to open: an unofficial flow asks the user to trust a third party.
 */
export function isCommunityFlow(method: LoginMethodRow | undefined): boolean {
  return method?.provenance === 'community';
}

/**
 * `zcodeAppInstalled`.
 *
 * The webview cannot stat the user's home directory, so the Tauri shell answers
 * this (`zcode_context`). A provider that is not Z.ai has no ZCode app to look
 * for, and an answer that never arrived must not be read as "not installed" —
 * the two states say different things to a first-timer.
 */
export function zcodeAppInstalled(input: {
  provider: AccountProviderRow | undefined;
  context: ZcodeContext | undefined;
}): boolean {
  if (!isZaiProvider(input.provider)) return false;
  return input.context?.appInstalled ?? false;
}

/**
 * The routing pair, typed as one field and sent as the credential profile.
 *
 * The gateway base URL embeds the Cloudflare account id, so no fixed profile
 * preset can name it — one string is the only thing the sheet can send. The
 * engine parses it back; a malformed pair stays engine-owned and surfaces
 * through the save result rather than being rejected here.
 */
export function cloudflareRoutingProfile(routing: string): string {
  const [account = '', gateway = ''] = routing.split('/');
  return `${account.trim()}/${gateway.trim() || 'default'}`;
}

/**
 * Whether the typed routing pair names an account.
 *
 * An empty gateway is fine — `default` works without setup — but an empty
 * account cannot route, so that alone disables submit.
 */
export function cloudflareRoutingComplete(routing: string): boolean {
  const [account = ''] = routing.split('/');
  return account.trim() !== '';
}

/**
 * `zcodeCodingPlanWarning`. The ZCode app's world-readable plan-status cache.
 *
 * Only plan-status context: the provider separately reads the encrypted ZCode
 * login and offers the official browser fallback. This never blocks the sheet —
 * it explains why a key might not work.
 */
export function zcodeCodingPlanWarning(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(json)) return undefined;
  const entryStatus = json.entryStatus;
  if (!isRecord(entryStatus)) return undefined;
  const items = entryStatus.items;
  if (!isRecord(items)) return undefined;
  const values = Object.values(items);
  if (values.length === 0) return undefined;
  const connected = values.some((item) => {
    if (!isRecord(item)) return false;
    const status = item.status;
    return typeof status === 'string' && status !== '' && status !== 'unavailable';
  });
  return connected
    ? undefined
    : 'The ZCode app reports no connected coding plan. You can still use the ZCode login on this Mac, sign in again with Z.ai, or paste a GLM Coding Plan key from the Z.ai dashboard (API Keys).';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the Tauri shell reports about the ZCode app. */
export type ZcodeContext = {
  appInstalled: boolean;
  /** Set when the app's plan cache reports no connected plan. */
  planWarning?: string;
};

/**
 * `zcodeHint`. What to say under the key field for the Z.ai provider.
 *
 * A stale plan cache is a warning, not a block, so it and the generic advice
 * are alternatives rather than two paragraphs.
 */
export function zcodeHint(planWarning: string | undefined): string {
  return planWarning ?? 'Use On This Mac to read the ZCode login, or choose New Account to sign in with Z.ai in the browser.';
}

/** `CLOUDFLARE_HINT`. How to find the two halves of the routing pair. */
export const CLOUDFLARE_HINT =
  'Find the account ID with wrangler whoami. The gateway is the AI Gateway name — default works without setup.';

/** The destructive sign-out confirmation, said before the engine runs. */
export const SIGN_OUT_MESSAGE =
  'AnyPick backs up this account before signing out on this Mac. Remote sessions stay active.';

/**
 * `loginFailureMessage`. The engine's own text, or a sentence that says what to
 * try, never a raw code.
 */
export function loginFailureMessage(message: string | undefined): string {
  const trimmed = (message ?? '').trim();
  return trimmed || 'The provider returned an unreadable response. Try again.';
}

/**
 * Whether a failed sign-in should offer the paths back.
 *
 * macOS offers "Use Account on This Mac" only when a live login exists to fall
 * back to, and "Use API Key" only when the provider takes a typed key. Offering
 * a fallback that cannot work is worse than offering none.
 */
export function loginFallbacks(input: {
  isNewAccountMode: boolean;
  hasLiveLogin: boolean;
  hasCredentialKinds: boolean;
}): { currentLogin: boolean; credential: boolean } {
  return {
    currentLogin: input.isNewAccountMode && input.hasLiveLogin,
    credential: input.isNewAccountMode && input.hasCredentialKinds,
  };
}

export type { CredentialProfileRow };