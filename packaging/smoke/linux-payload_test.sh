#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
root="$(mktemp -d "${TMPDIR:-/tmp}/anypick-linux-payload-test.XXXXXX")"
trap 'rm -rf "$root"' EXIT
stage="$root/stage"
bin="$root/bin"
workspace="$root/workspace"
runner_temp="$root/runner"
mkdir -p "$stage" "$bin" "$workspace/src/tauri/ui/scripts" "$runner_temp"
empty_path="$root/empty-path"
mkdir -p "$empty_path"
: > "$stage/anypick.deb"
: > "$stage/anypick.AppImage"
: > "$workspace/src/tauri/ui/scripts/desktop-e2e.mjs"

cat > "$bin/dpkg-deb" <<'STUB'
#!/bin/sh
set -eu
[ "$1" = -x ] || exit 2
destination=$3
mkdir -p "$destination/usr/bin"
cat > "$destination/usr/bin/anypick-core" <<'HELPER'
#!/bin/sh
if [ "${1-}" = --version ]; then
  printf 'anypick-go 1.1.2\n'
fi
HELPER
cat > "$destination/usr/bin/anypick" <<'APP'
#!/bin/sh
[ "${PATH-}" = "$SMOKE_EMPTY_PATH" ] || {
  echo "deb desktop smoke did not preserve the empty PATH" >&2
  exit 95
}
exit 0
APP
chmod +x "$destination/usr/bin/anypick-core" "$destination/usr/bin/anypick"
STUB

cat > "$bin/xvfb-run" <<'STUB'
#!/bin/sh
set -eu
[ "$1" = -a ] || exit 2
shift
exec "$@"
STUB

cat > "$bin/dbus-run-session" <<'STUB'
#!/bin/sh
set -eu
[ "$1" = -- ] || exit 2
shift
exec "$@"
STUB

cat > "$bin/node" <<'STUB'
#!/bin/sh
set -eu
[ "$1" = "$GITHUB_WORKSPACE/src/tauri/ui/scripts/desktop-e2e.mjs" ] || {
  echo "unexpected desktop E2E script: $1" >&2
  exit 2
}
application=$2
case "$application" in
  */anypick-appimage-launcher)
    PATH="$SMOKE_EMPTY_PATH" "$application"
    ;;
  */deb/usr/bin/anypick)
    PATH="$SMOKE_EMPTY_PATH" "$application"
    ;;
  */squashfs-root/usr/bin/anypick)
    echo "AppImage E2E bypassed its runtime launcher" >&2
    exit 1
    ;;
  *)
    echo "unexpected desktop application path: $application" >&2
    exit 2
    ;;
esac
STUB

cat > "$stage/anypick.AppImage" <<'APPIMAGE'
#!/bin/sh
set -eu
if [ "${1-}" = --appimage-extract ]; then
  mkdir -p squashfs-root/usr/bin squashfs-root/usr/lib/anypick
  cat > squashfs-root/usr/lib/anypick/anypick-core <<'HELPER'
#!/bin/sh
if [ "${1-}" = --version ]; then
  printf 'anypick-go 1.1.2\n'
fi
HELPER
  cat > squashfs-root/usr/bin/anypick <<'RAW_APP'
#!/bin/sh
echo "raw extracted AppImage executable must not be launched" >&2
exit 98
RAW_APP
  chmod +x squashfs-root/usr/lib/anypick/anypick-core squashfs-root/usr/bin/anypick
  exit 0
fi
if [ "${APPIMAGE_EXTRACT_AND_RUN-}" != 1 ]; then
  echo "AppImage runtime was not asked to extract and run" >&2
  exit 97
fi
if [ "${1-}" != --appimage-extract-and-run ]; then
  echo "AppImage runtime compatibility argument was not passed" >&2
  exit 96
fi
if [ "${PATH-}" != /usr/bin:/bin ]; then
  echo "AppImage runtime did not receive the minimal host PATH" >&2
  exit 95
fi
printf 'launched\n' >> "$APPIMAGE_TEST_MARKER"
APPIMAGE
chmod +x "$stage/anypick.AppImage"
chmod +x "$bin/dpkg-deb" "$bin/xvfb-run" "$bin/dbus-run-session" "$bin/node"

export PATH="$bin:$PATH"
export SMOKE_EMPTY_PATH="$empty_path"
export GITHUB_WORKSPACE="$workspace"
export RUNNER_TEMP="$runner_temp"
export APPIMAGE_TEST_MARKER="$root/appimage-launches"
bash "$repo_root/packaging/smoke/linux-payload.sh" "$stage" 1.1.2
[[ "$(<"$APPIMAGE_TEST_MARKER")" == launched ]]
printf 'PASS Linux payload smoke uses the AppImage runtime for desktop E2E\n'
