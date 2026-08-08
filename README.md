<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img alt="Hotplug" src="assets/logo.svg" width="380">
  </picture>
</p>

<p align="center"><b>Plug any AI into any tool.</b></p>

<p align="center">
  <a href="https://www.npmjs.com/package/hotplug"><img alt="npm" src="https://img.shields.io/npm/v/hotplug?color=6A5CFF&label=npm"></a>
  <a href="#requirements"><img alt="node" src="https://img.shields.io/badge/node-%E2%89%A5%2022.5-2563FF"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-00D4FF"></a>
</p>

---

Your Claude Code subscription, your Codex login, your Gemini account, your
OpenRouter key — Hotplug makes any of them the engine behind any supported CLI.

```bash
hotplug use claude --with grok/work    # Claude Code, powered by your Grok account
hotplug run claude
```

```text
Claude is the client.
grok/work is the source.
use makes it the default.
run launches it.
```

Auth snapshots, local proxies, protocol conversion, env injection, and client
config files are Hotplug's job. You pick a **client** and a **source**.

## Install

```bash
npm install -g hotplug     # or: pnpm add -g hotplug
hotplug
```

The binary is installed as `hotplug`, with `rotate` kept as an alias. Later,
`hotplug update` upgrades an npm-installed copy (`--check` reports only).

Optional shell completion:

```bash
source <(hotplug completion zsh)   # or bash | fish
```

### Requirements

Node.js ≥ 22.5. Hotplug stores its data in SQLite through `node:sqlite`, which
needs that version; Node may still print an `ExperimentalWarning` for it, which
the CLI entry suppresses.

### Support policy

Hotplug's supported release platform is **Linux on Node.js 22.5 or newer**.
The CI matrix verifies that contract from the packed tarball. macOS-specific
tray support is best effort; Windows is not a supported platform. See
[`SECURITY.md`](./SECURITY.md) for supported security-fix versions and private
reporting instructions.

### From source

```bash
pnpm install && pnpm build
pnpm link --global   # optional
```

## Mental model

| Word        | Meaning                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| **Client**  | CLI you run: `claude`, `codex`, `gemini`, `kiro`                                                      |
| **Source**  | Account `grok/work` / `gemini/work`, gateway `openrouter-work`, pool `pool:gemini`, or preset `@work` |
| **Binding** | Concrete snapshot: this client → this source (+ model roles)                                          |
| **Preset**  | Editable template (`@name`) — only after explicit `--save`                                            |

```
use   = set default binding (persistent)
run   = launch with binding (ephemeral; does not rewrite live defaults)
link  = project-local binding
```

Grammar (always):

```bash
hotplug use|run <client> --with <source|@preset>
```

|               |                                                                          |
| ------------- | ------------------------------------------------------------------------ |
| Data          | `~/.hotplug/hotplug.db`                                                  |
| Override home | `HOTPLUG_HOME=/path`                                                     |
| Interactive   | bare `hotplug` on a TTY opens the command-center launcher                 |

Global flags: `--json` · `-v` · `-q` · `--dry-run` · `--reveal` · `--no-input` · `-y`

---

## Daily commands

```bash
# Set defaults
hotplug use claude --with grok/work
hotplug use claude --with openrouter-work
hotplug use claude --with @work-stack          # preset
hotplug use claude --current                   # re-apply stored snapshot
hotplug use claude --with grok/work --save work-stack

# Launch
hotplug run claude                             # uses project then global binding
hotplug run claude --with grok/work            # one-shot; does not change bindings
hotplug run codex --with openrouter-work

# Inspect
hotplug current
hotplug current claude
hotplug list                                   # accounts · gateways · clients · presets
hotplug list accounts
hotplug list gateways

# Projects
hotplug link claude                            # from global binding
hotplug link claude --with grok/work
hotplug unlink claude

# Add sources
hotplug add account codex --current --name personal
hotplug add account grok --new --name work
hotplug add gateway openrouter-work \
  --provider openrouter \
  --endpoint https://openrouter.ai/api/v1 \
  --api-key "$OPENROUTER_API_KEY"

# Cleanup / health
hotplug reset claude
hotplug doctor
hotplug doctor --fix -y                        # only safe Hotplug-owned fixes
```

Non-TTY / CI: `use <client>` requires `--with` or `--current` (exit `2` if missing). No prompts.

---

## Sources

### Accounts (native logins)

| Provider     | Live auth                              | How Claude/Codex use it                                         |
| ------------ | -------------------------------------- | --------------------------------------------------------------- |
| **codex**    | `~/.codex/auth.json`                   | direct for Codex only                                           |
| **grok**     | `~/.grok/auth.json`                    | built-in dual proxy (OpenAI + Anthropic)                        |
| **opencode** | OpenCode auth store                    | built-in Zen/Go dual proxy                                      |
| **gemini**   | `~/.gemini/` (`.env`, oauth, accounts) | built-in dual proxy → Gemini API (API key or Code Assist OAuth) |
| **kiro**     | AWS SSO kiro tokens                    | external `kirolink` / `kiro-proxy` if installed                 |

```bash
# After logging in with the native tool:
hotplug add account codex --current --name personal
hotplug add account grok --current --name work
hotplug add account gemini --current --name work

hotplug use codex --with codex/personal
hotplug use claude --with grok/work
hotplug use claude --with gemini/work              # starts Gemini proxy if needed
hotplug run claude
```

**Dynamic model discovery:** the Gemini proxy reads `models.list` for API-key accounts and Code Assist `fetchAvailableModels` for OAuth accounts (with quota metadata as a legacy fallback). Display names, rollout IDs, defaults, and ordering come from that live catalog. The OpenCode proxy intersects the live Zen/Go catalogs with provider metadata to choose the correct Messages, Chat Completions, Responses, or Google protocol. The Grok proxy forwards the authenticated upstream `/v1/models` catalog and requested model IDs unchanged. These proxies do not inject a static model list when discovery is unavailable, so newly released models do not require a Hotplug release. Set `OPENCODE_MODEL_METADATA_URL` to override the OpenCode metadata source, or to `none` to disable enrichment.

**Reasoning and thinking:** compatibility translations preserve Codex/OpenAI `reasoning_effort` and Responses `reasoning.effort`, Claude `output_config.effort`, adaptive thinking, manual `budget_tokens`, and visible thinking summaries. Native Anthropic/OpenAI routes remain pass-through. Google routes translate the same intent to Gemini `thinkingConfig` and keep thought summaries separate from final answer text. Gemini also implements the modern `/v1/responses` request and SSE lifecycle required by current Codex CLI releases, including reasoning items and function calls.

Managed proxies start automatically when the transport needs them. Manual lifecycle remains under `hotplug proxy` for debugging.

On macOS, closing the default TUI hands proxy ownership to a native menu-bar
status item (without a Dock icon). Hotplug opens iTerm2 when it is installed and
falls back to Terminal. Its menu can reopen Hotplug, restart enabled proxies,
stop every proxy, or quit with a graceful shutdown. On Linux the same lifecycle
runs as a headless background supervisor (there is no bundled native tray icon);
use the CLI commands below to inspect or stop it.

```bash
hotplug tray start
hotplug tray status
hotplug tray stop      # quits the supervisor and stops every Hotplug-owned proxy
```

Set `HOTPLUG_NO_TRAY=1` to make the terminal UI exit without starting the
menu-bar supervisor. `hotplug proxy stop` with no provider/account also stops
all running account proxies, including an inactive account left from an older
session.

### Gateways vs proxies

|           | **Proxy** (account)              | **Gateway** (API profile)               |
| --------- | -------------------------------- | --------------------------------------- |
| Auth      | Login snapshot (+ local process) | Endpoint + API key stored in Hotplug    |
| Bind apps | Proxy board → manage apps        | Gateways (`g`) → manage apps            |
| Models    | Per app when binding             | Gateway defaults + per app when binding |

Both end the same way: **client uses a source** (`use claude --with …`).

### Model map (Claude roles)

When you attach a proxy **or gateway** to Claude (TUI **manage apps** or after confirm), Hotplug sets:

- `ANTHROPIC_MODEL` (default)
- `ANTHROPIC_DEFAULT_SONNET_MODEL` / `OPUS` / `HAIKU`

Defaults come from the running proxy's live `/v1/models` catalog when available. Re-edit with **`m`** on Proxy or Enter on an app already using the proxy.

### Multi-account pool (opt-in)

Default remains **one proxy process per account**. Enable multi only when you want one endpoint and failover:

```bash
hotplug proxy pool enable gemini -p 4130
hotplug proxy pool member gemini work on
hotplug proxy pool member gemini alt off
hotplug use claude --with pool:gemini
hotplug proxy pool disable gemini          # back to single-account
```

TUI Proxy board: **`p`** toggles multi pool; **space** on a member pauses/enables it.

### Gateways (API endpoint + key + models)

```bash
hotplug add gateway openrouter-work \
  --provider openrouter \
  --endpoint https://openrouter.ai/api/v1 \
  --api-key "$OPENROUTER_API_KEY" \
  --model anthropic/claude-sonnet-4 \
  --models anthropic/claude-sonnet-4 openai/gpt-5.6-sol google/gemini-3.1-pro

hotplug use claude --with openrouter-work
hotplug run claude
```

For Codex, `--models` writes a managed model catalog so these gateway models
appear in `/model`. Local account proxies discover their live `/v1/models`
catalog automatically whenever Hotplug activates Codex.

Catalog providers: `anthropic` · `openai` · `openrouter` · `grok-api` · `litellm` · `local` · `custom`

### Presets

```bash
hotplug use claude --with grok/work --save work-stack
hotplug use claude --with @work-stack
hotplug preset list
hotplug preset edit work-stack --model …
```

Editing a preset never rewrites existing global/project bindings (they are snapshots).

---

## Projects

```bash
cd ~/src/my-app
hotplug link claude                  # copy global binding into this project
hotplug link claude --with grok/work
hotplug run claude                   # project binding wins over global
hotplug unlink claude
```

---

## Clients

```bash
hotplug clients
# claude  — Claude Code (ANTHROPIC_*; isolated temp home on run)
# codex   — Codex CLI
# gemini  — Gemini CLI (GEMINI_API_KEY / GEMINI_MODEL)
# kiro    — Kiro
```

`hotplug run` uses an **isolated temporary client home** for Claude / Codex / Kiro so live config is not patched for one-shot runs. Cleanup runs after normal exit and after SIGINT/SIGTERM.

Interactive TUI: run bare `hotplug` on a TTY → **Switch** / **Proxy** / **Accounts** / **Gateways** (`g`).

---

## Proxy (advanced)

Built-in and external proxies are usually started by `use` / `run`. Manual control:

```bash
hotplug proxy
hotplug proxy start
hotplug proxy stop
hotplug proxy enable grok work -p 8080
hotplug proxy enable gemini work -p 4130
hotplug proxy config gemini work --oauth-source auto        # default: Gemini CLI → Antigravity
hotplug proxy config gemini work --oauth-source antigravity # optional source override
hotplug proxy logs gemini
hotplug proxy pool enable gemini -p 4130   # opt-in multi-account
```

| Provider default port |        |
| --------------------- | ------ |
| grok                  | `8080` |
| kiro                  | `4119` |
| opencode              | `4120` |
| gemini                | `4130` |

The OpenCode proxy picks the Zen or Go catalog from the live account itself;
`--auth-mode public` pins it to Zen. `OPENCODE_PROXY_UPSTREAM` overrides the
upstream base URL.

Gemini auth defaults to `auto`: it respects the Gemini CLI's selected OAuth/API-key login first, then reads the signed-in Antigravity credential from macOS Keychain when the CLI catalog does not expose the requested model or returns an entitlement error. Successful catalog aliases are resolved within the same auth source, so an Antigravity rollout ID is never sent through Gemini CLI by mistake. `--oauth-source gemini-cli|antigravity` pins one source for debugging or policy control.

---

## Doctor & errors

```bash
hotplug doctor
hotplug doctor --fix --dry-run
hotplug doctor --fix -y
```

`--fix` only touches the hard allowlist (stale locks/PIDs, orphan proxies, temp overlays, permissions, journal rollback). It never mutates native auth or bindings.

| Exit  | Meaning                                                   |
| ----- | --------------------------------------------------------- |
| `0`   | success                                                   |
| `2`   | invalid usage (missing client/source, non-TTY bare `use`) |
| `3`   | not found                                                 |
| `5`   | capability conflict / unsupported transport / no binding  |
| `7`   | missing required dependency (e.g. external proxy binary)  |
| `130` | cancelled (SIGINT)                                        |

---

## Manage resources

```bash
# Accounts
hotplug account list
hotplug account refresh codex
hotplug account refresh codex --all
hotplug account remove codex old -y
hotplug account export codex work -o ./work.json
hotplug account import codex work -i ./work.json

# Gateways
hotplug gateway list
hotplug gateway show openrouter-work
hotplug gateway edit openrouter-work -m anthropic/claude-sonnet-4
hotplug gateway remove old-gateway -y

# Presets
hotplug preset list
hotplug preset show work-stack
hotplug preset remove work-stack

# Plugins — a provider/client/catalog you wrote, without forking the CLI
hotplug plugin add ./acme-provider    # installs it disabled
hotplug plugin enable acme-provider   # the trust decision; prompts
hotplug plugin trust acme-provider    # re-pin after its code changes
hotplug plugin list
```

A plugin runs in the Hotplug process, so it is never loaded until you enable it
by name, and only at the entry-module digest you approved — verified before the
module is imported. `HOTPLUG_NO_PLUGINS=1` skips loading entirely. See
[`adr/0012-plugin-trust-boundary.md`](./adr/0012-plugin-trust-boundary.md) and
[`SECURITY.md`](./SECURITY.md).

---

## Examples

### Claude on Grok

```bash
# login with Grok CLI first
hotplug add account grok --current --name work
hotplug use claude --with grok/work
hotplug run claude
```

### Codex multi-account

```bash
codex login
hotplug add account codex --current --name personal
# add another login (clears live auth so you can re-login):
hotplug add account codex --new --name work
hotplug use codex --with codex/work
hotplug run codex
```

### OpenRouter → Claude

```bash
hotplug add gateway openrouter-work \
  --provider openrouter \
  --endpoint https://openrouter.ai/api/v1 \
  --api-key "$OPENROUTER_API_KEY" \
  --model anthropic/claude-sonnet-4

hotplug use claude --with openrouter-work
hotplug run claude
```

### One-shot without changing defaults

```bash
hotplug run claude --with openrouter-work
# global binding unchanged
```

### Project override

```bash
hotplug use claude --with grok/work          # global
cd ~/src/client-a
hotplug link claude --with openrouter-work   # project only
hotplug run claude
```

---

## Command reference

| Command                                       | Description                          |
| --------------------------------------------- | ------------------------------------ |
| `hotplug`                                     | Interactive menu (TTY)               |
| `use <client> --with <source>`                | Set global binding                   |
| `use <client> --current`                      | Re-apply stored global snapshot      |
| `use <client> --with … --save <name>`         | Bind and create preset               |
| `run <client> [--with …]`                     | Launch (project → global → error)    |
| `current [client]`                            | Show effective bindings              |
| `list [accounts\|gateways\|clients\|presets]` | Inventory                            |
| `add account \| gateway`                      | Create sources                       |
| `link` / `unlink`                             | Project bindings                     |
| `reset <client>`                              | Remove Hotplug-managed client config |
| `account` / `gateway` / `preset`              | CRUD for resources                   |
| `proxy`                                       | Manual proxy lifecycle               |
| `tray`                                        | Background proxy supervisor          |
| `plugin`                                      | Install and trust extensions         |
| `doctor`                                      | Diagnose; optional safe `--fix`      |
| `update [--check]`                            | Self-update from npm                 |
| `completion zsh\|bash\|fish`                  | Shell completion                     |

---

## Documentation

Long-form docs live in [`docs/`](./docs/) and are published as a static site.

### Programmatic API

The supported library entrypoint is asynchronous and opens a fully migrated,
recovered application. Importing `hotplug` itself performs no filesystem,
process, plugin, or SQLite work.

```ts
import { createHotplugApp } from 'hotplug';

const app = await createHotplugApp({ root: '/safe/hotplug-root' });
try {
  console.log(await app.accounts.list('grok'));
} finally {
  app.close();
}
```

Use `hotplug/adapters` for supported extension contracts and `hotplug/types`
for domain types. `hotplug/testing` is intentionally unstable test plumbing;
all other deep imports are unsupported and blocked by the package export map.

```bash
cd docs && pnpm install && pnpm dev
```

---

## Development

```bash
pnpm install
pnpm dev            # tsx src/cli.ts
pnpm typecheck
pnpm test
pnpm build          # declarations with tsc, then native Node ESM with Vite
pnpm check          # format + lint + typecheck + test
pnpm package        # clean dist + build + npm tarball in dist/
pnpm package:smoke  # package, then verify that exact tarball
```

```
src/
  cli/           primary commands, interactive, help, completion
  core/          sqlite, bindings, planner, executor, journal, locks, doctor
  providers/     codex, grok (+proxy), kiro, opencode (+proxy)
  providers/protocol/  shared wire-format translation (anthropic, gemini)
  clients/       claude-code, codex, kiro (isolation manifests)
  sources/       account + gateway SourceAdapter.transportFor
  catalog/       gateway model catalogs
  tui/           Ink UI; tui/model/ holds the pure view models
  tray/          menu-bar/system-tray supervisor
  network/       shared HTTP plumbing for proxies
  utils/         errors, process supervision, fs helpers
```

### Why is it like this?

- [`adr/`](./adr/) — accepted architecture decisions, each with context and
  consequences. [`adr/README.md`](./adr/README.md) is the index. Start here, and
  cite ADR numbers (not spec sections) in new code comments.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — layering rules, how to add a provider
  or client, lint policy.
- [`docs/history/`](./docs/history/) — the original design and planning
  documents, kept for provenance. Not current documentation; several source
  comments still cite their `§` numbers, which is why they are still around.

TypeScript / Vitest / Vite are pinned to the current majors used in CI; they are
newer stacks — re-check when upgrading.

## Brand

Assets live in [`assets/`](./assets/): logo lockups, logomark, 512px app icon,
and the macOS menu-bar template glyph.

| Token         | Hex       | Used for                                        |
| ------------- | --------- | ----------------------------------------------- |
| Navy          | `#0B1020` | Dark backgrounds                                |
| Violet        | `#6A5CFF` | Wordmark                                        |
| Electric Blue | `#2563FF` | Selection and focus — legible on light and dark |
| Cyan          | `#00D4FF` | Logo gradient, and dark surfaces only           |
| Light Gray    | `#F2F4F8` | Light backgrounds                               |

Cyan is kept out of the terminal UI on purpose: a terminal's background cannot
be detected, and cyan on a light theme is about 1.9:1.

---

## License

MIT © Hotplug contributors. See [`LICENSE`](./LICENSE).
