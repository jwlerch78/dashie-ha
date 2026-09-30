/**
 * DeviceControlState — the single answer to "what state is this device control in?"
 *
 * 🔴 WHY THIS EXISTS. Before this holder, the same control was rendered from
 * THREE different sources in the devices UI, and the optimistic flip on click
 * was written into only one of them:
 *
 *   devices-card.js    `fresh?.metrics || device.metrics`   — worker feed, 5s
 *   devices-detail.js  `device.metrics`                     — Supabase row, 30s
 *   devices-card.js:626 `device.metrics?.controls?.lock`     — the same 30s row,
 *                                                             read directly, in
 *                                                             the same header as
 *                                                             a pill on the 5s feed
 *
 * `DevicesCard.toggleSwitch` wrote its optimistic value into `device.metrics`,
 * so on the CARD — which reads `fresh.metrics` — the write landed in an object
 * the card never reads and the pill was structurally incapable of responding to
 * a click. On the DETAIL page the write did land, and the 30s refresh then
 * replaced `device.metrics` wholesale with a row up to 30s stale, so the pill
 * flipped back, then forward again on the following refresh. One defect, two
 * opposite symptoms, which is why it read as two different bugs.
 *
 * Measured on the Office Fire TV Stick, 2026-09-30: HA's logbook shows the
 * clicks landing as real `switch.turn_on`/`turn_off` service calls, and the
 * device answers `getDarkMode`/`deviceInfo.isDarkMode` identically and steadily
 * across 45s of direct polls — so nothing was wrong with the command path or
 * the device. The console simply never acknowledged what it had already done.
 *
 * ⚠️ NOT dark-mode-specific, which is only where John noticed it.
 * `toggleSwitch` is shared by screen / camera / lock, and `_commitSlider` wrote
 * the same unread object for volume / brightness. Six controls, two surfaces.
 *
 * ── The contract ──────────────────────────────────────────────────────────
 *  metricsFor(device)      the ONE place the fresh-over-cached precedence lives
 *  resolve(device, role)   pending intent → else the device's own reported value
 *  note(deviceId, …)       record what we just asked the device for
 *
 * `resolve()` is self-settling: a pending value is dropped the moment a render
 * observes the device agreeing, and HELD over a poll that still disagrees. That
 * hold is what kills the oscillation — a stale poll can no longer walk back a
 * change the user just made. There is deliberately no separate settle() hook on
 * the poll path: a second call site is a second thing to forget (standing rule
 * 1 — share the first, don't add a mirror).
 *
 * 🔴 resolve() returns the RAW value, which may be `undefined`. Callers keep
 * their own defaults (`screen !== false`, `!!dark_mode`) because those defaults
 * are not the same for every role and centralising them here would invent a
 * state for a control the device has never reported.
 */
window.DeviceControlState = {

    /**
     * How long a pending value may outrank the device's own report.
     *
     * Two full 5s worker cycles plus slack. It is a BACKSTOP, not the normal
     * exit — the normal exit is observation. If real commands are found to take
     * longer than this, raise it; do not remove the warn below, which is the
     * only thing that makes a never-settling control visible at all.
     */
    PENDING_TTL_MS: 12000,

    /** `${deviceId}:${role}` -> { value, at } */
    _pending: {},

    /**
     * Fresh worker metrics (5s) beat the Supabase-cached row (30s).
     *
     * Every surface that renders a live control calls this instead of writing
     * the precedence itself. `_freshDeviceFor` already folds in the SSE
     * `_liveOverrides` layer, so this is also the only place that has to know
     * SSE exists.
     */
    metricsFor(device) {
        if (!device) return {};
        const fresh = (typeof DevicesPage !== 'undefined')
            ? DevicesPage._freshDeviceFor?.(device.device_id)
            : null;
        return fresh?.metrics || device.metrics || {};
    },

    /** The device's own reported value for a role, with no pending overlay. */
    observed(device, role) {
        return this.metricsFor(device).controls?.[role];
    },

    /**
     * The value a surface should render, and the value a click should compute
     * its target from. Settles or expires the pending entry as a side effect —
     * see the class comment for why that lives here rather than on the poll.
     */
    resolve(device, role) {
        const observed = this.observed(device, role);
        const key = this._key(device?.device_id, role);
        const p = this._pending[key];
        if (!p) return observed;
        if (observed === p.value) {          // the device agrees — intent fulfilled
            delete this._pending[key];
            return observed;
        }
        if (this._isExpired(p)) {
            this._warnUnsettled(key, p, observed);
            delete this._pending[key];
            return observed;
        }
        return p.value;                      // hold over a poll that is still stale
    },

    /**
     * Record what we just asked a device for, so the UI can acknowledge the
     * click immediately without lying about anything it hasn't been told.
     */
    note(deviceId, role, value) {
        this.sweep();
        this._pending[this._key(deviceId, role)] = { value, at: Date.now() };
    },

    /** Forget a pending intent — used when the command itself failed. */
    forget(deviceId, role) {
        delete this._pending[this._key(deviceId, role)];
    },

    /** True while a role is showing an unconfirmed value. */
    isPending(deviceId, role) {
        const p = this._pending[this._key(deviceId, role)];
        return !!p && !this._isExpired(p);
    },

    /**
     * Expire anything that has aged out, loudly.
     *
     * `resolve()` only sees roles a surface still renders, so a pending entry
     * for a role that stopped being drawn would otherwise age out in silence.
     * Called on every `note()`, which bounds how long a stray entry can sit
     * without bringing in a new call site on the render or poll path.
     */
    sweep() {
        for (const key of Object.keys(this._pending)) {
            const p = this._pending[key];
            if (!this._isExpired(p)) continue;
            this._warnUnsettled(key, p, undefined);
            delete this._pending[key];
        }
    },

    /** Test seam: drop all pending state. */
    reset() { this._pending = {}; },

    _key(deviceId, role) { return `${deviceId}:${role}`; },

    _isExpired(p) { return (Date.now() - p.at) >= this.PENDING_TTL_MS; },

    /**
     * 🔴 A pending value that expires SILENTLY is a second version of the bug
     * this file fixes: the pill quietly reverts, the user sees a click that did
     * not take, and nothing anywhere says why. Standing rule 2 — every drop is
     * loud, with a grep-able marker.
     */
    _warnUnsettled(key, p, observed) {
        const [deviceId, role] = key.split(':');
        const age = Math.round((Date.now() - p.at) / 1000);
        console.warn(
            `DROP: device control '${role}' on ${deviceId} never settled — asked for `
            + `${JSON.stringify(p.value)} ${age}s ago, device still reports `
            + `${JSON.stringify(observed)}. Reverting to the device's own value.`,
        );
    },
};
