// kiosk-overlay/js/sidebar-back-focus.test.js
//
// Board D-067 — in kiosk mode the Fire TV remote had no way back into Dashie.
//
// The defect was never that revealing failed; it was that revealing is not focusing, and the
// kiosk path only ever revealed. So the legs that matter assert WHICH bridge call is made,
// not that something happened.

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { focusSidebarFromBack } from './sidebar-back-focus.js';

const noopLog = { warn() {} };

/** A fake DashieNative that records which methods were called. */
function fakeNative({ focus = false, reveal = false } = {}) {
  const calls = [];
  const n = {};
  if (focus) n.focusSidebar = () => calls.push('focusSidebar');
  if (reveal) n.revealNativeSidebar = () => calls.push('revealNativeSidebar');
  return { native: n, calls };
}

// ── The fix ──────────────────────────────────────────────────────────────────

Deno.test('prefers focusSidebar when the bridge offers it', () => {
  const { native, calls } = fakeNative({ focus: true, reveal: true });
  assertEquals(focusSidebarFromBack(native, noopLog), 'focus');
  assertEquals(calls, ['focusSidebar']);
});

Deno.test('does NOT also reveal — revealing without focusing is the bug', () => {
  // The whole defect is a strip that appears and cannot be steered. Calling both would
  // re-introduce it on any build where reveal wins the race.
  const { native, calls } = fakeNative({ focus: true, reveal: true });
  focusSidebarFromBack(native, noopLog);
  assertEquals(calls.includes('revealNativeSidebar'), false);
});

// ── Old-APK compatibility (CLAUDE.md: feature-detect every new bridge method) ─

Deno.test('falls back to revealNativeSidebar on an APK without focusSidebar', () => {
  // Webapp JS ships instantly; APKs ship when the user installs. An old APK has no
  // focusSidebar, and BACK must still do what it does today rather than throw.
  const { native, calls } = fakeNative({ focus: false, reveal: true });
  assertEquals(focusSidebarFromBack(native, noopLog), 'reveal');
  assertEquals(calls, ['revealNativeSidebar']);
});

Deno.test('no bridge at all: does not throw, and says so loudly', () => {
  // Standing rule 2 — a BACK that silently does nothing is the symptom of this very row.
  let warned = '';
  const log = { warn: (m) => { warned = String(m); } };
  assertEquals(focusSidebarFromBack(undefined, log), 'none');
  assertEquals(warned.includes('DROP:'), true);
});

Deno.test('a bridge missing BOTH methods is also a loud drop, not a crash', () => {
  let warned = '';
  const log = { warn: (m) => { warned = String(m); } };
  assertEquals(focusSidebarFromBack({}, log), 'none');
  assertEquals(warned.includes('DROP:'), true);
});

// ── Source pin: the kiosk back handler must actually USE this ────────────────
//
// ⚠️ The legs above would all pass while the Fire TV stayed unsteerable, because the defect
// was that branch 4 never called the focusing path. This pins that call.
//
// 📌 Pinning the CALL, not the symbol, deliberately — trap 9b (2026-09-17): a pin that
// searches a region for a bare identifier is satisfied by a comment or a log line that
// happens to name it, and survives the very injection it exists to catch.

Deno.test('kiosk-shell BACK routes through focusSidebarFromBack', async () => {
  const src = await Deno.readTextFile('kiosk-overlay/js/kiosk-shell.js');
  const fn = src.slice(src.indexOf('window.dashieHandleBack = function()'));
  const body = fn.slice(0, fn.indexOf('\n};'));

  assertEquals(
    body.includes('focusSidebarFromBack('), true,
    'branch 4 must CALL focusSidebarFromBack — naming it in a comment is not wiring (D-067)'
  );
  assertEquals(
    body.includes('DashieNative.revealNativeSidebar()'), false,
    'branch 4 must not call revealNativeSidebar directly any more; the helper owns that fallback'
  );
});
