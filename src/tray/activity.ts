import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withMutationLocks } from '../core/mutation-lock';
import { pathExists, readJsonFile, writeJsonFile } from '../utils/fs';

export type TrayActivityKind =
  | 'switch'
  | 'account'
  | 'gateway'
  | 'proxy'
  | 'quota'
  | 'settings'
  | 'system';

export interface TrayActivityRecord {
  id: string;
  createdAt: string;
  message: string;
  isError: boolean;
  kind: TrayActivityKind;
  dedupeKey?: string;
}

const MAX_ACTIVITY = 200;

/** Persistent, secret-free tray history. Mutations own their coordinator lock. */
export class TrayActivityService {
  private readonly path: string;

  constructor(private readonly root: string) {
    this.path = join(root, 'activity', 'tray.json');
  }

  async list(): Promise<TrayActivityRecord[]> {
    if (!(await pathExists(this.path))) {
      return [];
    }
    try {
      const value = await readJsonFile<unknown>(this.path);
      if (!Array.isArray(value)) {
        return [];
      }
      return value.filter(isActivityRecord).slice(0, MAX_ACTIVITY);
    } catch {
      return [];
    }
  }

  async record(
    message: string,
    isError: boolean,
    kind: TrayActivityKind,
    dedupeKey?: string,
  ): Promise<TrayActivityRecord> {
    return withMutationLocks(this.root, ['tray/activity'], async () => {
      const current = await this.list();
      const existing = dedupeKey
        ? current.find((entry) => entry.dedupeKey === dedupeKey)
        : undefined;
      if (existing) {
        return existing;
      }
      const record: TrayActivityRecord = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        message: message.replace(/\s+/gu, ' ').trim().slice(0, 240),
        isError,
        kind,
        ...(dedupeKey ? { dedupeKey: dedupeKey.slice(0, 160) } : {}),
      };
      await writeJsonFile(this.path, [record, ...current].slice(0, MAX_ACTIVITY));
      return record;
    });
  }
}

function isActivityRecord(value: unknown): value is TrayActivityRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    typeof item.createdAt === 'string' &&
    !Number.isNaN(Date.parse(item.createdAt)) &&
    typeof item.message === 'string' &&
    item.message.length <= 240 &&
    typeof item.isError === 'boolean' &&
    (item.kind === 'switch' ||
      item.kind === 'account' ||
      item.kind === 'gateway' ||
      item.kind === 'proxy' ||
      item.kind === 'quota' ||
      item.kind === 'settings' ||
      item.kind === 'system') &&
    (item.dedupeKey === undefined ||
      (typeof item.dedupeKey === 'string' && item.dedupeKey.length <= 160))
  );
}
