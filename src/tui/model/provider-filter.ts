import type { GatewayRow } from './gateway';
import type { AnyPickHomeModel } from './anypick';

export interface ProviderFilterOption {
  id: string;
  label: string;
}

function uniqueOptions(options: ProviderFilterOption[]): ProviderFilterOption[] {
  const seen = new Set<string>();
  return options
    .filter((option) => {
      if (!option.id || seen.has(option.id)) {
        return false;
      }
      seen.add(option.id);
      return true;
    })
    .toSorted((left, right) => left.label.localeCompare(right.label));
}

export function accountProviderFilterOptions(model: AnyPickHomeModel): ProviderFilterOption[] {
  return uniqueOptions(
    model.providers.map((provider) => ({
      id: provider.providerId,
      label: provider.providerName,
    })),
  );
}

export function gatewayProviderFilterOptions(rows: GatewayRow[]): ProviderFilterOption[] {
  return uniqueOptions(
    rows.map((row) => ({
      id: row.providerId,
      label: row.providerName,
    })),
  );
}

export function filterHomeByProvider(
  model: AnyPickHomeModel,
  providerId?: string,
): AnyPickHomeModel {
  if (!providerId) {
    return model;
  }
  return {
    ...model,
    providers: model.providers.filter((provider) => provider.providerId === providerId),
    rows: model.rows.filter((row) => row.providerId === providerId),
  };
}

export function filterGatewaysByProvider(rows: GatewayRow[], providerId?: string): GatewayRow[] {
  return providerId ? rows.filter((row) => row.providerId === providerId) : rows;
}

/** Cycle All → each provider → All without making an empty option sticky. */
export function nextProviderFilter(
  selectedId: string | undefined,
  options: ProviderFilterOption[],
): string | undefined {
  if (options.length === 0) {
    return undefined;
  }
  if (!selectedId) {
    return options[0]?.id;
  }
  const index = options.findIndex((option) => option.id === selectedId);
  return index < 0 || index === options.length - 1 ? undefined : options[index + 1]?.id;
}

export function providerFilterLabel(
  selectedId: string | undefined,
  options: ProviderFilterOption[],
): string {
  return options.find((option) => option.id === selectedId)?.label ?? 'All providers';
}
