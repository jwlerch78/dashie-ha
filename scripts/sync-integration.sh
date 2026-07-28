#!/usr/bin/env bash
# Vendor the Chickadee INTEGRATION into the add-on image so the add-on can
# install it into /config/custom_components ("all at once" onboarding — see
# server/integration-installer.js). Same committed-tree rules as
# sync-console.sh: git archive of origin/main, no working-tree contamination.
#
# Usage: ./scripts/sync-integration.sh [branch] [integration-repo-path]

set -euo pipefail

BRANCH="${1:-main}"
REPO_PATH="${2:-$(cd "$(dirname "$0")/../.." && pwd)/chickadee-integration}"
ADDON_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 3rd arg = target dir (default prod add-on's integration/). The dev channel
# passes chickadee-dev/integration so it vendors without touching prod's copy.
TARGET="${3:-$ADDON_ROOT/chickadee/integration}"

if [[ ! -d "$REPO_PATH/.git" ]]; then
    echo "Error: $REPO_PATH is not a git repository (pass the chickadee integration clone path)." >&2
    exit 1
fi

echo "==> Fetching chickadee origin/$BRANCH" >&2
git -C "$REPO_PATH" fetch origin "$BRANCH" --quiet
SHA="$(git -C "$REPO_PATH" rev-parse --short "origin/$BRANCH")"

echo "==> Vendoring integration origin/$BRANCH ($SHA) → $TARGET" >&2
rm -rf "$TARGET"
mkdir -p "$TARGET"
git -C "$REPO_PATH" archive "origin/$BRANCH" custom_components/chickadee | tar -x -C "$TARGET"

VERSION="$(python3 -c "import json;print(json.load(open('$TARGET/custom_components/chickadee/manifest.json'))['version'])")"
echo "==> Vendored integration v$VERSION (chickadee @ $SHA)" >&2
echo "$SHA"
