# AnyPick v1.1.1 — In-App Update: Architecture Design Note
Status: Initial architecture decisions and current v1.1.1 shipping scope · Base: origin/main @ ac8ce2b (v1.1.0).

## 0. Repo facts this design rests on
- Version: single `VERSION` file; release.yml requires stable x.y.z newer than latest tag; Go gets `-X .../buildinfo.Version`; `buildinfo.IsRelease()` already distinguishes `(devel)`. Swift reads `CFBundleShortVersionString` (AppEntry.swift `AppVersion`); Tauri `tauri.conf.json` "version": "1.1.0".
- Swift app spawns Go `anypick-core` over the desktop stdio protocol (`GoServiceProcess.swift`, `internal/desktop`, ProtocolVersion=2, handshake). Tauri bundles the same binary as `externalBin: binaries/anypick-core`. => Both shells already talk to one Go core.
- macOS signing: `codesign --force --deep -s -` (ad-hoc) in `src/macos/scripts/release-build.sh`. Brew cask uses `AnyPick-macos-universal.zip`, `app "AnyPick.app"`.
- Tauri: plugins = `tauri-plugin-shell` only; no updater, no `TAURI_SIGNING_*` anywhere.
- `SHA256SUMS.txt` is generated in release.yml over every staged asset, uploaded to the same draft release, then published.
- v1.1.0 assets: `AnyPick-macos-universal.{zip,dmg}`, `AnyPick_1.1.0_x64-setup.exe` (NSIS), `AnyPick_1.1.0_x64_en-US.msi` (Tauri WiX), `AnyPick-1.1.0-windows-x64.msi` (winget copy), `AnyPick_1.1.0_amd64.{AppImage,deb}`, `AnyPick-1.1.0-1.x86_64.rpm`, CLI `anypick-1.1.0-{darwin,linux,windows}-{amd64,arm64}.{tar.gz,zip}`, `AnyPick-package-manager-manifests.zip`, `anypick-sbom.spdx.json`, `SHA256SUMS.txt`.
- Settings today: `SettingsGeneralPane`, `SettingsUsagePane` only (no Updates pane).

## 1. Where logic lives
**Decision: decision logic in Go core, mutation in the shell.**
- Go `internal/update` (new): channel detection, GitHub fetch (ETag, 304, 403/429), prerelease filter, semver compare + downgrade refusal, asset selection, SHA256SUMS parse, file hash verify, throttle/state persistence. Exposed later as desktop-protocol commands (`update.status`, `update.check{force}`, `update.download{version}`, `update.settings.set`) plus a CLI `anypick update check --json` (reuses CLI for scripting/QA and for npm/scoop users who only have the CLI).
- Why: one tested implementation for 3 OSes; both shells already speak the protocol; Go has `atomicfile`, `paths`, `config`, `anyerr` to reuse; Go test infra is the strongest in the repo.
- Shell owns only what needs its own process identity: **macOS** — Swift writes nothing itself; Go downloads+verifies+unpacks to staging, Swift launches a tiny relaunch helper (`anypick-core update apply-macos …`, the same Go binary copied to temp so it survives bundle swap) and quits. **Tauri** — `tauri-plugin-updater` does download/verify(minisign)/install/relaunch for NSIS/AppImage; Go core still decides *whether* (channel, version, throttle) and additionally verifies SHA256 before handing the plugin a go-ahead (see §4).

## 2. Types (Go; mirrored as Codable / serde DTOs)
```go
type InstallChannel string // "direct"|"brew"|"nsis"|"msi"|"winget"|"scoop"|"npm"|"deb"|"rpm"|"appimage"|"unknown"
type Release struct { Tag string; Version string; Notes string; PublishedAt time.Time; Prerelease, Draft bool; Assets []Asset; HTMLURL string }
type Asset   struct { Name, URL string; Size int64; SHA256 string /*from SHA256SUMS*/ }
type UpdateSettings struct {
  AutoCheck bool     // default true
  AutoDownload bool  // default false; forced false when !AutoCheck. Renamed from AutoInstall.
  SkippedVersion string
  LastChecked time.Time
  ETag string
  HighestSeen string // persist highest-seen version to resist rollback feeds
}
type UpdateState struct {
  Kind StateKind; Current, Latest string; Notes string
  Command string; Action UpdateAction; Progress float64; Err error; LastChecked time.Time
}
// StateKind: idle checking upToDate availableDirect availablePackageManager notWritable storageUnavailable
//   downloading verifying ready offline rateLimited githubDown hostBlocked badChecksum installFailed
type ActionKind string // "selfUpdate"|"command"|"downloadAsset"|"manual"
type UpdateAction struct {
  Kind ActionKind
  Command string       // pasteable only (no prose, no trailing period); set for command + deb/rpm
  DownloadAsset string // asset file name for downloadAsset (UI: Download .<ext>)
  Lead string          // locked Design lead copy
}
// Channel mapping:
//   selfUpdate: direct, nsis, appimage
//   command: brew, scoop, npm, winget (Command e.g. `winget upgrade AnyPick`)
//   downloadAsset: deb, rpm (DownloadAsset + Command), msi (DownloadAsset .msi only)
//   manual: unknown / arm64 desktop (link to release)
type Fetcher interface{ Latest(ctx, etag string) (Release, newETag string, notModified bool, err error) }
type Clock   interface{ Now() time.Time }
```

### Channel detection (`DetectChannel`, first match wins; testing-hook override wins over all when gated)
- macOS: bundle path resolves (EvalSymlinks) under Caskroom/`anypick` (`/opt/homebrew/Caskroom/anypick` or `/usr/local/Caskroom/anypick`) → brew; also brew if those Caskroom dirs exist and `/Applications/AnyPick.app` matches. Else direct. Writability of parent dir checked separately → notWritable.
- Windows: exe under `%USERPROFILE%\scoop\apps\` or `$SCOOP`/`$SCOOP_GLOBAL` → scoop (CLI only — no desktop row). NSIS: per-user install under `%LOCALAPPDATA%\AnyPick` or presence of uninstall key for NSIS setup → nsis (self-update). MSI / winget: Program Files / winget Links / `AnyPick-*-windows-x64.msi` install path → msi or winget (package manager: show `winget upgrade AnyPick` or download link). Heuristics documented in code.
- Linux: `$APPIMAGE` set → appimage (direct self-update path); `dpkg -S <exe>` success → deb; `rpm -qf <exe>` success → rpm; else unknown.
- CLI-only: exe under `npm prefix -g` / path contains `node_modules/anypick` → npm (CLI only — no desktop row).
- arm64 desktop (no GUI bundle for linux-arm64 / windows-arm64): manual download fallback (unknown / download link).

### Package-manager commands
| Channel | Command / UX |
| --- | --- |
| brew | `brew upgrade --cask anypick` |
| scoop | `scoop update anypick` (CLI only) |
| npm | `npm install -g anypick@latest` (CLI only) |
| deb | Manual reinstall. Show **Download .deb** + exact `sudo apt install ./AnyPick_<v>_amd64.deb`. Never say "repo". |
| rpm | Manual reinstall. Show **Download .rpm** + exact `sudo dnf install ./AnyPick-<v>-1.x86_64.rpm`. Never say "repo". |
| winget | `winget upgrade AnyPick` or download link |
| msi | package manager / download link (not self-update) |
| nsis | self-update (per-user setup.exe) |
| appimage / direct | self-update path |

## 3. Flows
The v1.1.1 implementation checks manually and downloads plus checks the selected asset. Its state machine is `idle→checking→{upToDate|availableDirect|availablePackageManager|offline|rateLimited|githubDown|hostBlocked|storageUnavailable}`; `availableDirect→Download Update→notWritable | downloading→verifying→{badChecksum|ready}`. `ready` means the ZIP is in the cache and can be opened in Finder for manual installation; AnyPick remains on the current version. Bundle replacement, relaunch, startup checks and background downloads are planned follow-up work, not part of this release. HighestSeen is stored atomically across helper runs to resist a rolled-back feed. Manual check ignores throttle and sends ETag. 304 without a cached Release triggers a second GitHub fetch without If-None-Match so the body can be evaluated (see `Checker.Check`). Network errors/403/429 never panic: inline status row + backoff (respect `Retry-After`/`X-RateLimit-Reset`). Allowlist refusals (`ErrHostNotAllowed`) map to `hostBlocked` (never `offline`): Retry=false, **View on GitHub**, copy `Update didn't finish. The download came from an address AnyPick doesn't trust, so nothing was changed. You're still on <current>.`

**Planned follow-up — Skip This Version:** hides the menu item + background badge until a newer version; a manual check still shows it. UI copy: `You skipped 1.1.1. You'll hear about the next version.`

**Planned follow-up — "Download updates automatically":** download+verify in background, install on next **QUIT**, never relaunch when idle. Menu bar item `Restart to Update to <v>`. Relaunch confirms if proxies are serving (n>0 only; n==0 → no confirm): n=1 uses singular `proxy`; n>1 keeps `proxies`. Copy: `Restarting stops N running proxy|proxies. Connected apps reconnect when AnyPick starts again.`

**Planned follow-up — macOS install (direct):** after the current download+checksum step, 1) `ditto -x -k` to staging, `codesign --verify --deep --strict` + check `CFBundleShortVersionString == ver` and bundle id; 2) preflight writability — if not writable → notWritable with "Download in browser" + "Reveal in Finder", **never an admin prompt**; 3) ready → user clicks Relaunch (or AutoDownload waits for quit); 4) helper swap + rollback as previously designed.

**Ready line (UI):** `Downloaded from GitHub Releases. The file matches the release checksum. Install it manually from Finder; AnyPick stays on this version.` Do **not** use the bare word "verified" in UI copy until minisign lands.

**macOS direct Ready footnote:** `macOS may ask again for access AnyPick already had, such as Keychain or Automation, because this build isn't notarized. Allow it to keep things working.`

**Windows:** self-update ONLY for NSIS setup.exe (per-user). MSI + winget = package manager path.
**Linux AppImage:** self-update when path writable; else notWritable.
**brew/scoop/npm/deb/rpm/winget/msi/unknown:** availablePackageManager (or download fallback); Download Update hidden for package-manager channels.

## 4. Tauri updater
Plugin needs: `plugins.updater.pubkey` (minisign) in tauri.conf.json, `bundle.createUpdaterArtifacts: true`, CI secrets `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`), `.sig` files, endpoint `latest.json`. **Blocked on OutOf0 key approval** — nothing generated in slice 1. Recommend Go SHA256SUMS as second gate before `downloadAndInstall`.

## 5. Security / Authenticity
- TLS only, Go default roots. **Two dedicated HTTP clients, two host lists — no unrestricted fallback:**
  - **API client** (`NewAPITransport` / `GitHubFetcher.apiTransport`): exact host `api.github.com` only, https only. Validates the first URL and every redirect hop (`CheckRedirect`, same redirect cap of 5). Used solely for Releases metadata (`/releases/latest`). A caller-supplied `http.Client` (tests) is always wrapped so the allowlist still runs first; there is no path that uses `http.DefaultClient` or a bare `http.Client` for the fetch. GitHub renamed-repo 301s that stay on `api.github.com` (e.g. `/repos/…/releases/latest` → `/repositories/<id>/releases/latest`) are followed.
  - **Download client** (`NewDownloadTransport`): exact hosts `github.com`, `objects.githubusercontent.com`, and `release-assets.githubusercontent.com` (https only, no wildcards). `release-assets.githubusercontent.com` is required because GitHub 302-redirects real `browser_download_url` downloads there. Validates the initial URL and every redirect hop (https→http downgrades refused; redirect cap 5). Used for `AttachChecksums`, `DownloadAsset`, and other asset bytes.
- A caller-supplied `Transport` (its proxy, dialer, and TLS settings) is trusted; AnyPick still enforces the host allowlist and https-only checks on every hop.
- Asset names containing `..`, `/`, or `\` are rejected (no basename trimming). Missing/duplicate/empty SHA256SUMS entries for the asset being installed fail closed; unrelated release assets without a checksum do not block the update.
- **Same-release SHA-256 is integrity, not authenticity**: it verifies the file matches the release checksum, not who signed it. Accepted for macOS v1.1.1. Tauri minisign pending OutOf0 key approval.
- Downgrade: refuse `latest ≤ current`; refuse tag/asset version mismatch; ignore drafts/prereleases; persist `HighestSeen` to resist rollback feeds.
- Path safety on unzip; size cap vs `Asset.Size`; temp dirs 0700.
- Helper runs as user; no privilege escalation path exists by design.

## 6. Testability hooks
All no-op unless `ANYPICK_UPDATE_TESTING=1` (exactly `"1"`, including in release builds):
1. `ANYPICK_UPDATE_FEED_URL` — base URL replacing `https://api.github.com/repos/outof0/anypick`. When the gate is open, that feed host is **added to the API allowlist** (https still required). When the gate is closed, the feed URL is ignored and the default `api.github.com` base + allowlist are used.
2. `ANYPICK_UPDATE_CHANNEL=direct|brew|nsis|msi|winget|scoop|npm|deb|rpm|appimage|unknown`.
3. `ANYPICK_UPDATE_CLOCK=2026-10-12T00:00:00Z` (fixed) or `ANYPICK_UPDATE_CLOCK_OFFSET=25h`.
4. `ANYPICK_UPDATE_FAULT=relaunch-fail|swap-fail|checksum-mismatch|download-stall`.
5. `ANYPICK_UPDATE_CURRENT_VERSION=1.1.0` to fake the running version.

Allowlists: production API = `api.github.com`; production download = the three hosts in §5. Host lists live on unexported `Transport.allowedHosts` / `GitHubFetcher.allowedHosts` (no exported field or setter). Same-package tests inject loopback hosts for `httptest` (and optionally an `HTTP` client for TLS trust); the allowlist `CheckRedirect` is always wrapped around any injected client. Refusals return typed `ErrHostNotAllowed` (match with `errors.Is` / `errors.As`, never by text) and surface as `hostBlocked`. Opt-in live tests: `ANYPICK_UPDATE_LIVE_TEST=1` downloads real v1.1.0 `SHA256SUMS.txt` through the download client and fetches `/releases/latest` through the API client (skipped otherwise so normal `go test` stays offline). CI may enable them on a schedule so a GitHub host move surfaces. Production files under `internal/update` are grepped in tests for unguarded `http.Get` / `http.DefaultClient` / bare `http.Client{`.

## 7. Phased PR slices
1. Go `internal/update`: types, semver, fetcher (ETag/304/403/429), asset pick, SHA256SUMS verify, channel detect, clock, hooks + fake-server tests. *(this PR)*
2. Desktop protocol commands + settings persistence + throttle scheduler (Go).
3. macOS Settings > Updates pane (read-only states).
4. macOS download/verify/stage + relaunch helper + rollback + fault hooks.
5. Release workflow: Tauri updater artifacts, `.sig`, `latest.json` (blocked on key approval).
6. Tauri plugin integration + Updates UI (Win/Linux).
7. (Later) signed SHA256SUMS / attestations.

## 8. Locked decisions (were open questions)
1. Tauri minisign keypair: **awaits OutOf0 approval** (open).
2. Quarantine strip on own verified download: accepted with SHA256-from-same-release for v1.1.1; docs state plainly it matches the release, not who signed it.
3. deb/rpm: **manual reinstall** — Download + exact apt/dnf install of local file. Never say "repo".
4. scoop/npm: **CLI only** (no desktop rows); CLI `anypick update check --json`.
5. Windows: **NSIS self-update only**; MSI + winget = package manager.
6. arm64 desktop (no GUI bundle): manual download fallback.
7. AutoDownload: install on next **QUIT**, never relaunch when idle.
8. TCC/keychain re-prompt footnote: accepted copy above.
9. Skip This Version: **in scope** (copy above).
10. Unauthenticated API 60 req/h/IP: acceptable with 24h throttle + ETag.
