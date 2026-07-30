#!/usr/bin/env bash
# Refuse hand-edits to GENERATED trees.
#
# Three kinds of directory live in this repo, and only one of them is yours:
#
#   dashie-ha/server/, dashie-ha/frontend/console/   SOURCE — edit freely
#   dashie-ha-dev/**                                 GENERATED (rsync --delete from dashie-ha/)
#   dashie-ha*/integration/**                        GENERATED (rm -rf + git archive of dashie-voice-integration)
#
# Both generated kinds are rebuilt DESTRUCTIVELY at release. An edit there
# looks completely normal — it commits, it diffs, it reviews — and is then
# deleted with no error and no log the next time a release runs.
#
# This is not hypothetical. Commit 30ea848 authored the entire satellite
# wake-word feature (satellite_wake.py + wake_models/) directly in
# dashie-ha/integration/. It existed in no commit of dashie-voice-integration,
# so the next prod release would have silently removed the feature from the
# shipped add-on.
#
# Note the release-time promotion check does NOT cover this: it diffs prod
# against dashie-ha-dev/, and a hand-edit to a vendored dir is wiped from BOTH
# identically, so the comparison passes. This gate is the only thing that
# catches it — and it catches it at authorship, which is where it is cheap.
#
# Usage:
#   ./scripts/check-generated-tree.sh              # check the staged set (pre-commit)
#   ./scripts/check-generated-tree.sh <file>...    # check specific paths
#
# Exempt: DASHIE_HA_RELEASE=1 (release.sh sets this — it is the thing that is
# SUPPOSED to write these trees).

set -euo pipefail

if [[ "${DASHIE_HA_RELEASE:-0}" == "1" ]]; then
    exit 0
fi

FILES=()
if [[ $# -gt 0 ]]; then
    FILES=("$@")
else
    # bash 3.2 (macOS system bash) has no mapfile — read loop instead.
    while IFS= read -r line; do
        [[ -n "$line" ]] && FILES+=("$line")
    done < <(git diff --cached --name-only --diff-filter=ACMR)
fi

[[ ${#FILES[@]} -eq 0 ]] && exit 0

VENDORED=()
MIRRORED=()
for f in "${FILES[@]}"; do
    case "$f" in
        # Hand-owned inside an otherwise-generated folder: the dev channel's
        # config.yaml carries its own name/slug/version and is NOT mirrored.
        dashie-ha-dev/config.yaml) ;;
        dashie-ha/integration/*|dashie-ha-dev/integration/*) VENDORED+=("$f") ;;
        dashie-ha-dev/*)                                     MIRRORED+=("$f") ;;
    esac
done

[[ ${#VENDORED[@]} -eq 0 && ${#MIRRORED[@]} -eq 0 ]] && exit 0

echo "" >&2
echo "check-generated-tree: ❌ refusing — these files are GENERATED and will be" >&2
echo "                        deleted by the next release, silently." >&2

if [[ ${#VENDORED[@]} -gt 0 ]]; then
    echo "" >&2
    echo "  Vendored from the dashie-voice-integration repo:" >&2
    for f in "${VENDORED[@]}"; do echo "    $f" >&2; done
    echo "" >&2
    echo "  → Author this in ~/projects/dashie-voice-integration instead, commit," >&2
    echo "    PUSH it (sync-integration.sh reads origin/<ref>, not your working" >&2
    echo "    tree), then re-vendor with a release." >&2
fi

if [[ ${#MIRRORED[@]} -gt 0 ]]; then
    echo "" >&2
    echo "  Mirrored from dashie-ha/ by the dev release:" >&2
    for f in "${MIRRORED[@]}"; do echo "    $f" >&2; done
    echo "" >&2
    echo "  → Edit the canonical copy instead — same path under dashie-ha/:" >&2
    for f in "${MIRRORED[@]}"; do echo "    ${f/dashie-ha-dev\//dashie-ha/}" >&2; done
fi

echo "" >&2
echo "  If you are certain (you are release.sh, or repairing a broken vendor):" >&2
echo "    DASHIE_HA_RELEASE=1 git commit ..." >&2
echo "" >&2
exit 1
