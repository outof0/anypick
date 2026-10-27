import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

import { commandShape, parseLine, unacceptedLines } from './command-corpus';

// Every line a UI test sends must have a shape the Go engine accepted in
// `ui-commands.json`. See `command-corpus.ts` for why this is not a throw.
afterEach(() => {
  if (unacceptedLines.length === 0) return;
  const lines = unacceptedLines.splice(0);
  const detail = lines.map((line) => `  ${commandShape(line)}\n    ${JSON.stringify(parseLine(line)?.payload ?? line)}`);
  throw new Error(
    `The UI sent ${lines.length} command(s) whose shape no corpus case covers, so nothing proves the engine accepts them:\n` +
      `${detail.join('\n')}\n` +
      'Build the payload with a lib/desktop-actions.ts builder and add a case to test/command-corpus.ts.',
  );
});

// The UI renders inside a Tauri webview, so nothing in jsdom provides the
// host surface a pane can legitimately reach for: the clipboard write, the
// confirm dialog behind the destructive Stop All, and the matchMedia probe
// behind the appearance watcher.
//
// userEvent.setup() replaces navigator.clipboard with its own stub. A test
// that wants the text the app copied reads navigator.clipboard.readText()
// after the write, not a log captured on this object.
Object.defineProperty(globalThis.navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: () => Promise.resolve(),
    readText: () => Promise.resolve(''),
  },
});

if (!('confirm' in globalThis) || !globalThis.confirm) {
  Object.defineProperty(globalThis, 'confirm', {
    configurable: true,
    value: () => true,
    writable: true,
  });
}

if (!globalThis.matchMedia) {
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

if (!globalThis.localStorage || typeof globalThis.localStorage.getItem !== 'function') {
  const store = new Map<string, string>();
  const localStorageMock: Storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: localStorageMock,
    writable: true,
  });
}
