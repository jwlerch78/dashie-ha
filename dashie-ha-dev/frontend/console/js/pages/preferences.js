/* ============================================================
   Preferences page
   ------------------------------------------------------------
   Account-wide user preferences. Mirrors the Kotlin native
   "Preferences" page (halite/settings/schemas/PreferencesPageSchema.kt)
   so a setting changed here is visible on the tablet, and vice
   versa — both sides round-trip through user_settings.

   Sections:
     - Language          general.language          picker (15 locales)
     - Date & Time       interface.use24HourClock  toggle
                         interface.dateFormat       picker (mdy/dmy)
                         time.useHa                 toggle
     - Weather           family.temperatureUnit     picker (F/C)
                         family.zipCode             text
                         weather.useHa              toggle

   PATHS ARE THE DASHBOARD-CANONICAL ones (what the widgets/services actually
   read): family.zipCode, interface.use24HourClock, interface.dateFormat,
   family.temperatureUnit. An earlier version wrote general.zipCode /
   display.* which NO dashboard consumer reads, so console changes never
   reached devices (the tablet's native Preferences page bridges display.* ->
   interface.* via ACTION_DISPLAY_SETTINGS_CHANGED, but the web console has no
   such bridge). general.language / time.useHa / weather.useHa already match.

   The "Use HA for time/weather" toggles are per-device in Kotlin;
   here they act as the account default a new device picks up at
   registration. A per-device override would live on Devices later.

   Saves: every change accumulates into a pending partial patch and
   calls DashieAuth.patchUserSettings(patch) after a 300ms debounce.
   Only the touched keys leave this page — the server deep-merges the
   patch over the stored blob, so nothing else can be clobbered (the
   old full-blob round-trip raced with other writers).
   ============================================================ */

const PreferencesPage = {
    _settings: null,         // full user_settings tree, fetched on entry (render state)
    _loading: false,
    _error: null,
    _pendingPatch: null,     // nested partial of touched keys awaiting save
    _saving: false,          // UI indicator only — serialization lives in patchUserSettings
    _saveTimer: null,        // debounce for text-input changes

    // Mirrors Kotlin's PreferencesPageSchema.languageOptions(). 'system'
    // means "follow the device locale" — the webapp falls through to
    // its built-in default in that case (no LANGUAGE in the AI prompt).
    LANGUAGE_OPTIONS: [
        ['system', 'System default'],
        ['en-US', 'English (US)'],
        ['en-GB', 'English (UK)'],
        ['es-ES', 'Spanish'],
        ['es-US', 'Spanish (US)'],
        ['fr-FR', 'French'],
        ['de-DE', 'German'],
        ['it-IT', 'Italian'],
        ['pt-BR', 'Portuguese (Brazil)'],
        ['nl-NL', 'Dutch'],
        ['pl-PL', 'Polish'],
        ['hi-IN', 'Hindi'],
        ['ja-JP', 'Japanese'],
        ['ko-KR', 'Korean'],
        ['zh-CN', 'Chinese (Simplified)'],
    ],

    DATE_FORMAT_OPTIONS: [
        ['mdy', 'Month Day, Year'],
        ['dmy', 'Day Month Year'],
    ],

    TEMP_OPTIONS: [
        ['F', 'Fahrenheit'],
        ['C', 'Celsius'],
    ],

    topBarTitle()    { return 'Preferences'; },
    topBarSubtitle() { return 'Account-wide settings shared across all your devices'; },

    onNavigateTo() { this._fetchSettings(); },

    async refresh() { await this._fetchSettings(); },

    async _fetchSettings() {
        this._loading = true;
        this._error = null;
        App.renderPage();
        try {
            this._settings = (await DashieAuth.loadUserSettings()) || {};
        } catch (e) {
            this._error = e?.message || String(e);
        }
        this._loading = false;
        App.renderPage();
    },

    // ── reads ─────────────────────────────────────────────────
    //
    // Reading nested keys: settings.general?.language etc. Defaults
    // mirror what the dashboard's settingsStore would return when the
    // key is absent — so a fresh account renders the same as a long-
    // standing one.

    _read(category, key, fallback) {
        return this._settings?.[category]?.[key] ?? fallback;
    },

    // ── writes ────────────────────────────────────────────────

    _setField(category, key, value) {
        if (!this._settings) return;
        if (!this._settings[category]) this._settings[category] = {};
        this._settings[category][key] = value;
        // Accumulate only the touched key into the pending patch — that's
        // all that gets sent; the server merges it over the stored blob.
        this._pendingPatch = this._pendingPatch || {};
        this._pendingPatch[category] = { ...(this._pendingPatch[category] || {}), [key]: value };
        App.renderPage();          // reflect the change immediately
        this._scheduleSave();
    },

    _scheduleSave() {
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this._save(), 300);
    },

    async _save() {
        this._saveTimer = null;
        const patch = this._pendingPatch;
        if (!patch || Object.keys(patch).length === 0) return;
        this._pendingPatch = null;
        this._saving = true;
        try {
            // Partial patch via the canonical serialized writer — fields
            // changed while a save is in flight land in a fresh
            // _pendingPatch and get their own (chained) save.
            await DashieAuth.patchUserSettings(patch);
            // Bust the chat client's cached language so the next turn
            // sees the new locale without a page reload.
            window.ConsoleAiClient?.invalidateLanguageCache?.();
        } catch (e) {
            Toast?.error?.(`Save failed: ${e?.message || e}`);
        } finally {
            this._saving = false;
            App.renderPage();
        }
    },

    // ── render ────────────────────────────────────────────────

    render() {
        if (this._error) {
            return `
                <div style="max-width: 800px;">
                    <div class="card"><div class="card-body" style="color: var(--status-error, #c00);">
                        Couldn't load preferences: ${this._escape(this._error)}
                        <button class="btn btn-secondary btn-sm" style="margin-left: 12px;" onclick="PreferencesPage._fetchSettings()">Retry</button>
                    </div></div>
                </div>`;
        }

        if (this._loading && !this._settings) {
            return `<div style="max-width: 800px; color: var(--text-muted); padding: 20px 0;">Loading…</div>`;
        }

        return `
            <div style="max-width: 800px;">
                ${this._renderLanguageSection()}
                ${this._renderDateTimeSection()}
                ${this._renderWeatherSection()}
                ${this._saving ? `<div style="color: var(--text-muted); font-size: var(--font-size-sm); padding: 8px 4px;">Saving…</div>` : ''}
            </div>
        `;
    },

    _renderLanguageSection() {
        const current = this._read('general', 'language', 'system');
        return `
            <div class="card" style="margin-bottom: 16px;">
                <div class="card-body">
                    <div class="section-header" style="font-weight: 600; padding: 0 4px 8px;">Language</div>
                    ${this._renderPickerRow('Language', current, this.LANGUAGE_OPTIONS,
                        `PreferencesPage._setField('general', 'language', this.value)`)}
                </div>
            </div>
        `;
    },

    _renderDateTimeSection() {
        const use24 = this._read('interface', 'use24HourClock', false);
        const fmt = this._read('interface', 'dateFormat', 'mdy');
        const useHa = this._read('time', 'useHa', false);
        return `
            <div class="card" style="margin-bottom: 16px;">
                <div class="card-body">
                    <div class="section-header" style="font-weight: 600; padding: 0 4px 8px;">Date & Time</div>
                    ${this._renderToggleRow('24-hour Clock', use24,
                        `PreferencesPage._setField('interface', 'use24HourClock', this.checked)`)}
                    ${this._renderPickerRow('Date Format', fmt, this.DATE_FORMAT_OPTIONS,
                        `PreferencesPage._setField('interface', 'dateFormat', this.value)`)}
                    ${this._renderToggleRow('Use Home Assistant for time', useHa,
                        `PreferencesPage._setField('time', 'useHa', this.checked)`)}
                </div>
            </div>
        `;
    },

    _renderWeatherSection() {
        const tempUnit = this._read('family', 'temperatureUnit', 'F');
        const zip = this._read('family', 'zipCode', '');
        const useHa = this._read('weather', 'useHa', false);
        return `
            <div class="card" style="margin-bottom: 16px;">
                <div class="card-body">
                    <div class="section-header" style="font-weight: 600; padding: 0 4px 8px;">Weather</div>
                    ${this._renderPickerRow('Temperature Unit', tempUnit, this.TEMP_OPTIONS,
                        `PreferencesPage._setField('family', 'temperatureUnit', this.value)`)}
                    ${this._renderTextRow('Location', zip, '90210 or Berlin, Germany',
                        `PreferencesPage._setField('family', 'zipCode', this.value)`)}
                    ${this._renderToggleRow('Use Home Assistant for weather', useHa,
                        `PreferencesPage._setField('weather', 'useHa', this.checked)`)}
                </div>
            </div>
        `;
    },

    // ── row primitives ────────────────────────────────────────
    //
    // Rolled by hand because FormFields.select doesn't support
    // value/label pairs (only flat option strings).

    _renderPickerRow(label, currentValue, options, onChange) {
        const optsHtml = options.map(([val, lbl]) =>
            `<option value="${this._escape(val)}" ${val === currentValue ? 'selected' : ''}>${this._escape(lbl)}</option>`
        ).join('');
        return `
            <div class="setting-row">
                <span class="setting-row-label">${this._escape(label)}</span>
                <select class="form-select" style="max-width: 240px;" onchange="${onChange}">
                    ${optsHtml}
                </select>
            </div>
        `;
    },

    _renderToggleRow(label, checked, onChange) {
        return `
            <div class="setting-row">
                <span class="setting-row-label">${this._escape(label)}</span>
                <label class="toggle">
                    <input type="checkbox" ${checked ? 'checked' : ''} onchange="${onChange}">
                    <span class="toggle-slider"></span>
                </label>
            </div>
        `;
    },

    _renderTextRow(label, value, placeholder, onChange) {
        // Use 'change' (fired on blur) rather than 'input' so we don't
        // queue a save on every keystroke — debounce on _setField is
        // already 300ms but the network round-trip is wasteful when the
        // user is mid-type.
        return `
            <div class="setting-row">
                <span class="setting-row-label">${this._escape(label)}</span>
                <input class="form-input" type="text" value="${this._escape(value || '')}"
                    placeholder="${this._escape(placeholder)}"
                    style="max-width: 240px;"
                    onchange="${onChange}">
            </div>
        `;
    },

    _escape(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
};

window.PreferencesPage = PreferencesPage;
