/* ============================================================
   DevicesHousehold — the "Edit defaults" dialog (P4a Phase C)
   ------------------------------------------------------------
   John's shape, 2026-09-21 (confirmed against his mock-up): one dialog off the
   Devices page with two sections —
     • Screens — starting values for NEW screens; existing screens keep their own
     • Voice   — devices on the household FOLLOW changes, live

   🔴 THE TWO SECTIONS HAVE OPPOSITE SEMANTICS AND THAT IS THE WHOLE POINT OF
   THE DIALOG. A Screens default SEEDS a device once and then stops mattering;
   a Voice default is FOLLOWED continuously by every device that has not
   overridden it. Showing them in one dialog without saying which is which is
   how someone changes a theme default and expects every tablet to repaint.
   Each section states its own rule in its subtitle; do not "tidy" those away.

   ⚠️ WHY THE SCREENS SECTION IS NOT WIRED (measured 2026-09-21, not assumed):
   there is no account-level store for a screen default. The ONLY account
   defaults that exist are three voice ones — `ai.defaultPersonalityId`,
   `ai.defaultVoiceKey`, `ai.defaultWakeWord` — and they are the only ones the
   server exposes (server/account-config.js:167-169). Nothing seeds a newly
   adopted device's settings from a household value either. So Theme / Sleep /
   Photo album have nowhere to read from and nowhere to write to.
   Rendering three live-looking controls over that would be a dialog that
   accepts a choice and silently drops it — the worst of the options — so the
   section renders as NOT SET UP YET and says so. Wiring it needs new account
   keys plus a seeding rule at adoption, which is John's call, not a modal's.
   ============================================================ */

const DevicesHousehold = {
    _open: false,

    open() { this._open = true; App.renderPage(); },
    close() { this._open = false; App.renderPage(); },

    /** Backdrop click closes, a click inside does not. */
    _onBackdrop(event) { if (event.target === event.currentTarget) this.close(); },

    /**
     * How many active devices FOLLOW the household voice defaults — i.e. have not
     * overridden any voice leaf key.
     *
     * 🔴 Reuses DevicesDetailModals.voiceSetupSummary rather than re-deriving
     * "is this device custom?". That predicate already knows the inherit
     * sentinel ('' is inherit, not a value) and the leaf-key list; a second
     * copy here would disagree with the card's Voice tile the first time either
     * changed, and the symptom would be a COUNT that contradicts the dots
     * visible on the same screen.
     */
    _followerCount() {
        if (typeof DevicesDetailModals?.voiceSetupSummary !== 'function') return null;
        // 🔴 null = NOT KNOWN YET, and it must stay distinguishable from zero.
        // voiceSetupSummary decides "custom" by comparing each device against the
        // HOUSEHOLD values; until those have loaded it compares against {}, so the
        // number it produces is an artefact of the load rather than a fact about
        // the fleet. Returning it anyway would print a confident "Followed by N
        // devices" that changes a second later with nothing having happened —
        // the same falsy-test trap AccountSettingsStore's own header describes.
        DevicesDetailModals.ensureAccountSettings?.();
        if (!DevicesDetailModals._accountSettings) return null;
        const devices = (DevicesPage._devices || []).filter((d) => d.is_active !== false);
        return devices.filter((d) => !DevicesDetailModals.voiceSetupSummary(d).custom).length;
    },

    _row(label, value, hint) {
        return `
            <div class="hh-row">
                <div class="hh-row-main">
                    <span class="hh-row-label">${DevicesPage._escape(label)}</span>
                    <span class="hh-row-value">${DevicesPage._escape(value)}</span>
                </div>
                ${hint ? `<div class="hh-row-hint">${DevicesPage._escape(hint)}</div>` : ''}
            </div>`;
    },

    _screensSection() {
        // See the header note: no store exists for these three. Stated, not faked.
        return `
            <div class="hh-section">
                <div class="hh-section-head">
                    <span class="hh-section-title">Screens</span>
                    <span class="hh-section-sub">Starting values for new screens</span>
                </div>
                <div class="hh-empty">
                    Not set up yet. New screens currently start from the app's own
                    defaults, and each screen keeps whatever you set on it.
                </div>
            </div>`;
    },

    _voiceSection() {
        const acct = (typeof AccountSettingsStore !== 'undefined' && AccountSettingsStore.get()) || null;
        const n = this._followerCount();
        // ⚠️ null means NOT LOADED, not zero (AccountSettingsStore.get contract).
        // A falsy test here would print "followed by 0 devices" during the load
        // and read as a real answer.
        const followed = (n === null) ? 'Counting…'
            : `Followed by ${n} device${n === 1 ? '' : 's'}`;
        const persona = acct?.ai?.defaultPersonalityId || '—';
        const wake = acct?.ai?.defaultWakeWord || '—';
        const pretty = (s) => (typeof DevicesCard?._prettify === 'function'
            ? DevicesCard._prettify(s) : s);
        return `
            <div class="hh-section">
                <div class="hh-section-head">
                    <span class="hh-section-title">Voice</span>
                    <span class="hh-section-sub">Devices on the household follow these</span>
                </div>
                ${this._row('Personality', persona === '—' ? '—' : pretty(persona))}
                ${this._row('Wake word', wake === '—' ? '—' : pretty(wake))}
                <div class="hh-foot-note">${DevicesPage._escape(followed)}</div>
                <button type="button" class="hh-link" onclick="DevicesHousehold.close(); App.navigate('voice-ai')">
                    Change on Voice &amp; AI ›
                </button>
            </div>`;
    },

    render() {
        if (!this._open) return '';
        if (typeof AccountSettingsStore !== 'undefined') AccountSettingsStore.ensure();
        const body = this._screensSection() + this._voiceSection();
        const footer = `
            <div class="modal-footer">
                <button type="button" class="btn btn-primary" onclick="DevicesHousehold.close()">Done</button>
            </div>`;
        return `
            <div class="modal-backdrop" onclick="DevicesHousehold._onBackdrop(event)">
                <div class="modal" style="max-width: 480px; width: 92vw;">
                    <div class="modal-header">
                        <span class="modal-title-group">
                            <span class="modal-title">Household defaults</span>
                        </span>
                        <button class="modal-close" onclick="DevicesHousehold.close()">✕</button>
                    </div>
                    <div class="modal-body">${body}</div>
                    ${footer}
                </div>
            </div>`;
    },
};

window.DevicesHousehold = DevicesHousehold;
