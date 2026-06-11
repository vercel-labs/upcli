#!/bin/sh

set -eu
# Fail a pipeline if any stage fails (e.g. `shasum | awk`), so a broken first
# stage cannot yield an empty result that slips past the checksum check below.
# No-op on POSIX sh/dash, active on bash/zsh.
(set -o pipefail) 2>/dev/null && set -o pipefail || true

VERSION="${UP_VERSION:-v0.1.0-beta.5}"
INSTALL_DIR="${UP_INSTALL_DIR:-${HOME:?HOME is required}/.local/bin}"
DOWNLOAD_ROOT="${UP_DOWNLOAD_ROOT:-https://cdn.upcli.dev/releases/${VERSION}}"

fail() {
  printf 'up install: %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v node >/dev/null 2>&1 || fail "Node.js >=20.19.0 is required. Install Node.js, then run this command again."

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 19) ? 0 : 1)' ||
  fail "Node.js >=20.19.0 is required. Found $(node --version)."

# Owner-only temp dir so other local users cannot read the binary while it is
# downloaded and verified.
umask 077
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/up-install.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM

printf 'Downloading up %s\n' "$VERSION"
# --proto =https forbids any non-HTTPS transfer and --proto-redir -all,https
# refuses to follow a redirect that downgrades to plaintext.
curl -fsSL --proto '=https' --proto-redir -all,https "$DOWNLOAD_ROOT/up.mjs" -o "$TMP_DIR/up.mjs" ||
  fail "Unable to download up.mjs for ${VERSION}."
curl -fsSL --proto '=https' --proto-redir -all,https "$DOWNLOAD_ROOT/checksums.txt" -o "$TMP_DIR/checksums.txt" ||
  fail "Unable to download checksums.txt for ${VERSION}."

EXPECTED_CHECKSUM="$(awk '$2 == "up.mjs" && length($1) == 64 && $1 ~ /^[0-9a-fA-F]+$/ { print tolower($1) }' "$TMP_DIR/checksums.txt")"
if [ -z "$EXPECTED_CHECKSUM" ] || [ "$(printf '%s\n' "$EXPECTED_CHECKSUM" | wc -l | tr -d ' ')" -ne 1 ]; then
  fail "Checksum file must contain exactly one SHA-256 entry for up.mjs."
fi

if command -v shasum >/dev/null 2>&1; then
  ACTUAL_CHECKSUM="$(shasum -a 256 "$TMP_DIR/up.mjs" | awk '{ print tolower($1) }')"
elif command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_CHECKSUM="$(sha256sum "$TMP_DIR/up.mjs" | awk '{ print tolower($1) }')"
else
  fail "Install shasum or sha256sum to verify the release download."
fi
[ "$ACTUAL_CHECKSUM" = "$EXPECTED_CHECKSUM" ] || fail "Checksum verification failed."

mkdir -p "$INSTALL_DIR"

# Refuse to write into a directory owned by another user (e.g. if UP_INSTALL_DIR
# points at a shared/system path), which could otherwise overwrite or run files
# we do not control. `stat` flags differ between GNU (-c) and BSD/macOS (-f).
DIR_OWNER="$(stat -c '%u' "$INSTALL_DIR" 2>/dev/null || stat -f '%u' "$INSTALL_DIR" 2>/dev/null || echo '')"
if [ -n "$DIR_OWNER" ] && [ "$DIR_OWNER" != "$(id -u)" ]; then
  fail "Install directory $INSTALL_DIR is not owned by the current user."
fi

rm -f "$INSTALL_DIR/up" "$INSTALL_DIR/up.mjs"
install -m 755 "$TMP_DIR/up.mjs" "$INSTALL_DIR/up.mjs"
cat >"$INSTALL_DIR/up" <<'EOF'
#!/bin/sh
set -e
BIN_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec node "$BIN_DIR/up.mjs" "$@"
EOF
chmod 755 "$INSTALL_DIR/up"

printf 'Installed up to %s/up\n' "$INSTALL_DIR"
case ":${PATH:-}:" in
  *":$INSTALL_DIR:"*) printf 'Run: cd <your-project> && up .\n' ;;
  *) printf 'Add %s to PATH, then run: up .\n' "$INSTALL_DIR" ;;
esac
# This channel is frozen at its final beta. Releases moved to npm.
printf 'Note: up is now distributed via npm: npm install -g up\n'
