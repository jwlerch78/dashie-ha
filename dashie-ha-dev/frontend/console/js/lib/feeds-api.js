/* ============================================================
   Feeds API — thin wrapper over the add-on's /api/feeds/* routes,
   which proxy to the HA integration's household feed registry
   (custom_components/dashie/feed_registry.py).

   Add-on mode only — every method throws when the Console isn't
   running inside the HA add-on (callers gate UI on
   DashieAuth.isAddonMode first, so this is a backstop).
   ============================================================ */

const FeedsApi = {
    async _request(path, opts = {}) {
        if (!DashieAuth.isAddonMode) {
            throw new Error('Video feed management requires the HA add-on');
        }
        const resp = await fetch(DashieAuth._addonUrl(path), {
            method: opts.method || 'GET',
            headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
            body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
        const body = await resp.json().catch(() => null);
        if (!resp.ok) {
            throw new Error(body?.message || body?.error || `HTTP ${resp.status}`);
        }
        return body;
    },

    /** Returns {feeds: {feedId: feed}} — annotated with available,
     *  rtsp_url, is_frigate_camera, frigate_camera_name. */
    async list() {
        return this._request('/api/feeds');
    },

    /** Create or update. `feed` uses the registry's canonical field names
     *  (label, camera_entity_id, triggers, …). Returns {feed}. */
    async save(feed) {
        return this._request('/api/feeds', { method: 'POST', body: feed });
    },

    /** Returns {deleted: feedId}. */
    async remove(feedId) {
        return this._request(`/api/feeds/${encodeURIComponent(feedId)}`, { method: 'DELETE' });
    },

    /** Returns {cameras: [...names]} — empty when Frigate is unreachable. */
    async frigateCameras() {
        return this._request('/api/feeds/meta/frigate-cameras');
    },

    /** Returns {cameras: [{entity_id, name, state}], triggers: [...]}. */
    async entities() {
        return this._request('/api/feeds/meta/entities');
    },

    /** Returns {cameras: [{entity_id, label, source, frigate_camera,
     *  snapshot_url}]} — cameras the household could add as feeds (HA +
     *  Frigate), minus ones already added and ones that can't stream now. */
    async discover() {
        return this._request('/api/feeds/meta/discover');
    },
};
