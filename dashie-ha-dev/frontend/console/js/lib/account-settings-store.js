/* ============================================================
   AccountSettingsStore — ONE copy of the household's account settings
   for everything on the Devices page.
   ------------------------------------------------------------
   WHY THIS EXISTS (2026-09-20, P4a)

   The device CARD needs the household defaults, because the compact card marks
   every tile whose value differs from the household with a dot. The device
   MODAL already needed them, and had its own `_accountSettings` cache.

   🔴 The obvious move — give the card its own fetch — is the defect, not the
   fix. Two caches of one household on one page drift apart the moment one
   refreshes and the other does not, and the symptom is the DOT being wrong:
   a card claiming a device differs from a household value it actually matches.
   That reads as a UI bug and gets hunted in the renderer, which is the wrong
   floor. One fetch, one cache, one source.

   ⚠️ `get()` returns null until the load resolves. Callers must treat null as
   "not known yet" and NOT as "no overrides" — a falsy test there marks every
   tile as matching the household and the dots silently never appear.
   ============================================================ */

const AccountSettingsStore = {
    _data: null,        // null = not loaded yet; {} = loaded and genuinely empty
    _loading: false,

    /** The account settings, or null when they are not known yet. */
    get() { return this._data; },

    /** True once a load has resolved — including to `{}` on an account-less box. */
    get loaded() { return this._data !== null; },

    /**
     * Lazy-load `user_settings` the first time anything on the page needs an
     * account-level field, and re-render when it resolves.
     *
     * 🔴 Feature-detect `loadUserSettings`, because this is called from RENDER
     * paths. It does not exist on every DashieAuth: the ACCOUNT-LESS add-on
     * console runs a local shim with no user_settings at all. This guard is
     * carried over verbatim in intent from devices-detail-modals.js, where its
     * absence once threw from a render path and took out the whole Devices
     * detail page on the published HA edition — a function with zero callers
     * that acquired its first one. `lint:devices-surface` leg 3 catches it by
     * rendering the page for real.
     *
     * Absent → cache `{}`, exactly like the .catch() below. An account-less box
     * HAS no account defaults, so `{}` is the true answer there, not a degraded
     * one.
     */
    ensure() {
        if (this._data !== null || this._loading) return;
        if (typeof DashieAuth?.loadUserSettings !== 'function') {
            this._data = {};
            return;
        }
        this._loading = true;
        DashieAuth.loadUserSettings().then((s) => {
            this._data = s || {};
            this._loading = false;
            App.renderPage();
        }).catch(() => {
            this._data = {};
            this._loading = false;
        });
    },

    /** Test/rehydration seam. Also the setter behind DevicesDetailModals._accountSettings. */
    set(value) { this._data = value; },

    /** Drop the cache so the next ensure() refetches (account swap, sign-out). */
    reset() { this._data = null; this._loading = false; },
};

window.AccountSettingsStore = AccountSettingsStore;
