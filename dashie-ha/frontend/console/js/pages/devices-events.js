/* ============================================================
   Devices live events — SSE client.
   ------------------------------------------------------------
   Connects to /api/ha/events and listens for HA state_changed events
   (forwarded by the add-on, enriched with {device_id, role, state}).
   Updates DevicesPage._liveOverrides so cards re-render with fresh data
   immediately. Re-render is debounced to ~80ms so a burst of events
   doesn't cause render storms.
   ============================================================ */

const DevicesEvents = {
    _es: null,
    _renderTimer: null,

    start() {
        if (this._es || !DashieAuth.isAddonMode) return;
        const url = DashieAuth._addonUrl('/api/ha/events');
        try {
            this._es = new EventSource(url);
            this._es.onmessage = (e) => this._onMessage(e);
            this._es.onerror = (e) => {
                // EventSource auto-reconnects; nothing to do here unless we need a UI hint.
                if (this._es?.readyState === EventSource.CLOSED) {
                    console.warn('[DevicesEvents] connection closed');
                }
            };
        } catch (e) {
            console.warn('[DevicesEvents] start failed:', e.message);
        }
    },

    stop() {
        if (this._es) { this._es.close(); this._es = null; }
        if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
    },

    // Roles whose state changes should trigger a full-page re-render. Anything
    // not in this set either (a) handled via targeted DOM update below, or
    // (b) noisy numeric values (battery, ram_usage, wifi_signal) that don't
    // need a repaint — they still update internally and surface on the next
    // render that fires for any reason.
    STRUCTURAL_ROLES: new Set([
        'lock', 'screen', 'screensaver', 'screensaver_active',
        'dark_mode', 'keep_screen_on', 'auto_brightness',
        'volume', 'brightness',
        // RTSP/camera state is what gates the motion/face slash overlay too,
        // so any of these changing should re-render to flip those icons.
        'camera', 'camera_stream_url', 'rtsp_stream', 'camera_stream_enabled',
    ]),

    _onMessage(e) {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type !== 'state' || !msg.device_id || !msg.role) return;
        DevicesPage._applyLiveOverride(msg);

        // Only touch the DOM when the Devices page is actually mounted. The SSE
        // stays connected after navigating away, so without this guard a device
        // event would re-render whatever page the user is on — e.g. wiping a
        // half-typed edit on the Family page (the bug this prevents). The live
        // override above is still recorded, so Devices shows fresh state the
        // moment it's reopened.
        if (typeof App !== 'undefined' && App._currentPage !== 'devices') return;

        // Motion / face fire frequently. Update just the affected icon's DOM
        // in place — no full re-render, so all other <img>s on the page stay
        // intact (no thumbnail flash on every detection event).
        if (msg.role === 'motion_detected' || msg.role === 'face_detected') {
            const role = msg.role === 'motion_detected' ? 'motion' : 'face';
            // The *_active flag tracks whether the device is actually scanning
            // for this signal. It's "off" only when HA reports the sensor as
            // unavailable (= detection toggle off). _applyLiveOverride above
            // already updated metrics.presence.{motion,face}_active based on
            // this very event's state, so just read it back.
            const fresh = DevicesPage._freshDeviceFor(msg.device_id);
            const active = fresh?.metrics?.presence?.[`${role}_active`] !== false;
            DevicesCard.updateDetectIcon(msg.device_id, role, msg.state === 'on', active);
            return;
        }

        if (DevicesCamera._open) return;
        if (!this.STRUCTURAL_ROLES.has(msg.role)) return;
        if (this._renderTimer) return;
        this._renderTimer = setTimeout(() => {
            this._renderTimer = null;
            if (DevicesCamera._open) return;
            App.renderPage();
        }, 250);
    },
};
