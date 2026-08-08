import type { ProxyRow } from './types';

export function proxyRowLabel(row: ProxyRow): string {
  if (row.displayRef) {
    return row.displayRef;
  }
  if (row.rowKind === 'pool') {
    return `pool:${row.providerId}`;
  }
  if (row.rowKind === 'unsaved') {
    return `${row.providerId} · not saved`;
  }
  if (row.rowKind === 'hub') {
    return `hub:${row.name}`;
  }
  return `${row.providerId}/${row.name}`;
}

/** Binding source string for apps (account or pool). */
export function proxyBindingRef(row: ProxyRow): string {
  if (row.rowKind === 'pool') {
    return `pool:${row.providerId}`;
  }
  if (row.rowKind === 'hub') {
    return `hub:${row.name}`;
  }
  return `${row.providerId}/${row.name}`;
}
