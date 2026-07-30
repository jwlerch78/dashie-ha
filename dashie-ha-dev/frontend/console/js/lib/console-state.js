/* ============================================================
   ConsoleState — per-user Console UI state, persisted server-side
   ------------------------------------------------------------
   Backed by user_profiles.console_state (JSONB on the server). The
   shape is owned here; the backend just deep-merges patches.

   Current shape:
       {
         dismissed: {
           installs:   [<install_uuid>, ...],      // Add-banner install rows
           discovered: [<ha_device_id>, ...],      // Add-banner HA-discovered rows
           devices:    [<user_devices.device_id>], // Offline cards
         },
       }

   Future Console-wide UI prefs (collapsed-section state, etc.) can
   land here too without growing new edge fn ops.

   First-load migration: drains the legacy per-browser localStorage
   key (`dashie_devices_dismissed_claims`) into the server blob on
   the first authenticated load that finds the server-side state
   empty. After migration the LS key is cleared.

   Concurrency: dismiss()/restore() optimistically mutate local state
   and re-render via the caller, then fire-and-forget the server patch.
   Server failure is logged but not surfaced — the next page load
   will re-hydrate from the server source of truth.
   ============================================================ */

const ConsoleState = {
    _state: null,                  // hydrated server state
    _loaded: false,
    _loading: null,                // in-flight load() promise (idempotent)
    _LEGACY_LS_KEY: 'dashie_devices_dismissed_claims',

    /** Hydrate from the server. Idempotent — multiple callers can await
     *  the same in-flight load. */
    async load() {
        if (this._loaded) return this._state;
        if (this._loading) return this._loading;
        this._loading = (async () => {
            try {
                const result = await DashieAuth.dbRequest('get_console_state', {});
                this._state = result.state || {};
            } catch (e) {
                console.warn('[ConsoleState] load failed, defaulting to empty:', e.message);
                this._state = {};
            }
            this._normalize();
            await this._migrateLegacyDismissals();
            this._loaded = true;
            return this._state;
        })();
        try {
            return await this._loading;
        } finally {
            this._loading = null;
        }
    },

    _normalize() {
        if (!this._state || typeof this._state !== 'object') this._state = {};
        if (!this._state.dismissed || typeof this._state.dismissed !== 'object') this._state.dismissed = {};
        for (const k of ['installs', 'discovered', 'devices']) {
            if (!Array.isArray(this._state.dismissed[k])) this._state.dismissed[k] = [];
        }
    },

    /** Synchronous read — returns a fresh Set so callers can't mutate
     *  internal state by accident. Returns empty Set if not loaded yet. */
    dismissedSet(kind) {
        if (!this._state?.dismissed) return new Set();
        return new Set(this._state.dismissed[kind] || []);
    },

    /** True if `id` is dismissed under `kind`. */
    isDismissed(kind, id) {
        return (this._state?.dismissed?.[kind] || []).includes(id);
    },

    /** Add ids to a dismissed bucket. Optimistic — local mutation
     *  is immediate; server patch is fire-and-forget. */
    dismiss(kind, ids) {
        this._normalize();
        const set = new Set(this._state.dismissed[kind]);
        const arr = Array.isArray(ids) ? ids : [ids];
        let changed = false;
        for (const id of arr) {
            if (id && !set.has(id)) { set.add(id); changed = true; }
        }
        if (!changed) return;
        const next = [...set];
        this._state.dismissed[kind] = next;
        this._save({ dismissed: { [kind]: next } });
    },

    /** Remove ids from a dismissed bucket. Optimistic same as dismiss(). */
    restore(kind, ids) {
        this._normalize();
        const set = new Set(this._state.dismissed[kind]);
        const arr = Array.isArray(ids) ? ids : [ids];
        let changed = false;
        for (const id of arr) {
            if (set.delete(id)) changed = true;
        }
        if (!changed) return;
        const next = [...set];
        this._state.dismissed[kind] = next;
        this._save({ dismissed: { [kind]: next } });
    },

    /** Fire-and-forget server patch. Failures are logged. */
    async _save(patch) {
        try {
            await DashieAuth.dbRequest('update_console_state', { patch });
        } catch (e) {
            console.error('[ConsoleState] save failed:', e);
        }
    },

    /** Drain legacy per-browser dismissals (localStorage) into the server
     *  state on first load. Skipped if server already has any dismissals
     *  (we trust the newer cross-browser data over an older local list). */
    async _migrateLegacyDismissals() {
        let raw;
        try {
            raw = localStorage.getItem(this._LEGACY_LS_KEY);
        } catch (e) { return; }
        if (!raw) return;

        let uids;
        try { uids = JSON.parse(raw); } catch (e) {
            try { localStorage.removeItem(this._LEGACY_LS_KEY); } catch (_) {}
            return;
        }
        if (!Array.isArray(uids) || uids.length === 0) {
            try { localStorage.removeItem(this._LEGACY_LS_KEY); } catch (_) {}
            return;
        }

        const total = (this._state.dismissed.installs.length
                     + this._state.dismissed.discovered.length
                     + this._state.dismissed.devices.length);
        if (total > 0) {
            try { localStorage.removeItem(this._LEGACY_LS_KEY); } catch (_) {}
            return;
        }

        const installs = [], discovered = [];
        for (const uid of uids) {
            if (typeof uid !== 'string') continue;
            if (uid.startsWith('ha:')) discovered.push(uid.slice(3));
            else installs.push(uid);
        }
        this._state.dismissed.installs = installs;
        this._state.dismissed.discovered = discovered;
        try {
            await DashieAuth.dbRequest('update_console_state', {
                patch: { dismissed: { installs, discovered } }
            });
            console.log('[ConsoleState] migrated legacy LS dismissals → server',
                { installs: installs.length, discovered: discovered.length });
            try { localStorage.removeItem(this._LEGACY_LS_KEY); } catch (_) {}
        } catch (e) {
            console.warn('[ConsoleState] LS migration save failed, will retry next load:', e.message);
        }
    },
};

window.ConsoleState = ConsoleState;
