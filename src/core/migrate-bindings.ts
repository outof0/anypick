/**
 * Legacy ClientState / RuntimeProfile → GlobalBinding migration (spec §26.4).
 * Exact-evidence only. Never invent bindings from activeProfile alone.
 */

import type { HotplugApp } from './app';
import type { BindingSpec, GlobalBinding, ModelSelection } from '../types';
import { gatewayRef, accountRef } from './refs';
import { getMeta, setMeta } from './db';
import { ClientStateStore } from './client-state-store';

const MIGRATION_KEY = 'bindings_migrated_v1';

export async function migrateBindingsIfNeeded(app: HotplugApp): Promise<{
  migrated: boolean;
  bindingsCreated: number;
}> {
  if (getMeta(app.db, MIGRATION_KEY) === '1') {
    return { migrated: false, bindingsCreated: 0 };
  }

  // If global bindings already exist, mark done without overwriting
  if (app.bindings.listGlobal().length > 0) {
    setMeta(app.db, MIGRATION_KEY, '1');
    return { migrated: false, bindingsCreated: 0 };
  }

  const clientState = new ClientStateStore(app.root, app.db);
  const states = await clientState.list();
  let created = 0;
  const importedAt = new Date().toISOString();

  for (const state of states) {
    // Gateway evidence: exact profileName match
    if (state.profileName && state.mode === 'profile') {
      const profile = await app.profileStore.get(state.profileName);
      if (!profile) {
        continue;
      }

      // Do not reinterpret profile.provider as account source
      const source = gatewayRef(state.profileName);
      const model = reconstructModel(state, profile.meta.defaultModel);

      const spec: BindingSpec = {
        client: state.clientId,
        source,
        model,
        transportPolicy: 'auto',
        clientOptions: {},
      };

      const binding: GlobalBinding = {
        client: state.clientId,
        spec,
        provenance: {
          kind: 'legacy_migration',
          sourceConfidence: 'exact',
          modelConfidence:
            model.mode === 'explicit' ? 'exact' : model.mode === 'omitted' ? 'omitted' : 'unknown',
          importedAt,
        },
        createdAt: importedAt,
        updatedAt: importedAt,
      };

      // Only create if no binding yet for this client
      if (!app.bindings.getGlobal(state.clientId)) {
        app.bindings.putGlobal(binding);
        created++;
      }
      continue;
    }

    // Account evidence: exact accountRef on client state
    if (state.accountRef && state.mode === 'account') {
      const { provider, name } = state.accountRef;
      const account = await app.accounts.get(provider, name);
      if (!account) {
        continue;
      }

      const source = accountRef(provider, name);
      const model: ModelSelection = {
        mode: 'unknown',
        reason: 'legacy_migration',
      };

      const spec: BindingSpec = {
        client: state.clientId,
        source,
        model,
        transportPolicy: 'auto',
        clientOptions: {},
      };

      if (!app.bindings.getGlobal(state.clientId)) {
        app.bindings.putGlobal({
          client: state.clientId,
          spec,
          provenance: {
            kind: 'legacy_migration',
            sourceConfidence: 'exact',
            modelConfidence: 'unknown',
            importedAt,
          },
          createdAt: importedAt,
          updatedAt: importedAt,
        });
        created++;
      }
    }
  }

  // Never create binding solely from GlobalConfig.activeProfile
  setMeta(app.db, MIGRATION_KEY, '1');
  return { migrated: true, bindingsCreated: created };
}

function reconstructModel(
  state: { managedPaths?: string[] },
  profileDefault?: string,
): ModelSelection {
  // Without exact per-client apply metadata for model, do not substitute
  // the gateway's current default — it may have changed.
  void state;
  void profileDefault;
  return { mode: 'unknown', reason: 'legacy_migration' };
}
