#!/usr/bin/env node
/**
 * check-devices-liveness — the Devices page's Online section must be REACHABLE
 * on the non-HA (family) lane, and must not have become sloppier on the HA one.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 *
 * `_isLive()` used to have exactly two inputs and BOTH were fed only by the
 * Home Assistant add-on: the worker's poll (`has_live_data`, add-on mode only)
 * and `user_devices.metrics_updated_at`, which is written by exactly one op in
 * the whole estate — `update_device_metrics`, whose only caller is
 * `dashie-ha/server/ha-worker.js`.
 *
 * So on an account with no Home Assistant, `_isLive` could not return true for
 * any device, ever. Measured against prod on 2026-08-17: **1 of 207**
 * `user_devices` rows had a non-null `metrics_updated_at`. Every family user
 * saw "ONLINE (0) — No online devices right now" permanently, with their live
 * tablet listed in the Offline section underneath it.
 *
 * 🔴 Nothing was red. The section rendered, the query ran, the data was
 * truthful. It was a component-level green over an outcome-level dead surface —
 * which is exactly the class of defect a static check cannot see, so this gate
 * is DRIVEN: it evaluates the real `devices.js` and calls the real `_isLive`.
 *
 * ── THE CONTROLS ────────────────────────────────────────────────────────────
 *
 * Leg 1 is the repair. Legs 2-4 are what stop it being a repair that quietly
 * costs something:
 *
 *   • leg 2 is a POSITIVE CONTROL for the HA lane — metrics fresh still means
 *     live, at 90-second precision. Without it, "family devices show online"
 *     could be satisfied by a function that returns true for everything.
 *   • leg 3 is the one that matters most and is easy to get wrong. When metrics
 *     are PRESENT but STALE the add-on is actively watching and reporting the
 *     device gone; the 35-minute heartbeat window must NOT override the
 *     90-second one and resurrect it. The fallback is gated on metrics being
 *     ABSENT, not on them being old.
 *   • leg 4 keeps the fallback honest in the other direction — a genuinely
 *     departed family device (heartbeat older than the window) is not live.
 *
 * Leg 5 pins the cross-repo constant. HEARTBEAT_LIVE_SECONDS is derived from
 * the DASHBOARD's heartbeat cadence, which lives in another repo entirely
 * (`dashieapp_staging/js/core/initialization/device-registration.js`,
 * `startDeviceHeartbeat(..., intervalMs = 30 * 60 * 1000)`). A window shorter
 * than that cadence is unsatisfiable by construction and re-empties the Online
 * section — the original defect, restored, silently. This gate cannot read the
 * other repo, so it asserts the invariant it CAN see (window > one beat, and
 * not absurdly wide) and names the coupling for whoever trips it.
 *
 * ⚠️ What this gate is blind to: it proves `_isLive`'s classification, not that
 * a heartbeat ever arrives. If the dashboard stops writing `last_seen_at`, every
 * leg here still passes and the Online section is empty again for a different
 * reason. The heartbeat's own liveness is not observable from this repo.
 *
 * Exit 0 = every leg passes, 1 = a violation, 2 = cannot check.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
// Defaults to the canonical source. The optional argument exists because the
// defect this gate repairs is a FAMILY-lane defect, and the family console is a
// different tree reached through `dashie-console/scripts/vendor-core.sh` — so a
// gate that only ever ran here would be green about a file the affected users
// do not load. vendor-core passes the vendored copy. Same class of mistake as
// gating the route instead of delivering the feature behind it.
const FILE = process.argv[2]
    ? resolve(process.argv[2])
    : join(HERE, '..', 'dashie-ha', 'frontend', 'console', 'js', 'pages', 'devices.js');
if (!existsSync(FILE)) {
    console.error(`check-devices-liveness: cannot check — devices.js not found at ${FILE}`);
    process.exit(2);
}

// Only the collaborators `_isLive` and module load actually reach. A stub that
// is too generous hides a missing dependency; one too thin fails to load for
// reasons that read like findings.
const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: { title: '', querySelector: () => null, visibilityState: 'visible' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    DashieAuth: { isAddonMode: false, isLocalMode: false, async dbRequest() { return { devices: [] }; } },
    FeatureGate: { isAddonMode: () => false, isPageEnabled: () => true },
    ConsoleState: { dismiss() {}, restore() {}, isDismissed: () => false },
    Toast: { success() {}, error() {}, friendly: (e) => String(e) },
    App: { renderPage() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => { throw new Error('no network in this harness'); },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
try {
    vm.runInContext(readFileSync(FILE, 'utf8'), ctx, { filename: FILE });
} catch (e) {
    console.error(`check-devices-liveness: cannot check — devices.js did not evaluate: ${e.message}`);
    process.exit(2);
}

// Top-level `const` in a vm context is a LEXICAL binding and never becomes a
// property of the sandbox — reading `sandbox.DevicesPage` silently yields
// undefined. Evaluate an expression in the same context instead.
let DP;
try {
    DP = vm.runInContext('DevicesPage', ctx);
} catch (e) {
    console.error(`check-devices-liveness: cannot check — DevicesPage did not bind: ${e.message}`);
    process.exit(2);
}
if (!DP || typeof DP._isLive !== 'function') {
    console.error('check-devices-liveness: cannot check — DevicesPage._isLive did not load');
    process.exit(2);
}

let failed = 0;
function check(name, ok, detail, why) {
    if (ok) { console.log(`✅ ${name}`); return; }
    failed++;
    console.error(`❌ ${name}\n     ${detail}\n     why it matters: ${why}`);
}

const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();

// Non-add-on account lane: no worker, no local mode. This is the family console.
DP._localMode = false;
DP._haStatus = null;

const LIVE = DP.LIVE_THRESHOLD_SECONDS;
// ⚠️ Resolved defensively, and this is not paranoia — it is what the gate did on
// its own verify-red run. Against the pre-fix devices.js the constant did not
// exist, `ago(undefined + 120)` produced an Invalid Date, and the gate DIED
// mid-run with a RangeError after reporting three legs. It exited non-zero, so
// it was "red", but a crashed gate does not tell you WHICH legs it never
// reached — and the next person reads a stack trace instead of a finding.
// A missing constant is itself the violation; say so, and let the rest run.
const HB_RAW = DP.HEARTBEAT_LIVE_SECONDS;
const HB_OK = typeof HB_RAW === 'number' && Number.isFinite(HB_RAW) && HB_RAW > 0;
const HB = HB_OK ? HB_RAW : 35 * 60;   // placeholder so the dependent legs still report

// ── leg 1 — THE REPAIR: a heartbeating family device is live ────────────────
check(
    'leg 1 — family device with a recent heartbeat and NO metrics reads live',
    DP._isLive({ device_id: 'fam-1', metrics_updated_at: null, last_seen_at: ago(60) }) === true,
    'a device whose only signal is user_devices.last_seen_at was classified not-live',
    'metrics_updated_at is written only by the HA add-on worker (1 of 207 prod rows had one). '
        + 'Without a heartbeat fallback the Online section is unreachable for every non-HA '
        + 'account — it renders "No online devices right now" while the tablet is on the wall.',
);

// ── leg 2 — POSITIVE CONTROL: the HA lane still works, at its own precision ─
check(
    'leg 2 — HA device with fresh metrics still reads live (positive control)',
    DP._isLive({ device_id: 'ha-1', metrics_updated_at: ago(10), last_seen_at: ago(10) }) === true,
    'a device with metrics inside LIVE_THRESHOLD_SECONDS was classified not-live',
    'without this control, leg 1 would also pass against an _isLive that returns true for '
        + 'everything. A repair that cannot fail is not a repair.',
);

// ── leg 3 — the regression the fallback could easily have caused ────────────
check(
    'leg 3 — HA device with STALE metrics is NOT resurrected by the heartbeat window',
    DP._isLive({ device_id: 'ha-2', metrics_updated_at: ago(LIVE * 4), last_seen_at: ago(60) }) === false,
    'a device the add-on reports as gone was classified live off its heartbeat instead',
    'when metrics are present the add-on is actively watching at 90-second precision. Letting a '
        + '35-minute window override it would make HA users\' Online section stale by half an '
        + 'hour — trading one lane\'s bug for the other lane\'s.',
);

// ── leg 4 — the fallback stays honest in the other direction ────────────────
check(
    'leg 4 — family device whose heartbeat is older than the window is NOT live',
    DP._isLive({ device_id: 'fam-2', metrics_updated_at: null, last_seen_at: ago(HB + 120) }) === false,
    'a device that stopped heartbeating was still classified live',
    'a fallback that never expires is not liveness, it is a device list. The Offline section '
        + 'exists precisely to carry these.',
);

check(
    'leg 4b — family device that has NEVER been seen is not live',
    DP._isLive({ device_id: 'fam-3', metrics_updated_at: null, last_seen_at: null }) === false,
    'a device with no timestamps at all was classified live',
    'claim_devices writes user_devices stubs with no last_seen_at. A stub is not a live device.',
);

// ── leg 5 — the cross-repo constant ────────────────────────────────────────
// The dashboard's startDeviceHeartbeat default. This gate cannot read the other
// repo; if the cadence there changes, this literal is the thing to change too.
const DASHBOARD_HEARTBEAT_SECONDS = 30 * 60;
check(
    'leg 5 — the heartbeat window can actually be satisfied by the dashboard\'s cadence',
    HB_OK && HB_RAW > DASHBOARD_HEARTBEAT_SECONDS && HB_RAW <= DASHBOARD_HEARTBEAT_SECONDS * 3,
    HB_OK
        ? `HEARTBEAT_LIVE_SECONDS=${HB_RAW} against a ${DASHBOARD_HEARTBEAT_SECONDS}s dashboard beat`
        : `HEARTBEAT_LIVE_SECONDS is ${HB_RAW === undefined ? 'not declared' : String(HB_RAW)} — legs 4/4b above ran against a ${HB}s placeholder, not the shipping value`,
    'a window at or below the beat interval is unsatisfiable by construction — the Online section '
        + 'empties again and every other leg here still passes. If you changed '
        + 'startDeviceHeartbeat\'s intervalMs in dashieapp_staging '
        + '(js/core/initialization/device-registration.js), change DASHBOARD_HEARTBEAT_SECONDS here '
        + 'and HEARTBEAT_LIVE_SECONDS in devices.js together. See .reference/JS_KOTLIN_CONTRACTS.md.',
);

if (failed) {
    console.error(`\ncheck-devices-liveness: ${failed} violation(s)`);
    process.exit(1);
}
console.log('\ncheck-devices-liveness: all legs pass');
