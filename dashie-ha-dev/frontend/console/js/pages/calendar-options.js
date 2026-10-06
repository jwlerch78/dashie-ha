/* ============================================================
   Calendar Options — account-level calendar settings

   Renders below the account/calendar groups on the Calendar page
   (mirrors calendar-edit.js's "own module, CalendarPage owns the
   state" split). Mirrors the dashboard's "Calendar Options" section
   (js/modules/Settings/pages/settings-calendar-page.js) and the
   native Kotlin CalendarPageSchema.calendarOptionsSection().

   Rows:
   - Start Week On      calendar.startWeekOn   sun | mon | sat
   - Calendar Editing   calendar.writeAccess   none | touch | voice | both

   SCOPE — why only these two. Both are ACCOUNT-level keys
   (ACCOUNT_CALENDAR_KEYS in js/data/settings/device-settings-writer.js),
   so they live in user_settings and patchUserSetting reaches every
   device. The dashboard's third row, "Start Time to Scroll To"
   (calendar.scrollTime), is deliberately NOT here: it is PER-DEVICE
   (user_devices.settings.calendar, written via saveDeviceSetting).
   Writing it to user_settings from here would save a key no device
   reads — the same silent no-op the Preferences page's header warns
   about (general.zipCode / display.*). It belongs on a device page.

   Writes go through DashieAuth.patchUserSetting (the sanctioned
   single-key writer — lint:console-writes forbids saveUserSettings
   outside console-auth.js). Reads/state live on CalendarPage._settings.
   ============================================================ */

const CalendarOptions = {
    START_WEEK_OPTIONS: [
        ['sun', 'Sunday'],
        ['mon', 'Monday'],
        ['sat', 'Saturday'],
    ],

    // Labels mirror the dashboard's renderWriteAccessScreen(). The native
    // Kotlin picker still says None/Both for the same two values — a known
    // cosmetic drift, tracked separately.
    WRITE_ACCESS_OPTIONS: [
        ['none', 'Off'],
        ['touch', 'Touch only'],
        ['voice', 'Voice only'],
        ['both', 'Voice & touch'],
    ],

    // Defaults mirror what settingsStore returns when the key is absent, so a
    // fresh account renders the same as a long-standing one.
    DEFAULTS: {
        startWeekOn: 'sun',
        writeAccess: 'touch',
    },

    /**
     * @param {Object|null} settings full user_settings tree (CalendarPage._settings)
     * @returns {string} section HTML, or '' before settings have loaded
     */
    render(settings) {
        if (!settings) return '';
        const cal = settings.calendar || {};
        const startWeekOn = cal.startWeekOn ?? this.DEFAULTS.startWeekOn;
        const writeAccess = cal.writeAccess ?? this.DEFAULTS.writeAccess;

        // Container mirrors .account-group above it so the section reads as
        // part of the same page rather than a transplant from Preferences.
        return `
            <div class="section-header">Calendar Options</div>
            <div style="border: 1px solid var(--border, #e5e7eb); border-radius: 8px; margin-bottom: 12px; overflow: hidden; background: var(--bg-card, #fff);">
                ${this._renderPickerRow('Start Week On', startWeekOn, this.START_WEEK_OPTIONS,
                    `CalendarOptions._set('startWeekOn', this.value)`)}
                ${this._renderPickerRow('Calendar Editing', writeAccess, this.WRITE_ACCESS_OPTIONS,
                    `CalendarOptions._set('writeAccess', this.value)`)}
                <div style="padding: 0 16px 12px; color: var(--text-muted); font-size: 13px;">
                    Calendar Editing controls who may add, change, or remove events.
                    “Off” and “Voice only” hide the + button and the Edit/Delete
                    options on your dashboards.
                </div>
            </div>
        `;
    },

    // ── writes ────────────────────────────────────────────────

    /**
     * Optimistically update CalendarPage._settings, re-render, then persist.
     * Single-key writes only, so no debounce/patch accumulation is needed —
     * patchUserSetting serializes on console-auth's _patchChain and the server
     * deep-merges, so a change can't clobber a concurrent writer.
     */
    async _set(key, value) {
        // Bare identifier, not window.CalendarPage — calendar.js declares it with
        // `const` in a classic script, which makes a lexical global that is NOT a
        // window property. Same access style as calendar-edit.js.
        const page = (typeof CalendarPage !== 'undefined') ? CalendarPage : null;
        if (!page || !page._settings) return;

        const previous = page._settings.calendar?.[key];
        if (!page._settings.calendar) page._settings.calendar = {};
        page._settings.calendar[key] = value;
        App.renderPage();

        try {
            await DashieAuth.patchUserSetting(`calendar.${key}`, value);
        } catch (e) {
            // Roll the optimistic write back so the select doesn't lie about
            // what's stored.
            page._settings.calendar[key] = previous;
            App.renderPage();
            Toast?.error?.(`Save failed: ${e?.message || e}`);
        }
    },

    // ── row primitives ────────────────────────────────────────
    //
    // Rolled by hand for the same reason preferences.js does: FormFields.select
    // doesn't support value/label pairs (only flat option strings).

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

    _escape(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
};
