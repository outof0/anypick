/**
 * Deterministic resource reference parsing (spec §15).
 *
 * Grammar:
 *   provider/account       → account
 *   account/provider/account → account
 *   gateway-name           → gateway
 *   gateway/gateway-name   → gateway
 *   @preset-name           → preset
 *   preset/preset-name     → preset
 *
 * No cross-kind ambiguity. Fuzzy matching never used for direct execution.
 */

import type {
  AccountPoolResourceRef,
  AccountResourceRef,
  ClientId,
  GatewayResourceRef,
  ProxyHubResourceRef,
  PresetResourceRef,
  ResourceRef,
} from '../types';
import { anypickError, ExitCode } from '../utils/errors';

/** Known account-auth provider ids (file-snapshot providers). */
const DEFAULT_ACCOUNT_PROVIDERS = new Set(['codex', 'gemini', 'grok', 'kiro', 'opencode']);

export interface ParseRefContext {
  /** Known account provider ids (default: builtin set). */
  accountProviders?: ReadonlySet<string>;
  /**
   * Optional exact gateway existence check. When provided and plain input
   * is not a gateway but an exact preset exists, throws NOT_FOUND with @suggestion.
   */
  gatewayExists?: (name: string) => boolean | Promise<boolean>;
  presetExists?: (name: string) => boolean | Promise<boolean>;
}

/**
 * Mutation scope covering a provider's live credential file *and* all of its
 * saved snapshots.
 *
 * Deliberately coarser than one lock per account. Every snapshot mutation is
 * reached through the single live auth file the provider owns on disk, so two
 * activations pointing different clients at different accounts of the same
 * provider are not independent — per-account locks would let them interleave
 * two rewrites of that one file. Save/use/stash also resolve their target
 * account *by identity* mid-operation, so the exact account is not knowable
 * up front and could not be locked in a fixed order (ADR 0009).
 */
export function providerScope(providerId: string): string {
  return `provider/${providerId}`;
}

/**
 * Mutation scope an activation must hold for its resolved source. Account and
 * pool sources both reach the provider's live auth, so they collapse onto
 * `providerScope`, which is what the services lock — one lock file, so the
 * nested service call re-enters instead of self-deadlocking.
 */
export function mutationScopeForRef(ref: ResourceRef): string {
  switch (ref.kind) {
    case 'account':
    case 'account-pool':
      return providerScope(ref.provider);
    case 'gateway':
    case 'proxy-hub':
    case 'preset':
      return serializeRef(ref);
    default: {
      const _exhaustive: never = ref;
      throw new Error(`Unknown resource ref: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export function serializeRef(ref: ResourceRef): string {
  switch (ref.kind) {
    case 'account':
      return `account/${ref.provider}/${ref.name}`;
    case 'gateway':
      return `gateway/${ref.name}`;
    case 'proxy-hub':
      return `hub/${ref.name}`;
    case 'preset':
      return `preset/${ref.name}`;
    case 'account-pool':
      return `pool/${ref.provider}`;
    default: {
      const _exhaustive: never = ref;
      throw new Error(`Unknown resource ref: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export function displayRef(ref: ResourceRef): string {
  switch (ref.kind) {
    case 'account':
      return `${ref.provider}/${ref.name}`;
    case 'gateway':
      return ref.name;
    case 'proxy-hub':
      return `hub:${ref.name}`;
    case 'preset':
      return `@${ref.name}`;
    case 'account-pool':
      return `pool:${ref.provider}`;
    default: {
      const _exhaustive: never = ref;
      throw new Error(`Unknown resource ref: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export function accountRef(provider: string, name: string): AccountResourceRef {
  return { kind: 'account', provider, name };
}

export function gatewayRef(name: string): GatewayResourceRef {
  return { kind: 'gateway', name };
}

export function proxyHubRef(name: string): ProxyHubResourceRef {
  return { kind: 'proxy-hub', name };
}

export function presetRef(name: string): PresetResourceRef {
  return { kind: 'preset', name };
}

export function accountPoolRef(provider: string): AccountPoolResourceRef {
  return { kind: 'account-pool', provider };
}

/**
 * Parse a source/preset reference string into a typed ResourceRef.
 * Synchronous path — does not perform existence checks.
 * Use resolveSourceRef for existence + preset suggestion.
 */
export function parseRef(input: string, ctx: ParseRefContext = {}): ResourceRef {
  const raw = input.trim();
  if (!raw) {
    throw anypickError('Empty resource reference.', 'INVALID_REFERENCE', {
      exitCode: ExitCode.INVALID_USAGE,
      suggestions: [
        'Accounts use provider/name:  grok/work',
        'Gateways use their saved name:  openrouter-work',
        'Presets use @name:  @work-grok',
      ],
    });
  }

  const providers = ctx.accountProviders ?? DEFAULT_ACCOUNT_PROVIDERS;

  // @preset
  if (raw.startsWith('@')) {
    const name = raw.slice(1).trim();
    if (!name) {
      throw anypickError('Preset name is required after @.', 'INVALID_REFERENCE', {
        exitCode: ExitCode.INVALID_USAGE,
      });
    }
    return presetRef(name);
  }

  // Fully qualified forms
  if (raw.startsWith('preset/')) {
    const name = raw.slice('preset/'.length).trim();
    if (!name) {
      throw anypickError('Preset name is required after preset/.', 'INVALID_REFERENCE', {
        exitCode: ExitCode.INVALID_USAGE,
      });
    }
    return presetRef(name);
  }

  // hub:default | hub/default. Hub has an explicit prefix so a plain gateway
  // name can never be reinterpreted after an upgrade.
  if (raw.startsWith('hub:') || raw.startsWith('hub/')) {
    const name = raw.startsWith('hub:')
      ? raw.slice('hub:'.length).trim()
      : raw.slice('hub/'.length).trim();
    if (!name || name.includes('/') || name.includes(':')) {
      throw anypickError(`Invalid Proxy Hub reference: ${raw}`, 'INVALID_REFERENCE', {
        exitCode: ExitCode.INVALID_USAGE,
      });
    }
    return proxyHubRef(name);
  }

  // pool:grok | pool/grok
  if (raw.startsWith('pool:') || raw.startsWith('pool/')) {
    const provider = raw.startsWith('pool:')
      ? raw.slice('pool:'.length).trim()
      : raw.slice('pool/'.length).trim();
    if (!provider || provider.includes('/') || provider.includes(':')) {
      throw anypickError(
        `Invalid pool reference: ${raw}. Expected pool:provider (e.g. pool:gemini)`,
        'INVALID_REFERENCE',
        { exitCode: ExitCode.INVALID_USAGE },
      );
    }
    if (!providers.has(provider)) {
      throw anypickError(
        `Unknown account provider "${provider}" in pool reference: ${raw}`,
        'INVALID_REFERENCE',
        {
          exitCode: ExitCode.INVALID_USAGE,
          suggestions: [`Known: ${[...providers].toSorted().join(', ')}`],
        },
      );
    }
    return accountPoolRef(provider);
  }

  if (raw.startsWith('gateway/')) {
    const name = raw.slice('gateway/'.length).trim();
    if (!name || name.includes('/')) {
      throw anypickError(`Invalid gateway reference: ${raw}`, 'INVALID_REFERENCE', {
        exitCode: ExitCode.INVALID_USAGE,
      });
    }
    return gatewayRef(name);
  }

  if (raw.startsWith('account/')) {
    const rest = raw.slice('account/'.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) {
      throw anypickError(
        `Invalid account reference: ${raw}. Expected account/provider/name`,
        'INVALID_REFERENCE',
        { exitCode: ExitCode.INVALID_USAGE },
      );
    }
    const provider = rest.slice(0, slash);
    const name = rest.slice(slash + 1);
    return accountRef(provider, name);
  }

  // provider/name → account when provider is a known account provider
  const slash = raw.indexOf('/');
  if (slash > 0) {
    const provider = raw.slice(0, slash);
    const name = raw.slice(slash + 1);
    if (providers.has(provider)) {
      if (!name || name.includes('/')) {
        throw anypickError(
          `Invalid account reference: ${raw}. Expected provider/account`,
          'INVALID_REFERENCE',
          { exitCode: ExitCode.INVALID_USAGE },
        );
      }
      return accountRef(provider, name);
    }
    // Unknown provider with slash: treat as invalid account form, not gateway
    // (gateways cannot contain /)
    throw anypickError(
      `Unknown account provider "${provider}" in reference: ${raw}`,
      'INVALID_REFERENCE',
      {
        exitCode: ExitCode.INVALID_USAGE,
        suggestions: [
          `Known account providers: ${[...providers].toSorted().join(', ')}`,
          'Gateways use a plain name without /',
          'Presets use @name',
        ],
      },
    );
  }

  // Plain input → gateway only
  if (raw.includes('/') || raw.startsWith('@')) {
    throw anypickError(`Invalid gateway name: ${raw}`, 'INVALID_REFERENCE', {
      exitCode: ExitCode.INVALID_USAGE,
    });
  }
  return gatewayRef(raw);
}

/**
 * Resolve a reference with optional existence checks.
 * When a plain gateway name is missing but an exact preset exists,
 * throws NOT_FOUND suggesting `@name` (never auto-resolves).
 */
export async function resolveSourceRef(
  input: string,
  ctx: ParseRefContext & {
    gatewayExists: (name: string) => boolean | Promise<boolean>;
    presetExists?: (name: string) => boolean | Promise<boolean>;
    accountExists?: (provider: string, name: string) => boolean | Promise<boolean>;
  },
): Promise<ResourceRef> {
  const ref = parseRef(input, ctx);

  if (ref.kind === 'gateway') {
    const exists = await ctx.gatewayExists(ref.name);
    if (!exists) {
      const presetHit = ctx.presetExists && (await ctx.presetExists(ref.name));
      if (presetHit) {
        throw anypickError(
          `Gateway \`${ref.name}\` was not found.\n\nA preset with that name exists.\nDid you mean:\n  anypick use <client> --with @${ref.name}`,
          'RESOURCE_NOT_FOUND',
          {
            exitCode: ExitCode.NOT_FOUND,
            suggestions: [`anypick use <client> --with @${ref.name}`],
            details: { kind: 'gateway', name: ref.name, presetSuggestion: ref.name },
          },
        );
      }
      throw anypickError(`Gateway \`${ref.name}\` was not found.`, 'GATEWAY_NOT_FOUND', {
        exitCode: ExitCode.NOT_FOUND,
        suggestions: [
          'Accounts use provider/name:',
          '  anypick use claude --with grok/work',
          'Gateways use their saved name:',
          '  anypick use claude --with openrouter-work',
          'Presets use @name:',
          '  anypick use claude --with @work-grok',
        ],
        details: { kind: 'gateway', name: ref.name },
      });
    }
    return ref;
  }

  if (ref.kind === 'proxy-hub') {
    // `default` is synthesized lazily by ProxyHubStore. Other names are kept
    // type-valid for future profiles, but are not auto-created by parsing.
    if (ref.name !== 'default') {
      throw anypickError(`Proxy Hub \`${ref.name}\` was not found.`, 'RESOURCE_NOT_FOUND', {
        exitCode: ExitCode.NOT_FOUND,
      });
    }
    return ref;
  }

  if (ref.kind === 'account' && ctx.accountExists) {
    const exists = await ctx.accountExists(ref.provider, ref.name);
    if (!exists) {
      throw anypickError(
        `Account \`${ref.provider}/${ref.name}\` was not found.`,
        'ACCOUNT_NOT_FOUND',
        {
          exitCode: ExitCode.NOT_FOUND,
          suggestions: [
            `anypick add account ${ref.provider} --current --name ${ref.name}`,
            `anypick list accounts`,
          ],
          details: { kind: 'account', provider: ref.provider, name: ref.name },
        },
      );
    }
  }

  if (ref.kind === 'preset' && ctx.presetExists) {
    const exists = await ctx.presetExists(ref.name);
    if (!exists) {
      throw anypickError(`Preset \`@${ref.name}\` was not found.`, 'PRESET_NOT_FOUND', {
        exitCode: ExitCode.NOT_FOUND,
        suggestions: ['anypick list presets'],
        details: { kind: 'preset', name: ref.name },
      });
    }
  }

  return ref;
}

/**
 * Optional native-account shorthand: `anypick use codex/personal`
 * Valid only when provider is also a supported client and the account
 * is a native source for that same client.
 */
export function parseNativeAccountShorthand(
  input: string,
  opts: {
    accountProviders: ReadonlySet<string>;
    clientIds: ReadonlySet<string>;
  },
): { client: ClientId; source: AccountResourceRef } | null {
  const raw = input.trim();
  if (
    !raw ||
    raw.startsWith('@') ||
    raw.startsWith('account/') ||
    raw.startsWith('gateway/') ||
    raw.startsWith('preset/')
  ) {
    return null;
  }
  const slash = raw.indexOf('/');
  if (slash <= 0) {
    return null;
  }
  const provider = raw.slice(0, slash);
  const name = raw.slice(slash + 1);
  if (!name || name.includes('/')) {
    return null;
  }
  if (!opts.accountProviders.has(provider)) {
    return null;
  }
  // Provider must also be a supported client (native same-provider)
  if (!opts.clientIds.has(provider)) {
    return null;
  }
  return {
    client: provider,
    source: accountRef(provider, name),
  };
}

export function isKnownAccountProvider(
  id: string,
  providers: ReadonlySet<string> = DEFAULT_ACCOUNT_PROVIDERS,
): boolean {
  return providers.has(id);
}

export { DEFAULT_ACCOUNT_PROVIDERS };
