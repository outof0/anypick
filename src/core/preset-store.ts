import { randomUUID } from 'node:crypto';
import type { BindingSpec, SavedPreset } from '../types';
import { hotplugError, ExitCode } from '../utils/errors';
import { decode, decoders } from './codec';
import type { HotplugDatabase } from './db';

interface PresetRow {
  id: string;
  name: string;
  revision: number;
  spec_json: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  use_count: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parse(row: PresetRow): SavedPreset {
  return {
    id: row.id,
    name: row.name,
    revision: row.revision,
    spec: decode(row.spec_json, decoders.presetSpec, `preset/${row.name}`),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at ?? undefined,
    useCount: row.use_count,
  };
}

export class PresetStore {
  constructor(private readonly db: HotplugDatabase) {}

  getByName(name: string): SavedPreset | null {
    const row = this.db
      .prepare(
        `SELECT id, name, revision, spec_json, created_at, updated_at, last_used_at, use_count
         FROM presets WHERE name = ?`,
      )
      .get(name) as PresetRow | undefined;
    return row ? parse(row) : null;
  }

  getById(id: string): SavedPreset | null {
    const row = this.db
      .prepare(
        `SELECT id, name, revision, spec_json, created_at, updated_at, last_used_at, use_count
         FROM presets WHERE id = ?`,
      )
      .get(id) as PresetRow | undefined;
    return row ? parse(row) : null;
  }

  exists(name: string): boolean {
    return this.getByName(name) !== null;
  }

  list(): SavedPreset[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, revision, spec_json, created_at, updated_at, last_used_at, use_count
         FROM presets ORDER BY name`,
      )
      .all() as unknown as PresetRow[];
    return rows.map(parse);
  }

  create(
    name: string,
    spec: Omit<BindingSpec, 'model'> & {
      model: { mode: 'explicit'; id: string } | { mode: 'omitted' };
    },
  ): SavedPreset {
    if (!name || name.startsWith('@') || name.includes('/')) {
      throw hotplugError(
        `Invalid preset name "${name}". Preset names cannot contain / or leading @.`,
        'INVALID_USAGE',
        { exitCode: ExitCode.INVALID_USAGE },
      );
    }
    if (this.exists(name)) {
      throw hotplugError(`Preset \`@${name}\` already exists.`, 'STATE_CONFLICT', {
        exitCode: ExitCode.CAPABILITY_CONFLICT,
        suggestions: [`hotplug edit @${name}`, `hotplug remove @${name}`],
      });
    }
    const ts = nowIso();
    const preset: SavedPreset = {
      id: randomUUID(),
      name,
      revision: 1,
      spec,
      createdAt: ts,
      updatedAt: ts,
      useCount: 0,
    };
    this.db
      .prepare(
        `INSERT INTO presets
           (id, name, revision, spec_json, created_at, updated_at, last_used_at, use_count)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 0)`,
      )
      .run(
        preset.id,
        preset.name,
        preset.revision,
        JSON.stringify(preset.spec),
        preset.createdAt,
        preset.updatedAt,
      );
    return preset;
  }

  /**
   * Update preset fields. Omitted fields in `patch` preserve current values.
   * Always increments revision on success.
   */
  update(
    name: string,
    patch: {
      name?: string;
      spec?: Partial<SavedPreset['spec']>;
    },
  ): SavedPreset {
    const existing = this.getByName(name);
    if (!existing) {
      throw hotplugError(`Preset \`@${name}\` was not found.`, 'PRESET_NOT_FOUND', {
        exitCode: ExitCode.NOT_FOUND,
      });
    }

    const newName = patch.name ?? existing.name;
    if (newName !== existing.name && this.exists(newName)) {
      throw hotplugError(`Preset \`@${newName}\` already exists.`, 'STATE_CONFLICT', {
        exitCode: ExitCode.CAPABILITY_CONFLICT,
      });
    }

    const nextSpec: SavedPreset['spec'] = {
      ...existing.spec,
      ...patch.spec,
      clientOptions: {
        ...existing.spec.clientOptions,
        ...patch.spec?.clientOptions,
      },
    };

    // model must remain explicit | omitted
    if (nextSpec.model.mode !== 'explicit' && nextSpec.model.mode !== 'omitted') {
      throw hotplugError('Preset model must be explicit or omitted.', 'INVALID_USAGE', {
        exitCode: ExitCode.INVALID_USAGE,
      });
    }

    const ts = nowIso();
    const revision = existing.revision + 1;
    this.db
      .prepare(
        `UPDATE presets SET name = ?, revision = ?, spec_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(newName, revision, JSON.stringify(nextSpec), ts, existing.id);

    return {
      ...existing,
      name: newName,
      revision,
      spec: nextSpec,
      updatedAt: ts,
    };
  }

  recordUse(name: string): void {
    const ts = nowIso();
    this.db
      .prepare(`UPDATE presets SET last_used_at = ?, use_count = use_count + 1 WHERE name = ?`)
      .run(ts, name);
  }

  remove(name: string): boolean {
    const r = this.db.prepare(`DELETE FROM presets WHERE name = ?`).run(name);
    return Number(r.changes) > 0;
  }
}
