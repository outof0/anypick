/**
 * Root command-center launcher using @clack/core SelectPrompt + custom render.
 * Does NOT use @clack/prompts intro/note/select/outro chrome.
 */

import { SelectPrompt, isCancel, updateSettings } from '@clack/core';
import { buildLauncherModel, type LauncherAction, type LauncherModel } from './launcher-model';
import { cursorForActionId, orderedActions, renderLauncherFrame } from './launcher-render';
import type { AnyPickApp } from '../core/app';
import { ExitCode } from '../utils/errors';

export type LauncherResult =
  | { kind: 'action'; action: LauncherAction; model: LauncherModel }
  | { kind: 'quit'; exitCode: number };

export interface OpenLauncherOpts {
  /** Restore selection by semantic action id. */
  previousActionId?: string;
  cwd?: string;
}

function onLauncherSigint(): void {
  process.exitCode = ExitCode.CANCELLED;
}

/**
 * Show the root launcher once. Resolves with the chosen action, or quit.
 * Esc / q → exitCode 0; Ctrl-C → exitCode 130; 1-9 select that row.
 */
export async function openRootLauncher(
  app: AnyPickApp,
  opts: OpenLauncherOpts = {},
): Promise<LauncherResult> {
  updateSettings({
    aliases: {
      escape: 'cancel',
      q: 'cancel',
    },
  });

  const model = await buildLauncherModel(app, { cwd: opts.cwd });
  const actions = orderedActions(model);
  if (actions.length === 0) {
    return { kind: 'quit', exitCode: 0 };
  }

  const options = actions.map((a) => ({ value: a.id, label: a.label }));
  const first = actions[0];
  if (!first) {
    return { kind: 'quit', exitCode: 0 };
  }

  // Prefer restoring previous; else first actionable row (Attention wins over Run)
  const defaultId = first.id;

  const initialValue =
    opts.previousActionId && actions.some((a) => a.id === opts.previousActionId)
      ? opts.previousActionId
      : defaultId;

  let lastKey: string | undefined;
  let settled: 'submit' | 'cancel' | undefined;

  const prompt = new SelectPrompt({
    options,
    initialValue,
    render() {
      const cursor = this.cursor;
      return renderLauncherFrame(model, {
        cursor,
        columns: process.stdout.columns ?? 80,
        settled: this.state === 'submit' || this.state === 'cancel' ? this.state : settled,
      });
    },
  });

  // Hotkeys: 1-9 jump cursor (enter still confirms) — also accept as immediate select
  prompt.on('key', (key) => {
    lastKey = key;
    if (!key || key.length !== 1) {
      return;
    }
    if (key >= '1' && key <= '9') {
      const idx = Number(key) - 1;
      if (idx >= 0 && idx < actions.length) {
        // Move highlight; user can also just press enter.
        // Immediate select: treat digit as enter on that row.
        prompt.cursor = idx;
        const opt = options[idx];
        if (opt) {
          prompt.value = opt.value;
        }
        settled = 'submit';
        prompt.state = 'submit';
      }
    }
  });

  const value = await prompt.prompt();

  if (isCancel(value) || value === undefined) {
    const exitCode = lastKey === '\x03' ? ExitCode.CANCELLED : ExitCode.SUCCESS;
    return { kind: 'quit', exitCode };
  }

  const id = String(value);
  // If digit-select set value, prefer that
  const action = actions.find((a) => a.id === id);
  if (!action) {
    const idx = cursorForActionId(model, id);
    const fallback = actions[idx] ?? first;
    return { kind: 'action', action: fallback, model };
  }
  return { kind: 'action', action, model };
}

/** Listen for SIGINT during launcher so Ctrl-C maps to 130 if process gets it. */
export function installLauncherSigint(): () => void {
  process.once('SIGINT', onLauncherSigint);
  return () => process.off('SIGINT', onLauncherSigint);
}
