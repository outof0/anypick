# Hotplug TUI — UI design

| Field | Value |
|---|---|
| Product behavior | Locked |
| UI direction | Implementation target |
| Date | 2026-07-18 |

This document defines the complete user-facing TUI: visual language, terminology,
navigation, screens, transient states, and copy.

It does not change Hotplug's product behavior. It replaces the current visual and
wording system.

---

## 0. The target

Hotplug should feel like a quiet, modern terminal tool:

- terminal-native, not a dashboard squeezed into a terminal;
- clear without explaining the engine;
- restrained without becoming visually empty;
- consistent across every screen and intermediate state;
- readable in the user's terminal theme;
- useful without color.

The reference quality is the calm hierarchy and directness of Claude Code, not
its branding or exact components.

### Non-negotiable visual rules

1. **Exactly two brand hues:** violet `#6A5CFF` for the wordmark, electric blue
   `#2563FF` for the cursor. No other surface may introduce a colour. Brand cyan
   `#00D4FF` is deliberately *not* used here: a terminal's background cannot be
   detected, and cyan on a light theme lands at about 1.9:1. Cyan stays in the
   logo and the docs site, where the background is known.
2. Default terminal foreground is the primary UI color.
3. State is carried only by the small status tokens: good, attention, and failure. A brand
   hue never signals state, and a status hue is never used for decoration.
4. Selection is `›` plus bold text, tinted with the accent blue. The tint ends after the
   name column — never a fully coloured row.
5. No card grid, permanent right pane, or `INSPECT` wall.
6. One list, one contextual outcome area, one key bar.
7. Icons always have a word beside them. Color and glyph alone never carry meaning.
8. Sentence case in UI copy. Avoid all-caps section chrome.
9. The main list never jumps when a notice or busy state appears.
10. Every visible shortcut must work in the current state.

---

## 1. User language

### 1.1 Screen names

| Screen | Job |
|---|---|
| **Switch** | Choose which saved login a tool uses now |
| **Proxy** | Run a proxy and let an app use it |
| **Accounts** | Save, add, refresh, import, export, or remove saved logins |

The header path is always lowercase brand plus sentence-case location:

```text
hotplug / switch
hotplug / proxy
hotplug / accounts
hotplug / accounts / add
```

Do not call the home screen `HOTPLUG`, `Home`, or `Command Center` in user copy.

### 1.2 Canonical terms

| Concept | UI term | Example |
|---|---|---|
| Official CLI whose login Hotplug reads or switches | **tool** | `Choose a tool` |
| Program configured to use a local proxy | **app** | `Use with Claude` |
| Login the official tool currently uses | **live login** | `Signed in as erik@…` |
| Login Hotplug has stored | **saved login** | `3 saved logins` |
| Use another stored login | **switch** | `Switch Codex to work` |
| Live login differs from the last selected saved login | **changed** | `◐ changed` |
| Proxy process is accepting traffic | **running** | `● running` |
| Proxy is configured but not running | **stopped** | `○ stopped` |
| Proxy is disabled | **off** | `– off` |
| Point an app at a proxy | **use with** | `Use with Claude` |
| Remove a Hotplug proxy from an app | **stop using this proxy** | `Claude no longer uses grok/jonben` |
| Store the login that is live now | **save this login** | `Save this Codex login` |
| Make room to sign in as someone else | **add another login** | `Add another Codex login` |
| Renew stored credentials | **refresh login** | `Refresh work` |
| Delete Hotplug's stored copy | **remove saved login** | `Remove codex/work` |

`changed` is the user-facing label for internal drift. `active pointer`, `record`,
and the distinction between active and live are never shown as internal nouns.

The same executable can have either role. Codex is a **tool** while Hotplug is
reading its login, and an **app** while Hotplug is configuring it to use a proxy.
The UI uses the word that matches the action on the current screen; it never asks
the user to classify the executable.

### 1.3 Words that must not appear in primary UI

- auth, token, credential material;
- stash, snapshot, restore snapshot;
- active pointer, active record, live match;
- make-live, hotplug as a verb;
- provider, source, binding, provenance;
- apply, transport, lease, commit;
- pipeline step names;
- port or endpoint as setup homework;
- inspect, context, plan, done, input as generic screen titles.

These may appear only in debug logs where technically necessary:

- auth, token, endpoint, host, port;
- provider-specific filenames or process output.

### 1.4 Copy grammar

- State a fact: `Claude uses grok/work.`
- State an outcome: `Switch Codex to personal.`
- State an error plus next action: `Proxy didn't start. Press l for logs.`
- Use contractions and plain verbs.
- Keep one sentence per line when possible.
- Do not narrate implementation steps.
- Do not say `successfully`; the `✓` already says it.
- Do not expose canonical refs when a human label is enough. Show the ref dimmed
  only where it disambiguates.

Good:

```text
Switch Codex to personal
work@acme.com  →  me@gmail.com
```

Bad:

```text
Make live personal
Will save active auth, restore snapshot, update pointer, and verify identity
```

---

## 2. Status and icon system

Use monochrome Unicode symbols with a text label. No emoji.

| Token | Meaning | Color scope |
|---|---|---|
| `● live` | Saved login is the live login | `●` and `live` may be green |
| `● signed in` | Tool has a live login | `●` and `signed in` may be green |
| `● running` | Proxy is running | `●` and `running` may be green |
| `● using` | App uses the selected proxy | `●` and `using` may be green |
| `○ saved` | Stored but not live | Dim/default |
| `○ stopped` | Configured but stopped | Dim/default |
| `○ not using` | App has no verified Hotplug proxy | Dim/default |
| `◐ changed` | Live login and saved login differ | `◐` and `changed` may be yellow |
| `◐ attention` | Recoverable warning | `◐` may be yellow |
| `× failed` | Operation or status failed | `×` and `failed` may be red |
| `× unavailable` | Hotplug cannot read or use the item now | `×` and `unavailable` may be red |
| `… checking` | Read in progress | Dim/default |
| `… switching` | Mutation in progress | Dim/default |
| `✓` | Completed outcome | `✓` may be green |
| `!` | Warning notice | `!` may be yellow |
| `›` | Keyboard focus | Default foreground, bold target text |
| `– signed out` | Tool has no live login | Dim/default |
| `– not detected` | Expected login has not appeared yet | Dim/default |
| `– off` | Proxy is disabled | Dim/default |
| `–` | Not applicable | Dim/default |

Rules:

- A selected `◐ changed` row keeps its yellow status; selection does not recolor it.
- `NO_COLOR` removes colors, not glyphs or labels.
- For `TERM=dumb`, fall back to `*`, `o`, `!`, `x`, `...`, and `>`.
- Validate glyph width in the supported terminals. No ambiguous-width decorative icons.

### Theme roles

| Role | Rendering |
|---|---|
| Primary text | Terminal foreground |
| Secondary text | Dim |
| Wordmark | `theme.brand` violet, header only |
| Selected item | `›` + bold name in `theme.accent` electric blue |
| Good status | Optional green token only |
| Attention status | Optional yellow token only |
| Error/destructive | Optional red token only |
| Cursor | Terminal inverse |

`theme.brand` and `theme.accent` are the only brand hues, and both are read through
`brandColor()` so `NO_COLOR` drops them. Selection therefore has to stay legible from
`›` plus bold alone — the tint is never the only cue.

---

## 3. Shared screen anatomy

Every screen uses the same four regions:

```text
header path                                      ambient status

notice slot (always two physical lines; blank when unused)
scrollable content viewport

────────────────────────────────────────────────────────────
selected outcome or prompt
contextual keys
```

### 3.1 Header

```text
hotplug / switch                                      ◐ 1 changed
```

- `hotplug` is dim.
- The path segment is normal or bold foreground.
- Ambient status is right-aligned when width allows.
- On a narrow terminal, ambient status moves to the next line.
- No version, project path, or decorative breadcrumb dots.

### 3.2 Notice slot

Notices do not push the list down. Every main screen always reserves two physical
lines above the viewport, including when the slot is empty. A one-line notice
leaves its second line blank.

```text
✓ Switched Codex to personal
! Proxy is running, but Claude couldn't be updated. Press enter to retry.
× Couldn't read Grok logins. Press enter to retry.
```

No notice title such as `Hotplug complete` or `Error`.

- Success clears after the next navigation action or after three seconds.
- Warning and error remain until their state resolves or the user dismisses them.
- A passive notice never changes what Enter does for the focused row.
- If retry is the primary next step, the screen enters an explicit error substate:
  the error owns the bottom rail and names the retry key. Action flows use Enter;
  logs and refresh may retain `r` or `f`. Esc dismisses it. Focus on the underlying
  row is retained for the return from that substate.

### 3.3 Rows

Rows are Ink columns, never padded strings.

```text
[focus: 2] [name: fixed/min] [identity: flex] [status: fixed] [extra: optional]
```

- The renderer owns the focus gutter. Formatters never add `›` or leading spaces.
- Identity truncates in the middle or end according to width.
- Status never wraps.
- Extra metadata disappears before identity or status.
- No blank line between rows.
- One blank line between tool groups.

### 3.4 Bottom rail

The bottom rail has one divider. It combines the selected outcome and key hints.
It has a fixed footprint for the current breakpoint and sits below a manually
sliced list viewport; Ink does not need an overlay or absolute positioning.

```text
────────────────────────────────────────────────────────────
Switch Codex to personal
work@acme.com  →  me@gmail.com
enter switch   f refresh   tab proxy   a accounts   ? help
```

- Primary outcome is one line, bold foreground.
- Supporting fact is one dim line.
- Keys are bold foreground; labels are dim/default.
- Only show actions valid for the current row and state.
- Keep four to six visible hints. Put the rest in `?`.
- No second rule and no blank line between outcome and keys.

### 3.5 Busy

Keep the selected row and screen visible. Replace the primary outcome line:

```text
… Switching Codex to personal
```

Disable mutation keys. Keep `esc` only if the operation is truly cancellable.
Never show both `Working…` and an action-specific busy label.

### 3.6 Confirm and input

Confirm and input flows are focused full-screen states inside the same parent path.
They are not centered cards and do not use a generic `CONFIRM` or `INPUT` title.

Maximum readable content width is approximately 68 columns. The screen remains
left-aligned with the same outer gutter as the parent.

### 3.7 Responsive behavior

| Width | Behavior |
|---|---|
| `>= 96` | Name, identity, status, and optional extra columns; one-line key bar |
| `64–95` | Name, identity, status; key bar may use two lines |
| `< 64` | Name and status on row; identity moves into the bottom rail |

Height rules:

- Header, notice slot, divider, outcome, and key bar remain visible.
- The shell calculates `viewportHeight = terminalRows - fixedRegionRows` and slices
  rows itself. `fixedRegionRows` includes the two-line notice slot and the rail
  height for the active width breakpoint.
- Rail height is fixed within a breakpoint: one outcome line, one supporting line,
  and one or two key lines. Unused supporting/key lines render blank.
- The list viewport contains the selection at all times.
- Show `↑ 3 more` / `↓ 5 more` in dim text when clipped.
- At fewer than 18 rows, remove secondary metadata before removing primary actions.
- Logs have their own viewport; they never append below another screen.

---

## 4. Navigation and keys

### 4.1 Top-level browsing

| Key | Meaning |
|---|---|
| `↑/↓` or `j/k` | Move |
| `enter` | Primary outcome shown in the bottom rail |
| `esc` | Back or cancel |
| `tab` | Toggle Switch and Proxy from either daily screen |
| `a` | Open Accounts from Switch or Proxy |
| `?` | Help for the current screen |
| `q` | Quit from a top-level screen |

### 4.2 Contextual

| Screen | Keys |
|---|---|
| Switch | `f` refresh login, `/` filter |
| Proxy | `s` stop, `r` restart, `d` turn proxy off, `l` logs |
| Accounts | `a` add, `f` refresh, `x` remove, `e` export, `i` import |
| Picker | `space` toggle when multi-select is enabled |
| Logs | `r` refresh |

All shortcuts are lowercase. Uppercase variants are not separate commands.

### 4.3 Key scope by interaction mode

| Mode | Active keys |
|---|---|
| Top-level list | movement, Enter, route shortcuts, `?`, `q` |
| Picker | movement, Enter, Space when multi-select, Esc, `?` |
| Confirm | Enter and Esc only |
| Text input | printable keys edit the field; Enter submits; Esc cancels |
| Busy | mutation keys ignored; Esc only when cancellation is real |
| Error substate | the retry key shown in the rail; Esc dismisses or returns |
| Logs | movement, `r` refresh, Esc |

`a`, `q`, `tab`, `/`, and `?` are ordinary input characters while a text field has
focus. Ctrl-C always requests a safe exit and restores terminal state; it is never
a field character or an application action.

---

## 5. Switch

Switch is the default screen. It answers:

> Who is signed in now, and what will Enter switch to?

### 5.1 Normal and changed state

```text
hotplug / switch                                      ◐ 1 changed

Codex
    work        dames@acme.com                       ◐ changed
  › personal    me@gmail.com                         ○ saved
    office      brands@acme.com                      ○ saved

Grok
    jonben      jon@grok.com                         ● live
    lentau      lentau@gmail.com                     ○ saved

────────────────────────────────────────────────────────────
Switch Codex to personal
xolvlab@acme.com  →  me@gmail.com
enter switch   f refresh   tab proxy   a accounts   ? help
```

The group header is the tool name only (no email, no "now"). Row status comes from
re-probing official-tool auth files on load and while the screen is open. `● live`
means the saved snapshot's auth material matches the live file (Codex: account_id;
OpenCode: API/oauth fingerprint) — not a display-identity string and not the DB
active pointer alone. `◐ changed` means Hotplug's active pointer is not the live
snapshot.

Do not show a fake selectable `live` row unless `live` is actually the user's saved
login name.

### 5.2 Selection outcomes

Selected saved login is already live:

```text
Codex already uses work
No change.
f refresh   tab proxy   a accounts   ? help
```

Selected saved login is different:

```text
Switch Codex to personal
work@acme.com  →  me@gmail.com
enter switch   f refresh   ? help
```

Selected login is marked changed:

```text
This Codex login differs from work
Live: xolvlab@acme.com   Saved: dames@acme.com
enter resolve   ? help
```

No action line may say `write snapshot`, `restore`, `fix drift`, or `put back on disk`.

### 5.3 Switch confirmation

```text
hotplug / switch

Switch Codex login?

now      xolvlab@acme.com       work
after    me@gmail.com           personal

Other tools won't change.

────────────────────────────────────────────────────────────
enter confirm   esc cancel
```

While switching:

```text
… Switching Codex to personal
```

Completion returns to Switch with focus preserved:

```text
✓ Switched Codex to personal
```

If the login switched but its proxy did not start, report the partial outcome:

```text
! Codex switched to personal, but its proxy didn't start. Press tab, then l for logs.
```

### 5.4 Changed login decision

Never overwrite either login from a one-key action. Ask what the user wants:

```text
hotplug / switch / changed login

Codex is signed in as xolvlab@acme.com.
The saved login work contains dames@acme.com.

› Save xolvlab@acme.com as a new login
  Switch back to work
  Leave it as-is

────────────────────────────────────────────────────────────
enter save as new   esc cancel
```

- **Save as new** opens the Save this login flow with identity and suggested name.
- **Switch back** opens the normal now/after confirmation.
- **Leave it as-is** makes no change and keeps the `◐ changed` status.

### 5.5 No live login

```text
Codex
  › work        dames@acme.com                       ○ saved
    personal    me@gmail.com                         ○ saved

────────────────────────────────────────────────────────────
Sign in to Codex with work
enter switch   a accounts   ? help
```

### 5.6 Live but not saved

```text
Codex                                      new@acme.com
  › Save current login    new@acme.com
    work        dames@acme.com                       ○ saved

────────────────────────────────────────────────────────────
Save new@acme.com as a Codex login
enter save this login   a accounts   ? help
```

`Save current login` is an action row, not a fake saved-login row. It appears only
when the live identity is not stored, and Enter therefore still acts on the focused
object.

### 5.7 Empty tool and empty machine

```text
OpenCode
    No saved logins.

────────────────────────────────────────────────────────────
No OpenCode logins saved
a accounts   ? help   q quit
```

Fresh install:

```text
hotplug / switch

No saved logins yet.

Save a login already on this computer, or add another one.

────────────────────────────────────────────────────────────
a accounts   ? help   q quit
```

### 5.8 Filter

`/` focuses a one-line filter without replacing the list. Results update while the
user types; Enter moves focus to the first visible result.

```text
hotplug / switch                                      ◐ 1 changed

Filter  work█

Codex                                      xolvlab@acme.com
  › work        dames@acme.com                       ◐ changed

Grok                                       jon@grok.com
    work-alt    work@grok.com                        ○ saved

────────────────────────────────────────────────────────────
2 matches
enter focus results   esc clear filter
```

No matches keeps the grouped list area visible with one line:

```text
No saved logins match "work".
esc clear filter
```

### 5.9 Refresh

Refresh is normally inline:

```text
… Refreshing codex/work
✓ Refreshed codex/work
× Couldn't refresh codex/work. Press f to retry.
```

If the tool does not support refresh, do not show `f`.

---

## 6. Proxy

Proxy answers:

> Which proxies are running, and which apps use them?

### 6.1 Main screen

```text
hotplug / proxy                                     ● 1 running

  › grok/jonben       ● running       Claude
    grok/lentau       ○ stopped       –
    opencode/zen      – off           –
    kiro/work         × unavailable   –

────────────────────────────────────────────────────────────
grok/jonben is running
Claude uses this proxy
enter manage apps   s stop   r restart   d turn off   l logs   tab switch
```

Columns are `saved login`, `proxy status`, and `used by`. Do not show port, PID,
protocol, compatibility matrix, or active-pointer state here.

### 6.2 Primary outcomes by state

Running:

```text
Manage apps using grok/jonben
Currently used by Claude
enter manage apps   s stop   r restart   d turn off   l logs
```

Stopped:

```text
Start grok/lentau
App settings won't change.
enter start   d turn off   l logs
```

Off:

```text
Turn on and start opencode/zen
Hotplug chooses the address automatically.
enter turn on and start
```

Unavailable:

```text
kiro/work isn't available
Press l for details, then press enter to check again.
enter check again   l logs
```

### 6.3 Manage apps

Enter on a running proxy opens one scoped picker. It can attach an app to the
selected proxy or stop an app from using that proxy.

Discovering apps:

```text
hotplug / proxy / apps

… Looking for supported apps
```

Checkboxes initialize checked only for apps already using the selected proxy.
Apps using another proxy and apps with no Hotplug proxy initialize unchecked; the
TUI never preselects a new configuration on the user's behalf.

With one available app, the branch is explicit:

- if it is not using this proxy, go to `Use <proxy> with <app>?`;
- if it already uses this proxy, go to `Stop using this proxy with <app>?` from §6.4.

With several apps, checked means “will use this proxy after confirmation.” The
example below is the state after the user selects Codex and Kiro:

```text
hotplug / proxy / apps

Apps using grok/jonben

  [x] Claude      ● using this proxy
  [x] Codex       ● using opencode/zen
› [x] Kiro        ○ not using

────────────────────────────────────────────────────────────
Use grok/jonben with Codex and Kiro
space toggle   enter review 2 changes   esc cancel
```

`[x]` is selection, not completion. App status remains visible separately. Toggling
an app already on another proxy explicitly switches it; leaving it unchecked does
nothing to that other proxy.

Confirmation lists only changes:

```text
hotplug / proxy / apps

Update app setup?

Codex     opencode/zen  →  grok/jonben
Kiro      not using    →  grok/jonben

The proxy is already running.

────────────────────────────────────────────────────────────
enter confirm   esc cancel
```

Completion:

```text
✓ Codex and Kiro use grok/jonben
```

Partial completion:

```text
! Codex uses grok/jonben. Kiro couldn't be updated.
enter retry Kiro   esc keep result
```

No supported apps:

```text
No supported apps were found.
Run a supported app once, then check again.

enter check again   esc back
```

### 6.4 Stop using a proxy

Unchecking an app that currently uses the selected proxy calls the existing reset
operation, then re-inspects the app. Reset does not report whether restoring app
configuration failed, so the TUI never claims a previous or default setup was
restored without verification.

Reset never removes project-specific setup. If one is still stored for the current
project, confirmation says `This project's Hotplug setup stays saved`, and the result
mentions it explicitly.

```text
hotplug / proxy / apps

Stop using grok/jonben with Claude?

now      grok/jonben
after    no Hotplug proxy

Hotplug will remove this proxy from Claude.
Other apps won't change.

────────────────────────────────────────────────────────────
enter confirm   esc cancel
```

An orphaned app configuration still appears and can be reset:

```text
Claude            ◐ attention
```

After reset, inspect the app and report only what can be verified:

```text
✓ Claude no longer uses grok/jonben
! Couldn't verify whether Claude still uses grok/jonben.
× Claude still uses grok/jonben.
```

With a remaining project setup, use:

```text
! Claude stopped using grok/jonben; this project's Hotplug setup remains saved.
```

For a partial or failed result, the error substate owns the rail:

```text
enter retry failed apps   esc keep result
```

If the user has toggled nothing, Enter is disabled and the rail says
`No app changes selected.`

When the focused app already uses this proxy and there are no checkbox changes,
`m` opens the model map for that app (see §6.3.1).

### 6.3.1 Model map (per app)

After confirming an attach (or via `m` on an app already using the proxy), Hotplug
shows the **client-shaped** model slots for that app. Defaults come from the
proxy provider; the user can edit any role with autocomplete (free text allowed).

Claude Code example:

```text
hotplug / proxy / apps / models

Models for Claude
grok/jonben

  › Default    grok-4.5
    Sonnet     grok-4.5
    Opus       grok-4.5
    Haiku      grok-4.3

────────────────────────────────────────────────────────────
Models for Claude · grok/jonben
Defaults come from the proxy; change any role before applying.
enter edit   tab apply with these models   esc back
```

While editing a role:

```text
 › Sonnet     grok-4█

────────────────────────────────────────────────────────────
Edit Sonnet
Suggestions  grok-4.5 · grok-4.3 · grok-4.20
enter save   tab complete   esc cancel edit
```

Rules:

- Roles are defined by the **app** (Claude: default/sonnet/opus/haiku; Codex: default).
- Defaults are defined by the **proxy provider** (e.g. Grok → `grok-4.5` for most roles).
- Values are stored on the app binding and re-applied with the proxy endpoint.
- Multi-app attach opens this screen once per attached app, then applies the batch.
- Do not show env var names or binding internals in primary copy.

### 6.5 Proxy operations

Stopping or turning off a proxy used by an app requires a consequence screen; both
actions leave that app pointing at the proxy.

Stop:

```text
hotplug / proxy

Stop grok/jonben?

Claude currently uses this proxy.
Claude may stop working until you start it again.

────────────────────────────────────────────────────────────
enter stop   esc cancel
```

Turn off:

```text
hotplug / proxy

Turn off grok/jonben?

Claude currently uses this proxy.
Claude may stop working until you change its setup.

────────────────────────────────────────────────────────────
enter turn off   esc cancel
```

When no app uses the selected proxy, Stop remains immediate and Turn off uses the
normal direct confirmation for a persistent state change. Neither action silently
resets app setup.

The normal operation receipts are:

```text
… Starting grok/lentau
✓ Proxy running for grok/lentau

… Stopping grok/jonben
✓ Proxy stopped for grok/jonben

… Restarting grok/jonben
✓ Proxy running again for grok/jonben

… Turning off grok/jonben
✓ Proxy off for grok/jonben

… Turning on opencode/zen
✓ Proxy running for opencode/zen

× Proxy didn't start. Press l for logs or enter to retry.
```

### 6.6 Logs

```text
hotplug / proxy / logs                         grok/jonben  ● running

12:41:03  started
12:41:04  listening locally
12:42:18  request completed
12:42:21  upstream returned 401

────────────────────────────────────────────────────────────
r refresh   esc back
```

- Logs use a dedicated scrollable viewport.
- Logs are snapshots. `r` requests a fresh snapshot; the TUI does not imply a
  streaming/follow capability that the service does not provide.
- Raw technical terms, endpoint, and port may appear because this is a debug surface.
- Empty: `No logs yet.`
- Error: `× Couldn't read logs. Press r to retry.`

### 6.7 Empty Proxy

```text
hotplug / proxy

No saved logins can run a proxy yet.

Add a Grok, OpenCode, Gemini, or Kiro login in Accounts.

────────────────────────────────────────────────────────────
a accounts   tab switch   ? help
```

Manual host and port configuration is not part of the primary TUI. Hotplug chooses
and keeps the local address in sync. Advanced debugging remains available in the CLI.

---

## 7. Accounts

Accounts answers:

> What logins has Hotplug saved, and what maintenance action do I need?

### 7.1 Inventory

```text
hotplug / accounts                                      4 saved

Codex
  › work        dames@acme.com             2h ago      ◐ changed
    personal    me@gmail.com                3d ago      ○ saved

Grok
    jonben      jon@grok.com                1h ago      ● live
    lentau      lentau@gmail.com            8d ago      ○ saved

────────────────────────────────────────────────────────────
codex/work was updated 2 hours ago
enter open in Switch   f refresh   x remove   a add   ? help
```

Do not add an `INSPECT` section. Identity and age belong on the row. Rare actions
may move to the second key-bar line or Help at narrow widths.

### 7.2 Empty Accounts

```text
hotplug / accounts

No saved logins yet.

────────────────────────────────────────────────────────────
a add a login   i import   esc switch   ? help
```

### 7.3 Choose a tool

```text
hotplug / accounts / add

Choose a tool

› Codex       ● signed in as xolvlab@acme.com
  Grok        ● signed in as jon@grok.com
  OpenCode    – signed out
  Kiro        × unavailable

────────────────────────────────────────────────────────────
enter add Codex login   esc cancel
```

While detection runs:

```text
… Checking logins
```

One tool failing does not block the rest. Its row shows `× unavailable` and offers
`enter retry` when selected.

### 7.4 Choose how to add

Live login found:

```text
hotplug / accounts / add / codex

Signed in as xolvlab@acme.com

› Save this login
  Add another login

────────────────────────────────────────────────────────────
enter save this login   esc back
```

The outcome line follows focus: `enter add another login` on the second row.

A signed-out tool skips the one-choice menu:

```text
hotplug / accounts / add / opencode

Sign in to OpenCode

In another terminal, use the normal OpenCode sign-in command.
When sign-in finishes, return here.

────────────────────────────────────────────────────────────
enter check again   esc back
```

Import is a separate Accounts action on `i`; it does not appear inside Add.

If a tool cannot safely clear its local login, omit **Add another login**. Do not
show a disabled option with internal capability wording.

---

## 8. Save this login

### 8.1 Name

```text
hotplug / accounts / save

Save this Codex login

Signed in as xolvlab@acme.com

Name
> xolvlab█

Saved as codex/xolvlab
Codex stays signed in.

────────────────────────────────────────────────────────────
enter save   esc cancel
```

- Suggest a short name from the identity.
- Show the canonical ref only as a dim preview.
- Human-friendly input is normalized live. For example, `Work Team` previews as
  `codex/work-team`; spaces and punctuation are not rejected merely for existing.
- Validation appears only when normalization leaves no usable letters or digits:
  `Name needs at least one letter or number.`
- Empty input does not submit.

### 8.2 Existing name

```text
hotplug / accounts / save

Replace the saved login codex/work?

Existing    dames@acme.com
New         xolvlab@acme.com

This replaces Hotplug's saved copy. Codex stays signed in.

────────────────────────────────────────────────────────────
enter replace   esc choose another name
```

### 8.3 Saving and result

```text
… Saving codex/xolvlab
✓ Saved codex/xolvlab
× Couldn't save this login. Press enter to retry.
```

Success returns to Accounts focused on the saved login.

### 8.4 No login found

```text
hotplug / accounts / save

No Codex login was found.

Sign in with Codex, then return here.

────────────────────────────────────────────────────────────
enter check again   esc back
```

Detection failure is distinct from signed out:

```text
× Couldn't check the Codex login. Press enter to retry.
```

---

## 9. Add another login

This is a guided flow over the existing save, prepare, detect, and switch actions.
Hotplug never performs the official sign-in and does not invent a durable wizard
state.

### 9.1 Protect the current login

If the live login already matches a saved login:

```text
hotplug / accounts / add another

Add another Codex login

Currently signed in as xolvlab@acme.com.
This login is saved as codex/work.

Next, Codex will be signed out on this computer so you can use another login.
Other sessions stay signed in.

────────────────────────────────────────────────────────────
enter prepare Codex   esc cancel
```

If this saved login has a running proxy, the preflight adds its real consequence:

```text
Its proxy will stop while you add the new login.
Claude currently uses it and may stop working until the proxy starts again.
```

Omit the second line when no app uses that proxy.

If the current login is not saved, save it first:

```text
Your current Codex login is not saved yet.

Save it before adding another login.

Name
> work█

────────────────────────────────────────────────────────────
enter save and continue   esc cancel
```

There is no single-key `skip backup` action.

### 9.2 Preparing

```text
… Preparing Codex for another login
```

Saving the previous login and clearing its local sign-in may be separate service
steps, but only this one outcome line is rendered. Internal step names do not leak
into the UI.

Failure before the local login changes:

```text
× Couldn't protect codex/work. Nothing changed.
enter retry   esc cancel
```

Partial failure after the saved copy exists:

```text
! codex/work is safe, but Codex couldn't be prepared for another login.
enter retry   esc switch back
```

### 9.3 Official sign-in

```text
hotplug / accounts / add another

Sign in to Codex

In another terminal, use the normal Codex sign-in command.
When sign-in finishes, return here.

Previous login    xolvlab@acme.com   saved as work
New login         not detected yet

────────────────────────────────────────────────────────────
enter check again   esc cancel
```

Provider-specific commands may be shown when known, but they are presented as a
copyable instruction, not executed by Hotplug.

Checking:

```text
… Checking the Codex login
```

Still signed out:

```text
– No Codex login found yet.
Finish signing in, then check again.

enter check again   esc cancel
```

Same identity detected:

```text
◐ Codex is still signed in as xolvlab@acme.com.
Sign in with the other login, then check again.

enter check again   esc cancel
```

Detection error:

```text
× Couldn't check the Codex login.
enter retry   esc cancel
```

### 9.4 New login detected

```text
hotplug / accounts / add another

● Signed in as me@gmail.com

Name this login
> personal█

Saved as codex/personal

────────────────────────────────────────────────────────────
enter save   esc cancel
```

### 9.5 Finish

```text
hotplug / accounts / add another

✓ Saved codex/personal

Which login should Codex use now?

› Keep personal live       me@gmail.com
  Switch back to work      xolvlab@acme.com

────────────────────────────────────────────────────────────
enter keep personal live   esc accounts
```

When focus moves to the second row, the rail says `enter switch back to work`.

### 9.6 Cancel and switch back

Before preparation, `esc` simply cancels.

After preparation, `esc` opens a deliberate switch-back choice:

```text
Switch Codex back to work?

now      signed out
after    xolvlab@acme.com   work

────────────────────────────────────────────────────────────
enter switch back   esc continue adding
```

If a new login has been detected but is not saved, the consequence must be explicit:

```text
me@gmail.com is not saved yet.
Switching back will replace this local login.

› Save it first
  Switch back without saving
  Continue adding

────────────────────────────────────────────────────────────
enter save it first   esc continue adding
```

Switch-back progress and outcomes use the normal account-switch operation:

```text
… Switching Codex back to work
✓ Codex uses work again
× Couldn't switch Codex back to work.
enter retry   esc continue adding
```

If the TUI is interrupted, it does not claim to resume this wizard automatically.
The previous login remains saved and can be selected from Switch. General operation
journal recovery remains a product concern outside this screen design.

---

## 10. Account maintenance

### 10.1 Remove saved login

```text
hotplug / accounts

Remove codex/work from Hotplug?

dames@acme.com

This removes the saved login from Hotplug.
It does not change the login currently used by Codex.

────────────────────────────────────────────────────────────
enter remove   esc cancel
```

If an app currently uses this login's proxy, insert the factual warning
`Claude currently uses this proxy and may stop working after removal.` Do not claim
that app setup is reset; the existing remove operation does not make that promise.

```text
… Removing codex/work
✓ Removed codex/work
× Couldn't remove codex/work. Press enter to retry.
```

### 10.2 Export

```text
hotplug / accounts / export

Export codex/work

File
> ./codex-work.json█

This file contains login secrets. Keep it private.

────────────────────────────────────────────────────────────
enter export   esc cancel
```

Existing file:

```text
Replace ./codex-work.json?
enter replace   esc choose another file
```

Result:

```text
✓ Exported codex/work
! The exported file contains login secrets.
```

### 10.3 Import

Import is a short sequence using the same input layout:

```text
hotplug / accounts / import

Choose a tool
› Codex
  Grok
  OpenCode
  Kiro

────────────────────────────────────────────────────────────
enter import Codex login   esc cancel
```

```text
Name the imported login
> work█
```

```text
Import file
> ./codex-work.json█
```

Confirmation uses only information available before the existing import call:

```text
Import this saved login?

Tool       Codex
Name       work
File       ./codex-work.json

────────────────────────────────────────────────────────────
enter import   esc cancel
```

Name conflict:

```text
Replace the saved login codex/work?

Existing    old@acme.com
File        ./codex-work.json

This replaces Hotplug's saved copy.

────────────────────────────────────────────────────────────
enter replace   esc choose another name
```

Errors are specific:

```text
× File not found. Check the path and press enter.
× This is not a Hotplug login export. Choose another file.
× Couldn't import this login. Check the tool and file, then retry.
```

The TUI checks path and account-name conflicts before calling the existing service.
It passes overwrite only after the user confirms. It does not promise provider
mismatch detection or a metadata preview that the current service cannot supply.
Likewise, Export may check whether a path exists before calling the existing export
operation; neither flow changes the export format or storage behavior.

### 10.4 Refresh

```text
… Refreshing codex/work
✓ Refreshed codex/work
! Refreshed 2 logins. 1 login needs attention.
```

For a partial result, keep focus on the first failed login and show `enter details`
only if a concrete recovery action exists.

---

## 11. Global utility screens

### 11.1 Startup

```text
hotplug

… Loading saved logins
```

Startup failure:

```text
hotplug

× Hotplug couldn't load its data.
  <one human-readable reason>

────────────────────────────────────────────────────────────
enter retry   q quit
```

### 11.2 Help

```text
hotplug / help

Switch
  ↑ ↓ / j k    move
  enter        run the action shown at the bottom
  f            refresh login
  tab          Proxy
  a            Accounts

Proxy
  enter        manage apps / start
  s r d l      stop / restart / turn off / logs
  tab          Switch
  a            Accounts

Accounts
  a            add a login
  f            refresh
  x            remove
  e / i        export / import

Status
  ● live       tool uses this saved login
  ○ saved      stored in Hotplug
  ◐ changed    live and saved login differ
  × failed     status or action failed

Global
  esc          back or cancel
  ?            help
  q            quit from a main screen

────────────────────────────────────────────────────────────
esc back
```

Help is contextual. Proxy and Accounts show their own keys first. The status legend
is always available. On Accounts, `a` means add a login (not a route to Accounts).
On Switch and Proxy, `a` opens Accounts.

### 11.3 Generic destructive confirm

Destructive confirms use a direct title, object, consequence, and Enter/Esc. They
inherit the parent header path and never hardcode another screen name.

Double submission is disabled after the first Enter.

### 11.4 Generic input

```text
Field label
> value█
  validation or useful consequence
```

- Only the focused field label carries the brand cyan; the typed value stays foreground.
- Cursor uses terminal inverse.
- Validation remains visible until corrected.
- Paste does not echo secret values when the field is secret.

---

## 12. Complete screen and state inventory

Implementation is not complete until every row below uses this visual system.

| Area | Required screens / states |
|---|---|
| Shell | startup, startup error, route loading, stable notice, busy, help, narrow layout |
| Switch | healthy, changed, signed out, unsaved live login, empty tool, empty machine, filter, no results |
| Switch action | confirmation, busy, success, partial success, failure, changed-login decision |
| Proxy | running, stopped, off, unavailable, empty, used by none/one/many, orphaned app |
| Proxy action | turn on, start, stop, restart, turn off, manage-app picker, own-setup confirmation, success, partial result, failure |
| Logs | loading, content, empty, refresh, read failure |
| Accounts | loading, inventory, empty, tool picker, status unavailable |
| Save | detecting, signed in, signed out, naming, validation, conflict, busy, success, failure |
| Add another | preflight, protect, partial failure, sign-in instruction, recheck, same login, new login, naming, finish, cancel, unsaved-new-login warning, switch-back busy/success/failure |
| Remove | confirm, busy, success, failure |
| Export | path, validation, overwrite, busy, success warning, failure |
| Import | tool, name, path, validation, confirmation, conflict, busy, result |

Legacy screens must either migrate to this system or leave the active build. Do not
leave alternate chrome or terminology available for reuse.

---

## 13. Product boundaries retained

This UI redesign does not add:

- a clients inventory screen;
- launching Claude, Codex, or Kiro from the TUI;
- gateways, presets, or project links;
- quota or usage data;
- login automation;
- durable Add-another wizard recovery beyond existing operation journals;
- manual port homework;
- pipeline education.

Hotplug detects and stores official-tool logins. The user performs official sign-in.

---

## 14. Implementation contract

### Required primitives

- `ScreenShell` — header, stable notice slot, viewport, bottom rail;
- `DataRow` — focus gutter plus responsive columns;
- `StatusToken` — glyph, label, semantic color;
- `OutcomeRail` — primary outcome, supporting fact, valid keys;
- `KeyHints` — structured, prioritized, responsive hints;
- `NoticeLine` — content inside the shell's fixed two-line notice slot;
- `TextField` — foreground text, inverse cursor, inline validation;
- `Picker` — single or multi-select using the same row grammar;
- `Viewport` — height-aware clipping and scroll indicators.

Do not build generic cards or an Inspect component.

### Acceptance checks

1. `theme` exposes exactly two brand hues, both hex, and no component hard-codes a colour
   literal — every colour is read from `theme` via `brandColor()` or `statusColor()`.
2. The extracted user-facing string catalog and rendered snapshots contain no
   `INSPECT`, `CONTEXT`, `make-live`, `stash`, `snapshot`, `binding`, or `provenance`.
3. Selection remains visible with `NO_COLOR`.
4. Status meaning remains visible with `NO_COLOR`.
5. Every footer hint is valid for the current state.
6. No screen renders two adjacent dividers.
7. Notices and busy states do not move the selected row.
8. Visual snapshots cover widths `48, 64, 80, 96, 120` and heights `16, 24, 40`.
9. Long email, account name, path, and log lines do not break the action rail.
10. `q`, `esc`, and Ctrl-C restore the cursor and terminal mode.
11. Add-another covers cancel before/after preparation, warns before replacing an
    unsaved new login, and never claims durable wizard resume.
12. Confirm screens preserve their parent path and reject double submit.

---

## 15. Final rule

If a line explains Hotplug's internal pipeline instead of what becomes true for the
user, remove it.

If a visual element does not improve focus, state recognition, or the next action,
remove it.
