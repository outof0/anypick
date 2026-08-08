/**
 * Exit codes per hotplug-cli-dx-redesign-spec §25.2
 *
 * Reserved ranges (do NOT reuse for new program errors):
 *   0                — success
 *   1–127            — program/operational errors (hotplug's own)
 *   128 + N (128–255) — process terminated by signal N (e.g. 130 = SIGINT)
 *   Known program codes below:
 *     0 SUCCESS, 1 OPERATIONAL, 2 INVALID_USAGE, 3 NOT_FOUND,
 *     4 AUTH_REQUIRED, 5 CAPABILITY_CONFLICT, 6 HEALTH_FAILURE,
 *     7 MISSING_DEPENDENCY, 130 CANCELLED (SIGINT)
 */
export const ExitCode = {
  SUCCESS: 0,
  OPERATIONAL: 1,
  INVALID_USAGE: 2,
  NOT_FOUND: 3,
  AUTH_REQUIRED: 4,
  CAPABILITY_CONFLICT: 5,
  HEALTH_FAILURE: 6,
  MISSING_DEPENDENCY: 7,
  /** Malformed / untrusted import envelope (SEC-01). */
  IMPORT_FORMAT: 8,
  /** Import exceeds file-count / size / total-size limits (SEC-01). */
  IMPORT_LIMIT: 9,
  /** 128 + SIGINT: process was interrupted (Ctrl-C). */
  CANCELLED: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export interface HotplugErrorOptions {
  code?: string;
  exitCode?: ExitCodeValue;
  suggestions?: string[];
  mutated?: boolean;
  /** Extra fields for JSON error payloads. */
  details?: Record<string, unknown>;
}

export class HotplugError extends Error {
  readonly code?: string;
  readonly exitCode: ExitCodeValue;
  readonly suggestions: string[];
  mutated: boolean;
  readonly details?: Record<string, unknown>;

  constructor(message: string, codeOrOpts?: string | HotplugErrorOptions) {
    super(message);
    this.name = 'HotplugError';
    if (typeof codeOrOpts === 'string' || codeOrOpts === undefined) {
      this.code = codeOrOpts;
      this.exitCode = ExitCode.OPERATIONAL;
      this.suggestions = [];
      this.mutated = false;
    } else {
      this.code = codeOrOpts.code;
      this.exitCode = codeOrOpts.exitCode ?? ExitCode.OPERATIONAL;
      this.suggestions = codeOrOpts.suggestions ?? [];
      this.mutated = codeOrOpts.mutated ?? false;
      this.details = codeOrOpts.details;
    }
  }

  toJson(): {
    error: {
      code: string;
      message: string;
      suggestions: string[];
      mutated: boolean;
      [key: string]: unknown;
    };
  } {
    return {
      error: {
        code: this.code ?? 'ERROR',
        message: this.message,
        suggestions: this.suggestions,
        mutated: this.mutated,
        ...this.details,
      },
    };
  }

  /** Human multi-line error with suggestions and "No configuration was changed." when applicable. */
  toHuman(): string {
    const lines = [this.message, ''];
    if (this.suggestions.length > 0) {
      for (const s of this.suggestions) {
        lines.push(s);
      }
      lines.push('');
    }
    if (!this.mutated) {
      lines.push('No configuration was changed.');
    }
    return lines.join('\n').trimEnd();
  }
}

export function isHotplugError(err: unknown): err is HotplugError {
  return err instanceof HotplugError;
}

/** Map a common error code string to a default exit code. */
export function exitCodeForErrorCode(code: string | undefined): ExitCodeValue {
  switch (code) {
    case 'INVALID_USAGE':
    case 'MISSING_CLIENT':
    case 'MISSING_SOURCE':
    case 'PRESET_CLIENT_MISMATCH':
    case 'INVALID_REFERENCE':
      return ExitCode.INVALID_USAGE;
    case 'RESOURCE_NOT_FOUND':
    case 'ACCOUNT_NOT_FOUND':
    case 'GATEWAY_NOT_FOUND':
    case 'PRESET_NOT_FOUND':
    case 'CLIENT_NOT_FOUND':
      return ExitCode.NOT_FOUND;
    case 'AUTH_REQUIRED':
    case 'LOGIN_REQUIRED':
      return ExitCode.AUTH_REQUIRED;
    case 'CAPABILITY_CONFLICT':
    case 'UNSUPPORTED_TRANSPORT':
    case 'STATE_CONFLICT':
    case 'NO_ACTIVE_BINDING':
    case 'MODEL_UNKNOWN':
      return ExitCode.CAPABILITY_CONFLICT;
    case 'HEALTH_FAILURE':
    case 'VERIFY_FAILED':
      return ExitCode.HEALTH_FAILURE;
    case 'MISSING_DEPENDENCY':
    case 'EXTERNAL_PROXY_MISSING':
      return ExitCode.MISSING_DEPENDENCY;
    case 'IMPORT_FORMAT':
    case 'IMPORT_MISSING':
      return ExitCode.IMPORT_FORMAT;
    case 'IMPORT_LIMIT':
      return ExitCode.IMPORT_LIMIT;
    case 'ACCOUNT_EXISTS':
      return ExitCode.INVALID_USAGE;
    case 'CANCELLED':
      return ExitCode.CANCELLED;
    default:
      return ExitCode.OPERATIONAL;
  }
}

export function hotplugError(
  message: string,
  code: string,
  opts: Omit<HotplugErrorOptions, 'code'> = {},
): HotplugError {
  return new HotplugError(message, {
    code,
    exitCode: opts.exitCode ?? exitCodeForErrorCode(code),
    suggestions: opts.suggestions,
    mutated: opts.mutated,
    details: opts.details,
  });
}
