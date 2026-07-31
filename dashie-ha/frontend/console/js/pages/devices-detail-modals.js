/* ============================================================
   Devices Detail — Display section body + modals
   ------------------------------------------------------------
   Mirrors the Kotlin DisplayPageSchema: three sub-section cards
   (Dashboard / Screen Management / Display Preferences) each
   containing summary-rows. Click → modal in this file. Inline
   toggles (Animations) skip the modal layer.

   Modal taxonomy:
     - Sleep modal: composite (mode + schedule + inactivity + options)
     - Theme modal: theme family + dark mode
     - Screensaver modal: timeout + mode + per-mode options
     - Picker modal: generic single-setting picker, reused for
       Layout / Orientation / Animation Level / Wake Mode / Zooms /
       Sidebar Icon Size / Screen Off Behavior

   Persistence: every write goes through DevicesPage._onSettingChange,
   same broadcast path the inline form-grid used to use.
   ============================================================ */

const DevicesDetailModals = {

    // ── Option catalogs (mirror Kotlin DisplayPageSchema) ──────

    LAYOUT_MODES: [
        ['widgets', 'Widgets'],
        ['single_panel', 'Single Panel'],
        ['kiosk', 'Kiosk mode (HA-only)'],
    ],
    // Kiosk is NOT console-settable — the Kotlin bridge setLayoutMode rejects
    // anything but widgets/single_panel, so offering it made the write revert.
    // Full LAYOUT_MODES stays for label lookup; the picker uses this subset. When
    // a device is already in kiosk, the row renders read-only (see below).
    WRITABLE_LAYOUT_MODES: [
        ['widgets', 'Widgets'],
        ['single_panel', 'Single Panel'],
    ],

    ORIENTATION_MODES: [
        ['auto', 'Auto'],
        ['landscape', 'Landscape'],
        ['landscape_reverse', 'Landscape (reversed)'],
        ['portrait', 'Portrait'],
        ['portrait_reverse', 'Portrait (reversed)'],
    ],

    THEME_FAMILIES: [
        ['default', 'Default'],
        ['blue', 'Blue'],
        ['halloween', 'Halloween'],
        ['christmas', 'Christmas'],
    ],

    ANIMATION_LEVELS: [
        ['high', 'High'],
        ['low', 'Low'],
    ],

    WAKE_MODES: [
        ['disabled', 'Touch Only'],
        ['brightness', 'Brightness Sensor'],
        ['camera', 'Motion (Camera)'],
        ['face', 'Face Detection (Camera)'],
    ],

    ZOOM_LEVELS: [
        ['50', '50%'], ['75', '75%'], ['90', '90%'], ['100', '100%'],
        ['110', '110%'], ['125', '125%'], ['150', '150%'],
        ['175', '175%'], ['200', '200%'],
    ],

    // Mirror Kotlin DisplayPageSchema displaySizeSubScreen — scales
    // native chrome (sidebar, control center, music/video/voice cards).
    DISPLAY_SIZES: [
        ['100', '100%'], ['125', '125%'], ['150', '150%'],
        ['175', '175%'], ['200', '200%'],
    ],

    // Mirror Kotlin DisplayPageSchema font_size_picker — scales widget text.
    FONT_SIZES: [
        ['75', '75%'], ['100', '100%'], ['125', '125%'], ['150', '150%'],
    ],

    SIDEBAR_ICON_SIZES: [
        ['0.75', 'Very Small'],
        ['0.9', 'Small'],
        ['1', 'Medium'],
        ['1.15', 'Large'],
        ['1.3', 'Extra Large'],
    ],

    SCREEN_OFF_BEHAVIORS: [
        ['black_overlay', 'Black Overlay'],
        ['power_off', 'Power Off Screen'],
    ],

    SCREENSAVER_TIMEOUTS: [
        ['0', 'Off'], ['10', '10 sec'], ['30', '30 sec'],
        ['60', '1 min'], ['120', '2 min'], ['300', '5 min'],
        ['600', '10 min'], ['1800', '30 min'],
    ],

    SCREENSAVER_MODES: [
        ['dim', 'Dim'],
        ['black', 'Black Overlay'],
        ['off', 'Screen Off'],
        ['photos', 'Photos'],
        ['weather', 'Weather & Time'],
    ],

    // Wake words now come from VoiceAiOptions.WAKE_WORDS — ONE console copy, shared with
    // the Voice & AI page, whose ids are lint-gated against Kotlin's WakeWordModel
    // (npm run lint:voice-options). This used to be a second hand-copy here, carrying the
    // comment "Mirror Kotlin WakeWordModel.BUNDLED_MODEL_IDS" — i.e. a hand-mirror that
    // nothing checked. Don't reintroduce it.
    get WAKE_WORDS() {
        return window.VoiceAiOptions?.WAKE_WORDS || [];
    },

    // ── Account-settings cache (for ai.wakeWord and other account-wide
    //    fields we surface read/edit from the device detail page) ─────

    _accountSettings: null,     // populated by ensureAccountSettings()
    _accountLoading: false,

    /** Lazy-load user_settings the first time something on this page needs
     *  an account-level field. Re-render when the load resolves so the
     *  Voice section's Wake Word row swaps from "—" to the real value. */
    ensureAccountSettings() {
        if (this._accountSettings || this._accountLoading) return;
        this._accountLoading = true;
        DashieAuth.loadUserSettings().then(s => {
            this._accountSettings = s || {};
            this._accountLoading = false;
            App.renderPage();
        }).catch(() => {
            this._accountSettings = {};
            this._accountLoading = false;
        });
    },

    /**
     * The household's default wake word — what a device with no override follows.
     *
     * Reads `ai.defaultWakeWord` (ACCOUNT default, WS-G §13.2). It used to read
     * `ai.wakeWord`, which since D5 is the DEVICE-scoped key and does not live in
     * user_settings at all — so this returned '' for every household and the Devices
     * page's "Account default" always rendered blank. Nothing errored; it just showed
     * nothing, forever. (Kiosk-mirror audit #5, the second half.)
     */
    getAccountWakeWord() {
        return this._accountSettings?.ai?.defaultWakeWord || '';
    },

    // ── Section body ──────────────────────────────────────────

    renderDisplayBody(device, display, sleep) {
        const idAttr = DevicesPage._escape(device.device_id);
        const screensaver = device.settings?.screensaver || {};
        const sleepSummary = this.buildSleepSummary(sleep, display);
        const themeSummary = this.buildThemeSummary(display);
        const animationsOn = display.animationsEnabled === true || display['display.animationsEnabled'] === true;
        const themeFamily = display.themeFamily || 'default';
        const layoutMode = display.layoutMode || display['preferences.layoutMode'] || 'widgets';
        const showOrientation = layoutMode === 'widgets';
        const showAnimationRows = themeFamily !== 'default';

        return `
            ${this._subsectionCard('Dashboard', [
                layoutMode === 'kiosk'
                    ? this._readonlyRow('Layout', this._labelFor(this.LAYOUT_MODES, 'kiosk'))
                    : this._summaryRow('Layout', this._labelFor(this.LAYOUT_MODES, layoutMode),
                        `DevicesDetailModals.openPicker('${idAttr}','display','layoutMode','Layout','WRITABLE_LAYOUT_MODES','widgets')`),
                showOrientation ? this._summaryRow('Orientation',
                    this._labelFor(this.ORIENTATION_MODES, display.orientationLock || 'auto'),
                    `DevicesDetailModals.openPicker('${idAttr}','display','orientationLock','Orientation','ORIENTATION_MODES','auto')`) : '',
                FeatureGate.optionAllowed('display.themeFamily')
                    ? this._summaryRow('Theme', themeSummary,
                        `DevicesDetailModals.openTheme('${idAttr}')`)
                    : '',
                showAnimationRows ? this._toggleRow(device, 'display', 'animationsEnabled',
                    'Animations', animationsOn) : '',
                showAnimationRows && animationsOn ? this._summaryRow('Animation Level',
                    this._labelFor(this.ANIMATION_LEVELS, display.animationLevel || display['preferences.animationLevel'] || 'high'),
                    `DevicesDetailModals.openPicker('${idAttr}','display','animationLevel','Animation Level','ANIMATION_LEVELS','high')`) : '',
            ].filter(Boolean).join(''))}
            ${this._subsectionCard('Screen Management', [
                this._summaryRow('Sleep Mode', sleepSummary,
                    `DevicesDetailModals.openSleep('${idAttr}')`),
                this._summaryRow('Screensaver', this.buildScreensaverSummary(display, screensaver),
                    `DevicesDetailModals.openScreensaver('${idAttr}')`),
                // Read-only: motionWakeMode is sync:'readback-only' (no cloud→Kotlin
                // setter), so a console write silently reverts on the next readback.
                this._readonlyRow('Wake Mode',
                    this._labelFor(this.WAKE_MODES, display.motionWakeMode || 'disabled')),
                // Granular Display Preferences (zooms, display/font size,
                // sidebar icon size, screen-off, auto brightness) collapse
                // into one row → modal. Summary text intentionally blank
                // — the modal has six+ values and surfacing any subset on
                // the row was just noise the user has to parse.
                this._summaryRow('Advanced Display Options', '',
                    `DevicesDetailModals.openAdvancedDisplay('${idAttr}')`),
            ].join(''))}
        `;
    },

    _subsectionCard(title, rowsHtml) {
        return `
            <div class="card" style="margin-bottom: 12px;">
                <div class="card-body" style="padding: 0;">
                    <div style="padding: 12px 16px 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted);">${this._escape(title)}</div>
                    ${rowsHtml}
                </div>
            </div>
        `;
    },

    _summaryRow(label, summary, onClick) {
        return `
            <div onclick="${onClick}" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; cursor: pointer; gap: 12px; border-top: 1px solid var(--border-subtle);"
                onmouseenter="this.style.background='var(--bg-subtle, #f3f4f6)'" onmouseleave="this.style.background='transparent'">
                <span style="font-size: var(--font-size-sm); font-weight: 500;">${this._escape(label)}</span>
                <span style="display: inline-flex; align-items: center; gap: 8px; color: var(--text-secondary); font-size: var(--font-size-sm); text-align: right;">
                    ${this._escape(summary)}
                    <span style="color: var(--text-muted); font-size: 14px;">›</span>
                </span>
            </div>
        `;
    },

    // Read-only display row (no chevron / click). Use for device settings the
    // console can SHOW but not CHANGE — e.g. readback-only keys that have no
    // cloud→Kotlin setter (motionWakeMode, sidebarIconSize) or values the bridge
    // rejects (layoutMode 'kiosk'). Rendering them as pickers made the write a
    // silent no-op that the device readback then reverted.
    _readonlyRow(label, summary) {
        return `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; gap: 12px; border-top: 1px solid var(--border-subtle);">
                <span style="font-size: var(--font-size-sm); font-weight: 500;">${this._escape(label)}</span>
                <span style="color: var(--text-muted); font-size: var(--font-size-sm); text-align: right;">${this._escape(summary)}</span>
            </div>
        `;
    },

    _toggleRow(device, category, key, label, checked) {
        return `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-top: 1px solid var(--border-subtle);">
                <span style="font-size: var(--font-size-sm); font-weight: 500;">${this._escape(label)}</span>
                <label class="toggle">
                    <input type="checkbox" ${checked ? 'checked' : ''}
                        onchange="DevicesPage._onSettingChange('${device.device_id}', '${category}', '${key}', this.checked)">
                    <span class="toggle-slider"></span>
                </label>
            </div>
        `;
    },

    /** External call kept for any leftover callers (kept stable across refactors). */
    renderSummaryRow(label, summary, onClick) { return this._summaryRow(label, summary, onClick); },

    // ── Summary builders (mirror Kotlin control center) ────────

    /** "22:00 / 07:00 (Black Overlay)" / "2 min timeout (Black Overlay)" / "Inactive" */
    buildSleepSummary(sleep, display) {
        // Blob keys are UNPREFIXED (native-settings-listener.js writes enabled,
        // sleepMethod, sleepTime, wakeTime, inactivityTimeout). Mode is derived:
        // off when disabled, else the method. (Was reading sleep['sleep.enabled']
        // etc. — always undefined, so the summary rendered defaults forever.)
        const enabled = sleep.enabled !== false;
        if (!enabled) return 'Inactive';
        const method = sleep.sleepMethod || 'schedule';
        let timeStr;
        if (method === 'inactivity') {
            const seconds = Number(sleep.inactivityTimeout ?? 120);
            timeStr = `${this._formatTimeout(seconds)} timeout`;
        } else {
            const start = sleep.sleepTime || '22:00';
            const end = sleep.wakeTime || '07:00';
            timeStr = `${this._formatTime(start)} / ${this._formatTime(end)}`;
        }
        const screenOff = (display && (display.screenOffBehavior || display['display.screenOffBehavior'])) || 'black_overlay';
        const offLabel = screenOff === 'power_off' ? 'Power Off' : 'Black Overlay';
        return `${timeStr} (${offLabel})`;
    },

    /** Just the theme family — dark/light is its own toggle inside the
     *  Theme modal, surfacing it here doubles up the same control. */
    buildThemeSummary(display) {
        const fam = display.themeFamily || 'default';
        return this._labelFor(this.THEME_FAMILIES, fam);
    },

    /** "Photos, 5 min" / "Off" / "{Mode} ({timeout})"
     *  Reads from user_devices.settings.screensaver.* (the canonical shape
     *  written by device-registration.js _buildScreensaverSettings), falling
     *  back to legacy display.screensaverX paths if the device hasn't yet
     *  written the new category. */
    buildScreensaverSummary(display, screensaver) {
        const s = screensaver || {};
        const timeout = Number(s.timeout ?? display?.screensaverTimeout ?? display?.['screensaver.timeout'] ?? 0);
        if (!timeout) return 'Off';
        const mode = s.mode || display?.screensaverMode || display?.['screensaver.mode'] || 'dim';
        const modeLabel = this._labelFor(this.SCREENSAVER_MODES, mode);
        return `${modeLabel}, ${this._formatTimeout(timeout)}`;
    },

    // ── Sleep modal ────────────────────────────────────────────

    _sleepOpen: false,
    _sleepDeviceId: null,

    openSleep(deviceId) { this._applyAllArmed = false; this._sleepOpen = true; this._sleepDeviceId = deviceId; App.renderPage(); },
    closeSleep() { this._sleepOpen = false; this._sleepDeviceId = null; App.renderPage(); },

    renderSleepModal() {
        if (!this._sleepOpen) return '';
        const device = DevicesPage._findDevice(this._sleepDeviceId);
        if (!device) return '';
        const sleep = device.settings?.sleep || {};
        const display = device.settings?.display || {};

        // Keys MUST match the app's blob (SETTINGS_KEY_MAP.sleep): enabled,
        // sleepMethod, sleepTime, wakeTime, resleepTimeout, inactivityTimeout,
        // sleepShowClock, reduceBrightnessOnSleep, motionWakeForSleep. There is
        // NO `sleep.*`-prefixed key and NO stored sleepMode — the mode is derived
        // from enabled + sleepMethod (off / schedule / inactivity).
        const enabled = sleep.enabled !== false;
        const method = sleep.sleepMethod || 'schedule';
        const sleepMode = !enabled ? 'off' : method;
        const scheduleVisible = sleepMode === 'schedule';
        const inactivityVisible = sleepMode === 'inactivity';
        const optionsVisible = sleepMode !== 'off';
        const screenOff = display.screenOffBehavior || 'black_overlay';
        const notPowerOff = screenOff !== 'power_off';

        const D = DevicesDetail;
        const body = `
            <div style="display: flex; flex-direction: column; gap: 14px;">
                <div class="form-group">
                    <label class="form-label">Sleep Mode</label>
                    ${D._settingSelectRaw(device, 'sleep', 'sleepMode', sleepMode, [
                        ['off', 'Off'], ['schedule', 'Schedule'], ['inactivity', 'Timeout']
                    ], 'DevicesDetailModals._onSleepModeChange(this.value)')}
                </div>
                ${scheduleVisible ? `
                    ${this._divider('Schedule')}
                    ${D.settingSelect(device, 'sleep', 'sleepTime',
                        'Sleep Time', sleep.sleepTime || '22:00', OptionCatalog.sleepTimes())}
                    ${D.settingSelect(device, 'sleep', 'wakeTime',
                        'Wake Time', sleep.wakeTime || '07:00', OptionCatalog.wakeTimes())}
                    ${D.settingSelect(device, 'sleep', 'resleepTimeout',
                        'Re-sleep Delay (min)', String(sleep.resleepTimeout ?? 15), OptionCatalog.resleepDelays())}
                ` : ''}
                ${inactivityVisible ? `
                    ${this._divider('Inactivity')}
                    ${D.settingSelect(device, 'sleep', 'inactivityTimeout',
                        'Sleep After (sec)', String(sleep.inactivityTimeout ?? 120), OptionCatalog.inactivityTimeouts())}
                ` : ''}
                ${optionsVisible ? `
                    ${this._divider('Options')}
                    ${D._settingSelectRaw(device, 'display', 'screenOffBehavior', screenOff, this.SCREEN_OFF_BEHAVIORS)}
                    ${notPowerOff ? `
                        ${D._settingToggleRow(device, 'sleep', 'sleepShowClock',
                            'Show Clock During Sleep', sleep.sleepShowClock === true)}
                        ${D._settingToggleRow(device, 'sleep', 'reduceBrightnessOnSleep',
                            'Reduce Brightness While Asleep', sleep.reduceBrightnessOnSleep === true)}
                    ` : ''}
                    ${D._settingToggleRow(device, 'sleep', 'motionWakeForSleep',
                        'Motion Wake', sleep.motionWakeForSleep === true)}
                ` : ''}
            </div>
        `;
        return this._modal('Sleep / Wake', body, 'DevicesDetailModals.closeSleep()', this._applyToAllFooter());
    },

    _onSleepModeChange(value) {
        const device = DevicesPage._findDevice(this._sleepDeviceId);
        if (!device) return;
        const enabled = value !== 'off';
        // Preserve the underlying schedule/inactivity method when turning sleep
        // off, so re-enabling restores the prior mode. Only enabled + sleepMethod
        // are persisted — sleepMode is a UI-only projection of those two.
        const method = value === 'off' ? (device.settings?.sleep?.sleepMethod || 'schedule') : value;
        DevicesPage._onSettingChange(device.device_id, 'sleep', 'enabled', enabled);
        DevicesPage._onSettingChange(device.device_id, 'sleep', 'sleepMethod', method);
    },

    // ── Theme modal (family + dark mode) ──────────────────────

    _themeOpen: false,
    _themeDeviceId: null,

    openTheme(deviceId) { this._applyAllArmed = false; this._themeOpen = true; this._themeDeviceId = deviceId; App.renderPage(); },
    closeTheme() { this._themeOpen = false; this._themeDeviceId = null; App.renderPage(); },

    renderThemeModal() {
        if (!this._themeOpen) return '';
        // Belt and braces: the row that opens this is already gated, but the
        // modal is reachable by any other caller and this is a family-only
        // control (seasonal theme families).
        if (!FeatureGate.optionAllowed('display.themeFamily')) return '';
        const device = DevicesPage._findDevice(this._themeDeviceId);
        if (!device) return '';
        const display = device.settings?.display || {};
        const D = DevicesDetail;
        // Dark/Light mode is a SEPARATE control (the Quick Controls row on the
        // device card), NOT part of the theme. Deliberately omitted here and
        // from buildThemeSummary — theme = family only (2026-07-06, per user).
        const body = `
            <div style="display: flex; flex-direction: column; gap: 14px;">
                <div class="form-group">
                    <label class="form-label">Theme</label>
                    ${D._settingSelectRaw(device, 'display', 'themeFamily',
                        display.themeFamily || 'default', this.THEME_FAMILIES)}
                </div>
                <div style="font-size: var(--font-size-sm); color: var(--text-muted);">
                    Seasonal themes (Halloween, Christmas) auto-activate during their respective months.
                </div>
            </div>
        `;
        return this._modal('Theme', body, 'DevicesDetailModals.closeTheme()', this._applyToAllFooter());
    },

    // ── Generic single-picker modal ───────────────────────────

    _pickerOpen: false,
    _pickerCtx: null,  // {deviceId, category, key, label, optionsCatalogKey}

    openPicker(deviceId, category, key, label, optionsCatalogKey, defaultValue) {
        this._pickerOpen = true;
        this._pickerCtx = { deviceId, category, key, label, optionsCatalogKey, defaultValue };
        App.renderPage();
    },
    closePicker() { this._pickerOpen = false; this._pickerCtx = null; App.renderPage(); },

    renderPickerModal() {
        if (!this._pickerOpen) return '';
        const ctx = this._pickerCtx;
        const device = DevicesPage._findDevice(ctx.deviceId);
        if (!device) return '';
        // Edition filter, applied HERE so it covers every picker rather than
        // each caller remembering. ctx.category+key is exactly the key shape
        // FAMILY_ONLY_OPTIONS uses (e.g. 'display.layoutMode' → drops 'widgets',
        // the family dashboard, from the published build).
        const options = FeatureGate.filterOptions(
            `${ctx.category}.${ctx.key}`, this[ctx.optionsCatalogKey] || []);
        // Default chain: stored value → caller-supplied default → first
        // option. Falling all the way through to options[0] is what made
        // Widget Zoom show "50%" when the device hadn't yet broadcast
        // a value — callers should pass an explicit defaultValue.
        const stored = device.settings?.[ctx.category]?.[ctx.key];
        const current = (stored != null && stored !== '') ? stored
            : (ctx.defaultValue != null ? ctx.defaultValue
            : options[0]?.[0]);
        const body = `
            <div class="form-group">
                <label class="form-label">${this._escape(ctx.label)}</label>
                ${DevicesDetail._settingSelectRaw(device, ctx.category, ctx.key, String(current), options)}
            </div>
        `;
        return this._modal(ctx.label, body, 'DevicesDetailModals.closePicker()');
    },

    // ── Screensaver modal ─────────────────────────────────────

    _screensaverOpen: false,
    _screensaverDeviceId: null,

    openScreensaver(deviceId) { this._screensaverOpen = true; this._screensaverDeviceId = deviceId; App.renderPage(); },
    closeScreensaver() { this._screensaverOpen = false; this._screensaverDeviceId = null; App.renderPage(); },

    renderScreensaverModal() {
        if (!this._screensaverOpen) return '';
        const device = DevicesPage._findDevice(this._screensaverDeviceId);
        if (!device) return '';
        const s = device.settings?.screensaver || {};
        const display = device.settings?.display || {};
        const timeout = String(s.timeout ?? display.screensaverTimeout ?? '0');
        const mode = s.mode || display.screensaverMode || 'dim';
        const D = DevicesDetail;
        const enabled = timeout !== '0';
        const showClock = s.showClock === true;
        const body = `
            <div style="display: flex; flex-direction: column; gap: 14px;">
                <div class="form-group">
                    <label class="form-label">Timeout</label>
                    ${D._settingSelectRaw(device, 'screensaver', 'timeout', timeout, this.SCREENSAVER_TIMEOUTS)}
                </div>
                ${enabled ? `
                    <div class="form-group">
                        <label class="form-label">Mode</label>
                        ${D._settingSelectRaw(device, 'screensaver', 'mode', mode, this.SCREENSAVER_MODES)}
                    </div>
                    ${(mode === 'dim' || mode === 'black' || mode === 'photos') ? `
                        ${D._settingToggleRow(device, 'screensaver', 'showClock', 'Show Clock', showClock)}
                        ${showClock ? D._settingToggleRow(device, 'screensaver', 'showDate',
                            'Show Date', s.showDate === true) : ''}
                    ` : ''}
                ` : ''}
            </div>
        `;
        return this._modal('Screensaver', body, 'DevicesDetailModals.closeScreensaver()');
    },

    // ── Advanced Display Options modal ────────────────────────

    _advancedDisplayOpen: false,
    _advancedDisplayDeviceId: null,

    openAdvancedDisplay(deviceId) {
        this._advancedDisplayOpen = true;
        this._advancedDisplayDeviceId = deviceId;
        App.renderPage();
    },
    closeAdvancedDisplay() {
        this._advancedDisplayOpen = false;
        this._advancedDisplayDeviceId = null;
        App.renderPage();
    },

    /** "100% / 100% · Medium" — most-glanceable values for the row. */
    _buildAdvancedDisplaySummary(display) {
        const ds = String(display.displaySize ?? '100');
        const fs = String(display.widgetFontSize ?? '100');
        const sis = this._labelFor(this.SIDEBAR_ICON_SIZES, String(display.sidebarIconSize ?? '1'));
        return `${ds}% / ${fs}% · ${sis}`;
    },

    renderAdvancedDisplayModal() {
        if (!this._advancedDisplayOpen) return '';
        const device = DevicesPage._findDevice(this._advancedDisplayDeviceId);
        if (!device) return '';
        const display = device.settings?.display || {};
        const D = DevicesDetail;
        const body = `
            <div style="display: flex; flex-direction: column; gap: 14px;">
                <div class="form-group">
                    <label class="form-label">Display Size</label>
                    ${D._settingSelectRaw(device, 'display', 'displaySize',
                        String(display.displaySize ?? '100'), this.DISPLAY_SIZES)}
                </div>
                <div class="form-group">
                    <label class="form-label">Font Size</label>
                    ${D._settingSelectRaw(device, 'display', 'widgetFontSize',
                        String(display.widgetFontSize ?? '100'), this.FONT_SIZES)}
                </div>
                <div class="form-group">
                    <label class="form-label">HA Dashboard Zoom</label>
                    ${D._settingSelectRaw(device, 'display', 'dashboardZoom',
                        String(display.dashboardZoom ?? '100'), this.ZOOM_LEVELS)}
                </div>
                <div class="form-group">
                    <label class="form-label">Widget Zoom</label>
                    ${D._settingSelectRaw(device, 'display', 'widgetZoom',
                        String(display.widgetZoom ?? '100'), this.ZOOM_LEVELS)}
                </div>
                <div class="form-group">
                    <label class="form-label">Sidebar Icon Size</label>
                    <!-- Read-only: sidebarIconSize is sync:'readback-only' (no cloud→Kotlin
                         setter), so a console write silently reverts on the next readback. -->
                    <div style="padding: 8px 0; color: var(--text-muted); font-size: var(--font-size-sm);">${this._escape(this._labelFor(this.SIDEBAR_ICON_SIZES, String(display.sidebarIconSize ?? '1')))}</div>
                </div>
                <div class="form-group">
                    <label class="form-label">Screen Off Behavior</label>
                    ${D._settingSelectRaw(device, 'display', 'screenOffBehavior',
                        display.screenOffBehavior || 'black_overlay', this.SCREEN_OFF_BEHAVIORS)}
                </div>
                ${D._settingToggleRow(device, 'display', 'autoBrightnessEnabled',
                    'Auto Brightness', display.autoBrightnessEnabled === true)}
            </div>
        `;
        return this._modal('Advanced Display Options', body, 'DevicesDetailModals.closeAdvancedDisplay()');
    },

    // ── Wake Word modal (DEVICE-level user_devices.aiVoice.wakeWord — D5) ──
    // Per-device, mirroring the Personality picker. The device's WakeWordModelManager
    // persists the selection and applies it on the NEXT restart, so the UI tells the user.

    _wakeWordOpen: false,
    _wakeWordDeviceId: null,
    _wakeWordSaving: false,
    _wakeWordPending: null,  // value chosen but not yet persisted

    openWakeWord(deviceId) {
        this._wakeWordOpen = true;
        this._wakeWordDeviceId = deviceId;
        this._wakeWordPending = null;
        App.renderPage();
    },

    closeWakeWord() {
        this._wakeWordOpen = false;
        this._wakeWordDeviceId = null;
        this._wakeWordPending = null;
        App.renderPage();
    },

    _setWakeWordPending(value) { this._wakeWordPending = value; },

    async submitWakeWord() {
        if (this._wakeWordSaving) return;
        const value = this._wakeWordPending;
        const deviceId = this._wakeWordDeviceId;
        if (!value || !deviceId) { this.closeWakeWord(); return; }
        this._wakeWordSaving = true;
        App.renderPage();
        try {
            // Per-device write: user_devices.aiVoice.wakeWord (the path the app reads +
            // reports back). Same merge-per-key RPC the Personality/Theme pickers use.
            await DevicesPage._onSettingChange(deviceId, 'aiVoice', 'wakeWord', value);
            Toast.success('Wake word saved — restart the device to apply');
            this.closeWakeWord();
        } catch (e) {
            Toast.error(`Save failed: ${e?.message || e}`);
        } finally {
            this._wakeWordSaving = false;
            App.renderPage();
        }
    },

    renderWakeWordModal() {
        if (!this._wakeWordOpen) return '';
        const device = DevicesPage._findDevice(this._wakeWordDeviceId);
        const current = this._wakeWordPending != null
            ? this._wakeWordPending
            : (device?.settings?.aiVoice?.wakeWord || 'hey_dashie');
        const optionsHtml = this.WAKE_WORDS.map(({ id, label }) =>
            `<option value="${this._escape(id)}" ${id === current ? 'selected' : ''}>${this._escape(label)}</option>`
        ).join('');
        const body = `
            <div class="form-group">
                <label class="form-label">Wake Word</label>
                <select class="form-select" onchange="DevicesDetailModals._setWakeWordPending(this.value)">
                    ${optionsHtml}
                </select>
            </div>
            <div style="font-size: var(--font-size-sm); color: var(--text-muted);">
                This device's wake word. <strong>Applies after the device restarts.</strong>
            </div>
            <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px;">
                <button class="btn btn-secondary" onclick="DevicesDetailModals.closeWakeWord()" ${this._wakeWordSaving ? 'disabled' : ''}>Cancel</button>
                <button class="btn btn-primary" onclick="DevicesDetailModals.submitWakeWord()" ${this._wakeWordSaving ? 'disabled' : ''}>${this._wakeWordSaving ? 'Saving…' : 'Save'}</button>
            </div>
        `;
        return this._modal('Wake Word', body, 'DevicesDetailModals.closeWakeWord()');
    },

    // ── Personality catalog (shared) ──────────────────────────────
    // A device stores aiVoice.personalityId — a built-in template KEY
    // ('dashie', 'pirate', …) or a custom personality UUID. The card/detail
    // summaries and the picker all need to turn that id into a human name, so
    // the catalog + resolver live here and are reused everywhere. Matches the
    // app's own scheme (personality-service.js: template id === key, custom by
    // uuid) and the Voice & AI page (_personalityRow: key for built-ins, id for
    // custom). Cached for the session; prefetched by DevicesPage on load.

    _personalityCatalog: null,  // [[id, name], …] templates (by key) + custom (by uuid)
    _personalityRecords: null,  // raw rows (voice_mode/voice) — for the voice-lock check (WS-G)

    async loadPersonalityCatalog() {
        if (this._personalityCatalog || typeof VoiceAiApi === 'undefined') return this._personalityCatalog;
        try {
            const [templates, custom] = await Promise.all([
                VoiceAiApi.listTemplates().catch(() => []),
                VoiceAiApi.listCustom().catch(() => []),
            ]);
            const opts = [];
            const records = new Map();
            for (const t of templates || []) {
                const key = t.key || t.id;
                if (!key) continue;
                opts.push([String(key), t.name || DevicesDetail._titleCase(key)]);
                records.set(String(key), t);
            }
            for (const c of custom || []) {
                if (!c.id) continue;
                opts.push([String(c.id), c.name || 'Custom personality']);
                records.set(String(c.id), c);
            }
            this._personalityCatalog = opts;
            this._personalityRecords = records;
        } catch { this._personalityCatalog = []; this._personalityRecords = new Map(); }
        return this._personalityCatalog;
    },

    personalityRecord(id) {
        return (this._personalityRecords || new Map()).get(String(id)) || null;
    },

    // ── Voice catalog + account defaults (shared by the WS-G modals) ──

    _voiceCatalog: null,          // tts_voices rows ({key, name, gender, …})
    _accountDefaults: null,       // { personalityId, voiceKey } — ai.default*

    async _loadVoiceCatalog() {
        if (this._voiceCatalog || typeof VoiceAiApi === 'undefined') return this._voiceCatalog;
        try { this._voiceCatalog = await VoiceAiApi.listVoices(); }
        catch { this._voiceCatalog = []; }
        return this._voiceCatalog;
    },

    async _loadAccountDefaults() {
        try {
            const d = await VoiceAiApi.loadAiDefaults();
            this._accountDefaults = {
                personalityId: String(d['ai.defaultPersonalityId'] || 'dashie'),
                voiceKey: String(d['ai.defaultVoiceKey'] || ''),
            };
        } catch { /* labels render without names */ }
        return this._accountDefaults;
    },

    /** Resolve a voice key → display name (falls back to a prettified key). */
    voiceName(key) {
        if (!key) return '';
        const v = (this._voiceCatalog || []).find(x => (x.key || x.voice_key) === key);
        return v?.name || (key.charAt(0) + key.slice(1).toLowerCase());
    },

    /** The personality a device EFFECTIVELY runs: its own override, else the
     *  account default (WS-G resolution rule — mirrored here for display/lock). */
    effectivePersonalityId(device) {
        return device.settings?.aiVoice?.personalityId
            || this._accountDefaults?.personalityId
            || 'dashie';
    },

    /** Resolve a stored personalityId → display name. Falls back to a prettified
     *  id when the catalog hasn't loaded yet or the id is unknown (e.g. a custom
     *  personality that was deleted). An empty id = the device follows the
     *  account default (WS-G unset-=-inherit). */
    personalityName(id) {
        if (!id) return 'Account default';
        const hit = (this._personalityCatalog || []).find(([v]) => v === String(id));
        return hit ? hit[1] : DevicesDetail._titleCase(id);
    },

    // ── Personality picker (device-level aiVoice.personalityId) ───

    _personalityOpen: false,
    _personalityDeviceId: null,

    async openVoicePersonality(deviceId) {
        this._applyAllArmed = false;
        this._personalityOpen = true;
        this._personalityDeviceId = deviceId;
        App.renderPage();
        // Lazy-load the personality catalog + the account defaults (labels the
        // "Account default (<name>)" inherit option). Best-effort.
        await Promise.all([this.loadPersonalityCatalog(), this._loadAccountDefaults()]);
        App.renderPage();
    },

    closeVoicePersonality() { this._personalityOpen = false; App.renderPage(); },

    renderVoicePersonalityModal() {
        if (!this._personalityOpen) return '';
        const device = DevicesPage._findDevice(this._personalityDeviceId);
        if (!device) return '';
        // '' / unset = follow the account default (WS-G). Runtime resolution is
        // device ?? account default; until Round B ships it, an inheriting
        // device behaves as the app default (Dashie).
        const current = device.settings?.aiVoice?.personalityId || '';
        const defaultName = this._accountDefaults?.personalityId
            ? ` (${this.personalityName(this._accountDefaults.personalityId)})` : '';
        // Ensure the currently-stored personality is always selectable, even if
        // the catalog is still loading or the id is no longer in the catalog —
        // otherwise the <select> would silently snap to the first option and a
        // stray change-event could overwrite a valid value.
        const catalog = [['', `Account default${defaultName}`], ...(this._personalityCatalog || [])];
        const options = catalog.some(([v]) => v === String(current))
            ? catalog
            : [[String(current), this.personalityName(current)], ...catalog];
        const body = `
            <div class="form-group">
                <label class="form-label">Personality</label>
                ${DevicesDetail._settingSelectRaw(device, 'aiVoice', 'personalityId', String(current), options)}
            </div>
            <div style="font-size: var(--font-size-sm); color: var(--text-muted);">
                “Account default” follows the personality set on the <a href="#voice-ai" onclick="event.preventDefault(); App.navigate('voice-ai')">Voice & AI</a> page; picking one here overrides it for this device only.
            </div>
        `;
        return this._modal('Personality', body, 'DevicesDetailModals.closeVoicePersonality()', this._applyToAllFooter());
    },

    // ── Voice picker (device-level aiVoice.voiceKey — WS-G) ───────
    // Separate from personality: the device speaks the account default voice
    // unless overridden here. Voice lock wins — when the device's EFFECTIVE
    // personality (override ?? account default) fixes its voice, there is no
    // picker, just the locked explanation.

    _voiceOpen: false,
    _voiceDeviceId: null,

    async openVoiceVoice(deviceId) {
        this._applyAllArmed = false;
        this._voiceOpen = true;
        this._voiceDeviceId = deviceId;
        App.renderPage();
        await Promise.all([this.loadPersonalityCatalog(), this._loadVoiceCatalog(), this._loadAccountDefaults()]);
        App.renderPage();
    },

    closeVoiceVoice() { this._voiceOpen = false; App.renderPage(); },

    renderVoiceVoiceModal() {
        if (!this._voiceOpen) return '';
        const device = DevicesPage._findDevice(this._voiceDeviceId);
        if (!device) return '';
        const effectiveId = this.effectivePersonalityId(device);
        const p = this.personalityRecord(effectiveId);
        if (p && p.voice_mode === 'fixed') {
            const body = `
                <div style="font-size: 14px; margin-bottom: 8px;">
                    ${DevicesPage._escape(this.voiceName(p.voice))}
                    <span style="font-size: 11px; font-weight: 600; color: var(--text-muted); background: var(--bg-muted, #f4f4f5); border-radius: 999px; padding: 2px 8px; margin-left: 8px;">locked by ${DevicesPage._escape(p.name || 'personality')}</span>
                </div>
                <div style="font-size: var(--font-size-sm); color: var(--text-muted);">
                    ${DevicesPage._escape(p.name || 'This personality')} always speaks in this voice.
                    Choose a voice-flexible personality (here or on the Voice &amp; AI page) to pick a voice.
                </div>`;
            return this._modal('Voice', body, 'DevicesDetailModals.closeVoiceVoice()');
        }
        // '' / unset = follow the account default voice (itself '' = the
        // personality's preferred voice). Same inherit sentinel as personality.
        // Premium flag (John, 2026-07-12): ElevenLabs voices cost ~4× the
        // default Dashie voice (Inworld) per character — mark them explicitly.
        const current = device.settings?.aiVoice?.voiceKey || '';
        const accountVoice = this._accountDefaults?.voiceKey
            ? this.voiceName(this._accountDefaults.voiceKey)
            : (p?.voice ? this.voiceName(p.voice) : '');
        const options = [
            ['', `Account default${accountVoice ? ` (${accountVoice})` : ''}`],
            ...(this._voiceCatalog || []).map(v => {
                const key = v.key || v.voice_key;
                const tier = v.provider === 'elevenlabs' ? ' · premium'
                    : v.provider === 'inworld' ? ' · most economical' : '';
                return [key, `${v.name || key}${v.gender ? ` · ${v.gender}` : ''}${tier}`];
            }),
        ];
        const body = `
            <div class="form-group">
                <label class="form-label">Voice</label>
                ${DevicesDetail._settingSelectRaw(device, 'aiVoice', 'voiceKey', String(current), options)}
            </div>
            <div style="font-size: var(--font-size-sm); color: var(--text-muted);">
                “Account default” follows the voice set on the <a href="#voice-ai" onclick="event.preventDefault(); App.navigate('voice-ai')">Voice &amp; AI</a> page; picking one here overrides it for this device only.
                Premium voices cost about 4× the default ${BRAND.assistantName} voice per reply.
            </div>`;
        return this._modal('Voice', body, 'DevicesDetailModals.closeVoiceVoice()', this._applyToAllFooter());
    },

    // ── Photos picker (device-level photos.sourceType + album) ────
    // Source type is device-specific; albums are listable only for the Dashie
    // Cloud (supabase) source via list_albums (account-level album catalog).
    // Writes photos.sourceType, and photos.albumId + photos.albumName when a
    // Dashie Cloud album is chosen — the keys applyDeviceSettings fans out to
    // the photo widget on each device.

    _photosOpen: false,
    _photosDeviceId: null,
    _photosSource: null,        // live source selection (drives album-picker visibility)
    _photosAlbums: null,        // cached list_albums result this session

    async openPhotos(deviceId) {
        this._applyAllArmed = false;
        this._photosOpen = true;
        this._photosDeviceId = deviceId;
        const device = DevicesPage._findDevice(deviceId);
        this._photosSource = device?.settings?.photos?.sourceType || 'unsplash';
        App.renderPage();
        if (this._photosSource === 'supabase') this._loadAlbums();
    },

    closePhotos() {
        this._photosOpen = false;
        this._photosDeviceId = null;
        this._photosSource = null;
        App.renderPage();
    },

    async _loadAlbums() {
        if (this._photosAlbums || typeof DashieAuth === 'undefined') return;
        try {
            const res = await DashieAuth.dbRequest('list_albums', {});
            this._photosAlbums = res.albums || res.data || [];
        } catch { this._photosAlbums = []; }
        App.renderPage();
    },

    // Source options mirror settings-photos-page.js. HA sources (Home Assistant,
    // Immich) only make sense when the device runs HA, so gate them on the
    // device's stored home_assistant.core.haEnabled. The console user is always
    // logged in, so the cloud/drive sources are always offered.
    _photoSourceOptions(device) {
        const haEnabled = device?.settings?.home_assistant?.core?.haEnabled === true;
        // The edition filter drops `supabase` (Dashie Cloud albums — family
        // product) and `google_drive` (needs the Google Drive OAuth scope, which
        // the HA edition deliberately does not request) from the published build.
        // HA Media / Immich / Unsplash stay — screensaver albums are core here.
        return FeatureGate.filterOptions('photos.sourceType', [
            ...(haEnabled ? [['ha_media', 'Home Assistant'], ['immich', 'Immich']] : []),
            ['google_drive', 'Google Drive'],
            ['supabase', BRAND.cloudName],
            ['unsplash', 'Unsplash'],
        ]);
    },

    renderPhotosModal() {
        if (!this._photosOpen) return '';
        const device = DevicesPage._findDevice(this._photosDeviceId);
        if (!device) return '';
        const photos = device.settings?.photos || {};
        const source = this._photosSource || photos.sourceType || 'unsplash';
        const D = DevicesDetail;

        let albumPicker = '';
        if (source === 'supabase') {
            if (this._photosAlbums === null) {
                albumPicker = `<div style="font-size: var(--font-size-sm); color: var(--text-muted);">Loading albums…</div>`;
            } else {
                const albumOpts = [['', 'All photos'],
                    ...this._photosAlbums.map(a => [String(a.id), a.name || 'Untitled album'])];
                albumPicker = `
                    <div class="form-group">
                        <label class="form-label">Album</label>
                        ${D._settingSelectRaw(device, 'photos', 'albumId', String(photos.albumId || ''),
                            albumOpts, 'DevicesDetailModals._onPhotoAlbumChange(this.value)')}
                    </div>`;
            }
        } else if (source === 'immich') {
            albumPicker = this._renderImmichAlbums(photos);
        }

        // Only sources with no album picker get the generic "configure on device" note.
        const noPicker = source !== 'supabase' && source !== 'immich';
        const body = `
            <div style="display: flex; flex-direction: column; gap: 14px;">
                <div class="form-group">
                    <label class="form-label">Photo Source</label>
                    ${D._settingSelectRaw(device, 'photos', 'sourceType', source,
                        this._photoSourceOptions(device), 'DevicesDetailModals._onPhotoSourceChange(this.value)')}
                </div>
                ${albumPicker}
                ${noPicker ? `
                    <div style="font-size: var(--font-size-sm); color: var(--text-muted);">
                        Album selection is available for the ${BRAND.cloudName} and Immich sources. Other
                        sources use their own configuration on the device.
                    </div>` : ''}
            </div>
        `;
        return this._modal('Photos', body, 'DevicesDetailModals.closePhotos()', this._applyToAllFooter());
    },

    // ── Immich albums (multi-select) ──────────────────────────────
    // The device publishes its album catalog to photos.availableImmichAlbums
    // ([{id, name}]) on each Immich sync (report-only — the Console never fetches
    // Immich directly; it's self-hosted behind the user's HA/LAN). The selection
    // lives in photos.immichSelectedAlbums (array of album ids; empty = all/random,
    // matching Kotlin ScreensaverPreferences.immich_selected_albums). NOTE: the
    // WRITE only reaches the device once the settings-clobber fix + a Kotlin
    // setImmichSelectedAlbums adopt-path ship — see .reference/SETTINGS_CONSOLE_DEVICE_CLOBBER.md.

    /** Album ids the device has selected (empty = all). Filters the "*" sentinel. */
    _immichSelected(photos) {
        const sel = photos?.immichSelectedAlbums;
        return Array.isArray(sel) ? sel.map(String).filter(x => x && x !== '*') : [];
    },

    _renderImmichAlbums(photos) {
        const available = Array.isArray(photos.availableImmichAlbums) ? photos.availableImmichAlbums : null;
        if (!available || available.length === 0) {
            return `<div class="form-group"><label class="form-label">Albums</label>
                <div style="font-size: var(--font-size-sm); color: var(--text-muted);">
                    This device hasn't published its Immich albums yet. Once it next syncs with
                    Immich, its albums will appear here to choose from.
                </div></div>`;
        }
        const selected = this._immichSelected(photos);
        const allSelected = selected.length === 0;
        const row = (checked, onChange, label, bold) => `
            <label style="display: flex; align-items: center; gap: 8px; padding: 6px 0; cursor: pointer;">
                <input type="checkbox" ${checked ? 'checked' : ''} onchange="${onChange}">
                <span style="${bold ? 'font-weight: 500;' : ''}">${DevicesPage._escape(label)}</span>
            </label>`;
        const items = available.map(a => {
            const id = String(a.id);
            return row(selected.includes(id),
                `DevicesDetailModals._onImmichAlbumToggle('${id}', this.checked)`,
                a.name || 'Untitled album', false);
        }).join('');
        return `
            <div class="form-group">
                <label class="form-label">Albums</label>
                <div style="border-bottom: 1px solid var(--border, #e5e7eb);">
                    ${row(allSelected, 'DevicesDetailModals._onImmichAlbumAll(this.checked)', 'All albums', true)}
                </div>
                <div style="max-height: 220px; overflow-y: auto;">${items}</div>
            </div>`;
    },

    /** Card summary of the Immich album selection. */
    immichAlbumSummary(photos) {
        const sel = this._immichSelected(photos);
        if (!sel.length) return 'All albums';
        const available = Array.isArray(photos.availableImmichAlbums) ? photos.availableImmichAlbums : [];
        if (sel.length === 1) {
            const hit = available.find(a => String(a.id) === sel[0]);
            return hit ? (hit.name || '1 album') : '1 album';
        }
        return `${sel.length} albums`;
    },

    _onImmichAlbumAll(checked) {
        // Checking "All albums" clears the selection (empty = all/random on device).
        // Unchecking it is a no-op — pick a specific album to narrow instead.
        if (!checked) { App.renderPage(); return; }
        DevicesPage._onSettingChange(this._photosDeviceId, 'photos', 'immichSelectedAlbums', []);
        App.renderPage();
    },

    _onImmichAlbumToggle(albumId, checked) {
        const device = DevicesPage._findDevice(this._photosDeviceId);
        let sel = this._immichSelected(device?.settings?.photos);
        sel = checked ? [...new Set([...sel, albumId])] : sel.filter(id => id !== albumId);
        DevicesPage._onSettingChange(this._photosDeviceId, 'photos', 'immichSelectedAlbums', sel);
        App.renderPage();
    },

    _onPhotoSourceChange(value) {
        this._photosSource = value;
        DevicesPage._onSettingChange(this._photosDeviceId, 'photos', 'sourceType', value);
        if (value === 'supabase') this._loadAlbums();
        App.renderPage();
    },

    _onPhotoAlbumChange(albumId) {
        const album = (this._photosAlbums || []).find(a => String(a.id) === String(albumId));
        const albumName = album ? (album.name || '') : '';
        // albumId + albumName are written together — the widget keys off albumId
        // but the card/summary shows albumName.
        DevicesPage._onSettingChange(this._photosDeviceId, 'photos', 'albumId', albumId || '');
        DevicesPage._onSettingChange(this._photosDeviceId, 'photos', 'albumName', albumName);
    },

    // ── PIN modal (set / change / clear) ──────────────────────

    _pinOpen: false,
    _pinDeviceId: null,
    _pinHadPin: false,
    _pinForm: { value: '', confirm: '', busy: false, error: null },

    openPinModal(deviceId, hadPin) {
        this._pinOpen = true;
        this._pinDeviceId = deviceId;
        this._pinHadPin = !!hadPin;
        this._pinForm = { value: '', confirm: '', busy: false, error: null };
        App.renderPage();
    },

    closePinModal() {
        this._pinOpen = false;
        this._pinDeviceId = null;
        this._pinForm = { value: '', confirm: '', busy: false, error: null };
        App.renderPage();
    },

    _setPinField(field, value) { this._pinForm[field] = value; },

    async submitPin() {
        const f = this._pinForm;
        if (f.busy) return;
        if (!/^\d{4,8}$/.test(f.value)) {
            f.error = 'PIN must be 4–8 digits.';
            App.renderPage();
            return;
        }
        if (f.value !== f.confirm) {
            f.error = 'PINs don\'t match.';
            App.renderPage();
            return;
        }
        f.busy = true; f.error = null;
        App.renderPage();
        try {
            // No dedicated PIN write path exists yet — route through the
            // same settings broadcast pipeline; the device-side consumer
            // can read security.pin from user_devices.settings the same
            // way it reads sleep/display settings.
            DevicesPage._onSettingChange(this._pinDeviceId, 'security', 'pin', f.value);
            DevicesPage._onSettingChange(this._pinDeviceId, 'security', 'pinSet', true);
            Toast.success('PIN updated');
            this.closePinModal();
        } catch (e) {
            f.error = e?.message || String(e);
            f.busy = false;
            App.renderPage();
        }
    },

    async clearPin() {
        if (this._pinForm.busy) return;
        this._pinForm.busy = true; this._pinForm.error = null;
        App.renderPage();
        try {
            DevicesPage._onSettingChange(this._pinDeviceId, 'security', 'pin', '');
            DevicesPage._onSettingChange(this._pinDeviceId, 'security', 'pinSet', false);
            Toast.success('PIN cleared');
            this.closePinModal();
        } catch (e) {
            this._pinForm.error = e?.message || String(e);
            this._pinForm.busy = false;
            App.renderPage();
        }
    },

    renderPinModal() {
        if (!this._pinOpen) return '';
        const f = this._pinForm;
        const body = `
            <div style="display: flex; flex-direction: column; gap: 12px;">
                <div class="form-group">
                    <label class="form-label">New PIN (4–8 digits)</label>
                    <input class="form-input" type="password" inputmode="numeric" maxlength="8" value="${this._escape(f.value)}"
                        oninput="DevicesDetailModals._setPinField('value', this.value)">
                </div>
                <div class="form-group">
                    <label class="form-label">Confirm PIN</label>
                    <input class="form-input" type="password" inputmode="numeric" maxlength="8" value="${this._escape(f.confirm)}"
                        oninput="DevicesDetailModals._setPinField('confirm', this.value)">
                </div>
                ${f.error ? `<div style="color: var(--status-error, #c00); font-size: var(--font-size-sm);">${this._escape(f.error)}</div>` : ''}
                <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px;">
                    ${this._pinHadPin ? `<button class="btn btn-secondary" onclick="DevicesDetailModals.clearPin()" ${f.busy ? 'disabled' : ''}>Clear PIN</button>` : ''}
                    <button class="btn btn-secondary" onclick="DevicesDetailModals.closePinModal()" ${f.busy ? 'disabled' : ''}>Cancel</button>
                    <button class="btn btn-primary" onclick="DevicesDetailModals.submitPin()" ${f.busy ? 'disabled' : ''}>${this._pinHadPin ? 'Update PIN' : 'Set PIN'}</button>
                </div>
            </div>
        `;
        return this._modal(this._pinHadPin ? 'Change PIN' : 'Set PIN', body, 'DevicesDetailModals.closePinModal()');
    },

    // ── Modal shell + helpers ─────────────────────────────────

    _modal(title, bodyHtml, onClose, footerHtml) {
        return `
            <div class="modal-backdrop" onclick="DevicesDetailModals._onBackdrop(event, '${onClose}')">
                <div class="modal" style="max-width: 480px; width: 92vw;">
                    <div class="modal-header">
                        <span class="modal-title">${this._escape(title)}</span>
                        <button class="modal-close" onclick="${onClose}">✕</button>
                    </div>
                    <div class="modal-body">${bodyHtml}</div>
                    ${footerHtml || ''}
                </div>
            </div>
        `;
    },

    /**
     * "Apply to all devices" checkbox, rendered as a modal footer. When checked,
     * DevicesPage._onSettingChange reads this at write time (by stable id) and
     * fans the same (category, key, value) out to every active device instead of
     * just the one being edited. Stateless — the checkbox IS the state, so there
     * is nothing to reset on close (only one settings modal is open at a time).
     * Checking it first asks for confirmation (see _confirmApplyToAll) so it
     * can't be armed by accident.
     */
    // Module-state, NOT the DOM checkbox (2026-07-06 fix): a background
    // re-render (the device_settings realtime consumer) rebuilt the modal and
    // reset a checkbox-only flag, so the fan-out silently wrote to only the
    // open device. Render the box from this flag; read the flag at write
    // time (DevicesPage._onSettingChange). Reset to false whenever an
    // apply-to-all modal opens so it never leaks across devices/dialogs.
    _applyAllArmed: false,

    _applyToAllFooter() {
        return `
            <div class="modal-footer" style="padding: 12px 16px; border-top: 1px solid var(--border, #e5e7eb);">
                <label class="setting-row" style="cursor: pointer; margin: 0; display: flex; align-items: center; gap: 10px;">
                    <input type="checkbox" id="device-apply-to-all" ${this._applyAllArmed ? 'checked' : ''}
                           onchange="DevicesDetailModals._confirmApplyToAll(this)">
                    <span class="setting-row-label" style="font-size: var(--font-size-sm);">Apply to all devices</span>
                </label>
            </div>
        `;
    },

    // The keys each apply-to-all modal manages — used to retro-apply the open
    // device's CURRENT values to all others the moment apply-to-all is armed,
    // so "change the setting, THEN check apply to all" works (the common
    // order). Without this, arming only affects FUTURE changes and the change
    // the user already made never fanned out (2026-07-06 christmas repro).
    _APPLY_ALL_KEYS: {
        theme:       { idKey: '_themeDeviceId',       keys: [['display', 'themeFamily'], ['display', 'darkMode']] },
        sleep:       { idKey: '_sleepDeviceId',       keys: [['sleep', 'enabled'], ['sleep', 'sleepMethod'], ['sleep', 'sleepTime'], ['sleep', 'wakeTime'], ['sleep', 'resleepTimeout'], ['sleep', 'inactivityTimeout']] },
        personality: { idKey: '_personalityDeviceId', keys: [['aiVoice', 'personalityId'], ['aiVoice', 'voiceKey']] },
        voice:       { idKey: '_voiceDeviceId',       keys: [['aiVoice', 'voiceKey']] },
        photos:      { idKey: '_photosDeviceId',      keys: [['photos', 'sourceType'], ['photos', 'albumId'], ['photos', 'albumName'], ['photos', 'slideshowInterval']] },
    },

    /** Which apply-to-all modal is currently open → its key spec. */
    _openApplyAllSpec() {
        if (this._themeOpen)       return this._APPLY_ALL_KEYS.theme;
        if (this._sleepOpen)       return this._APPLY_ALL_KEYS.sleep;
        if (this._personalityOpen) return this._APPLY_ALL_KEYS.personality;
        if (this._voiceOpen)       return this._APPLY_ALL_KEYS.voice;
        if (this._photosOpen)      return this._APPLY_ALL_KEYS.photos;
        return null;
    },

    /** Fan the open device's CURRENT values for the modal's managed keys out
     *  to every other active device. Called on arm so the setting the user
     *  already picked propagates immediately, not only on the next change. */
    async _fanOutCurrentOnArm() {
        const spec = this._openApplyAllSpec();
        if (!spec) return;
        const src = DevicesPage._findDevice(this[spec.idKey]);
        if (!src) return;
        const others = (DevicesPage._devices || [])
            .filter(d => d.is_active !== false && d.device_id !== src.device_id);
        // Group by category so we write each category once per device.
        const byCat = {};
        for (const [cat, key] of spec.keys) {
            const val = src.settings?.[cat]?.[key];
            if (val === undefined) continue;
            (byCat[cat] = byCat[cat] || {})[key] = val;
        }
        for (const device of others) {
            for (const [cat, vals] of Object.entries(byCat)) {
                try {
                    await DashieAuth.dbRequest('update_device_settings', {
                        device_id: device.device_id, settings_path: cat, settings_value: vals,
                    });
                    device.settings = device.settings || {};
                    device.settings[cat] = { ...(device.settings[cat] || {}), ...vals };
                    DashieAuth._broadcastDeviceSettingsChanged(
                        device.device_id, cat, device.settings[cat]).catch(() => {});
                } catch (e) {
                    console.warn('[DevicesDetailModals] apply-to-all arm fan-out failed:', e.message);
                }
            }
        }
    },

    /** Guard on the "apply to all" toggle: while armed, every change in this
     *  dialog fans out to all active devices. Confirm intent before arming;
     *  on confirm we ALSO retro-apply the current values (so the change the
     *  user just made propagates). Unchecking never needs confirmation. */
    async _confirmApplyToAll(checkbox) {
        if (!checkbox.checked) { this._applyAllArmed = false; return; }
        const count = (DevicesPage._devices || []).filter(d => d.is_active !== false).length;
        const ok = await ConfirmModal.confirm({
            title: 'Apply to all devices?',
            message: `This applies the current settings in this dialog to all ${count} devices, and keeps applying any further changes here while it stays checked.`,
            confirmLabel: 'Apply to all',
        });
        this._applyAllArmed = !!ok;
        if (!ok) { checkbox.checked = false; return; }
        await this._fanOutCurrentOnArm();
    },

    _onBackdrop(event, onClose) {
        if (event.target.classList.contains('modal-backdrop')) {
            // eslint-disable-next-line no-new-func
            new Function(onClose)();
        }
    },

    _divider(label) {
        return `<div style="margin: 4px 0 -4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted);">${this._escape(label)}</div>`;
    },

    _labelFor(options, value) {
        const v = String(value);
        const found = options.find(([val]) => String(val) === v);
        return found ? found[1] : v;
    },

    _formatTimeout(seconds) {
        if (!isFinite(seconds) || seconds <= 0) return '0 sec';
        if (seconds < 60) return `${seconds} sec`;
        if (seconds < 3600) {
            const m = Math.round(seconds / 60);
            return m === 1 ? '1 min' : `${m} min`;
        }
        const h = Math.round(seconds / 3600 * 10) / 10;
        return h === 1 ? '1 hour' : `${h} hours`;
    },

    /** "22:00" → "10:00pm" (lowercased am/pm to match Kotlin look). */
    _formatTime(hhmm) {
        if (!hhmm || typeof hhmm !== 'string') return hhmm || '—';
        const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
        if (!m) return hhmm;
        let h = parseInt(m[1], 10);
        const mm = m[2];
        const period = h < 12 ? 'am' : 'pm';
        if (h === 0) h = 12;
        else if (h > 12) h -= 12;
        return `${h}:${mm}${period}`;
    },

    _escape(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
};

window.DevicesDetailModals = DevicesDetailModals;
