#!/bin/bash
# Build the macOS release disk image: the signed app, an Applications drop
# target, and INSTALL.txt.
#
# The note is the whole point. The app is ad-hoc signed and not notarized
# (ADR 0033), so a first launch can be refused with "damaged and can't be
# opened" — a message that reads as a corrupt download unless the disk image
# says otherwise at the moment the user sees it. The release page and the
# Homebrew caveats cannot help someone who is staring at a Finder warning.
#
# Usage: build-dmg.sh --app <AnyPick.app> --output <path.dmg>
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
install_note="${repo_root}/packaging/macos/INSTALL.txt"

usage() {
  echo "usage: $0 --app <AnyPick.app> --output <path.dmg>" >&2
  exit 2
}

app=""
output=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      [[ $# -ge 2 ]] || usage
      app="$2"
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || usage
      output="$2"
      shift 2
      ;;
    -h | --help)
      usage
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage
      ;;
  esac
done

[[ -n "${app}" && -n "${output}" ]] || usage
[[ -d "${app}" && "${app}" == *.app ]] || {
  echo "error: ${app} is not an .app bundle" >&2
  exit 1
}
[[ -f "${install_note}" ]] || {
  echo "error: the disk-image note is missing: ${install_note}" >&2
  exit 1
}

# A disk image built from an unsigned bundle is rejected by Gatekeeper with the
# same wording whether the bundle is intact or truncated, so the signature is
# verified here rather than discovered by the first person to download it.
codesign --verify --deep --strict "${app}" || {
  echo "error: ${app} does not carry a valid signature; sign it before packaging" >&2
  exit 1
}

app_name="$(basename "${app}")"
stage="$(mktemp -d "${TMPDIR:-/tmp}/anypick-dmg.XXXXXX")"
trap 'rm -rf "${stage}"' EXIT

# `ditto` rather than `cp -R`: it preserves the bundle's resource forks,
# extended attributes and symlinks, so the copied app still verifies.
ditto "${app}" "${stage}/${app_name}"
cp "${install_note}" "${stage}/INSTALL.txt"
ln -s /Applications "${stage}/Applications"

# Verify the staged tree, not the source bundle: a note that failed to copy
# would ship an image that explains nothing, which is the failure this script
# exists to prevent.
[[ -f "${stage}/INSTALL.txt" ]] || {
  echo "error: INSTALL.txt was not staged" >&2
  exit 1
}
[[ -L "${stage}/Applications" ]] || {
  echo "error: the Applications drop target was not staged" >&2
  exit 1
}
codesign --verify --deep --strict "${stage}/${app_name}" || {
  echo "error: the staged app lost its signature during the copy" >&2
  exit 1
}

mkdir -p "$(dirname "${output}")"
rm -f "${output}"
hdiutil create \
  -volname AnyPick \
  -srcfolder "${stage}" \
  -ov -format UDZO \
  "${output}" >/dev/null

[[ -s "${output}" ]] || {
  echo "error: hdiutil produced no image at ${output}" >&2
  exit 1
}

# Mount and read back what actually landed in the image. hdiutil succeeding is
# not evidence that the note and the drop target are inside it.
mountpoint="$(mktemp -d "${TMPDIR:-/tmp}/anypick-dmg-mount.XXXXXX")"
cleanup_mount() {
  hdiutil detach "${mountpoint}" >/dev/null 2>&1 || true
  rmdir "${mountpoint}" 2>/dev/null || true
}
trap 'cleanup_mount; rm -rf "${stage}"' EXIT

hdiutil attach -nobrowse -readonly -mountpoint "${mountpoint}" "${output}" >/dev/null
for required in "${app_name}" INSTALL.txt Applications; do
  [[ -e "${mountpoint}/${required}" ]] || {
    echo "error: ${required} is missing from ${output}" >&2
    exit 1
  }
done
codesign --verify --deep --strict "${mountpoint}/${app_name}" || {
  echo "error: the app inside ${output} does not verify" >&2
  exit 1
}
cleanup_mount
trap 'rm -rf "${stage}"' EXIT

echo "macOS disk image: ${output}"
