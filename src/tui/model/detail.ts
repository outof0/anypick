import type { AnyPickApp } from '../../core/app';
import type { DoctorFixPlan } from '../../core/doctor';
import type { ProxyStatus } from '../../types';
import { providerCapabilities } from '../../core/capabilities';
import type { AccountDetailModel, HealthModel } from './types';
import { deriveLiveRelation, formatRelativeTime, proxyStateLabel } from './identity';
import { liveSummary, safeCurrent } from './root';

export async function loadAccountDetail(
  app: AnyPickApp,
  providerId: string,
  name: string,
  nowMs = Date.now(),
): Promise<AccountDetailModel> {
  const provider = app.accounts.provider(providerId);
  const caps = providerCapabilities(provider);
  const account = await app.accounts.get(providerId, name);
  if (!account) {
    throw new Error(`Account ${providerId}/${name} not found.`);
  }
  const cur = await safeCurrent(app, providerId);
  const live = cur.ok ? cur.data.live : { present: false };
  const active = cur.ok ? cur.data.active : null;
  const isActive = active === account.meta.name;

  let proxy: ProxyStatus | null = null;
  if (caps.canProxy) {
    try {
      proxy = await app.proxy.proxyStatus(providerId, name);
    } catch {
      proxy = {
        enabled: account.proxy.enabled,
        running: false,
        port: account.proxy.port,
        host: account.proxy.host,
        detail: 'unavailable',
      };
    }
  }

  const relation = deriveLiveRelation({
    savedCount: 1,
    livePresent: live.present,
    liveIdentity: live.identity,
    activeName: isActive ? name : active,
    activeIdentity: isActive ? account.meta.identity : undefined,
    savedIdentities: [account.meta.identity],
  });

  // If this account is not active, relation is about pool — simplify
  let relationSummary: string;
  if (!isActive) {
    relationSummary = 'Saved snapshot (not active).';
  } else {
    relationSummary = liveSummary(relation, providerId, name, live);
  }

  return {
    providerId,
    displayName: provider.name,
    name: account.meta.name,
    canonical: `${providerId}/${account.meta.name}`,
    label: account.meta.label,
    identity: account.meta.identity,
    createdAt: account.meta.createdAt,
    updatedAt: account.meta.updatedAt,
    updatedRelative: formatRelativeTime(account.meta.updatedAt, nowMs),
    active: isActive,
    relation: isActive ? relation : 'unknown',
    relationSummary,
    canProxy: caps.canProxy,
    canRefresh: caps.canRefresh,
    proxy,
    proxyStateLabel: proxy ? proxyStateLabel(proxy) : undefined,
    snapshotDir: account.snapshotDir,
    accountDir: account.accountDir,
  };
}

export async function loadHealthModel(app: AnyPickApp): Promise<HealthModel> {
  const report = await app.doctor.run();
  let plan: DoctorFixPlan | null = null;
  try {
    plan = await app.doctor.planFixes();
  } catch {
    plan = null;
  }

  const failed = report.checks.filter((c) => !c.ok);
  const accountProxy = failed.filter((c) =>
    /account|proxy|auth|pid|lock|credential/i.test(`${c.id} ${c.message}`),
  );
  const other = failed.filter((c) => !accountProxy.includes(c));
  const ok = report.checks.filter((c) => c.ok);
  const prioritized = [...accountProxy, ...other, ...ok];

  return { report, plan, prioritized };
}

// ── Final TUI: AnyPick home + Claude bind status ─────────────────

/** Account row for Switch (under a tool group). */
