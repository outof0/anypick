import { describe, expect, it } from 'vitest';

import type { AccountProviderRow, LoginMethodRow } from '../lib/contract';
import {
  SOURCE_LABEL,
  accountIdentityFromDetection,
  availableSourceModes,
  blockerMessage,
  credentialInputCanSubmit,
  localLoginMethods,
  needsCloudflareRouting,
  primaryTitle,
  savedAccountCanSubmit,
  selectedCredentialKind,
  selectedLocalLoginMethod,
  selectedProfileId,
  checkAgainHelp,
  identityDetail,
  identityTitle,
  showsLocalSourcePicker,
  sourceFooterFor,
} from '../lib/account-flow';

/**
 * The Add Account flow's rules, tested without a webview.
 *
 * The sheet this replaces rendered a field dump per provider: a Save button, a
 * Detect button, a secret box, a kind picker and a name field, all at once, for
 * every provider, on one scroll. The primary button was labelled "Add Account"
 * on four different commands. These rules are what make it a flow instead.
 */

function method(overrides: Partial<LoginMethodRow> & { id: string }): LoginMethodRow {
  return { label: overrides.id, available: true, provenance: 'official', preferred: false, ...overrides };
}

function provider(overrides: Partial<AccountProviderRow> = {}): AccountProviderRow {
  return {
    id: 'claude',
    providerId: 'claude',
    label: 'Claude',
    detail: 'Anthropic Claude',
    installed: true,
    livePresent: false,
    loginMethods: [method({ id: 'subscription', label: 'Subscription' })],
    ...overrides,
  };
}

describe('which sources a provider offers', () => {
  it('always offers reading what is already here', () => {
    // A provider can expose both a browser sign-in and a local store. A
    // key-only form would replace the current-login path for someone who just
    // wanted their existing login saved.
    expect(availableSourceModes(provider({ loginMethods: [] }))).toEqual(['thisMac']);
  });

  it('adds the sign-in path when the provider has login methods', () => {
    expect(availableSourceModes(provider())).toEqual(['thisMac', 'newAccount']);
  });

  it('adds the typed-key path only when the provider declares credential kinds', () => {
    const withKeys = provider({ credentialKinds: [{ kind: 'api-key', label: 'API key', profiles: [] }] });
    expect(availableSourceModes(withKeys)).toEqual(['thisMac', 'newAccount', 'credential']);
  });

  it('adds the paste path only when the provider accepts its own auth file', () => {
    const pasted = provider({ acceptsAuthPaste: true });
    expect(availableSourceModes(pasted)).toEqual(['thisMac', 'newAccount', 'paste']);
  });

  it('offers nothing for no provider', () => {
    expect(availableSourceModes(undefined)).toEqual([]);
  });

  it('orders by how much the app does for you', () => {
    const all = provider({
      credentialKinds: [{ kind: 'api-key', label: 'API key', profiles: [] }],
      acceptsAuthPaste: true,
    });
    expect(availableSourceModes(all)).toEqual(['thisMac', 'newAccount', 'credential', 'paste']);
  });
});

describe('the local store picker', () => {
  const two = provider({
    loginMethods: [
      method({ id: 'cli', label: 'Claude Code', sourceId: 'cli', sourceLabel: 'Claude Code' }),
      method({ id: 'antigravity', label: 'Antigravity', sourceId: 'antigravity', sourceLabel: 'Antigravity' }),
    ],
  });

  it('appears only when there is a choice to make', () => {
    expect(showsLocalSourcePicker(provider())).toBe(false);
    expect(showsLocalSourcePicker(two)).toBe(true);
  });

  it('keeps the local store explicit', () => {
    // One provider with a browser sign-in and a local store: conflating the
    // two reads the wrong login.
    expect(localLoginMethods(two).map((row) => row.sourceId)).toEqual(['cli', 'antigravity']);
  });

  it('matches the selected source, case-insensitively', () => {
    expect(selectedLocalLoginMethod(two, 'ANTIGRAVITY')?.sourceId).toBe('antigravity');
  });

  it('falls back to the first when the selection names nothing', () => {
    expect(selectedLocalLoginMethod(two, 'absent')?.sourceId).toBe('cli');
  });

  it('ignores methods with no local store', () => {
    const browserOnly = provider({ loginMethods: [method({ id: 'oauth' })] });
    expect(localLoginMethods(browserOnly)).toEqual([]);
  });
});

describe('the credential kind and profile', () => {
  const withKinds = provider({
    credentialKinds: [
      { kind: 'api-key', label: 'API key', profiles: [{ id: 'global', label: 'Global' }] },
      { kind: 'plan', label: 'Plan', profiles: [{ id: 'pro', label: 'Pro' }] },
    ],
  });

  it('falls back to the first kind when the selection is stale', () => {
    expect(selectedCredentialKind(withKinds, 'absent')?.kind).toBe('api-key');
  });

  it('corrects a profile id the new kind has never heard of', () => {
    // Switching kinds leaves the previous profile behind, and sending it names a
    // profile that does not exist.
    expect(selectedProfileId(withKinds, 'plan', 'global')).toBe('pro');
  });

  it('keeps a profile the kind does offer', () => {
    expect(selectedProfileId(withKinds, 'api-key', 'global')).toBe('global');
  });

  it('reports no profile when the kind has none', () => {
    expect(selectedProfileId(provider(), 'api-key', 'anything')).toBe('');
  });
});

describe('reading the detected identity', () => {
  it('takes the text before the last " in "', () => {
    // An identity that itself contains the phrase has to survive.
    expect(accountIdentityFromDetection('Detected alex in studio in Claude Code')).toBe('alex in studio');
  });

  it('turns the engine sentinel into something readable', () => {
    expect(accountIdentityFromDetection('Detected the current login in Claude Code')).toBe(
      'Current login',
    );
  });

  it('returns nothing for a message that is not a detection', () => {
    expect(accountIdentityFromDetection('Some other failure')).toBeUndefined();
    expect(accountIdentityFromDetection('Detected nothing in')).toBeUndefined();
    expect(accountIdentityFromDetection(undefined)).toBeUndefined();
  });
});

describe('the blocker line', () => {
  it('says nothing when everything is available', () => {
    expect(
      blockerMessage({ provider: provider(), method: undefined, isNewAccountMode: true }),
    ).toBeUndefined();
  });

  it('says so when no provider is installed', () => {
    expect(blockerMessage({ provider: undefined, method: undefined, isNewAccountMode: false })).toContain(
      'No compatible providers',
    );
  });

  it('prefers the provider detail when there is one', () => {
    const message = blockerMessage({
      provider: provider({ installed: false, detail: 'Claude Code is not signed in.' }),
      method: undefined,
      isNewAccountMode: false,
    });
    expect(message).toBe('Claude Code is not signed in.');
  });

  it('falls back to the provider label when the detail is blank', () => {
    expect(
      blockerMessage({
        provider: provider({ installed: false, detail: '' }),
        method: undefined,
        isNewAccountMode: false,
      }),
    ).toBe('Claude is not available on this Mac.');
  });

  it('names the unavailable sign-in method, and only on the sign-in path', () => {
    const unavailable = method({ id: 'oauth', label: 'OAuth', available: false, unavailableReason: 'No browser.' });
    expect(
      blockerMessage({ provider: provider(), method: unavailable, isNewAccountMode: true }),
    ).toBe('No browser.');
    // Reading a local login does not depend on the browser method working.
    expect(
      blockerMessage({ provider: provider(), method: unavailable, isNewAccountMode: false }),
    ).toBeUndefined();
  });
});

describe('when the sheet may submit', () => {
  const base = {
    name: 'Work',
    isNewAccountMode: false,
    hasIdentity: true,
    hasLiveLogin: false,
    methodAvailable: true,
    providerInstalled: true,
    blocked: false,
  };

  it('needs a name', () => {
    expect(savedAccountCanSubmit({ ...base, name: '  ' })).toBe(false);
  });

  it('needs an identity or a live login', () => {
    expect(savedAccountCanSubmit({ ...base, hasIdentity: false })).toBe(false);
    expect(savedAccountCanSubmit({ ...base, hasIdentity: false, hasLiveLogin: true })).toBe(true);
  });

  it('accepts a named sign-in with no identity yet', () => {
    // The browser flow produces the identity; demanding one first would make
    // the button permanently disabled.
    expect(
      savedAccountCanSubmit({ ...base, isNewAccountMode: true, hasIdentity: false, hasLiveLogin: false }),
    ).toBe(true);
  });

  it('rejects a sign-in whose method is unavailable', () => {
    expect(
      savedAccountCanSubmit({ ...base, isNewAccountMode: true, hasIdentity: false, methodAvailable: false }),
    ).toBe(false);
  });

  it('refuses while blocked', () => {
    expect(savedAccountCanSubmit({ ...base, blocked: true })).toBe(false);
  });

  it('refuses for a provider that is not installed', () => {
    expect(savedAccountCanSubmit({ ...base, providerInstalled: false })).toBe(false);
  });

  it('needs both a name and a secret for a typed key', () => {
    const key = { name: 'Work', secret: 'sk', providerInstalled: true, blocked: false, routingComplete: true };
    expect(credentialInputCanSubmit(key)).toBe(true);
    expect(credentialInputCanSubmit({ ...key, secret: ' ' })).toBe(false);
    expect(credentialInputCanSubmit({ ...key, name: '' })).toBe(false);
  });

  it('accepts an empty key only for a key-optional product', () => {
    const keyless = { name: 'Local', secret: '', providerInstalled: true, blocked: false, routingComplete: true };
    expect(credentialInputCanSubmit(keyless)).toBe(false);
    expect(credentialInputCanSubmit({ ...keyless, secretOptional: true })).toBe(true);
    // Still needs a name.
    expect(credentialInputCanSubmit({ ...keyless, secretOptional: true, name: ' ' })).toBe(false);
  });

  it('requires Cloudflare routing to be complete', () => {
    expect(
      credentialInputCanSubmit({
        name: 'Work',
        secret: 'sk',
        providerInstalled: true,
        blocked: false,
        routingComplete: false,
      }),
    ).toBe(false);
  });
});

describe('Cloudflare routing', () => {
  it('is needed for that provider and nothing else', () => {
    // The engine's provider id, not the label a sheet might display.
    expect(needsCloudflareRouting(provider({ id: 'cloudflare-aigateway' }))).toBe(true);
    expect(needsCloudflareRouting(provider())).toBe(false);
    expect(needsCloudflareRouting(undefined)).toBe(false);
  });
});

describe('what the primary button says', () => {
  const base = {
    mode: 'thisMac' as const,
    providerLabel: 'Claude',
    accountName: '',
    isNewAccount: false,
    hasIdentity: false,
    blocked: false,
  };

  it('says Checking while the engine is working', () => {
    // A button labelled "Add Account" that is waiting on a detect is a lie.
    expect(primaryTitle({ ...base, blocked: true })).toBe('Checking');
  });

  it('says what the sign-in button will do', () => {
    expect(primaryTitle({ ...base, mode: 'newAccount' })).toBe('Sign In with Claude');
  });

  it('says Add Login once a new sign-in has an identity', () => {
    expect(primaryTitle({ ...base, mode: 'newAccount', hasIdentity: true })).toBe('Add Login');
  });

  it('names the account a paste will replace', () => {
    expect(primaryTitle({ ...base, mode: 'paste', accountName: ' Work ', replacing: true })).toBe('Replace Work');
  });

  it('says Replace Account when the collision had no name', () => {
    expect(primaryTitle({ ...base, mode: 'paste', accountName: '  ', replacing: true })).toBe('Replace Account');
  });

  it('does not promise to replace on a first paste attempt', () => {
    // The name is a label, not a collision. Calling the first attempt Replace
    // would tell the user their account is about to be overwritten.
    expect(primaryTitle({ ...base, mode: 'paste', accountName: ' Work ' })).toBe('Add Login');
  });
});

describe('the footer', () => {
  const base = {
    providerLabel: 'Claude',
    appName: 'Claude Code',
    isChecking: false,
    isNewAccountMode: false,
    hasIdentity: false,
  };

  it('says each source does something different', () => {
    const footers = (['thisMac', 'newAccount', 'credential', 'paste'] as const).map((mode) =>
      sourceFooterFor({ ...base, mode }),
    );
    expect(new Set(footers).size).toBe(4);
  });

  it('says which store it reads, not just that something is read', () => {
    // "Reads the Claude login already on this Mac" could be the browser tab.
    // Naming the local store is the distinction that path rests on.
    expect(sourceFooterFor({ ...base, mode: 'thisMac' })).toContain('local Claude Code login');
    expect(sourceFooterFor({ ...base, mode: 'thisMac' })).toContain('does not read the account currently open');
  });

  it('says the browser flow saves the account when it finishes', () => {
    expect(sourceFooterFor({ ...base, mode: 'newAccount', isNewAccountMode: true })).toContain(
      'when the browser flow finishes',
    );
  });

  it('says the same while the engine is checking', () => {
    // A footer that names the wrong source mid-detection is how a user ends up
    // waiting on a browser that is never going to open.
    expect(sourceFooterFor({ ...base, mode: 'thisMac', isChecking: true })).toContain(
      'when the browser flow finishes',
    );
  });
});

describe('the identity card', () => {
  it('names the app being read while the engine is checking', () => {
    expect(
      identityTitle({ identity: '', appName: 'Claude Code', isChecking: true, isNewAccountMode: false }),
    ).toBe('Checking Claude Code');
    expect(
      identityDetail({
        identity: '',
        detectedSource: '',
        appName: 'Claude Code',
        isChecking: true,
        isNewAccountMode: false,
        providerLabel: 'Claude',
        isCommunityFlow: false,
        zcodeAppInstalled: false,
      }),
    ).toBe('This usually takes a few seconds.');
  });

  it('shows the identity and says where it came from', () => {
    const detail = identityDetail({
      identity: 'alex@studio.example',
      detectedSource: 'Claude Code',
      appName: 'Claude Code',
      isChecking: false,
      isNewAccountMode: false,
      providerLabel: 'Claude',
      isCommunityFlow: false,
      zcodeAppInstalled: false,
    });
    expect(detail).toBe('Claude Code on this Mac');
  });

  it('drops "on this Mac" for a browser sign-in', () => {
    // A login that came from a browser tab is not on this Mac, and saying so
    // would be a lie the user can check.
    expect(
      identityDetail({
        identity: 'alex',
        detectedSource: 'Z.ai',
        appName: 'Z.ai',
        isChecking: false,
        isNewAccountMode: true,
        providerLabel: 'Z.ai',
        isCommunityFlow: false,
        zcodeAppInstalled: false,
      }),
    ).toBe('Z.ai');
  });

  it('falls back to the app name when the engine named no source', () => {
    expect(
      identityDetail({
        identity: 'alex',
        detectedSource: '',
        appName: 'Claude Code',
        isChecking: false,
        isNewAccountMode: false,
        providerLabel: 'Claude',
        isCommunityFlow: false,
        zcodeAppInstalled: false,
      }),
    ).toBe('Claude Code on this Mac');
  });

  it('says which browser flow a sign-in will open', () => {
    const base = {
      identity: '',
      detectedSource: '',
      appName: 'Claude Code',
      isChecking: false,
      isNewAccountMode: true,
      providerLabel: 'Claude',
      zcodeAppInstalled: false,
    };
    expect(identityDetail({ ...base, isCommunityFlow: false })).toBe("Opens Claude’s official browser flow");
    expect(identityDetail({ ...base, isCommunityFlow: true })).toBe(
      "Opens Claude’s community-supported browser flow",
    );
  });

  it('sends a first-timer to New Account when ZCode has no local login', () => {
    expect(
      identityDetail({
        identity: '',
        detectedSource: '',
        appName: 'ZCode',
        isChecking: false,
        isNewAccountMode: false,
        providerLabel: 'Z.ai',
        isCommunityFlow: false,
        zcodeAppInstalled: true,
      }),
    ).toContain('try New Account');
  });

  it('says there is no login rather than naming the app', () => {
    expect(
      identityTitle({ identity: '', appName: 'Claude Code', isChecking: false, isNewAccountMode: false }),
    ).toBe('No login on this Mac');
  });

  it('explains what Check Again will check', () => {
    expect(
      checkAgainHelp({
        appName: 'Claude Code',
        isNewAccountMode: false,
        hasIdentity: true,
        providerLabel: 'Claude',
        isCommunityFlow: false,
      }),
    ).toBe('Checks the Claude Code account currently active on this Mac.');
    // Before a sign-in completes, the button starts the flow rather than
    // checking anything, and saying otherwise sends the user to the wrong place.
    expect(
      checkAgainHelp({
        appName: 'Claude',
        isNewAccountMode: true,
        hasIdentity: false,
        providerLabel: 'Claude',
        isCommunityFlow: false,
      }),
    ).toBe("Opens Claude’s official browser flow");
  });
});

describe('the source labels', () => {
  it('names every mode', () => {
    for (const mode of ['thisMac', 'newAccount', 'credential', 'paste'] as const) {
      expect(SOURCE_LABEL[mode]).toBeTruthy();
    }
  });
});