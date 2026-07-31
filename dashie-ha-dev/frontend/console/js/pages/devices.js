/* ============================================================
   Devices Page
   ------------------------------------------------------------
   Three sections on the list view:
     • Active    — live or recently-seen devices (last_seen_at < 30d)
     • Discovered — devices HA reports but which aren't in user_devices
                    for this user (from the add-on's /api/ha/status, so only
                    shows when running inside the add-on)
     • Archive   — stale devices (last_seen_at >= 30d), collapsed, hidden
                    if empty, with per-device Delete
   ------------------------------------------------------------ */

const DevicesPage = {
    _detailDeviceId: null,
    _devices: null,
    _loading: false,
    _error: null,
    _saving: {},  // { [deviceId_field]: bool }

    // Phase-2 additions
    _haStatus: null,          // add-on /api/ha/status response (or null)
    _haStatusFetchedAt: 0,
    _haStatusFetching: false, // single-flight guard for background refresh
    _archiveExpanded: false,
    _offlineExpanded: true,      // Offline section starts expanded — cards are minimal anyway
    _deletingId: null,        // device_id currently being deleted
    // Rename + conflict state lives on DevicesRename (see devices-rename.js).

    ARCHIVE_THRESHOLD_DAYS: 30,
    LIVE_THRESHOLD_SECONDS: 90,   // metrics_updated_at newer than this → "live" chip
    HA_STATUS_MAX_AGE_MS: 15 * 1000, // refetch /api/ha/status if older than this on render
    // SSE pushes per-state changes in real time, so this poll just acts as a
    // backstop. 30s is plenty — at 5s we were re-rendering the entire page
    // every 5s for no visible change, which caused the visible "flashing".
    AUTO_REFRESH_MS: 30 * 1000,
    LIST_DEVICES_REFRESH_MS: 5 * 60 * 1000,  // Supabase list_devices (settings, structural)
    // Periodic screenshot re-capture. The status poll keeps the screenshot
    // cache-bust stable (so it doesn't flash); this is the only thing that
    // pulls a genuinely fresh frame from each device on a schedule.
    SCREENSHOT_REFRESH_MS: 30 * 1000,

    _pollTimer: null,
    _ssTimer: null,
    _lastListDevicesAt: 0,
    /** Live overrides: device_id → { role: { state, attrs } } applied over the
     *  worker's freshDevices metrics. Updated by SSE state_changed events. */
    _liveOverrides: {},

    /**
     * Whether to render the technical-details version of each card (battery,
     * RAM, wifi, screenshot, camera, lock, all controls) versus the simple
     * "what's playing on this dashboard" version (theme, sleep schedule, AI
     * personality, photos album + a small set of controls).
     *
     * Default ON inside the HA add-on (technical users), OFF on the public
     * web (less-technical users). Persisted per-browser in localStorage.
     */
    _TECH_VIEW_KEY: 'dashie_devices_tech_view',
    get _techView() {
        const stored = localStorage.getItem(this._TECH_VIEW_KEY);
        if (stored === 'on')  return true;
        if (stored === 'off') return false;
        return FeatureGate.isAddonMode();   // default depends on context
    },
    setTechView(on) {
        try { localStorage.setItem(this._TECH_VIEW_KEY, on ? 'on' : 'off'); } catch {}
        App.renderPage();
    },
    toggleTechView() { this.setTechView(!this._techView); },

    /**
     * Sub-toggles for the tech view — when ON, the per-device card can
     * still hide its screenshot or camera panels. Both default ON.
     * When _techView is OFF the simple card doesn't render those panels
     * at all, so these toggles are no-ops in that mode.
     */
    _SHOW_SCREENSHOTS_KEY: 'dashie_devices_show_screenshots',
    _SHOW_CAMERAS_KEY: 'dashie_devices_show_cameras',
    get _showScreenshots() {
        const stored = localStorage.getItem(this._SHOW_SCREENSHOTS_KEY);
        return stored === null ? true : stored === 'on';
    },
    get _showCameras() {
        const stored = localStorage.getItem(this._SHOW_CAMERAS_KEY);
        return stored === null ? true : stored === 'on';
    },
    setShowScreenshots(on) {
        try { localStorage.setItem(this._SHOW_SCREENSHOTS_KEY, on ? 'on' : 'off'); } catch {}
        App.renderPage();
    },
    setShowCameras(on) {
        try { localStorage.setItem(this._SHOW_CAMERAS_KEY, on ? 'on' : 'off'); } catch {}
        App.renderPage();
    },
    toggleShowScreenshots() { this.setShowScreenshots(!this._showScreenshots); },
    toggleShowCameras() { this.setShowCameras(!this._showCameras); },

    render() {
        if (!this._devices && !this._loading && !this._error) {
            this._fetchDevices();
            return this._renderLoading();
        }
        if (this._loading) return this._renderLoading();
        if (this._error) return this._renderError();
        if (this._detailDeviceId) return this._renderDetail();
        return this._renderList();
    },

    topBarTitle() {
        if (this._detailDeviceId) {
            const device = this._findDevice(this._detailDeviceId);
            return device ? (device.device_name || 'Device') : 'Device';
        }
        return 'Devices';
    },

    topBarSubtitle() {
        if (!this._detailDeviceId) {
            if (!this._devices) return '';
            // "active" = visible in the Online/Offline sections — exclude
            // both time-archived (>30d since last_seen) AND user-dismissed
            // devices so the count matches what the user actually sees.
            const active = this._devices.filter(d => !this._isArchived(d) && !this._isDismissed(d)).length;
            // Manual refresh now lives in the shared title-bar icon (refresh()).
            // The Overview/Details view switcher sits right after the count (the subtitle renders
            // as HTML in the top bar), not out in the right-hand actions column.
            return `${active} active${this._viewSwitcherHtml()}`;
        }
        const device = this._findDevice(this._detailDeviceId);
        return device ? this._typeLabel(device) : '';
    },

    /** The Overview/Details view switcher — a segmented control. Lives next to the "N active"
     *  subtitle (rendered as HTML there), not in the right-hand actions column. Overview = what's
     *  playing on each dashboard; Details = full device diagnostics. Context default (add-on →
     *  Details, web → Overview); persisted per-browser via setTechView. Uses a <span> wrapper so
     *  it's valid inline inside the subtitle span. */
    _viewSwitcherHtml() {
        const on = this._techView;
        return `<span style="display:inline-flex; margin-left:12px; vertical-align:middle; border:1px solid var(--border,#e5e7eb); border-radius:6px; overflow:hidden;">
                <button class="btn ${!on ? 'btn-primary' : 'btn-secondary'} btn-sm" style="border:none; border-radius:0;"
                        onclick="DevicesPage.setTechView(false)"
                        title="What's playing on each dashboard — theme, sleep schedule, AI personality, photos">Overview</button>
                <button class="btn ${on ? 'btn-primary' : 'btn-secondary'} btn-sm" style="border:none; border-radius:0;"
                        onclick="DevicesPage.setTechView(true)"
                        title="Full device details — battery, RAM, wifi, screenshots, cameras, locks">Details</button>
            </span>`;
    },

    /** Top-bar action buttons — Preview Dashie + (in Details) Screenshot / Camera sub-toggles.
     *  The Overview/Details switcher moved next to the "N active" subtitle (_viewSwitcherHtml). */
    topBarActions() {
        // Only show on the list view, not the detail view.
        if (this._detailDeviceId) return '';
        const on = this._techView;
        // Preview opens the browser dashboard at the origin root. Only valid in
        // web mode — in add-on mode the console is served from HA Ingress, where
        // '/' is Home Assistant, not the Dashie dashboard.
        const previewBtn = (typeof DashieAuth !== 'undefined' && DashieAuth.isAddonMode)
            ? ''
            : `<button class="btn btn-secondary" onclick="DevicesPage.openPreview()"
                       title="Open the ${BRAND.productName} dashboard in a new browser tab">
                   Preview ${BRAND.productName} in Browser ↗
               </button>`;
        // Screenshot / Camera sub-toggles are only useful in Details view (Overview
        // doesn't render those panels at all). Hide them in Overview to keep the header tidy.
        const subToggles = on ? `
            <button class="btn ${this._showScreenshots ? 'btn-primary' : 'btn-secondary'}"
                    onclick="DevicesPage.toggleShowScreenshots()"
                    title="Show or hide the dashboard screenshot panel on each device card">
                ${this._showScreenshots ? '✓ ' : ''}Screenshots
            </button>
            <button class="btn ${this._showCameras ? 'btn-primary' : 'btn-secondary'}"
                    onclick="DevicesPage.toggleShowCameras()"
                    title="Show or hide the camera feed panel on each device card">
                ${this._showCameras ? '✓ ' : ''}Cameras
            </button>` : '';
        return `
            ${previewBtn}
            ${subToggles}
        `;
    },

    /** Open the browser dashboard (origin root) in a new tab. Same origin as
     *  the hub, so the shared dashie-supabase-jwt means no re-login. */
    openPreview() {
        window.open('/', '_blank', 'noopener');
    },

    /**
     * Consume the 'device_settings' realtime kind (Phase 4.2 — this kind was
     * emitted by the edge on every device-settings write but had NO consumer;
     * the page relied on the 5-minute list_devices poll, so an open settings
     * modal could hold stale values and its full-category live-push
     * re-broadcast stale siblings). On signal: refetch list_devices so
     * cards, detail view, and open modals re-render with fresh settings.
     * Self-echoes of this console's own writes are filtered upstream via the
     * source_client_id DashieAuth.dbRequest injects. Idempotent.
     * @private
     */
    _registerSyncOnce() {
        if (this._syncRegistered) return;
        if (!window.SettingsSync || typeof window.SettingsSync.register !== 'function') return;
        this._syncRegistered = true;
        window.SettingsSync.register('device_settings', async () => {
            if (typeof App !== 'undefined' && App._currentPage && App._currentPage !== 'devices') {
                // Not mounted — drop the cache so the next visit refetches
                // instead of painting stale settings first.
                this._devices = null;
                return;
            }
            try {
                const result = await DashieAuth.dbRequest('list_devices', { tv_only: false, include_inactive: true });
                const newList = result.devices || result.data || [];
                const changed = JSON.stringify(newList) !== JSON.stringify(this._devices);
                this._devices = newList;
                this._lastListDevicesAt = Date.now();
                // Camera modal owns a live <video> — don't churn it (same
                // guard the poll path uses). Settings modals re-render from
                // _devices, which is the point: they show the fresh values.
                if (typeof DevicesCamera !== 'undefined' && DevicesCamera._open) return;
                // Don't tear down an open settings modal (2026-07-06): a
                // renderPage here rebuilds the modal DOM, which lost the
                // "apply to all" checkbox state mid-edit and made the fan-out
                // silently write to only the open device. The in-memory
                // _devices is already fresh; the modal reads from it, and the
                // summary rows repaint when the modal closes.
                if (this._isAnyDetailModalOpen()) return;
                if (changed) App.renderPage();
            } catch (e) {
                console.warn('[DevicesPage] device_settings refresh failed:', e.message);
            }
        });
        console.log('[DevicesPage] Registered device_settings SettingsSync consumer');
    },

    async _fetchDevices() {
        this._loading = true;
        this._error = null;
        this._pollersStopped = false;  // re-arm pollers on a fresh (re-)load
        this._registerSyncOnce();
        try {
            const [devicesResult] = await Promise.all([
                DashieAuth.dbRequest('list_devices', { tv_only: false, include_inactive: true }),
                this._fetchAddonStatus(),  // fire-and-forget inside
                DevicesClaim.fetch(),      // claimable installs — non-critical, swallows errors
            ]);
            this._devices = devicesResult.devices || devicesResult.data || [];
            this._loading = false;
            this._startAutoRefresh();
            this._startScreenshotRefresh();
            DevicesEvents.start();
            App.renderPage();
            // Prefetch the personality catalog so card/detail summaries resolve
            // personalityId → name on first paint (fire-and-forget; re-renders
            // when it lands). Falls back to a prettified id until then.
            DevicesDetailModals.loadPersonalityCatalog().then(() => App.renderPage());
            // If the add-on just restarted (e.g. after a version bump) the
            // worker hasn't completed its first poll yet — freshDevices is
            // empty and chips would be inert until the 30s auto-refresh.
            // Fast-retry until we see live data.
            this._pollUntilFreshDevices();
        } catch (e) {
            console.error('[DevicesPage] Fetch failed:', e);
            this._error = e.message;
            this._loading = false;
            App.renderPage();
        }
    },

    /** Background re-fetch every AUTO_REFRESH_MS while page is visible. */
    _startAutoRefresh() {
        if (this._pollTimer) return;
        this._pollTimer = setInterval(() => {
            if (document.visibilityState === 'hidden') return;
            this._refreshSilent();
        }, this.AUTO_REFRESH_MS);
    },

    /** Background screenshot re-capture every SCREENSHOT_REFRESH_MS while
     *  the page is visible. Only addon mode serves screenshots. */
    _startScreenshotRefresh() {
        if (this._ssTimer || !DashieAuth.isAddonMode) return;
        this._ssTimer = setInterval(() => {
            if (document.visibilityState === 'hidden') return;
            const ids = (this._devices || []).filter(d => this._isLive(d)).map(d => d.device_id);
            this.refreshScreenshots(ids);
        }, this.SCREENSHOT_REFRESH_MS);
    },

    /**
     * Pull a genuinely fresh frame from each given device, flicker-free: preload
     * the new-cache-bust image off-screen, and only once it's decoded swap the
     * card's cache-bust to it (the visible <img> then loads from cache instantly,
     * with no blank gap). Re-renders once after the batch settles.
     *
     * Skipped per-device while its screenshot/camera modal is open (the modal owns
     * a fresh frame already, and a re-render would churn the open <video>).
     */
    refreshScreenshots(deviceIds) {
        if (!DashieAuth.isAddonMode || !deviceIds || !deviceIds.length) return;
        if (typeof DevicesCamera !== 'undefined' && DevicesCamera._open) return;
        const ts = Date.now();
        let pending = deviceIds.length;
        let anyLoaded = false;
        const settle = (id, ok) => {
            if (ok) { DevicesCard._screenshotTs[id] = ts; anyLoaded = true; }
            if (--pending === 0 && anyLoaded) App.renderPage();
        };
        deviceIds.forEach(id => {
            const img = new Image();
            img.onload = () => settle(id, true);
            img.onerror = () => settle(id, false);
            img.src = DashieAuth._addonUrl(
                `/api/ha/image/${encodeURIComponent(id)}/screenshot?t=${ts}`);
        });
    },

    /** Stop every background poller this page started. Called on sign-out
     *  (App._showLogin) so timers don't keep hitting unauthenticated
     *  endpoints — or, before the renderPage() auth guard, repaint the
     *  dashboard over the login screen. */
    _stopPollers() {
        if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
        if (this._ssTimer) { clearInterval(this._ssTimer); this._ssTimer = null; }
        this._pollersStopped = true;  // halts the recursive _pollUntilFreshDevices chain
    },

    async _refreshSilent() {
        try {
            // Always refresh /api/ha/status (cheap, local). Skip the heavy list_devices
            // call unless LIST_DEVICES_REFRESH_MS has elapsed.
            this._haStatusFetchedAt = 0;
            const before = this._haStatusHash();
            const claimBefore = DevicesClaim.signature();
            await this._fetchAddonStatus();
            await DevicesClaim.fetch();
            const after = this._haStatusHash();
            const claimChanged = DevicesClaim.signature() !== claimBefore;
            let listChanged = false;
            if (Date.now() - this._lastListDevicesAt >= this.LIST_DEVICES_REFRESH_MS) {
                this._lastListDevicesAt = Date.now();
                const result = await DashieAuth.dbRequest('list_devices', { tv_only: false, include_inactive: true });
                const newList = result.devices || result.data || [];
                if (JSON.stringify(newList) !== JSON.stringify(this._devices)) listChanged = true;
                this._devices = newList;
            }
            // Skip render if camera modal is open (would tear down <video>) or
            // if nothing visibly changed since last poll. SSE handles real-time
            // updates between polls, so a quiet status check shouldn't repaint.
            if (typeof DevicesCamera !== 'undefined' && DevicesCamera._open) return;
            if (before === after && !listChanged && !claimChanged) return;
            App.renderPage();
        } catch (e) {
            console.warn('[DevicesPage] auto-refresh failed:', e.message);
        }
    },

    /** Stable hash of the parts of /api/ha/status that affect what we render.
     *  Excludes noisy numeric values (battery, ram, wifi_signal) so frequent
     *  small changes don't cause repaints that flash screenshots/cameras.
     *  Those values still update internally and surface on the next render. */
    _haStatusHash() {
        const fresh = this._haStatus?.lastRun?.freshDevices || [];
        try {
            return JSON.stringify(fresh.map(d => {
                const m = d.metrics || {};
                const c = m.controls || {};
                const p = m.presence || {};
                return {
                    id: d.device_id,
                    hl: d.has_live_data,
                    slug: d.slug,
                    lock: c.lock, screen: c.screen, dark_mode: c.dark_mode,
                    screensaver: c.screensaver,
                    keep_screen_on: c.keep_screen_on, auto_brightness: c.auto_brightness,
                    volume: c.volume, brightness: c.brightness,
                    motion: p.motion, face: p.face,
                    motion_active: p.motion_active, face_active: p.face_active,
                    cam_on: !!(c.camera_streaming || c.camera_stream_enabled),
                    cam_res: c.camera_resolution ? 'set' : 'none',
                };
            }));
        } catch { return ''; }
    },

    /** Manual refresh (title-bar icon): re-poll status AND pull a fresh frame
     *  from every device (flicker-free preload, same path as the periodic
     *  refresh). App.refreshCurrentPage() owns the spin state + re-render. */
    async refresh() {
        await this._refreshSilent();
        this.refreshScreenshots((this._devices || []).map(d => d.device_id));
    },

    /**
     * Grab the add-on's worker status so we can surface "Discovered but
     * not claimed" devices. Only meaningful when Console is running inside
     * the add-on — otherwise _addonUrl resolves to an external path that
     * won't exist; we swallow the error and show no Discovered section.
     */
    async _fetchAddonStatus() {
        if (!DashieAuth.isAddonMode) {
            this._haStatus = null;
            return;
        }
        if (this._haStatusFetching) return;
        this._haStatusFetching = true;
        try {
            const resp = await fetch(DashieAuth._addonUrl('/api/ha/status'), { cache: 'no-store' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            this._haStatus = await resp.json();
            this._haStatusFetchedAt = Date.now();
        } catch (e) {
            console.warn('[DevicesPage] /api/ha/status unavailable:', e.message);
            this._haStatus = null;
        } finally {
            // Stamp the attempt on FAILURE too, not just success.
            //
            // _maybeRefreshAddonStatus() gates on `Date.now() - _haStatusFetchedAt`.
            // While this only advanced on success, a failing endpoint left it at 0 —
            // permanently "stale" — and the render path is circular:
            //   _renderList → _maybeRefreshAddonStatus → _fetchAddonStatus
            //     → .then(App.renderPage) → _renderList → …
            // _haStatusFetching is cleared in this finally, BEFORE that .then() runs,
            // so it serialized nothing. The result was a tight loop bounded only by
            // localhost RTT: ~20,000 requests in seconds, which buried the add-on log
            // (2000/2000 lines were the same DROP marker) on 2026-07-31.
            //
            // Not merge-specific — any transient 500, or the add-on restarting under
            // a open Devices tab, hits the same loop. Backing off on failure the same
            // 15s we back off on success is the fix.
            this._haStatusFetchedAt = Date.now();
            this._haStatusFetching = false;
        }
    },

    /** Kick off a background refresh if the cached /api/ha/status is stale. */
    _maybeRefreshAddonStatus() {
        if (!DashieAuth.isAddonMode) return;
        if (this._haStatusFetching) return;
        const age = Date.now() - this._haStatusFetchedAt;
        if (age < this.HA_STATUS_MAX_AGE_MS) return;
        this._fetchAddonStatus().then(() => App.renderPage());
    },

    /** Fast retry of /api/ha/status during the boot window before the worker
     *  has done its first poll (3s startup delay + ~1s poll latency on the
     *  add-on side). Without this, freshDevices stays empty for up to
     *  AUTO_REFRESH_MS (30s) on a fresh add-on restart, which makes the
     *  metric chips look broken (entity_ids empty → click no-ops). Runs
     *  at most a handful of times then yields to the normal auto-refresh. */
    _pollUntilFreshDevices(attempt = 0) {
        const MAX_ATTEMPTS = 6;     // ~12s total
        const DELAY_MS = 2000;
        if (this._pollersStopped) return;  // signed out mid-poll
        const fresh = this._haStatus?.lastRun?.freshDevices;
        if (Array.isArray(fresh) && fresh.length > 0) return;
        if (attempt >= MAX_ATTEMPTS) return;
        setTimeout(() => {
            if (this._pollersStopped) return;
            // Bypass HA_STATUS_MAX_AGE_MS — we want a fresh fetch, not
            // the cached "fetched <15s ago" result.
            this._haStatusFetchedAt = 0;
            this._fetchAddonStatus().then(() => {
                App.renderPage();
                this._pollUntilFreshDevices(attempt + 1);
            });
        }, DELAY_MS);
    },

    _findDevice(deviceId) {
        if (!this._devices) return null;
        return this._devices.find(d => d.device_id === deviceId);
    },

    _isArchived(device) {
        if (!device.last_seen_at) return false;
        const age = Date.now() - new Date(device.last_seen_at).getTime();
        return age > this.ARCHIVE_THRESHOLD_DAYS * 86400 * 1000;
    },

    /** Has the user explicitly hidden this device from the Offline list?
     *  Distinct from the time-based Archive bucket — Archive is automatic
     *  (30d+ since last_seen), Dismiss is an explicit per-user choice
     *  persisted server-side via ConsoleState. */
    _isDismissed(device) {
        if (typeof ConsoleState === 'undefined') return false;
        return ConsoleState.isDismissed('devices', device.device_id);
    },

    /** Hide an Offline card from the main list. Persists via ConsoleState
     *  (cross-browser, survives cache clear). */
    dismissDevice(deviceId) {
        if (typeof ConsoleState !== 'undefined') ConsoleState.dismiss('devices', deviceId);
        App.renderPage();
    },

    /** Move a dismissed device back into the Offline list. */
    restoreDevice(deviceId) {
        if (typeof ConsoleState !== 'undefined') ConsoleState.restore('devices', deviceId);
        App.renderPage();
    },

    /** Delete a dismissed user_devices row entirely (soft-delete via
     *  delete_device — sets is_active=false). Also drops the dismissal
     *  entry so the row doesn't linger in ConsoleState after the row
     *  is gone. If the device reconnects later, it'll surface fresh
     *  via discovered / install paths. */
    async deleteDismissedDevice(deviceId, deviceName) {
        const label = deviceName || 'this device';
        if (!confirm(`Delete "${label}" from your account?\n\nThe row will be removed. If the device reconnects later, it'll reappear as a fresh discovered/install entry.`)) return;
        try {
            await DashieAuth.dbRequest('delete_device', { device_id: deviceId });
            this._devices = (this._devices || []).filter(d => d.device_id !== deviceId);
            if (typeof ConsoleState !== 'undefined') ConsoleState.restore('devices', deviceId);
            if (typeof Toast !== 'undefined') Toast.success(`Deleted "${label}"`);
        } catch (e) {
            console.error('[DevicesPage] delete_device failed:', e);
            if (typeof Toast !== 'undefined') Toast.error(Toast.friendly(e, 'delete this device'));
        }
        App.renderPage();
    },

    /** Toggle for the unified Dismissed section at the bottom of the page. */
    _dismissedExpanded: false,
    _toggleDismissed() {
        this._dismissedExpanded = !this._dismissedExpanded;
        App.renderPage();
    },

    _isLive(device) {
        // If the worker has a fresh poll for this device with live data, it's live —
        // independent of the Supabase metrics_updated_at timestamp (which only
        // updates on upsert, every 30s).
        const fresh = this._freshDeviceFor(device.device_id);
        if (fresh?.has_live_data) return true;
        if (!device.metrics_updated_at) return false;
        const age = (Date.now() - new Date(device.metrics_updated_at).getTime()) / 1000;
        return age < this.LIVE_THRESHOLD_SECONDS;
    },

    _discoveredDevices() {
        return this._haStatus?.lastRun?.upsertResult?.unmatched || [];
    },

    _conflictHaName(device) { return DevicesRename.conflictHaName(device, this._haStatus); },
    _conflictDevices() {
        return DevicesRename.conflictDevices(this._devices, d => this._isArchived(d), this._haStatus);
    },

    /** Look up the HA entity slug (e.g. 'fire_tv') for a Dashie device_id from
     *  the worker's last-poll synced[] / freshDevices. Used to deep-link to HA. */
    _haSlugForDevice(deviceId) {
        const fresh = this._freshDeviceFor(deviceId);
        if (fresh?.slug) return fresh.slug;
        const synced = this._haStatus?.lastRun?.upsertResult?.synced || [];
        const entry = synced.find(s => s?.device_id === deviceId);
        return entry?.ha_slug || null;
    },

    /** Map of role → resolved entity_id for a device, sourced from the
     *  worker's freshDevices entry. Lets history-chart deep links use
     *  the *actual* entity_id HA holds (which may not match the anchor's
     *  slug + role suffix on partial-migration devices). Returns {} when
     *  the worker hasn't seen the device yet — caller should fall back
     *  to slug+suffix construction in that case. */
    _haEntityIdsForDevice(deviceId) {
        const fresh = this._freshDeviceFor(deviceId);
        return fresh?.entity_ids || {};
    },

    /** The worker's freshly-extracted per-device record (every 5s), with any
     *  live SSE overrides merged in. The merge maps state_changed events to
     *  the relevant slots in metrics.controls / metrics.presence. */
    _freshDeviceFor(deviceId) {
        const fresh = (this._haStatus?.lastRun?.freshDevices || []).find(d => d.device_id === deviceId);
        const overrides = this._liveOverrides[deviceId];
        if (!fresh || !overrides) return fresh || null;
        const metrics = JSON.parse(JSON.stringify(fresh.metrics || {}));
        for (const [role, val] of Object.entries(overrides)) this._mergeRoleIntoMetrics(metrics, role, val);
        return { ...fresh, metrics };
    },

    /** Apply an incoming SSE state event into _liveOverrides. */
    _applyLiveOverride(msg) {
        const cur = this._liveOverrides[msg.device_id] || {};
        cur[msg.role] = { state: msg.state, attrs: msg.attributes || {} };
        this._liveOverrides[msg.device_id] = cur;
    },

    /** Translate a (role, state, attrs) into the metrics shape buildDeviceMetrics produces. */
    _mergeRoleIntoMetrics(metrics, role, val) {
        const s = val.state, a = val.attrs || {};
        const num = v => (v === null || v === undefined || v === 'unavailable' || v === 'unknown' || isNaN(Number(v))) ? null : Number(v);
        const map = {
            battery:           () => { metrics.battery = { ...(metrics.battery||{}), level: num(s), plugged: !!a.plugged }; },
            plugged_in:        () => { metrics.battery = { ...(metrics.battery||{}), charging: s === 'on', plug_source: a.plug_source ?? null }; },
            ram_usage:         () => { metrics.system = { ...(metrics.system||{}), ram_used_percent: num(s), ram_total_mb: a.total_mb ?? null, ram_available_mb: a.available_mb ?? null, app_pss_mb: a.app_pss_mb ?? null }; },
            wifi_signal:       () => { metrics.network = { ...(metrics.network||{}), wifi_signal_percent: num(s), wifi_ssid: a.ssid ?? null, ip_address: a.ip_address ?? null, mac_address: a.mac_address ?? null }; },
            storage_free:      () => { metrics.storage = { ...(metrics.storage||{}), free_gb: num(s), total_gb: a.total_gb ?? null }; },
            android_version:   () => { metrics.app = { ...(metrics.app||{}), android_version: s, device_model: a.device_model ?? null, device_manufacturer: a.device_manufacturer ?? null }; },
            app_version:       () => { metrics.app = { ...(metrics.app||{}), app_version: s, version_code: a.version_code ?? null }; },
            current_page:      () => { metrics.app = { ...(metrics.app||{}), current_page: s }; },
            screensaver_active:() => { metrics.screensaver = { active: s === 'on' }; },
            motion_detected:   () => {
                const avail = s !== 'unavailable' && s !== 'unknown' && s != null;
                metrics.presence = { ...(metrics.presence||{}), motion: s === 'on', motion_active: avail };
            },
            face_detected:     () => {
                const avail = s !== 'unavailable' && s !== 'unknown' && s != null;
                metrics.presence = { ...(metrics.presence||{}), face: s === 'on', face_active: avail };
            },
            ambient_light:     () => { metrics.environment = { ambient_light: num(s) }; },
            lock:              () => { metrics.controls = { ...(metrics.controls||{}), lock: s === 'on' }; },
            screen:            () => { metrics.controls = { ...(metrics.controls||{}), screen: s === 'on' }; },
            screensaver:       () => { metrics.controls = { ...(metrics.controls||{}), screensaver: s === 'on' }; },
            dark_mode:         () => { metrics.controls = { ...(metrics.controls||{}), dark_mode: s === 'on' }; },
            keep_screen_on:    () => { metrics.controls = { ...(metrics.controls||{}), keep_screen_on: s === 'on' }; },
            auto_brightness:   () => { metrics.controls = { ...(metrics.controls||{}), auto_brightness: s === 'on' }; },
            volume:            () => { metrics.controls = { ...(metrics.controls||{}), volume: num(s) }; },
            brightness:        () => { metrics.controls = { ...(metrics.controls||{}), brightness: num(s) }; },
            camera_stream_url: () => { metrics.controls = { ...(metrics.controls||{}), camera_stream_url: (s && s !== 'unavailable' && s !== 'unknown') ? s : null }; },
            camera_resolution: () => { metrics.controls = { ...(metrics.controls||{}), camera_resolution: (s && s !== 'unavailable' && s !== 'unknown') ? s : null }; },
            camera_frame_rate: () => { metrics.controls = { ...(metrics.controls||{}), camera_frame_rate: (s && s !== 'unavailable' && s !== 'unknown') ? Number(s) : null }; },
            camera:            () => { metrics.controls = { ...(metrics.controls||{}), camera_streaming: s === 'streaming' }; },
            rtsp_stream:       () => { metrics.controls = { ...(metrics.controls||{}), camera_stream_enabled: s === 'on' }; },
        };
        const fn = map[role];
        if (fn) fn();
    },

    _renderLoading() {
        return `
            <div style="display: flex; align-items: center; justify-content: center; padding: 60px;">
                <div style="text-align: center;">
                    <div style="width: 32px; height: 32px; border: 3px solid #e5e7eb; border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 12px;"></div>
                    <div style="color: var(--text-secondary); font-size: var(--font-size-sm);">Loading devices...</div>
                </div>
                <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
            </div>
        `;
    },

    _renderError() {
        return `
            <div class="card">
                <div class="card-body" style="color: var(--status-error);">
                    <strong>Failed to load devices:</strong> ${this._escape(this._error)}
                    <div style="margin-top: 12px;">
                        <button class="btn btn-secondary btn-sm" onclick="DevicesPage._retry()">Retry</button>
                    </div>
                </div>
            </div>
        `;
    },

    _retry() {
        this._error = null;
        this._devices = null;
        this._haStatus = null;
        App.renderPage();
    },

    _renderList() {
        // Background-refresh /api/ha/status if it's gone stale since last fetch.
        // Self-heals the "page loaded before worker's first poll" race.
        this._maybeRefreshAddonStatus();

        if (!this._devices || this._devices.length === 0) {
            // No registered devices yet — but still show the Add banner +
            // Dismissed section since a kiosk-mode device (HA-discovered)
            // might be addable from a fresh account.
            return `
                ${DevicesClaim.renderBanner()}
                <div class="empty-state">
                    <div class="empty-state-icon">📱</div>
                    <div class="empty-state-text">No devices registered yet.</div>
                    <div style="color: var(--text-muted); font-size: var(--font-size-sm); margin-top: 8px;">
                        Sign in to ${BRAND.productName} on a tablet or Fire TV to register it — or, if HA
                        sees one of your devices, add it from the banner above.
                    </div>
                </div>
                ${this._renderDismissedSection([])}
            `;
        }

        const active = this._devices.filter(d => !this._isArchived(d));
        const online = active.filter(d => this._isLive(d));
        // Offline = active, not live, AND not explicitly dismissed by the user.
        // Dismissed devices show up in the unified Dismissed section instead.
        const offline = active.filter(d => !this._isLive(d) && !this._isDismissed(d));
        const dismissedDevices = active.filter(d => !this._isLive(d) && this._isDismissed(d));
        const archived = this._devices.filter(d => this._isArchived(d));

        const conflicts = this._conflictDevices();
        // Section order: high-attention banners → Online → Offline → Archive
        // → collapsed Dismissed at the bottom. The standalone Discovered
        // section was folded into DevicesClaim.renderBanner() — HA-discovered
        // kiosk devices now appear in the same banner as already-installed
        // claimables, with Adopt vs Claim routing handled internally.
        return `
            ${DevicesRename.renderBanner(conflicts)}
            ${DevicesClaim.renderBanner()}
            ${this._renderOnlineSection(online)}
            ${this._renderOfflineSection(offline)}
            ${this._renderArchiveSection(archived)}
            ${this._renderDismissedSection(dismissedDevices)}
            ${DevicesRename.conflictModal ? DevicesRename.renderModal(conflicts, d => this._conflictHaName(d)) : ''}
            ${DevicesCard.renderSliderModal()}
            ${DevicesCard.renderScreenshotModal()}
            ${DevicesCard.renderHistoryModal()}
            ${DevicesCard.renderCameraModal()}
            ${DevicesDetailModals.renderSleepModal()}
            ${DevicesDetailModals.renderThemeModal()}
            ${DevicesDetailModals.renderVoicePersonalityModal()}
            ${DevicesDetailModals.renderVoiceVoiceModal()}
            ${DevicesDetailModals.renderPhotosModal()}
        `;
    },

    /**
     * Unified Dismissed section at the bottom of the page. Combines:
     *   - install / discovered rows hidden from the Add banner
     *   - claimed devices the user dismissed from the Offline list
     * Each card has a Restore button that returns it to its original bucket.
     */
    _renderDismissedSection(dismissedDevices) {
        const hiddenAddables = (typeof DevicesClaim !== 'undefined') ? DevicesClaim._hidden() : [];
        const total = hiddenAddables.length + (dismissedDevices?.length || 0);
        if (total === 0) return '';

        const caret = this._dismissedExpanded ? '▾' : '▸';
        const header = `
            <div class="section-header" style="margin-top: 32px; cursor: pointer;" onclick="DevicesPage._toggleDismissed()">
                ${caret} Dismissed (${total})
            </div>
        `;
        if (!this._dismissedExpanded) return header;

        const addableCards = hiddenAddables.map(a => DevicesClaim.renderHiddenCard(a)).join('');

        const deviceCards = (dismissedDevices || []).map(d => {
            const idAttr = this._escape(d.device_id);
            const nameAttr = this._escape(d.device_name || 'this device');
            const icon = this._deviceIcon(d.device_type);
            return `
                <div class="card" style="margin-bottom: 8px;">
                    <div class="card-body" style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
                        <div style="display: flex; align-items: center; gap: 12px; min-width: 0;">
                            <div class="device-card-icon">${icon}</div>
                            <div style="min-width: 0;">
                                <div style="font-weight: 500;">${this._escape(d.device_name || 'Unnamed Device')}</div>
                                <div style="color: var(--text-muted); font-size: var(--font-size-sm);">
                                    ${this._escape(this._typeLabel(d))} · last seen ${this._formatTime(d.last_seen_at)}
                                </div>
                            </div>
                        </div>
                        <div style="flex-shrink: 0; display: flex; gap: 6px;">
                            <button class="btn btn-secondary btn-sm" onclick="DevicesPage.restoreDevice('${idAttr}')">Restore</button>
                            <button class="btn btn-secondary btn-sm"
                                title="Delete this device from your account. If it reconnects later, it'll reappear as a fresh discovered/install."
                                onclick="DevicesPage.deleteDismissedDevice('${idAttr}', '${nameAttr}')">Delete</button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        return `${header}<div>${addableCards}${deviceCards}</div>`;
    },

    _renderOnlineSection(devices) {
        // Manual refresh button has moved to the page subtitle (next to the
        // "N active" count) so the section header stays tidy.
        const header = `
            <div style="margin-bottom: 8px;">
                <span style="font-size: 11px; font-weight: 600; color: #10b981; text-transform: uppercase; letter-spacing: 0.5px;">Online (${devices.length})</span>
            </div>
        `;
        if (devices.length === 0) {
            return `${header}<p class="empty-state-text" style="margin: 16px 0;">No online devices right now.</p>`;
        }
        const cards = devices.map(d => this._renderDeviceCard(d)).join('');
        return `${header}<div class="devices-grid">${cards}</div>`;
    },

    /**
     * Offline section — devices that aren't archived (< 30d last_seen) but
     * aren't currently live either. Rendered with a minimal card (name +
     * type + last-seen) since stats / screenshots / camera / controls
     * aren't actionable while the device is offline anyway. Section is
     * collapsible — defaults to expanded since the cards are already minimal.
     */
    _renderOfflineSection(devices) {
        if (devices.length === 0) return '';
        const caret = this._offlineExpanded ? '▾' : '▸';
        const header = `
            <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 32px; margin-bottom: 8px; cursor: pointer;"
                 onclick="DevicesPage._toggleOffline()">
                <span style="font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">${caret} Offline (${devices.length})</span>
            </div>
        `;
        if (!this._offlineExpanded) return header;
        const cards = devices.map(d => DevicesCard.renderOffline(d)).join('');
        return `${header}<div class="devices-grid">${cards}</div>`;
    },

    _toggleOffline() {
        this._offlineExpanded = !this._offlineExpanded;
        App.renderPage();
    },

    // (Discovered section + Adopt handler removed — HA-discovered kiosk
    //  devices now appear in DevicesClaim.renderBanner() alongside
    //  installable ones, with routing handled by DevicesClaim.claimSelected.)

    _renderArchiveSection(devices) {
        if (devices.length === 0) return '';

        const caret = this._archiveExpanded ? '▾' : '▸';
        if (!this._archiveExpanded) {
            return `
                <div class="section-header" style="margin-top: 32px; cursor: pointer;" onclick="DevicesPage._toggleArchive()">
                    ${caret} Archived (${devices.length})
                </div>
            `;
        }

        const rows = devices.map(d => `
            <div class="card" style="margin-bottom: 8px;">
                <div class="card-body" style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
                    <div style="display: flex; align-items: center; gap: 12px; min-width: 0;">
                        <div class="device-card-icon">${this._deviceIcon(d.device_type)}</div>
                        <div style="min-width: 0;">
                            <div style="font-weight: 500;">${this._escape(d.device_name || 'Unnamed')}</div>
                            <div style="color: var(--text-muted); font-size: var(--font-size-sm);">
                                ${this._escape(d.device_type || '—')} · last seen ${this._formatTime(d.last_seen_at)}
                            </div>
                        </div>
                    </div>
                    <div style="flex-shrink: 0;">
                        <button class="btn btn-secondary btn-sm" ${this._deletingId === d.device_id ? 'disabled' : ''}
                            onclick="DevicesPage._deleteArchived('${this._escape(d.device_id)}', '${this._escape(d.device_name || 'this device')}')">
                            ${this._deletingId === d.device_id ? 'Deleting…' : 'Delete'}
                        </button>
                    </div>
                </div>
            </div>
        `).join('');

        return `
            <div class="section-header" style="margin-top: 32px; cursor: pointer;" onclick="DevicesPage._toggleArchive()">
                ${caret} Archived (${devices.length})
            </div>
            <div>${rows}</div>
        `;
    },

    _toggleArchive() {
        this._archiveExpanded = !this._archiveExpanded;
        App.renderPage();
    },

    async _deleteArchived(deviceId, deviceName) {
        if (!confirm(`Delete "${deviceName}" from your devices? This cannot be undone.`)) return;
        this._deletingId = deviceId;
        App.renderPage();
        try {
            await DashieAuth.dbRequest('delete_device', { device_id: deviceId });
            // Drop it from the local cache
            this._devices = this._devices.filter(d => d.device_id !== deviceId);
            Toast.success(`Deleted "${deviceName}"`);
        } catch (e) {
            console.error('[DevicesPage] Delete failed:', e);
            Toast.error(Toast.friendly(e, 'delete this device'));
        } finally {
            this._deletingId = null;
            App.renderPage();
        }
    },

    _renderDeviceCard(device) { return DevicesCard.render(device); },

    _renderDetail() { return DevicesDetail.render(this._findDevice(this._detailDeviceId)); },

    async _onSettingChange(deviceId, category, key, value) {
        // "Apply to all devices" — when the checkbox in an open settings modal is
        // ticked, fan the same (category, key, value) out to every active device
        // instead of just the one being edited. Read from the DOM at call time so
        // there's no flag to keep in sync (only one settings modal is open at a
        // time, so at most one such checkbox exists). Uses the per-key-merge
        // update_device_settings RPC per device — NOT sync_settings_to_all_devices,
        // which is TV-only and whole-category-replace (would wipe sibling keys).
        // Read the ARMED FLAG (module state), not the DOM checkbox — a
        // background re-render can rebuild the modal and reset a DOM-only
        // checkbox, which silently reduced the fan-out to just the open
        // device (2026-07-06). Fall back to the DOM box if the modals module
        // isn't present.
        const applyAll = (typeof DevicesDetailModals !== 'undefined'
            && DevicesDetailModals._applyAllArmed === true)
            || (typeof document !== 'undefined'
                && !!document.getElementById('device-apply-to-all')?.checked);
        const targets = applyAll
            ? (this._devices || []).filter(d => d.is_active !== false)
            : [this._findDevice(deviceId)].filter(Boolean);

        const savingKey = `${deviceId}_${key}`;
        this._saving[savingKey] = true;

        try {
            for (const device of targets) {
                await DashieAuth.dbRequest('update_device_settings', {
                    device_id: device.device_id,
                    settings_path: category,
                    settings_value: { [key]: value },
                });
                device.settings = device.settings || {};
                device.settings[category] = device.settings[category] || {};
                device.settings[category][key] = value;
                // Live-push to the device so it applies now (not only on next reload) and
                // its readback can't revert us — send the FULL merged category. Q4 fix.
                DashieAuth._broadcastDeviceSettingsChanged(
                    device.device_id, category, device.settings[category]
                ).catch(() => {});
            }
        } catch (e) {
            console.error('[DevicesPage] Save failed:', e);
            Toast.error(Toast.friendly(e, 'save this setting'));
        } finally {
            delete this._saving[savingKey];
            // Skip the re-render when any DevicesDetailModals modal is open —
            // App.renderPage replaces the entire #content innerHTML, which
            // destroys + recreates the open modal mid-interaction and causes
            // the flash the user reported. The browser already reflects the
            // picker's new value, and the in-memory device.settings was
            // updated above. When the modal closes (closeX → renderPage),
            // the underlying summary row picks up the fresh value.
            if (!this._isAnyDetailModalOpen()) {
                App.renderPage();
            }
        }
    },

    /** True iff any DevicesDetailModals modal is currently open. Used by
     *  _onSettingChange to avoid tearing down the modal DOM on save. */
    _isAnyDetailModalOpen() {
        const M = typeof DevicesDetailModals !== 'undefined' ? DevicesDetailModals : null;
        if (!M) return false;
        return !!(M._sleepOpen || M._displayOpen || M._themeOpen
            || M._pickerOpen || M._screensaverOpen || M._advancedDisplayOpen || M._personalityOpen
            || M._wakeWordOpen || M._pinOpen || M._photosOpen);
    },

    showDetail(deviceId) {
        this._detailDeviceId = deviceId;
        App.renderPage();
    },

    backToList() {
        this._detailDeviceId = null;
        App.renderPage();
    },

    _deviceIcon(deviceType) {
        if (!deviceType) return '🖥';
        const lower = deviceType.toLowerCase();
        if (lower.includes('fire') || lower.includes('tv')) return '🖥';
        if (lower.includes('tablet') || lower.includes('sm-') || lower.includes('ipad')) return '📱';
        return '🖥';
    },

    /** Friendly type label combining the registered category prefix with the
     *  HA-reported model. Examples: "Tablet · SM-X200", "TV · AFTMM". */
    _typeLabel(device) {
        const model = device?.metrics?.app?.device_model || device?.device_metadata?.model || null;
        const raw = device?.device_type || '';
        const prefix = raw.split('_')[0];
        const cat = { tv: 'TV', tablet: 'Tablet', computer: 'Computer', phone: 'Phone' }[prefix]
            || (prefix ? prefix.charAt(0).toUpperCase() + prefix.slice(1) : null);
        if (model && cat) return `${cat} · ${model}`;
        return model || raw || '—';
    },

    _formatTime(iso) {
        if (!iso) return '—';
        try {
            const then = new Date(iso).getTime();
            const now = Date.now();
            const diffSec = Math.floor((now - then) / 1000);
            if (diffSec < 60) return `${diffSec}s ago`;
            if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
            if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
            return `${Math.floor(diffSec / 86400)}d ago`;
        } catch (e) {
            return iso;
        }
    },

    _escape(str) {
        if (!str) return '';
        // Escape both quote characters too — values get inlined into HTML
        // attribute contexts (onclick="…", title="…"), and an unescaped
        // " or ' closes the attribute mid-string. Device names like
        // "Lerch Kitchen 15\"" with the literal inch mark were breaking
        // the chip onclick handler — the openHistory call got truncated
        // and clicking the chip silently did nothing.
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },
};
