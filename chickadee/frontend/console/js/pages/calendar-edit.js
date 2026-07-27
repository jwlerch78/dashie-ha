/* ============================================================
   Calendar Edit Panel — Iteration 1A.2

   Renders an inline edit panel below a calendar row in the
   Calendar page (mirrors family.js's _renderEditPanel pattern).
   Reads state from CalendarPage._calendars / _members and
   writes through to existing edge ops on save.

   Sections (mirror dashboard's categorize-and-assign):
   - Display Name override
   - Color override (10-swatch palette)
   - Calendar Type (Assigned / Family / Informational)
   - Member Assignment (only when type === 'member')
   - Tags (input + chips with × remove)

   Edge ops used (all already wired):
   - set_calendar_display_name
   - set_calendar_color_override
   - set_calendar_assignment_type
   - set_calendar_tags
   - update_family_member  (for assigned_calendars)
   ============================================================ */

const CalendarEditPanel = {
    /** Mirror of dashboard's CALENDAR_COLOR_PALETTE (calendar-assignment-handler.js:15) */
    COLOR_PALETTE: [
        { color: '#4285F4', label: 'Blue' },
        { color: '#EA4335', label: 'Red' },
        { color: '#34A853', label: 'Green' },
        { color: '#FBBC05', label: 'Yellow' },
        { color: '#FF6D01', label: 'Orange' },
        { color: '#46BDC6', label: 'Teal' },
        { color: '#7B61FF', label: 'Purple' },
        { color: '#E91E63', label: 'Pink' },
        { color: '#795548', label: 'Brown' },
        { color: '#607D8B', label: 'Gray' },
    ],

    /** Pending tag input text (per-calendar so it survives renders). */
    _tagDrafts: {},

    /** While true, an async save is in flight — disable controls so we don't double-fire. */
    _busy: false,

    /**
     * @param {Object} cal     - resolved calendar from CalendarPage._calendars
     * @param {Array}  members - CalendarPage._members
     * @returns {string} HTML string
     */
    render(cal, members) {
        const sourceName = cal.summary_source || cal.calendar_id;
        const overrideName = cal.summary !== sourceName ? cal.summary : '';
        const currentColor = (cal.background_color || '').toUpperCase();
        const currentType = cal.assignment_type || 'family';
        const tags = Array.isArray(cal.tags) ? cal.tags : [];
        const tagDraft = this._tagDrafts[cal.prefixed_id] || '';
        const id = this._escape(cal.prefixed_id);

        return `
            <div class="calendar-edit-panel" style="background: var(--bg-card, #fff); border: 1px solid var(--border, #e5e7eb); border-radius: 8px; padding: 16px; margin: 8px 0 12px 32px;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="width: 12px; height: 12px; border-radius: 50%; background: ${this._escape(cal.background_color || '#9ca3af')}; flex-shrink: 0;"></span>
                        <span style="font-weight: 600;">${this._escape(cal.summary)}</span>
                    </div>
                    <button class="btn btn-ghost btn-sm" onclick="CalendarEditPanel.close()" aria-label="Close edit">✕</button>
                </div>

                <!-- Display Name -->
                <div class="form-group">
                    <label class="form-label">Calendar Name</label>
                    <input type="text"
                           class="form-input"
                           id="cal-edit-name-${id}"
                           value="${this._escape(overrideName)}"
                           placeholder="${this._escape(sourceName)}"
                           onblur="CalendarEditPanel.saveDisplayName('${id}', this.value)"
                           onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}">
                    ${overrideName ? `<div style="margin-top: 4px; font-size: 12px; color: var(--text-muted);">Source: ${this._escape(sourceName)}</div>` : ''}
                </div>

                <!-- Color -->
                <div class="form-group" style="margin-top: 12px;">
                    <label class="form-label">Color</label>
                    <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
                        ${this.COLOR_PALETTE.map(({ color, label }) => {
                            const sel = color.toUpperCase() === currentColor;
                            const ringStyle = sel
                                ? 'border: 2px solid #fff; outline: 2px solid var(--accent, #ff9500); outline-offset: 1px;'
                                : 'border: 2px solid transparent;';
                            return `<button class="calendar-color-swatch"
                                            title="${this._escape(label)}"
                                            onclick="CalendarEditPanel.saveColor('${id}', '${color}')"
                                            style="width: 28px; height: 28px; border-radius: 50%; background-color: ${color}; ${ringStyle} cursor: pointer; padding: 0;"
                                            aria-label="${this._escape(label)}"></button>`;
                        }).join('')}
                        ${cal.background_color_source && cal.background_color !== cal.background_color_source
                            ? `<button class="btn btn-ghost btn-sm"
                                       onclick="CalendarEditPanel.saveColor('${id}', null)"
                                       style="margin-left: 8px;">Reset to source</button>`
                            : ''}
                    </div>
                </div>

                <!-- Calendar Type -->
                <div class="form-group" style="margin-top: 16px;">
                    <label class="form-label">Calendar Type</label>
                    <div style="display: flex; flex-direction: column; gap: 6px;">
                        ${this._renderTypeOption(id, 'member',        '👤', 'Assigned',     'Contains events for specific family member(s)', currentType)}
                        ${this._renderTypeOption(id, 'family',        '👥', 'Family',       'Contains events for the entire family',           currentType)}
                        ${this._renderTypeOption(id, 'informational', 'ℹ️', 'Informational','Reference calendars (sports, weather) excluded from voice queries', currentType)}
                    </div>
                </div>

                ${currentType === 'member' ? this._renderMemberSelection(cal, members) : ''}

                <!-- Tags -->
                <div class="form-group" style="margin-top: 16px;">
                    <label class="form-label">Tags</label>
                    <div style="display: flex; flex-wrap: wrap; gap: 6px; min-height: 28px; margin-bottom: 8px;">
                        ${tags.length === 0
                            ? `<span style="color: var(--text-muted); font-size: 13px;">No tags added</span>`
                            : tags.map(t => `
                                <span class="calendar-tag-pill" style="display: inline-flex; align-items: center; gap: 4px; background: var(--bg-muted, #f3f4f6); color: var(--text-secondary); padding: 2px 4px 2px 10px; border-radius: 12px; font-size: 12px;">
                                    ${this._escape(t)}
                                    <button onclick="CalendarEditPanel.removeTag('${id}', '${this._escape(t)}')"
                                            style="background: none; border: none; cursor: pointer; padding: 0 4px; color: var(--text-muted); font-size: 14px; line-height: 1;"
                                            aria-label="Remove tag ${this._escape(t)}">×</button>
                                </span>
                            `).join('')}
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <input type="text"
                               class="form-input"
                               id="cal-edit-tag-${id}"
                               value="${this._escape(tagDraft)}"
                               placeholder="Add tag (e.g. soccer, music)"
                               oninput="CalendarEditPanel._tagDrafts['${id}'] = this.value"
                               onkeydown="if(event.key==='Enter'){event.preventDefault();CalendarEditPanel.addTag('${id}', this.value);}"
                               style="flex: 1;">
                        <button class="btn btn-secondary btn-sm" onclick="CalendarEditPanel.addTag('${id}', document.getElementById('cal-edit-tag-${id}').value)">Add</button>
                    </div>
                </div>
            </div>
        `;
    },

    _renderTypeOption(prefId, type, icon, label, desc, currentType) {
        const sel = type === currentType;
        const bg = sel ? 'var(--bg-muted, #f3f4f6)' : 'transparent';
        const checkmark = sel ? '✓' : '';
        return `
            <button onclick="CalendarEditPanel.saveType('${prefId}', '${type}')"
                    style="display: flex; align-items: center; gap: 12px; padding: 10px 12px;
                           background: ${bg}; border: 1px solid var(--border, #e5e7eb);
                           border-radius: 6px; cursor: pointer; text-align: left; width: 100%;">
                <span style="font-size: 20px; flex-shrink: 0;">${icon}</span>
                <div style="flex: 1;">
                    <div style="font-weight: 500; font-size: 14px;">${label}</div>
                    <div style="font-size: 12px; color: var(--text-muted); line-height: 1.3;">${desc}</div>
                </div>
                <span style="font-size: 16px; color: var(--accent, #ff9500); width: 16px;">${checkmark}</span>
            </button>
        `;
    },

    _renderMemberSelection(cal, members) {
        if (!Array.isArray(members) || members.length === 0) {
            return `
                <div style="margin-top: 12px; padding: 12px; background: var(--bg-muted, #f9fafb); border-radius: 6px; font-size: 13px; color: var(--text-muted);">
                    No family members yet. Add members in the Family page to assign this calendar.
                </div>
            `;
        }
        const id = this._escape(cal.prefixed_id);
        return `
            <div class="form-group" style="margin-top: 16px;">
                <label class="form-label">Assigned Members</label>
                <div style="display: flex; flex-wrap: wrap; gap: 12px;">
                    ${members.map(m => {
                        const isAssigned = Array.isArray(m.assigned_calendars) && m.assigned_calendars.includes(cal.prefixed_id);
                        const bg = m.assigned_color || '#9ca3af';
                        const initial = (m.full_name || '?').charAt(0).toUpperCase();
                        const name = this._escape(m.full_name || '');
                        // Selected = a shaded box with an accent border (+ ring + ✓ badge +
                        // accent bold name) so it's unmistakable which members are assigned.
                        const boxStyle = isAssigned
                            ? 'background: var(--bg-muted, #f3f4f6); border: 2px solid var(--accent, #ff9500);'
                            : 'background: transparent; border: 2px solid transparent;';
                        const ring = isAssigned ? 'box-shadow: 0 0 0 2px var(--accent, #ff9500);' : '';
                        return `
                            <button onclick="CalendarEditPanel.toggleMember('${id}', '${this._escape(m.id)}')"
                                    title="${name}"
                                    style="display: flex; flex-direction: column; align-items: center; gap: 6px;
                                           cursor: pointer; padding: 8px 10px; border-radius: 10px; ${boxStyle}
                                           transition: background 120ms ease, border-color 120ms ease;">
                                <div style="position: relative; width: 40px; height: 40px; border-radius: 50%; background: ${this._escape(bg)};
                                            display: flex; align-items: center; justify-content: center;
                                            color: white; font-weight: 600; font-size: 16px; ${ring}">
                                    ${initial}
                                    ${isAssigned ? '<span style="position: absolute; top: -4px; right: -4px; background: var(--accent, #ff9500); color: white; border-radius: 50%; width: 16px; height: 16px; font-size: 10px; line-height: 1; display: flex; align-items: center; justify-content: center; border: 2px solid var(--bg-card, #fff);">✓</span>' : ''}
                                </div>
                                <span style="font-size: 11px; font-weight: ${isAssigned ? '600' : '400'}; color: ${isAssigned ? 'var(--accent, #ff9500)' : 'var(--text-secondary)'}; max-width: 64px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${name}</span>
                            </button>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    },

    // ── Operations ──────────────────────────────────────────

    close() {
        CalendarPage._editingPrefixedId = null;
        App.renderPage();
    },

    async saveDisplayName(prefixedId, value) {
        const cal = this._findCal(prefixedId);
        if (!cal) return;
        const trimmed = (value || '').trim();
        const sourceName = cal.summary_source || '';
        // Empty or matches source → clear override; otherwise set
        const newOverride = (!trimmed || trimmed === sourceName) ? null : trimmed;
        const currentOverride = cal.summary !== sourceName ? cal.summary : null;
        if (newOverride === currentOverride) return;
        try {
            await DashieAuth.dbRequest('set_calendar_display_name', {
                calendar_id: prefixedId,
                display_name: newOverride,
            });
            cal.summary = newOverride || sourceName;
        } catch (e) {
            Toast.error(`Failed to save name: ${e.message}`);
        }
        App.renderPage();
    },

    async saveColor(prefixedId, color) {
        const cal = this._findCal(prefixedId);
        if (!cal) return;
        try {
            await DashieAuth.dbRequest('set_calendar_color_override', {
                calendar_id: prefixedId,
                color: color,  // null clears override
            });
            cal.background_color = color || cal.background_color_source;
        } catch (e) {
            Toast.error(`Failed to save color: ${e.message}`);
        }
        App.renderPage();
    },

    async saveType(prefixedId, type) {
        const cal = this._findCal(prefixedId);
        if (!cal) return;
        if (cal.assignment_type === type || (!cal.assignment_type && type === 'family')) return;
        try {
            await DashieAuth.dbRequest('set_calendar_assignment_type', {
                calendar_id: prefixedId,
                assignment_type: type,
            });
            cal.assignment_type = type;
        } catch (e) {
            Toast.error(`Failed to save calendar type: ${e.message}`);
        }
        App.renderPage();
    },

    async toggleMember(prefixedId, memberId) {
        const member = (CalendarPage._members || []).find(m => m.id === memberId);
        if (!member) return;
        const current = Array.isArray(member.assigned_calendars) ? [...member.assigned_calendars] : [];
        const idx = current.indexOf(prefixedId);
        if (idx >= 0) current.splice(idx, 1);
        else current.push(prefixedId);
        try {
            const result = await DashieAuth.dbRequest('update_family_member', {
                member_id: memberId,
                updates: { assigned_calendars: current },
            });
            const updated = result.member || result.data;
            if (updated) {
                Object.assign(member, updated);
            } else {
                member.assigned_calendars = current;
            }
        } catch (e) {
            Toast.error(`Failed to update assignment: ${e.message}`);
        }
        App.renderPage();
    },

    async addTag(prefixedId, value) {
        const cal = this._findCal(prefixedId);
        if (!cal) return;
        const trimmed = (value || '').trim();
        if (!trimmed) return;
        const current = Array.isArray(cal.tags) ? [...cal.tags] : [];
        if (current.includes(trimmed)) {
            this._tagDrafts[prefixedId] = '';
            App.renderPage();
            return;
        }
        current.push(trimmed);
        try {
            await DashieAuth.dbRequest('set_calendar_tags', {
                calendar_id: prefixedId,
                tags: current,
            });
            cal.tags = current;
            this._tagDrafts[prefixedId] = '';
        } catch (e) {
            Toast.error(`Failed to add tag: ${e.message}`);
        }
        App.renderPage();
    },

    async removeTag(prefixedId, tag) {
        const cal = this._findCal(prefixedId);
        if (!cal) return;
        const current = Array.isArray(cal.tags) ? cal.tags.filter(t => t !== tag) : [];
        try {
            await DashieAuth.dbRequest('set_calendar_tags', {
                calendar_id: prefixedId,
                tags: current,
            });
            cal.tags = current;
        } catch (e) {
            Toast.error(`Failed to remove tag: ${e.message}`);
        }
        App.renderPage();
    },

    // ── Helpers ─────────────────────────────────────────────

    _findCal(prefixedId) {
        return (CalendarPage._calendars || []).find(c => c.prefixed_id === prefixedId);
    },

    _escape(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
};
