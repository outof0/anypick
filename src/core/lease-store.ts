import { randomUUID } from 'node:crypto';
import type { ProxyLease } from '../types';
import { decode } from './codec';
import { decoders } from './codec';
import type { HotplugDatabase } from './db';

interface LeaseRow {
  lease_id: string;
  provider: string;
  account: string | null;
  port: number;
  host: string;
  endpoint: string | null;
  owner_pid: number;
  instance_id: string | null;
  binding_refs_json: string;
  created_at: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parse(row: LeaseRow): ProxyLease {
  return decode(
    JSON.stringify({
      leaseId: row.lease_id,
      provider: row.provider,
      account: row.account ?? undefined,
      port: row.port,
      host: row.host,
      endpoint: row.endpoint ?? undefined,
      ownerPid: row.owner_pid,
      instanceId: row.instance_id ?? undefined,
      bindingRefs: JSON.parse(row.binding_refs_json) as string[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
    decoders.proxyLease,
    `lease/${row.lease_id}`,
  );
}

export class LeaseStore {
  constructor(private readonly db: HotplugDatabase) {}

  create(opts: {
    provider: string;
    account?: string;
    port: number;
    host?: string;
    endpoint?: string;
    ownerPid?: number;
    instanceId?: string;
    bindingRefs?: string[];
  }): ProxyLease {
    const ts = nowIso();
    const lease: ProxyLease = {
      leaseId: randomUUID(),
      provider: opts.provider,
      account: opts.account,
      port: opts.port,
      host: opts.host ?? '127.0.0.1',
      endpoint: opts.endpoint,
      ownerPid: opts.ownerPid ?? process.pid,
      instanceId: opts.instanceId,
      bindingRefs: opts.bindingRefs ?? [],
      createdAt: ts,
      updatedAt: ts,
    };
    this.db
      .prepare(
        `INSERT INTO proxy_leases
           (lease_id, provider, account, port, host, endpoint, owner_pid,
            instance_id, binding_refs_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        lease.leaseId,
        lease.provider,
        lease.account ?? null,
        lease.port,
        lease.host,
        lease.endpoint ?? null,
        lease.ownerPid,
        lease.instanceId ?? null,
        JSON.stringify(lease.bindingRefs),
        lease.createdAt,
        lease.updatedAt,
      );
    return lease;
  }

  get(leaseId: string): ProxyLease | null {
    const row = this.db
      .prepare(
        `SELECT lease_id, provider, account, port, host, endpoint, owner_pid, instance_id,
                binding_refs_json, created_at, updated_at
         FROM proxy_leases WHERE lease_id = ?`,
      )
      .get(leaseId) as LeaseRow | undefined;
    return row ? parse(row) : null;
  }

  list(): ProxyLease[] {
    const rows = this.db
      .prepare(
        `SELECT lease_id, provider, account, port, host, endpoint, owner_pid, instance_id,
                binding_refs_json, created_at, updated_at
         FROM proxy_leases ORDER BY created_at`,
      )
      .all() as unknown as LeaseRow[];
    return rows.map(parse);
  }

  findByProviderAccount(provider: string, account?: string): ProxyLease | null {
    const row = account
      ? (this.db
          .prepare(
            `SELECT lease_id, provider, account, port, host, endpoint, owner_pid, instance_id,
                    binding_refs_json, created_at, updated_at
             FROM proxy_leases WHERE provider = ? AND account = ?
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(provider, account) as LeaseRow | undefined)
      : (this.db
          .prepare(
            `SELECT lease_id, provider, account, port, host, endpoint, owner_pid, instance_id,
                    binding_refs_json, created_at, updated_at
             FROM proxy_leases WHERE provider = ? AND account IS NULL
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(provider) as LeaseRow | undefined);
    return row ? parse(row) : null;
  }

  release(leaseId: string): boolean {
    const r = this.db.prepare(`DELETE FROM proxy_leases WHERE lease_id = ?`).run(leaseId);
    return Number(r.changes) > 0;
  }

  releaseByProviderAccount(provider: string, account?: string): number {
    const r = account
      ? this.db
          .prepare(`DELETE FROM proxy_leases WHERE provider = ? AND account = ?`)
          .run(provider, account)
      : this.db
          .prepare(`DELETE FROM proxy_leases WHERE provider = ? AND account IS NULL`)
          .run(provider);
    return Number(r.changes);
  }
}
