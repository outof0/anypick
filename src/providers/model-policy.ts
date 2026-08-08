/**
 * Shared model-policy helpers for providers whose model catalog is account- or
 * upstream-specific.
 *
 * These providers front a proxy that exposes `/v1/models`, so the authoritative
 * list is only knowable at runtime. Declaring the four Claude-Code roles with
 * empty values says "this role applies, fill it from live discovery" — which is
 * meaningfully different from omitting the key (role does not apply) and from
 * inventing a plausible-looking id the account may not be entitled to.
 */

/** Role ids Claude Code exposes. Other clients use `default` only. */
export const CLAUDE_ROLE_IDS = ['default', 'sonnet', 'opus', 'haiku'] as const;

/** Four roles, all awaiting live discovery. */
export function rolesFromLiveDiscovery(): Record<string, string> {
  return Object.fromEntries(CLAUDE_ROLE_IDS.map((r) => [r, '']));
}
