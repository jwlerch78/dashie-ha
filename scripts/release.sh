#!/usr/bin/env bash
# Atomic release for the Chickadee add-on (single channel — the repo's main
# branch is what HA installs from). Port of the dashie-ha-app release.sh
# pattern, minus the dev/prod split.
#
# Vendors the dashie-console SPA (COMMITTED tree of origin/main — push the
# console first), bumps config.yaml + package.json together, and commits ONLY
# the add-on folder.
#
# Usage:
#   ./scripts/release.sh <version> [--push]
#     e.g. ./scripts/release.sh 0.5.0 --push

set -euo pipefail

NEW_VERSION=""
DO_PUSH=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --push) DO_PUSH=1; shift ;;
    -*)     echo "Unknown flag: $1" >&2; exit 1 ;;
    *)      if [[ -z "$NEW_VERSION" ]]; then NEW_VERSION="$1"; shift; else echo "Unexpected arg: $1" >&2; exit 1; fi ;;
  esac
done

if [[ -z "$NEW_VERSION" ]]; then
  echo "Usage: $0 <version> [--push]" >&2
  exit 1
fi

ADDON_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ADDON_ROOT"
DIR="$ADDON_ROOT/chickadee"

# Refuse a dirty tree so the release commit contains only what this script staged.
if ! git diff-index --quiet HEAD --; then
  echo "Error: working tree has uncommitted changes. Commit or stash first." >&2
  git status --short
  exit 1
fi

echo "==> Vendoring dashie-console main → chickadee/frontend/console"
CONSOLE_SHA="$("$ADDON_ROOT/scripts/sync-console.sh" main)"

echo "==> Bumping version → $NEW_VERSION"
sed -i.bak -E "s/^version: \"[^\"]+\"/version: \"$NEW_VERSION\"/" "$DIR/config.yaml"; rm -f "$DIR/config.yaml.bak"
sed -i.bak -E "s/(\"version\": *\")[^\"]+(\")/\1$NEW_VERSION\2/" "$DIR/package.json"; rm -f "$DIR/package.json.bak"
grep -q "\"$NEW_VERSION\"" "$DIR/config.yaml"  || { echo "config.yaml bump failed"; exit 1; }
grep -q "\"$NEW_VERSION\"" "$DIR/package.json" || { echo "package.json bump failed"; exit 1; }
# (server code reads its version from package.json — no VERSION const to sync;
#  the 0.2.0 stale-const bug can't recur.)

echo "==> Staging"
# -A captures files the console removed (sync does rm -rf + re-extract).
git add -A "$DIR/config.yaml" "$DIR/package.json" "$DIR/server" "$DIR/frontend/console"

if git diff --cached --quiet; then
  echo "==> Nothing to commit (already at $NEW_VERSION with console @ $CONSOLE_SHA)"
  exit 0
fi

echo "==> Committing"
git commit -m "Release $NEW_VERSION (console main @ $CONSOLE_SHA)" \
  -- "$DIR/config.yaml" "$DIR/package.json" "$DIR/server" "$DIR/frontend/console"

if [[ $DO_PUSH -eq 1 ]]; then
  echo "==> Pushing origin main"
  git push origin main
fi

echo ""
echo "Done. Released $NEW_VERSION (console main @ $CONSOLE_SHA)."
