#!/usr/bin/env bash

# Update the separately owned Homebrew tap after a GitHub Release exists.

set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 VERSION RELEASE_BASE_URL SHA256SUMS" >&2
  exit 2
fi

: "${HOMEBREW_TAP_TOKEN:?HOMEBREW_TAP_TOKEN is required}"
tap_repository="${HOMEBREW_TAP_REPOSITORY:-outof0/homebrew-tap}"
version="$1"
release_base="$2"
sums="$3"

checkout="$(mktemp -d "${RUNNER_TEMP:-/tmp}/anypick-homebrew.XXXXXX")"
trap 'rm -rf "$checkout"' EXIT

# The tap is public, so clone it without credentials. Keeping authentication
# off the read path avoids turning a bad write token into an anonymous-clone
# failure; only the push needs the scoped token.
auth_header="AUTHORIZATION: basic $(printf 'x-access-token:%s' "${HOMEBREW_TAP_TOKEN}" | base64 | tr -d '\r\n')"
git clone --depth=1 "https://github.com/${tap_repository}.git" "$checkout/tap"
bash "$(dirname "$0")/render.sh" "$version" "$release_base" "$sums" "$checkout/tap"
cask_asset="AnyPick-macos-universal.zip"
if awk -v asset="$cask_asset" '$2 == asset || $2 == "*" asset { found = 1 } END { exit !found }' "$sums"; then
  bash "$(dirname "$0")/render-cask.sh" "$version" "$release_base" "$sums" "$checkout/tap"
fi

cd "$checkout/tap"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add Formula/anypick.rb
if [[ -f Casks/anypick.rb ]]; then
  git add Casks/anypick.rb
fi
if git diff --cached --quiet; then
  echo "Homebrew tap already contains AnyPick ${version}."
else
  git diff --cached --check
  git commit -m "anypick ${version}"
  git -c http.extraheader="$auth_header" push origin HEAD
fi
