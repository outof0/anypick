import { randomUUID } from 'node:crypto';
import type { JournalState, OperationJournalEntry } from '../types';
import { decode, decoders } from './codec';
import type { AnyPickDatabase } from './db';

interface JournalRow {
  id: string;
  type: string;
  state: string;
  affected_resources_json: string;
  backup_paths_json: string;
  params_json: string | null;
  started_at: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parse(row: JournalRow): OperationJournalEntry {
  let affectedResources: unknown;
  let backupPaths: unknown;
  let params: unknown;
  try {
    affectedResources = JSON.parse(row.affected_resources_json);
    backupPaths = JSON.parse(row.backup_paths_json);
    params = row.params_json === null ? undefined : JSON.parse(row.params_json);
  } catch {
    // `decode` supplies a stable record kind while keeping stored values out
    // of the message (params may carry credential-adjacent metadata).
    return decode('{', decoders.journalEntry, `journal/${row.id}`);
  }
  return decode(
    JSON.stringify({
      id: row.id,
      type: row.type,
      state: row.state,
      affectedResources,
      backupPaths,
      params,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
    }),
    decoders.journalEntry,
    `journal/${row.id}`,
  );
}

export class OperationJournal {
  constructor(private readonly db: AnyPickDatabase) {}

  create(
    type: string,
    opts: {
      affectedResources?: string[];
      backupPaths?: string[];
      params?: Record<string, unknown>;
      state?: JournalState;
    } = {},
  ): OperationJournalEntry {
    const ts = nowIso();
    const entry: OperationJournalEntry = {
      id: randomUUID(),
      type,
      state: opts.state ?? 'planned',
      affectedResources: opts.affectedResources ?? [],
      backupPaths: opts.backupPaths ?? [],
      params: opts.params,
      startedAt: ts,
      updatedAt: ts,
    };
    this.db
      .prepare(
        `INSERT INTO operation_journal
           (id, type, state, affected_resources_json, backup_paths_json, params_json, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.type,
        entry.state,
        JSON.stringify(entry.affectedResources),
        JSON.stringify(entry.backupPaths),
        entry.params ? JSON.stringify(entry.params) : null,
        entry.startedAt,
        entry.updatedAt,
      );
    return entry;
  }

  get(id: string): OperationJournalEntry | null {
    const row = this.db
      .prepare(
        `SELECT id, type, state, affected_resources_json, backup_paths_json,
                params_json, started_at, updated_at
         FROM operation_journal WHERE id = ?`,
      )
      .get(id) as JournalRow | undefined;
    return row ? parse(row) : null;
  }

  update(
    id: string,
    patch: {
      state?: JournalState;
      backupPaths?: string[];
      affectedResources?: string[];
      params?: Record<string, unknown>;
    },
  ): OperationJournalEntry {
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`Journal entry not found: ${id}`);
    }
    const next: OperationJournalEntry = {
      ...existing,
      state: patch.state ?? existing.state,
      backupPaths: patch.backupPaths ?? existing.backupPaths,
      affectedResources: patch.affectedResources ?? existing.affectedResources,
      params: patch.params ?? existing.params,
      updatedAt: nowIso(),
    };
    this.db
      .prepare(
        `UPDATE operation_journal SET
           state = ?, affected_resources_json = ?, backup_paths_json = ?,
           params_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.state,
        JSON.stringify(next.affectedResources),
        JSON.stringify(next.backupPaths),
        next.params ? JSON.stringify(next.params) : null,
        next.updatedAt,
        id,
      );
    return next;
  }

  /** Incomplete entries that may need recovery on startup. */
  listIncomplete(): OperationJournalEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, type, state, affected_resources_json, backup_paths_json,
                params_json, started_at, updated_at
         FROM operation_journal
         WHERE state IN ('planned', 'executing', 'verifying', 'rolling_back')
         ORDER BY started_at`,
      )
      .all() as unknown as JournalRow[];
    return rows.map(parse);
  }

  listRecent(limit = 50): OperationJournalEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, type, state, affected_resources_json, backup_paths_json,
                params_json, started_at, updated_at
         FROM operation_journal
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as JournalRow[];
    return rows.map(parse);
  }
}
