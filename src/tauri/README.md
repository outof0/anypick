# AnyPick desktop app (Linux and Windows)

This is one of two native front ends. The other is the macOS app in
`src/macos/` (SwiftUI); this one is Tauri 2 + React and targets Linux and
Windows (ADR 0020). The release workflow defaults to `all`: it builds
AppImage/deb/rpm, MSI and NSIS artifacts alongside the SwiftUI macOS app.
`cli-only` omits desktop installers. The macOS app currently uses an ad-hoc
signature and is not notarized.

Each Linux/Windows payload is smoke-tested on its own OS (`packaging/smoke/`)
before it can reach a GitHub Release. The gate extracts each installer, checks
the bundled Go helper, then launches the packaged desktop executable in an
isolated home with an empty executable search path (ADR 0020 §8). The Windows
smoke also confirms the app window and bundled Go sidecar start. Linux uses
Xvfb and WebKitGTK for native WebDriver coverage.

**This app owns no AnyPick state and never reads credentials.** It launches,
handshakes with, supervises and shuts down the bundled Go service, then renders
what that service sends it (ADR 0019 §1):

- app → service: `invoke`, `mutate`, `logs`, and simple commands;
- service → app: snapshots/events, results, logs, Doctor reports and backup previews.

The transport is a hidden `anypick desktop-service --stdio` process whose stdout
is protocol-only, behind a version/capability handshake that check every
mutation (ADR 0019 §3). Release builds have no permanent daemon, localhost HTTP
service, socket, or gRPC API — any of those needs a new accepted ADR. The
Windows E2E build enables a loopback WebDriver server only through its explicit
test feature; release builds reject that feature.

## What is bundled

- **The Go service**, as a Tauri `externalBin` sidecar:
  `binaries/anypick-core` in `app/tauri.conf.json`, resolved per target by
  `app/build.rs`. If you move a directory under `src/`, run `make check-paths`
  first: that build script is one of the paths it checks.
- **No Node runtime.** npm and Vite build the UI bundle at build time; the
  shipped artifact contains no Node, npm, pnpm or ESM shim (ADR 0020 §8). Two
  check enforce it — `src/macos/scripts/check-node-free-app.sh` and
  `go run ./cmd/anypick-artifact node-free <root>` — and both must reject the
  same shapes.

## UI

React 19 + Vite + Tailwind v4 under `ui/`, built into `frontend/` (which Tauri
consumes as `frontendDist`). Do not edit files under `frontend/` by hand.
There is exactly one stylesheet, `ui/styles.css`: an `@import "tailwindcss"`, an
`@theme` block holding the System Settings tokens, and a `@layer base` block for
the handful of element defaults the chrome needs. A pane composes
`ui/primitives.tsx` and never styles a row itself.

**Do not add a second stylesheet.** There were two (`styles.css` and
`ui/system-settings.css`) and they collided over seven class names while leaving
three classes the UI emitted undefined. `styles.css` loaded last, so it won
every equal-specificity tie and the System Settings metrics lost. Utilities
cannot do either: there is nothing to collide with and nothing to forget to
define.

### Layout

```text
lib/contract.ts   the TypeScript mirror of go/internal/desktop/snapshot.go
lib/wire.ts       the stdio framing: KIND\tbase64(JSON), both directions
lib/service.ts    the only place a pane asks the engine to do something
lib/model.ts      display and derivation rules ported from src/macos/
lib/bridge.ts     the Tauri boundary, injectable for tests
panes/            one file per destination, composing ui/primitives.tsx
shell/            Sidebar, Toolbar, NoticeBanner, Symbol
ui/               primitives.tsx (the System Settings building blocks) and Dialog.tsx
```

`lib/contract.ts` is checked against the Go struct by
`test/contract-drift.test.ts`, which reads `snapshot.go` and fails the build
when a field exists there and not in the mirror. A contract that drifts from
the engine is worse than none, because the failure is a blank cell with nothing
to grep for.

`lib/model.ts` holds the copy rules. They are ported from
`src/macos/DesignDisplay.swift` and `AppIcon.swift`, and the expectations came
from the macOS XCTest suite first. That is deliberate: the macOS app's copy is
the product's copy, so a Linux user reading a Claude proxy row should read the
same words a macOS user does. A rule that lives in a view instead belongs here,
where it can be tested without a webview.

### What "matches the macOS app" means here

Structural, metric, and state parity: the same destinations in the same order,
the same rows with the same labels, the same states, the same flows, and the
same metrics in `ui/styles.css` with a named Swift counterpart beside
each one.

Settings is a regular sidebar destination and renders as one page with separate
groups for startup, usage, and language preferences. Language defaults to
Auto Detect, which follows the system locale. The selection updates app
navigation and Settings labels as well as CLI/TUI copy. It contains no links to
other panes or read-only status summaries; feature management stays in the related
sidebar destination. Codex profiles are managed with the Codex app in Apps. The
sidebar and native app-menu Settings… command route to that same page. It is a
shell-only destination, so the engine contract remains the seven data-backed
panes.

It is **not** a pixel-exact image diff, and this port will not claim one. macOS
is SwiftUI on AppKit; this is a webview (WebKitGTK on Linux, WebView2 on
Windows). Different rasterizers, font engines, text metrics, and window chrome.
A zero-pixel diff between them is not achievable, so a claim of one would be
false.

Parity is verified two ways, both in CI. `make test-tauri-ui` asserts behavior
against the fixture. `make check-parity` reads every macOS
`accessibilityIdentifier` and checks it against `test/parity-map.ts`, which is
the definition of "every feature ported" as a machine check rather than a
claim. `make screenshots-tauri-ui` renders each destination and dialog to
`.screenshots/` for a human to look at; it needs Playwright, so it is not a
gate.

The screenshot and browser-probe scripts load `vitest.config.ts` and build the
wire frame from `test/fixture.ts` in-process. They do not start the Vite
dev-service or read the developer's AnyPick data. `npm run probe` measures
hover, press, copy, loading, reduced-motion, and disabled states in Chromium.

`make check-parity` deliberately checks that a control *exists*, not how it
behaves, so state parity has its own gates in
`test/command-state.test.tsx`.

### An icon command owns its state

macOS reaches for an `NSButton` in `DesignIconButton` so AppKit paints the
hover, the press and the disabled bezel. A web button already paints all three
from CSS, so the control kind was never the parity gap. The state was: eight
copy commands reported nothing at all, and one swapped its own glyph inline.

`IconButton` therefore carries a `phase` of `idle`, `working` or `confirmed`, and
`CopyButton` makes a copy a component rather than a prop, so a pane cannot grow
a second spelling. Both draw through `Symbol`, which is the only place a path
lives.

- A copy reports whether the text reached the clipboard. `CopyButton` shows the
  working state while the host writes, then confirms only a successful write.
  Copyable row details remain selectable if the host refuses the write.
- A `working` command sets `aria-busy` and is disabled, so a second click cannot
  land on the same single-flight slot.
- A protected API-key copy uses the same icon phases while the engine retrieves
  the key and the host writes it. The key itself never enters the snapshot.
- Row-menu copies go through `RowMenu` and announce success or refusal after the
  menu closes. The allowed menu-copy rows are listed in the state test.

Custom menus and provider pickers move focus into their panel, support arrow and
Home/End navigation, close on Escape or focus leaving the panel, and return
focus to the trigger. Dialog focus trapping includes portaled picker options.

**A refresh greys; it does not spin.** The engine single-flights a mutation, so
a refresh disables while its own request is in flight and that disabled state is
the feedback. Spinning it would need a per-command in-flight slot with its own
confirm path, for a state the HIG reserves spinners for background work. macOS
made the same call; see `macos/README.md`.

Three regressions here are invisible to a rendered test, because jsdom never
loads `styles.css` and never fires a hover. `test/command-state.test.tsx` reads
the source for all three, the same way `test/colour-tokens.test.ts` does:
a `.spinner` that never named its `@keyframes`, a copy glyph drawn by hand, and
an icon-only control with no name.

### Button help and in-form guidance

Shared buttons expose a `title` tooltip, using their accessible label when a
call site does not provide more specific wording. Icon buttons, row-menu items,
provider pickers, segmented choices, and switches keep descriptive help text.
Override the default when an action depends on its row or current state. Keep
tooltip text to a short, specific action description.

Put required instructions in the interface too: use a group footer for a
workflow explanation and a field's `help` for a short format hint. Hover text is
supplemental; it must not be the only place to learn a required value, warning,
or next step. Keep labels and help short and specific, with an independent
accessible name for every control.

### The parity map is the work list

`test/parity-map.ts` has one row per macOS feature: `done` names the Tauri
element that carries it, `todo` means macOS has it and Tauri does not, and
`skip` requires a written reason. `test/parity.test.ts` fails when a macOS
feature has no row, when a `done` row names an element the UI does not emit, or
when a row names a macOS feature that no longer exists. The map cannot go green
by accident, which is the property the check exists to provide.

`make check-parity` prints the `todo` set. The port is complete when it is
empty.

### Tests

`make test-tauri-ui` runs vitest in jsdom. It needs no webview, no Go service,
and no display, so it runs in CI on the same runner as the Go tests. The panes
are rendered against `test/fixture.ts`, a snapshot shaped exactly as
`snapshot.go` serialises, and asserted on through `test/harness.tsx`'s
`FakeBridge`, which records the commands a pane sent.

`createService` is where a request id is minted and where a control is
released: on the engine's terminal frame, matched by id, never on a timer. The
tests assert that directly, because a timeout-based release re-enables a button
whose mutation has not landed.

The native host has two additional gates. Rust's `protocol_service_tests.rs`
launches the Go sidecar prepared by `build.rs` and passes every received frame
through production `AppProtocol`, including Doctor, logs, backup previews,
mutations, protocol errors, refresh and shutdown. It runs in `cargo test` on
Linux and Windows. A Go-only cross-process test cannot exercise this boundary.

`scripts/desktop-e2e.mjs` launches the real debug desktop executable, without
fixture mode or a JavaScript bridge shim. It checks the
first snapshot, Doctor's displayed terminal report, a new snapshot after
refresh, every pane, Add Login saving an isolated file-backed Codex account
through the real UI and strict Go decoder without treating the UI display hint
as a stored account identity, Activity fetching the stopped fixture proxy's
logs, and Quick Backup writing the account's backup inside the
isolated test home. The account and a setting must both survive closing and
reopening the app. The test auth file has no access token, so it cannot make an
authenticated provider request. CI runs it on Ubuntu and Windows. Linux uses
`tauri-driver` and WebKitGTK; Windows uses a loopback WebDriver server embedded
only in debug builds, so release binaries have no automation endpoint. Run
`xvfb-run -a dbus-run-session -- node
src/tauri/ui/scripts/desktop-e2e.mjs /absolute/path/to/anypick` on Linux, or
`node src/tauri/ui/scripts/desktop-e2e.mjs C:/absolute/path/to/anypick.exe`
on Windows, from the repository root. Linux package tests run the native E2E
against extracted deb/AppImage/rpm payloads. Windows package tests launch the
extracted MSI/NSIS applications and verify their Go sidecar because the
production binary intentionally omits the debug-only WebDriver server.

These gates do not perform real browser sign-ins, spend subscription quota, or
prove every provider's upstream still accepts its credentials. Unit tests,
native GUI tests and payload tests report their separate scopes; a fixture
browser pass is not evidence that an installer or native bridge works.

Adding a command to a pane means adding it to `lib/service.ts` first. A pane
never builds a wire line: the engine rejects any key that is not on the
operation's allowlist with a `MALFORMED_FRAME` that names nothing useful.

## Commands

From the repository root:

| Command | Purpose |
| --- | --- |
| `make install-tauri` | Install the UI dependencies |
| `make typecheck-tauri-ui` | Typecheck the UI without emitting output |
| `make test-tauri-ui` | Run the desktop UI tests (jsdom, no webview needed) |
| `make check-tauri-ui` | Typecheck and test the desktop UI |
| `make check-parity` | Report which macOS features have no Tauri counterpart |
| `make screenshots-tauri-ui` | Screenshot every pane and dialog (needs Playwright) |
| `make build-tauri-ui` | Build the UI bundle into `src/tauri/frontend` |
| `make build-tauri` | Build the packaged desktop app for this platform |
| `make run-tauri` | Run the desktop app against the real Go service |

Build on the target desktop OS after installing the Tauri platform
prerequisites (on Linux: `libwebkit2gtk-4.1-dev`,
`libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`).

## The desktop protocol version is declared four times

Go (`internal/buildinfo`), Rust (`src/tauri/app/src/protocol.rs`), Swift
(`src/macos/AppServiceClient.swift`) and the webview
(`src/tauri/ui/lib/wire.ts`) each declare it independently, and nothing links
them. `make check-protocol` asserts all four agree — run it whenever you bump
the protocol, because bumping it on three and missing the fourth produces a
failure that is otherwise very hard to trace: the webview drops every frame
that declares `protocolVersion`, so the window stays empty while the other
front ends look healthy.

## CI

The `tauri` matrix in `.github/workflows/ci.yml` runs on Ubuntu and Windows on
every push and PR to `main`. Both run the cross-language gates, UI typecheck,
UI tests/build, Rust check/format/tests/clippy/audit, and native desktop E2E.
The Linux GUI runs under Xvfb; Windows uses the native WebView2 driver. Release
jobs repeat the native gate against packaged executables, not only build-tree
binaries.

Out of scope for CI (needs a real desktop and installed clients): running
against a developer's `~/.anypick`, tray-icon click geometry, and OS
notification surfaces. Use `make sandbox ARGS="status"` when you need to poke
at real state without touching your own data root.
