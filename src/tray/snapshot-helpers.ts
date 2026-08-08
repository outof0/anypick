import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AnyPickApp } from '../core/app';
import { displayRef } from '../core/refs';
import type { BindingSpec, ClientAdapter, ProxyHubSourceRef, ResourceRef } from '../types';
import type { ListedAccount } from '../core/service';
import { pathExists } from '../utils/fs';
import { resolveBinary } from '../utils/process';
import type { TrayAccountProviderSnapshot } from './snapshot-types';

export function accountProviderPriority(
  provider: Pick<TrayAccountProviderSnapshot, 'providerId' | 'sourceId'>,
): number {
  const id = `${provider.providerId}:${provider.sourceId ?? ''}`.toLowerCase();
  if (id.includes('codex') || id.includes('openai')) {
    return 0;
  }
  if (id.includes('claude') || id.includes('anthropic')) {
    return 1;
  }
  if (id.includes('gemini') || id.includes('antigravity')) {
    return 2;
  }
  if (id.includes('kiro')) {
    return 3;
  }
  return 10;
}

export function primaryModel(spec: BindingSpec): string | undefined {
  if (spec.model.mode === 'explicit') {
    return spec.model.id;
  }
  const roles = spec.clientOptions.modelRoles;
  if (!roles || typeof roles !== 'object' || !('default' in roles)) {
    return undefined;
  }
  return typeof roles.default === 'string' ? roles.default : undefined;
}

export function traySourceDisplay(source: ResourceRef): string {
  switch (source.kind) {
    case 'account':
      return `${source.provider}/${source.name}`;
    case 'account-pool':
      return `pool:${source.provider}`;
    case 'gateway':
      return source.name;
    case 'proxy-hub':
      return 'Proxy Hub';
    case 'preset':
      return `@${source.name}`;
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

export function humanizeSourceId(sourceId: string): string {
  return sourceId
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) =>
      part.length <= 3 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(' ');
}

export async function nativeSourceInstalled(
  client: ClientAdapter,
  sourceId: string,
): Promise<boolean> {
  const probes = client.nativeInstallations?.filter((probe) => probe.sourceId === sourceId) ?? [];
  if (probes.length === 0) {
    return false;
  }
  for (const probe of probes) {
    if (probe.executables?.length && (await resolveBinary([...probe.executables]))) {
      return true;
    }
    if (process.platform === 'darwin') {
      for (const application of probe.macApplications ?? []) {
        if (
          (await pathExists(join('/Applications', application))) ||
          (await pathExists(join(homedir(), 'Applications', application)))
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Best-effort provider family from a model ID for display purposes.
 * Used in hub route model pickers where the upstream account provider
 * (e.g. "opencode") would be misleading as a provider badge.
 */
export function modelFamilyForId(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.startsWith('claude-')) {
    return 'anthropic';
  }
  if (
    id.startsWith('gpt-') ||
    id.startsWith('o1-') ||
    id.startsWith('o3-') ||
    id.startsWith('o4-')
  ) {
    return 'openai';
  }
  if (id.startsWith('gemini-')) {
    return 'gemini';
  }
  if (id.startsWith('grok-')) {
    return 'grok';
  }
  return modelId;
}

export function hubSourcePresentation(
  app: Pick<AnyPickApp, 'accountRegistry'>,
  accounts: readonly ListedAccount[],
  source: ProxyHubSourceRef,
): { label: string; detail: string } {
  const provider = app.accountRegistry.get(source.provider);
  const providerLabel = provider.shortName ?? provider.name;
  if (source.kind === 'account-pool') {
    return { label: `${providerLabel} pool`, detail: 'Managed account pool' };
  }
  const account = accounts.find(
    (candidate) => candidate.provider === source.provider && candidate.name === source.name,
  );
  return {
    label: account?.label ?? source.name,
    detail: [providerLabel, account?.identity ?? displayRef(source)].filter(Boolean).join(' · '),
  };
}
