import React from 'react';
import type { TuiShell } from '../use-tui-shell';
import {
  nextProviderFilter,
  providerFilterLabel,
  type ProviderFilterOption,
} from '../model/provider-filter';

export interface ProviderFilter {
  selectedId: string | undefined;
  label: (options: ProviderFilterOption[]) => string;
  cycle: (options: ProviderFilterOption[]) => void;
  clear: () => void;
}

export function useProviderFilter(shell: TuiShell): ProviderFilter {
  const [selectedId, setSelectedId] = React.useState<string | undefined>();

  return {
    selectedId,
    label: (options) => providerFilterLabel(selectedId, options),
    cycle: (options) => {
      setSelectedId(nextProviderFilter(selectedId, options));
      shell.setSelectedIndex(0);
    },
    clear: () => {
      setSelectedId(undefined);
      shell.setSelectedIndex(0);
    },
  };
}
