import { act } from '@testing-library/react';

import type { TrayBridge, BridgeEvent } from '../lib/bridge';
import { encodeBase64Utf8 } from '../lib/wire';
import { snapshotFixture } from './fixture';
import { acceptedShape, unacceptedLines } from './command-corpus';

/**
 * A bridge a test drives, standing in for the Tauri shell.
 *
 * The shipped `resolveBridge` throws without `window.__TAURI__`, which is
 * correct for production and makes the UI unrenderable in a test. This records
 * every command so an assertion can be about what the pane asked the engine,
 * not about how it happens to look.
 */
export class FakeBridge implements TrayBridge {
  readonly sent: string[] = [];
  readonly invokes: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  private readonly listeners = new Map<string, Array<(event: BridgeEvent) => void>>();
  private readonly unlisten: Array<() => void> = [];
  lastLine: string | null = null;
  /** What the ZCode shell reports. A test sets it to say the app is present. */
  zcode: { appInstalled: boolean; planWarning?: string } | null = null;
  /**
   * When set, `send_command` rejects with this message the way the Tauri host
   * does once the sidecar has stopped (`main.rs:28` returns the same string).
   */
  sendCommandError: string | null = null;

  async invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
    this.invokes.push({ cmd, args });
    if (cmd === 'send_command' && typeof args?.command === 'string') {
      this.sent.push(args.command);
      if (!acceptedShape(args.command)) unacceptedLines.push(args.command);
      if (this.sendCommandError) throw new Error(this.sendCommandError);
      return undefined;
    }
    if (cmd === 'last_service_line') return this.lastLine;
    if (cmd === 'zcode_context') return this.zcode;
    if (cmd === 'stage_auth_paste') {
      const body = args?.body;
      if (typeof body !== 'string') throw new Error('AnyPick could not store the pasted auth JSON.');
      if (new TextEncoder().encode(body).length > 256 * 1024) {
        throw new Error('Pasted auth JSON is larger than 256 KiB.');
      }
      return '/tmp/anypick-auth-paste/paste.json';
    }
    if (cmd === 'forget_auth_paste') {
      const path = args?.path;
      if (typeof path !== 'string' || !path.startsWith('/tmp/anypick-auth-paste/')) {
        throw new Error('Refusing to delete a path outside the paste directory.');
      }
      return undefined;
    }
    return undefined;
  }

  async listen(event: string, handler: (event: BridgeEvent) => void): Promise<() => void> {
    const existing = this.listeners.get(event) ?? [];
    existing.push(handler);
    this.listeners.set(event, existing);
    const off = () => {
      const current = this.listeners.get(event) ?? [];
      this.listeners.set(event, current.filter((fn) => fn !== handler));
    };
    this.unlisten.push(off);
    return off;
  }

  /**
   * Deliver a frame as the service would, on the real wire encoding.
   *
   * Wrapped in `act` because a frame drives React state. A test that pushes one
   * outside `act` asserts against a tree React has not committed yet, and the
   * resulting warning buries the ones that matter.
   */
  push(kind: string, payload: unknown): void {
    const line = `${kind}\t${encodeBase64Utf8(JSON.stringify(payload))}`;
    act(() => {
      for (const handler of this.listeners.get('service-line') ?? []) {
        handler({ payload: line });
      }
    });
  }

  pushServiceState(phase: string, message = ''): void {
    act(() => {
      for (const handler of this.listeners.get('service-state') ?? []) {
        handler({ payload: { phase, message } as unknown as BridgeEvent['payload'] });
      }
    });
  }

  pushEvent(event: string): void {
    act(() => {
      for (const handler of this.listeners.get(event) ?? []) handler({ payload: '' });
    });
  }

  /** Decode every command the UI sent, in order. */
  commands(): Array<{ kind: string; payload: Record<string, unknown> | null }> {
    return this.sent.map((line) => {
      const tab = line.indexOf('\t');
      if (tab < 0) return { kind: line, payload: null };
      const kind = line.slice(0, tab);
      try {
        const binary = atob(line.slice(tab + 1));
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return { kind, payload: JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> };
      } catch {
        return { kind, payload: null };
      }
    });
  }

  /**
   * Payloads of one kind with the envelope removed, for exact comparison.
   *
   * Compare these with `toEqual`, not `objectContaining`: a containment check
   * passes when the UI leaves out a key the engine requires, which is how Add
   * Login's Detect shipped without `name`. The envelope is checked here instead.
   */
  bodies(kind: string): Array<Record<string, unknown>> {
    return this.commands()
      .filter((entry) => entry.kind === kind)
      .map(({ payload }) => {
        if (!payload) throw new Error(`a ${kind} command carried no decodable payload`);
        const { version, requestId, ...body } = payload;
        if (version !== 1 || typeof requestId !== 'string' || requestId === '') {
          throw new Error(`a ${kind} command has a bad envelope: ${JSON.stringify({ version, requestId })}`);
        }
        return body;
      });
  }

  commandKinds(): string[] {
    return this.commands().map((entry) => entry.kind);
  }

  dispose(): void {
    for (const off of this.unlisten) off();
    this.unlisten.length = 0;
  }
}

export { snapshotFixture };
