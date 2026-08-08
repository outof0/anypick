import type {
  BindingProvenance,
  BindingSpec,
  ClientId,
  GlobalBinding,
  ProjectBinding,
  SourceResume,
} from '../types';
import { decode } from './codec';
import { decoders } from './codec';
import type { AnyPickDatabase } from './db';
import { serializeRef } from './refs';

interface BindingRow {
  client_id: string;
  project_root?: string;
  spec_json: string;
  provenance_json: string;
  managed_config_revision?: string | null;
  created_at: string;
  updated_at: string;
}

interface SourceResumeRow {
  source_ref: string;
  client_id: string;
  spec_json: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseGlobal(row: BindingRow): GlobalBinding {
  return {
    client: row.client_id,
    spec: decode(row.spec_json, decoders.bindingSpec, `binding/${row.client_id}`) as BindingSpec,
    provenance: decode(
      row.provenance_json,
      decoders.bindingProvenance,
      `binding/${row.client_id}/prov`,
    ) as BindingProvenance,
    managedConfigRevision: row.managed_config_revision ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseProject(row: BindingRow): ProjectBinding {
  return {
    projectRoot: row.project_root!,
    client: row.client_id,
    spec: decode(
      row.spec_json,
      decoders.bindingSpec,
      `project-binding/${row.project_root}/${row.client_id}`,
    ) as BindingSpec,
    provenance: decode(
      row.provenance_json,
      decoders.bindingProvenance,
      `project-binding/${row.project_root}/${row.client_id}/prov`,
    ) as BindingProvenance,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseSourceResume(row: SourceResumeRow): SourceResume | null {
  try {
    const spec = JSON.parse(row.spec_json) as BindingSpec;
    // Treat history as a cache: malformed or mismatched rows must never alter
    // an activation. Fresh successful applies will heal them naturally.
    if (
      !spec ||
      typeof spec !== 'object' ||
      spec.client !== row.client_id ||
      !spec.source ||
      serializeRef(spec.source) !== row.source_ref
    ) {
      return null;
    }
    return { client: row.client_id, spec, updatedAt: row.updated_at };
  } catch {
    return null;
  }
}

export class BindingStore {
  constructor(private readonly db: AnyPickDatabase) {}

  getGlobal(clientId: ClientId): GlobalBinding | null {
    const row = this.db
      .prepare(
        `SELECT client_id, spec_json, provenance_json, managed_config_revision,
                created_at, updated_at
         FROM global_bindings WHERE client_id = ?`,
      )
      .get(clientId) as BindingRow | undefined;
    return row ? parseGlobal(row) : null;
  }

  listGlobal(): GlobalBinding[] {
    const rows = this.db
      .prepare(
        `SELECT client_id, spec_json, provenance_json, managed_config_revision,
                created_at, updated_at
         FROM global_bindings ORDER BY client_id`,
      )
      .all() as unknown as BindingRow[];
    return rows.map(parseGlobal);
  }

  putGlobal(binding: GlobalBinding): void {
    this.db
      .prepare(
        `INSERT INTO global_bindings
           (client_id, spec_json, provenance_json, managed_config_revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET
           spec_json = excluded.spec_json,
           provenance_json = excluded.provenance_json,
           managed_config_revision = excluded.managed_config_revision,
           updated_at = excluded.updated_at`,
      )
      .run(
        binding.client,
        JSON.stringify(binding.spec),
        JSON.stringify(binding.provenance),
        binding.managedConfigRevision ?? null,
        binding.createdAt,
        binding.updatedAt,
      );
  }

  deleteGlobal(clientId: ClientId): boolean {
    const r = this.db.prepare(`DELETE FROM global_bindings WHERE client_id = ?`).run(clientId);
    return Number(r.changes) > 0;
  }

  getProject(projectRoot: string, clientId: ClientId): ProjectBinding | null {
    const row = this.db
      .prepare(
        `SELECT project_root, client_id, spec_json, provenance_json, created_at, updated_at
         FROM project_bindings WHERE project_root = ? AND client_id = ?`,
      )
      .get(projectRoot, clientId) as BindingRow | undefined;
    return row ? parseProject(row) : null;
  }

  listProject(projectRoot: string): ProjectBinding[] {
    const rows = this.db
      .prepare(
        `SELECT project_root, client_id, spec_json, provenance_json, created_at, updated_at
         FROM project_bindings WHERE project_root = ? ORDER BY client_id`,
      )
      .all(projectRoot) as unknown as BindingRow[];
    return rows.map(parseProject);
  }

  listAllProjects(): ProjectBinding[] {
    const rows = this.db
      .prepare(
        `SELECT project_root, client_id, spec_json, provenance_json, created_at, updated_at
         FROM project_bindings ORDER BY project_root, client_id`,
      )
      .all() as unknown as BindingRow[];
    return rows.map(parseProject);
  }

  /** Record a successful, source-specific setup for TUI resume. */
  recordSourceResume(spec: BindingSpec): void {
    // Presets are expanded by the planner before activation. Do not retain a
    // symbolic preset pointer as it can be edited or deleted independently.
    if (spec.source.kind === 'preset') {
      return;
    }
    const sourceRef = serializeRef(spec.source);
    this.db
      .prepare(
        `INSERT INTO source_resumes (source_ref, client_id, spec_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source_ref, client_id) DO UPDATE SET
           spec_json = excluded.spec_json,
           updated_at = excluded.updated_at`,
      )
      .run(sourceRef, spec.client, JSON.stringify(spec), nowIso());
  }

  /** Most recently successful compatible setups for a concrete source. */
  listSourceResumes(source: BindingSpec['source']): SourceResume[] {
    if (source.kind === 'preset') {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT source_ref, client_id, spec_json, updated_at
         FROM source_resumes WHERE source_ref = ?
         ORDER BY updated_at DESC, client_id ASC`,
      )
      .all(serializeRef(source)) as unknown as SourceResumeRow[];
    return rows.map(parseSourceResume).filter((row): row is SourceResume => row !== null);
  }

  putProject(binding: ProjectBinding): void {
    this.db
      .prepare(
        `INSERT INTO project_bindings
           (project_root, client_id, spec_json, provenance_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_root, client_id) DO UPDATE SET
           spec_json = excluded.spec_json,
           provenance_json = excluded.provenance_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        binding.projectRoot,
        binding.client,
        JSON.stringify(binding.spec),
        JSON.stringify(binding.provenance),
        binding.createdAt,
        binding.updatedAt,
      );
  }

  deleteProject(projectRoot: string, clientId?: ClientId): number {
    if (clientId) {
      const r = this.db
        .prepare(`DELETE FROM project_bindings WHERE project_root = ? AND client_id = ?`)
        .run(projectRoot, clientId);
      return Number(r.changes);
    }
    const r = this.db
      .prepare(`DELETE FROM project_bindings WHERE project_root = ?`)
      .run(projectRoot);
    return Number(r.changes);
  }

  /** Upsert helper that preserves createdAt when updating. */
  upsertGlobal(
    client: ClientId,
    spec: BindingSpec,
    provenance: BindingProvenance,
    managedConfigRevision?: string,
  ): GlobalBinding {
    return this.db.transaction(() => {
      const existing = this.getGlobal(client);
      const ts = nowIso();
      const binding: GlobalBinding = {
        client,
        spec,
        provenance,
        managedConfigRevision,
        createdAt: existing?.createdAt ?? ts,
        updatedAt: ts,
      };
      this.putGlobal(binding);
      return binding;
    });
  }

  upsertProject(
    projectRoot: string,
    client: ClientId,
    spec: BindingSpec,
    provenance: BindingProvenance,
  ): ProjectBinding {
    return this.db.transaction(() => {
      const existing = this.getProject(projectRoot, client);
      const ts = nowIso();
      const binding: ProjectBinding = {
        projectRoot,
        client,
        spec,
        provenance,
        createdAt: existing?.createdAt ?? ts,
        updatedAt: ts,
      };
      this.putProject(binding);
      return binding;
    });
  }
}
