#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/validate-scope.sh"

assert_pass() {
  local body=$1 expected=$2 got
  got=$(printf '%s\n' "$body" | bash "$script" "$expected")
  [[ "$got" == "$expected" ]] || {
    echo "expected scope $expected, got $got" >&2
    exit 1
  }
}

assert_fail() {
  local body=$1 expected=$2
  if printf '%s\n' "$body" | bash "$script" "$expected" >/dev/null 2>&1; then
    echo "unexpectedly accepted scope marker for expected scope $expected" >&2
    exit 1
  fi
}

assert_pass $'Release notes\n\n<!-- anypick-release-scope=all -->' all
assert_pass '<!-- anypick-release-scope=cli-only -->' cli-only
assert_fail '<!-- anypick-release-scope=all -->' cli-only
assert_fail 'Release notes without a scope marker' all
assert_fail '<!-- anypick-release-scope=desktop -->' all
assert_fail $'<!-- anypick-release-scope=all -->\n<!-- anypick-release-scope=all -->' all

echo "release scope validation tests passed"
