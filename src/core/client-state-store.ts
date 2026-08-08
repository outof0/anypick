import type { ClientState } from '../types';
import { decode, decoders } from './codec';
import type { HotplugDatabase } from './db';
import { clientBackupDir, getHotplugRoot } from './paths';

/**
 * SQLite-backed client runtime state.
 * Client file backups remain on disk under clients/<id>/backup/.
 */
export class ClientStateStore {
  readonly root: string;
  readonly db: HotplugDatabase;

  constructor(root: string, db: HotplugDatabase) {
    this.root = getHotplugRoot(root);
    this.db = db;
  }

  async get(clientId: string): Promise<ClientState | null> {
    const row = this.db
      .prepare(`SELECT state_json FROM client_state WHERE client_id = ?`)
      .get(clientId) as { state_json: string } | undefined;
    if (!row) {
      return null;
    }
    try {
      return decode(
        row.state_json,
        decoders.clientState,
        `client-state/${clientId}`,
      ) as ClientState;
    } catch {
      return null;
    }
  }

  async list(): Promise<ClientState[]> {
    const rows = this.db.prepare(`SELECT state_json FROM client_state`).all() as Array<{
      state_json: string;
    }>;
    const out: ClientState[] = [];
    for (const row of rows) {
      try {
        out.push(decode(row.state_json, decoders.clientState, 'client-state/list') as ClientState);
      } catch {
        // skip corrupt
      }
    }
    return out;
  }

  async write(state: ClientState): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO client_state (client_id, state_json)
         VALUES (?, ?)
         ON CONFLICT(client_id) DO UPDATE SET state_json = excluded.state_json`,
      )
      .run(state.clientId, JSON.stringify(state));
  }

  async clear(clientId: string): Promise<void> {
    this.db.prepare(`DELETE FROM client_state WHERE client_id = ?`).run(clientId);
  }

  backupDir(clientId: string): string {
    return clientBackupDir(this.root, clientId);
  }
}
