#!/usr/bin/env bash
# Gate: the public console tree stays open-core clean.
#
# The console at chickadee/frontend/console is CANONICAL SOURCE (repo
# inversion, 2026-07-27) — the Dashie build vendors from here and overlays
# its private delta (paywall/subscription + family-product pages). This gate
# proves none of that delta leaks back into the public tree:
#
#   1. No Dashie-only module files present (they live only in the delta)
#   2. No paywall/subscription copy or Stripe price ids in js/html
#   3. Delta globals referenced ONLY in guarded form (window.X?. / typeof X)
#   4. Every <script src> in index.html + login/index.html resolves
#   5. The DELTA-SCRIPTS block is empty
#
# Run standalone or via release.sh (which refuses to cut a release on failure).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONSOLE="$ROOT/chickadee/frontend/console"
fail=0

say()  { echo "check-console-tree: $*"; }
bad()  { echo "check-console-tree: ❌ $*" >&2; fail=1; }

# ---- 1. Delta-only files must not exist here ------------------------------
DELTA_FILES=(
  js/lib/subscribe-gate.js js/lib/subscription-status.js js/lib/dashboard-trial.js
  js/components/external-link-modal.js js/pages/account-plan.js
  js/pages/devices.js js/pages/devices-rename.js js/pages/devices-camera.js
  js/pages/devices-events.js js/pages/devices-card.js js/pages/devices-detail.js
  js/pages/devices-detail-modals.js js/pages/devices-claim.js
  js/pages/family.js
  js/pages/calendar.js js/pages/calendar-edit.js js/pages/calendar-options.js js/pages/calendar-add.js
  js/pages/chores.js js/pages/rewards.js js/pages/locations.js
  js/pages/photos.js js/pages/photos-upload.js js/pages/photos-album-edit.js
  js/pages/video-feeds.js js/pages/video-feeds-edit.js js/pages/video-feeds-discover.js
  js/pages/preferences.js
)
for f in "${DELTA_FILES[@]}"; do
  [ -e "$CONSOLE/$f" ] && bad "delta file present in public tree: $f"
done

# ---- 2. Paywall strings ----------------------------------------------------
# NOTE: credits purchase (buy-credits/credits-controls, price_1 ids) is the
# disclosed Chickadee Cloud business model and stays public ON the credits
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
  DevicesPage FamilyPage CalendarPage ChoresPage RewardsPage LocationsPage
  PhotosPage VideoFeedsPage PreferencesPage
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

if [ "$fail" -ne 0 ]; then
  echo "check-console-tree: FAILED — the public console tree is not open-core clean." >&2
  exit 1
fi
say "✅ public console tree is open-core clean"
