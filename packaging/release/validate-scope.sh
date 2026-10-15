#!/usr/bin/env bash
set -euo pipefail

expected=${1:?usage: validate-scope.sh <all|cli-only>}
body=$(cat)
markers=$(printf '%s\n' "$body" | grep -oE '<!-- anypick-release-scope=[^[:space:]]+ -->' || true)

if [[ -z "$markers" || "$markers" == *$'\n'* ]]; then
  echo "::error::Published release has no unique release-scope marker; refusing to guess publisher inputs." >&2
  exit 1
fi

case "$markers" in
  '<!-- anypick-release-scope=all -->') actual=all ;;
  '<!-- anypick-release-scope=cli-only -->') actual=cli-only ;;
  *)
    echo "::error::Published release has an invalid release-scope marker; refusing to guess publisher inputs." >&2
    exit 1
    ;;
esac

if [[ "$actual" != "$expected" ]]; then
  echo "::error::Published release was created with release-scope=${actual}; rerun with that same scope." >&2
  exit 1
fi

printf '%s\n' "$actual"
