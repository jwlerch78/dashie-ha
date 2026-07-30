/* ============================================================
   Scheduled Actions Page

   Two collapsible sections — Active (scheduled) and Completed
   (fired, collapsed by default). Each row: a type icon on the
   left (bell = single reminder; a recurring badge by the title
   for recurring actions), the ALL-CAPS text, and a quick delete
   on the right. Expand a row to edit (text / fire time / type)
   and see its created/edited timestamp.

   Reminders are CREATED by voice on a device; this page manages
   them. Edit/delete broadcast `reminder-changed` so the owning
   device re-arms or cancels (see js/core/reminders/reminder-sync.js).
   ============================================================ */

const ScheduledActionsPage = {
    _actions: null,
    _expandedIds: null,
    _collapsed: null,          // { active: false, completed: true }
    _savingId: null,
    _deletingId: null,
    _clearing: false,          // "Clear all completed" in flight
    _loading: false,
    _error: null,
    _realtimeChannel: null,

    VERNACULARS: ['reminder', 'alarm'],

    render() {
        if (!this._actions && !this._loading && !this._error) {
            this._fetch();
            return this._renderLoading();
        }
        if (this._loading && !this._actions) return this._renderLoading();
        if (this._error && !this._actions) return this._renderError();
        this._initState();
        return this._renderList();
    },

    _initState() {
        if (!this._expandedIds) this._expandedIds = new Set();
        if (!this._collapsed) this._collapsed = { active: false, completed: true };
    },

    topBarTitle() { return 'Scheduled Actions'; },
    topBarSubtitle() {
        if (!this._actions) return '';
        const n = this._actions.filter(a => a.status === 'scheduled').length;
        return `${n} active`;
    },
    topBarActions() { return ''; },

    onNavigateTo() {
        this._fetch();
        this._ensureRealtimeSub();
    },

    // Title-bar refresh icon — app.js renders it left of the title for any page
    // that exposes a refresh() hook.
    refresh() { return this._fetch(); },

    // =========================================================

    async _fetch() {
        this._loading = true;
        this._error = null;
        try {
            const result = await DashieAuth.dbRequest('list_scheduled_actions', {});
            this._actions = (result.actions || result.data || []).slice();
            // Resolve device_id → friendly name so each action shows where it fires.
            // Best-effort: a failure just falls back to a generic device label.
            try {
                const dev = await DashieAuth.dbRequest('list_devices', { tv_only: false, include_inactive: true });
                const list = dev.devices || dev.data || [];
                this._deviceMap = {};
                list.forEach(d => { if (d.device_id) this._deviceMap[d.device_id] = d.device_name; });
            } catch (_) { /* device names optional */ }
        } catch (e) {
            console.error('[ScheduledActionsPage] Fetch failed:', e);
            this._error = e.message;
        } finally {
            this._loading = false;
            App.renderPage();
        }
    },

    async _ensureRealtimeSub() {
        if (this._realtimeChannel) return;
        try {
            this._realtimeChannel = await DashieAuth.subscribeToChannel(
                'scheduled-actions', 'reminder-changed',
                () => this._fetch()
            );
        } catch (e) {
            console.warn('[ScheduledActionsPage] realtime subscribe failed', e);
        }
    },

    _renderLoading() {
        return `
            <div style="display: flex; align-items: center; justify-content: center; padding: 60px;">
                <div style="text-align: center;">
                    <div style="width: 32px; height: 32px; border: 3px solid #e5e7eb; border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 12px;"></div>
                    <div style="color: var(--text-secondary); font-size: var(--font-size-sm);">Loading reminders...</div>
                </div>
                <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
            </div>
        `;
    },

    _renderError() {
        return `
            <div class="card">
                <div class="card-body" style="color: var(--status-error);">
                    <strong>Failed to load scheduled actions:</strong> ${this._escape(this._error)}
                    <div style="margin-top: 12px;">
                        <button class="btn btn-secondary btn-sm" onclick="ScheduledActionsPage._retry()">Retry</button>
                    </div>
                </div>
            </div>
        `;
    },

    _retry() {
        this._error = null;
        this._actions = null;
        App.renderPage();
    },

    _renderList() {
        const all = this._actions || [];
        if (all.length === 0) {
            return `
                <div class="empty-state">
                    <div class="empty-state-icon"><img src="assets/icons/icon-bell.svg" alt="" style="width:44px;height:44px;opacity:0.35;"></div>
                    <div class="empty-state-text">No scheduled actions.</div>
                    <div style="color: var(--text-muted); font-size: var(--font-size-sm); margin-top: 8px;">
                        Say "${BRAND.wakePhrase}, remind me…" on a device to create one.
                    </div>
                </div>
            `;
        }
        const byFireAt = (dir) => (a, b) => dir * ((new Date(a.fire_at).getTime() || 0) - (new Date(b.fire_at).getTime() || 0));
        // Active: soonest-to-fire first (next up on top). Completed: most-recently-fired first.
        const active = all.filter(a => a.status === 'scheduled').sort(byFireAt(1));
        const completed = all.filter(a => a.status === 'fired').sort(byFireAt(-1));
        return this._renderSection('active', 'Active', active, true)
             + this._renderSection('completed', 'Completed', completed, false);
    },

    _renderSection(key, label, items, editable) {
        const collapsed = this._collapsed[key];
        const chevron = collapsed ? '▸' : '▾';
        // Completed rows are history — a one-click "Clear all" beside the header removes them
        // all (each already has its own ✕). stopPropagation so it doesn't toggle the section.
        const clearBtn = (key === 'completed' && items.length && !this._clearing)
            ? `<button class="btn btn-ghost btn-sm" style="margin-left:auto;"
                       onclick="event.stopPropagation(); ScheduledActionsPage.clearCompleted()">Clear all</button>`
            : (key === 'completed' && this._clearing ? `<span style="margin-left:auto; font-size:var(--font-size-sm); color:var(--text-muted); text-transform:none;">Clearing…</span>` : '');
        const header = `
            <div onclick="ScheduledActionsPage.toggleSection('${key}')"
                 style="display:flex; align-items:center; gap:8px; cursor:pointer; padding:10px 4px; margin-top:8px;
                        font-size:var(--font-size-sm); font-weight:600; text-transform:uppercase; letter-spacing:0.04em; color:var(--text-secondary);">
                <span style="width:14px; text-align:center;">${chevron}</span>
                <span>${label} (${items.length})</span>
                ${clearBtn}
            </div>`;
        if (collapsed) return header;
        if (items.length === 0) {
            return header + `<div style="color:var(--text-muted); font-size:var(--font-size-sm); padding:2px 0 8px 26px;">None.</div>`;
        }
        return header + items.map(a => this._renderRow(a, editable)).join('');
    },

    _renderRow(action, editable) {
        const id = this._escape(action.id);
        const expanded = this._expandedIds.has(action.id);
        const chevron = expanded ? '▾' : '▸';
        const recurring = this._isRecurring(action);
        const isAiTurn = this._isAiTurn(action);
        const isHaCommand = this._isHaCommand(action);
        // Device actions (AI turns AND scheduled HA commands) carry the command in
        // `prompt` (notify_text is empty for them) — before this, ha_command rows
        // rendered as "(NO TEXT)" bell reminders.
        const titleText = this._isDeviceAction(action) ? action.prompt : action.notify_text;
        const title = titleText
            ? this._escape(titleText.toUpperCase())
            : '<span style="color:var(--text-muted); font-style:italic;">(NO TEXT)</span>';
        const deviceName = this._deviceName(action);
        const deviceSuffix = deviceName
            ? ` · <span title="Fires on this device"><img src="assets/icons/icon-tv.svg" alt="" style="width:12px;height:12px;vertical-align:-1px;opacity:0.7;"> ${this._escape(deviceName)}</span>`
            : '';
        const recurBadge = recurring
            ? `<img src="assets/icons/icon-reload.svg" alt="Recurring" title="Recurring" style="width:14px;height:14px;margin-left:8px;vertical-align:middle;opacity:0.7;">`
            : '';
        const deleting = this._deletingId === action.id;

        const header = `
            <div style="display:flex; align-items:center; gap:10px; padding:12px 14px; background:var(--bg-card,#fff);">
                <span onclick="ScheduledActionsPage.toggleExpand('${id}')" style="cursor:pointer; font-size:20px; color:var(--text-muted); width:16px; text-align:center; flex-shrink:0;">${chevron}</span>
                <img src="assets/icons/${isHaCommand ? 'icon-home' : isAiTurn ? 'icon-ai-chat' : 'icon-bell'}.svg"
                     alt="" title="${isHaCommand ? 'Home Assistant command' : isAiTurn ? 'AI action' : 'Reminder'}"
                     style="width:20px;height:20px;flex-shrink:0;opacity:0.8;">
                <div onclick="ScheduledActionsPage.toggleExpand('${id}')" style="flex:1; min-width:0; cursor:pointer;">
                    <div class="list-item-title">${title}${recurBadge}</div>
                    <div class="list-item-subtitle">${this._typeLabel(action)} · ${this._fmtWhen(action.fire_at)}${deviceSuffix}</div>
                </div>
                <button class="btn btn-danger btn-sm" onclick="ScheduledActionsPage._delete('${id}')" ${deleting ? 'disabled' : ''}
                        title="Delete" style="flex-shrink:0; min-width:34px;">${deleting ? '…' : '✕'}</button>
            </div>`;

        const body = expanded
            ? `<div style="border-top:1px solid var(--border,#e5e7eb); padding:16px 20px;">${this._renderDetail(action, editable)}</div>`
            : '';

        return `
            <div class="account-group" style="border:1px solid var(--border,#e5e7eb); border-radius:8px; margin-bottom:10px; overflow:hidden; ${editable ? '' : 'opacity:0.75;'}">
                ${header}${body}
            </div>`;
    },

    _renderDetail(action, editable) {
        const id = this._escape(action.id);
        const ts = `<div style="color:var(--text-muted); font-size:var(--font-size-sm); margin-top:${editable ? '10px' : '0'};">${this._timestampLabel(action)}</div>`;

        // AI turns (schedule_action) are created + owned on the device and aren't
        // console-editable yet — show a read-only summary of the command, schedule,
        // and firing device instead of the reminder-text form.
        if (this._isDeviceAction(action)) {
            const rows = [
                ['Command', this._escape(action.prompt || '—')],
                ['Type', this._isHaCommand(action) ? 'Home Assistant command (runs on the device at the set time)' : 'Action (runs on the device at the set time)'],
                ['Repeats', action.recurrence === 'daily' ? 'Every day' : 'Once'],
                ['Fires at', this._fmtWhen(action.fire_at)],
                ['Device', this._escape(this._deviceName(action) || 'this device')],
            ].map(([k, v]) => `
                <div class="form-group">
                    <label class="form-label">${k}</label>
                    <div class="form-input" style="background:var(--bg-muted,#f6f7f9);">${v}</div>
                </div>`).join('');
            return `<div class="form-grid">${rows}</div>${ts}`;
        }

        if (!editable) return ts; // Completed: read-only, just the timestamp.

        const saving = this._savingId === action.id;
        return `
            <div class="form-grid">
                <div class="form-group">
                    <label class="form-label">Reminder text</label>
                    <input class="form-input" type="text" id="sa-${id}-text" value="${this._escape(action.notify_text || '')}" placeholder="What to remind you">
                </div>
                <div class="form-group">
                    <label class="form-label">Fires at</label>
                    <input class="form-input" type="datetime-local" id="sa-${id}-time" value="${this._toLocalInput(action.fire_at)}">
                </div>
                <div class="form-group">
                    <label class="form-label">Type</label>
                    <select class="form-select" id="sa-${id}-vern">
                        ${this.VERNACULARS.map(v => `<option value="${v}" ${v === (action.vernacular || 'reminder') ? 'selected' : ''}>${this._capitalize(v)}</option>`).join('')}
                    </select>
                </div>
            </div>
            ${ts}
            <div class="edit-panel-actions" style="margin-top:14px;">
                <button class="btn btn-primary" onclick="ScheduledActionsPage._save('${id}')" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save Changes'}</button>
                <button class="btn btn-ghost" onclick="ScheduledActionsPage.toggleExpand('${id}')" ${saving ? 'disabled' : ''}>Cancel</button>
            </div>`;
    },

    toggleSection(key) {
        this._initState();
        this._collapsed[key] = !this._collapsed[key];
        App.renderPage();
    },

    toggleExpand(id) {
        this._initState();
        if (this._expandedIds.has(id)) this._expandedIds.delete(id);
        else this._expandedIds.add(id);
        App.renderPage();
    },

    async _save(id) {
        const text = document.getElementById(`sa-${id}-text`).value.trim();
        const localDt = document.getElementById(`sa-${id}-time`).value;
        const vernacular = document.getElementById(`sa-${id}-vern`).value;
        const fireAt = this._fromLocalInput(localDt);
        if (!fireAt) { Toast.error('Please pick a valid date and time'); return; }

        this._savingId = id;
        App.renderPage();
        try {
            const result = await DashieAuth.dbRequest('update_scheduled_action', {
                id, notify_text: text, fire_at: fireAt, vernacular,
            });
            const updated = result.action || result.data;
            if (!updated) {
                Toast.error('That reminder can no longer be edited (it already fired or was cancelled).');
                await this._fetch();
                return;
            }
            const idx = this._actions.findIndex(a => a.id === id);
            if (idx >= 0) this._actions[idx] = updated;
            this._expandedIds.delete(id);
            DashieAuth.broadcast('scheduled-actions', 'reminder-changed', { action: 'updated', row: updated })
                .catch(e => console.warn('[ScheduledActionsPage] broadcast failed', e));
        } catch (e) {
            console.error('[ScheduledActionsPage] Save failed:', e);
            Toast.error(Toast.friendly(e, 'update this reminder'));
        } finally {
            this._savingId = null;
            App.renderPage();
        }
    },

    async _delete(id) {
        const action = (this._actions || []).find(a => a.id === id);
        const label = action && action.notify_text ? `"${action.notify_text}"` : 'this reminder';
        const ok = await ConfirmModal.confirm({
            title: 'Delete reminder',
            message: `Delete ${label}?\n\nIt will be cancelled on the device.`,
            confirmLabel: 'Delete',
            danger: true,
        });
        if (!ok) return;

        this._deletingId = id;
        App.renderPage();
        try {
            const result = await DashieAuth.dbRequest('cancel_scheduled_action', { id });
            const cancelled = result.action || result.data;
            this._actions = this._actions.filter(a => a.id !== id);
            this._expandedIds.delete(id);
            DashieAuth.broadcast('scheduled-actions', 'reminder-changed', {
                action: 'cancelled',
                row: cancelled || (action ? { ...action, status: 'cancelled' } : null),
            }).catch(e => console.warn('[ScheduledActionsPage] broadcast failed', e));
        } catch (e) {
            console.error('[ScheduledActionsPage] Delete failed:', e);
            Toast.error(Toast.friendly(e, 'delete this reminder'));
        } finally {
            this._deletingId = null;
            App.renderPage();
        }
    },

    /** Remove all completed (fired) actions from the list. Each is cancelled the same way the
     *  per-row ✕ does; best-effort per item, then one refetch. */
    async clearCompleted() {
        if (this._clearing) return;
        const completed = (this._actions || []).filter(a => a.status === 'fired');
        if (!completed.length) return;
        const ok = await ConfirmModal.confirm({
            title: 'Clear completed actions',
            message: `Remove all ${completed.length} completed action${completed.length === 1 ? '' : 's'} from the list?\n\nThis only clears the history — active actions are untouched.`,
            confirmLabel: 'Clear all',
            danger: true,
        });
        if (!ok) return;
        this._clearing = true;
        App.renderPage();
        try {
            for (const a of completed) {
                try {
                    await DashieAuth.dbRequest('cancel_scheduled_action', { id: a.id });
                    this._actions = this._actions.filter(x => x.id !== a.id);
                } catch (e) {
                    console.warn('[ScheduledActionsPage] clear failed for', a.id, e);
                }
            }
        } finally {
            this._clearing = false;
            App.renderPage();
            // Reconcile with the server (and pick up anything the realtime channel missed).
            this._fetch();
        }
    },

    // =========================================================

    // Phase 1 actions are one-shot. When recurring lands, detect it here
    // (e.g. action.trigger_type === 'every'); for now everything is single.
    _isRecurring(action) {
        return !!action.recurrence || action.trigger_type === 'every' || action.recurring === true;
    },

    _isAiTurn(action) {
        return action.action_type === 'ai_turn';
    },

    _isHaCommand(action) {
        return action.action_type === 'ha_command';
    },

    // Device-owned actions (schedule_action tool) carry their text in `prompt`,
    // not notify_text — both AI turns and scheduled HA commands.
    _isDeviceAction(action) {
        return this._isAiTurn(action) || this._isHaCommand(action);
    },

    // Human label for the action kind: AI turns are "Action", scheduled HA commands
    // "HA Action"; classic ones keep their vernacular (Reminder/Alarm).
    _typeLabel(action) {
        if (this._isHaCommand(action)) return 'HA Action';
        return this._isAiTurn(action) ? 'Action' : this._capitalize(action.vernacular || 'reminder');
    },

    _deviceName(action) {
        const name = this._deviceMap && action.device_id ? this._deviceMap[action.device_id] : null;
        return name || (action.device_id ? 'this device' : null);
    },

    _timestampLabel(action) {
        const created = action.created_at ? new Date(action.created_at) : null;
        const updated = action.updated_at ? new Date(action.updated_at) : null;
        if (created && updated && (updated.getTime() - created.getTime()) > 5000) {
            return `Edited ${this._fmtTimestamp(updated)}`;
        }
        return created ? `Created ${this._fmtTimestamp(created)}` : '';
    },

    _fmtTimestamp(d) {
        if (!d || isNaN(d.getTime())) return '';
        return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    },

    _fmtWhen(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return this._escape(iso);
        return d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    },

    _toLocalInput(iso) {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },

    _fromLocalInput(val) {
        if (!val) return null;
        const d = new Date(val);
        return isNaN(d.getTime()) ? null : d.toISOString();
    },

    _capitalize(s) {
        if (!s) return '';
        return s.charAt(0).toUpperCase() + s.slice(1);
    },

    _escape(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
};
