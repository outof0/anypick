import { isAnyPickError, type AnyPickError } from '../utils/errors';
import { MARK, getUxMode, printError } from './ux';

export function handleCliError(err: unknown): never {
  const mode = getUxMode();
  if (isAnyPickError(err)) {
    if (mode.json) {
      console.log(JSON.stringify(err.toJson()));
    } else {
      printError(err.toHuman());
    }
    process.exit(err.exitCode);
  }
  const message = err instanceof Error ? err.message : String(err);
  if (mode.json) {
    console.log(
      JSON.stringify({
        error: { code: 'ERROR', message, suggestions: [], mutated: false },
      }),
    );
  } else {
    printError(message);
  }
  process.exit(1);
}

export function formatUseSuccess(opts: {
  clientName: string;
  sourceDisplay: string;
  model?: string;
  transport?: string;
  scope?: string;
  alreadyActive?: boolean;
  savedPreset?: string;
  /** Written into client native config (e.g. ~/.claude/settings.json env). */
  configEndpoint?: string;
}): string {
  if (opts.alreadyActive) {
    const lines = [
      `${MARK.done} ${opts.clientName} already uses ${opts.sourceDisplay} (config re-synced)`,
      '',
    ];
    if (opts.model) {
      lines.push(`  Model      ${opts.model}`);
    }
    if (opts.transport) {
      lines.push(`  Transport  ${opts.transport}`);
    }
    if (opts.configEndpoint) {
      lines.push(`  Config     ANTHROPIC_BASE_URL=${opts.configEndpoint}`);
    }
    if (opts.savedPreset) {
      lines.push(`  Saved      @${opts.savedPreset}`);
    }
    return lines.join('\n');
  }
  const lines = [`${MARK.done} ${opts.clientName} now uses ${opts.sourceDisplay}`, ''];
  if (opts.model) {
    lines.push(`  Model      ${opts.model}`);
  }
  if (opts.transport) {
    lines.push(`  Transport  ${opts.transport}`);
  }
  if (opts.configEndpoint) {
    lines.push(`  Config     ANTHROPIC_BASE_URL=${opts.configEndpoint}`);
  }
  if (opts.scope) {
    lines.push(`  Scope      ${opts.scope}`);
  }
  if (opts.savedPreset) {
    lines.push(`  Saved      @${opts.savedPreset}`);
  }
  return lines.join('\n');
}

export function formatModel(model: { mode: string; id?: string; reason?: string }): string {
  if (model.mode === 'explicit' && model.id) {
    return model.id;
  }
  if (model.mode === 'omitted') {
    return 'omitted · client/source default';
  }
  if (model.mode === 'unknown') {
    return 'unknown · migrated legacy state';
  }
  return model.mode;
}

export type { AnyPickError };
