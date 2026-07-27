/* ============================================================
   Video Feed Discovery — "Discover cameras" picker modal.

   Lists cameras the household could add as feeds, from the
   integration's GET /api/dashie/feeds/discover (via
   FeedsApi.discover): every streamable HA/Frigate camera that
   isn't already a feed. One click adds it with sensible defaults
   (no trigger — on-demand; edit afterward to add motion alerts).

   Rendered from VideoFeedsPage.render(); state lives here, mirroring
   the VideoFeedsEdit modal pattern.
   ============================================================ */

const VideoFeedsDiscover = {
    /** null when closed; else { loading, error, candidates: [], adding: {} } */
    _open: null,

    open() {
        this._open = { loading: true, error: null, candidates: [], adding: {} };
        this._fetch();
        App.renderPage();
    },

    close() {
        this._open = null;
        App.renderPage();
    },

    _maybeCloseBackdrop(e) {
        if (e.target === e.currentTarget) this.close();
    },

    async _fetch() {
        if (!this._open) return;
        this._open.loading = true;
        this._open.error = null;
        App.renderPage();
        try {
            const result = await FeedsApi.discover();
            if (!this._open) return;
            this._open.candidates = result.cameras || [];
        } catch (e) {
            console.error('[VideoFeedsDiscover] discover failed:', e);
            if (this._open) this._open.error = e.message || String(e);
        } finally {
            if (this._open) this._open.loading = false;
            App.renderPage();
        }
    },

    async add(entityId) {
        const m = this._open;
        if (!m) return;
        const cam = m.candidates.find(c => c.entity_id === entityId);
        if (!cam || m.adding[entityId]) return;
        m.adding[entityId] = true;
        App.renderPage();
        try {
            // label + camera_entity_id is enough — the registry fills the rest
            // from DEFAULT_FEED (no triggers, on-demand) and auto-detects Frigate.
            await FeedsApi.save({ label: cam.label, camera_entity_id: cam.entity_id });
            Toast.info(`Added "${cam.label}"`);
            // Drop it from the picker and refresh the feed list behind us.
            m.candidates = m.candidates.filter(c => c.entity_id !== entityId);
            await VideoFeedsPage.refresh();
        } catch (e) {
            console.error('[VideoFeedsDiscover] add failed:', e);
            Toast.error(`Add failed: ${e.message}`);
            delete m.adding[entityId];
        } finally {
            App.renderPage();
        }
    },

    render() {
        const m = this._open;
        if (!m) return '';
        const esc = VideoFeedsPage._escape.bind(VideoFeedsPage);

        let body;
        if (m.loading) {
            body = `<div style="color: var(--text-muted); font-size: 13px; padding: 24px 0; text-align: center;">Scanning Home Assistant for cameras…</div>`;
        } else if (m.error) {
            body = `<div style="background: rgba(220,38,38,0.08); color: #dc2626; border-radius: 6px; padding: 8px 12px; font-size: 13px;">${esc(m.error)}</div>`;
        } else if (!m.candidates.length) {
            body = `
                <div class="empty-state" style="margin: 24px 0;">
                    <div class="empty-state-icon">✅</div>
                    <div class="empty-state-text">No new cameras to add.</div>
                    <div style="color: var(--text-muted); font-size: 13px; margin-top: 8px; max-width: 380px; margin-left: auto; margin-right: auto;">
                        Every camera that can stream right now is already a feed. Cameras
                        that are turned off show up here once they come online.
                    </div>
                </div>`;
        } else {
            body = `<div class="list-container">${m.candidates.map(c => this._row(c, esc)).join('')}</div>`;
        }

        return `
            <div onclick="VideoFeedsDiscover._maybeCloseBackdrop(event)"
                 style="position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 1050; display: flex; align-items: center; justify-content: center; padding: 16px;">
                <div onclick="event.stopPropagation()"
                     style="background: var(--bg-card, #fff); border-radius: 12px; max-width: 560px; width: 100%; max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3); padding: 20px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
                        <h2 style="margin: 0; font-size: 17px;">Discover cameras</h2>
                        <button class="btn btn-ghost btn-sm" onclick="VideoFeedsDiscover.close()" aria-label="Close">✕</button>
                    </div>
                    <div style="color: var(--text-muted); font-size: 13px; margin-bottom: 16px;">
                        Cameras found in Home Assistant that aren't feeds yet. Adding one shares
                        it with every device (on-demand, no trigger — edit it afterward to add
                        motion alerts).
                    </div>
                    ${body}
                    <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px;">
                        <button class="btn btn-ghost btn-sm" onclick="VideoFeedsDiscover._fetch()" ${m.loading ? 'disabled' : ''}>↻ Rescan</button>
                        <button class="btn btn-ghost" onclick="VideoFeedsDiscover.close()">Done</button>
                    </div>
                </div>
            </div>
        `;
    },

    _row(c, esc) {
        const sourceBadge = c.source === 'frigate'
            ? `<span class="list-item-badge" title="Frigate camera: ${esc(c.frigate_camera)}">Frigate</span>`
            : `<span class="list-item-badge">HA</span>`;
        const adding = !!this._open.adding[c.entity_id];
        return `
            <div class="list-item">
                <div class="list-item-content">
                    <div class="list-item-title">${esc(c.label)}</div>
                    <div class="list-item-subtitle">${esc(c.entity_id)}</div>
                </div>
                ${sourceBadge}
                <button class="btn btn-primary btn-sm" onclick="VideoFeedsDiscover.add('${esc(c.entity_id)}')" ${adding ? 'disabled' : ''}>
                    ${adding ? 'Adding…' : '+ Add'}
                </button>
            </div>
        `;
    },
};
