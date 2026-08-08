import type { RuntimeProfile, RuntimeProfileMeta, RuntimeProfileSecrets } from '../types';
import { HotplugError } from '../utils/errors';
import { displayLabelFromName, normalizeProfileName } from '../utils/slug';
import type { CatalogRegistry } from '../catalog/providers';
import type { ProfileStore } from './profile-store';

/** Models configured once on the profile, applied on `profile use`. */
export interface ProfileModels {
  defaultModel?: string;
  sonnetModel?: string;
  opusModel?: string;
  haikuModel?: string;
  /** Optional alias map (advanced). */
  models?: Record<string, string>;
}

export interface ProfileCreateOpts extends ProfileModels {
  provider: string;
  endpoint?: string;
  apiKey?: string;
  label?: string;
  notes?: string;
  headers?: Record<string, string>;
  clientOverrides?: Record<string, Record<string, unknown>>;
  force?: boolean;
}

export interface ProfileEditOpts extends ProfileModels {
  endpoint?: string;
  apiKey?: string;
  label?: string;
  notes?: string;
  headers?: Record<string, string>;
  clientOverrides?: Record<string, Record<string, unknown>>;
  clearApiKey?: boolean;
  /** Remove alias keys from models map. */
  unsetModels?: string[];
}

export class ProfileService {
  constructor(
    private readonly store: ProfileStore,
    private readonly catalog: CatalogRegistry,
  ) {}

  async list(): Promise<RuntimeProfile[]> {
    return this.store.list();
  }

  async get(name: string): Promise<RuntimeProfile> {
    return this.store.require(normalizeProfileName(name));
  }

  async create(name: string, opts: ProfileCreateOpts): Promise<RuntimeProfile> {
    const profileName = normalizeProfileName(name);
    const existing = await this.store.get(profileName);
    if (existing && !opts.force) {
      throw new HotplugError(
        `Profile "${profileName}" already exists. Use --force to overwrite.`,
        'PROFILE_EXISTS',
      );
    }

    const provider = this.catalog.get(opts.provider);
    const now = new Date().toISOString();
    const autoLabel = displayLabelFromName(name, profileName);
    const models = opts.models ?? {};
    const headerNames = opts.headers ? Object.keys(opts.headers) : undefined;

    const meta: RuntimeProfileMeta = {
      name: profileName,
      provider: provider.id,
      createdAt: existing?.meta.createdAt ?? now,
      updatedAt: now,
      label: opts.label ?? existing?.meta.label ?? autoLabel,
      notes: opts.notes ?? existing?.meta.notes,
      endpoint: opts.endpoint ?? provider.defaultEndpoint,
      headerNames,
      models,
      defaultModel: cleanModel(opts.defaultModel),
      sonnetModel: cleanModel(opts.sonnetModel),
      opusModel: cleanModel(opts.opusModel),
      haikuModel: cleanModel(opts.haikuModel),
      clientOverrides: opts.clientOverrides,
    };

    const secrets: RuntimeProfileSecrets = {
      apiKey: normalizeLooseSecret(opts.apiKey) ?? existing?.secrets.apiKey,
      headers: opts.headers ?? existing?.secrets.headers,
    };

    await this.store.writeMeta(meta);
    await this.store.writeSecrets(profileName, secrets);
    return this.store.require(profileName);
  }

  async edit(name: string, opts: ProfileEditOpts): Promise<RuntimeProfile> {
    const profileName = normalizeProfileName(name);
    const current = await this.store.require(profileName);
    const now = new Date().toISOString();

    const models = { ...current.meta.models, ...opts.models };
    for (const key of opts.unsetModels ?? []) {
      delete models[key];
    }

    let headers = current.secrets.headers ? { ...current.secrets.headers } : undefined;
    if (opts.headers) {
      headers = { ...headers, ...opts.headers };
    }

    const clientOverrides = {
      ...current.meta.clientOverrides,
      ...opts.clientOverrides,
    };

    const meta: RuntimeProfileMeta = {
      ...current.meta,
      updatedAt: now,
      label: opts.label ?? current.meta.label,
      notes: opts.notes ?? current.meta.notes,
      endpoint: opts.endpoint ?? current.meta.endpoint,
      models,
      defaultModel:
        opts.defaultModel !== undefined ? cleanModel(opts.defaultModel) : current.meta.defaultModel,
      sonnetModel:
        opts.sonnetModel !== undefined ? cleanModel(opts.sonnetModel) : current.meta.sonnetModel,
      opusModel: opts.opusModel !== undefined ? cleanModel(opts.opusModel) : current.meta.opusModel,
      haikuModel:
        opts.haikuModel !== undefined ? cleanModel(opts.haikuModel) : current.meta.haikuModel,
      headerNames: headers ? Object.keys(headers) : current.meta.headerNames,
      clientOverrides: Object.keys(clientOverrides).length > 0 ? clientOverrides : undefined,
    };

    let apiKey = current.secrets.apiKey;
    if (opts.clearApiKey) {
      apiKey = undefined;
    }
    if (opts.apiKey !== undefined) {
      apiKey = normalizeLooseSecret(opts.apiKey) ?? '';
    }

    const secrets: RuntimeProfileSecrets = {
      apiKey,
      headers,
    };

    await this.store.writeMeta(meta);
    await this.store.writeSecrets(profileName, secrets);
    return this.store.require(profileName);
  }

  async delete(name: string): Promise<void> {
    await this.store.delete(normalizeProfileName(name));
  }

  async rename(oldName: string, newName: string): Promise<void> {
    await this.store.rename(normalizeProfileName(oldName), normalizeProfileName(newName));
  }

  async duplicate(sourceName: string, newName: string): Promise<RuntimeProfile> {
    const source = await this.store.require(normalizeProfileName(sourceName));
    const dest = normalizeProfileName(newName);
    if (await this.store.get(dest)) {
      throw new HotplugError(`Profile "${dest}" already exists.`, 'PROFILE_EXISTS');
    }
    return this.create(dest, {
      provider: source.meta.provider,
      endpoint: source.meta.endpoint,
      apiKey: source.secrets.apiKey,
      label: source.meta.label,
      notes: source.meta.notes,
      defaultModel: source.meta.defaultModel,
      sonnetModel: source.meta.sonnetModel,
      opusModel: source.meta.opusModel,
      haikuModel: source.meta.haikuModel,
      models: { ...source.meta.models },
      headers: source.secrets.headers ? { ...source.secrets.headers } : undefined,
      clientOverrides: source.meta.clientOverrides
        ? structuredClone(source.meta.clientOverrides)
        : undefined,
    });
  }

  redact(
    profile: RuntimeProfile,
    reveal = false,
  ): {
    meta: RuntimeProfileMeta;
    secrets: RuntimeProfileSecrets;
  } {
    if (reveal) {
      return { meta: profile.meta, secrets: profile.secrets };
    }
    return {
      meta: profile.meta,
      secrets: {
        apiKey: profile.secrets.apiKey ? maskSecret(profile.secrets.apiKey) : undefined,
        headers: profile.secrets.headers
          ? Object.fromEntries(
              Object.entries(profile.secrets.headers).map(([k, v]) => [k, maskSecret(v)]),
            )
          : undefined,
      },
    };
  }
}

function cleanModel(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const t = value.trim();
  return t.length ? t : undefined;
}

function normalizeLooseSecret(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.replace(/^\r?\n|\r?\n$/g, '');
}

function maskSecret(value: string): string {
  if (value.length === 0) {
    return '(empty)';
  }
  if (value.length <= 8) {
    return '••••••••';
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
