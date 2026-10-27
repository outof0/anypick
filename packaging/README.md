# Distribution and release operations

GitHub Releases are the canonical source for versioned artifacts. The release
workflow builds and verifies them, publishes a draft with checksums, SBOM and
provenance, then makes the release public. npm, Homebrew and Scoop run as
independent jobs after the GitHub Release and can be retried without rebuilding
or replacing public assets. Documentation deploys through its own workflow.

## Artifact matrix

| Channel | Product | Artifacts | Install surface |
| --- | --- | --- | --- |
| GitHub Releases | CLI | macOS/Linux/Windows, x64 + ARM64 archives | direct download |
| GitHub Releases | Desktop macOS | Universal `.dmg` and `.zip` | direct download |
| GitHub Releases | Desktop Linux | x64 AppImage, `.deb`, `.rpm` | direct download |
| GitHub Releases | Desktop Windows | x64 MSI and NSIS installer | direct download |
| npm | CLI launcher | downloads and verifies the matching CLI archive | `npm install --global anypick` |
| Homebrew | CLI and macOS app | formula and cask | `outof0/homebrew-tap` (`outof0/tap`) |
| Scoop | CLI | Windows x64 + ARM64 | `outof0/scoop-bucket` |
| WinGet | Desktop Windows | x64 MSI manifest | manual PR to `microsoft/winget-pkgs` |

The macOS desktop app uses an ad-hoc code signature in CI and is not notarized.
Its first-launch approval steps are included in the Homebrew cask caveats and
the installation docs. macOS CLI archives remain in GitHub Releases, npm and
Homebrew. Linux `.deb`/`.rpm` files are direct downloads; they are not an apt/dnf
repository and do not update automatically.

## Prepare a release

1. Merge the release changes through a reviewed PR. For a version PR, use
   `make plan-release` to inspect the proposed version, then `make set-version
   VERSION=x.y.z` and `make check-release`. Include the synchronized version
   files and one short release summary under that version in `CHANGELOG.md`;
   do not add per-change entries.
2. Confirm the selected version is greater than the latest published tag and
   that the release commit is on `main`.
3. In Actions → Release, run from `main` with the default `all` scope. This
   builds the macOS app, Linux and Windows desktop artifacts, all six CLI
   archives, and the npm launcher. Use `cli-only` for a CLI-only artifact set.
4. npm, Homebrew and Scoop publishing default to enabled. Their inputs can be
   unchecked when a channel should be skipped. Each publisher is a separate
   job; a failed channel can be rerun without rebuilding or replacing public
   GitHub assets.
5. For desktop releases, download `AnyPick-package-manager-manifests.zip` from
   the GitHub Release. Submit its three WinGet YAML files to
   `microsoft/winget-pkgs` and follow the PR checks/review. WinGet acceptance
   is separate from the GitHub release.
6. Verify installation and `anypick --version` from each enabled channel.

The workflow requires a version update to be merged before it runs; it never
pushes a version commit directly to `main`. A draft can be resumed only with
the same tag, source commit and release scope. Public GitHub assets are
immutable from the workflow; use a new patch version to replace a bad binary.

## One-time setup

### GitHub

- The repository must be public for public release assets and npm provenance.
- Allow GitHub Actions to create tags and releases (`contents: write`). The
  release workflow scopes this permission to its release job.
- Keep the `production` environment for npm trusted publishing. The npm job
  requests GitHub OIDC; it does not store a long-lived npm token.

### npm

- The public package `anypick` already points to this repository and is
  maintained by `outof0`; confirm your npm account can publish it, enable 2FA,
  and configure trusted publishing for repository `outof0/anypick`, workflow
  `.github/workflows/release.yml`, environment `production`.
- The package supports Node 18 and newer (`npm/anypick/package.json`). The
  publish job itself runs on Node 22.17.1 and npm CLI 11.5.1.
- Complete one successful CI publish within two days after creating a new
  trusted-publisher configuration. npm binds the publisher to the package on
  that first publish. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)

### Homebrew

- Use public repository `outof0/homebrew-tap` with an initial commit.
- Set repository variable `HOMEBREW_TAP_REPOSITORY=outof0/homebrew-tap`.
- Add secret `HOMEBREW_TAP_TOKEN` with write access to that tap only.
- The release publisher updates both `Formula/anypick.rb` and `Casks/anypick.rb`
  when the macOS app is in the release. Users install the CLI with
  `brew install outof0/tap/anypick`, or the desktop app with
  `brew install --cask outof0/tap/anypick`.
- The cask warns that the app is not notarized and shows the first-launch
  approval steps: right-click **Open**, use **System Settings → Privacy &
  Security → Open Anyway**, or run
  `/usr/bin/xattr -dr com.apple.quarantine /Applications/AnyPick.app`.

### Scoop

- Create public repository `outof0/scoop-bucket` with an initial commit.
- Set repository variable `SCOOP_BUCKET_REPOSITORY=outof0/scoop-bucket`.
- Add secret `SCOOP_BUCKET_TOKEN` with write access to that bucket only.
- Users install with `scoop bucket add outof0
  https://github.com/outof0/scoop-bucket` and `scoop install anypick`.

### WinGet

- No Microsoft Store enrollment is needed. A GitHub account can submit the
  generated manifests as a PR to `microsoft/winget-pkgs`.
- The manifest currently identifies the x64 Windows MSI as
  `outof0.AnyPick`; confirm that identifier is available/accepted before the
  first submission.

### Cloudflare Pages

- Docs deployment is independent of release publishing. Configure
  `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` for the `production`
  environment; a docs deploy failure does not block or roll back a release.

### macOS app

The `all` scope builds a universal app on the hosted macOS runner, applies an
ad-hoc code signature, and publishes `.dmg` and `.zip` assets without
notarization. No Apple Developer account or Apple release secrets are needed.
macOS may block the first launch; users can right-click **Open**, choose **Open
Anyway** under **System Settings → Privacy & Security**, or run
`/usr/bin/xattr -dr com.apple.quarantine /Applications/AnyPick.app`.

The Homebrew cask is not an escape from that step. Homebrew applies the same
quarantine attribute a browser does — verified on an installed cask, which
carries `com.apple.quarantine` — so a cask install still needs the one-time
approval. `brew install --no-quarantine` is not an option: Homebrew removed
that flag. Do not promise users that the cask avoids the warning.

`src/macos/scripts/build-dmg.sh` builds the disk image. It stages the app, an
`Applications` drop target, and `packaging/macos/INSTALL.txt`, then mounts the
finished image and verifies that all three are present and that the app still
verifies. The note explains the Gatekeeper block in English and Vietnamese at
the moment the user meets it, because the release page and the Homebrew caveats
cannot help someone looking at a Finder warning. The script refuses to package
an app whose signature does not verify, so a `.dmg` is never built around a
bundle Gatekeeper would reject as damaged.

The command is written with an absolute path on purpose. `xattr` also names a
Python package, and a pyenv shim puts it ahead of `/usr/bin` on some machines;
that program has no `-r` flag, so the documented fix would exit 64 and clear
nothing. `make check-paths` fails on a bare `xattr -dr` in any instruction file
so this cannot come back.

## Recovery

- **Build or verification fails:** no public release is created. Fix the source
  and rerun after merging the fix/version PR.
- **GitHub Release remains a draft:** rerun Release with the same version,
  source commit and scope. The workflow replaces only draft assets.
- **npm/Homebrew/Scoop fails:** rerun only the failed job. npm compares package
  integrity before treating an existing version as successful; tap/bucket
  updates are idempotent.
- **WinGet is pending:** keep the GitHub downloads available and continue the
  manifest PR separately.
- **A public binary is wrong:** cut a new patch release. The workflow refuses
  to replace public release assets.
