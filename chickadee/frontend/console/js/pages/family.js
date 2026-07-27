/* ============================================================
   Family Page

   Each member is its own collapsible group (mirrors the calendar
   accounts pattern): chevron + avatar + name in the header, edit
   form inline when expanded. Multiple members can be expanded at
   once. Adding a member inserts a synthetic 'new' row at the top
   that's expanded with an empty form.
   ============================================================ */

const FamilyPage = {
    _members: null,
    _expandedIds: null,        // Set of member ids currently expanded; 'new' for the add-form row
    _savingId: null,           // member id currently saving, null otherwise
    _deletingId: null,         // member id currently deleting, null otherwise
    _loading: false,
    _error: null,

    // Household name (family.familyName) lives in the account-level
    // user_settings blob, NOT the family_members table — so it loads/saves
    // through a separate path from the member list below.
    _userSettings: null,       // full user_settings tree, lazy-loaded
    _householdLoading: false,
    _householdError: null,
    _householdSaving: false,
    _householdSaveTimer: null,

    // Per-member "timer & reminder alerts to their phone" toggle
    // (member_notification_preferences.notify_on_reminder). Only shown for
    // mobile-linked members; loaded lazily on expand, saved immediately on toggle.
    _reminderPrefs: {},        // memberId -> boolean (loaded value; undefined = not loaded)
    _reminderPrefLoading: {},  // memberId -> true while fetching
    _reminderPrefSaving: {},   // memberId -> true while saving

    // Preset palette from backend auto-assignment
    PALETTE: ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2', '#F8B739', '#52B788'],
    RELATIONSHIPS: ['parent', 'child', 'guest'],

    render() {
        // Household-name card always renders at the top, independent of the
        // member-list load so a slow/failed user_settings fetch doesn't hide it.
        if (!this._userSettings && !this._householdLoading && !this._householdError) {
            this._fetchUserSettings();
        }
        const household = this._renderHouseholdCard();

        if (!this._members && !this._loading && !this._error) {
            this._fetchMembers();
            return household + this._renderLoading();
        }
        if (this._loading && !this._members) return household + this._renderLoading();
        if (this._error && !this._members) return household + this._renderError();

        if (!this._expandedIds) this._expandedIds = new Set();
        return household + this._renderList();
    },

    topBarTitle() { return 'Family'; },
    topBarSubtitle() {
        if (!this._members) return '';
        const real = this._members.filter(m => m.id !== 'new').length;
        return `${real} member${real === 1 ? '' : 's'}`;
    },
    topBarActions() {
        return `<button class="btn btn-primary" onclick="FamilyPage.add()">+ Add Member</button>`;
    },

    // =========================================================

    async _fetchMembers() {
        this._loading = true;
        this._error = null;
        try {
            const result = await DashieAuth.dbRequest('list_family_members', {});
            this._members = result.members || result.data || [];
            this._members.sort((a, b) => {
                const oa = a.display_order ?? 999;
                const ob = b.display_order ?? 999;
                if (oa !== ob) return oa - ob;
                return (a.full_name || '').localeCompare(b.full_name || '');
            });
        } catch (e) {
            console.error('[FamilyPage] Fetch failed:', e);
            this._error = e.message;
        } finally {
            this._loading = false;
            App.renderPage();
        }
    },

    _renderLoading() {
        return `
            <div style="display: flex; align-items: center; justify-content: center; padding: 60px;">
                <div style="text-align: center;">
                    <div style="width: 32px; height: 32px; border: 3px solid #e5e7eb; border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 12px;"></div>
                    <div style="color: var(--text-secondary); font-size: var(--font-size-sm);">Loading family...</div>
                </div>
                <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
            </div>
        `;
    },

    _renderError() {
        return `
            <div class="card">
                <div class="card-body" style="color: var(--status-error);">
                    <strong>Failed to load family:</strong> ${this._escape(this._error)}
                    <div style="margin-top: 12px;">
                        <button class="btn btn-secondary btn-sm" onclick="FamilyPage._retry()">Retry</button>
                    </div>
                </div>
            </div>
        `;
    },

    _retry() {
        this._error = null;
        this._members = null;
        this._expandedIds = null;
        App.renderPage();
    },

    // =========================================================
    //  Household name (family.familyName → user_settings)
    //
    //  Account-level: the dashboard header renders it as
    //  "The <name> Family" (formatting lives in the header widget), so we
    //  store the raw base name here — the exact value the native Kotlin
    //  "Edit Family Name" dialog writes to settingsStore.family.familyName.
    // =========================================================

    async _fetchUserSettings() {
        this._householdLoading = true;
        this._householdError = null;
        try {
            this._userSettings = (await DashieAuth.loadUserSettings()) || {};
        } catch (e) {
            console.error('[FamilyPage] user_settings fetch failed:', e);
            this._householdError = e?.message || String(e);
        } finally {
            this._householdLoading = false;
            App.renderPage();
        }
    },

    _householdName() {
        return this._userSettings?.family?.familyName ?? '';
    },

    _renderHouseholdCard() {
        if (this._householdError) {
            return `
                <div class="card" style="margin-bottom: 16px;">
                    <div class="card-body" style="color: var(--status-error, #c00);">
                        Couldn't load household name: ${this._escape(this._householdError)}
                        <button class="btn btn-secondary btn-sm" style="margin-left: 12px;" onclick="FamilyPage._fetchUserSettings()">Retry</button>
                    </div>
                </div>`;
        }
        const loading = this._householdLoading && !this._userSettings;
        const name = this._householdName();
        // Preview mirrors the header widget's formatFamilyName(): strip a
        // leading "The " / trailing " Family" the user may have typed so we
        // don't render "The The Smith Family Family".
        const base = name.trim().replace(/^The\s+/i, '').replace(/\s+Family$/i, '');
        const preview = base ? `The ${this._escape(base)} Family` : `The ${BRAND.productName} Family`;
        return `
            <div class="card" style="margin-bottom: 16px;">
                <div class="card-body">
                    <div class="section-header" style="font-weight: 600; padding: 0 4px 8px;">Household Name</div>
                    <div class="setting-row">
                        <span class="setting-row-label">Family Name</span>
                        <input class="form-input" type="text"
                            value="${this._escape(name)}"
                            placeholder="e.g. Smith"
                            style="max-width: 240px;"
                            ${loading ? 'disabled' : ''}
                            onchange="FamilyPage._setHouseholdName(this.value)">
                    </div>
                    <div style="color: var(--text-muted); font-size: var(--font-size-sm); padding: 4px 4px 0;">
                        Shown on the dashboard as "${preview}".${this._householdSaving ? ' <span style="color: var(--text-secondary);">Saving…</span>' : ''}
                    </div>
                </div>
            </div>`;
    },

    _setHouseholdName(value) {
        if (!this._userSettings) this._userSettings = {};
        if (!this._userSettings.family) this._userSettings.family = {};
        this._userSettings.family.familyName = value.trim();
        App.renderPage();          // reflect the trimmed value + preview now
        if (this._householdSaveTimer) clearTimeout(this._householdSaveTimer);
        this._householdSaveTimer = setTimeout(() => this._saveHousehold(), 300);
    },

    async _saveHousehold() {
        this._householdSaveTimer = null;
        if (!this._userSettings || this._householdSaving) return;
        this._householdSaving = true;
        App.renderPage();
        try {
            // Patch only the familyName leaf via the canonical serialized
            // writer — the server merges it over the stored blob, so
            // temperatureUnit/zipCode/etc. can't be clobbered.
            await DashieAuth.patchUserSetting(
                'family.familyName', this._userSettings.family.familyName);
        } catch (e) {
            console.error('[FamilyPage] household save failed:', e);
            Toast?.error?.(`Save failed: ${e?.message || e}`);
        } finally {
            this._householdSaving = false;
            App.renderPage();
        }
    },

    _renderList() {
        const realMembers = this._members.filter(m => m.id !== 'new');
        if (realMembers.length === 0 && !this._expandedIds.has('new')) {
            return `
                <div class="empty-state">
                    <div class="empty-state-icon">👪</div>
                    <div class="empty-state-text">No family members yet.</div>
                    <div style="color: var(--text-muted); font-size: var(--font-size-sm); margin-top: 8px;">
                        Click "+ Add Member" to get started.
                    </div>
                </div>
            `;
        }

        // Synthetic 'new' member always renders first when present so the
        // user sees the empty form pop in at the top, not get lost mid-list.
        return this._members.map(m => this._renderMemberGroup(m)).join('');
    },

    _renderMemberGroup(member) {
        const expanded = this._expandedIds.has(member.id);
        const chevron = expanded ? '▾' : '▸';
        const isNew = member.id === 'new';
        const color = member.assigned_color || '#9ca3af';
        const initial = (member.full_name || '?').charAt(0).toUpperCase();
        const titleText = isNew
            ? '<span style="color: var(--text-muted); font-style: italic;">New family member</span>'
            : `${this._escape(member.full_name || '(unnamed)')}${member.nickname ? ` <span style="color: var(--text-muted); font-weight: 400;">(${this._escape(member.nickname)})</span>` : ''}`;
        const subtitleText = isNew
            ? 'Fill in the form below to add'
            : this._capitalize(member.relationship || 'member');
        const linkedBadge = !isNew && member.device_linked_at
            ? `<span class="list-item-badge" style="background: var(--bg-muted, #f3f4f6); color: var(--text-secondary);">Mobile linked</span>`
            : '';

        const body = expanded
            ? `<div class="member-form-body" style="border-top: 1px solid var(--border, #e5e7eb); padding: 16px 20px;">
                   ${this._renderMemberEditForm(member)}
               </div>`
            : '';

        return `
            <div class="account-group" style="border: 1px solid var(--border, #e5e7eb); border-radius: 8px; margin-bottom: 12px; overflow: hidden;">
                <div class="account-header"
                     onclick="FamilyPage.toggleMemberExpand('${this._escape(member.id)}')"
                     style="display: flex; align-items: center; gap: 12px; padding: 12px 16px; cursor: pointer; background: var(--bg-card, #fff);">
                    <span style="font-size: 38px; line-height: 1; color: var(--text-muted); width: 28px; text-align: center; flex-shrink: 0;">${chevron}</span>
                    <div style="width: 32px; height: 32px; border-radius: 50%; background: ${this._escape(color)}; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 600; color: white; flex-shrink: 0;">
                        ${isNew ? '+' : initial}
                    </div>
                    <div style="flex: 1; min-width: 0;">
                        <div class="list-item-title">${titleText}</div>
                        <div class="list-item-subtitle">${subtitleText}</div>
                    </div>
                    ${linkedBadge}
                </div>
                ${body}
            </div>
        `;
    },

    _renderMemberEditForm(member) {
        const id = this._escape(member.id);
        const isNew = member.id === 'new';
        const saving = this._savingId === member.id;
        const deleting = this._deletingId === member.id;

        // Colors taken by other members are greyed out + not clickable —
        // selected gets the bigger swatch, unselected the smaller (mirrors
        // the Kotlin picker).
        const otherUsed = new Set(
            this._members
                .filter(m => m.id !== member.id && m.assigned_color)
                .map(m => m.assigned_color.toLowerCase())
        );
        const colorDots = this.PALETTE.map(c => {
            const sel = c.toLowerCase() === (member.assigned_color || '').toLowerCase();
            const used = !sel && otherUsed.has(c.toLowerCase());
            const cls = `color-picker-dot${sel ? ' selected' : ''}${used ? ' used' : ''}`;
            const click = used ? '' : `onclick="FamilyPage._selectColor('${id}', '${c}')"`;
            return `<div class="${cls}"
                         style="background: ${c}"
                         data-color="${c}"
                         ${click}></div>`;
        }).join('');

        return `
            <div class="form-grid">
                <div class="form-group">
                    <label class="form-label">Name</label>
                    <input class="form-input" type="text" id="family-${id}-name"
                        value="${this._escape(member.full_name || '')}"
                        placeholder="Full name">
                </div>
                <div class="form-group">
                    <label class="form-label">Nickname</label>
                    <input class="form-input" type="text" id="family-${id}-nickname"
                        value="${this._escape(member.nickname || '')}"
                        placeholder="Optional">
                </div>
                <div class="form-group">
                    <label class="form-label">Role</label>
                    <select class="form-select" id="family-${id}-role">
                        ${this.RELATIONSHIPS.map(r => `
                            <option value="${r}" ${r === member.relationship ? 'selected' : ''}>
                                ${this._capitalize(r)}
                            </option>
                        `).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Color</label>
                    <div class="color-picker" id="family-${id}-color-picker">${colorDots}</div>
                </div>
            </div>

            <div class="form-group">
                <label class="form-label">Notes</label>
                <input class="form-input" type="text" id="family-${id}-notes"
                    value="${this._escape(member.notes || '')}"
                    placeholder="Optional notes">
            </div>

            ${!isNew && member.device_linked_at ? `
                <div class="card" style="margin-top: 12px;">
                    <div class="card-body" style="padding: 12px 16px; font-size: var(--font-size-sm);">
                        <span style="color: var(--status-online);">✓</span>
                        Device linked · ${this._escape(member.device_name || 'Unknown device')}
                    </div>
                </div>
            ` : ''}

            ${!isNew ? this._renderReminderAlertToggle(member) : ''}

            <div class="edit-panel-actions" style="margin-top: 16px;">
                <button class="btn btn-primary" onclick="FamilyPage._save('${id}')" ${saving ? 'disabled' : ''}>
                    ${saving ? 'Saving…' : (isNew ? 'Add Member' : 'Save Changes')}
                </button>
                <button class="btn btn-ghost" onclick="FamilyPage._cancel('${id}')" ${saving ? 'disabled' : ''}>
                    Cancel
                </button>
                ${!isNew ? `
                    <button class="btn btn-danger btn-sm" onclick="FamilyPage._delete('${id}')"
                        ${saving || deleting ? 'disabled' : ''}>
                        ${deleting ? 'Removing…' : 'Remove Member'}
                    </button>
                ` : ''}
            </div>
        `;
    },

    // Timer/reminder push toggle — shown for every saved member. The push only
    // reaches members who've installed & linked the Dashie mobile app; the hint
    // says so for members without a linked device. Immediate-apply.
    _renderReminderAlertToggle(member) {
        const id = this._escape(member.id);
        const loading = this._reminderPrefLoading[member.id];
        const saving = this._reminderPrefSaving[member.id];
        const linked = !!member.device_linked_at;
        const on = this._reminderPrefs[member.id] !== false; // default on until loaded
        const hint = loading
            ? 'Loading…'
            : (linked
                ? 'Send a notification to their phone when a timer or reminder goes off.'
                : `Notifies their phone when a timer or reminder goes off — once they’ve installed and linked the ${BRAND.productName} mobile app.`);
        return `
            <div class="form-group" style="margin-top: 12px;">
                <label class="toggle-row">
                    <span class="toggle-text">Timer &amp; reminder alerts</span>
                    <label class="toggle"><input type="checkbox" ${on ? 'checked' : ''} ${loading || saving ? 'disabled' : ''}
                        onchange="FamilyPage._toggleReminderAlerts('${id}', this.checked)">
                        <span class="toggle-slider"></span></label>
                </label>
                <div class="field-hint">${hint}</div>
            </div>
        `;
    },

    _selectColor(memberId, color) {
        const picker = document.getElementById(`family-${memberId}-color-picker`);
        if (!picker) return;
        picker.querySelectorAll('.color-picker-dot').forEach(dot => {
            dot.classList.toggle('selected', dot.dataset.color === color);
        });
    },

    _getEditValues(memberId) {
        const sel = document.querySelector(`#family-${memberId}-color-picker .color-picker-dot.selected`);
        return {
            full_name: document.getElementById(`family-${memberId}-name`).value.trim(),
            nickname: document.getElementById(`family-${memberId}-nickname`).value.trim(),
            relationship: document.getElementById(`family-${memberId}-role`).value,
            assigned_color: sel ? sel.dataset.color : this.PALETTE[0],
            notes: document.getElementById(`family-${memberId}-notes`).value.trim(),
        };
    },

    async _save(memberId) {
        const values = this._getEditValues(memberId);

        if (!values.full_name) {
            Toast.error('Please enter a name');
            return;
        }

        this._savingId = memberId;
        App.renderPage();

        try {
            if (memberId === 'new') {
                const result = await DashieAuth.dbRequest('create_family_member', values);
                const newMember = result.member || result.data;
                if (newMember) {
                    // Replace the synthetic 'new' member with the real one and
                    // collapse — keeps the user in their reading place rather
                    // than shoving an open form at them.
                    this._members = this._members.map(m => m.id === 'new' ? newMember : m);
                    this._expandedIds.delete('new');
                }
            } else {
                const result = await DashieAuth.dbRequest('update_family_member', {
                    member_id: memberId,
                    updates: values,
                });
                const updated = result.member || result.data;
                if (updated) {
                    const idx = this._members.findIndex(m => m.id === memberId);
                    if (idx >= 0) this._members[idx] = updated;
                }
                this._expandedIds.delete(memberId);
            }
        } catch (e) {
            console.error('[FamilyPage] Save failed:', e);
            Toast.error(Toast.friendly(e, 'save this member'));
        } finally {
            this._savingId = null;
            App.renderPage();
        }
    },

    async _delete(memberId) {
        const member = this._members.find(m => m.id === memberId);
        const name = member ? member.full_name : 'this member';
        const ok = await ConfirmModal.confirm({
            title: 'Remove family member',
            message: `Remove ${name} from your family?\n\nTheir calendar assignments and chore history will be deleted.`,
            confirmLabel: 'Remove',
            danger: true,
        });
        if (!ok) return;

        this._deletingId = memberId;
        App.renderPage();

        try {
            await DashieAuth.dbRequest('delete_family_member', {
                member_id: memberId,
                hard_delete: false,
            });
            this._members = this._members.filter(m => m.id !== memberId);
            this._expandedIds.delete(memberId);
        } catch (e) {
            console.error('[FamilyPage] Delete failed:', e);
            Toast.error(Toast.friendly(e, 'remove this member'));
        } finally {
            this._deletingId = null;
            App.renderPage();
        }
    },

    // ---- Per-member timer/reminder push toggle ----

    async _fetchReminderPref(memberId) {
        this._reminderPrefLoading[memberId] = true;
        try {
            const result = await DashieAuth.dbRequest('get_notification_preferences', {
                family_member_id: memberId,
            });
            const prefs = result.data || result;
            // Server default is on; only an explicit false turns it off.
            this._reminderPrefs[memberId] = prefs.notify_on_reminder !== false;
        } catch (e) {
            console.error('[FamilyPage] reminder pref load failed:', e);
            this._reminderPrefs[memberId] = true; // matches server default
        } finally {
            this._reminderPrefLoading[memberId] = false;
            App.renderPage();
        }
    },

    async _toggleReminderAlerts(memberId, checked) {
        const prev = this._reminderPrefs[memberId];
        this._reminderPrefs[memberId] = checked; // optimistic
        this._reminderPrefSaving[memberId] = true;
        App.renderPage();
        try {
            await DashieAuth.dbRequest('set_notification_preferences', {
                family_member_id: memberId,
                notify_on_reminder: checked,
            });
            Toast.success?.(checked ? 'Timer & reminder alerts on' : 'Timer & reminder alerts off');
        } catch (e) {
            console.error('[FamilyPage] reminder pref save failed:', e);
            this._reminderPrefs[memberId] = prev; // revert on failure
            Toast.error(Toast.friendly(e, 'update timer & reminder alerts'));
        } finally {
            this._reminderPrefSaving[memberId] = false;
            App.renderPage();
        }
    },

    /**
     * Cancel: collapse the row. For the synthetic 'new' member, also drop
     * it from the list so the empty form disappears entirely.
     */
    _cancel(memberId) {
        if (memberId === 'new') {
            this._members = this._members.filter(m => m.id !== 'new');
        }
        this._expandedIds.delete(memberId);
        App.renderPage();
    },

    /**
     * Toggle the expanded state of a member. Collapsing the synthetic 'new'
     * also removes it (same semantics as Cancel) so it doesn't linger.
     */
    toggleMemberExpand(memberId) {
        if (this._expandedIds.has(memberId)) {
            this._cancel(memberId);
            return;
        }
        this._expandedIds.add(memberId);
        // Lazy-load this member's reminder-alert pref (shown for every saved member).
        const member = (this._members || []).find(m => m.id === memberId);
        if (member && memberId !== 'new' &&
            this._reminderPrefs[memberId] === undefined &&
            !this._reminderPrefLoading[memberId]) {
            this._fetchReminderPref(memberId);
        }
        App.renderPage();
        // Focus the name field for new-member rows so the user can type
        // immediately. Existing rows skip this — clicking to expand for
        // review shouldn't grab focus.
        if (memberId === 'new') {
            setTimeout(() => {
                const el = document.getElementById('family-new-name');
                if (el) el.focus();
            }, 50);
        }
    },

    // D.37 — the first palette color not already assigned to a member, so a
    // new member doesn't default to a taken (greyed-out) color.
    _firstUnusedColor() {
        const used = new Set((this._members || [])
            .filter(m => m.id !== 'new')
            .map(m => (m.assigned_color || '').toLowerCase()));
        return this.PALETTE.find(c => !used.has(c.toLowerCase())) || this.PALETTE[0];
    },

    add() {
        // Prepend a synthetic 'new' member so it appears at the top and
        // expand it. Replaces the legacy `_editingId = 'new'` flow.
        if (this._members.some(m => m.id === 'new')) {
            // Already adding — just expand & focus
            this._expandedIds.add('new');
        } else {
            const synthetic = {
                id: 'new',
                full_name: '',
                nickname: '',
                relationship: 'child',
                assigned_color: this._firstUnusedColor(),
                notes: ''
            };
            this._members = [synthetic, ...this._members];
            this._expandedIds.add('new');
        }
        App.renderPage();
        setTimeout(() => {
            const el = document.getElementById('family-new-name');
            if (el) el.focus();
        }, 50);
    },

    // =========================================================

    _capitalize(s) {
        if (!s) return '';
        return s.charAt(0).toUpperCase() + s.slice(1);
    },

    _escape(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
};
