# Changelog

**Releases after 1.0.0 are not written here.** `changelogithub` builds the notes
from the commits between two tags and publishes them to
[GitHub Releases](https://github.com/hotplug-dev/hotplug/releases), so the commit
message *is* the changelog entry — see `CONTRIBUTING.md` for the format.

This file is the record of everything that shipped in 1.0.0, which predates that
tooling and predates the repository's own history. It is kept, not regenerated.

This project follows [Semantic Versioning](https://semver.org/).

## 1.0.0 - 2026-07-27

### Added
- **Kiro accounts from an API key.** `hotplug add account kiro --api-key [key]`
  saves a `ksk_…` key as an account — prompting for it when the value is
  omitted, so it need not appear in shell history — and `--region` pins the API
  region. The account's proxy runs kirolink in `api-key` mode against exactly
  that key, so a key and an OAuth login can be switched between like any two
  accounts. A provider opts in by declaring `credentialInputs` and implementing
  `backupInput`; core validates the request without knowing the provider.
  Credential material the user supplied is marked `credentialKind: 'proxy-only'`
  and is exempt from every path that treats a snapshot as a mirror of the live
  login: it never reports as live, activation does not restore it over the
  native credential, and a refreshed live token is never written into it.
  The terminal UI offers the same thing: the add-account screen now shows
  **Use an API key instead** even when nothing is signed in, and collects the
  key, the region and the account name on one inline form — tab between rows,
  the key masked as it is typed, the region's known values under the arrow keys
  but still editable. A provider declares those qualifiers with
  `credentialInputFields`, so the TUI never learns what a region is. A region
  that could not be a runtime hostname is rejected when the account is saved
  instead of when its proxy starts.
- Plugins: a released `hotplug` binary can now load third-party providers,
  clients, and catalog providers from a local directory containing a
  `hotplug.plugin.json`, via `hotplug plugin add|list|enable|disable|trust|remove`.
  Plugins install **disabled** and only load after an explicit `enable`, which
  pins a SHA-256 digest of the entry module; the digest is verified *before* the
  module is imported, so changed code is refused until it is reviewed and
  `trust`ed. `activate(ctx)` runs inside the same window as the built-in
  registration, immediately before the registries seal, and `PluginContext`
  exposes only the three register functions — no database, stores, or data root.
  A refused plugin is reported through events, `plugin list`, and `doctor`
  rather than aborting startup, and `HOTPLUG_NO_PLUGINS=1` skips loading
  entirely. See ADR-0012 and `SECURITY.md`.
- `hotplug update`: compares the running version against the `latest` npm
  dist-tag and installs it with `npm install -g hotplug@<version>`, pinning the
  exact version it reported. `--check` reports without installing, `--dry-run`
  prints the command, and `--json` emits the comparison.
- Documentation site under `docs/`, built with nimbus-docs on Astro and
  deployable to Cloudflare Workers. Covers getting started, concepts, guides
  for accounts / gateways / proxies / projects / the terminal UI, and a CLI and
  troubleshooting reference.
- Agent briefs: `AGENTS.md` at the root (invariants, verified traps, where the
  authority lives) and `docs/AGENTS.md` for the docs site, with `CLAUDE.md` and
  `GEMINI.md` symlinked to each so every tool reads one source of truth.
- Brand assets under `assets/`: logo (light and dark), logomark, application
  icon, and the macOS tray template icon.
- OSS scaffolding: `LICENSE` (MIT), `CONTRIBUTING.md`, `CHANGELOG.md`, and a
  GitHub Actions CI workflow that runs `pnpm check` on every push/PR.
- Real activation rollback: mutating activation steps now record backup paths
  to the operation journal, and a failed activation restores prior state
  (client config, native auth, started proxies) before reporting failure.
- Proxy process reaping: on startup, leases whose owning process has exited
  are released and their proxy processes stopped, preventing detached-proxy
  accumulation across CLI/TUI sessions.

### Changed
- Decomposed the TUI root component. `src/tui/app-ui.tsx` went from 3324 lines
  to 109, and now owns nothing but the hook graph. Behavior lives in one hook
  per concern — `useTuiShell` (navigation, busy banner, inline error, receipt),
  `useTuiNav` (screen models and the `open*` loaders), and one per domain under
  `src/tui/actions/`: app bindings, gateway, proxy, account, the Switch board
  filter, and the shared model-role editor. Rendering lives in four route
  modules under `src/tui/routes/`, each handed the whole graph as one
  `RouteCtx` and returning the first screen it owns. The hooks form a DAG
  (`shell → nav → bindings → {gateway, proxy}`), so the routes are pure
  functions of state and no screen behavior changed. The text-entry screen
  moved to `src/tui/screens/text-input.tsx` with its per-purpose dispatch in
  `useTextInputSubmit`, and the six model-role edit handlers — previously
  duplicated byte-for-byte between the proxy and gateway model screens — now
  come from `roleEditor.handlers()`.
- The gateway endpoint editor no longer presents itself as a create step: it
  reads `gateways / edit` instead of `gateways / add`, and enter is labelled
  `save` rather than `next`, since it commits immediately.
- The TUI busy banner now shows a label for operations that previously ran with
  a blank banner: checking a saved login, reading proxy logs, turning a proxy
  off, and confirm-screen actions.
- `HotplugError` suggestions now reach the TUI as receipt hint lines wherever a
  failure is reported, matching what `toHuman()` prints on the CLI.
- **Renamed the project to Hotplug.** The npm package is now `hotplug` and the
  primary binary is `hotplug`, with `rotate` kept as a bin alias. The data
  directory moved from `~/.rotate` to `~/.hotplug` and the override variable
  from `ROTATE_HOME` to `HOTPLUG_HOME`; other `ROTATE_*` variables follow the
  same rename. There is no automatic migration — move the directory by hand.
- The terminal UI, prompts, and log output use the Hotplug palette (navy,
  violet, electric blue, cyan) in place of the previous neutral scheme.
- `activation-executor` now interprets `ActivationPlan.steps` as the source of
  truth for execution and rollback, instead of re-deriving behavior from
  transport capability. The planner and executor can no longer silently
  diverge.
- `BindingService.runPrepare` (ephemeral `run`) now routes through the shared
  `executeActivation` pipeline rather than a parallel `runPrepareLocked`
  implementation, removing duplicated proxy/lease/native-auth logic.
- Pool transport policy moved onto the providers. `poolAdapterFor` no longer
  branches on `providerId`; a provider declares its proxy transport when it
  builds its own pool adapter. Three of the four branches were already
  equivalent to the fallback.
- Provider capability checks go through `providerCanProxy` from
  `core/capabilities.ts` instead of open-coded `typeof provider.startProxy ===
  'function'` in the CLI, TUI, source adapters, and source resolver.
- The programmatic surface is now split in two. `Hotplug` is the supported
  contract — services, registries, events, lifecycle — and `HotplugApp` extends
  it with the database and raw stores for the CLI, TUI, and tray. Embedders
  should annotate against `Hotplug`; the header of `src/index.ts` previously
  claimed store plumbing was excluded while `HotplugApp` exposed all of it.

### Fixed
- **Switching to an Antigravity account changed nothing outside Hotplug.** An
  Antigravity login lives in the OS credential store, not under `~/.gemini`, and
  `gemini-antigravity-oauth.ts` could read and delete that entry but not write
  it — so `restore()` counted the snapshot as restored and left the store
  holding the previous account. Antigravity itself, and anything else reading
  the store, stayed signed in as whoever was there before; only Hotplug's own
  proxy followed the switch, because it reads the snapshot directory. The
  credential is now written back, in the platform's own format and over stdin
  rather than argv, and updated in place where the platform allows so the
  existing item's access control survives. The snapshot keeps the whole
  credential-store payload instead of the reduced `{refresh_token, token_type}`
  the proxy needs; snapshots written in the old shape are wrapped on read.
- **No Gemini account ever reported as live.** `GeminiProvider` delegated to
  `snapshotMatchesLiveDefault`, which looks for `auth.json` — a file Gemini has
  never written — so the fingerprint was always null and every saved account,
  including the active one, showed as merely saved. Gemini now compares its own
  credential material, and only the durable part of it: the refresh token rather
  than the whole `oauth_creds.json`, which both the CLI and the proxy rewrite on
  every access-token rotation. An Antigravity snapshot reports "not
  determinable" rather than guessing, since naming the account inside the
  credential store means reading the secret.
- **`account refresh` could overwrite an unrelated account.** Refreshing the
  live login synced the result into whichever account was active, with `force`.
  Gemini reads one Antigravity credential-store entry for every account, so an
  out-of-band sign-in as someone else turned a refresh into a silent overwrite
  of the active account's snapshot. The sync now goes through the same
  identity-checked path a switch uses, which reports `UNSAVED_LIVE_AUTH`
  instead.
- **A disbanded proxy pool kept redirecting an account's proxy.** Enabling a
  pool persisted its members' absolute snapshot paths as `authDirs` on the
  primary account's proxy config, and nothing removed them when the pool
  returned to single mode. Providers give `authDirs` precedence over the
  account's own snapshot directory, so that account served whatever those paths
  held — and after the `~/.rotate` → `~/.hotplug` rename, which has no
  migration, they pointed into a directory the rest of Hotplug had stopped
  updating. Pool auth dirs are now computed when the pool proxy starts and never
  stored, and pool options are dropped from any account config that still
  carries them.
- **A Kiro login was invisible to Hotplug.** The provider looked for two literal
  filenames in `~/.aws/sso/cache`, and neither exists any more. kiro-cli 2.x keeps
  its token in a secret store — the OS keychain, mirrored into an `auth_kv` table
  in its own SQLite database — while the Kiro IDE writes AWS-SSO-style files whose
  names are content hashes. Both are now handled: the secret store is read and
  written through the same `security(1)` calls kiro-cli itself makes, so an item
  Hotplug writes carries the same keychain ACL and is read back without an
  authorization prompt, and cache files are recognised by *shape* instead of by
  name, which also skips the client-registration files sharing that directory.
  Restoring a snapshot removes the cache files it is not restoring, because the
  proxy picks a token by expiry and a leftover file from another account would
  silently win. Identity comes from the profile id in `profile_arn`, since a Kiro
  token carries no email.
- **The Kiro proxy ignored the account it was bound to.** `kirolink` was spawned
  with no auth mode, so it fell back to its own saved config — which may be
  `api-key` mode against an unrelated Kiro key. The proxy started, answered
  `/health`, and served a different identity than the bound account. Hotplug now
  sets `KIROLINK_AUTH=cli` for the spawned process; kirolink applies an
  environment override for that run only, so a bare `kirolink` keeps the user's
  own mode.
- **An external proxy could be started but never stopped.** `stopPidFile` proved
  ownership by requiring the child to echo `HOTPLUG_INSTANCE_ID` from `/health`,
  which a third-party binary cannot do, so `proxy stop kiro` always failed closed
  and left the process holding its port — after which `proxy start` short-circuited
  to the orphan. External proxies now prove ownership from the process start time
  instead: PID reuse necessarily happens after the original exits, so a live
  process whose start time matches the record's `createdAt` cannot be a recycled
  PID. PROC-01 still fails closed when the start time cannot be read or does not
  match.
- **A failing external proxy reported nothing usable.** `PROXY_START_FAILED` said
  only which host and port were tried, so a binary that exited immediately and
  wrote no log — a package-manager shim left pointing at a library entry instead
  of the CLI produces exactly that — was untraceable. The error now names the
  resolved binary and full argv, distinguishes "exited immediately" from "still
  running but never answered", and says explicitly when the log was empty.
- **Account mutations were not locked.** `save`, `use`, `stash`, `refresh`,
  `delete`, and `importAccount` rewrote snapshots and live credential files with
  no coordinator lock, so two concurrent invocations could interleave
  `prepareSnapshot` → `backup` → `writeMeta`, and two saves of the same upstream
  login could each resolve their target before the other committed and create
  duplicate accounts for one identity. All six now hold a re-entrant
  `provider/<id>` scope for their whole body (ADR 0011).
- Live-login detection worked only for Codex. Every provider now reports `live`
  when the credential on disk matches a saved snapshot.
- "Add / login another account" no longer dead-ends when the provider CLI login
  was completed in a separate terminal: the live credential is detected and
  offered for saving.
- Adding a Gemini or Antigravity account now stashes the existing credential
  first, so the provider CLI prompts for a fresh login instead of reusing the
  current one.
- Terminal UI hotkeys were audited for collisions; export moved from `o` to
  `e`.
- A committed filter on the Switch board was a dead end. `esc` was only bound
  while the filter prompt was open, so once the query was submitted there was no
  advertised way to release it, and a query matching nothing rendered the
  empty-machine copy — "No saved logins yet. Save a login already on this
  computer" — which is wrong and sends the user off to save a login they
  already have. `esc` now clears a committed filter from the board, the hint row
  says so, and an unmatched query reports the query.
- Documentation errors found while preparing the release: `add gateway` takes
  `--model`, not `-m` (that alias exists only on `gateway edit`), and
  `OPENCODE_PROXY_SERVICE` was never implemented — the OpenCode proxy derives
  the Zen or Go catalog from the account, and `--auth-mode public` pins Zen.
- The packaging CI job globbed for `rotate-*.tgz`, which no longer matches the
  renamed package.
- The operation journal no longer reports `rolled_back` for activations that
  did not actually restore any state. Failures that mutate live configuration
  are now rolled back (or marked `failed` with recovery possible on next
  startup).
- Fixed layering inversion where `AccountService` accepted an app-level
  `wireClientAlign` callback after construction. Client realignment is now a
  constructor-injected dependency, so the service has no upward dependency on
  the app graph and there is no two-phase wiring.

### Removed
- Dead `@deprecated` helper `proxyInspectLines` (superseded by `proxyOutcome`)
  and a stale "kept for tests" annotation on `hotplugContextLines` (which is in
  fact a live helper).
- `HotplugApp.withMutationLock`. It locked a `.mutate.lock` file that no scoped
  coordinator lock respected, so it could only give a false sense of exclusion;
  nothing called it. Services own their locks (ADR 0009).
- Unreachable duplicates of the account CLI (`src/cli/commands-account.ts`,
  `src/cli/commands-shared.ts`), which no module imported.

### Notes / follow-ups
- The full extraction of proxy port-allocation and process supervision out of
  `AccountService` into a dedicated `ProxyOrchestrator` is still pending. The
  layering inversion is fixed and lease reaping is now owned by
  `core/proxy-lifecycle.ts`, but `AccountService` remains large; splitting it
  is tracked as a follow-up refactor.
