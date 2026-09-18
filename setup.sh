#!/bin/bash
# Writes Local.xcconfig with your Apple Team ID and bundle prefix.
# Usage:  ./setup.sh [TEAM_ID] [BUNDLE_ID_PREFIX]

set -euo pipefail
cd "$(dirname "$0")"

OUT="Local.xcconfig"

if [ -e "$OUT" ] && [ "${FORCE:-}" != "1" ]; then
  echo "$OUT already exists. Delete it or re-run with FORCE=1 to overwrite."
  exit 1
fi

TEAM="${1:-}"
PREFIX="${2:-}"

# Team IDs appear as TeamIdentifier in any provisioning profile Xcode has
# already downloaded. Usually there is exactly one.
detect_teams() {
  local dir="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
  [ -d "$dir" ] || return 0
  local f
  for f in "$dir"/*.mobileprovision "$dir"/*.provisionprofile; do
    [ -e "$f" ] || continue
    security cms -D -i "$f" 2>/dev/null \
      | plutil -extract TeamIdentifier.0 raw - 2>/dev/null || true
  done | sort -u
}

if [ -z "$TEAM" ]; then
  FOUND=$(detect_teams || true)
  COUNT=$(printf '%s' "$FOUND" | grep -c . || true)
  if [ "$COUNT" = "1" ]; then
    TEAM="$FOUND"
    echo "Detected Team ID: $TEAM"
  elif [ "$COUNT" -gt 1 ]; then
    echo "Several Team IDs found:"
    printf '  %s\n' $FOUND
  fi
fi

if [ -z "$TEAM" ] && [ -t 0 ]; then
  echo
  echo "Find yours at https://developer.apple.com/account -> Membership,"
  echo "or open any Xcode project and look at Signing & Capabilities."
  read -r -p "Apple Team ID (10 characters): " TEAM || true
fi

if [ -z "$PREFIX" ]; then
  read -r -p "Bundle ID prefix [com.$(whoami)]: " PREFIX || true
  PREFIX="${PREFIX:-com.$(whoami)}"
fi

if [ -z "$TEAM" ]; then
  echo "No Team ID given. Re-run as: ./setup.sh TEAM_ID com.yourname"
  exit 1
fi

if [ ${#TEAM} -ne 10 ]; then
  echo "Warning: '$TEAM' is not 10 characters. Team IDs normally are."
fi

cat > "$OUT" <<CONF
BUNDLE_ID_PREFIX = $PREFIX
DEVELOPMENT_TEAM = $TEAM
CONF

echo
echo "Wrote $OUT:"
sed 's/^/  /' "$OUT"
echo
echo "Next: open 'Reddit Unblock/Reddit Unblock.xcodeproj', pick the"
echo "'Reddit Unblock (iOS)' scheme and your iPhone, then press Run."
