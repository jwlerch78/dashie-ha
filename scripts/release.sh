#!/usr/bin/env bash
# Atomic release for the Chickadee add-on — two channels in ONE repo:
#
#   prod (default) → chickadee/       slug `chickadee`      (what field boxes install)
#   dev            → chickadee-dev/   slug `chickadee_dev`  (test box; push freely)
#
# `chickadee/` is the CANONICAL source (console + server developed in place).
# `chickadee-dev/` is a generated MIRROR of it (server/, frontend/, integration/,
# Dockerfile, run.sh, package*.json, docs) refreshed here on every dev release —
# only chickadee-dev/config.yaml is hand-owned (name/slug/version). Isolation is
# by version: a dev release bumps ONLY the dev add-on, so an installed prod
# add-on shows no Update until you deliberately cut prod.
#
# Both bump config.yaml + package.json together and commit ONLY that channel's
# folder. Push the console (this repo's main) first — nothing here vendors an
# external branch; the source is right here.
#
# Usage:
#   ./scripts/release.sh <version> [--channel dev|prod] [--push]
#     e.g. ./scripts/release.sh 0.8.7 --channel dev --push

set -euo pipefail

NEW_VERSION=""
CHANNEL="prod"
DO_PUSH=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --push)    DO_PUSH=1; shift ;;
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    -*)        echo "Unknown flag: $1" >&2; exit 1 ;;
    *)         if [[ -z "$NEW_VERSION" ]]; then NEW_VERSION="$1"; shift; else echo "Unexpected arg: $1" >&2; exit 1; fi ;;
  esac
done

if [[ -z "$NEW_VERSION" ]]; then
  echo "Usage: $0 <version> [--channel dev|prod] [--push]" >&2
  exit 1
fi

case "$CHANNEL" in
  prod) ADDON_DIR="chickadee" ;;
  dev)  ADDON_DIR="chickadee-dev" ;;
  *)    echo "Unknown channel: $CHANNEL (expected dev|prod)" >&2; exit 1 ;;
esac

ADDON_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ADDON_ROOT"
DIR="$ADDON_ROOT/$ADDON_DIR"

# Refuse a dirty tree so the release commit contains only what this script staged.
if ! git diff-index --quiet HEAD --; then
  echo "Error: working tree has uncommitted changes. Commit or stash first." >&2
  git status --short
  exit 1
fi

# Repo inversion (2026-07-27): the console is DEVELOPED HERE — no vendoring.
# chickadee/frontend/console is canonical source; the Dashie build vendors
# FROM this repo and overlays its private delta. check-console-tree.sh gates
# the tree instead.
echo "==> Checking console tree (canonical here since the repo inversion)"
"$ADDON_ROOT/scripts/check-console-tree.sh"
CONSOLE_SHA="$(git rev-parse --short HEAD)"

if [[ "$CHANNEL" == "dev" ]]; then
  # Mirror the canonical chickadee/ source into the dev folder (everything
  # tracked EXCEPT config.yaml, which is dev-owned, and integration/, vendored
  # separately below). node_modules/data are gitignored and never copied.
  echo "==> [dev] Mirroring canonical chickadee/ source → chickadee-dev/"
  for item in server frontend Dockerfile run.sh package.json package-lock.json DOCS.md CHANGELOG.md icon.png logo.png; do
    if [[ -d "chickadee/$item" ]]; then
      rsync -a --delete --exclude node_modules "chickadee/$item/" "chickadee-dev/$item/"
    else
      cp "chickadee/$item" "chickadee-dev/$item"
    fi
  done
  echo "==> [dev] Vendoring chickadee integration main → chickadee-dev/integration"
  INTEGRATION_SHA="$("$ADDON_ROOT/scripts/sync-integration.sh" main "" "$DIR/integration")"
else
  echo "==> [prod] Vendoring chickadee integration main → chickadee/integration"
  INTEGRATION_SHA="$("$ADDON_ROOT/scripts/sync-integration.sh" main)"
fi

echo "==> Bumping version → $NEW_VERSION"
sed -i.bak -E "s/^version: \"[^\"]+\"/version: \"$NEW_VERSION\"/" "$DIR/config.yaml"; rm -f "$DIR/config.yaml.bak"
sed -i.bak -E "s/(\"version\": *\")[^\"]+(\")/\1$NEW_VERSION\2/" "$DIR/package.json"; rm -f "$DIR/package.json.bak"
grep -q "\"$NEW_VERSION\"" "$DIR/config.yaml"  || { echo "config.yaml bump failed"; exit 1; }
grep -q "\"$NEW_VERSION\"" "$DIR/package.json" || { echo "package.json bump failed"; exit 1; }
# (server code reads its version from package.json — no VERSION const to sync;
#  the 0.2.0 stale-const bug can't recur.)

echo "==> Staging"
# -A captures files the syncs removed (rm -rf + re-extract). For dev, stage the
# whole mirror folder (gitignore keeps node_modules/data out).
if [[ "$CHANNEL" == "dev" ]]; then
  git add -A "$ADDON_DIR"
else
  git add -A "$DIR/config.yaml" "$DIR/package.json" "$DIR/server" "$DIR/frontend/console" "$DIR/integration"
fi

if git diff --cached --quiet; then
  echo "==> Nothing to commit (already at $NEW_VERSION with console @ $CONSOLE_SHA, integration @ $INTEGRATION_SHA)"
  exit 0
fi

echo "==> Committing [$CHANNEL]"
git commit -m "Release [$CHANNEL] $NEW_VERSION (source @ $CONSOLE_SHA, integration @ $INTEGRATION_SHA)" \
  -- "$ADDON_DIR"

if [[ $DO_PUSH -eq 1 ]]; then
  echo "==> Pushing origin main"
  git push origin main
fi

echo ""
echo "Done. Released [$CHANNEL] $NEW_VERSION (source @ $CONSOLE_SHA, integration @ $INTEGRATION_SHA)."
