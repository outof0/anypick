# AnyPick Tauri tray

This is the Linux/Windows UI helper. It owns no AnyPick state and never reads
credentials. The Node supervisor spawns it with piped stdin/stdout:

- supervisor → helper: filtered `snapshot`, `result`, and `logs` messages;
- helper → supervisor: bounded `invoke`, `mutate`, `logs`, and simple commands.

The macOS build continues to use `AnyPickTray.swift`. When a packaged Tauri
binary is unavailable, Linux/Windows keep the existing headless supervisor.
AnyPick looks first beside its packaged JavaScript, then for `anypick-tray` on
`PATH`. Developers can set `ANYPICK_TAURI_TRAY_BINARY` to an absolute path.
Release artifacts use the platform/architecture suffixes emitted by
`scripts/build-tauri-tray.mjs`; place the matching file in `dist/tray/bin` or
point the environment variable at it.

The browser UI is a React + Tailwind (v4) app under `ui/` and is built into
`frontend/` (consumed by Tauri as `frontendDist`). Do not edit files under
`frontend/` by hand. Shared design tokens and component styles live in
`ui/styles.css` (`@import "tailwindcss"` plus the tray look).

From the repository root:

| Command | Purpose |
| --- | --- |
| `pnpm dev tray start` | Real tray against your `~/.anypick` data (main path) |
| `pnpm tray:check` | Compile-check Tauri helper (+ UI typecheck/build) |
| `pnpm tray:build` | Release helper binary (Linux/Windows only) |
| `pnpm tray:smoke` | Full binary protocol suite (one spawn: seed + multi-command + quit) |
| `pnpm tray:smoke:only` | Short path only (`snapshot` → `refresh` → exit) |
| `pnpm tray:e2e:ui` | Playwright click-through against the Vite demo fixture |
| `pnpm tray:demo` | Tauri shell + in-memory fixture (`--empty` for empty snapshot) |
| `pnpm tray:ui` | Browser-only Vite UI for layout work |
| `pnpm tray:macos` | Native macOS Swift tray (`--fixture` / `--empty` for fake data) |

Build helpers on the target desktop OS after installing Tauri platform
prerequisites. Fixture demos never read or write `~/.anypick`, login files,
Keychain, or real proxy processes.

### CI / E2E coverage

Path-filtered (only when `src/tray/**`, tray scripts, or lockfile change):

1. **`tray-ui-e2e`** (Linux + Windows) — Playwright against the React demo
   bridge. Chromium browsers are cached by lockfile hash.
2. **`tauri-tray`** (Linux + Windows) — rust-cache + `cargo test` + UI build +
   release binary + **one** `pnpm tray:smoke` spawn covering seed, multi-command
   probe (`refresh|logs|mutate|invoke|model-roles|navigate|quit`), garbage
   rejection, and quit. Linux wraps with `xvfb-run`.

Still out of scope for CI (needs a real desktop + installed clients): live
`pnpm dev tray start` against `~/.anypick`, tray-icon click geometry, and OS
notification surfaces.

After rebuilding the package while the real macOS tray is already running,
run `pnpm dev tray start` once more. AnyPick fingerprints the Swift helper and
automatically replaces a stale native tray process.
