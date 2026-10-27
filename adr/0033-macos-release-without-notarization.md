# ADR-0033: macOS releases use an ad-hoc code signature without notarization

- Status: accepted (2026-10-10)
- Amends: [0020](0020-node-free-native-app-distribution.md) decisions 8 and 9
- Supersedes: the macOS notarization and stapling requirements in ADR-0019's
  consequences and ADR-0020 decisions 8 and 9

## Context

AnyPick has no Apple Developer account. Requiring Developer ID credentials and
notarization kept the macOS desktop app out of releases even though CI can build
and smoke-test the universal app. The app can still be distributed through
GitHub Releases and a project-owned Homebrew tap if first-launch Gatekeeper
approval is explained clearly.

## Decision

1. **`all` is the default release scope.** It builds macOS, Linux and Windows
   desktop apps, all supported CLI archives, and the npm launcher. `cli-only`
   remains available when a release should contain CLI artifacts only.
2. **CI builds the universal macOS app and applies an ad-hoc code signature.**
   The release build uses `codesign --force --deep -s -`. It does not submit the
   app for notarization or attempt to staple a ticket. The `.dmg` and `.zip` are
   published with the other GitHub Release assets after the existing Node-free,
   architecture, and installed-helper smoke checks pass.
3. **The macOS app is described as not notarized.** Install instructions and the
   Homebrew cask tell users to right-click the app and choose **Open**, use
   **System Settings → Privacy & Security → Open Anyway**, or clear quarantine
   with `/usr/bin/xattr -dr com.apple.quarantine /Applications/AnyPick.app`.
4. **Homebrew remains project-owned.** `outof0/homebrew-tap` publishes both the
   portable CLI formula and the macOS app cask. The cask points to the versioned
   GitHub Release ZIP and carries the first-launch instructions. It is not
   submitted to the official `homebrew/cask` repository.
5. **The Node-free native artifact contract is unchanged.** The macOS app still
   bundles the Go service and must pass both Node-free scanners from ADR-0020.

## Consequences

- No Apple Developer account or Apple signing/notarization secrets are needed
  for a release. The macOS app is available in the default release scope.
- Gatekeeper may block first launch because the app is not notarized. Users need
  the approval steps in the cask or install documentation.
- `codesign --verify` validates the app bundle structure in CI; it does not
  establish notarization or Gatekeeper approval.
- ADR-0020's Node-free artifact rules, universal architecture check, and clean
  account smoke remain in force. Only its Developer ID, notarization, stapling,
  and app-first notarized-release requirements are superseded here.
