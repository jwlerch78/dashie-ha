#!/usr/bin/env bash
# Gate: the disclosure docs still describe the code.
#
# (This is the gate the R3 launch audit called `lint:disclosure`. Grep for that
# name and land here.)
#
# The audit's structural finding was that three of its four Tier-1 items shared
# one root cause: NOTHING kept the public documents in sync with the code they
# describe. Docs were written once, accurately, and then the code moved. Each
# individual drift was small; the aggregate was a set of published claims that
# were no longer true, in a repo whose entire pitch is "read it yourself."
#
# Docs that make checkable claims, and what breaks them:
#
#   chickadee/DOCS.md "Permissions"   enumerates every path the add-on and the
#                                    integration write OUTSIDE /data. A new
#                                    fs.writeFileSync three months from now is
#                                    invisible to a reader of that table.
#   chickadee*/integration/           is a vendored copy of another repo. If it
#                                    stops matching what the release said it
#                                    vendored, the add-on ships code that is in
#                                    no commit of the canonical repo.
#   PRIVACY.md / PROVENANCE.md        exist in two repos because HACS installs a
#                                    different one than the add-on store. A
#                                    mirror that loses its pointer becomes a
#                                    second, silently diverging original.
#
# This gate is deliberately NOT clever. It cannot know whether prose is true.
# What it can do is refuse to let the *set of things needing disclosure* grow
# without someone looking at the disclosure — which is the failure that
# actually happened.
#
# Usage:
#   ./scripts/check-disclosure.sh          # all checks (release.sh runs this)
#   ./scripts/check-disclosure.sh writes   # one check: writes | vendored | mirrors
#
# When check 1 fails because you ADDED a write: that's the gate working. Decide
# where the write lands, document it in the DOCS.md permissions section if it is
# outside /data, then add your line to WRITE_SITES in
# scripts/disclosure-write-paths.sh (sourced below; separate file because that
# baseline is the part that gets edited).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INTEG_REPO="${CHICKADEE_INTEGRATION_REPO:-$(cd "$ROOT/.." && pwd)/chickadee-integration}"
ONLY="${1:-all}"
fail=0

say()  { echo "check-disclosure: $*"; }
bad()  { echo "check-disclosure: ❌ $*" >&2; fail=1; }
warn() { echo "check-disclosure: ⚠️  $*" >&2; }

# ---------------------------------------------------------------------------
# 1. Every write path outside /data is in the DOCS.md permissions table
# ---------------------------------------------------------------------------
# Lives in its own file because its WRITE_SITES baseline is the part you edit.
# shellcheck source=scripts/disclosure-write-paths.sh
. "$ROOT/scripts/disclosure-write-paths.sh"


# ---------------------------------------------------------------------------
# 2. The vendored integration matches what the release said it vendored
# ---------------------------------------------------------------------------
#
# Basis is the RELEASE LEDGER, not origin/main: a release records the exact
# integration SHA it vendored ("Release [dev] X (source @ …, integration @ …)"),
# and prod promotes by re-vendoring that same SHA. Checking against origin/main
# instead would go red every time the integration repo moves ahead of the last
# release, which is a normal state, not a defect.
#
# Neither existing gate covers this: check-generated-tree.sh catches hand-edits
# at authorship (only if the hook is installed), and release.sh's promotion
# check diffs prod against dev — a vendored tree that drifted from canonical in
# BOTH channels passes that comparison identically.
check_vendored_channel() {
  local channel dir ledger sha tmp canon
  channel="$1"; dir="$2"

  ledger="$(git -C "$ROOT" log --grep="^Release \[$channel\]" -1 --format=%s 2>/dev/null || true)"
  if [ -z "$ledger" ]; then
    say "   $channel: no release recorded yet — nothing to verify against (skipped)"
    return
  fi
  sha="$(echo "$ledger" | sed -n 's/.*integration @ \([0-9a-f][0-9a-f]*\).*/\1/p')"
  if [ -z "$sha" ]; then
    bad "$channel release ledger has no integration SHA: $ledger"
    return
  fi
  if [ ! -d "$dir" ]; then
    bad "$channel vendored integration missing: ${dir#$ROOT/}"
    return
  fi
  if [ ! -d "$INTEG_REPO/.git" ]; then
    warn "$channel: integration repo not found at $INTEG_REPO — cannot verify (set CHICKADEE_INTEGRATION_REPO)"
    return
  fi
  # Fetch before accusing. A missing object in a local clone usually means
  # "not fetched yet", not "not canonical" — and the failure below is a serious
  # claim to make wrongly.
  if ! git -C "$INTEG_REPO" rev-parse --verify --quiet "$sha^{commit}" >/dev/null; then
    git -C "$INTEG_REPO" fetch origin --quiet --tags 2>/dev/null || true
  fi
  if ! git -C "$INTEG_REPO" rev-parse --verify --quiet "$sha^{commit}" >/dev/null; then
    if ! git -C "$INTEG_REPO" ls-remote origin >/dev/null 2>&1; then
      warn "$channel: cannot reach the integration remote and $sha is not local — unverified (offline?)"
      return
    fi
    bad "$channel vendored $sha, which is not a commit in the integration repo
       → the shipped add-on contains integration code that is in NO canonical commit
       (fetched first, so this is not a stale-clone artifact)"
    return
  fi

  tmp="$(mktemp -d)"
  git -C "$INTEG_REPO" archive "$sha" custom_components/chickadee | tar -x -C "$tmp"
  canon="$tmp/custom_components/chickadee"
  if diff -r --exclude=__pycache__ "$canon" "$dir/custom_components/chickadee" >/dev/null 2>&1; then
    say "   $channel: ✅ matches integration @ $sha"
  else
    bad "$channel vendored tree does NOT match integration @ $sha:
$(diff -rq --exclude=__pycache__ "$canon" "$dir/custom_components/chickadee" 2>&1 | sed 's/^/       /')
       → re-vendor with scripts/sync-integration.sh, or find who hand-edited it"
  fi
  rm -rf "$tmp"
}

check_vendored() {
  say "Vendored integration vs the SHA each channel's release recorded:"
  check_vendored_channel dev  "$ROOT/chickadee-dev/integration"
  check_vendored_channel prod "$ROOT/chickadee/integration"
}

# ---------------------------------------------------------------------------
# 3. Mirrored documents still point at their canonical copy
# ---------------------------------------------------------------------------
#
# PRIVACY.md and PROVENANCE.md exist in both repos because HACS installs the
# integration repo while the add-on store installs this one — the disclosure has
# to be in whichever one you actually got. They are NOT byte-identical and are
# not meant to be (the mirror carries an extra header, and may condense a
# section whose detail belongs on the canonical page). What must hold is that a
# mirror still declares where the original lives, so it can't quietly become a
# second original.
check_mirrors() {
  local f mirror canonical
  for f in PRIVACY.md PROVENANCE.md; do
    mirror="$INTEG_REPO/$f"
    canonical="$ROOT/$f"
    if [ ! -f "$canonical" ]; then
      bad "canonical $f missing from this repo"
      continue
    fi
    if [ ! -d "$INTEG_REPO/.git" ]; then
      warn "integration repo not found at $INTEG_REPO — cannot check the $f mirror"
      continue
    fi
    if [ ! -f "$mirror" ]; then
      bad "$f is not mirrored into the integration repo (HACS users would never see it)"
      continue
    fi
    if ! grep -q "MIRRORED FILE" "$mirror"; then
      bad "$f in the integration repo has lost its 'MIRRORED FILE — canonical copy:' header
       → without it, the next editor treats a mirror as an original and the two diverge"
      continue
    fi
    if ! grep -q "jwlerch78/chickadee/blob/main/$f" "$mirror"; then
      bad "$f mirror's canonical pointer does not resolve to jwlerch78/chickadee/blob/main/$f"
    fi
  done

  # CONTRACTS.md is the reverse direction: one copy in the integration repo,
  # a pointer here. A pointer that stops pointing is worse than no pointer.
  if [ -f "$ROOT/CONTRACTS.md" ] \
     && ! grep -q "chickadee-integration/blob/main/CONTRACTS.md" "$ROOT/CONTRACTS.md"; then
    bad "CONTRACTS.md here no longer links the canonical registry in chickadee-integration"
  fi

  [ "$fail" -eq 0 ] && say "✅ doc mirrors declare their canonical source"
}

# ---------------------------------------------------------------------------
case "$ONLY" in
  all)      check_writes; check_vendored; check_mirrors ;;
  writes)   check_writes ;;
  vendored) check_vendored ;;
  mirrors)  check_mirrors ;;
  *) echo "usage: $0 [all|writes|vendored|mirrors]" >&2; exit 2 ;;
esac

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "check-disclosure: FAILED — the published docs no longer match the code." >&2
  echo "                  Fix the docs (or the code), not this script's baseline," >&2
  echo "                  unless the baseline is what's actually wrong." >&2
  exit 1
fi
say "✅ disclosure gate passed"
