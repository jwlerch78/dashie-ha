/* ============================================================
   Devices Camera — multipart MJPEG in a plain <img>
   ------------------------------------------------------------
   The browser handles multipart/x-mixed-replace MJPEG natively
   when set as an <img> src — each new frame from the server
   replaces the rendered image in place, no Hls.js, no <video>,
   no iframe, no shadow-DOM gymnastics.

   The add-on's /api/ha/mjpeg/:deviceId/:role route loops the
   same HA signed-URL fetch the still-image route uses and wraps
   each JPEG in a multipart envelope at ~10 fps. When the user
   closes the modal, removing the <img> from the DOM disconnects
   the long-running request and the add-on cleans up its loop.
   ============================================================ */

const DevicesCamera = {
    _open: null,

    open(deviceId) {
        if (!DashieAuth.isAddonMode) return;
        this._open = { deviceId };
        App.renderPage();
    },

    close() {
        this._open = null;
        App.renderPage();
    },

    _maybeCloseBackdrop(e) {
        if (e.target === e.currentTarget) this.close();
    },

    render() {
        const m = this._open;
        if (!m) return '';
        const device = DevicesPage._findDevice(m.deviceId);
        const name = device?.device_name || 'Camera';
        const escName = DevicesPage._escape(name);
        const src = DashieAuth._addonUrl(`/api/ha/mjpeg/${encodeURIComponent(m.deviceId)}/camera`);

        return `
            <div onclick="DevicesCamera._maybeCloseBackdrop(event)"
                 style="position: fixed; inset: 0; background: rgba(0,0,0,0.92); z-index: 1100; display: flex; align-items: center; justify-content: center; padding: 24px; cursor: zoom-out;">
                <div onclick="event.stopPropagation()"
                     style="display: flex; flex-direction: column; gap: 10px; max-width: 95vw; max-height: 92vh; cursor: default;">
                    <div style="display: flex; align-items: center; justify-content: space-between; color: white;">
                        <strong>${escName}</strong>
                        <button onclick="DevicesCamera.close()"
                            style="background: rgba(255,255,255,0.15); color: white; border: 1px solid rgba(255,255,255,0.25); border-radius: 4px; padding: 4px 12px; cursor: pointer;">Close</button>
                    </div>
                    <img src="${src}" alt="${escName}"
                        style="max-width: 95vw; max-height: 82vh; object-fit: contain; background: #000; border-radius: 6px;">
                </div>
            </div>
        `;
    },
};
