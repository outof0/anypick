# Native macOS tray (SwiftUI)

Sources are split for maintainability. The Node supervisor compiles **all**
files listed in `sources.txt` together (`swiftc a.swift b.swift …`).

Do not add a second `@main`. Entry is `AppEntry.swift`.

## Design language

Follow Apple HIG for macOS — System Settings chrome + menu-bar utility density:

- Semantic colors + **system materials** (`.ultraThinMaterial` on MenuBarExtra and
  inset groups). Do **not** paint opaque `controlBackground` over the panel —
  that kills glass / vibrancy.
- Standard controls first (`Form`, `Toggle`, menus, bordered buttons).
- Brand color only on the logo mark, provider badges, and status LEDs.
- Instant-apply mutations; no custom OK/Apply for toggles.
- Prefer **⋯ menus** over rows of mini bordered buttons.
- Prefer `NativeStatusDot` / `NativeEmptyState` / `NativeSectionHeader`.

### Clarity (product) + HIG chrome

Information density follows the product mock; chrome follows HIG:

- Always show the **active account** (full label / email) under the app name.
- Usage is **“Usage · N%” + bar** (compact) or **“Usage” + “N% left”** (main
  window), never a bare percentage.
- Route chips are **sources** (Work / Personal / Hub), not models. Full list stays in Switch.
- **Switch is source-first.** Role / default model overrides live under
  **Model Settings…** (nested under Apps — not the Settings sidebar). Codex and
  Claude still pick day-to-day models in their own UIs from the published catalog.
- Switch face + popover **match the Codex model picker** chrome (value face,
  search, 380pt). Groups: **Accounts** (native) · **Proxies** (Hub first, then
  account/pool proxies — Grok/OpenCode/Kiro for Codex live here) · **Gateways**.
  Empty groups hide. Open lands in the **active** group (no separate Current).
- **Hide Switch + chips** when there is nothing to switch to (0–1 enabled
  sources). Two or more → show switcher.
- Groups use material, not solid cards.
- Main window is **resizable** (min 720×480), frame autosaved; menu bar shows a
  small attention badge when routing needs a decision.
- Keyboard: ⌘, Settings · ⌘R Refresh · ⌘⇧R Restart Proxies · ⌘N Add Account ·
  ⌘O Open window (quick panel) · ⌘W Close window · ⌘1–5 sidebar Go.

### List anatomy

```
section label
┌ glass group (ultraThinMaterial) ─────────────────┐
│ badge | title                                    │
│       | account identity (email / hub model)     │
│       | model line                               │  Usage N% left ─  Switch ▾
│ [chip] [chip] [chip]                             │
│ ────── hairline (indent under badge) ─────────── │
└──────────────────────────────────────────────────┘
```

Navigation uses `chevron.right` / `TrayNavigateLabel`. Overflow uses ⋯.

### Affordance glyphs (do not mix)

| Affordance | Glyph | Control |
| --- | --- | --- |
| Secondary / overflow actions | `ellipsis.circle` (⋯) | `TrayOverflowMenuLabel` |
| Choose a value (pop-up) | `chevron.down` | `TrayPopupMenuLabel` / `TraySwitchMenu` |
| Navigate into a child screen | `chevron.right` | `TrayNavigateLabel` / callouts |

Always hide the system Menu pull-down indicator (`.trayMenuLabel()`).

Spacing tokens live on `TraySpacing` (row pad 12, group radius 10, divider
leading 52, outer 12, group gap 16).

The HTML mock under `design/concepts/anypick-tray/` is historical reference only.

## Vocabulary

Align labels with the Terminal UI where possible:

| Concept | Label |
| --- | --- |
| Client routes (Claude Code, Codex, …) | **Apps** |
| Saved provider logins | **Accounts** (sidebar) / **Saved accounts** (list section) |
| Hub upstream subscriptions | **Hub Sources** |
| Local proxy processes | **Proxies** |
| Multi-model local endpoint | **Proxy Hub** |
| Native-only CLIs | **Other CLIs** |
| Activity stream | **Logs** (Quick tab + main sidebar); section **Recent activity** |

## Busy / mutations

`TrayStore` is single-flight: a second `invoke`/`mutate` while busy surfaces
“Already working on …” instead of silently no-oping. Forms wait on
`lastResult.requestId`, not a bare busy flag.

## First-run & motion

Until the first supervisor snapshot arrives, panels show
`NativeSnapshotLoading` (no empty-flash). Incomplete setup shows
`NativeOnboardingChecklist` (save account → installed app → pick route →
optional Hub). **Not Now** / ✕ dismisses via `UserDefaults`
(`TrayPreferences`); empty config re-opens tips. Settings → **Show Setup Tips
Again** restores them. Completing the three core steps auto-dismisses.

Local chrome prefs (not supervisor state): last quick-panel tab, last primary
sidebar tab, onboarding dismiss — see `TrayPreferences.swift`.

Motion tokens live on `TrayMotion` and consult
`NSWorkspace.accessibilityDisplayShouldReduceMotion` so Reduce Motion collapses
to near-instant opacity.

## 10/10 polish invariants

- **One Switch popover per row.** Chips “More…” reuses `NativeRoutePicker`’s
  `isPresented` binding — never a nested popover in MenuBarExtra.
- **Dynamic Type:** `@ScaledMetric` on badges, usage column, row padding;
  text uses `minimumScaleFactor` instead of clipping hard.
- **Screen-aware height:** quick panel max height is clamped to ~55% of the
  visible screen (`trayQuickPanelMaxHeight()`).
- **Freshness:** footer / sidebar show “Updated just now” via `TimelineView`.
- **Haptics:** success/error feedback on completed mutations (not on “Working…”).
- **Onboarding density:** compact checklist (menu bar) drops Hub step + shorter copy.

## Window vs menu bar

The process starts as `.accessory` (menu bar only). Opening the main window
promotes to `.regular` so the window behaves like a normal app (Dock icon,
survives click-outside). Closing the main window demotes back to accessory.

The helper is built as a minimal `AnyPick.app` bundle (`dev.anypick.tray`) so
Dock / Cmd-Tab show the brand name + `AppIcon`, not a bare `swiftc` binary.
`AnyPickAppIcon.applyToApp()` also sets `NSApp.applicationIconImage` on promote.

Tinted warning/info rows use `TrayAttentionCallout` (press-only chrome) so
hover does not wash out amber/accent fills.

| Module | Responsibility |
| --- | --- |
| Theme | Brand tokens, status LEDs, shared helpers |
| Models | Snapshot / wire DTOs |
| Store | `TrayStore` + protocol I/O |
| SharedUI | Section header, provider badge, empty/search helpers |
| QuickPanel | Menu-bar popover |
| MainWindow | NavigationSplitView shell |
| *Panel | Feature screens |
| AppEntry | `@main` + app delegate |
