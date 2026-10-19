import type { Snapshot } from './contract';

/**
 * The desktop wire format, decoded in one place.
 *
 * Every service frame is `KIND\tBASE64_STD_ENCODED_JSON` (ADR 0019 §3). The
 * macOS app decodes the same frames in `AppServiceClient.swift`, and the engine
 * is strict in both directions: an unknown field in a command is a rejected
 * frame, and an unknown kind is a dropped one. So the decoder here is an
 * explicit allowlist rather than a `switch` with a default branch — a frame
 * kind the UI does not understand must be ignored, never half-rendered.
 */

export const PROTOCOL_VERSION = 2;
export const MESSAGE_VERSION = 1;

/** Frame kinds the UI acts on. Anything else is ignored on purpose. */
export const UI_FRAME_KINDS = [
  'snapshot',
  'snapshot-event',
  'result',
  'logs',
  'backup-preview',
  'doctor',
  'usage-event',
  'protocol-error',
] as const;

export type UIFrameKind = (typeof UI_FRAME_KINDS)[number];

export type ResultStatus = 'success' | 'error' | 'cancelled';

export type Suggestion = { text: string; action?: string };

export type ServiceResult = {
  requestId: string;
  status: ResultStatus;
  message: string;
  code?: string;
  suggestions?: Suggestion[];
  /** True when a failed operation still changed state. */
  mutated?: boolean;
  /** Secrets arrive only here, never in a snapshot or a message (ADR 0006). */
  payload?: Record<string, unknown>;
};

export type LogsFrame = {
  requestId: string;
  proxyId: string;
  /** 'ready' | 'empty' | 'not-running' | 'error' */
  state: string;
  text: string;
};

export type BackupPreviewEntry = {
  id: string;
  providerId: string;
  name: string;
  label: string;
  /** 'create' | 'replace' | 'keep' | 'blocked' | 'unavailable' */
  disposition: string;
  reason: string;
};

export type BackupPreviewFrame = {
  requestId: string;
  status: 'ready' | 'error';
  inspectionId: string;
  createdAt: string;
  entries: BackupPreviewEntry[];
  code?: string;
  reason?: string;
  message?: string;
};

export type DoctorFrame = {
  requestId: string;
  status: string;
  findings: Array<{ check: string; status: string; detail: string }>;
};

export type ServiceFrame =
  | { kind: 'snapshot'; snapshot: Snapshot }
  | { kind: 'snapshot-event'; snapshot: Snapshot; reason: string; revision: number }
  | { kind: 'usage-event'; revision: number; usage: Snapshot['usage'] }
  | { kind: 'result'; result: ServiceResult }
  | { kind: 'logs'; logs: LogsFrame }
  | { kind: 'backup-preview'; preview: BackupPreviewFrame }
  | { kind: 'doctor'; report: DoctorFrame }
  | { kind: 'protocol-error'; code: string; message: string; requestId?: string };

function decodeBase64Utf8(encoded: string): string {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown): boolean {
  return value === true;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function suggestions(value: unknown): Suggestion[] {
  if (!Array.isArray(value)) return [];
  return value.filter(record).map((item) => ({
    text: str(item.text ?? item.title ?? item.label),
    action: typeof item.action === 'string' ? item.action : undefined,
  }));
}

function status(value: unknown): ResultStatus {
  return value === 'success' || value === 'cancelled' ? value : 'error';
}

export function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The wire form of a command, for the bridge's `send_command`. */
export function encodeCommand(kind: string, payload?: unknown): string {
  if (payload === undefined) return kind;
  return `${kind}\t${encodeBase64Utf8(JSON.stringify(payload))}`;
}

/**
 * Decode one line from the service. Returns null for anything the UI does not
 * act on, including malformed lines: a corrupt frame must not take the window
 * down, and it must not be rendered as an empty state either.
 */
export function decodeFrame(line: string): ServiceFrame | null {
  const tab = line.indexOf('\t');
  if (tab < 0) return null;
  const kind = line.slice(0, tab);
  if (!(UI_FRAME_KINDS as readonly string[]).includes(kind)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Utf8(line.slice(tab + 1)));
  } catch {
    return null;
  }
  if (!record(payload)) return null;
  // Frames that declare a protocolVersion must match ours. Missing is fine
  // (legacy / bare snapshot); a mismatch is ignored like any other bad frame.
  if ('protocolVersion' in payload && payload.protocolVersion !== PROTOCOL_VERSION) {
    return null;
  }

  switch (kind) {
    case 'snapshot': {
      // The first state frame is a bare snapshot with no envelope.
      return typeof payload.revision === 'number' ? { kind, snapshot: payload as unknown as Snapshot } : null;
    }
    case 'snapshot-event': {
      const snapshot = payload.snapshot;
      if (!record(snapshot) || typeof snapshot.revision !== 'number') return null;
      return {
        kind,
        snapshot: snapshot as unknown as Snapshot,
        reason: str(payload.reason),
        revision: num(payload.revision),
      };
    }
    case 'usage-event':
      return {
        kind,
        revision: num(payload.revision),
        usage: Array.isArray(payload.usage) ? (payload.usage as Snapshot['usage']) : [],
      };
    case 'result':
      return {
        kind,
        result: {
          requestId: str(payload.requestId),
          // A cancelled command is a user decision, not a failure: the engine
          // clears code/suggestions/mutated, so the status must be read first.
          status: status(payload.status),
          message: str(payload.message),
          code: typeof payload.code === 'string' ? payload.code : undefined,
          suggestions: suggestions(payload.suggestions),
          mutated: typeof payload.mutated === 'boolean' ? payload.mutated : undefined,
          payload: record(payload.payload) ? payload.payload : undefined,
        },
      };
    case 'logs':
      return {
        kind,
        logs: {
          requestId: str(payload.requestId),
          proxyId: str(payload.proxyId),
          state: str(payload.state),
          text: str(payload.text),
        },
      };
    case 'backup-preview':
      return {
        kind,
        preview: {
          requestId: str(payload.requestId),
          status: payload.status === 'ready' ? 'ready' : 'error',
          inspectionId: str(payload.inspectionId),
          createdAt: str(payload.createdAt),
          entries: Array.isArray(payload.entries)
            ? payload.entries.filter(record).map((entry) => ({
                id: str(entry.id),
                providerId: str(entry.providerId),
                name: str(entry.name),
                label: str(entry.label),
                disposition: str(entry.disposition),
                reason: str(entry.reason),
              }))
            : [],
          code: typeof payload.code === 'string' ? payload.code : undefined,
          reason: typeof payload.reason === 'string' ? payload.reason : undefined,
          message: typeof payload.message === 'string' ? payload.message : undefined,
        },
      };
    case 'doctor':
      // Doctor reports carry the request id so the UI can release the request
      // after the host delivers the report.
      return {
        kind,
        report: {
          requestId: str(payload.requestId),
          status: str(payload.status),
          findings: Array.isArray(payload.findings)
            ? payload.findings.filter(record).map((finding) => ({
                check: str(finding.check),
                status: str(finding.status),
                detail: str(finding.detail),
              }))
            : [],
        },
      };
    case 'protocol-error':
      return {
        kind,
        code: str(payload.code),
        message: str(payload.message),
        requestId: typeof payload.requestId === 'string' ? payload.requestId : undefined,
      };
    default:
      return null;
  }
}

/** The request identity a command carries, so a result can be matched to it. */
export function newRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function invokeCommand(
  actionId: string,
  revision: number,
  requestId: string,
  allowForeignConfig = false,
): string {
  return encodeCommand('invoke', {
    version: MESSAGE_VERSION,
    requestId,
    revision,
    actionId,
    ...(allowForeignConfig ? { allowForeignConfig: true } : {}),
  });
}

export type MutateExtra = Record<string, unknown>;

/**
 * Build a `mutate` line. The engine rejects any key that is not on the
 * operation's allowlist, with a `MALFORMED_FRAME` that names nothing useful,
 * so callers pass only what the operation documents.
 */
export function mutateCommand(
  operation: string,
  extra: MutateExtra,
  requestId: string,
): string {
  return encodeCommand('mutate', { version: MESSAGE_VERSION, requestId, operation, ...extra });
}

export function modelRolesCommand(
  clientId: string,
  roleActionIds: Record<string, string>,
  revision: number,
  requestId: string,
  scope?: 'connection' | 'provider',
): string {
  return encodeCommand('model-roles', {
    version: MESSAGE_VERSION,
    requestId,
    revision,
    clientId,
    roleActionIds,
    ...(scope ? { scope } : {}),
  });
}

export function logsCommand(
  providerId: string,
  name: string,
  lines: number,
  requestId: string,
): string {
  return encodeCommand('logs', { version: MESSAGE_VERSION, requestId, providerId, name, lines });
}

export function backupInspectCommand(path: string, requestId: string): string {
  return encodeCommand('backup-inspect', { version: MESSAGE_VERSION, requestId, path });
}

export function cancelCommand(requestId: string): string {
  return encodeCommand('cancel', { version: MESSAGE_VERSION, requestId });
}

export function doctorCommand(requestId: string): string {
  return encodeCommand('doctor', { version: MESSAGE_VERSION, requestId });
}

/** True when the failure reported that state was changed anyway. */
export function partiallyMutated(result: ServiceResult): boolean {
  return result.status === 'error' && bool(result.mutated);
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  const text = String(error ?? '');
  return text || 'Unknown error';
}

export function describeResult(result: ServiceResult): string {
  if (result.status === 'cancelled') return result.message || 'Action cancelled.';
  if (result.status === 'success') return result.message || 'Action completed.';
  const suffix = partiallyMutated(result) ? ' (state was partially changed — run the Doctor)' : '';
  return `${result.message || 'Action failed.'}${suffix}`;
}

export function frameIsFor(frame: ServiceFrame, requestId: string): boolean {
  if (frame.kind === 'result') return frame.result.requestId === requestId;
  if (frame.kind === 'logs') return frame.logs.requestId === requestId;
  if (frame.kind === 'backup-preview') return frame.preview.requestId === requestId;
  if (frame.kind === 'protocol-error') return frame.requestId === requestId;
  return false;
}

export { strArray };
