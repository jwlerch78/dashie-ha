/* ============================================================
   Chores & Rewards Options Modal (shared)
   ============================================================ */

const OptionsModal = {
    _open: false,
    _form: null,
    _saving: false,
    _userSettings: null,
    _allFamilyMembers: null,
    _onSaved: null,      // callback(fullSettings) after successful save

    open(userSettings, allFamilyMembers, onSaved) {
        this._userSettings = userSettings || {};
        this._allFamilyMembers = allFamilyMembers || [];
        this._onSaved = onSaved || null;
        const s = this._userSettings;
        this._form = {
            choresEnabled: s.chores?.enabled !== false,
            rewardsEnabled: s.rewards?.enabled !== false,
            anyoneEnabled: s.chores?.anyoneEnabled !== false,
            participants: Array.isArray(s.chores?.participants) ? [...s.chores.participants] : null,
            upcomingDays: Number.isFinite(s.chores?.upcomingDays) ? s.chores.upcomingDays : 7,
        };
        this._open = true;
        App.renderPage();
    },

    close() {
        this._open = false;
        this._form = null;
        this._onSaved = null;
        App.renderPage();
    },

    render() {
        if (!this._open || !this._form) return '';
        const f = this._form;
        const members = this._allFamilyMembers || [];
        const participantsList = f.participants === null ? members.map(m => m.id) : f.participants;

        const memberCircles = members.map(m => {
            const isSel = participantsList.includes(m.id);
            const name = m.nickname || (m.full_name || '').split(' ')[0] || 'Unknown';
            const initial = (m.full_name || m.nickname || '?')[0].toUpperCase();
            const color = m.assigned_color || '#999';
            return `
                <button type="button" class="member-circle ${isSel ? 'selected' : ''}"
                    onclick="OptionsModal._toggleParticipant('${m.id}')" title="${this._escape(name)}">
                    <div class="member-avatar" style="background: ${color};">
                        ${this._escape(initial)}
                        ${isSel ? '<span class="check-badge">✓</span>' : ''}
                    </div>
                    <div class="member-label">${this._escape(name)}</div>
                </button>
            `;
        }).join('');

        return `
            <div class="modal-backdrop" onclick="OptionsModal._onBackdrop(event)">
                <div class="modal" onclick="event.stopPropagation()">
                    <div class="modal-header">
                        <span class="modal-title">Chores &amp; Rewards Options</span>
                        <button class="modal-close" onclick="OptionsModal.close()">✕</button>
                    </div>
                    <div class="modal-body">
                        <div class="chore-field">
                            <label class="toggle-row">
                                <span class="toggle-text">Enable Chores</span>
                                <label class="toggle"><input type="checkbox" ${f.choresEnabled ? 'checked' : ''}
                                    onchange="OptionsModal._form.choresEnabled = this.checked; App.renderPage();">
                                    <span class="toggle-slider"></span></label>
                            </label>
                            <div class="field-hint">Master switch for chores. Disabling hides chores on all devices.</div>
                        </div>

                        <div class="chore-field">
                            <label class="toggle-row">
                                <span class="toggle-text">Enable Rewards</span>
                                <label class="toggle"><input type="checkbox" ${f.rewardsEnabled ? 'checked' : ''}
                                    onchange="OptionsModal._form.rewardsEnabled = this.checked; App.renderPage();">
                                    <span class="toggle-slider"></span></label>
                            </label>
                            <div class="field-hint">Family members can redeem points for rewards when enabled.</div>
                        </div>

                        <div class="chore-field">
                            <label class="toggle-row">
                                <span class="toggle-text">Allow "Anyone" Chores</span>
                                <label class="toggle"><input type="checkbox" ${f.anyoneEnabled ? 'checked' : ''}
                                    onchange="OptionsModal._form.anyoneEnabled = this.checked; App.renderPage();">
                                    <span class="toggle-slider"></span></label>
                            </label>
                            <div class="field-hint">When on, chores can be marked "Anyone" so any participant can complete them.</div>
                        </div>

                        <div class="chore-field">
                            <label class="chore-field-label">Upcoming Days</label>
                            <input type="number" class="chore-field-input" value="${f.upcomingDays}"
                                min="1" max="30" style="max-width: 120px;"
                                oninput="OptionsModal._form.upcomingDays = parseInt(this.value) || 7">
                            <div class="field-hint">How many days ahead to show upcoming chores.</div>
                        </div>

                        <div class="chore-field">
                            <div class="chore-field-header">
                                <label class="chore-field-label">Chore Participants</label>
                                <div class="quick-selectors">
                                    <button type="button" class="quick-btn" onclick="OptionsModal._selectAll()">All</button>
                                    <button type="button" class="quick-btn" onclick="OptionsModal._selectKids()">Kids Only</button>
                                    <button type="button" class="clear-link" onclick="OptionsModal._clear()">Clear</button>
                                </div>
                            </div>
                            <div class="field-hint" style="margin-bottom: 8px;">Only selected members appear in the Assignments view.</div>
                            <div class="member-row">${memberCircles}</div>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-ghost" onclick="OptionsModal.close()" ${this._saving ? 'disabled' : ''}>Cancel</button>
                        <button class="btn btn-primary" onclick="OptionsModal._save()" ${this._saving ? 'disabled' : ''}>
                            ${this._saving ? 'Saving…' : 'Save'}
                        </button>
                    </div>
                </div>
            </div>
        `;
    },

    _onBackdrop(event) { if (event.target === event.currentTarget) this.close(); },

    _toggleParticipant(id) {
        if (this._form.participants === null) {
            this._form.participants = (this._allFamilyMembers || []).map(m => m.id);
        }
        const idx = this._form.participants.indexOf(id);
        if (idx >= 0) this._form.participants.splice(idx, 1);
        else this._form.participants.push(id);
        App.renderPage();
    },

    _selectAll() {
        this._form.participants = (this._allFamilyMembers || []).map(m => m.id);
        App.renderPage();
    },

    _selectKids() {
        this._form.participants = (this._allFamilyMembers || [])
            .filter(m => m.relationship === 'child').map(m => m.id);
        App.renderPage();
    },

    _clear() {
        this._form.participants = [];
        App.renderPage();
    },

    async _save() {
        const f = this._form;
        if (!f) return;

        this._saving = true;
        App.renderPage();

        try {
            // Patch only the keys this modal owns via the canonical
            // serialized writer — the server merges them over the stored
            // blob, so nothing else can be clobbered (no refetch needed).
            const patch = {
                chores: {
                    enabled: f.choresEnabled,
                    anyoneEnabled: f.anyoneEnabled,
                    participants: f.participants,
                    upcomingDays: f.upcomingDays,
                },
                rewards: {
                    enabled: f.rewardsEnabled,
                },
            };
            await DashieAuth.patchUserSettings(patch);

            // Local view of the result for the onSaved callback (pages use
            // it to update their own _userSettings render state).
            const full = {
                ...(this._userSettings || {}),
                chores: { ...(this._userSettings?.chores || {}), ...patch.chores },
                rewards: { ...(this._userSettings?.rewards || {}), ...patch.rewards },
            };

            const cb = this._onSaved;
            this._open = false;
            this._form = null;
            this._onSaved = null;

            if (cb) cb(full);
        } catch (e) {
            console.error('[OptionsModal] Save failed:', e);
            Toast.error(Toast.friendly(e, 'save options'));
        } finally {
            this._saving = false;
            App.renderPage();
        }
    },

    _escape(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    },
};
