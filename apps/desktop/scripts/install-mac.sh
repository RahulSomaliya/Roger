#!/usr/bin/env bash
# Build Roger.app for this Mac, sign it ad hoc and install it in /Applications.
# Run it as `pnpm install:mac` in apps/desktop (the repo's `make install-desktop` calls it).
#
# Signing for real (Developer ID, hardened runtime, notarization) is M11. Until then:
# - The app is signed ad hoc WITHOUT the hardened runtime. electron-builder.yml asks for hardened
#   runtime, and an ad-hoc signature with it dies at launch with "Electron Framework ... not valid
#   for use in process": library validation needs a team id, and an ad-hoc signature has none.
# - Every ad-hoc build has a new code hash, so macOS asks for Microphone and System Audio
#   Recording permission again after each install.
set -euo pipefail

readonly APP_ID="ai.linkt.roger"
readonly DEST="/Applications/Roger.app"
readonly LOG_DIR="$HOME/Library/Logs/Roger"

cd "$(dirname "$0")/.."

# electron-builder writes the dir target to dist/mac-arm64 on Apple Silicon and dist/mac on Intel.
case "$(uname -m)" in
  arm64) arch_flag="--arm64" out_dir="dist/mac-arm64" ;;
  x86_64) arch_flag="--x64" out_dir="dist/mac" ;;
  *)
    echo "install-mac: unsupported architecture $(uname -m)" >&2
    exit 1
    ;;
esac
readonly built="$out_dir/Roger.app"

echo "==> Building"
pnpm exec electron-vite build

echo "==> Packaging an unsigned Roger.app for $(uname -m)"
rm -rf "$built"
# No identity lookup: electron-builder must not sign with whatever certificate the keychain holds
# (with the hardened runtime from electron-builder.yml); the ad-hoc signature below is the one used.
CSC_IDENTITY_AUTO_DISCOVERY=false \
  pnpm exec electron-builder --mac dir "$arch_flag" --config electron-builder.yml

echo "==> Signing ad hoc, without the hardened runtime (see the top of this file)"
codesign --force --deep --sign - "$built"
codesign --verify --deep --strict "$built"

# The main process is named "Roger"; its helpers are "Roger Helper (...)", which -x skips.
if pgrep -x Roger >/dev/null; then
  echo "==> Quitting the running Roger (a recording in progress is stopped and saved first)"
  osascript -e "tell application id \"$APP_ID\" to quit"
  for _ in $(seq 1 30); do
    pgrep -x Roger >/dev/null || break
    sleep 0.5
  done
  if pgrep -x Roger >/dev/null; then
    echo "install-mac: Roger did not quit within 15 s. Quit it, then run this again." >&2
    exit 1
  fi
fi

echo "==> Installing $DEST"
# Copy next to the old app first, so a failed copy leaves the installed app untouched.
readonly staged="$DEST.installing"
rm -rf "$staged"
ditto "$built" "$staged"
rm -rf "$DEST"
mv "$staged" "$DEST"

cat <<EOF

Installed $DEST (ad hoc signed, $(uname -m)).

The packaged app reads its settings from
  ~/Library/Application Support/Roger/config.json
not from environment variables or the repo .env (those are for make dev-desktop). For example:
  { "apiUrl": "http://127.0.0.1:8000", "apiToken": "<the API's ROGER_API_TOKEN>" }

macOS asks for Microphone and System Audio Recording again after every install, because each
ad-hoc build has a new code hash.

Launch it with its log in a file (a packaged app logs to stderr only):
  mkdir -p "$LOG_DIR" && open --stdout "$LOG_DIR/stdout.log" --stderr "$LOG_DIR/roger.log" "$DEST"
  tail -f "$LOG_DIR/roger.log"
EOF
