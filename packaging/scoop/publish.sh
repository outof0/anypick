#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 VERSION RELEASE_BASE_URL SHA256SUMS" >&2
  exit 2
fi

: "${SCOOP_BUCKET_TOKEN:?SCOOP_BUCKET_TOKEN is required}"
bucket_repository="${SCOOP_BUCKET_REPOSITORY:-outof0/scoop-bucket}"
version="$1"
release_base="$2"
sums="$3"

checkout="$(mktemp -d "${RUNNER_TEMP:-/tmp}/anypick-scoop.XXXXXX")"
trap 'rm -rf "$checkout"' EXIT

# The bucket is public, so clone it without credentials. Keeping authentication
# off the read path avoids turning a bad write token into an anonymous-clone
# failure; only the push needs the scoped token.
auth_header="AUTHORIZATION: basic $(printf 'x-access-token:%s' "${SCOOP_BUCKET_TOKEN}" | base64 | tr -d '\r\n')"
git clone --depth=1 "https://github.com/${bucket_repository}.git" "$checkout/bucket"
bash "$(dirname "$0")/render.sh" "$version" "$release_base" "$sums" "$checkout/bucket"

cd "$checkout/bucket"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add anypick.json
if git diff --cached --quiet; then
  echo "Scoop bucket already contains AnyPick ${version}."
else
  git diff --cached --check
  git commit -m "anypick ${version}"
  git -c http.extraheader="$auth_header" push origin HEAD
fi
