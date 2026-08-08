export type TrayTab =
  | 'Apps'
  | 'Proxies'
  | 'Saved accounts'
  | 'Hub Sources'
  | 'Routing Issues'
  | 'Models'
  | 'Logs'
  | 'Settings';

export type FormState = Record<string, any> & {
  kind: string;
  providerId?: string;
  name?: string;
  label?: string;
  detail?: string;
  endpoint?: string;
  apiKey?: string;
  defaultModel?: string;
  detected?: boolean;
};

export type OverflowItem = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
};

export type PendingResult = { message?: string; status?: string; requestId?: string };

export type Notice = { message: string; isError: boolean } | null;

export interface TrayBridge {
  isDemo: boolean;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen: (
    event: string,
    handler: (event: { payload: string }) => void,
  ) => Promise<() => void>;
}

declare global {
  interface Window {
    __TAURI__?: {
      core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
      event: {
        listen: (
          event: string,
          handler: (event: { payload: string }) => void,
        ) => Promise<() => void>;
      };
    };
  }
}

export {};
