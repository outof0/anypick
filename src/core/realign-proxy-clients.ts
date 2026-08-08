/**
 * When a proxy rebinds to a new port/endpoint, rewrite every bound client
 * (settings.json / env) so ANTHROPIC_BASE_URL / OPENAI_BASE_URL stay in sync.
 * User should never need `hotplug use --current` just because the port bumped.
 */

import type { BindingStore } from './binding-store';
import type { RuntimeService } from './runtime-service';
import type { ClientStateStore } from './client-state-store';
import { modelRolesFromClientOptions } from './model-roles';

export interface RealignProxyClientsDeps {
  bindings: BindingStore;
  runtime: RuntimeService;
  clientState?: ClientStateStore;
}

/**
 * Find clients bound to provider/account (global + project bindings + client_state)
 * and re-apply the live proxy endpoint into their native config.
 */
export async function realignClientsToAccountProxy(
  deps: RealignProxyClientsDeps,
  providerId: string,
  accountName: string,
  endpoint: string,
  token?: string,
): Promise<string[]> {
  const clients = new Set<string>();

  for (const b of deps.bindings.listGlobal()) {
    if (bindingMatchesAccount(b.spec.source, providerId, accountName)) {
      clients.add(b.client);
    }
  }
  // Project bindings are scoped to a project activation. Rewriting a native
  // global client config here would leak that project binding globally.

  if (deps.clientState) {
    for (const st of await deps.clientState.list()) {
      if (
        st.mode === 'account' &&
        st.accountRef?.provider === providerId &&
        st.accountRef?.name === accountName
      ) {
        clients.add(st.clientId);
      }
    }
  }

  const updated: string[] = [];
  for (const clientId of clients) {
    try {
      const global = deps.bindings.getGlobal(clientId);
      const roles = modelRolesFromClientOptions(global?.spec.clientOptions);
      const modelId =
        global?.spec.model.mode === 'explicit' ? global.spec.model.id : roles?.default;

      await deps.runtime.applyProxyEndpoint(clientId, {
        endpoint,
        apiKey: token ?? 'hotplug-proxy',
        defaultModel: modelId,
        modelRoles: roles,
        accountRef: { provider: providerId, name: accountName },
        label: `proxy:${providerId}/${accountName}`,
      });
      updated.push(clientId);
    } catch {
      // Best-effort — one broken client should not block others
    }
  }
  return updated;
}

function bindingMatchesAccount(
  source: { kind: string; provider?: string; name?: string },
  providerId: string,
  accountName: string,
): boolean {
  if (source.kind === 'account') {
    return source.provider === providerId && source.name === accountName;
  }
  // A single-account process must never rewrite clients bound to a provider
  // pool (or another account). Pool lifecycle owns its own client binding.
  return false;
}
