// Devices card: header [icon name lock status] / stats chips / media row
// (screenshot+camera with controls) / music strip when playing.
const ICON = path => `assets/icons/${path}`;
const iconImg = (path, size = 16, extraStyle = '') =>
    `<img src="${ICON(path)}" alt="" style="width: ${size}px; height: ${size}px; vertical-align: middle; ${extraStyle}">`;

const DevicesCard = {
    _busyControl: {},   // `${deviceId}:${role}` → bool
    _sliderOpen: null,
    _screenshotTs: {},  // per-device cache-bust ts; bumped on manual refresh / post-toggle
    _cameraFailed: {},  // `${deviceId}:${ts}` → true when the camera frame 404'd (collapse the column)
    _ssMeta: {},        // deviceId → { updated: iso|null, at: ms } — screenshot capture time (for the "Nm ago" badge)
    _initialTs: Date.now(),
    _screenshotModal: null,
    _historyOpen: null,

    render(device) {
        const idAttr = DevicesPage._escape(device.device_id);
        const live = DevicesPage._isLive(device);
        const conflict = DevicesPage._conflictHaName(device);
        // Prefer the worker's freshly-extracted metrics (refreshed every 5s)
        // over the Supabase-cached row (refreshed every 30s) so motion/face
        // and other live bits show up promptly.
        const fresh = DevicesPage._freshDeviceFor(device.device_id);
        const m = fresh?.metrics || device.metrics || {};

        const statusBadge = live
            ? '<span class="status-dot online" title="Live"></span>'
            : `<span style="font-size: 11px; color: var(--text-secondary);">${DevicesPage._formatTime(device.last_seen_at)}</span> <span class="status-dot offline"></span>`;

        // Two render modes — "technical" (battery/RAM/wifi/screenshot/camera/
        // lock/full controls) for HA users; "simple" (settings summary +
        // small control set) for less-technical users on the public web.
        // Toggle lives on DevicesPage.topBarActions; default flips by context.
        if (!DevicesPage._techView) {
            return this._renderSimple(device, idAttr, live, conflict, m, statusBadge);
        }
        return `
            <div class="card card-clickable" onclick="DevicesPage.showDetail('${idAttr}')">
                <div class="card-body" style="padding: 12px;">
                    ${this._renderHeader(device, idAttr, statusBadge, conflict)}
                    ${this._renderStatsRow(device, idAttr, m)}
                    ${this._renderMediaRow(device, idAttr, m)}
                    ${this._renderMusicStrip(m)}
                </div>
            </div>
        `;
    },

    /**
     * Simple-mode card: shows what the dashboard is doing right now (theme,
     * sleep schedule, AI personality, photos album) instead of the
     * device's hardware telemetry. Smaller control set: reload, screen
     * on/off, light/dark, volume — no lock, no camera, no screenshot.
     */
    _renderSimple(device, idAttr, live, conflict, m, statusBadge) {
        const offlineStyle = !live ? 'opacity: 0.4; pointer-events: none;' : '';
        return `
            <div class="card card-clickable" onclick="DevicesPage.showDetail('${idAttr}')">
                <div class="card-body" style="padding: 12px;">
                    ${this._renderSimpleHeader(device, idAttr, conflict)}
                    <div style="${offlineStyle}">
                        ${this._renderSimpleSettings(device, m)}
                        ${this._renderSimpleControls(device, idAttr, m)}
                    </div>
                </div>
            </div>
        `;
    },

    /**
     * Offline card — minimal render for devices in the Offline section.
     * Just the header row: icon + name + type + last-seen + status dot.
     * No lock chip (intentionally hidden — offline devices can't toggle
     * anything anyway), no stats, no panels, no controls.
     */
    renderOffline(device) {
        const idAttr = DevicesPage._escape(device.device_id);
        const conflict = DevicesPage._conflictHaName(device);
        const statusBadge = `<span style="font-size: 11px; color: var(--text-secondary);">${DevicesPage._formatTime(device.last_seen_at)}</span> <span class="status-dot offline"></span>`;
        const icon = DevicesPage._deviceIcon(device.device_type);
        const conflictChip = conflict
            ? `<span title="HA: ${DevicesPage._escape(conflict)}" style="color: var(--accent); font-size: 11px; margin-left: 6px;">⚠</span>`
            : '';
        return `
            <div class="card card-clickable" onclick="DevicesPage.showDetail('${idAttr}')">
                <div class="card-body" style="padding: 12px;">
                    <div style="display: flex; align-items: flex-start; gap: 10px;">
                        <div class="device-card-icon" style="flex-shrink: 0;">${icon}</div>
                        <div style="flex: 1; min-width: 0;">
                            <div style="display: flex; align-items: center; gap: 8px; font-weight: 600;">
                                <span>${DevicesPage._escape(device.device_name || 'Unnamed Device')}</span>
                                ${conflictChip}
                            </div>
                            <div class="device-card-type" style="margin-top: 2px;">${DevicesPage._escape(DevicesPage._typeLabel(device))}</div>
                        </div>
                        <div style="flex-shrink: 0; align-self: flex-start; display: flex; align-items: center; gap: 4px;">
                            ${statusBadge}
                            <button title="Dismiss — hide this device from the Offline list. Restore from the Dismissed section at the bottom of the page."
                                onclick="event.stopPropagation(); DevicesPage.dismissDevice('${idAttr}')"
                                style="background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 14px; padding: 2px 6px; line-height: 1;">✕</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    },

    /** Simplified header — name + type + lock chip top-right. */
    _renderSimpleHeader(device, idAttr, conflict) {
        const icon = DevicesPage._deviceIcon(device.device_type);
        const conflictChip = conflict
            ? `<span title="HA: ${DevicesPage._escape(conflict)}" style="color: var(--accent); font-size: 11px; margin-left: 6px;">⚠</span>`
            : '';
        return `
            <div style="display: flex; align-items: flex-start; gap: 10px;">
                <div class="device-card-icon" style="flex-shrink: 0;">${icon}</div>
                <div style="flex: 1; min-width: 0;">
                    <div style="display: flex; align-items: center; gap: 8px; font-weight: 600;">
                        <span>${DevicesPage._escape(device.device_name || 'Unnamed Device')}</span>
                        ${conflictChip}
                    </div>
                    <div class="device-card-type" style="margin-top: 2px;">${DevicesPage._escape(DevicesPage._typeLabel(device))}</div>
                </div>
                <div style="flex-shrink: 0; align-self: flex-start; display: flex; align-items: center; gap: 4px;">${this._buildLockChip(device, idAttr)}</div>
            </div>
        `;
    },

    /** Simple settings summary: Theme · Sleep · AI Personality · Photos.
     *  Keys here MUST match what the app writes into user_devices.settings.<category>
     *  via SETTINGS_KEY_MAP (device-settings-writer.js) — NOT dot-notated store paths.
     *  Real blob shape (see a live row): display.{themeFamily,themeMode,darkMode},
     *  sleep.{enabled,sleepTime,wakeTime}, aiVoice.personalityId, photos.{albumName,sourceType}. */
    _renderSimpleSettings(device, m) {
        const settings = device.settings || {};
        const display = settings.display || {};
        const sleep = settings.sleep || {};
        const aiVoice = settings.aiVoice || {};
        const photos = settings.photos || {};

        // Theme — the FAMILY only. Dark/Light mode is a separate control (the
        // Quick Controls light/dark pill), deliberately NOT folded into the
        // theme name (2026-07-06, per user).
        const theme = display.themeFamily ? this._prettify(display.themeFamily) : 'Default';

        // AI Personality — the device blob stores personalityId (template key or
        // custom uuid); resolve it to the catalog's display name.
        const aiPersonality = DevicesDetailModals.personalityName(aiVoice.personalityId);

        // Photos — show the album, not the source: Immich → its selected-album
        // summary; Dashie Cloud → the named album; otherwise fall back to the
        // source type (unsplash, google_drive, …) or 'Default'.
        const photoAlbum = photos.sourceType === 'immich'
            ? DevicesDetailModals.immichAlbumSummary(photos)
            : (photos.albumName
                ? this._prettify(photos.albumName)
                : (photos.sourceType ? this._prettify(photos.sourceType) : 'Default'));

        // Sleep / Wake — only a live schedule when enabled and both times set.
        const sleepSchedule = (sleep.enabled && sleep.sleepTime && sleep.wakeTime)
            ? `${this._formatTime12(sleep.sleepTime)} – ${this._formatTime12(sleep.wakeTime)}`
            : 'Off';

        // Each row opens the matching editor modal. stopPropagation keeps the
        // card's click-to-detail navigation from also firing. The ‹edit› chevron
        // signals the row is tappable.
        const id = device.device_id;
        const row = (label, value, openCall) => `
            <div onclick="event.stopPropagation(); ${openCall}"
                 style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; font-size: var(--font-size-sm); cursor: pointer;"
                 onmouseover="this.style.opacity=0.65" onmouseout="this.style.opacity=1">
                <span style="color: var(--text-secondary);">${label}</span>
                <span style="font-weight: 500; color: var(--text-primary); text-align: right; max-width: 62%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${DevicesPage._escape(value)}<span style="color: var(--text-muted); margin-left: 6px;">›</span></span>
            </div>
        `;
        return `
            <div style="margin-top: 12px; border-top: 1px solid var(--border, #e5e7eb); padding-top: 4px;">
                ${row('Theme', theme, `DevicesDetailModals.openTheme('${id}')`)}
                ${row('Sleep / Wake', sleepSchedule, `DevicesDetailModals.openSleep('${id}')`)}
                ${row('AI Personality', aiPersonality, `DevicesDetailModals.openVoicePersonality('${id}')`)}
                ${row('Photos', photoAlbum, `DevicesDetailModals.openPhotos('${id}')`)}
            </div>
        `;
    },

    /** Compact controls: reload · screen on/off · light/dark · volume. */
    _renderSimpleControls(device, idAttr, m) {
        const dark = !!m.controls?.dark_mode;
        const screenOn = m.controls?.screen !== false;
        const reloadBusy = !!this._busyControl[`${device.device_id}:reload`];
        const screenBusy = !!this._busyControl[`${device.device_id}:screen`];
        const darkBusy = !!this._busyControl[`${device.device_id}:dark_mode`];

        const reloadIcon = `
            <button title="Reload dashboard" ${reloadBusy ? 'disabled' : ''}
                onclick="event.stopPropagation(); DevicesCard.pressButton('${idAttr}', 'reload')"
                style="display: inline-flex; align-items: center; justify-content: center; padding: 4px 10px; border-radius: 999px; border: 1px solid #d1d5db; background: #f3f4f6; cursor: ${reloadBusy ? 'wait' : 'pointer'}; opacity: ${reloadBusy ? 0.5 : 1}; line-height: 0;">
                ${iconImg('icon-reload.svg', 14)}
            </button>
        `;
        const screenPill = this._renderPill({
            idAttr, role: 'screen', currentlyOn: screenOn,
            iconFile: 'icon-tv.svg', busy: screenBusy,
            title: screenOn ? 'Screen on — tap to turn off' : 'Screen off — tap to turn on',
            // Screen on = orange (#f97316), off = black (#1f2937). White
            // icon on both sides so it reads against either fill.
            palette: { onBg: '#f97316', offBg: '#1f2937', onBorder: '#f97316', offBorder: '#1f2937', onIconInvert: true, offIconInvert: true },
        });
        const lightDarkPill = this._renderPill({
            idAttr, role: 'dark_mode', currentlyOn: dark,
            iconFile: dark ? 'icon-moon.svg' : 'icon-sun.svg', busy: darkBusy,
            title: dark ? 'Dark mode — tap for light' : 'Light mode — tap for dark',
            // Dark mode (currentlyOn=true) = black with white moon icon.
            // Light mode (off) = orange (#f97316) with white sun icon —
            // user feedback: the previous white pill blended with the
            // card background and felt like "no state."
            palette: { onBg: '#1f2937', offBg: '#f97316', onBorder: '#1f2937', offBorder: '#f97316', onIconInvert: true, offIconInvert: true },
        });

        // Volume — small chip showing current value, click opens slider.
        let volumeBtn = '';
        if (m.controls?.volume != null) {
            const display = this._scaleTo10(m.controls.volume, m.controls.volume_max);
            const muted = m.controls.volume === 0;
            const volIcon = muted ? 'icon-volume-mute.svg' : 'icon-volume-high.svg';
            volumeBtn = `
                <button class="device-card-detail" style="cursor: pointer; display: inline-flex; align-items: center; gap: 4px; background: #f3f4f6; border: 1px solid #d1d5db; padding: 4px 10px; border-radius: 999px;" title="Adjust volume"
                    onclick="event.stopPropagation(); DevicesCard.openSlider('${idAttr}', 'volume', ${m.controls.volume}, ${m.controls.volume_max ?? 'null'})">
                    ${iconImg(volIcon, 14)}<span style="font-size: 13px;">${muted ? 'Muted' : display}</span>
                </button>
            `;
        }

        return `
            <div style="display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-top: 12px;">
                ${reloadIcon}
                ${screenPill}
                ${lightDarkPill}
                ${volumeBtn}
            </div>
        `;
    },

    _prettify(value) {
        if (!value) return '—';
        return String(value).split(/[_\-\s]/).filter(Boolean)
            .map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    },

    _formatTime12(hhmm) {
        if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return hhmm || '';
        const [h, m] = hhmm.split(':').map(Number);
        const period = h >= 12 ? 'PM' : 'AM';
        const h12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
        return `${h12}:${String(m).padStart(2, '0')} ${period}`;
    },

    /**
     * Interactive lock chip — shown in the top-right of online device cards
     * (both tech-mode and simple-mode headers). Removed entirely from the
     * Offline section per UX request. Colored badge for locked, outline +
     * lower-opacity for unlocked.
     */
    _buildLockChip(device, idAttr) {
        const locked = !!device.metrics?.controls?.lock;
        const lockBusy = !!this._busyControl[`${device.device_id}:lock`];
        const lockBg = locked ? '#f97316' : 'transparent';
        const lockBorder = locked ? '#f97316' : '#d1d5db';
        const lockFilter = locked ? 'filter: brightness(0) invert(1);' : '';
        const lockOpacity = lockBusy ? 0.4 : (locked ? 1 : 0.6);
        const lockIconFile = locked ? 'icon-lock.svg' : 'icon-unlock.svg';
        return `
            <button title="${locked ? 'Locked — tap to unlock' : 'Unlocked — tap to lock'}" ${lockBusy ? 'disabled' : ''}
                onclick="event.stopPropagation(); DevicesCard.toggleSwitch('${idAttr}', 'lock', ${locked})"
                style="background: ${lockBg}; border: 1px solid ${lockBorder}; cursor: ${lockBusy ? 'wait' : 'pointer'}; padding: 3px; border-radius: 50%; line-height: 0; opacity: ${lockOpacity};">
                ${iconImg(lockIconFile, 12, lockFilter)}
            </button>`;
    },

    _renderHeader(device, idAttr, statusBadge, conflict) {
        const icon = DevicesPage._deviceIcon(device.device_type);
        // Lock chip lives in the top-right of the header (was previously
        // inline next to the name; status dot occupied this slot). Green
        // "online" dot removed — the Online section heading conveys liveness.
        const conflictChip = conflict
            ? `<span title="HA: ${DevicesPage._escape(conflict)}" style="color: var(--accent); font-size: 11px; margin-left: 6px;">⚠</span>`
            : '';
        return `
            <div style="display: flex; align-items: flex-start; gap: 10px;">
                <div class="device-card-icon" style="flex-shrink: 0;">${icon}</div>
                <div style="flex: 1; min-width: 0;">
                    <div style="display: flex; align-items: center; gap: 8px; font-weight: 600;">
                        <span>${DevicesPage._escape(device.device_name || 'Unnamed Device')}</span>
                        ${conflictChip}
                    </div>
                    <div class="device-card-type" style="margin-top: 2px;">${DevicesPage._escape(DevicesPage._typeLabel(device))}</div>
                </div>
                <div style="flex-shrink: 0; align-self: flex-start; display: flex; align-items: center; gap: 4px;">${this._buildLockChip(device, idAttr)}</div>
            </div>
        `;
    },

    _renderStatsRow(device, idAttr, m) {
        const chips = [];
        const slug = DevicesPage._haSlugForDevice(device.device_id);
        const entityIds = DevicesPage._haEntityIdsForDevice(device.device_id);
        const deviceLabel = device.device_name || 'Device';
        // Battery / RAM / Wi-Fi chips: open a Console-native history chart
        // (data via /api/ha/history). Use the worker-resolved entity_id when
        // available (correct even for partial-migration devices like Mio 15"
        // whose entity_id slug doesn't match the anchor slug). Fall back to
        // sensor.<slug>_<suffix> reconstruction for the boot-time window
        // before the worker has populated entity_ids.
        // When neither path produces a usable entity_id, stopPropagation
        // so clicking the chip doesn't bubble up to the card's showDetail
        // handler (user expects "click metric → see history or nothing,"
        // not a page switch).
        const historyLink = (role, label) => {
            const entityId = entityIds[role] || (slug ? `sensor.${slug}_${role}` : null);
            if (!entityId) return `onclick="event.stopPropagation()"`;
            return `style="cursor: pointer;" title="${label} — open history" onclick="event.stopPropagation(); DevicesCard.openHistory('${entityId}', '${DevicesPage._escape(deviceLabel + ' · ' + label)}')"`;
        };
        if (m.battery?.level != null) {
            const charge = m.battery.charging ? '⚡' : '🔋';
            chips.push(`<span class="device-card-detail" ${historyLink('battery', 'Battery')}>${charge} ${m.battery.level}%</span>`);
        }
        if (m.system?.ram_used_percent != null) {
            chips.push(`<span class="device-card-detail" ${historyLink('ram_usage', 'RAM')}>RAM ${m.system.ram_used_percent}%</span>`);
        }
        if (m.network?.wifi_signal_percent != null) {
            chips.push(`<span class="device-card-detail" ${historyLink('wifi_signal', 'Wi-Fi')}>📶 ${m.network.wifi_signal_percent}%</span>`);
        }
        const room = device.metrics?.ha_area || device.ha_area;
        if (room) chips.push(`<span class="device-card-detail">🏠 ${DevicesPage._escape(room)}</span>`);

        if (m.controls?.volume != null) {
            const display = this._scaleTo10(m.controls.volume, m.controls.volume_max);
            const muted = m.controls.volume === 0;
            const volIcon = muted ? 'icon-volume-mute.svg' : 'icon-volume-high.svg';
            chips.push(`
                <span class="device-card-detail" style="cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" title="Adjust volume"
                    onclick="event.stopPropagation(); DevicesCard.openSlider('${idAttr}', 'volume', ${m.controls.volume}, ${m.controls.volume_max ?? 'null'})">
                    ${iconImg(volIcon, 12)}${muted ? 'Muted' : display}
                </span>
            `);
        }
        if (m.controls?.brightness != null) {
            const display = this._scaleTo10(m.controls.brightness, m.controls.brightness_max);
            chips.push(`
                <span class="device-card-detail" style="cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" title="Adjust brightness"
                    onclick="event.stopPropagation(); DevicesCard.openSlider('${idAttr}', 'brightness', ${m.controls.brightness}, ${m.controls.brightness_max ?? 'null'})">
                    ${iconImg('icon-sun.svg', 12)}${display}
                </span>
            `);
        }

        if (chips.length === 0) {
            return `<div style="font-size: var(--font-size-sm); color: var(--text-muted); margin-top: 12px;">No live metrics yet</div>`;
        }
        return `<div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px;">${chips.join('')}</div>`;
    },

    _renderMediaRow(device, idAttr, m) {
        const panelOuter = 'position: relative; background: var(--bg-muted, #f7f7f8); border: 1px dashed var(--border, #e5e7eb); border-radius: 4px; aspect-ratio: 16/9; overflow: hidden;';
        const panelEmpty = panelOuter + 'display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--text-muted);';
        // Stable cache-bust per device: same value across re-renders within a
        // page-load session so auto-refresh doesn't flash the thumbnails. Bumped
        // by the manual refresh button or after a screen toggle.
        const ts = this._screenshotTs[device.device_id] || this._initialTs;
        const isLive = DevicesPage._isLive(device);
        // imageReady: just trust isLive. metrics_updated_at as a precondition
        // breaks freshly-adopted devices — the user_devices row exists and the
        // worker is producing live data (has_live_data=true via freshDevices),
        // but the Console's cached list_devices result still has
        // metrics_updated_at=null for up to LIST_DEVICES_REFRESH_MS until the
        // next refetch. isLive already handles both the cached and worker
        // signals; if it's true, the screenshot/camera endpoints will serve.
        const imageReady = DashieAuth.isAddonMode && isLive;
        const screenshotSrc = imageReady
            ? DashieAuth._addonUrl(`/api/ha/image/${encodeURIComponent(device.device_id)}/screenshot?t=${ts}`)
            : null;
        // Camera live frame iff the device's camera entity is in 'streaming' state
        // (camera_streaming) or — fallback for devices that don't surface that —
        // the camera_stream_enabled switch is on.
        const cameraLive = m.controls?.camera_streaming || m.controls?.camera_stream_enabled;
        const cameraSrc = imageReady && cameraLive
            ? DashieAuth._addonUrl(`/api/ha/image/${encodeURIComponent(device.device_id)}/camera?t=${ts}`)
            : null;
        const imgStyle = 'width: 100%; height: 100%; object-fit: cover; display: block;';
        // Screen off overlay — fade the screenshot and show "Screen off" text on top.
        // Only trust controls.screen when we DON'T have a fresh screenshot stream.
        // When imageReady is true, the device is actively producing screenshots —
        // a contradictory controls.screen=false is almost always a stale flag
        // (some devices fail to flip it back to true after sleep/wake races).
        // The live image is the source of truth in that case.
        const screenOff = m.controls?.screen === false && !imageReady;
        const overlay = screenOff
            ? `<div style="position: absolute; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; color: white; font-size: 13px; font-weight: 500; pointer-events: none;">Screen off</div>`
            : '';
        const screenshotPanel = !isLive
            ? `<div style="${panelOuter} display: flex; align-items: center; justify-content: center; color: var(--text-muted);">
                   <span style="font-size: 13px; font-weight: 500;">Offline</span>
               </div>`
            : screenshotSrc
                ? `<div style="${panelOuter} cursor: zoom-in;" onclick="event.stopPropagation(); DevicesCard.openScreenshotModal('${idAttr}')">
                       <img src="${screenshotSrc}" alt="screenshot" style="${imgStyle}" onload="DevicesCard.markScreenshotTime('${idAttr}')" onerror="this.style.display='none'; this.parentElement.querySelector('.placeholder-fallback').style.display='flex';">
                       <span class="placeholder-fallback" style="display: none; position: absolute; inset: 0; align-items: center; justify-content: center; font-size: 11px; color: var(--text-muted);">no screenshot</span>
                       <span data-ss-age="${idAttr}" style="position: absolute; bottom: 4px; left: 4px; background: rgba(0,0,0,0.6); color: #fff; font-size: 10px; line-height: 1; padding: 2px 5px; border-radius: 4px; pointer-events: none;"></span>
                       ${overlay}
                   </div>`
                : `<div style="${panelEmpty}">screenshot</div>`;
        // Camera offline = configured but currently off (camera_stream_enabled === false).
        // Show a clear "Camera offline" placeholder with a slashed camera icon.
        const cameraConfigured = m.controls?.camera_stream_enabled !== undefined;
        const slashSvg = (size, color = '#9ca3af', strokeW = 2.5, opacity = 1) => `<span style="position: absolute; inset: 0; pointer-events: none; opacity: ${opacity};"><svg viewBox="0 0 ${size} ${size}" style="width: 100%; height: 100%;"><line x1="${size*0.15}" y1="${size*0.85}" x2="${size*0.85}" y2="${size*0.15}" stroke="${color}" stroke-width="${strokeW}" stroke-linecap="round"/></svg></span>`;
        const cameraOffPanel = `
            <div style="${panelOuter} display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 6px; color: var(--text-muted);">
                <span style="position: relative; display: inline-block; line-height: 0; width: 32px; height: 32px;">${iconImg('icon-video-camera.svg', 28, 'opacity: 0.5;')}${slashSvg(32)}</span>
                <span style="font-size: 11px;">Camera off</span>
            </div>`;
        const cameraPanel = cameraSrc
            ? `<div style="${panelOuter} cursor: zoom-in;" onclick="event.stopPropagation(); DevicesCamera.open('${idAttr}')">
                   <img src="${cameraSrc}" alt="camera" style="${imgStyle}" onerror="DevicesCard.onCameraError('${idAttr}')">
               </div>`
            : cameraOffPanel;
        const dark = !!m.controls?.dark_mode;
        const screenOn = m.controls?.screen !== false;
        const cameraOn = !!(m.controls?.camera_streaming || m.controls?.camera_stream_enabled);
        const motion = !!m.presence?.motion;
        const face = !!m.presence?.face;
        // *_active comes from whether HA reports the binary sensor as
        // available — the device sets it unavailable when the corresponding
        // detection toggle is off (no scanning). When the flag is missing
        // (older states / no observation yet) default to true so existing
        // devices show the active+clear/detected look rather than the slash.
        const motionActive = m.presence?.motion_active !== false;
        const faceActive = m.presence?.face_active !== false;
        const reloadBusy = !!this._busyControl[`${device.device_id}:reload`];
        const screenBusy = !!this._busyControl[`${device.device_id}:screen`];
        const darkBusy = !!this._busyControl[`${device.device_id}:dark_mode`];
        const camBusy = !!this._busyControl[`${device.device_id}:camera_stream_enabled`];

        // Reload in a pill so it matches the screen + light/dark visual style.
        const reloadIcon = `
            <button title="Reload dashboard" ${reloadBusy ? 'disabled' : ''}
                onclick="event.stopPropagation(); DevicesCard.pressButton('${idAttr}', 'reload')"
                style="display: inline-flex; align-items: center; justify-content: center; padding: 4px 10px; border-radius: 999px; border: 1px solid #d1d5db; background: #f3f4f6; cursor: ${reloadBusy ? 'wait' : 'pointer'}; opacity: ${reloadBusy ? 0.5 : 1}; line-height: 0;">
                ${iconImg('icon-reload.svg', 14)}
            </button>
        `;

        const screenPill = this._renderPill({
            idAttr, role: 'screen',
            currentlyOn: screenOn,
            iconFile: 'icon-tv.svg',
            busy: screenBusy,
            title: screenOn ? 'Screen on — tap to turn off' : 'Screen off — tap to turn on',
            // Screen on = orange (#f97316), off = black (#1f2937). White
            // icon on both sides so it reads against either fill.
            palette: { onBg: '#f97316', offBg: '#1f2937', onBorder: '#f97316', offBorder: '#1f2937', onIconInvert: true, offIconInvert: true },
        });

        const lightDarkPill = this._renderPill({
            idAttr, role: 'dark_mode',
            currentlyOn: dark,
            iconFile: dark ? 'icon-moon.svg' : 'icon-sun.svg',
            busy: darkBusy,
            title: dark ? 'Dark mode — tap for light' : 'Light mode — tap for dark',
            // Dark mode (currentlyOn=true) = black with white moon icon.
            // Light mode (off) = orange (#f97316) with white sun icon —
            // user feedback: the previous white pill blended with the
            // card background and felt like "no state."
            palette: { onBg: '#1f2937', offBg: '#f97316', onBorder: '#1f2937', offBorder: '#f97316', onIconInvert: true, offIconInvert: true },
        });

        // Camera toggle styled to match the screen / light-dark pills: an orange
        // pill with a white icon when streaming; an unfilled (gray-outlined) pill
        // with a dimmed gray icon + diagonal slash when off.
        const cameraIcon = `
            <button title="${cameraOn ? 'Camera streaming — tap to stop' : 'Camera off — tap to start'}" ${camBusy ? 'disabled' : ''}
                onclick="event.stopPropagation(); DevicesCard.toggleSwitch('${idAttr}', 'camera_stream_enabled', ${cameraOn})"
                style="display: inline-flex; align-items: center; justify-content: center; padding: 4px 10px; border-radius: 999px; border: 1px solid ${cameraOn ? '#f97316' : '#d1d5db'}; background: ${cameraOn ? '#f97316' : 'transparent'}; cursor: ${camBusy ? 'wait' : 'pointer'}; opacity: ${camBusy ? 0.5 : 1}; line-height: 0;">
                <span style="position: relative; display: inline-flex; line-height: 0;">
                    ${iconImg('icon-video-camera.svg', 14, cameraOn ? 'filter: brightness(0) invert(1);' : 'opacity: 0.45;')}
                    ${cameraOn ? '' : slashSvg(14, '#9ca3af', 2)}
                </span>
            </button>
        `;

        // Active state visual: thin orange border + light semi-transparent
        // orange fill covering both padding and icon (overlay layer above the
        // img). Inactive state visual: slash overlay over a dim icon — clearly
        // "detection is off", distinct from "idle/no detection right now".
        // data-detect-* attrs let SSE handlers update these spans in place
        // without a full re-render (motion/face fire frequently).
        // Hide motion / face icons entirely when their detection isn't running
        // on the device. The presence sensors go unavailable (motion_active /
        // face_active === false) when the toggle is off OR when the device
        // doesn't have a camera at all — in either case there's no signal to
        // show, so the slashed-icon-as-disabled affordance just adds noise.
        const motionIcon = motionActive ? `
            <span data-card-id="${idAttr}" data-detect-role="motion" title="${this._detectTitle('motion', motion, motionActive)}"
                  style="${this._detectIconStyle(motion)}">
                ${iconImg('icon-motion-detection.svg', 18, this._detectIconOpacity(motion, motionActive))}
                <span data-detect-overlay style="${this._detectOverlayStyle(motion)}"></span>
            </span>
        ` : '';
        const faceIcon = faceActive ? `
            <span data-card-id="${idAttr}" data-detect-role="face" title="${this._detectTitle('face', face, faceActive)}"
                  style="${this._detectIconStyle(face)}">
                ${iconImg('icon-face-detection.svg', 18, this._detectIconOpacity(face, faceActive))}
                <span data-detect-overlay style="${this._detectOverlayStyle(face)}"></span>
            </span>
        ` : '';

        // Three-column layout per media row: left / center / right justified.
        // 10% horizontal padding indents the left+right items inward so they don't sit
        // flush against the card edge. Offline devices: rows fade to 0.4 + clicks blocked.
        const offlineStyle = !isLive ? 'opacity: 0.4; pointer-events: none;' : '';
        const controlRow = (left, center, right) => `
            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; align-items: center; gap: 4px; margin-top: 8px; padding: 0 10%; ${offlineStyle}">
                <div style="justify-self: start; display: inline-flex;">${left}</div>
                <div style="justify-self: center; display: inline-flex;">${center}</div>
                <div style="justify-self: end; display: inline-flex;">${right}</div>
            </div>
        `;

        // Show the camera column when the device has actual camera hardware.
        // camera_resolution is the truth signal — but some devices without a
        // camera still report a placeholder value ('', '0x0', or similar)
        // rather than null/undefined, so a bare truthy check leaks the
        // panel onto non-camera devices like the Mio rk3576_u. Require a
        // real WxH resolution with both dimensions > 0.
        const hasCameraSection = DevicesCard._isRealCameraResolution(m.controls?.camera_resolution);

        // Sub-toggles — the user can hide the screenshot panel and/or the
        // camera panel individually from the top-bar Screenshots / Cameras
        // toggles. Controls stay; only the visual panels disappear.
        const showScreenshot = DevicesPage._showScreenshots;
        const showCamera = DevicesPage._showCameras;
        const screenshotSection = showScreenshot ? screenshotPanel : '';
        const cameraSection = showCamera ? cameraPanel : '';

        // Two-column layout only when the camera entity is ACTUALLY streaming
        // (camera_streaming) — not merely when the rtsp switch is enabled. Some
        // devices without a real camera report a placeholder resolution AND keep
        // the stream switch on, so they'd otherwise try to load a frame, 404,
        // and show a "no camera" box. Gating on camera_streaming collapses those.
        // Otherwise — no camera hardware, Cameras toggle off, or not streaming —
        // collapse to a single centered column instead of an empty/placeholder
        // ("no camera" / "Camera off") right column. In the collapsed layout the
        // screenshot is horizontally centered and ALL controls are centered in
        // one row beneath it: the camera on/off toggle and motion/face sensor
        // icons join the left toggles (only for devices that have a camera).
        // Some devices falsely report camera_streaming yet serve no actual frame
        // (e.g. the rk3576_u tablets) — the only reliable signal is the camera
        // image 404ing. onCameraError() records that per device+screenshot-ts;
        // honoring it here collapses the card instead of showing a "no camera"
        // box. The ts is part of the key, so a manual refresh retries the feed.
        const cameraFailed = !!this._cameraFailed[`${device.device_id}:${ts}`];
        const showCameraColumn = hasCameraSection && showCamera && imageReady
            && !!m.controls?.camera_streaming && !cameraFailed;

        if (!showCameraColumn) {
            // Include the camera on/off toggle + motion/face icons whenever the
            // device is camera-capable. Use cameraConfigured (the rtsp_stream
            // switch exists) rather than hasCameraSection (camera_resolution) —
            // the resolution goes null when the camera is off, which would drop
            // the toggle exactly when the user wants it to turn the camera back
            // on. Motion/face icons self-gate on their *_active flags.
            const hasCameraControls = cameraConfigured || hasCameraSection;
            const mergedControls = hasCameraControls
                ? `${reloadIcon}${screenPill}${lightDarkPill}${cameraIcon}${motionIcon}${faceIcon}`
                : `${reloadIcon}${screenPill}${lightDarkPill}`;
            // Screenshot centered at 50% width; controls centered across the full
            // card width (not constrained to the screenshot box) so the icons form
            // a centered, evenly-spaced cluster rather than left-aligning to the
            // screenshot's left edge.
            return `
                <div style="margin-top: 12px;">
                    <div style="max-width: 50%; margin: 0 auto;">
                        ${screenshotSection}
                    </div>
                    <div style="display: flex; align-items: center; justify-content: center; gap: 16px; margin-top: 8px; ${offlineStyle}">
                        ${mergedControls}
                    </div>
                </div>
            `;
        }

        return `
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px;">
                <div style="min-width: 0;">
                    ${screenshotSection}
                    ${controlRow(reloadIcon, screenPill, lightDarkPill)}
                </div>
                <div style="min-width: 0;">
                    ${cameraSection}
                    ${controlRow(cameraIcon, motionIcon, faceIcon)}
                </div>
            </div>
        `;
    },

    /**
     * The camera frame failed to load (404 / no real camera despite a
     * streaming state). Record it per device+screenshot-ts and re-render so
     * the card collapses to the centered single-column layout instead of an
     * empty "no camera" box. Keying on the ts means a manual refresh (which
     * bumps the ts) retries the feed. Guarded so repeated error events before
     * the re-render don't loop.
     */
    onCameraError(deviceId) {
        const ts = this._screenshotTs[deviceId] || this._initialTs;
        const key = `${deviceId}:${ts}`;
        if (this._cameraFailed[key]) return;
        this._cameraFailed[key] = true;
        App.renderPage();
    },

    /** Stamp the screenshot's age ("Nm ago") onto its badge once the <img> loads.
     *  A device may return a STALE cached frame (the integration serves the last
     *  good capture on a failed/timed-out request), so the badge — read from the
     *  image entity's capture time — tells the user how old the frame actually is.
     *  Capture time is cached ~15s so rapid re-renders don't refetch. */
    async markScreenshotTime(deviceId) {
        if (typeof DashieAuth === 'undefined' || !DashieAuth.isAddonMode) return;
        let meta = this._ssMeta[deviceId];
        if (!meta || (Date.now() - meta.at) > 15000) {
            try {
                const r = await fetch(DashieAuth._addonUrl(`/api/ha/image/${encodeURIComponent(deviceId)}/screenshot/updated`));
                const j = r.ok ? await r.json().catch(() => null) : null;
                meta = this._ssMeta[deviceId] = { updated: j?.updated || null, at: Date.now() };
            } catch (_) {
                meta = this._ssMeta[deviceId] = { updated: null, at: Date.now() };
            }
        }
        const badge = document.querySelector(`[data-ss-age="${deviceId}"]`);
        if (badge) badge.textContent = this._relativeAge(meta.updated);
    },

    /** ISO timestamp → "now" / "5m ago" / "2h ago" / "3d ago". '' if unknown. */
    _relativeAge(iso) {
        if (!iso) return '';
        const t = Date.parse(iso);
        if (!isFinite(t)) return '';
        const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
        if (sec < 45) return 'now';
        const min = Math.round(sec / 60);
        if (min < 60) return `${min}m ago`;
        const hr = Math.round(min / 60);
        if (hr < 24) return `${hr}h ago`;
        return `${Math.round(hr / 24)}d ago`;
    },

    /**
     * Compact pill button. Color/text/icon swap based on `currentlyOn`.
     * `palette.onIconInvert: true` flips the icon to white (filter) when
     * the active background is dark/colored — letting us reuse black SVGs
     * on colored bg without authoring multiple files.
     */
    _renderPill({ idAttr, role, currentlyOn, iconFile, title, busy = false, palette }) {
        const p = palette;
        const bg = currentlyOn ? p.onBg : p.offBg;
        const border = currentlyOn ? p.onBorder : p.offBorder;
        // Two-sided icon invert: previously only the "on" state could
        // recolor the icon to white. The new screen / light-mode
        // palettes have a colored background on both sides (orange/black
        // for screen, orange/black for light/dark) so we want a white
        // icon in both — opt-in via offIconInvert without touching the
        // existing callers that only set onIconInvert.
        const invert = currentlyOn ? !!p.onIconInvert : !!p.offIconInvert;
        return `
            <button title="${DevicesPage._escape(title)}" ${busy ? 'disabled' : ''}
                onclick="event.stopPropagation(); DevicesCard.toggleSwitch('${idAttr}', '${role}', ${currentlyOn})"
                style="display: inline-flex; align-items: center; justify-content: center; padding: 4px 10px; border-radius: 999px; border: 1px solid ${border}; background: ${bg}; cursor: ${busy ? 'wait' : 'pointer'}; opacity: ${busy ? 0.5 : 1}; line-height: 0;">
                ${iconImg(iconFile, 14, invert ? 'filter: brightness(0) invert(1);' : '')}
            </button>
        `;
    },

    _renderMusicStrip(m) {
        if (m.media?.state !== 'playing') return '';
        const artist = m.media.artist || '';
        const title = m.media.title || '';
        if (!artist && !title) return '';
        const text = artist && title ? `${artist} — ${title}` : (title || artist);
        return `
            <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border, #e5e7eb); display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-secondary);">
                ${iconImg('icon-music.svg', 12)}
                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${DevicesPage._escape(text)}</span>
            </div>
        `;
    },

    /** True iff `val` is a real camera resolution ("WxH" with W>0 and H>0).
     *  Devices without a camera occasionally report a placeholder ('', '0x0',
     *  'unknown') which a bare truthy check would treat as "has camera". */
    _isRealCameraResolution(val) {
        if (typeof val !== 'string') return false;
        const m = val.match(/^\s*(\d+)\s*[xX]\s*(\d+)\s*$/);
        if (!m) return false;
        return parseInt(m[1], 10) > 0 && parseInt(m[2], 10) > 0;
    },

    /** Inline style for the motion/face icon wrapper, by detected state. */
    _detectIconStyle(detected) {
        const base = 'display: inline-flex; align-items: center; line-height: 0; position: relative; transition: background 120ms ease;';
        return detected
            ? `${base} background: rgba(249,115,22,0.18); border: 1px solid #f97316; border-radius: 4px; padding: 3px;`
            : `${base} padding: 4px;`;
    },

    /** Inline style for the orange tint overlay layer (above the icon img). */
    _detectOverlayStyle(detected) {
        const base = 'position: absolute; inset: 0; border-radius: 3px; pointer-events: none;';
        return detected
            ? `${base} background: rgba(249,115,22,0.35);`
            : `${base} background: transparent;`;
    },

    /** Icon opacity by 3-state: detected → 1; active+clear → 0.5; inactive → 0.25. */
    _detectIconOpacity(detected, active) {
        if (detected) return '';
        if (active) return 'opacity: 0.5;';
        return 'opacity: 0.25;';
    },

    _detectTitle(role, detected, active) {
        const label = role === 'motion' ? 'Motion' : 'Face';
        if (!active) return `${label} detection off`;
        return `${label} ${detected ? 'detected' : 'idle'}`;
    },

    /**
     * Targeted DOM update for motion/face detection state. Finds the icon
     * wrapper for the given device + role and updates its style in place,
     * along with the overlay layer's tint. No full re-render — preserves
     * all <img> elements (screenshots, cameras) on the page.
     *
     * Caller must pass `active` (whether detection is enabled at all) so we
     * can pick the right opacity. The slash overlay only updates on full
     * re-render (motion_wake_mode changes are rare).
     */
    updateDetectIcon(deviceId, role, detected, active = true) {
        if (role !== 'motion' && role !== 'face') return;
        const sel = `[data-card-id="${CSS.escape(deviceId)}"][data-detect-role="${role}"]`;
        const wrapper = document.querySelector(sel);
        if (!wrapper) return;
        wrapper.setAttribute('style', this._detectIconStyle(detected));
        wrapper.setAttribute('title', this._detectTitle(role, detected, active));
        const img = wrapper.querySelector('img');
        if (img) img.setAttribute('style', `width: 18px; height: 18px; vertical-align: middle; ${this._detectIconOpacity(detected, active)}`);
        const overlay = wrapper.querySelector('[data-detect-overlay]');
        if (overlay) overlay.setAttribute('style', this._detectOverlayStyle(detected));
    },

    _scaleTo10(value, max) {
        if (value == null) return '—';
        if (!max || max === 10) return Math.round(value);
        return Math.max(0, Math.min(10, Math.round(value / max * 10)));
    },

    // ---- Live actions ----

    async toggleSwitch(deviceId, role, currentlyOn) {
        const key = `${deviceId}:${role}`;
        if (this._busyControl[key]) return;
        this._busyControl[key] = true;
        // Optimistic: flip the visible state immediately so the icon
        // turns orange/black on click instead of waiting ~200-500ms for
        // the round-trip. We revert on error.
        const device = DevicesPage._findDevice(deviceId);
        const target = !currentlyOn;
        if (device) {
            device.metrics = device.metrics || {};
            device.metrics.controls = device.metrics.controls || {};
            device.metrics.controls[role] = target;
        }
        App.renderPage();
        try {
            await this.control(deviceId, role, target);
            // After a screen toggle, the dashboard's content has changed — bump the
            // screenshot cache-bust so we re-fetch a fresh frame. Wait ~2s for the HA
            // integration to capture the new state.
            if (role === 'screen') {
                setTimeout(() => {
                    this._screenshotTs[deviceId] = Date.now();
                    App.renderPage();
                }, 2000);
            }
        } catch (e) {
            console.error(`[DevicesCard] toggle ${role} failed:`, e);
            Toast.error(Toast.friendly(e, `toggle ${role.replace('_', ' ')}`));
            // Revert the optimistic flip — the next poll would also fix
            // it, but reverting now means the user immediately sees that
            // the action didn't take effect instead of a stale wrong state.
            if (device?.metrics?.controls) {
                device.metrics.controls[role] = currentlyOn;
            }
        } finally {
            delete this._busyControl[key];
            App.renderPage();
        }
    },

    // ---- Screenshot enlargement modal ----

    openScreenshotModal(deviceId) {
        if (!DashieAuth.isAddonMode) return;
        // Always use a fresh timestamp here so the modal grabs the latest frame.
        const ts = Date.now();
        const src = DashieAuth._addonUrl(`/api/ha/image/${encodeURIComponent(deviceId)}/screenshot?t=${ts}`);
        this._screenshotModal = { deviceId, src, ts };
        App.renderPage();
    },

    closeScreenshotModal() {
        // Hand the card the fresh frame the modal just loaded — same cache-bust ts,
        // so the browser already has it cached and the thumbnail updates instantly
        // (no extra device capture, no stale-until-next-refresh gap).
        const m = this._screenshotModal;
        if (m) this._screenshotTs[m.deviceId] = m.ts;
        this._screenshotModal = null;
        App.renderPage();
    },

    renderScreenshotModal() {
        const m = this._screenshotModal;
        if (!m) return '';
        const name = DevicesPage._findDevice(m.deviceId)?.device_name || 'Screenshot';
        return this._renderImageModal({ src: m.src, name, footer: '', closeFn: 'closeScreenshotModal', onBackdrop: '_maybeCloseScreenshot' });
    },
    _maybeCloseScreenshot(e) { if (e.target === e.currentTarget) this.closeScreenshotModal(); },

    // Camera modal lives in devices-camera.js (DevicesCamera). Card-side stays minimal.
    renderCameraModal() { return DevicesCamera.render(); },

    _renderImageModal({ src, name, imgId, footer, closeFn, onBackdrop }) {
        const escName = DevicesPage._escape(name);
        return `
            <div onclick="DevicesCard.${onBackdrop}(event)" style="position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 1100; display: flex; align-items: center; justify-content: center; padding: 24px; cursor: zoom-out;">
                <div onclick="event.stopPropagation()" style="max-width: 95vw; max-height: 92vh; display: flex; flex-direction: column; gap: 10px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; color: white;">
                        <strong>${escName}</strong>
                        <button onclick="DevicesCard.${closeFn}()" style="background: rgba(255,255,255,0.15); color: white; border: 1px solid rgba(255,255,255,0.25); border-radius: 4px; padding: 4px 12px; cursor: pointer;">Close</button>
                    </div>
                    <img ${imgId ? `id="${imgId}"` : ''} src="${src}" alt="${escName}" style="max-width: 95vw; max-height: 80vh; object-fit: contain; border-radius: 6px; background: #000;">
                    ${footer ? `<div style="color: rgba(255,255,255,0.65); font-size: 11px; text-align: center;">${footer}</div>` : ''}
                </div>
            </div>
        `;
    },

    // History modal: Console-native SVG chart rendered by HistoryChart,
    // data fetched from HA via the add-on's /api/ha/history proxy. No
    // iframe / sidebar / HACS dependency. The chart host is mounted
    // declaratively by renderHistoryModal(); _mountHistoryChart() runs
    // post-render to call HistoryChart.render() on the live DOM node.
    openHistory(entityId, label) {
        this._historyOpen = { entityId, label: label || entityId, hours: 24 };
        App.renderPage();
        // App.renderPage is synchronous — DOM is in place by the time the
        // microtask flush happens. Defer to next tick so we run AFTER any
        // page-render side effects have settled.
        queueMicrotask(() => this._mountHistoryChart());
    },

    closeHistory() {
        const host = document.getElementById('history-chart-host');
        if (host && typeof HistoryChart !== 'undefined') HistoryChart.dispose(host);
        this._historyOpen = null;
        App.renderPage();
    },

    renderHistoryModal() {
        const h = this._historyOpen;
        if (!h) return '';
        return `
            <div onclick="DevicesCard._maybeCloseHistory(event)" style="position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 1100; display: flex; align-items: center; justify-content: center; padding: 24px;">
                <div onclick="event.stopPropagation()" class="card" style="width: min(960px, 95vw); max-height: 90vh; display: flex; flex-direction: column;">
                    <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border, #e5e7eb);">
                        <strong>${DevicesPage._escape(h.label)}</strong>
                        <button onclick="DevicesCard.closeHistory()" style="background: none; border: 1px solid var(--border, #d1d5db); border-radius: 4px; padding: 4px 12px; cursor: pointer;">Close</button>
                    </div>
                    <div id="history-chart-host" style="flex: 1; min-height: 60vh; padding: 16px; overflow: auto;"></div>
                </div>
            </div>
        `;
    },

    _mountHistoryChart() {
        const h = this._historyOpen;
        if (!h) return;
        const host = document.getElementById('history-chart-host');
        if (!host || typeof HistoryChart === 'undefined') return;
        HistoryChart.render(host, {
            entityId: h.entityId,
            label: h.label,
            hours: h.hours || 24,
        });
    },

    _maybeCloseHistory(e) { if (e.target === e.currentTarget) this.closeHistory(); },

    async pressButton(deviceId, role) {
        const key = `${deviceId}:${role}`;
        if (this._busyControl[key]) return;
        this._busyControl[key] = true;
        App.renderPage();
        try {
            await this.control(deviceId, role, null);
            Toast.success(`${role.replace('_', ' ')} sent`);
        } catch (e) {
            console.error(`[DevicesCard] press ${role} failed:`, e);
            Toast.error(Toast.friendly(e, `press ${role}`));
        } finally {
            delete this._busyControl[key];
            App.renderPage();
        }
    },

    // ---- Slider dialog (volume / brightness, normalized 1-10) ----

    openSlider(deviceId, role, currentValue, scaleMax) {
        const cfg = role === 'volume' ? { label: 'Volume' } : role === 'brightness' ? { label: 'Brightness' } : { label: role };
        const max = scaleMax || 10;
        const displayValue = !max || max === 10 ? Math.round(currentValue) : Math.round(currentValue / max * 10);
        this._sliderOpen = { deviceId, role, ...cfg, min: 0, max: 10, step: 1, value: displayValue, scaleMax: max };
        App.renderPage();
    },

    closeSlider() { this._sliderOpen = null; App.renderPage(); },

    onSliderInput(value) {
        if (!this._sliderOpen) return;
        this._sliderOpen.value = Number(value);
        const lbl = document.getElementById('devices-slider-value');
        if (lbl) lbl.textContent = `${this._sliderOpen.value}`;
    },

    async submitSlider() {
        const s = this._sliderOpen;
        if (!s) return;
        this._sliderOpen = null;
        App.renderPage();
        const key = `${s.deviceId}:${s.role}`;
        this._busyControl[key] = true;
        const actualValue = s.scaleMax === 10 ? s.value : Math.round(s.value / 10 * s.scaleMax);
        try {
            await this.control(s.deviceId, s.role, actualValue);
            const device = DevicesPage._findDevice(s.deviceId);
            if (device) {
                device.metrics = device.metrics || {};
                device.metrics.controls = device.metrics.controls || {};
                device.metrics.controls[s.role] = actualValue;
            }
            Toast.success(`${s.label} set to ${s.value}/10`);
        } catch (e) {
            console.error(`[DevicesCard] slider ${s.role} failed:`, e);
            Toast.error(Toast.friendly(e, `set ${s.role}`));
        } finally {
            delete this._busyControl[key];
            App.renderPage();
        }
    },

    renderSliderModal() {
        const s = this._sliderOpen;
        if (!s) return '';
        // Volume gets a Mute / Unmute toggle next to the label.
        const muteBtn = s.role === 'volume'
            ? (s.value === 0
                ? `<button class="btn btn-secondary btn-sm" onclick="DevicesCard.unmute()">Unmute</button>`
                : `<button class="btn btn-secondary btn-sm" onclick="DevicesCard.mute()">Mute</button>`)
            : '';
        return `
            <div onclick="DevicesCard._maybeClose(event)" style="position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 24px;">
                <div onclick="event.stopPropagation()" class="card" style="max-width: 360px; width: 100%;">
                    <div class="card-body">
                        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                            <strong style="font-size: var(--font-size-lg);">${DevicesPage._escape(s.label)}</strong>
                            ${muteBtn}
                        </div>
                        <div style="margin: 16px 0; text-align: center; font-size: 28px; font-weight: 600;" id="devices-slider-value">${s.value === 0 && s.role === 'volume' ? 'Muted' : s.value}</div>
                        <input type="range" min="0" max="10" step="1" value="${s.value}"
                            oninput="DevicesCard.onSliderInput(this.value)" style="width: 100%;">
                        <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); margin-top: 4px;">
                            <span>0</span><span>10</span>
                        </div>
                        <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px;">
                            <button class="btn btn-secondary btn-sm" onclick="DevicesCard.closeSlider()">Cancel</button>
                            <button class="btn btn-primary btn-sm" onclick="DevicesCard.submitSlider()">Save</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    },

    async mute() {
        const s = this._sliderOpen;
        if (!s || s.role !== 'volume') return;
        s.value = 0;
        await this._submitSliderValue(0);
    },
    async unmute() {
        const s = this._sliderOpen;
        if (!s || s.role !== 'volume') return;
        s.value = 5;
        await this._submitSliderValue(5);
    },
    async _submitSliderValue(displayValue) {
        const s = this._sliderOpen;
        if (!s) return;
        const actualValue = s.scaleMax === 10 ? displayValue : Math.round(displayValue / 10 * s.scaleMax);
        this._sliderOpen = null;
        const key = `${s.deviceId}:${s.role}`;
        this._busyControl[key] = true;
        App.renderPage();
        try {
            await this.control(s.deviceId, s.role, actualValue);
            const device = DevicesPage._findDevice(s.deviceId);
            if (device) {
                device.metrics = device.metrics || {};
                device.metrics.controls = device.metrics.controls || {};
                device.metrics.controls[s.role] = actualValue;
            }
            Toast.success(displayValue === 0 ? `${s.label} muted` : `${s.label} set to ${displayValue}/10`);
        } catch (e) {
            Toast.error(Toast.friendly(e, `set ${s.role}`));
        } finally {
            delete this._busyControl[key];
            App.renderPage();
        }
    },

    _maybeClose(e) { if (e.target === e.currentTarget) this.closeSlider(); },

    async control(deviceId, role, value) {
        if (!DashieAuth.isAddonMode) {
            throw new Error(`Device controls require running inside ${BRAND.consoleName}`);
        }
        const resp = await fetch(DashieAuth._addonUrl('/api/ha/control'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_id: deviceId, role, value }),
        });
        if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`control HTTP ${resp.status}: ${body.slice(0, 200)}`);
        }
        return resp.json();
    },
};
