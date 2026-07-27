/* ============================================================
   Video Feeds page — household feed definitions.

   Manages the HA integration's feed registry (the same registry
   tablets edit from their native Settings UI): camera source,
   triggers, stream quality, alert sound, default mode. Per-device
   subscription modes and device-local display prefs (feed size,
   location, volume) are intentionally NOT here — those live on
   the device detail page / on-tablet settings.

   Add-on mode only for management: the registry lives inside the
   user's HA, reached via the add-on's /api/feeds/* proxy. In
   cloud mode we render a pointer to the add-on console instead.
   ============================================================ */

const VideoFeedsPage = {
    _feeds: null,        // array of feed objects (registry values)
    _loading: false,
    _error: null,

    MODE_LABELS: {
        subscribed:    'On-demand',
        trigger:       'Trigger',
        trigger_alert: 'Trigger + Alert',
        ignored:       'Ignored',
    },

    render() {
        const editorHtml = (typeof VideoFeedsEdit !== 'undefined') ? VideoFeedsEdit.render() : '';
        const discoverHtml = (typeof VideoFeedsDiscover !== 'undefined') ? VideoFeedsDiscover.render() : '';
        const modals = editorHtml + discoverHtml;

        if (!DashieAuth.isAddonMode) return this._renderCloudMode();

        if (!this._feeds && !this._loading && !this._error) {
            this._fetch();
            return this._renderLoading() + modals;
        }
        if (this._loading && !this._feeds) return this._renderLoading() + modals;
        if (this._error && !this._feeds) return this._renderError() + modals;

        return this._renderList() + modals;
    },

    topBarTitle() { return 'Video Feeds'; },

    topBarSubtitle() {
        if (!DashieAuth.isAddonMode || !this._feeds) return 'Household camera feeds';
        const n = this._feeds.length;
        return `${n} feed${n === 1 ? '' : 's'} · shared by all devices`;
    },

    topBarActions() {
        if (!DashieAuth.isAddonMode) return '';
        return `
            <button class="btn btn-secondary" onclick="VideoFeedsDiscover.open()">🔍 Discover cameras</button>
            <button class="btn btn-primary" onclick="VideoFeedsEdit.open(null)">+ Add Feed</button>
        `;
    },

    /** Called by App.navigate — refresh so we pick up edits tablets made. */
    onNavigateTo() {
        if (DashieAuth.isAddonMode) this._fetch();
    },

    async refresh() { await this._fetch(); },

    async _fetch() {
        this._loading = true;
        this._error = null;
        try {
            const result = await FeedsApi.list();
            const feeds = Object.values(result.feeds || {});
            // Stable, human order — registry returns an object keyed by id.
            feeds.sort((a, b) => (a.label || a.id || '').localeCompare(b.label || b.id || ''));
            this._feeds = feeds;
        } catch (e) {
            console.error('[VideoFeedsPage] fetch failed:', e);
            this._error = e.message || String(e);
        } finally {
            this._loading = false;
            App.renderPage();
        }
    },

    getFeed(feedId) {
        return (this._feeds || []).find(f => f.id === feedId) || null;
    },

    async deleteFeed(feedId) {
        const feed = this.getFeed(feedId);
        const name = feed?.label || feedId;
        const ok = await ConfirmModal.confirm({
            title: 'Delete feed',
            message: `"${name}" will be removed for every device in the household. Devices keep their other feeds.`,
            confirmLabel: 'Delete',
            danger: true,
        });
        if (!ok) return;
        try {
            await FeedsApi.remove(feedId);
            Toast.info(`Deleted "${name}"`);
            await this._fetch();
        } catch (e) {
            console.error('[VideoFeedsPage] delete failed:', e);
            Toast.error(`Delete failed: ${e.message}`);
        }
    },

    // ── Render helpers ───────────────────────────────────────

    _renderCloudMode() {
        return `
            <div class="empty-state" style="margin-top: 80px;">
                <div class="empty-state-icon">📹</div>
                <div class="empty-state-text">Video feeds are managed from Home Assistant.</div>
                <div style="color: var(--text-muted); font-size: var(--font-size-sm); margin-top: 8px; max-width: 480px; margin-left: auto; margin-right: auto;">
                    Feed definitions live in your local Home Assistant. Open the ${BRAND.consoleName}
                    add-on inside Home Assistant to add cameras, triggers, and
                    alert settings shared by all your devices.
                </div>
            </div>
        `;
    },

    _renderLoading() {
        return `
            <div class="empty-state" style="margin-top: 80px;">
                <div class="empty-state-text">Loading feeds…</div>
            </div>
        `;
    },

    _renderError() {
        return `
            <div class="empty-state" style="margin-top: 80px;">
                <div class="empty-state-icon">⚠️</div>
                <div class="empty-state-text">Could not load video feeds</div>
                <div style="color: var(--text-muted); font-size: var(--font-size-sm); margin: 8px 0 16px;">${this._escape(this._error)}</div>
                <button class="btn btn-secondary" onclick="VideoFeedsPage._fetch()">Retry</button>
            </div>
        `;
    },

    _renderList() {
        if (!this._feeds.length) {
            return `
                <div class="empty-state" style="margin-top: 80px;">
                    <div class="empty-state-icon">📹</div>
                    <div class="empty-state-text">No video feeds yet.</div>
                    <div style="color: var(--text-muted); font-size: var(--font-size-sm); margin: 8px 0 16px; max-width: 440px; margin-left: auto; margin-right: auto;">
                        Add a camera feed once and every ${BRAND.productName} device in the household
                        can show it — on demand or automatically when a sensor triggers.
                    </div>
                    <div style="display: flex; gap: 8px; justify-content: center;">
                        <button class="btn btn-primary" onclick="VideoFeedsDiscover.open()">🔍 Discover cameras</button>
                        <button class="btn btn-secondary" onclick="VideoFeedsEdit.open(null)">+ Add manually</button>
                    </div>
                </div>
            `;
        }
        return `<div class="list-container">${this._feeds.map(f => this._renderFeedRow(f)).join('')}</div>`;
    },

    _renderFeedRow(feed) {
        const id = this._escape(feed.id);
        const available = feed.available !== false;
        const statusClass = available ? 'online' : 'offline';
        const statusTitle = available ? 'Camera available' : 'Camera unavailable';

        const sourceType = feed.stream_source_type || 'entity';
        const source = sourceType === 'entity'
            ? (feed.camera_entity_id || 'no camera set')
            : `${sourceType}: ${feed.stream_source_url || 'no URL set'}`;

        const trigger = (feed.triggers || [])[0];
        const triggerText = trigger
            ? `Trigger: ${trigger.entity_id} → ${trigger.state || 'on'}`
            : 'No trigger (on-demand only)';

        const quality = [
            feed.resolution ? `${feed.resolution}p` : 'native res',
            feed.fps ? `${feed.fps} fps` : 'native fps',
        ].join(' · ');

        const badges = [];
        badges.push(`<span class="list-item-badge">${this._escape(this.MODE_LABELS[feed.default_mode] || 'On-demand')}</span>`);
        if (feed.alert_sound) badges.push(`<span class="list-item-badge" title="Alert sound: ${this._escape(feed.alert_sound)}">🔔</span>`);
        if (feed.is_frigate_camera) badges.push(`<span class="list-item-badge" title="Frigate camera: ${this._escape(feed.frigate_camera_name || '')}">Frigate</span>`);

        return `
            <div class="list-item" onclick="VideoFeedsEdit.open('${id}')" style="cursor: pointer;">
                <span class="status-dot ${statusClass}" title="${statusTitle}" style="flex-shrink: 0; margin-right: 12px;"></span>
                <div class="list-item-content">
                    <div class="list-item-title">${this._escape(feed.label || feed.id)}</div>
                    <div class="list-item-subtitle">${this._escape(source)} · ${this._escape(triggerText)} · ${this._escape(quality)}</div>
                </div>
                ${badges.join('')}
                <button class="btn btn-ghost btn-sm" title="Delete feed"
                    onclick="event.stopPropagation(); VideoFeedsPage.deleteFeed('${id}')">🗑</button>
            </div>
        `;
    },

    _escape(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
};
