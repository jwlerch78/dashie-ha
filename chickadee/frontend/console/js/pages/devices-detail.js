/* ============================================================
   Devices Detail — per-device drill-down view rendered when a card
   is clicked.

   Section order:
     1. Header (name + type + status + last-seen + rename action)
     2. Quick Controls (lock / screen / dark mode / camera / reload /
        brightness / volume — pulled in from the device card)
     3. Live Metrics (battery / RAM / network / storage / app / page)
     4. Display & Theme
     5. Sleep & Screensaver
     6. Voice & AI
     7. Photos / Slideshow
     8. Device Behavior (HA switches not surfaced elsewhere)
     9. Admin Actions (HA buttons — relaunch / reboot / clear cache…)
    10. Danger Zone (soft + permanent delete)

   Reuses DevicesCard.{toggleSwitch, pressButton, openSlider} for
   control invocations. Reuses settingSelect() for dropdowns.
   ============================================================ */

const DevicesDetail = {
    /** Per-section expand/collapse state (keyed by section id). Persisted
     *  to localStorage so a user's preferred view sticks across reloads. */
    _SECTION_STATE_KEY: 'dashie_devices_detail_sections',
    _sectionExpanded: null,
    _loadSections() {
        if (this._sectionExpanded) return;
        try {
            this._sectionExpanded = JSON.parse(localStorage.getItem(this._SECTION_STATE_KEY) || '{}');
        } catch { this._sectionExpanded = {}; }
    },
    _isExpanded(sectionId, defaultExpanded = true) {
        this._loadSections();
        const v = this._sectionExpanded[sectionId];
        return v === undefined ? defaultExpanded : !!v;
    },
    toggleSection(sectionId) {
        this._loadSections();
        const next = !this._isExpanded(sectionId);
        this._sectionExpanded[sectionId] = next;
        try { localStorage.setItem(this._SECTION_STATE_KEY, JSON.stringify(this._sectionExpanded)); } catch {}
        App.renderPage();
    },

    /** Render a collapsible card section with a caret header. */
    _section(sectionId, title, bodyHtml, opts = {}) {
        const expanded = this._isExpanded(sectionId, opts.defaultExpanded !== false);
        const caret = expanded ? '▾' : '▸';
        const titleColor = opts.titleColor || '';
        return `
            <div class="section-header" style="cursor: pointer; ${titleColor}" onclick="DevicesDetail.toggleSection('${sectionId}')">
                <span style="display: inline-block; width: 14px;">${caret}</span> ${DevicesPage._escape(title)}
            </div>
            ${expanded ? bodyHtml : ''}
        `;
    },

    render(device) {
        if (!device) {
            return '<div class="empty-state"><div class="empty-state-text">Device not found</div></div>';
        }
        const live = DevicesPage._isLive(device);
        const settings = device.settings || {};
        const display = settings.display || {};
        const sleep = settings.sleep || {};
        const aiVoice = settings.aiVoice || {};
        const voice = settings.voice || {};
        const photos = settings.photos || {};
        const m = device.metrics || {};
        const icon = DevicesPage._deviceIcon(device.device_type);
        const conflict = DevicesPage._conflictHaName(device);
        const conflictBadge = conflict ? `
            <div style="margin-top: 4px; font-size: var(--font-size-sm); color: var(--accent);">
                ⚠ HA has a different name: "${DevicesPage._escape(conflict)}".
                <a href="#" onclick="event.preventDefault(); DevicesRename.openModal()">Resolve</a>
            </div>
        ` : '';
        return `
            <div class="back-link" onclick="DevicesPage.backToList()">← Back to Devices</div>
            <div style="display: flex; align-items: flex-start; gap: 16px; margin-bottom: 24px; flex-wrap: wrap;">
                <div style="display: flex; align-items: flex-start; gap: 12px; flex: 1 1 320px; min-width: 0;">
                    <div class="device-card-icon" style="width: 48px; height: 48px; font-size: 24px; flex-shrink: 0;">${icon}</div>
                    <div style="flex: 1; min-width: 0;">
                        ${DevicesRename.renderNameRow(device, conflict, 'detail',
                            this._renderLockToggle(device, m, live) + this._renderRefreshButton(device, live))}
                        <div style="font-size: var(--font-size-sm); color: var(--text-secondary); margin-top: 4px;">
                            ${DevicesPage._escape(DevicesPage._typeLabel(device))} ·
                            <span class="status-dot ${live ? 'online' : 'offline'}"></span>${live ? 'Live' : 'Offline'}
                        </div>
                        ${this._renderIdLine(device)}
                        ${this._renderVersionIpLine(device, m)}
                        ${conflictBadge}
                        ${this._renderHeaderChips(device, m)}
                    </div>
                </div>
                <div style="display: flex; flex-direction: column; gap: 8px; flex-shrink: 0;">
                    ${this._renderHeaderActions(device, m, live)}
                    ${this._renderHeaderPreview(device, m, live)}
                </div>
            </div>
            ${this._renderQuickControls(device, m, live)}
            ${this._renderDisplaySection(device, display, sleep)}
            ${this._renderVoiceSection(device, aiVoice, voice)}
            ${this._renderHomeAssistantSection(device)}
            ${this._renderPhotosSection(device, photos)}
            ${this._renderBehaviorSection(device, m)}
            ${this._renderAdminSection(device, m)}
            ${this._renderDangerZone(device)}
            <p class="page-summary">
                Changes apply to the device immediately via Supabase real-time broadcast.
                Last check-in: ${DevicesPage._formatTime(device.last_seen_at)}
            </p>
            ${DevicesRename.conflictModal ? DevicesRename.renderModal(DevicesPage._conflictDevices(), d => DevicesPage._conflictHaName(d)) : ''}
            ${DevicesCard.renderSliderModal()}
            ${DevicesCard.renderScreenshotModal()}
            ${DevicesCard.renderHistoryModal()}
            ${DevicesCard.renderCameraModal()}
            ${DevicesDetailModals.renderSleepModal()}
            ${DevicesDetailModals.renderThemeModal()}
            ${DevicesDetailModals.renderPickerModal()}
            ${DevicesDetailModals.renderScreensaverModal()}
            ${DevicesDetailModals.renderAdvancedDisplayModal()}
            ${DevicesDetailModals.renderVoicePersonalityModal()}
            ${DevicesDetailModals.renderVoiceVoiceModal()}
            ${DevicesDetailModals.renderWakeWordModal()}
            ${DevicesDetailModals.renderPinModal()}
        `;
    },

    // =========================================================
    //  Quick Controls — primary device actions (lock / screen /
    //  dark mode / camera / reload / brightness / volume)
    // =========================================================

    _renderQuickControls(device, m, live) {
        if (!live) {
            return this._section('quick-controls', 'Quick Controls', `
                <div class="card"><div class="card-body" style="color: var(--text-muted); font-size: var(--font-size-sm);">
                    Device is offline. Quick controls become available when the device checks in.
                </div></div>
            `);
        }
        const idAttr = DevicesPage._escape(device.device_id);
        const controls = m.controls || {};
        const buttons = [];

        // Reload — always available for an online device
        const reloadBusy = !!DevicesCard._busyControl[`${device.device_id}:reload`];
        buttons.push(`
            <button title="Reload the dashboard webview on this device" ${reloadBusy ? 'disabled' : ''}
                onclick="DevicesCard.pressButton('${idAttr}', 'reload')"
                style="${this._controlBtnStyle(reloadBusy)}">
                <img src="assets/icons/icon-reload.svg" alt="" style="width: 16px; height: 16px;">
                <span>Reload</span>
            </button>
        `);

        // Lock moved to the header (next to the name + refresh icon),
        // not duplicated here.

        // Screen on/off
        if (controls.screen !== undefined) {
            const on = controls.screen !== false;
            const busy = !!DevicesCard._busyControl[`${device.device_id}:screen`];
            buttons.push(this._toggleBtn(idAttr, 'screen', on, busy,
                'icon-tv.svg',
                on ? 'Screen on' : 'Screen off',
                on ? 'Screen on — tap to turn off' : 'Screen off — tap to turn on'));
        }

        // Dark mode
        if (controls.dark_mode !== undefined) {
            const dark = !!controls.dark_mode;
            const busy = !!DevicesCard._busyControl[`${device.device_id}:dark_mode`];
            buttons.push(this._toggleBtn(idAttr, 'dark_mode', dark, busy,
                dark ? 'icon-moon.svg' : 'icon-sun.svg',
                dark ? 'Dark mode' : 'Light mode',
                dark ? 'Dark mode — tap for light' : 'Light mode — tap for dark',
                // Visual: light mode → orange (warm/sunny), dark mode →
                // black. Matches the device card pill palette so the
                // same action looks the same across both surfaces.
                dark ? 'off' : 'on'));
        }

        // Camera stream toggle — only when the device has actual camera
        // hardware. The Dashie app reports camera_stream_enabled as a switch
        // regardless of hardware (it's a software toggle), but camera_resolution
        // only resolves to a real WxH on devices with a camera. Mirrors the
        // gate _renderMediaRow uses for the camera column on the device card.
        if (DevicesCard._isRealCameraResolution(controls.camera_resolution)) {
            const on = !!(controls.camera_streaming || controls.camera_stream_enabled);
            const busy = !!DevicesCard._busyControl[`${device.device_id}:camera_stream_enabled`];
            buttons.push(this._toggleBtn(idAttr, 'camera_stream_enabled', on, busy,
                'icon-video-camera.svg',
                on ? 'Camera on' : 'Camera off',
                on ? 'Camera streaming — tap to stop' : 'Camera off — tap to start'));
        }

        // Volume + brightness moved to the header chip row — same controls,
        // less duplication.

        // Brightness slider — kept here for tap-to-adjust convenience.
        if (controls.brightness != null) {
            const display = DevicesCard._scaleTo10(controls.brightness, controls.brightness_max);
            buttons.push(`
                <button title="Adjust screen brightness"
                    onclick="DevicesCard.openSlider('${idAttr}', 'brightness', ${controls.brightness}, ${controls.brightness_max ?? 'null'})"
                    style="${this._controlBtnStyle(false)}">
                    <img src="assets/icons/icon-sun.svg" alt="" style="width: 16px; height: 16px;">
                    <span>Brightness ${display}</span>
                </button>
            `);
        }

        // Screensaver toggle — controls.screensaver_enabled is the dashboard's
        // canonical signal for "show screensaver during sleep." Falls back to
        // device.settings.display.screensaverTimeout != 0 if the control state
        // isn't broadcast.
        const settings = device.settings || {};
        const screensaverCat = settings.screensaver || {};
        const screensaverOn = controls.screensaver !== undefined
            ? !!controls.screensaver
            : (Number(screensaverCat.timeout ?? 0) > 0);
        const screensaverBusy = !!DevicesCard._busyControl[`${device.device_id}:screensaver`];
        buttons.push(this._toggleBtn(idAttr, 'screensaver', screensaverOn, screensaverBusy,
            'icon-moon.svg',
            screensaverOn ? 'Screensaver on' : 'Screensaver off',
            screensaverOn ? 'Screensaver on — tap to disable' : 'Screensaver off — tap to enable'));

        // Change PIN / Set PIN — green when a PIN is set on the device,
        // gray "Set PIN" when not. Click opens the PIN modal.
        const pinSet = !!(controls.pin_set || settings.security?.pinSet);
        buttons.push(`
            <button title="${pinSet ? 'PIN is set — tap to change' : 'No PIN set — tap to create one'}"
                onclick="DevicesDetailModals.openPinModal('${idAttr}', ${pinSet})"
                style="${this._controlBtnStyle(false, pinSet)}">
                <img src="assets/icons/icon-lock.svg" alt="" style="width: 14px; height: 14px; ${pinSet ? 'filter: brightness(0) invert(1);' : ''}">
                <span>${pinSet ? 'Change PIN' : 'Set PIN'}</span>
            </button>
        `);

        if (buttons.length === 0) return '';
        return this._section('quick-controls', 'Quick Controls', `
            <div class="card"><div class="card-body">
                <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                    ${buttons.join('')}
                </div>
            </div></div>
        `);
    },

    /** `visualState` overrides the on/off mapping when the visual color
     *  should track something other than the raw isOn (e.g., dark_mode:
     *  the button is "on" when dark mode is enabled, but visually we
     *  want light-mode = orange and dark-mode = black to match the
     *  device card palette). Caller passes 'on' or 'off' explicitly;
     *  omitted = use isOn as-is. */
    _toggleBtn(idAttr, role, isOn, busy, iconFile, label, title, visualState) {
        const colorState = visualState || (isOn ? 'on' : 'off');
        return `
            <button title="${DevicesPage._escape(title)}" ${busy ? 'disabled' : ''}
                onclick="DevicesCard.toggleSwitch('${idAttr}', '${role}', ${isOn})"
                style="${this._controlBtnStyle(busy, colorState)}">
                <img src="assets/icons/${iconFile}" alt="" style="width: 16px; height: 16px; filter: brightness(0) invert(1);">
                <span>${label}</span>
            </button>
        `;
    },

    /** Quick-controls pill style. `state` is:
     *    - 'on'  → orange (#f97316) bg, white text/icon  (matches card)
     *    - 'off' → black (#1f2937) bg, white text/icon   (matches card)
     *    - undefined → neutral gray (for action buttons like Reload,
     *      Brightness slider trigger — they have no on/off concept and
     *      shouldn't render as if they were off).
     *  isOn flag is treated as legacy: true → 'on', false → 'off'. */
    _controlBtnStyle(busy, isOnOrState = undefined) {
        let bg, color, border;
        const state = typeof isOnOrState === 'string'
            ? isOnOrState
            : (isOnOrState === true ? 'on' : (isOnOrState === false ? undefined : isOnOrState));
        if (state === 'on') {
            bg = '#f97316'; color = '#fff'; border = bg;
        } else if (state === 'off') {
            bg = '#1f2937'; color = '#fff'; border = bg;
        } else {
            bg = '#f3f4f6'; color = '#1f2937'; border = '#d1d5db';
        }
        return `display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 999px; border: 1px solid ${border}; background: ${bg}; color: ${color}; cursor: ${busy ? 'wait' : 'pointer'}; opacity: ${busy ? 0.5 : 1}; font-size: 13px; font-weight: 500;`;
    },

    // =========================================================
    //  Header — compact metric chips (battery / RAM / wifi / room
    //  / volume / brightness) styled like the card stats row, plus
    //  the small screenshot+camera preview panel that slots to the
    //  right of the title block. Both reuse DashieAuth.isAddonMode
    //  signals for image URL gating.
    // =========================================================

    _renderHeaderChips(device, m) {
        if (!m) return '';
        const chips = [];
        const idAttr = DevicesPage._escape(device.device_id);
        // Stat chips on the device page header use the same historyLink
        // the card stats row uses — opens the Console-native history chart
        // modal (HistoryChart + /api/ha/history), no iframe / HA sidebar.
        // Prefer worker-resolved entity_id; fall back to slug + suffix
        // reconstruction during the boot window before the worker has
        // populated entity_ids.
        const slug = DevicesPage._haSlugForDevice(device.device_id);
        const entityIds = DevicesPage._haEntityIdsForDevice(device.device_id);
        const deviceLabel = device.device_name || 'Device';
        const historyLink = (role, label) => {
            const entityId = entityIds[role] || (slug ? `sensor.${slug}_${role}` : null);
            return entityId
                ? `style="cursor: pointer;" title="${label} — open history" onclick="DevicesCard.openHistory('${entityId}', '${DevicesPage._escape(deviceLabel + ' · ' + label)}')"`
                : '';
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
        const room = m.ha_area || device.ha_area;
        if (room) chips.push(`<span class="device-card-detail">🏠 ${DevicesPage._escape(room)}</span>`);
        if (m.controls?.volume != null) {
            const muted = m.controls.volume === 0;
            const scaled = DevicesCard._scaleTo10
                ? DevicesCard._scaleTo10(m.controls.volume, m.controls.volume_max)
                : m.controls.volume;
            chips.push(`<span class="device-card-detail" style="cursor: pointer;" title="Adjust volume"
                onclick="DevicesCard.openSlider('${idAttr}', 'volume', ${m.controls.volume}, ${m.controls.volume_max ?? 'null'})">
                <img src="assets/icons/${muted ? 'icon-volume-mute.svg' : 'icon-volume-high.svg'}" alt="" style="width: 11px; height: 11px; vertical-align: -1px;">
                ${muted ? 'Muted' : scaled}
            </span>`);
        }
        if (m.controls?.brightness != null) {
            const scaled = DevicesCard._scaleTo10
                ? DevicesCard._scaleTo10(m.controls.brightness, m.controls.brightness_max)
                : m.controls.brightness;
            chips.push(`<span class="device-card-detail" style="cursor: pointer;" title="Adjust brightness"
                onclick="DevicesCard.openSlider('${idAttr}', 'brightness', ${m.controls.brightness}, ${m.controls.brightness_max ?? 'null'})">
                <img src="assets/icons/icon-sun.svg" alt="" style="width: 11px; height: 11px; vertical-align: -1px;">
                ${scaled}
            </span>`);
        }
        // Motion + face detection — surface only when the sensor is active
        // on the device (matches the card behavior: don't show a slashed
        // icon for sensors that aren't running at all).
        if (m.controls?.motion_detection_active) {
            const detected = !!m.controls.motion_detected;
            chips.push(`<span class="device-card-detail" title="Motion detection ${detected ? '— currently detecting motion' : 'on'}">
                <img src="assets/icons/icon-motion-detection.svg" alt="" style="width: 11px; height: 11px; vertical-align: -1px; opacity: ${detected ? 1 : 0.6};">
                ${detected ? 'Motion' : 'Motion ✓'}
            </span>`);
        }
        if (m.controls?.face_detection_active) {
            const detected = !!m.controls.face_detected;
            chips.push(`<span class="device-card-detail" title="Face detection ${detected ? '— face seen' : 'on'}">
                <img src="assets/icons/icon-face-detection.svg" alt="" style="width: 11px; height: 11px; vertical-align: -1px; opacity: ${detected ? 1 : 0.6};">
                ${detected ? 'Face' : 'Face ✓'}
            </span>`);
        }
        if (chips.length === 0) return '';
        return `<div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px;">${chips.join('')}</div>`;
    },

    /** Padlock icon next to the name edit. Toggles device lock via the
     *  same toggleSwitch path the card uses. Orange (#f97316) when
     *  locked to match the card palette. Was wired to pressButton
     *  previously, which always sent turn_off regardless of current
     *  state — so trying to LOCK an unlocked device was a silent no-op. */
    _renderLockToggle(device, m, live) {
        if (!live || m?.controls?.lock === undefined) return '';
        const locked = !!m.controls.lock;
        const busy = !!DevicesCard._busyControl?.[`${device.device_id}:lock`];
        const idAttr = DevicesPage._escape(device.device_id);
        const bg = locked ? '#f97316' : 'transparent';
        const borderColor = locked ? '#f97316' : 'var(--border, #e5e7eb)';
        return `
            <button title="${locked ? 'Locked — tap to unlock' : 'Unlocked — tap to lock'}"
                onclick="DevicesCard.toggleSwitch('${idAttr}', 'lock', ${locked})"
                ${busy ? 'disabled' : ''}
                style="background: ${bg}; border: 1px solid ${borderColor}; border-radius: 999px; padding: 6px; cursor: ${busy ? 'wait' : 'pointer'}; opacity: ${busy ? 0.5 : 1}; line-height: 0;">
                <img src="assets/icons/${locked ? 'icon-lock.svg' : 'icon-unlock.svg'}" alt="" style="width: 14px; height: 14px; filter: ${locked ? 'brightness(0) invert(1)' : 'none'};">
            </button>
        `;
    },

    /** "ID: ABCDEF1234 📋" — same 10-char uppercase format as the Kotlin
     *  control center footer (StableDeviceId.take(10).uppercase()). */
    _renderIdLine(device) {
        const raw = device.device_id || '';
        const short = raw.replace(/[^0-9a-fA-F]/g, '').slice(0, 10).toUpperCase() || raw.slice(0, 10).toUpperCase() || '—';
        return `
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; user-select: all;"
                 title="Device ID — click to copy. Useful for diagnosing HA worker matching when a device shows Offline despite being reachable.">
                <span style="text-transform: none; font-family: var(--font-sans, system-ui);">ID:</span> ${DevicesPage._escape(short)}
                <button onclick="event.stopPropagation(); navigator.clipboard.writeText('${DevicesPage._escape(raw)}').then(() => Toast.success('Device ID copied'))"
                    style="background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 0 4px; font-size: 11px; line-height: 1;"
                    title="Copy device_id">📋</button>
            </div>
        `;
    },

    /** App version · IP address — control-center footer style. */
    _renderVersionIpLine(device, m) {
        const parts = [];
        const v = m?.app?.app_version;
        if (v) parts.push(`v${v}`);
        const ip = m?.network?.ip_address;
        if (ip) parts.push(ip);
        if (parts.length === 0) return '';
        return `<div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${parts.map(p => DevicesPage._escape(p)).join(' · ')}</div>`;
    },

    /** Small refresh button slotted in the name row, next to lock. */
    _renderRefreshButton(device, live) {
        if (!live) return '';
        const idAttr = DevicesPage._escape(device.device_id);
        const busy = !!DevicesCard._busyControl?.[`${device.device_id}:refresh`];
        return `
            <button title="Refresh images + device data" ${busy ? 'disabled' : ''}
                onclick="DevicesDetail.refresh('${idAttr}')"
                style="background: transparent; border: 1px solid var(--border, #e5e7eb); border-radius: 999px; padding: 6px; cursor: ${busy ? 'wait' : 'pointer'}; opacity: ${busy ? 0.5 : 1}; line-height: 0;">
                <img src="assets/icons/icon-reload.svg" alt="" style="width: 14px; height: 14px;">
            </button>
        `;
    },

    /** Send diagnostics / Send crash buttons above the preview.
     *  Backend control roles (send_diagnostics / send_crash_report) and HA
     *  button entities aren't wired yet — clicks toast a "coming soon" so
     *  the UI doesn't 400 while we plumb the entities + server route. */
    _renderHeaderActions(device, m, live) {
        const idAttr = DevicesPage._escape(device.device_id);
        const hasCrash = !!m?.app?.has_crash_report;
        const btn = (label, title, onClick, disabled) => `
            <button title="${title}" ${disabled ? 'disabled' : ''} onclick="${onClick}"
                style="padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border, #e5e7eb); background: var(--bg-card, #fff); color: var(--text-primary); cursor: ${disabled ? 'not-allowed' : 'pointer'}; opacity: ${disabled ? 0.5 : 1}; font-size: 12px; font-weight: 500; display: inline-flex; align-items: center; gap: 4px;">
                ${label}
            </button>
        `;
        const buttons = [];
        buttons.push(btn('Send diagnostics',
            'Trigger the device to upload a fresh diagnostic bundle',
            `DevicesDetail.sendDiagnostics('${idAttr}')`,
            !live));
        if (hasCrash) {
            buttons.push(btn('Send crash report',
                'Upload the pending crash report from the device',
                `DevicesDetail.sendCrashReport('${idAttr}')`,
                false));
        }
        return `<div style="display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap;">${buttons.join('')}</div>`;
    },

    /** Bump the screenshot cache-bust ts and refetch device data. */
    refresh(deviceId) {
        if (DevicesCard._screenshotTs) DevicesCard._screenshotTs[deviceId] = Date.now();
        DevicesCard._busyControl[`${deviceId}:refresh`] = true;
        App.renderPage();
        const done = () => {
            delete DevicesCard._busyControl[`${deviceId}:refresh`];
            App.renderPage();
        };
        if (typeof DevicesPage._refetchDevices === 'function') {
            DevicesPage._refetchDevices().finally(done);
        } else {
            (DevicesPage.refresh?.() || Promise.resolve()).then?.(done) || done();
        }
    },

    sendDiagnostics(deviceId) {
        this._publishDeviceCommand(deviceId, 'send_diagnostics', 'Sending diagnostics request…');
    },

    sendCrashReport(deviceId) {
        this._publishDeviceCommand(deviceId, 'send_crash_report', 'Sending crash report request…');
    },

    /** Broadcast a command on the per-device realtime channel that the
     *  webapp subscribes to via js/data/sync/device-commands.js. The
     *  tablet receives the broadcast, dispatches to the matching
     *  DashieNative bridge method, and runs the existing upload path —
     *  same one the sidebar dialog uses. */
    async _publishDeviceCommand(deviceId, cmd, pendingToast) {
        const sb = DashieAuth._getSupabaseClient?.();
        if (!sb) {
            Toast.error('No realtime client — cannot send command');
            return;
        }
        const channelName = `device_cmd_${deviceId}`;
        Toast.info(pendingToast);
        try {
            const channel = sb.channel(channelName, { config: { broadcast: { self: false, ack: false } } });
            await new Promise((resolve) => {
                channel.subscribe((status) => { if (status === 'SUBSCRIBED') resolve(); });
            });
            await channel.send({ type: 'broadcast', event: 'command', payload: { cmd } });
            // Tear down after publish — this is fire-and-forget.
            setTimeout(() => { try { channel.unsubscribe(); } catch (e) { /* ignore */ } }, 500);
        } catch (e) {
            Toast.error(`Failed to send: ${e?.message || e}`);
        }
    },

    /** Small screenshot + camera preview block for the header. Tap to open
     *  the full-screen modal that DevicesCard already renders. The image
     *  URLs match the per-card endpoints — same cache-bust ts so a manual
     *  refresh on the card list propagates here too. */
    _renderHeaderPreview(device, m, live) {
        if (!DashieAuth?.isAddonMode) return '';
        const idAttr = DevicesPage._escape(device.device_id);
        const ts = DevicesCard._screenshotTs?.[device.device_id] || DevicesCard._initialTs || Date.now();
        const imageReady = live;
        const screenshotSrc = imageReady
            ? DashieAuth._addonUrl(`/api/ha/image/${encodeURIComponent(device.device_id)}/screenshot?t=${ts}`)
            : null;
        const cameraLive = m?.controls?.camera_streaming || m?.controls?.camera_stream_enabled;
        const cameraSrc = imageReady && cameraLive
            ? DashieAuth._addonUrl(`/api/ha/image/${encodeURIComponent(device.device_id)}/camera?t=${ts}`)
            : null;
        const screenOff = m?.controls?.screen === false && !imageReady;
        const panelStyle = 'position: relative; width: 144px; height: 88px; background: var(--bg-subtle, #f3f4f6); border-radius: 8px; overflow: hidden;';
        const imgStyle = 'width: 100%; height: 100%; object-fit: cover; display: block;';
        const overlay = screenOff
            ? `<div style="position: absolute; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; color: white; font-size: 11px; font-weight: 500; pointer-events: none;">Screen off</div>`
            : '';
        const screenshotPanel = !live
            ? `<div style="${panelStyle} display: flex; align-items: center; justify-content: center; color: var(--text-muted);"><span style="font-size: 11px;">Offline</span></div>`
            : screenshotSrc
                ? `<div style="${panelStyle} cursor: zoom-in;" onclick="DevicesCard.openScreenshotModal('${idAttr}')">
                       <img src="${screenshotSrc}" alt="screenshot" style="${imgStyle}" onerror="this.style.display='none'">
                       ${overlay}
                   </div>`
                : `<div style="${panelStyle} display: flex; align-items: center; justify-content: center; color: var(--text-muted);"><span style="font-size: 11px;">No screenshot</span></div>`;
        const cameraConfigured = m?.controls?.camera_stream_enabled !== undefined;
        const cameraPanel = cameraSrc
            ? `<div style="${panelStyle} cursor: zoom-in;" onclick="DevicesCamera.open('${idAttr}')">
                   <img src="${cameraSrc}" alt="camera" style="${imgStyle}" onerror="this.style.display='none'">
               </div>`
            : cameraConfigured
                ? `<div style="${panelStyle} display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 4px; color: var(--text-muted);">
                       <img src="assets/icons/icon-video-camera.svg" alt="" style="width: 20px; height: 20px; opacity: 0.5;">
                       <span style="font-size: 10px;">Camera off</span>
                   </div>`
                : '';
        return `
            <div style="display: flex; gap: 8px; flex-shrink: 0;">
                ${screenshotPanel}
                ${cameraPanel}
            </div>
        `;
    },

    // =========================================================
    //  Live Metrics — the long-form details that don't fit in
    //  the header chips: IP / SSID / storage / app version /
    //  current page. Anything compact-able (battery / RAM% /
    //  wifi% / room / volume / brightness) lives in the header
    //  chip row instead.
    // =========================================================

    _renderMetricsPanel(device) {
        const m = device.metrics;
        if (!m) return '';
        const join = arr => arr.filter(Boolean).join(' · ');
        const rows = [
            m.network?.ip_address && ['IP address', m.network.ip_address],
            m.network?.wifi_ssid && m.network.wifi_ssid !== '<unknown ssid>' && ['Wi-Fi SSID', `"${m.network.wifi_ssid}"`],
            m.system?.ram_total_mb && ['RAM total', `${m.system.ram_total_mb} MB`
                + (m.system.ram_available_mb != null ? ` · ${m.system.ram_available_mb} MB free` : '')],
            m.storage?.free_gb != null && ['Storage',
                `${m.storage.free_gb} GB free` + (m.storage.total_gb ? ` of ${m.storage.total_gb} GB` : '')],
            m.app?.app_version && ['App', join([
                `v${m.app.app_version}`,
                m.app.android_version && `Android ${m.app.android_version}`,
                m.app.device_model,
            ])],
            m.app?.current_page && ['Current page', m.app.current_page],
            m.battery?.charging && m.battery.plug_source && ['Charging via', m.battery.plug_source],
        ].filter(r => r && r[1]);
        if (rows.length === 0) return '';
        return this._section('live-metrics', 'Live Metrics', `
            <div class="card"><div class="card-body">
                <div class="form-grid">
                    ${rows.map(([label, val]) => `
                        <div class="form-group">
                            <label class="form-label">${DevicesPage._escape(label)}</label>
                            <div style="font-size: var(--font-size-sm);">${DevicesPage._escape(val)}</div>
                        </div>
                    `).join('')}
                </div>
                <div style="margin-top: 12px; color: var(--text-muted); font-size: var(--font-size-sm);">
                    Updated ${DevicesPage._formatTime(device.metrics_updated_at)}
                </div>
            </div></div>
        `, { defaultExpanded: false });
    },

    // =========================================================
    //  Display & Theme
    // =========================================================

    /** Consolidated Display section, structured to mirror Kotlin's
     *  DisplayPageSchema: three sub-section cards (Dashboard / Screen
     *  Management / Display Preferences). Each row is a summary +
     *  chevron → opens a modal owned by DevicesDetailModals. Inline
     *  toggles (Animations) skip the modal layer. */
    _renderDisplaySection(device, display, sleep) {
        const body = DevicesDetailModals.renderDisplayBody(device, display, sleep);
        return this._section('display', 'Display', body);
    },

    // =========================================================
    //  Voice & AI
    // =========================================================

    /** Voice section parity with the standalone Voice & AI Settings page:
     *  Enable Voice, Wake Word, Personality — all DEVICE-scoped.
     *
     *  Device-vs-account split (confirmed via blocklist + writer mapping):
     *    Device: voice.enabled, aiVoice.personalityId, aiVoice.wakeWord,
     *            aiVoice.voiceKey, voice.controlMethod/STT/TTS/...
     *    Account: ai.model (and the rest of the Voice & AI page) */
    _renderVoiceSection(device, aiVoice, voice) {
        const idAttr = DevicesPage._escape(device.device_id);
        const voiceEnabled = voice.enabled !== false;
        // Unset = follows the account default (WS-G) — personalityName('')
        // renders it as "Account default".
        const personality = aiVoice.personalityId || aiVoice['aiVoice.personality'] || '';
        // Resolve id → catalog name (handles custom-personality uuids + multi-word
        // built-in names); falls back to a prettified id until the catalog loads.
        const personalityLabel = DevicesDetailModals.personalityName(personality);

        // Wake word is DEVICE-scoped (D5): user_devices.aiVoice.wakeWord, reported up
        // from the device's WakeWordModelManager. '—' until the device has synced one.
        const wakeWordValue = aiVoice.wakeWord || '';
        // Label via the shared catalog (VoiceAiOptions.wakeWordLabel). This used to
        // destructure [id, label] PAIRS out of a local hand-copy of the list; that copy is
        // gone, so a pair-destructure here would silently yield undefined and render the raw
        // id ("mww_okay_nabu") instead of "Okay Nabu".
        const wakeWordLabel = wakeWordValue
            ? (window.VoiceAiOptions?.wakeWordLabel(wakeWordValue) || wakeWordValue)
            : '—';

        // Voice (aiVoice.voiceKey) — separate from personality (WS-G): unset =
        // account default; a fixed-voice effective personality locks it.
        const effP = DevicesDetailModals.personalityRecord(DevicesDetailModals.effectivePersonalityId(device));
        const voiceKey = aiVoice.voiceKey || '';
        const voiceLabel = (effP && effP.voice_mode === 'fixed')
            ? `${DevicesDetailModals.voiceName(effP.voice)} (locked)`
            : (voiceKey ? DevicesDetailModals.voiceName(voiceKey) : 'Account default');

        const rows = [
            DevicesDetailModals._toggleRow(device, 'voice', 'enabled', 'Enable Voice', voiceEnabled),
            DevicesDetailModals._summaryRow('Wake Word', wakeWordLabel,
                `DevicesDetailModals.openWakeWord('${idAttr}')`),
            DevicesDetailModals._summaryRow('Personality', personalityLabel,
                `DevicesDetailModals.openVoicePersonality('${idAttr}')`),
            DevicesDetailModals._summaryRow('Voice', voiceLabel,
                `DevicesDetailModals.openVoiceVoice('${idAttr}')`),
        ].join('');

        return this._section('voice-ai', 'Voice & AI', `
            <div class="card"><div class="card-body" style="padding: 0;">${rows}</div></div>
            <div style="margin-top: 8px; font-size: var(--font-size-sm); color: var(--text-muted);">
                Wake word changes apply after the device restarts.
                AI model lives on the <a href="#voice-ai" onclick="event.preventDefault(); App.navigate('voice-ai')">Voice & AI</a> page.
            </div>
        `);
    },

    // =========================================================
    //  Photos / Slideshow
    // =========================================================

    /**
     * Photos section removed — slideshow setting keys + option lists need
     * verification before exposing dropdowns here. Manage slideshow + albums
     * on the Photos page until OptionCatalog adds entries for slideshow
     * interval/transition (see add-on plan Phase F).
     */
    _renderPhotosSection() { return ''; },

    // =========================================================
    //  Home Assistant
    // =========================================================

    /** HA Dashboard URL row — READ-ONLY. The device owns its HA connection
     *  (Kotlin-canonical blob; a configured device refuses cloud→Kotlin HA
     *  applies via the restore guard). The real value lives at
     *  home_assistant.core.haUrl, kept fresh by the device's
     *  ACTION_HA_CONFIG_CHANGED dispatch on native edits (plan 2B). */
    _renderHomeAssistantSection(device) {
        const ha = device.settings?.home_assistant || {};
        // core.haUrl is the real field; the bare keys are legacy junk from the
        // old (dead) dashboardPath editor — kept as last-resort fallbacks.
        const url = ha.core?.haUrl || ha.dashboardPath || ha.dashboardUrl || ha.haUrl || '';
        return this._section('home-assistant', 'Home Assistant', `
            <div class="card"><div class="card-body">
                <div class="form-group">
                    <label class="form-label">Dashboard URL</label>
                    <input class="form-input" type="text" value="${DevicesPage._escape(url)}" readonly
                        style="opacity: 0.7; cursor: default;"
                        placeholder="(not configured)">
                </div>
                <div style="font-size: var(--font-size-sm); color: var(--text-muted);">
                    Read-only — the device owns its Home Assistant connection. Change it on the
                    tablet under Settings → Home Assistant; the value updates here within seconds.
                </div>
            </div></div>
        `, { defaultExpanded: false });
        // NOTE (2026-07-06): this field used to be editable but was a write-only
        // trap — it wrote home_assistant.dashboardPath (a key nothing reads), and
        // a configured device refuses cloud→Kotlin HA applies anyway (the restore
        // guard in applyDeviceSettings). Remote HA-URL editing as a real feature
        // is tracked in .reference/_TECHNICAL_DEBT.md ("Console Cannot Remotely
        // Edit a Configured Device's HA Dashboard URL").
    },

    _titleCase(s) {
        if (!s) return '—';
        return String(s).split(/[_-]/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
    },

    // =========================================================
    //  Device Behavior — HA switches not surfaced elsewhere
    // =========================================================

    _renderBehaviorSection(device, m) {
        const controls = m.controls || {};
        const hasCamera = DevicesCard._isRealCameraResolution(controls.camera_resolution);
        const switches = [
            { role: 'screensaver',            label: 'Screensaver',              description: 'Show photo slideshow during sleep' },
            { role: 'keep_screen_on',         label: 'Keep Screen On',           description: 'Prevent sleep while in use' },
            // Auto Brightness lives in Advanced Display Options modal — no
            // need to duplicate it here. (Was alongside Hide Sidebar / Hide
            // Tabs / Start on Boot in the behavior list before the Advanced
            // Display Options modal existed.)
            { role: 'hide_sidebar',           label: 'Hide Sidebar',             description: 'Maximize widget area' },
            { role: 'hide_tabs',              label: 'Hide Tabs',                description: 'Remove dashboard tabs' },
            { role: 'start_on_boot',          label: 'Start on Boot',            description: `Launch ${BRAND.productName} when the device powers on` },
            { role: 'camera_software_encoding', label: 'Camera Software Encoding', description: 'Use software codec (older devices)', requiresCamera: true },
        ].filter(s => {
            if (controls[s.role] === undefined) return false;
            // Camera-related switches only show when real camera hardware is present.
            // The Dashie app publishes the camera_software_encoding switch regardless
            // (it's a software preference), but the toggle is meaningless without
            // a camera. camera_resolution is the truth signal for actual hardware.
            if (s.requiresCamera && !hasCamera) return false;
            return true;
        });

        if (switches.length === 0) return '';
        const idAttr = DevicesPage._escape(device.device_id);
        const rows = switches.map(s => {
            const on = !!controls[s.role];
            const busy = !!DevicesCard._busyControl[`${device.device_id}:${s.role}`];
            return `
                <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid var(--border, #e5e7eb);">
                    <div style="flex: 1; min-width: 0;">
                        <div style="font-weight: 500;">${s.label}</div>
                        <div style="color: var(--text-muted); font-size: var(--font-size-sm); margin-top: 2px;">${s.description}</div>
                    </div>
                    <button title="${on ? 'On — tap to turn off' : 'Off — tap to turn on'}" ${busy ? 'disabled' : ''}
                        onclick="DevicesCard.toggleSwitch('${idAttr}', '${s.role}', ${on})"
                        style="${this._toggleSwitchStyle(on, busy)}">
                        <span style="${this._toggleKnobStyle(on)}"></span>
                    </button>
                </div>
            `;
        }).join('');
        return this._section('behavior', 'Device Behavior', `
            <div class="card"><div class="card-body" style="padding: 4px 16px;">
                ${rows}
            </div></div>
        `);
    },

    _toggleSwitchStyle(on, busy) {
        const bg = on ? '#10b981' : '#d1d5db';
        return `position: relative; width: 44px; height: 24px; border-radius: 999px; border: none; background: ${bg}; cursor: ${busy ? 'wait' : 'pointer'}; opacity: ${busy ? 0.5 : 1}; padding: 0; transition: background 0.15s;`;
    },

    _toggleKnobStyle(on) {
        return `position: absolute; top: 2px; left: ${on ? '22px' : '2px'}; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.2); transition: left 0.15s;`;
    },

    // =========================================================
    //  Admin Actions — HA buttons (relaunch / refresh / reboot…)
    // =========================================================

    _renderAdminSection(device, m) {
        const controls = m.controls || {};
        const live = DevicesPage._isLive(device);
        // Each entry: role, label, description, destructive (confirm + red)
        const actions = [
            { role: 'refresh',             label: 'Refresh WebView',       description: 'Hard-refresh the dashboard' },
            { role: 'relaunch',            label: 'Relaunch App',          description: `Restart ${BRAND.productName} on the device` },
            { role: 'bring_to_foreground', label: 'Bring to Foreground',   description: `Pull ${BRAND.productName} back to the top` },
            { role: 'clear_cache',         label: 'Clear Cache',           description: 'Wipe cached data (logs in again)', destructive: true },
            { role: 'clear_storage',       label: 'Clear Storage',         description: 'Wipe all app data on this device', destructive: true },
            { role: 'reboot',              label: 'Reboot Device',         description: 'Restart the entire device', destructive: true },
        ];
        const idAttr = DevicesPage._escape(device.device_id);
        const rows = actions.map(a => {
            // If the device reports this button entity, show it; otherwise gray it out with a hint.
            const available = controls[a.role] !== undefined;
            const busy = !!DevicesCard._busyControl[`${device.device_id}:${a.role}`];
            const handlerName = a.destructive ? '_pressDestructive' : '_pressAdmin';
            const btnColor = a.destructive ? '#c00' : 'var(--text-primary)';
            const btnBorder = a.destructive ? '#fca5a5' : 'var(--border, #d1d5db)';
            return `
                <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid var(--border, #e5e7eb); ${!available || !live ? 'opacity: 0.5;' : ''}">
                    <div style="flex: 1; min-width: 0;">
                        <div style="font-weight: 500;">${a.label}</div>
                        <div style="color: var(--text-muted); font-size: var(--font-size-sm); margin-top: 2px;">${a.description}</div>
                    </div>
                    <button title="${available ? a.description : 'Not supported on this device'}"
                        ${!available || !live || busy ? 'disabled' : ''}
                        onclick="DevicesDetail.${handlerName}('${idAttr}', '${a.role}', '${DevicesPage._escape(a.label)}')"
                        style="padding: 6px 14px; border-radius: 6px; border: 1px solid ${btnBorder}; background: #fff; color: ${btnColor}; cursor: ${busy ? 'wait' : (available && live ? 'pointer' : 'not-allowed')}; font-size: 13px; font-weight: 500;">
                        ${busy ? 'Running…' : 'Run'}
                    </button>
                </div>
            `;
        }).join('');
        return this._section('admin', 'Admin Actions', `
            <div class="card"><div class="card-body" style="padding: 4px 16px;">
                ${rows}
            </div></div>
        `, { defaultExpanded: false });
    },

    /** Non-destructive admin actions — just call pressButton. */
    _pressAdmin(deviceId, role, label) {
        DevicesCard.pressButton(deviceId, role);
    },

    /** Destructive admin actions — confirm before firing. */
    async _pressDestructive(deviceId, role, label) {
        const confirmed = await ConfirmModal.confirm({
            title: `${label}?`,
            message: `Run "${label}" on this device? This action cannot be undone.`,
            confirmLabel: label,
            cancelLabel: 'Cancel',
            danger: true,
        });
        if (!confirmed) return;
        DevicesCard.pressButton(deviceId, role);
    },

    // =========================================================
    //  Danger Zone — soft + permanent delete
    // =========================================================

    _renderDangerZone(device) {
        const idAttr = DevicesPage._escape(device.device_id);
        const nameEsc = DevicesPage._escape(device.device_name || 'Device');
        return this._section('danger', 'Danger Zone', `
            <div class="card" style="border-color: var(--status-error, #c00);">
                <div class="card-body" style="padding: 4px 16px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid var(--border, #e5e7eb);">
                        <div style="flex: 1; min-width: 0;">
                            <div style="font-weight: 500;">Remove from your account</div>
                            <div style="color: var(--text-muted); font-size: var(--font-size-sm); margin-top: 2px;">Soft delete — the device can re-register on next sign-in and reclaim its identity.</div>
                        </div>
                        <button onclick="DevicesDetail._softDelete('${idAttr}', '${nameEsc}')"
                            style="padding: 6px 14px; border-radius: 6px; border: 1px solid #fca5a5; background: #fff; color: #c00; cursor: pointer; font-size: 13px; font-weight: 500;">
                            Remove
                        </button>
                    </div>
                    <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 0;">
                        <div style="flex: 1; min-width: 0;">
                            <div style="font-weight: 500;">Permanently delete</div>
                            <div style="color: var(--text-muted); font-size: var(--font-size-sm); margin-top: 2px;">Hard delete — removes all device records and metrics. Cannot be undone.</div>
                        </div>
                        <button onclick="DevicesDetail._hardDelete('${idAttr}', '${nameEsc}')"
                            style="padding: 6px 14px; border-radius: 6px; border: none; background: #c00; color: #fff; cursor: pointer; font-size: 13px; font-weight: 500;">
                            Delete Forever
                        </button>
                    </div>
                </div>
            </div>
        `, { defaultExpanded: false, titleColor: 'color: var(--status-error, #c00);' });
    },

    async _softDelete(deviceId, deviceName) {
        const confirmed = await ConfirmModal.confirm({
            title: 'Remove device?',
            message: `Remove "${deviceName}" from your account?\n\nThe device can re-register on next sign-in.`,
            confirmLabel: 'Remove',
            cancelLabel: 'Cancel',
            danger: true,
        });
        if (!confirmed) return;
        try {
            await DashieAuth.dbRequest('delete_device', { device_id: deviceId });
            DevicesPage._devices = (DevicesPage._devices || []).filter(d => d.device_id !== deviceId);
            DevicesPage._detailDeviceId = null;
            Toast.success(`Removed "${deviceName}"`);
            App.renderPage();
        } catch (e) {
            console.error('[DevicesDetail] soft delete failed:', e);
            Toast.error(Toast.friendly(e, 'remove this device'));
        }
    },

    async _hardDelete(deviceId, deviceName) {
        const confirmed = await ConfirmModal.confirm({
            title: 'Permanently delete this device?',
            message: `This permanently deletes "${deviceName}" and all of its metrics, settings, and history.\n\nThis cannot be undone.`,
            confirmLabel: 'Delete Forever',
            cancelLabel: 'Cancel',
            danger: true,
            requireTypedConfirmation: deviceName,
            typedConfirmationLabel: `Type "${deviceName}" to confirm`,
        });
        if (!confirmed) return;
        try {
            await DashieAuth.dbRequest('delete_device', { device_id: deviceId, hard_delete: true });
            DevicesPage._devices = (DevicesPage._devices || []).filter(d => d.device_id !== deviceId);
            DevicesPage._detailDeviceId = null;
            Toast.success(`Deleted "${deviceName}" permanently`);
            App.renderPage();
        } catch (e) {
            console.error('[DevicesDetail] hard delete failed:', e);
            Toast.error(Toast.friendly(e, 'permanently delete this device'));
        }
    },

    // =========================================================
    //  Generic dropdown — used by every settings section above.
    //  Persists via DevicesPage._onSettingChange → update_device_settings.
    // =========================================================

    settingSelect(device, category, key, label, currentValue, options) {
        const savingKey = `${device.device_id}_${key}`;
        const isSaving = DevicesPage._saving[savingKey];
        // Numeric-option coercion — same reasoning as _settingSelectRaw:
        // string values into Int bridge setters arrive as 0 on the tablet.
        const numeric = options.length > 0 &&
            options.every(([val]) => /^-?\d+(\.\d+)?$/.test(String(val)));
        const valueExpr = numeric ? 'Number(this.value)' : 'this.value';
        const optionsHtml = options.map(([val, text]) =>
            `<option value="${val}" ${String(val) === String(currentValue) ? 'selected' : ''}>${text}</option>`
        ).join('');
        return `
            <div class="form-group">
                <label class="form-label">${label} ${isSaving ? '<span style="color: var(--text-muted); font-weight: 400; text-transform: none; font-size: 10px;">saving…</span>' : ''}</label>
                <select class="form-select"
                    onchange="DevicesPage._onSettingChange('${device.device_id}', '${category}', '${key}', ${valueExpr})"
                    ${isSaving ? 'disabled' : ''}>
                    ${optionsHtml}
                </select>
            </div>
        `;
    },

    // =========================================================
    //  Modal helpers — bare picker + toggle that DevicesDetailModals
    //  uses for its sleep / display modals. Same persistence path
    //  as settingSelect (DevicesPage._onSettingChange) so writes
    //  flow through the existing broadcast pipeline.
    // =========================================================

    /** Bare <select> WITHOUT the form-group wrapper. Used inside the
     *  sleep modal where the parent already laid out the .form-group. */
    _settingSelectRaw(device, category, key, currentValue, options, customOnChange) {
        // DOM select values are ALWAYS strings, but numeric settings must be
        // written as numbers: the tablet applies them via per-key Int bridge
        // setters (setScreensaverTimeout, setWidgetZoom, …) and the Android
        // JS bridge passes 0 when a string hits an Int parameter — a string
        // "600" timeout DISABLED the screensaver (2026-07-06 incident).
        // Detect numeric pickers by their option list and coerce on change.
        const numeric = options.length > 0 &&
            options.every(([val]) => /^-?\d+(\.\d+)?$/.test(String(val)));
        const valueExpr = numeric ? 'Number(this.value)' : 'this.value';
        const onChange = customOnChange
            || `DevicesPage._onSettingChange('${device.device_id}', '${category}', '${key}', ${valueExpr})`;
        const optionsHtml = options.map(([val, text]) =>
            `<option value="${val}" ${String(val) === String(currentValue) ? 'selected' : ''}>${text}</option>`
        ).join('');
        return `<select class="form-select" onchange="${onChange}">${optionsHtml}</select>`;
    },

    /** Boolean toggle row — same broadcast path. */
    _settingToggleRow(device, category, key, label, checked) {
        return `
            <div class="setting-row">
                <span class="setting-row-label">${DevicesPage._escape(label)}</span>
                <label class="toggle">
                    <input type="checkbox" ${checked ? 'checked' : ''}
                        onchange="DevicesPage._onSettingChange('${device.device_id}', '${category}', '${key}', this.checked)">
                    <span class="toggle-slider"></span>
                </label>
            </div>
        `;
    },

    /** Direct setting writer — used by composite keys (sleep.sleepMode
     *  expands into sleep.enabled + sleep.method writes). */
    _writeSetting(device, category, key, value) {
        DevicesPage._onSettingChange(device.device_id, category, key, value);
    },
};
