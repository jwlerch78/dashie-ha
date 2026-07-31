#!/usr/bin/env bash
# Atomic release for the Dashie for Home Assistant add-on — two channels in ONE repo:
#
#   prod (default) → dashie-ha/       slug `dashie_ha`      (what field boxes install)
#   dev            → dashie-ha-dev/   slug `dashie_ha_dev`  (test box; push freely)
#
# `dashie-ha/` is the CANONICAL source (console + server developed in place).
# `dashie-ha-dev/` is a generated MIRROR of it (server/, frontend/, integration/,
# Dockerfile, run.sh, package*.json, docs) refreshed here on every dev release —
# only dashie-ha-dev/config.yaml is hand-owned (name/slug/version). Isolation is
# by version: a dev release bumps ONLY the dev add-on, so an installed prod
# add-on shows no Update until you deliberately cut prod.
#
# Both bump config.yaml + package.json together and commit ONLY that channel's
# folder.
#
# PROD IS A PROMOTION, NOT A BUILD (since 2026-07-29).
# ----------------------------------------------------
# A dev release records the exact inputs it was built from, in its own commit
# message: "Release [dev] X (source @ <sha>, integration @ <sha>)". A prod
# release now READS that ledger and rebuilds prod from those same two SHAs, so
# prod can only ever ship a tree the dev channel actually ran. Whatever landed
# on main since the last dev release is NOT picked up — cut a dev release and
# test it first. The promotion verifies the result byte-for-byte against
# dashie-ha-dev/ before committing.
#
# `--from-head` opts out and builds prod from current HEAD + integration
# origin/main (the pre-2026-07-29 behaviour). It exists for hotfixes; it prints
# a loud warning, because using it means prod ships something no dev box ran.
#
# Usage:
#   ./scripts/release.sh <version> [--channel dev|prod] [--push] [--from-head]
#     ./scripts/release.sh 0.8.7 --channel dev --push    # cut + test on the dev box
#     ./scripts/release.sh 0.9.0 --channel prod --push   # promote that dev build

set -euo pipefail

NEW_VERSION=""
CHANNEL="prod"
DO_PUSH=0
FROM_HEAD=0
ASSUME_YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --push)      DO_PUSH=1; shift ;;
    --yes|-y)    ASSUME_YES=1; shift ;;
    --from-head) FROM_HEAD=1; shift ;;
    --channel)   CHANNEL="${2:-}"; shift 2 ;;
    -*)          echo "Unknown flag: $1" >&2; exit 1 ;;
    *)           if [[ -z "$NEW_VERSION" ]]; then NEW_VERSION="$1"; shift; else echo "Unexpected arg: $1" >&2; exit 1; fi ;;
  esac
done

if [[ -z "$NEW_VERSION" ]]; then
  echo "Usage: $0 <version> [--channel dev|prod] [--push]" >&2
  exit 1
fi

case "$CHANNEL" in
  prod) ADDON_DIR="dashie-ha" ;;
  dev)  ADDON_DIR="dashie-ha-dev" ;;
  *)    echo "Unknown channel: $CHANNEL (expected dev|prod)" >&2; exit 1 ;;
esac

ADDON_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ADDON_ROOT"
DIR="$ADDON_ROOT/$ADDON_DIR"

# Writing the generated trees is this script's JOB, so exempt it from the
# pre-commit gate that refuses hand-edits to them (check-generated-tree.sh).
export DASHIE_HA_RELEASE=1

# Refuse a dirty tree so the release commit contains only what this script staged.
if ! git diff-index --quiet HEAD --; then
  echo "Error: working tree has uncommitted changes. Commit or stash first." >&2
  git status --short
  exit 1
fi
# Also refuse stray untracked files in the channel folders. Two reasons: they'd
# be swept into `git add -A`, and the rollback below uses `git clean`, which is
# only safe to run if we know nothing untracked was there to begin with.
# (Ignored paths — node_modules/, data/ — are excluded and never touched.)
STRAY="$(git ls-files --others --exclude-standard -- dashie-ha dashie-ha-dev)"
if [[ -n "$STRAY" ]]; then
  echo "Error: untracked files in the channel folders. Commit or remove them first:" >&2
  sed 's/^/  /' <<<"$STRAY" >&2
  exit 1
fi

# A release rewrites the channel folder in place (rm -rf + re-extract). If any
# step after that fails, the tree is left rewound to some other commit's content
# — which then trips the clean-tree guard above on the next run and needs manual
# repair. Roll back instead. Armed just before the first mutation; disarmed on
# success. Safe because of the two guards above: the tree was provably clean.
ROLLBACK_ARMED=0
rollback_on_failure() {
  local code=$?
  [[ $ROLLBACK_ARMED -eq 1 && $code -ne 0 ]] || exit $code
  echo "" >&2
  echo "==> Release failed — restoring the working tree to HEAD" >&2
  # ORDER MATTERS. `git checkout -- <path>` restores the worktree from the
  # INDEX, not from HEAD. By the time we fail, the version bump is usually
  # already staged, so checking out first would faithfully restore the bump and
  # report success while leaving the tree dirty. Unstage first, then restore.
  git reset -q HEAD -- dashie-ha dashie-ha-dev 2>/dev/null || true
  git checkout -- dashie-ha dashie-ha-dev 2>/dev/null || true
  git clean -qfd -- dashie-ha dashie-ha-dev 2>/dev/null || true
  if git diff --quiet -- dashie-ha dashie-ha-dev && git diff --cached --quiet -- dashie-ha dashie-ha-dev; then
    echo "    tree restored; nothing was committed." >&2
  else
    # Never claim a clean rollback we didn't achieve.
    echo "    ⚠️  could NOT fully restore — inspect and clean up by hand:" >&2
    git status --short -- dashie-ha dashie-ha-dev | sed 's/^/      /' >&2
  fi
  exit $code
}
trap rollback_on_failure EXIT

# Repo inversion (2026-07-27): the console is DEVELOPED HERE — no vendoring.
# dashie-ha/frontend/console is canonical source; the Dashie build vendors
# FROM this repo and overlays its private delta. check-console-tree.sh gates
# the tree instead.
echo "==> Checking console tree (canonical here since the repo inversion)"
# DASHIE_HA_ENDPOINTS_INTERIM=1 lets a DEV release go out while the console↔server
# endpoint gate is still red (the server-merge window — 20260731_SERVER_MERGE_MAP.md
# §8). It must never reach a PROD cut: with the Devices stopgap declined, that gate
# is the only thing keeping a knowingly-broken page away from users. Strip it here
# rather than trusting whoever exported it to remember the difference.
if [[ "$CHANNEL" == "prod" && "${DASHIE_HA_ENDPOINTS_INTERIM:-0}" == "1" ]]; then
  echo "==> [prod] ignoring DASHIE_HA_ENDPOINTS_INTERIM — the endpoint gate is enforced for prod"
  unset DASHIE_HA_ENDPOINTS_INTERIM
fi
"$ADDON_ROOT/scripts/check-console-tree.sh"

# The disclosure gate: DOCS.md still lists every non-/data write path, the
# vendored integration still matches the SHA the last release recorded, and the
# doc mirrors still point home. Runs BEFORE anything mutates a channel folder —
# it validates the tree we are about to build from, and the vendored-tree check
# is only meaningful against the PREVIOUS release's ledger entry (this run
# writes a new one).
echo "==> Checking disclosure (docs still describe the code)"
"$ADDON_ROOT/scripts/check-disclosure.sh"
# Default: the source is whatever HEAD holds. A prod PROMOTION overwrites this
# with the SHA recorded by the dev release it is promoting (see below).
CONSOLE_SHA="$(git rev-parse --short HEAD)"

# The set of paths the dev channel mirrors from dashie-ha/. Single source of
# truth for both the dev mirror and the prod promotion — they must agree, or a
# promotion would verify a different set of files than dev actually shipped.
MIRRORED_ITEMS=(server frontend Dockerfile run.sh package.json package-lock.json DOCS.md CHANGELOG.md icon.png logo.png)

# Everything past this point mutates the channel folder — rollback is now live.
ROLLBACK_ARMED=1

if [[ "$CHANNEL" == "dev" ]]; then
  # Mirror the canonical dashie-ha/ source into the dev folder (everything
  # tracked EXCEPT config.yaml, which is dev-owned, and integration/, vendored
  # separately below). node_modules/data are gitignored and never copied.
  echo "==> [dev] Mirroring canonical dashie-ha/ source → dashie-ha-dev/"
  for item in "${MIRRORED_ITEMS[@]}"; do
    if [[ -d "dashie-ha/$item" ]]; then
      rsync -a --delete --exclude node_modules "dashie-ha/$item/" "dashie-ha-dev/$item/"
    else
      cp "dashie-ha/$item" "dashie-ha-dev/$item"
    fi
  done
  echo "==> [dev] Vendoring Dashie Voice integration main → dashie-ha-dev/integration"
  INTEGRATION_SHA="$("$ADDON_ROOT/scripts/sync-integration.sh" main "" "$DIR/integration")"

elif [[ $FROM_HEAD -eq 1 ]]; then
  echo "==> [prod] ⚠️  --from-head: building prod from current HEAD, NOT promoting a dev build."
  echo "    Prod will ship a tree no dev box has run. Only correct for a hotfix."
  echo "==> [prod] Vendoring Dashie Voice integration main → dashie-ha/integration"
  INTEGRATION_SHA="$("$ADDON_ROOT/scripts/sync-integration.sh" main)"

else
  # ── Promote the last dev release ──────────────────────────────────────────
  # Read the inputs out of the dev release ledger rather than rebuilding from
  # whatever is current. Only the "[dev] ... (source @ x, integration @ y)"
  # format is accepted — pre-2026-07-27 commits used a different shape, and
  # mis-parsing one would silently promote the wrong tree.
  echo "==> [prod] Locating the dev release to promote"
  DEV_RELEASE="$(git log -n 50 --format='%H %s' --grep='^Release \[dev\] ' \
                 | grep -E 'source @ [0-9a-f]+, integration @ [0-9a-f]+' | head -n 1 || true)"
  if [[ -z "$DEV_RELEASE" ]]; then
    echo "Error: no 'Release [dev] ... (source @ x, integration @ y)' commit found." >&2
    echo "       Cut and test a dev release first, or use --from-head for a hotfix." >&2
    exit 1
  fi
  DEV_COMMIT="${DEV_RELEASE%% *}"
  DEV_SUBJECT="${DEV_RELEASE#* }"
  CONSOLE_SHA="$(sed -E 's/.*source @ ([0-9a-f]+).*/\1/' <<<"$DEV_SUBJECT")"
  INTEGRATION_SHA_WANTED="$(sed -E 's/.*integration @ ([0-9a-f]+).*/\1/' <<<"$DEV_SUBJECT")"
  DEV_VERSION="$(sed -E 's/^Release \[dev\] ([^ ]+) .*/\1/' <<<"$DEV_SUBJECT")"
  echo "    Promoting dev $DEV_VERSION  (commit ${DEV_COMMIT:0:9})"
  echo "    source @ $CONSOLE_SHA   integration @ $INTEGRATION_SHA_WANTED"

  # Restore the prod source tree to exactly what that dev release mirrored.
  # rm -rf + git archive (not `git checkout -- path`), so files added to
  # dashie-ha/ since the dev release are REMOVED rather than left behind —
  # otherwise prod would carry code dev never saw, which is the whole point.
  echo "==> [prod] Restoring dashie-ha/ source @ $CONSOLE_SHA"
  for item in "${MIRRORED_ITEMS[@]}"; do
    if ! git cat-file -e "$CONSOLE_SHA:dashie-ha/$item" 2>/dev/null; then
      echo "Error: dashie-ha/$item does not exist at $CONSOLE_SHA — refusing a partial promotion." >&2
      exit 1
    fi
    rm -rf "dashie-ha/$item"
    git archive "$CONSOLE_SHA" "dashie-ha/$item" | tar -x -C "$ADDON_ROOT"
  done

  echo "==> [prod] Vendoring Dashie Voice integration @ $INTEGRATION_SHA_WANTED"
  INTEGRATION_SHA="$("$ADDON_ROOT/scripts/sync-integration.sh" "$INTEGRATION_SHA_WANTED")"
fi

# ── Promotion proof ─────────────────────────────────────────────────────────
# Everything above is intent; this is the evidence. Compare the prod tree we
# just assembled against dashie-ha-dev/ file-by-file. If they differ, the
# promotion did NOT reproduce the tested build and the release must not happen.
# Runs BEFORE the version bump, since config.yaml/package.json versions are the
# one thing the channels are supposed to differ on.
if [[ "$CHANNEL" == "prod" && $FROM_HEAD -eq 0 ]]; then
  echo "==> [prod] Verifying the promoted tree matches dashie-ha-dev/"
  PROMOTION_DRIFT=0
  for item in "${MIRRORED_ITEMS[@]}" integration; do
    # package.json holds the channel's own version — compare everything else in
    # it by stripping that one line.
    if [[ "$item" == "package.json" ]]; then
      if ! diff <(grep -v '"version"' "dashie-ha/$item") <(grep -v '"version"' "dashie-ha-dev/$item") >/dev/null; then
        echo "    ✗ $item differs (beyond the version field)"; PROMOTION_DRIFT=1
      fi
      continue
    fi
    if ! diff -r --exclude=node_modules --exclude=__pycache__ --exclude=data \
              "dashie-ha/$item" "dashie-ha-dev/$item" >/dev/null 2>&1; then
      echo "    ✗ $item differs between prod and dev"; PROMOTION_DRIFT=1
    fi
  done
  if [[ $PROMOTION_DRIFT -eq 1 ]]; then
    echo "" >&2
    echo "Error: the promoted prod tree does not match dashie-ha-dev/." >&2
    echo "       Prod would ship something the dev channel never ran." >&2
    echo "       Most likely: dashie-ha-dev/ was hand-edited (it is GENERATED —" >&2
    echo "       see the header of this script), or the dev release predates a" >&2
    echo "       change to MIRRORED_ITEMS. Re-cut the dev release and retest." >&2
    exit 1
  fi
  echo "    ✅ prod tree is byte-identical to the tested dev build"
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
# whole mirror folder (gitignore keeps node_modules/data out). For prod, stage
# config.yaml + integration/ + every MIRRORED_ITEM — a promotion rewinds all of
# them to the dev release's SHA, so staging a subset (as this did before the
# promotion model) would commit a tree that is half-promoted and half-HEAD.
if [[ "$CHANNEL" == "dev" ]]; then
  git add -A "$ADDON_DIR"
else
  PROD_PATHS=("$DIR/config.yaml" "$DIR/integration")
  for item in "${MIRRORED_ITEMS[@]}"; do PROD_PATHS+=("$DIR/$item"); done
  git add -A "${PROD_PATHS[@]}"
fi

if git diff --cached --quiet; then
  echo "==> Nothing to commit (already at $NEW_VERSION with console @ $CONSOLE_SHA, integration @ $INTEGRATION_SHA)"
  exit 0
fi

# ── Confirm before it becomes real ──────────────────────────────────────────
# Everything so far is local and rolled back on failure. The commit (and any
# --push) is the point of no return, and for prod it reaches field boxes: HA
# reads config.yaml's version and offers every installed box an Update.
echo ""
echo "────────────────────────────────────────────────────────────"
if [[ "$CHANNEL" == "prod" ]]; then
  echo " RELEASE: prod  →  slug 'dashie-ha'  (FIELD BOXES)"
else
  echo " RELEASE: dev   →  slug 'dashie_ha_dev'  (test box only)"
fi
echo " version:      $NEW_VERSION"
echo " source @:     $CONSOLE_SHA"
echo " integration @ $INTEGRATION_SHA"
if [[ "$CHANNEL" == "prod" && $FROM_HEAD -eq 0 ]]; then
  echo " promoted from dev $DEV_VERSION (${DEV_COMMIT:0:9}) — tree verified identical"
elif [[ "$CHANNEL" == "prod" ]]; then
  echo " ⚠️  --from-head: NOT promoted from a tested dev build"
fi
echo " push:         $([[ $DO_PUSH -eq 1 ]] && echo 'YES — origin main' || echo 'no (local commit only)')"
echo "────────────────────────────────────────────────────────────"
echo " files staged:"
git diff --cached --stat | tail -n 6 | sed 's/^/  /'
echo "────────────────────────────────────────────────────────────"

if [[ $ASSUME_YES -eq 1 ]]; then
  echo "  (--yes given, proceeding)"
elif [[ ! -t 0 ]]; then
  # Non-interactive with no --yes: refuse rather than assume. A release that
  # silently proceeds under automation is exactly the thing worth not doing.
  echo "Error: not a terminal and --yes not given — refusing to release unattended." >&2
  exit 1
else
  read -r -p "Cut this release? (y/N) " REPLY
  if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 1
  fi
fi

echo "==> Committing [$CHANNEL]"
# The "(source @ x, integration @ y)" suffix is a LEDGER, not decoration: a prod
# promotion parses it off the last dev release. Keep the format if you edit it.
COMMIT_MSG="Release [$CHANNEL] $NEW_VERSION (source @ $CONSOLE_SHA, integration @ $INTEGRATION_SHA)"
if [[ "$CHANNEL" == "prod" && $FROM_HEAD -eq 0 ]]; then
  COMMIT_MSG+=" — promoted from dev $DEV_VERSION (${DEV_COMMIT:0:9}), tree verified identical"
elif [[ "$CHANNEL" == "prod" ]]; then
  COMMIT_MSG+=" — BUILT FROM HEAD (--from-head), not promoted from a dev build"
fi
git commit -m "$COMMIT_MSG" -- "$ADDON_DIR"
# Committed — a later failure (e.g. the push) must NOT roll the tree back, and
# must not claim nothing was committed.
ROLLBACK_ARMED=0

if [[ $DO_PUSH -eq 1 ]]; then
  echo "==> Pushing origin main"
  git push origin main
fi

echo ""
echo "Done. Released [$CHANNEL] $NEW_VERSION (source @ $CONSOLE_SHA, integration @ $INTEGRATION_SHA)."
