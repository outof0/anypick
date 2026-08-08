/**
 * The TUI navigation state.
 *
 * `Screen` is the discriminated union every view is selected from, and several
 * variants carry the data that view needs plus a `back` pointer, so the union
 * doubles as the navigation stack. It lives here rather than in `app-ui.tsx`
 * so that state transitions can be written and tested without mounting Ink.
 */

import type { ClientModelRole } from '../../types';
import type { HelpContext } from '../screens/help';
import type { OperationReceipt } from './types';
import type { AppBindingRow } from './bindings';

/**
 * Where a model picker's list came from, shown under the list so the user can
 * tell an authoritative list from a hardcoded guess.
 *
 * `live`/`cache`/`stale` come from `ModelDiscoveryService` asking the vendor;
 * `proxy` is a running local proxy's `/v1/models`; `catalog` and `fallback` are
 * the shipped static lists, which go stale between releases.
 */
export type ModelSuggestionsSource =
  | 'live'
  | 'cache'
  | 'stale'
  | 'proxy'
  | 'fallback'
  | 'empty'
  | 'catalog';

export type TextInputPurpose =
  | 'save-name'
  | 'export-path'
  | 'import-path'
  | 'import-name'
  | 'gateway-name'
  | 'gateway-endpoint'
  | 'gateway-api-key'
  | 'gateway-edit-endpoint';

/**
 * A user-supplied credential, complete, as the inline form collected it.
 *
 * `options` holds whatever qualifiers `Provider.credentialInputFields(kind)`
 * declares, so the flow collects them without knowing what they are. The draft
 * is carried back onto the form when saving needs a confirmation the user may
 * decline, so a declined save costs no retyping.
 */
export interface CredentialDraft {
  providerId: string;
  /** One of the provider's `credentialInputs`, e.g. `api-key`. */
  kind: string;
  secret: string;
  options: Record<string, string>;
  name: string;
}

export interface GatewayDraft {
  providerId: string;
  providerName: string;
  defaultEndpoint?: string;
  name?: string;
  endpoint?: string;
  apiKey?: string;
}

export type Screen =
  | { kind: 'loading'; label?: string }
  | {
      kind: 'hotplug';
      filter?: string;
      focusRef?: string;
      filterActive?: boolean;
    }
  | { kind: 'proxy'; focusRef?: string }
  | { kind: 'accounts'; focusRef?: string }
  | { kind: 'gateways'; focusName?: string }
  | { kind: 'gateway-pick-provider' }
  | {
      kind: 'gateway-create';
      step: 'name' | 'endpoint' | 'api-key' | 'models';
      providerId: string;
      providerName: string;
      defaultEndpoint?: string;
      name?: string;
      endpoint?: string;
      apiKey?: string;
      modelValues?: Record<string, string>;
    }
  | {
      kind: 'gateway-connection';
      providerId: string;
      providerName: string;
      name: string;
      endpoint?: string;
      apiKey?: string;
      back: Screen;
    }
  | {
      kind: 'gateway-models';
      name: string;
      values: Record<string, string>;
      suggestions: string[];
      suggestionsSource?: ModelSuggestionsSource;
      /** After save, re-apply bound apps */
      reapply?: boolean;
    }
  | {
      kind: 'gateway-apps';
      name: string;
      apps: AppBindingRow[];
      checked: string[];
    }
  | { kind: 'help'; context: HelpContext; back: Screen }
  | { kind: 'hotplug-preview'; providerId: string; name: string }
  | { kind: 'add-provider' }
  | { kind: 'add-mode'; providerId: string; source?: 'antigravity' }
  | { kind: 'add-source'; providerId: string }
  | {
      kind: 'credential-form';
      providerId: string;
      /** One of the provider's `credentialInputs`, e.g. `api-key`. */
      credentialKind: string;
      /** Values to reopen the form with, after a save the user backed out of. */
      draft?: CredentialDraft;
      back: Screen;
    }
  | { kind: 'account-detail'; providerId: string; name: string; back: Screen }
  | {
      kind: 'stash-result';
      providerId: string;
      source?: 'antigravity';
      displayName: string;
      cleared: boolean;
      backedUpTo: string | null;
      previousIdentity?: string;
      matchedByIdentity: boolean;
      skippedBackup?: boolean;
    }
  | {
      kind: 'text-input';
      purpose: TextInputPurpose;
      providerId?: string;
      accountName?: string;
      /** Sign-in source carried into save-name for providers with a source picker. */
      source?: 'antigravity';
      /** Gateway create draft carried through text steps */
      gatewayDraft?: GatewayDraft;
      label: string;
      initial?: string;
      hint?: string;
      preview?: string;
      back: Screen;
    }
  | {
      kind: 'confirm';
      title: string;
      body: string[];
      confirmLabel?: string;
      cancelLabel?: string;
      path?: string | string[];
      danger?: boolean;
      action: () => Promise<void> | void;
      back: Screen;
    }
  | {
      kind: 'message';
      receipt?: OperationReceipt;
      msg?: string;
      back: Screen;
    }
  | {
      kind: 'proxy-logs';
      providerId: string;
      name: string;
      text: string;
      running?: boolean;
    }
  | {
      kind: 'manage-apps';
      providerId: string;
      name: string;
      apps: AppBindingRow[];
      checked: string[];
    }
  | {
      kind: 'proxy-models';
      providerId: string;
      name: string;
      clientId: string;
      clientName: string;
      roles: ClientModelRole[];
      values: Record<string, string>;
      suggestions: string[];
      suggestionsSource?: ModelSuggestionsSource;
      /** Apps still waiting for model map (after current). */
      queue: Array<{ clientId: string; clientName: string }>;
      detach: AppBindingRow[];
      /** Roles already chosen for clients in this batch. */
      rolesByClient: Record<string, Record<string, string>>;
      /** When true, only re-apply this client (no detach queue). */
      reedit?: boolean;
    };

/** The one text-entry screen, named so its renderer and its submit handler share it. */
export type TextInputScreen = Extract<Screen, { kind: 'text-input' }>;

/** Named because the model map carries a whole batch of pending work, not just values. */
export type ProxyModelsScreenState = Extract<Screen, { kind: 'proxy-models' }>;

export type GatewayConnectionScreen = Extract<Screen, { kind: 'gateway-connection' }>;
export type GatewayModelsScreen = Extract<Screen, { kind: 'gateway-models' }>;

/** Screens that reload from disk on entry rather than rendering carried data. */
export type ReloadingScreenKind = 'hotplug' | 'proxy' | 'accounts';

export function isReloadingScreen(
  screen: Screen,
): screen is Screen & { kind: ReloadingScreenKind } {
  return screen.kind === 'hotplug' || screen.kind === 'proxy' || screen.kind === 'accounts';
}
