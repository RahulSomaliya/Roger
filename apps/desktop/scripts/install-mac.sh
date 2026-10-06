#!/usr/bin/env bash
# Build Roger.app for this Mac, sign it with a local signing identity and install it in /Applications.
# Run it as `pnpm install:mac` in apps/desktop (the repo's `make install-desktop` calls it).
#
# Signing for real (Developer ID, hardened runtime, notarization) is M11. Until then:
# - The app is signed WITHOUT the hardened runtime. electron-builder.yml asks for hardened runtime,
#   and a signature with no Apple team id dies at launch with "Electron Framework ... not valid for
#   use in process": library validation needs a team id, and a local identity has none.
# - It is signed with a per-Mac self-signed identity, NEVER ad hoc. macOS pins each privacy grant
#   (Microphone, Screen & System Audio Recording) to the app's designated requirement. An ad-hoc
#   signature's requirement is its code hash, which changes on every build, so after a rebuild
#   macOS silently denies call audio ("No screen source is available for system audio") while
#   System Settings still shows Roger switched on. A fixed identity keeps the requirement
#   `identifier "ai.linkt.roger" and certificate leaf = H"..."` stable, so grants survive rebuilds.
set -euo pipefail

readonly APP_ID="ai.linkt.roger"
readonly DEST="/Applications/Roger.app"
readonly LOG_DIR="$HOME/Library/Logs/Roger"
readonly SIGNING_DIR="$HOME/Library/Application Support/Roger Dev Signing"
readonly SIGNING_KEYCHAIN="$SIGNING_DIR/signing.keychain-db"
readonly SIGNING_PASSWORD_FILE="$SIGNING_DIR/keychain-password"
readonly SIGNING_CERT="$SIGNING_DIR/cert.pem"
# macOS's own LibreSSL on purpose: a PKCS#12 file from OpenSSL 3 (Homebrew) fails `security import`
# with "MAC verification failed during PKCS12 import".
readonly OPENSSL=/usr/bin/openssl

# A per-Mac code-signing identity in its own keychain, created on first use. It is trusted by
# nothing; it only gives macOS a stable identity to pin privacy grants to. Its keychain password
# sits beside it (mode 600), so any process running as you can sign with it: fine for a dev build,
# and one reason real Developer ID signing is M11.
ensure_signing_identity() {
  if [[ -f "$SIGNING_KEYCHAIN" && -f "$SIGNING_PASSWORD_FILE" && -f "$SIGNING_CERT" ]]; then
    security unlock-keychain -p "$(cat "$SIGNING_PASSWORD_FILE")" "$SIGNING_KEYCHAIN"
    return
  fi
  echo "==> Creating a local code-signing identity in $SIGNING_DIR (first run on this Mac)"
  mkdir -p "$SIGNING_DIR"
  chmod 700 "$SIGNING_DIR"
  local work password
  work="$(mktemp -d)"
  password="$("$OPENSSL" rand -hex 24)"
  cat >"$work/req.cnf" <<CNF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = Roger Local Signing ($(scutil --get LocalHostName 2>/dev/null || hostname -s))
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CNF
  "$OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$work/req.cnf" -extensions ext \
    -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
  "$OPENSSL" pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -out "$work/identity.p12" \
    -passout "pass:$password" -name "Roger Local Signing"
  rm -f "$SIGNING_KEYCHAIN"
  security create-keychain -p "$password" "$SIGNING_KEYCHAIN"
  security set-keychain-settings "$SIGNING_KEYCHAIN" # no auto-lock timeout
  security unlock-keychain -p "$password" "$SIGNING_KEYCHAIN"
  security import "$work/identity.p12" -k "$SIGNING_KEYCHAIN" -P "$password" -T /usr/bin/codesign >/dev/null
  # Without the partition list codesign shows a keychain password dialog on every build.
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$SIGNING_KEYCHAIN" >/dev/null
  cp "$work/cert.pem" "$SIGNING_CERT"
  (umask 077 && printf '%s' "$password" >"$SIGNING_PASSWORD_FILE")
  rm -rf "$work"
}

signing_identity_hash() {
  "$OPENSSL" x509 -in "$SIGNING_CERT" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d :
}

# codesign only finds an identity in a keychain on the user search list (`codesign --keychain`
# does not help for an untrusted certificate: "no identity found"). Add ours for one command and
# always put the user's list back.
with_signing_keychain() {
  local original=()
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    original+=("${line//\"/}")
  done < <(security list-keychains -d user)
  security list-keychains -d user -s "${original[@]}" "$SIGNING_KEYCHAIN"
  local status=0
  "$@" || status=$?
  security list-keychains -d user -s "${original[@]}"
  return "$status"
}

# Empty when the path (an app or the helper) is missing or unsigned. codesign prints an ad-hoc
# signature's implicit requirement as "# designated => cdhash ..."; without the "#" in the pattern
# an ad-hoc install reads as unsigned and its stale grants are never cleared.
# src/main/signing.ts (DESIGNATED_LINE) parses the same line the same way: keep the two in step.
# codesign exits 1 for unsigned code; under `set -e` and `pipefail` that failed pipeline would end
# the whole install, silently, at the caller's assignment. Hence the `|| true`: unsigned reads as
# empty, and each caller decides what empty means.
designated_requirement() {
  [[ -e "$1" ]] || return 0
  { codesign -d -r- "$1" 2>/dev/null || true; } | sed -n 's/^#* *designated => //p'
}

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
# (with the hardened runtime from electron-builder.yml); the local-identity signature below is the
# one used.
CSC_IDENTITY_AUTO_DISCOVERY=false \
  pnpm exec electron-builder --mac dir "$arch_flag" --config electron-builder.yml

echo "==> Signing with the local signing identity (see the top of this file)"
ensure_signing_identity
previous_requirement="$(designated_requirement "$DEST")"
with_signing_keychain codesign --force --deep --sign "$(signing_identity_hash)" "$built"
codesign --verify --deep --strict "$built"
new_requirement="$(designated_requirement "$built")"
if [[ "$new_requirement" != *"certificate leaf"* ]]; then
  echo "install-mac: $built is not signed with the local identity: $new_requirement" >&2
  exit 1
fi

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

if [[ -n "$previous_requirement" && "$previous_requirement" != "$new_requirement" ]]; then
  # The installed app had another identity (an ad-hoc build, or a lost signing keychain). Its grants
  # are pinned to that identity and would show as "on" in System Settings while denying the new
  # build. Clear them so macOS asks again, once.
  echo "==> Signing identity changed: clearing Roger's old privacy grants so macOS asks again"
  for service in Microphone ScreenCapture AudioCapture; do
    tccutil reset "$service" "$APP_ID" >/dev/null
  done
fi

echo "==> Installing $DEST"
# Copy next to the old app first, so a failed copy leaves the installed app untouched.
readonly staged="$DEST.installing"
rm -rf "$staged"
ditto "$built" "$staged"
rm -rf "$DEST"
mv "$staged" "$DEST"

cat <<EOF

Installed $DEST (signed with the local identity, $(uname -m)).

The packaged app reads its settings from
  ~/Library/Application Support/Roger/config.json
not from environment variables or the repo .env (those are for make dev-desktop). For example:
  { "apiUrl": "http://127.0.0.1:8000", "apiToken": "<the API's ROGER_API_TOKEN>" }

macOS asks for Microphone and Screen & System Audio Recording on the first Start after the
identity is created (or changes). Later rebuilds keep the grants.

Launch it with its log in a file (a packaged app logs to stderr only):
  mkdir -p "$LOG_DIR" && open --stdout "$LOG_DIR/stdout.log" --stderr "$LOG_DIR/roger.log" "$DEST"
  tail -f "$LOG_DIR/roger.log"
EOF
