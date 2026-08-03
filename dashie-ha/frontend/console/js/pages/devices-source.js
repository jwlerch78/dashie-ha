/**
 * DevicesSource — where the Devices page gets its roster.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * The page has always fetched `list_devices` from Supabase. On the account-less
 * add-on console there IS no Supabase and no account, so the page's DEFAULT
 * screen was permanently "No devices registered yet." — with the roster missing
 * for one reason (no account) and the liveness data missing for another (the
 * worker used to bail before building it).
 *
 * The box already knows its devices: Home Assistant's entity registry lists them
 * and the add-on's worker polls their state. `/api/ha/status` is open by design
 * and carries `lastRun.freshDevices`, so the local roster needs no new endpoint
 * and no new store — see the spec, `20260802_CHICKADEE_DEVICES_SURFACE.md`.
 *
 * ── WHY AN ADAPTER AND NOT `if (isLocalMode)` AT EACH FETCH ──────────────────
 *
 * There are four `list_devices` call sites (initial load, auto-refresh, the
 * settings-sync re-fetch, and the claim path's sibling refresh). Four branches is
 * four chances to miss one, and a missed one is SILENT: it returns nothing on an
 * account-less box and the page simply looks empty — which is the exact failure
 * this whole change exists to remove. One holder, asked once.
 *
 * 🔴 It returns the SAME SHAPE `list_devices` returns, so the page keeps a single
 * rendering path. Fields with no local equivalent are `null` rather than faked:
 * `last_seen_at` is a persisted Supabase column, and inventing one would resurrect
 * the 30-day Archive bucket as a lie about data the box does not have.
 */
const DevicesSource = {

    /** How many poll intervals may elapse before the whole poll is stale.
     *  🔴 ONE HOLDER — the page must not restate a threshold. Expressed in poll
     *  INTERVALS, not seconds: a bare "90s" silently means "everything is
     *  offline" the day someone slows the poll down. */
    STALE_AFTER_POLLS: 3,

    /** Is this console running without an account (add-on, published, unauthed)? */
    _isLocal() {
        return typeof DashieAuth !== 'undefined' && DashieAuth.isLocalMode === true;
    },

    /**
     * Fetch the roster. Returns `{ devices, local }`.
     * `local: true` tells the page to suppress account-only affordances.
     */
    async fetch() {
        if (!this._isLocal()) {
            const result = await DashieAuth.dbRequest('list_devices', { tv_only: false, include_inactive: true });
            return { devices: result.devices || result.data || [], local: false };
        }
        return { devices: await this._fetchLocal(), local: true };
    },

    /** Build the roster from the add-on's own poll. */
    async _fetchLocal() {
        let status = null;
        try {
            const resp = await fetch(DashieAuth._addonUrl('/api/ha/status'), { cache: 'no-store' });
            if (resp.ok) status = await resp.json();
        } catch (e) {
            console.warn('[DevicesSource] /api/ha/status unavailable:', e.message);
        }
        const fresh = status?.lastRun?.freshDevices || [];
        // 🔴 Devices whose identity could not be resolved are DROPPED, loudly.
        // They cannot be keyed, rendered or acted on, and a card with no id is a
        // card whose buttons address the wrong device. This should not happen —
        // ha-metrics recovers the id from the entity registry even when a device
        // is offline — so if it fires, that recovery has regressed.
        const usable = fresh.filter((d) => {
            if (d.device_id) return true;
            console.warn(`DROP: local device with no resolvable device_id (slug=${d.slug || '?'}) — omitted from the roster`);
            return false;
        });
        const online = this._pollIsFresh(status);
        return usable.map((d) => ({
            device_id: d.device_id,
            device_name: d.device_name || d.slug || 'Device',
            // No local equivalent — see the header. Null, never invented.
            device_type: null,
            install_id: null,
            last_seen_at: null,
            settings: {},
            device_metadata: {},
            // The page's own _isLive() reads freshDevices directly, so this is
            // for the local grouping only: a device is online when it reported
            // usable data AND the poll that said so is recent. Both halves
            // matter — without the second, a stopped worker would leave every
            // device looking permanently online.
            _local_online: !!d.has_live_data && online,
        }));
    },

    /** Is the worker's last poll recent enough to believe? */
    _pollIsFresh(status) {
        const at = status?.lastRun?.at;
        const intervalMs = Number(status?.intervalMs);
        if (!at || !Number.isFinite(intervalMs) || intervalMs <= 0) return false;
        return (Date.now() - new Date(at).getTime()) <= this.STALE_AFTER_POLLS * intervalMs;
    },
};
