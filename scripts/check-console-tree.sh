#!/usr/bin/env bash
# Gate: the public console tree stays open-core clean.
#
# The console at dashie-ha/frontend/console is CANONICAL SOURCE (repo
# inversion, 2026-07-27) — the Dashie build vendors from here and overlays
# its private delta (paywall/subscription + family-product pages). This gate
# proves none of that delta leaks back into the public tree:
#
#   1. No Dashie-only module files present (they live only in the delta)
#   2. No paywall/subscription copy or Stripe price ids in js/html
#   3. Delta globals referenced ONLY in guarded form (window.X?. / typeof X)
#   4. Every <script src> in index.html + login/index.html resolves
#   5. The DELTA-SCRIPTS block is empty
#   6. I7 — no FAMILY_ONLY_OPTIONS entry is reachable in a published build
#
# 1–5 are FILE and STRING checks. They cannot see a BEHAVIOURAL leak: a family
# feature reachable in the published build through a runtime branch passes all of
# them. That blind spot became load-bearing on 2026-07-30, when `devices` left
# CLOSED_DELTA_PAGES for option-level gating — so 6 delegates to a real test suite
# that executes the gate.
#
# Run standalone or via release.sh (which refuses to cut a release on failure).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONSOLE="$ROOT/dashie-ha/frontend/console"
fail=0

say()  { echo "check-console-tree: $*"; }
bad()  { echo "check-console-tree: ❌ $*" >&2; fail=1; }

# ---- 1. Delta-only files must not exist here ------------------------------
# video-feeds*.js and preferences.js LEFT this list on 2026-07-31 — they moved
# into the published core (single-add-on collapse). They are now core-owned and
# MUST be present; listing them here would fail every release.
DELTA_FILES=(
  js/lib/subscribe-gate.js js/lib/subscription-status.js js/lib/dashboard-trial.js
  js/components/external-link-modal.js js/pages/account-plan.js
  js/pages/family.js
  js/pages/calendar.js js/pages/calendar-edit.js js/pages/calendar-options.js js/pages/calendar-add.js
  js/pages/chores.js js/pages/rewards.js js/pages/locations.js
  js/pages/photos.js js/pages/photos-upload.js js/pages/photos-album-edit.js
)
for f in "${DELTA_FILES[@]}"; do
  [ -e "$CONSOLE/$f" ] && bad "delta file present in public tree: $f"
done

# ---- 2. Paywall strings ----------------------------------------------------
# NOTE: credits purchase (buy-credits/credits-controls, price_1 ids) is the
# disclosed Dashie Cloud business model and stays public ON the credits
# surfaces; everything subscription/trial-shaped must be gone.
PAYWALL_PATTERNS=(
  'trial has ended' 'Subscribe to unlock' 'Purchase License' 'Start free trial'
  'Manage Subscription' 'Manage subscription' 'billing portal' 'subscribe.html'
)
for p in "${PAYWALL_PATTERNS[@]}"; do
  hits=$(grep -RIn --include='*.js' --include='*.html' -F "$p" "$CONSOLE" 2>/dev/null || true)
  [ -n "$hits" ] && bad $'paywall string "'"$p"$'" in public tree:\n'"$hits"
done

# ---- 3. Delta globals only in guarded form --------------------------------
DELTA_GLOBALS=(
  SubscribeGate SubscriptionStatus DashboardTrial ExternalLinkModal AccountPlan
  FamilyPage CalendarPage ChoresPage RewardsPage LocationsPage
  PhotosPage
)
for g in "${DELTA_GLOBALS[@]}"; do
  hits=$(grep -RIn --include='*.js' "\b$g\b" "$CONSOLE" 2>/dev/null \
    | grep -v "window\.$g?\." \
    | grep -v "typeof $g\b" \
    | grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)' \
    || true)
  [ -n "$hits" ] && bad $'unguarded delta-global "'"$g"$'":\n'"$hits"
done

# ---- 4. Script tags resolve ------------------------------------------------
for html in "$CONSOLE/index.html" "$CONSOLE/login/index.html"; do
  [ -f "$html" ] || continue
  base="$(dirname "$html")"
  while IFS= read -r src; do
    [[ "$src" == http* ]] && continue
    rel="${src%%\?*}"
    [ -f "$base/$rel" ] || bad "dangling <script src=\"$src\"> in ${html#$CONSOLE/}"
  done < <(grep -o 'script src="[^"]*"' "$html" | sed 's/script src="//; s/"$//')
done

# ---- 5. DELTA block empty --------------------------------------------------
if [ -f "$CONSOLE/index.html" ]; then
  block=$(sed -n '/DELTA-SCRIPTS-BEGIN/,/DELTA-SCRIPTS-END/p' "$CONSOLE/index.html")
  if echo "$block" | grep -q '<script'; then
    bad "DELTA-SCRIPTS block contains script tags — must be empty in the public tree"
  fi
  if ! echo "$block" | grep -q 'DELTA-SCRIPTS-BEGIN'; then
    bad "DELTA-SCRIPTS markers missing from index.html"
  fi
fi

# ---- 6. I7: behavioural gate on family-only OPTIONS ------------------------
# Everything above is static. This one executes feature-gate.js and asserts that
# every FAMILY_ONLY_OPTIONS entry is both refused by the gate AND actually
# consulted by a render path — registering a key does not gate it.
#
# Deliberately a HARD failure when deno is missing rather than a skip: a gate that
# quietly stops running is worse than no gate, and this is the same silent-skip
# shape that left the published console out of `lint:prompts` for three days.
if ! command -v deno >/dev/null 2>&1; then
  bad "deno not on PATH — cannot run the I7 (FAMILY_ONLY_OPTIONS) behavioural test.
       Install deno; do not skip this. It is the only check that can see a
       BEHAVIOURAL leak of a family option into the published build."
else
  if deno test --quiet --allow-read --allow-env "$ROOT/scripts/check-family-only-options.test.ts"; then
    say "✅ I7 — no FAMILY_ONLY_OPTIONS entry reachable in a published build"
  else
    bad "I7 FAILED — a family-only option is reachable in the published build (see above)"
  fi
fi

# ---- 7. Every published page's server routes actually EXIST ----------------
# 1–6 all look at the FRONTEND. None of them can see a page published ahead of
# the server that answers it — which is exactly what happened on 2026-07-30 when
# `devices` left CLOSED_DELTA_PAGES and its eleven /api/ha/* routes 404'd.
#
# Same hard-fail posture as 6: a missing runtime is a failure, not a skip.
if ! command -v node >/dev/null 2>&1; then
  bad "node not on PATH — cannot run the console↔server endpoint check.
       Install node; do not skip this. It is the only check that can see a page
       published ahead of its server routes."
else
  if node "$ROOT/scripts/check-console-endpoints.mjs"; then
    say "✅ every route the published console calls is served by the published server"
  else
    bad "console↔server endpoint check FAILED — see the unserved routes above.
       (The DASHIE_HA_ENDPOINTS_INTERIM escape was retired on 2026-07-31 when the
       server merge landed and this gate went green. It is not coming back: a page
       whose routes 404 must not reach a release.)"
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "check-console-tree: FAILED — the public console tree is not open-core clean." >&2
  exit 1
fi
say "✅ public console tree is open-core clean"
