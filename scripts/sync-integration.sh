#!/usr/bin/env bash
# Vendor the Dashie Voice INTEGRATION into the add-on image so the add-on can
# install it into /config/custom_components ("all at once" onboarding — see
# server/integration-installer.js). Committed-tree only: a git archive of the
# requested ref, never the working tree.
#
# Usage: ./scripts/sync-integration.sh [ref] [integration-repo-path] [target-dir]
#
# `ref` is a BRANCH (resolved as origin/<ref>) or an exact COMMIT SHA. The SHA
# form is what `release.sh --channel prod` uses to promote: prod re-vendors the
# exact integration commit the dev channel was built from, rather than whatever
# origin/main happens to be at prod-release time.

set -euo pipefail

REF="${1:-main}"
REPO_PATH="${2:-$(cd "$(dirname "$0")/../.." && pwd)/dashie-voice-integration}"
ADDON_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 3rd arg = target dir (default prod add-on's integration/). The dev channel
# passes dashie-ha-dev/integration so it vendors without touching prod's copy.
TARGET="${3:-$ADDON_ROOT/dashie-ha/integration}"

if [[ ! -d "$REPO_PATH/.git" ]]; then
    echo "Error: $REPO_PATH is not a git repository (pass the Dashie Voice integration clone path)." >&2
    exit 1
fi

echo "==> Fetching Dashie Voice integration" >&2
git -C "$REPO_PATH" fetch origin --quiet --tags

# Branch first (origin/<ref>), then fall back to treating <ref> as a raw commit.
# Branch-first matters: a branch named like a SHA prefix would otherwise resolve
# to whichever the local object store happened to match.
if git -C "$REPO_PATH" rev-parse --verify --quiet "origin/$REF^{commit}" >/dev/null; then
    RESOLVED="origin/$REF"
elif git -C "$REPO_PATH" rev-parse --verify --quiet "$REF^{commit}" >/dev/null; then
    RESOLVED="$REF"
else
    echo "Error: '$REF' is neither a branch on origin nor a commit in $REPO_PATH." >&2
    echo "       (Promoting a prod release? The dev release's integration SHA must be" >&2
    echo "        pushed to the integration repo before prod can vendor it.)" >&2
    exit 1
fi
SHA="$(git -C "$REPO_PATH" rev-parse --short "$RESOLVED^{commit}")"

echo "==> Vendoring integration $RESOLVED ($SHA) → $TARGET" >&2
rm -rf "$TARGET"
mkdir -p "$TARGET"
git -C "$REPO_PATH" archive "$RESOLVED" custom_components/dashie_voice | tar -x -C "$TARGET"

VERSION="$(cd "$TARGET" && python3 -c "import json;print(json.load(open('custom_components/dashie_voice/manifest.json'))['version'])")"
echo "==> Vendored integration v$VERSION (dashie-voice-integration @ $SHA)" >&2
echo "$SHA"
