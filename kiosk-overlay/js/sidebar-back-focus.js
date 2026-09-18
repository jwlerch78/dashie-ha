// kiosk-overlay/js/sidebar-back-focus.js
//
// What BACK does in kiosk mode once nothing else has claimed it.
//
// ## Why this is its own function (board D-067)
//
// On a Fire TV in kiosk mode the remote had no way back into Dashie: UP/DOWN/RIGHT/MENU
// pass through to the HA page, and LEFT reached `dashieHandleBack`'s last branch, which
// called `DashieNative.revealNativeSidebar()`. That lands on
// `NativeSidebarController.revealForOnboardingTip()`, which makes the strip VISIBLE and sets
// `isVisible = true` — and **never requests focus**. So the strip appeared and the remote
// still could not steer: ten LEFT presses in eight seconds, no focus (O's capture, 09-17).
//
// 🔑 The focusing entry point already exists and is already on the bridge:
// `DashieNative.focusSidebar()` → `DashieJSBridge:1441` → `JsBridgeCoreCallbacks:63` →
// `NativeSidebarController.focusSidebar()`, which does `if (!isVisible) showOverlay()` and
// then `buttons.last().requestFocus()`. It needs no Kotlin change.
//
// ⚠️ **NOT a regression, though it was reported as one.** `focusSidebar` appears nowhere in
// `kiosk-overlay/` and never has — `git log -S focusSidebar -- kiosk-overlay/` is empty over
// all history, and the only JS callers are `js/modules/layout/layout-canvas-input-handler.js`,
// the FULL-MODE dashboard handler. Kiosk has only ever revealed without focusing.
// ✅ AND THE REPORTER'S RECOLLECTION WAS CORRECT — hypothesis his, mechanism found 2026-09-17,
// so this no longer rests on an inference about what he saw. Three true things that do not
// conflict:
//   • dashboard + non-amazon → BACK focuses the sidebar. Live today:
//     `js/modules/layout/layout-canvas-input-handler.js:411-419` — nothing focused inside a
//     widget ⇒ yield to the sidebar ⇒ `DashieNative.focusSidebar()`. This is what he remembers.
//   • dashboard + amazon → an exit dialog instead. Removed deliberately by `c44559db`
//     (2026-06-28, "route Fire TV BACK through onBackPressedDispatcher"), whose own comment
//     names the thing it was killing: *"BACK forwards straight to JS handleRemoteInput →
//     'escape' action → sidebar focus, which is the loop Amazon's reviewer flagged"*. Gated
//     `BuildConfig.FLAVOR == "amazon"`, after Amazon's vc171 functionality review.
//   • kiosk + ANY flavor → reveal without focus. Never inherited. That is this defect.
// 📌 So his `.41` runs the STAGING flavor, the amazon gate does not apply there, and what he
// remembers working is the dashboard path — which is still working.
//
// This is the third instance of one shape found in a day — a capability the main path grew
// and a second path never inherited (see also the family-card rotator never reaching the
// participants filter, and HA-Assist calling a TTS leaf the cascade's router had outgrown).

/**
 * Hand BACK to the native sidebar, preferring the call that actually takes focus.
 *
 * @param {object|undefined} native - the `DashieNative` bridge object, or undefined.
 * @param {{warn: Function}} [log] - injected for tests.
 * @returns {'focus'|'reveal'|'none'} which path was taken — returned so callers and tests can
 *   assert the choice without spying on the bridge.
 */
export function focusSidebarFromBack(native, log = console) {
  // Preferred: the call that shows the strip AND puts focus in it. Feature-detected because
  // webapp JS ships instantly while an APK ships when the user installs it, so an older APK
  // may not have this method (CLAUDE.md, webapp/native compatibility).
  if (native && typeof native.focusSidebar === 'function') {
    native.focusSidebar();
    return 'focus';
  }

  // Old APK: reveal is all that is available. Strictly today's behaviour — the strip appears
  // without focus — rather than a throw.
  if (native && typeof native.revealNativeSidebar === 'function') {
    native.revealNativeSidebar();
    return 'reveal';
  }

  // No usable bridge at all. Loud, because BACK silently doing nothing is the symptom this
  // whole row is about (CLAUDE.md standing rule 2 — no silent drops).
  log.warn('[KioskShell] DROP: BACK could not reach the native sidebar — no bridge method available');
  return 'none';
}
