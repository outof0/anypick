# macOS System Settings contract

This directory is the **only Swift tree** for the macOS app: scenes, panes,
sheets, menu-bar content, in-memory fixture, `TrayStore`, and
`ProductionDesignModel`. There is no second build: fixture vs live is a data
source chosen by environment variables (`ANYPICK_MACOS_FIXTURE`), read by
`AppDelegate` in the same binary.

The product is a full macOS Dock app whose **main window must look and behave
like a first-party macOS System Settings window**, not a website, not a
dashboard, and not a custom design-tool mock. A menu-bar extra remains
available as a compact power surface; it does not own the application
lifecycle. Shipped `.app` trees are Node-free (ADR 0020): no ESM plugin host, no
private Node runtime, no npm/pnpm/tsx shim, and no leaked developer paths.

If a change would look out of place next to **System Settings → Displays**
or **System Settings → Battery**, it is the wrong change.

## Authority (highest wins)

1. This file and the macOS section in repo-root `AGENTS.md`.
2. Apple HIG for macOS — Settings, Windows, Sidebars, Menus, Alerts,
   Accessibility: <https://developer.apple.com/design/human-interface-guidelines/designing-for-src/macos/>
3. The shipped System Settings app on the machine you are designing on.
   Open it. Match spacing, control kinds, and pane rhythm. Do not guess.
4. Product vocabulary and pane/sheet **content** in the Pen design file. This
   one is **not committed**: `/design/` is gitignored, so the file exists only
   in a workspace that has it and `make check` cannot verify it. Everything
   enforceable in it is restated in items 1 to 3 and in this file; treat the Pen
   board as IA and copy guidance, and this document as the contract.
   Pen is not 100% native (Inter, Phosphor, drawn chrome) — ship SF Pro,
   SF Symbols, and system controls.
5. `src/macos/AnyPickTests/` only for **isolation / credentials /
   native-control presence** (`AnyPickTests.swift`, `PaneRenderTests.swift`).
   String locks on pixel widths or Pencil measurements are stale — update the test.

**Not authority.** Do not copy these into new UI:

| Source | Why it misleads |
| --- | --- |
| Tray cards / RGB tokens / chip rows outside `MenuBar*.swift` | Deliberate Quick Panel chrome (see Menu bar extra). Copying it into panes or sheets is what misleads. |
| Pen stand-in metrics (Inter, Phosphor, 54×24 switch, drawn traffic lights) | Mock fidelity only — not Swift constants |
| `src/tauri/ui/` | Web tray for Linux; not a macOS reference |
| iOS Settings / inset-grouped “card” screenshots | Different platform |
| A generic “make it native” prompt without this file | Agents still absorb the files above |

## One tree

Edit this directory for chrome, panes, sheets, menu-bar content, store, and
the production bridge. Nothing outside this tree renders macOS chrome.

File layout: one type per file, with extensions in the matching
`Type+Feature.swift` file (`Store` and `Store+Transfers.swift`)
(`MacOSDesignModel+Accounts.swift`, `TrayStore+Logs.swift`). New files
must be registered in `sources.txt` and `AnyPick.xcodeproj` (app and test
targets) — `testProjectUsesTheSharedSwiftSourceManifest` fails otherwise.
`override` members and `super`-called methods stay in the main type file:
Swift forbids overriding anything declared in an extension.

## Fixture vs live

One binary, two data sources. Run with no variables and the app talks to the
Go service over `~/.anypick`; set `ANYPICK_MACOS_FIXTURE` (or
`ANYPICK_MACOS_DESIGN=1`) and it renders an in-memory fixture instead, with no
service and no disk access.

Set them in the scheme (**Product → Scheme → Edit Scheme → Run → Arguments →
Environment Variables**), then Run:

| Variable | Values | Default |
| --- | --- | --- |
| `ANYPICK_MACOS_FIXTURE` | `ready`, `loading`, `empty`, `error` | — (unset = live data) |
| `ANYPICK_MACOS_DESTINATION` | `overview`, `apps`, `accounts`, `proxyHub`, `proxies`, `activity`, `backups`, `settings` | `overview` |
| `ANYPICK_MACOS_FLOW` | `add-account`, `add-gateway`, `remove-account`, `published-models`, `hub-overlap`, `create-backup`, `restore-backup`, `import-backup`, `getting-started`, `tray`, `tray-attention`, `tray-use-with`, `tray-switching`, `tray-recovery`, `tray-first-run` | — |
| `ANYPICK_MACOS_APPEARANCE` | `system`, `light`, `dark` | `system` |
| `ANYPICK_MACOS_ACTIVITY_MODE` | `events`, `logs` | `events` |
| `ANYPICK_MACOS_ACCOUNT` | account id (e.g. `google-pro`) — opens Accounts → account detail | — |
| `ANYPICK_MACOS_UPDATE_FIXTURE` | `checking`, `upToDate`, `availableDirect`, `availablePackageManager`, `downloading`, `verifying`, `ready`, `offline`, `badChecksum`, `hostBlocked`, `rateLimited`, `notWritable`, `storageUnavailable` — pins Settings > Updates to that state (buttons do nothing) | — |
| `ANYPICK_MACOS_RENDER_PATH` | path — renders the window to a PNG and exits | — |
| `ANYPICK_MACOS_RENDER_SIZE` | `WIDTHxHEIGHT` in points, for renders | saved window size |

Preview the fixture, not a screenshot of a previous session:

```text
ANYPICK_MACOS_FIXTURE=ready                     # populated Overview + tray Ready
ANYPICK_MACOS_FIXTURE=empty                     # first-run Get Started + tray First Run
ANYPICK_MACOS_FLOW=tray                         # board 29 Ready
ANYPICK_MACOS_FLOW=tray-attention
ANYPICK_MACOS_FLOW=tray-use-with
ANYPICK_MACOS_FLOW=tray-switching
ANYPICK_MACOS_FLOW=tray-recovery
ANYPICK_MACOS_FLOW=tray-first-run
ANYPICK_MACOS_FLOW=getting-started
ANYPICK_MACOS_DESTINATION=proxies               # Hub + per-account proxies
ANYPICK_MACOS_DESTINATION=apps
ANYPICK_MACOS_FLOW=add-account
ANYPICK_MACOS_APPEARANCE=dark
```

Compile-only check of the Swift tree:

```bash
xcodebuild -project src/macos/AnyPick.xcodeproj -scheme AnyPick \
  -destination platform=macOS CODE_SIGNING_ALLOWED=NO build
```

## Running a build you are reviewing

`make run-macos-dev` builds the app, installs it as `~/Applications/AnyPick Dev.app`
with its own bundle id (`dev.anypick.app.dev`) and label, and runs it on fixture
data. Use it instead of opening AnyPick from Spotlight or the Dock: a dev build
and the release install share a name and an icon, so opening the wrong one looks
exactly like "my change did nothing". The release copy in `/Applications` is
never touched, and neither is `~/.anypick`.

To review the build against your real data, quit the release app first — two
instances on one data root fight over the same mutation locks and rewrite the
same client configs.

`make install-macos` is the other loop: it builds Release, keeps the previous
bundle under `~/Library/Application Support/anypick-installed-backup/`, replaces
the installed app, and restarts it. Use it when the change has to be in the app
you actually run. Note that the app only quits from the menu-bar Quit — a Dock
⌘Q or a scripted `quit` withdraws to the tray instead
(`applicationShouldTerminate`), so anything that replaces the bundle while the
app is running is replacing code the running process does not use.

## What “System Settings” means here

The **main window** is a settings-style management app:

```
NavigationSplitView
├─ sidebar: List(selection:) + .listStyle(.sidebar)
│           optional .searchable(placement: .sidebar)
└─ detail:  NavigationStack
            Form { Section { … } }.formStyle(.grouped)
            NavigationLink only for a real child pane
```

A pane is a **grouped Form**, not a dashboard. Compare to
System Settings → Wi‑Fi / Displays / Battery / Privacy & Security:

- One column of inset groups on the system window background.
- Leading label, trailing control (`Toggle`, `Picker`, `LabeledContent`,
  `NavigationLink`, small `Button`).
- Section `header` / `footer` for grouping and explanation.
- System fonts, system colors, system metrics. No palette file.
- Toggles and pickers **instant-apply**. No OK/Apply on a pane.
- Create / inspect / confirm flows are **sheets** with toolbar Cancel +
  primary action.
- Destructive work asks through one native alert (see
  [Confirmations](#confirmations)), never a custom modal card.

**Settings is a normal main-window destination** in the sidebar. It uses one
grouped `Form` with the app preferences for startup and usage; do not split it
into a separate window or tabs. Settings also has one action to reopen the
Getting Started checklist on Overview; it does not host status summaries or
controls for other product panes. Account backups, proxy controls, and Codex
profiles stay in their own destinations. Installation diagnostics are
available on Overview. The app-menu Settings… command and ⌘, shortcut route to
the same Settings destination.

The **menu bar extra** is a status-item menu, not a second app. See
[Menu bar extra](#menu-bar-extra).

## Allowed building blocks

Prefer these, in this order. Use the platform default for fonts, spacing,
tints, and materials. Do not wrap them in a custom “design system”.

| Job | Use |
| --- | --- |
| App / window | `Window`, `MenuBarExtra`, native `Toolbar` |
| Shell | `NavigationSplitView` + `List` + `.listStyle(.sidebar)` |
| Drill-in | `NavigationStack` + `NavigationLink` + `navigationTitle` |
| Pane body | `Form` + `.formStyle(.grouped)` + `Section` |
| Values | `Toggle`, `Picker`, `TextField`, `SecureField`, `LabeledContent` |
| Commands | `Button`, `Menu`, toolbar `cancellationAction` / `confirmationAction` |
| Empty / search miss | `ContentUnavailableView` |
| Progress | `ProgressView` |
| Confirm | `DesignConfirmation` + `.designConfirmation(_:)` |
| Files | `NSSavePanel` / `NSOpenPanel` |
| Brand mark | Provider / app rows: bundled logo via `DesignProviderIcon`. All other chrome: SF Symbol. No card, no badge plate. |

## Button help and in-form guidance

Use native help for toolbar icons, icon-only row commands, menu triggers, and
controls whose effect is not clear from their label (`.help(_:)` in SwiftUI or
`NSButton.toolTip` when bridging AppKit). Keep each help tag brief (aim for 60
to 75 characters) and specific to that control; describe the action and change
the wording when its state changes. Do not build a custom tooltip view or
repeat a long workflow in a help tag.
Follow [Apple’s help-tag guidance](https://developer.apple.com/design/human-interface-guidelines/offering-help)
for tooltip content and length.

Put instructions people need to finish a task in the sheet itself: a concise
`Section` footer for a group, or a short explanatory `Text` beside the field.
Tooltips supplement that visible guidance; they must not be the only place to
learn a required format, warning, or next step. Keep the main window and sheets
as native grouped Forms with system controls.

## Forbidden (this is why previous prompts failed)

Scope: the main window (panes, sheets, Settings). The menu-bar Quick
Panel is the one deliberate exception — a customized product surface per
Pen board 29, owned by `MenuBarChrome.swift` (see Menu bar extra). Its
cards, chips, and type ramp stay inside `MenuBar*.swift` and must not leak
into panes or sheets.

Do **not** introduce or copy:

- Web / dashboard chrome: custom cards, rounded containers, gradients,
  glass groups, chip strips, status pills, hairline dividers you drew
  yourself, “hero” headers, metric tiles.
- CSS-like layout: `TraySpacing`, `TrayRadius`, `QuickPanelMetrics`,
  `NativeWindowMetrics`, hardcoded RGB (`anypickViolet`, `anypickAmber`,
  `Color(red:green:blue:)`), `RoundedRectangle`, `overlay` strokes,
  `Color.accentColor.opacity(0.12)` selected rows.
- Custom controls that recreate a system one: handmade sidebar, search
  field, segmented chrome, checkbox, switch, pop-up, toolbar.
- iOS-only habits used as decoration: large circular glyphs, stacked
  title+caption as a substitute for `LabeledContent`, inset cards.
- Pixel-perfect frames as design: `frame(width: 208)`, `frame(width: 336)`,
  `padding(.horizontal, 20)` action bars, magic `minHeight` on every
  empty state.
- Form `Section` footers used as pane actions. Actions sit in a plain row
  immediately below the content-sized grouped Form, with no second inset
  container or manually styled card around the buttons. Keep them out of the
  toolbar and do not pin them to the window bottom.
- A product Light/Dark picker. Follow system appearance.
- Secrets, tokens, or raw backup JSON in any view.

If SwiftUI cannot reproduce a System Settings behavior, **bridge AppKit**
(`NSHostingView`, `NSAlert`, `NSOpenPanel`, `NSSavePanel`, `NSMenu`)
instead of faking the control.

## Pane recipe

```swift
Form {
  Section {
    Toggle("Open at Login", isOn: $model.openAtLogin)
    LabeledContent("Status") { Text(statusText).foregroundStyle(.secondary) }
    NavigationLink(value: DesignRouteID.app(app.id)) {
      Label(app.name, systemImage: app.symbol)
    }
  } header: {
    Text("Startup")
  } footer: {
    Text("Shown when the reason is not obvious from the control label.")
  }
}
.formStyle(.grouped)
.navigationTitle("General")
```

Rules:

- One primary job per pane. Progressive disclosure via `NavigationLink`
  or a trailing `Button("Options…")` / `Button("Advanced…")` that opens
  a sheet or child pane — the System Settings pattern.
- Row-level commands stay **in the Form** (trailing `LabeledContent`
  button). Pane-level commands sit in the plain action row immediately below
  the content (`DesignGroupedPane`), without a second Form/container
  background or a window-bottom footer.
- Service lifecycle (Start/Stop/Restart) also lives **in the Service row**
  as a trailing button. Panes carry **no titlebar buttons**: collection
  actions (Add Login, Start Hub, Stop All…) live once, under the last
  group — with 20+ rows prefer navigation (sidebar, search, row drill-in)
  over duplicating actions where they fall below the fold.
  The log-source filter is the exception that proves it: with no toolbar,
  it sits beside the Events/Live Logs picker inside the Activity pane.
- Quick Panel is a deliberately customized product surface (Pen board 29,
  node `m0s8el`), not a Settings pane: its cards, account chips, status
  pills, and type ramp (`TrayPaint` / `TrayFont` in `MenuBarChrome.swift`)
  are intentional. Service controls inside it stay native (`Toggle`,
  `Picker`, push buttons). Account names wrap; the expanded proxy list
  scrolls in a bounded region so Search/Open/Quit stay reachable.
- `List` is for the sidebar and for true selectable collections (logs).
  Do not fake selection with `.buttonStyle(.plain)` +
  `listRowBackground`.
- Window title tracks the pane (`navigationTitle`). Restore the last
  sidebar destination when that state is persisted.
- Sidebar icons are SF Symbols and must follow the **system accent**.
  Fixed colors only when they encode meaning (attention), and never as
  the only signal.

## Sheets

Create / choose / inspect flows (`Add Subscription`, `Add API Gateway`,
`Use With`, `Models`, `Export Accounts`, `Import Accounts`):

- `sheet` + grouped `Form` inside one rounded native sheet. The title sits
  inside the sheet above the content; it is not a navigation title bar.
- Cancel + default sit in the separated bottom action bar, aligned to the
  trailing edge. Disable the default until the form is valid.
- Files use `NSSavePanel` / `NSOpenPanel`. Do not draw a fake file-name row.
- **Change Connection** keeps the current source visible, groups alternatives
  under Accounts, Proxy Hub, and API Gateways, and moves a native checkmark to
  the selected row. Search appears when the resource list is long. Keep
  `Review Change` disabled until the user selects a different source.
  The flow continues connection → review → apply → models. The model
  picker comes *after* the switch on purpose: the engine publishes model
  options per live connection, so a picker offered before the switch would
  list models the new route cannot serve. The step only appears when the
  engine published options for that connection, and it is skipped when a
  default model is already pinned (`appRouteOffersModelStep`,
  `appRouteNeedsModelChoice`).

## Confirmations

Every irreversible or outward-facing command asks through **one native
alert**. There is a single spelling for it: a `DesignConfirmation` in the
view's `@State`, attached with `.designConfirmation(_:)`
(`SharedUI.swift`).

```swift
@State private var confirmation: DesignConfirmation?

// …
.designConfirmation($confirmation)

// A command asks; it never builds the dialog itself. "Remove", not
// "Remove Account" — see the width rule below.
confirmation = DesignConfirmation(
  id: "remove-account",
  title: "Remove “\(account.name)” from AnyPick?",
  message: "…one sentence about what actually changes…",
  action: .confirm("Remove") { model.removeAccount(id: account.id) }
)
```

Rules:

- **One host per view.** SwiftUI only reliably presents the most recently
  attached alert, so a pane that offers several confirmations keeps one request
  in state and points it at whichever command asked (`AppDetailView`,
  `ProxiesView`, `ActivityView`).
- **Cancel is the host's job.** A caller lists only the answers. The host
  appends `Cancel` last, which is what makes Cancel the rightmost button and
  therefore the one under the default key and Escape — Return must never be a
  destructive action.
- **Button titles are bare verbs.** "Remove", not "Remove Account". This is
  what puts the buttons on **one row**, and it is the only lever there is:
  `confirmationDialog`, `.alert` and a hand-built `NSAlert` all produce the
  identical native `_NSAlertPanel`, which gives its buttons a single 228pt
  row. A title too wide for that row is not squeezed — it takes its own
  full-width row, which is the "Remove Account and Cancel on two lines" report.
  Measured: "Forget Books" (12 chars) fits, "Remove Login" (13) does not, and
  the split is pixel width rather than length — "Remove Guest" (12) wraps.
  `AnyPickTests.testConfirmationButtonsFitOnOneRow` scans every `.confirm("…")`
  in the app, plus the action closure of the one hand-written `.alert`, and
  fails the build on a title that is not on the measured list. The alert title
  already carries the sentence ("Remove “Claude” from AnyPick?"), so the button
  only has to be the verb.
- **Three answers take three rows, and that is the platform's rule.** macOS
  puts each of three or more alert buttons on its own row — measured, even
  "No / Yes / Cancel" stacks. The backup-overwrite dialog is the only place in
  the app that does not answer on a single line, and it is not a layout choice
  made here.
- **Say what does not happen.** "Removed from AnyPick" alone is not reassurance;
  name what survives (`Codex stays signed in on this Mac`, `the remote API key
  is not revoked`).
- The one hand-written `.alert` is the `CLIENT_CONFIG_FOREIGN` takeover in
  `MainWindow.swift` (the engine's refusal and its answer belong on the window
  the user is already on). It follows the same width rule: "Replace", the verb
  the engine's own `--allow-foreign-config` suggestion uses, where
  "Manage with AnyPick" took a row of its own.
- The menu-bar extra's Quit is a hand-built `NSAlert`
  (`MenuBarMenu.swift`) — a status-item menu is not a pane and has no SwiftUI
  host to attach to. It follows the same rules: "Quit" before "Cancel", with
  Escape on Cancel.

## Menu bar extra

| Surface | Style | Content |
| --- | --- | --- |
| Production and fixture | `.menuBarExtraStyle(.window)` | Power Quick Panel from `MenuBarMenu.swift`: app routes, attention recovery, direct Proxy Hub/local-proxy controls, switch flow, Settings, and Quit. |

The menu bar is the compact power surface defined by Pencil node `m0s8el`.
Production and the fixture must host the same `MenuBarMenu`; do not replace it
with `AppMenuBarMenu` or a text-only native menu. Service start, stop, and restart
actions stay available in the tray; detailed configuration belongs in the main
window. Production launches the main window as a regular Dock app. Closing the
window never stops proxies; reopening from the Dock or menu-bar restores the
app. `MenuBarPreview` is the isolated window used to inspect the
same rich states without clicking the system status item.

Proxies is collapsed by default to preserve tray height. Its summary row expands
to Proxy Hub and the per-account services with the same start/stop and restart
controls. Attention remains visible in the collapsed summary instead of forcing
the section open.

## Information architecture

Main window sidebar (pane destinations, System Settings style):

| Destination | Job |
| --- | --- |
| Overview | Attention + Get Started + summary. Not a marketing dashboard. |
| Apps | Every switchable installed client/provider. Native-only clients switch saved accounts; only compatible-routing clients expose custom providers and model configuration. Codex also manages named profiles here: choose a saved account or route, optional model and transport, edit existing profiles, then copy the profile's Terminal launch command. Proxy profiles use a discovered source model when no model is selected. |
| Accounts & APIs | Searchable saved logins and API endpoints. **Add Login** owns importing the current local login and provider sign-in; there is no separate “Save Current Login” toolbar action. |
| Proxy Hub | One local endpoint, its sources, published models, and service lifecycle. |
| Proxies | Per-account translation processes and their service lifecycle. |
| Activity | Searchable events and live logs in a bounded, independently scrolling region. |
| Backups | Export / import saved accounts. |
| Settings | App-wide startup and usage preferences. |

Settings groups related controls into Startup and Usage. It contains only
preferences; each feature's management, status, and recovery actions stay in
their own sidebar destination. The sidebar row, app-menu command, and ⌘,
shortcut all select this same main-window destination.

Do not duplicate a toggle across General and a specialized pane.
Do not put appearance, scrolling, or other **system** preferences here.

Usage rows preserve every provider-reported window and label. Cadence
(`limit_window_seconds`) and reset instants render when the vendor reports
them; anything else is left unsaid rather than inferred — never rename a
window to “5-hour” from its position alone. Idle proxies are neutral; they
only become global attention when an active app route or running Hub depends on
them and the service is unavailable.

## Behavior that is not visual

These still apply; chrome must not fight them:

- Instant-apply for pane toggles and pickers.
- Single-flight mutations in production (`TrayStore`). Disable controls
  when `isBusy`.
- Errors: `NSAlert` / `.alert` only. Success is silent (VoiceOver
  announcement) — not a toast stack.
- Backups: `NSSavePanel` / `NSOpenPanel`. Files contain credentials;
  say so before create / import.
- Proxy addresses are loopback; never show the auth token.
- Reduce Motion and Increase Contrast come from the system. Do not add
  a motion or contrast switch.

## Known leftovers

These are smaller than the chrome bugs above. Do not copy them into new
panes.

- Comments citing `HANDOFF` / Pencil frames — delete when touching the
  file.
- The Quick Panel's custom chrome (`TrayPaint` / `TrayFont` / cards /
  chips) is intentional product chrome owned by `MenuBarChrome.swift`, not
  leftovers. Do not copy it into panes or sheets, and do not
  "native-ify" it without a product decision. Do not reintroduce
  `Native*` chrome anywhere.

## When you are done

- The pane is a grouped `Form`. A screenshot next to System Settings
  should share control anatomy, not just “a sidebar”.
- No new token file, card, or pixel recipe.
- `make build-macos` compiles; `make test-macos` passes unit and smoke UI tests.
- Isolation tests still forbid supervisor / `~/.anypick` references in
  this tree.
- If a string-scan test demanded a Pencil width or a removed wrapper,
  update the test to the contract above.
