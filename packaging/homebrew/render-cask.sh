#!/usr/bin/env bash

# Render the macOS app cask independently from the portable CLI formula.
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 VERSION RELEASE_BASE_URL SHA256SUMS TAP_ROOT" >&2
  exit 2
fi

version="$1"
release_base="$2"
sums="$3"
tap_root="$4"
asset="AnyPick-macos-universal.zip"
sha="$(awk -v asset="$asset" '$2 == asset || $2 == "*" asset { print $1; exit }' "$sums")"
if [[ ! "$sha" =~ ^[[:xdigit:]]{64}$ ]]; then
  echo "missing checksum for $asset" >&2
  exit 1
fi

cask_dir="$tap_root/Casks"
mkdir -p "$cask_dir"
cat > "$cask_dir/anypick.rb" <<EOF
cask "anypick" do
  version "${version}"
  sha256 "${sha}"

  url "${release_base}/${asset}"
  name "AnyPick"
  desc "Native account and proxy manager for AI coding clients"
  homepage "https://github.com/outof0/anypick"

  app "AnyPick.app"

  caveats do
    <<~EOS
      AnyPick is not notarized. The first time you open it, right-click
      AnyPick.app and choose Open, or go to System Settings → Privacy & Security
      and choose Open Anyway. You can also remove the quarantine flag with:

        /usr/bin/xattr -dr com.apple.quarantine /Applications/AnyPick.app
    EOS
  end
end
EOF
ruby -c "$cask_dir/anypick.rb" >/dev/null
