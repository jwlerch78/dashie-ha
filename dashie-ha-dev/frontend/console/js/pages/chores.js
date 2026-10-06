/* ============================================================
   Chores Page — Assignments view + List/management view
   Mirrors mobile app UX and data model
   ============================================================ */

const ChoresPage = {
    _chores: null,
    _familyMembers: null,
    _allFamilyMembers: null,      // unfiltered, for completion lookups
    _userSettings: null,          // full user_settings object from Supabase
    _completionsByMember: {},
    _pointsByMember: {},
    _loading: false,
    _error: null,
    _view: 'assignments',         // 'assignments' or 'list'
    _currentDate: null,           // selected date (null = today)
    _showCompleted: false,
    _expandedMembers: new Set(),  // member IDs whose row is expanded
    _anyoneExpanded: false,
    _editingId: null,             // chore being edited or 'new'
    _form: null,
    _saving: false,
    _deleting: false,
    _togglingCompletion: new Set(),
    _optionsOpen: false,          // options modal
    _optionsForm: null,           // working copy of chore/reward settings
    _optionsSaving: false,
    _realtimeChannel: null,       // inbound subscription for chore-changed

    WEEKDAYS: [
        { value: 'sun', idx: 0, label: 'Su', full: 'Sun' },
        { value: 'mon', idx: 1, label: 'Mo', full: 'Mon' },
        { value: 'tue', idx: 2, label: 'Tu', full: 'Tue' },
        { value: 'wed', idx: 3, label: 'We', full: 'Wed' },
        { value: 'thu', idx: 4, label: 'Th', full: 'Thu' },
        { value: 'fri', idx: 5, label: 'Fr', full: 'Fri' },
        { value: 'sat', idx: 6, label: 'Sa', full: 'Sat' },
    ],

    render() {
        if (!this._chores && !this._loading && !this._error) {
            this._fetchData();
            return this._renderLoading();
        }
        if (this._loading && !this._chores) return this._renderLoading();
        if (this._error && !this._chores) return this._renderError();

        let html = this._view === 'list' ? this._renderListView() : this._renderAssignmentsView();
        if (this._editingId) html += this._renderModal();
        html += OptionsModal.render();
        html += EmojiPicker.render();
        return html;
    },

    /** Called when navigating to this page (or on initial load) */
    onNavigateTo() {
        // Ensure realtime subscription is active
        this._ensureRealtimeSub();
    },

    async _ensureRealtimeSub() {
        if (this._realtimeChannel) return;
        try {
            this._realtimeChannel = await DashieAuth.subscribeToChannel('chore-completions', 'chore-changed', (payload) => {
                this._onRemoteChoreChanged(payload);
            });
        } catch (e) {
            console.warn('[ChoresPage] Realtime subscribe failed:', e);
        }
    },

    _onRemoteChoreChanged(payload) {
        // Refresh data when another client (tablet) changes a chore
        // Debounce slightly in case of rapid-fire events
        clearTimeout(this._refreshDebounce);
        this._refreshDebounce = setTimeout(() => this._fetchData(), 300);
    },

    topBarTitle() {
        if (!this._chores) return 'Chores';
        const totals = this._computeFamilyTotal();
        return `Chores  ·  <span style="color: var(--status-online); font-weight: 700;">✓</span> ${totals.completed} / ${totals.total}`;
    },

    topBarSubtitle() { return ''; },

    topBarActions() {
        const editActive = this._view === 'list';
        return `
            <button class="btn btn-primary" onclick="ChoresPage.add()">+ Add Chore</button>
            <button class="btn ${editActive ? 'btn-primary' : 'btn-secondary'}" onclick="ChoresPage._toggleView()">
                <img src="assets/icons/icon-edit.svg" style="width: 14px; height: 14px; margin-right: 4px; ${editActive ? 'filter: brightness(0) invert(1);' : ''}"
                    onerror="this.style.display='none'">
                ${editActive ? 'Done' : 'Edit'}
            </button>
            <button class="btn btn-secondary" onclick="ChoresPage.openOptions()">
                <img src="assets/icons/icon-settings.svg" style="width: 14px; height: 14px; margin-right: 4px; opacity: 0.6;">
                Options
            </button>
        `;
    },

    _toggleView() {
        this._view = this._view === 'list' ? 'assignments' : 'list';
        App.renderPage();
    },

    // =========================================================
    //  Data loading
    // =========================================================

    async refresh() { await this._fetchData(); },

    async _fetchData() {
        this._loading = true;
        this._error = null;
        try {
            const [familyResult, settingsResult] = await Promise.all([
                DashieAuth.dbRequest('list_family_members', {}),
                DashieAuth.loadUserSettings().catch(() => ({})),
            ]);
            this._allFamilyMembers = familyResult.members || familyResult.data || [];
            this._userSettings = settingsResult || {};

            // Participants = authoritative source is user_settings.chores.participants
            // null/undefined/[] all mean "all family members" — only filter when a specific
            // non-empty list is provided.
            const participants = this._userSettings?.chores?.participants;
            this._familyMembers = (Array.isArray(participants) && participants.length > 0)
                ? this._allFamilyMembers.filter(m => participants.includes(m.id))
                : this._allFamilyMembers;

            // Fetch chore data for ALL members (completions may reference any)
            const allMemberIds = this._allFamilyMembers.map(m => m.id);
            const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
            const choresResult = await DashieAuth.dbRequest('get_chore_dashboard_data', {
                member_ids: allMemberIds,
                since,
            });
            this._chores = choresResult.chores || choresResult.data || [];
            this._completionsByMember = choresResult.completions_by_member || {};
            this._pointsByMember = choresResult.points_by_member || {};

            this._ensureRealtimeSub();
        } catch (e) {
            console.error('[ChoresPage] Fetch failed:', e);
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
                    <div style="color: var(--text-secondary); font-size: var(--font-size-sm);">Loading chores...</div>
                </div>
                <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
            </div>
        `;
    },

    _renderError() {
        return `
            <div class="card">
                <div class="card-body" style="color: var(--status-error);">
                    <strong>Failed to load chores:</strong> ${this._escape(this._error)}
                    <div style="margin-top: 12px;">
                        <button class="btn btn-secondary btn-sm" onclick="ChoresPage._retry()">Retry</button>
                    </div>
                </div>
            </div>
        `;
    },

    _retry() { this._error = null; this._chores = null; App.renderPage(); },

    // =========================================================
    //  Chore filtering helpers (match mobile chore-utils)
    // =========================================================

    _isAnyoneChore(c) {
        return c.assignment_type === 'anyone';
    },

    /** Is this chore scheduled for this date? (weekly or custom interval or one-time) */
    _isActiveForDate(chore, date) {
        if (!chore.repeats) {
            // One-time — active only on its due_date
            if (!chore.due_date) return true;
            return this._sameIsoDay(chore.due_date, date);
        }
        const repeatDays = chore.repeat_days || chore.repeatDays || [];
        if (repeatDays.length > 0) {
            // Weekly with specific days
            const dayIdx = date.getDay();
            const dayName = this.WEEKDAYS[dayIdx].value;
            return repeatDays.includes(dayName);
        }
        // Custom interval — show for now; real logic would need start date + interval math
        return true;
    },

    _choresForDate(date) {
        return (this._chores || []).filter(c => this._isActiveForDate(c, date));
    },

    _anyoneChoresForDate(date) {
        return this._choresForDate(date).filter(c => this._isAnyoneChore(c));
    },

    _memberChoresForDate(memberId, date) {
        return this._choresForDate(date).filter(c =>
            !this._isAnyoneChore(c) &&
            (c.assigned_member_ids || []).includes(memberId)
        );
    },

    _completionsForDate(memberId, date) {
        const all = this._completionsByMember[memberId] || [];
        return all.filter(co => this._sameDate(new Date(co.completed_at), date));
    },

    _isChoreCompletedBy(choreId, memberId, date) {
        return this._completionsForDate(memberId, date).some(co => co.chore_id === choreId);
    },

    _isAnyoneChoreCompleted(choreId, date) {
        for (const memberId of Object.keys(this._completionsByMember)) {
            if (this._isChoreCompletedBy(choreId, memberId, date)) return true;
        }
        return false;
    },

    _whoCompletedAnyone(choreId, date) {
        for (const memberId of Object.keys(this._completionsByMember)) {
            if (this._isChoreCompletedBy(choreId, memberId, date)) return memberId;
        }
        return null;
    },

    _computeFamilyTotal() {
        if (!this._chores) return { completed: 0, total: 0 };
        const date = this._currentDate || new Date();
        const members = this._familyMembers || [];
        const anyoneEnabled = this._userSettings?.chores?.anyoneEnabled !== false;
        const anyoneChores = anyoneEnabled ? this._anyoneChoresForDate(date) : [];

        // Total = (anyone chores) + sum(member-assigned chores for each enabled member)
        let total = anyoneChores.length;
        let completed = 0;

        // Completed anyone chores (count each once even if multiple members could complete)
        for (const c of anyoneChores) {
            if (this._isAnyoneChoreCompleted(c.id, date)) completed++;
        }

        for (const m of members) {
            const memberChores = this._memberChoresForDate(m.id, date);
            total += memberChores.length;
            for (const c of memberChores) {
                if (this._isChoreCompletedBy(c.id, m.id, date)) completed++;
            }
        }

        return { completed, total };
    },

    // =========================================================
    //  Assignments view
    // =========================================================

    _renderAssignmentsView() {
        if (!this._chores) return '';

        const date = this._currentDate || new Date();
        const isToday = this._sameDate(date, new Date());
        const dateLabel = isToday
            ? 'Today'
            : date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

        const anyoneEnabled = this._userSettings?.chores?.anyoneEnabled !== false;
        const anyoneChores = anyoneEnabled ? this._anyoneChoresForDate(date) : [];
        const memberStats = (this._familyMembers || []).map(m => {
            const memberChores = this._memberChoresForDate(m.id, date);
            const completedOnDate = this._completionsForDate(m.id, date).length;
            const points = this._pointsByMember[m.id] || 0;
            return { member: m, chores: memberChores, completedOnDate, points };
        });

        return `
            <div class="chores-date-nav">
                <button class="nav-btn" onclick="ChoresPage._navDate(-1)" title="Previous day">&lt;</button>
                <div class="chores-date-label">${this._escape(dateLabel)}</div>
                <button class="nav-btn" onclick="ChoresPage._navDate(1)" title="Next day">&gt;</button>
                ${!isToday ? `<button class="btn btn-ghost btn-sm" style="margin-left: 6px;" onclick="ChoresPage._navToday()">Today</button>` : ''}
                <label class="toggle-row" style="margin-left: auto; gap: 10px;">
                    <span class="toggle-text">Show Completed</span>
                    <label class="toggle">
                        <input type="checkbox" ${this._showCompleted ? 'checked' : ''}
                            onchange="ChoresPage._showCompleted = this.checked; App.renderPage()">
                        <span class="toggle-slider"></span>
                    </label>
                </label>
            </div>

            ${anyoneChores.length > 0 ? this._renderAnyoneSection(anyoneChores, date) : ''}
            ${memberStats.map(s => this._renderMemberSection(s, date)).join('')}

            ${memberStats.length === 0 && anyoneChores.length === 0 ? `
                <div class="empty-state">
                    <div class="empty-state-icon">✓</div>
                    <div class="empty-state-text">No chores for this day.</div>
                </div>
            ` : ''}
        `;
    },

    _renderAnyoneSection(chores, date) {
        const completedCount = chores.filter(c => this._isAnyoneChoreCompleted(c.id, date)).length;
        const total = chores.length;
        const isExpanded = this._anyoneExpanded;

        return `
            <div class="assignment-section anyone-section ${isExpanded ? 'expanded' : ''}">
                <div class="assignment-row anyone-row" onclick="ChoresPage._toggleAnyoneExpand()">
                    <div class="assignment-avatar anyone-avatar-bg">
                        <span style="font-size: 22px;">👪</span>
                    </div>
                    <div class="assignment-info">
                        <div class="assignment-name">Anyone</div>
                    </div>
                    <div class="assignment-stats">
                        <div class="stat-pill">
                            <span class="check-green">✓</span> ${completedCount} / ${total}
                        </div>
                    </div>
                    <div class="expand-chevron">${isExpanded ? '▾' : '▸'}</div>
                </div>
                ${isExpanded ? `
                    <div class="assignment-chores">
                        ${chores.map(c => this._renderChoreItem(c, date, null)).join('')}
                    </div>
                ` : ''}
            </div>
        `;
    },

    _renderMemberSection(stats, date) {
        const m = stats.member;
        const initial = (m.full_name || m.nickname || '?')[0].toUpperCase();
        const color = m.assigned_color || '#9ca3af';
        const name = m.nickname || (m.full_name || '').split(' ')[0] || 'Unknown';
        const completedFromAssigned = stats.chores.filter(c => this._isChoreCompletedBy(c.id, m.id, date)).length;
        const isExpanded = this._expandedMembers.has(m.id);

        return `
            <div class="assignment-section ${isExpanded ? 'expanded' : ''}">
                <div class="assignment-row" onclick="ChoresPage._toggleMemberExpand('${m.id}')">
                    <div class="assignment-avatar" style="background: ${color};">${this._escape(initial)}</div>
                    <div class="assignment-info">
                        <div class="assignment-name">${this._escape(name)}</div>
                    </div>
                    <div class="assignment-stats">
                        <div class="stat-pill">
                            <span class="check-green">✓</span> ${completedFromAssigned} / ${stats.chores.length}
                        </div>
                        <div class="stat-pill stat-pill-points">
                            <span style="color: var(--accent);">★</span> ${stats.points}
                        </div>
                    </div>
                    <div class="expand-chevron">${isExpanded ? '▾' : '▸'}</div>
                </div>
                ${isExpanded ? `
                    <div class="assignment-chores">
                        ${stats.chores.length > 0
                            ? stats.chores.map(c => this._renderChoreItem(c, date, m.id)).join('')
                            : '<div class="assignment-empty">No chores assigned for this day.</div>'}
                    </div>
                ` : ''}
            </div>
        `;
    },

    /**
     * Render a single chore item inside an expanded member section.
     * memberId = null means this is an anyone-chore context (use the "who completed" logic).
     */
    _renderChoreItem(chore, date, memberId) {
        const isAnyone = memberId === null;
        const completed = isAnyone
            ? this._isAnyoneChoreCompleted(chore.id, date)
            : this._isChoreCompletedBy(chore.id, memberId, date);

        if (completed && !this._showCompleted) return '';

        const color = !isAnyone
            ? ((this._allFamilyMembers || []).find(m => m.id === memberId)?.assigned_color || '#9ca3af')
            : '#4A90D9';

        const toggling = this._togglingCompletion.has(chore.id + (memberId || ''));
        const checkboxClass = completed ? 'chore-check checked' : 'chore-check';

        // Show who completed it for anyone chores
        let completedByBadge = '';
        if (isAnyone && completed) {
            const whoId = this._whoCompletedAnyone(chore.id, date);
            const who = (this._allFamilyMembers || []).find(m => m.id === whoId);
            if (who) {
                const whoColor = who.assigned_color || '#9ca3af';
                const whoInitial = (who.full_name || who.nickname || '?')[0].toUpperCase();
                completedByBadge = `
                    <div class="completed-by-badge" title="${this._escape(who.full_name || who.nickname)}"
                        style="background: ${whoColor};">${this._escape(whoInitial)}</div>
                `;
            }
        }

        return `
            <div class="chore-item ${completed ? 'completed' : ''}">
                <div class="chore-item-emoji">${chore.emoji || '✓'}</div>
                <div class="chore-item-body">
                    <div class="chore-item-title">${this._escape(chore.title)}</div>
                    <div class="chore-item-meta">
                        ${chore.points ?? 0} pts
                        ${chore.repeats ? `<span class="chore-recurring" title="Recurring">
                            <img src="assets/icons/icon-reload.svg" style="width: 12px; height: 12px; vertical-align: middle; opacity: 0.6;">
                        </span>` : ''}
                    </div>
                </div>
                ${completedByBadge}
                <button class="${checkboxClass}" style="--check-color: ${color};"
                    onclick="ChoresPage._toggleCompletion('${chore.id}', ${memberId ? `'${memberId}'` : 'null'})"
                    ${toggling ? 'disabled' : ''}>
                    ${completed ? '✓' : ''}
                </button>
            </div>
        `;
    },

    async _toggleCompletion(choreId, memberId) {
        const date = this._currentDate || new Date();

        // D.39 — distinguish an "anyone" click (chore rendered under the
        // shared Anyone section, memberId === null) from a per-member click.
        // The original code OR'd in _isAnyoneChoreCompleted unconditionally,
        // so clicking member B's tile for a multi-assigned chore where A had
        // already completed it took the uncomplete path and credited A's
        // record — completing/uncompleting toggled the wrong person.
        const isAnyoneClick = (memberId === null || memberId === 'null');

        if (isAnyoneClick) {
            const firstEnabled = (this._familyMembers || [])[0];
            if (!firstEnabled) {
                Toast.error('No enabled family members to credit this completion to.');
                return;
            }
            memberId = firstEnabled.id;
        }

        const key = choreId + memberId;
        if (this._togglingCompletion.has(key)) return;

        const wasCompleted = isAnyoneClick
            ? this._isAnyoneChoreCompleted(choreId, date)
            : this._isChoreCompletedBy(choreId, memberId, date);

        this._togglingCompletion.add(key);
        App.renderPage();

        try {
            if (wasCompleted) {
                // Find the completion record to uncomplete.
                // For an anyone-click, search across all members (there's a
                // single completion owned by whoever first completed it).
                // For a per-member click, only look at THIS member's
                // completions — otherwise we'd uncomplete a different
                // member's record on a multi-assigned chore (D.39).
                let completionId = null;
                let creditedMemberId = memberId;
                let pointsToRefund = 0;
                if (isAnyoneClick) {
                    for (const mid of Object.keys(this._completionsByMember)) {
                        const c = this._completionsByMember[mid].find(co =>
                            co.chore_id === choreId && this._sameDate(new Date(co.completed_at), date)
                        );
                        if (c) {
                            completionId = c.id;
                            creditedMemberId = mid;
                            pointsToRefund = c.points_earned || 0;
                            break;
                        }
                    }
                } else {
                    const c = (this._completionsByMember[memberId] || []).find(co =>
                        co.chore_id === choreId && this._sameDate(new Date(co.completed_at), date)
                    );
                    if (c) {
                        completionId = c.id;
                        creditedMemberId = memberId;
                        pointsToRefund = c.points_earned || 0;
                    }
                }
                if (completionId) {
                    await DashieAuth.dbRequest('uncomplete_chore', {
                        chore_id: choreId,
                        completion_id: completionId,
                        family_member_id: creditedMemberId,
                    });
                    this._completionsByMember[creditedMemberId] = (this._completionsByMember[creditedMemberId] || [])
                        .filter(co => co.id !== completionId);
                    if (pointsToRefund) {
                        this._pointsByMember[creditedMemberId] = Math.max(0, (this._pointsByMember[creditedMemberId] || 0) - pointsToRefund);
                    }
                    // Broadcast to other clients (tablets)
                    DashieAuth.broadcast('chore-completions', 'chore-changed', {
                        action: 'undo',
                        chore_id: choreId,
                        data: { family_member_id: creditedMemberId },
                        completion: { family_member_id: creditedMemberId },
                        timestamp: Date.now(),
                    }).catch(e => console.warn('[ChoresPage] Broadcast failed:', e.message));
                }
            } else {
                const result = await DashieAuth.dbRequest('complete_chore', {
                    chore_id: choreId,
                    family_member_id: memberId,
                    completed_at: date.toISOString(),
                });
                const completion = result.completion || result.data;
                if (completion) {
                    this._completionsByMember[memberId] = this._completionsByMember[memberId] || [];
                    this._completionsByMember[memberId].push(completion);
                    const earned = completion.points_earned || 0;
                    if (earned) {
                        this._pointsByMember[memberId] = (this._pointsByMember[memberId] || 0) + earned;
                    }
                    // Broadcast to other clients (tablets)
                    DashieAuth.broadcast('chore-completions', 'chore-changed', {
                        action: 'complete',
                        chore_id: choreId,
                        data: completion,
                        completion,
                        timestamp: Date.now(),
                    }).catch(e => console.warn('[ChoresPage] Broadcast failed:', e.message));
                }
            }
        } catch (e) {
            console.error('[ChoresPage] Toggle completion failed:', e);
            Toast.error(Toast.friendly(e, 'update this chore'));
        } finally {
            this._togglingCompletion.delete(key);
            App.renderPage();
        }
    },

    _toggleMemberExpand(id) {
        if (this._expandedMembers.has(id)) this._expandedMembers.delete(id);
        else this._expandedMembers.add(id);
        App.renderPage();
    },

    _toggleAnyoneExpand() {
        this._anyoneExpanded = !this._anyoneExpanded;
        App.renderPage();
    },

    _navDate(deltaDays) {
        const base = this._currentDate || new Date();
        const newDate = new Date(base);
        newDate.setDate(newDate.getDate() + deltaDays);
        this._currentDate = newDate;
        App.renderPage();
    },

    _navToday() {
        this._currentDate = null;
        App.renderPage();
    },

    // =========================================================
    //  List view (management)
    // =========================================================

    _renderListView() {
        if (!this._chores || this._chores.length === 0) {
            return `
                <div class="empty-state">
                    <div class="empty-state-icon">✓</div>
                    <div class="empty-state-text">No chores yet.</div>
                    <div style="color: var(--text-muted); font-size: var(--font-size-sm); margin-top: 8px;">
                        Click "+ Add Chore" to create one.
                    </div>
                </div>
            `;
        }

        const cards = this._chores.map(c => this._renderChoreCard(c)).join('');
        return `
            <div class="chore-list">${cards}</div>
            <p class="page-summary">${this._chores.length} chore${this._chores.length === 1 ? '' : 's'}</p>
        `;
    },

    _renderChoreCard(c) {
        const assigneeChips = this._renderAssigneeChips(c);
        const recurringIcon = c.repeats
            ? `<img src="assets/icons/icon-reload.svg" style="width: 13px; height: 13px; vertical-align: middle; opacity: 0.5; margin-right: 4px;" title="Recurring">`
            : '';
        return `
            <div class="chore-card" onclick="ChoresPage.edit('${c.id}')">
                <div class="chore-card-emoji">${c.emoji || '✓'}</div>
                <div class="chore-card-body">
                    <div class="chore-card-title">${this._escape(c.title)}</div>
                    <div class="chore-card-meta">
                        <span class="chore-card-freq">${recurringIcon}${this._formatFrequency(c)}</span>
                        ${assigneeChips ? `<span class="chore-card-dot">·</span>${assigneeChips}` : ''}
                    </div>
                </div>
                <div class="chore-card-points">${c.points ?? 0} pts</div>
            </div>
        `;
    },

    _renderAssigneeChips(c) {
        if (this._isAnyoneChore(c)) {
            return `<span class="assignee-chip assignee-anyone">Anyone</span>`;
        }
        if (!c.assigned_member_ids || c.assigned_member_ids.length === 0) {
            return `<span class="assignee-chip assignee-none">Unassigned</span>`;
        }
        const chips = c.assigned_member_ids.slice(0, 3).map(id => {
            const m = (this._allFamilyMembers || []).find(m => m.id === id);
            if (!m) return '';
            const name = m.nickname || (m.full_name || '').split(' ')[0] || '?';
            const color = m.assigned_color || '#9ca3af';
            return `<span class="assignee-chip" style="background: ${color}1a; border-color: ${color}66; color: ${color};">${this._escape(name)}</span>`;
        }).join('');
        const extra = c.assigned_member_ids.length > 3 ? `<span class="assignee-chip">+${c.assigned_member_ids.length - 3}</span>` : '';
        return chips + extra;
    },

    // =========================================================
    //  Modal (create/edit)
    // =========================================================

    _initForm(chore) {
        const today = this._localDateString(new Date());

        let recurrence = 'one_time';
        if (chore?.repeats) {
            recurrence = (chore.repeat_interval_unit === 'weeks' && chore.repeat_days?.length > 0) ? 'weekly' : 'custom';
        }

        return {
            title: chore?.title || '',
            emoji: chore?.emoji || '',
            points: chore?.points ?? 10,
            assignmentType: chore && this._isAnyoneChore(chore) ? 'anyone' : 'members',
            memberIds: [...(chore?.assigned_member_ids || [])],
            recurrence,
            dueDate: chore?.due_date || today,
            dueTime: chore?.due_time || '09:00',
            dueTimeEnabled: !!chore?.due_time,
            allowEarlyCompletion: !!chore?.allow_early_completion,
            // Store as string values matching backend
            weeklyDays: [...(chore?.repeat_days || [])],
            customN: chore?.repeat_interval_n || 1,
            customUnit: (recurrence === 'custom' && chore?.repeat_interval_unit) ? chore.repeat_interval_unit : 'days',
            customStartDate: chore?.due_date || today,
        };
    },

    _renderModal() {
        const isNew = this._editingId === 'new';
        const f = this._form;
        const title = isNew ? 'Add Chore' : 'Edit Chore';

        return `
            <div class="modal-backdrop" onclick="ChoresPage._onBackdropClick(event)">
                <div class="modal" onclick="event.stopPropagation()">
                    <div class="modal-header">
                        <span class="modal-title">${title}</span>
                        <button class="modal-close" onclick="ChoresPage.closeEdit()">✕</button>
                    </div>
                    <div class="modal-body">
                        ${this._renderNameField(f)}
                        ${this._renderIconPointsRow(f)}
                        ${this._renderAssignField(f)}
                        ${this._renderRecurrenceField(f)}
                    </div>
                    <div class="modal-footer">
                        ${!isNew ? `
                            <button class="btn btn-danger btn-sm" onclick="ChoresPage._delete()"
                                ${this._saving || this._deleting ? 'disabled' : ''}
                                style="margin-right: auto;">
                                ${this._deleting ? 'Deleting…' : 'Delete'}
                            </button>
                        ` : ''}
                        <button class="btn btn-ghost" onclick="ChoresPage.closeEdit()" ${this._saving ? 'disabled' : ''}>Cancel</button>
                        <button class="btn btn-primary" onclick="ChoresPage._save()" ${this._saving ? 'disabled' : ''}>
                            ${this._saving ? 'Saving…' : 'Save'}
                        </button>
                    </div>
                </div>
            </div>
        `;
    },

    _renderNameField(f) {
        return `
            <div class="chore-field">
                <label class="chore-field-label required">Chore Name</label>
                <input type="text" class="chore-field-input" id="chore-f-title"
                    value="${this._escape(f.title)}" placeholder="e.g., Make your bed" maxlength="100"
                    oninput="ChoresPage._form.title = this.value">
            </div>
        `;
    },

    _renderIconPointsRow(f) {
        const emojiLabel = f.emoji || '➕';
        return `
            <div class="chore-field-row">
                <div class="chore-field chore-field-icon">
                    <label class="chore-field-label">Icon</label>
                    <button type="button" class="emoji-field-btn ${f.emoji ? '' : 'empty'}"
                        onclick="ChoresPage._openEmojiPicker()">
                        ${this._escape(emojiLabel)}
                    </button>
                </div>
                <div class="chore-field chore-field-points">
                    <label class="chore-field-label">Points</label>
                    <input type="number" class="chore-field-input" id="chore-f-points"
                        value="${f.points}" min="0" max="100"
                        oninput="ChoresPage._form.points = parseInt(this.value) || 0">
                </div>
            </div>
        `;
    },

    _openEmojiPicker() {
        EmojiPicker.open(null, (emoji) => {
            this._form.emoji = emoji;
            App.renderPage();
        });
    },

    _renderAssignField(f) {
        const members = this._familyMembers || [];
        const anyoneEnabled = this._userSettings?.chores?.anyoneEnabled !== false;
        // If anyone was selected but anyone is now disabled, flip to members mode
        if (!anyoneEnabled && f.assignmentType === 'anyone') {
            f.assignmentType = 'members';
        }
        const isAnyone = f.assignmentType === 'anyone';
        const hasIndividuals = f.memberIds.length > 0;

        const allMemberIds = members.map(m => m.id);
        const kidIds = members.filter(m => m.relationship === 'child').map(m => m.id);
        const isEveryoneActive = !isAnyone && allMemberIds.length > 0 && allMemberIds.every(id => f.memberIds.includes(id));
        const isKidsActive = !isAnyone && kidIds.length > 0 && f.memberIds.length === kidIds.length && kidIds.every(id => f.memberIds.includes(id));

        const anyoneCircle = anyoneEnabled ? `
            <button type="button" class="member-circle anyone-circle ${isAnyone ? 'selected' : ''} ${hasIndividuals && !isAnyone ? 'dimmed' : ''}"
                onclick="ChoresPage._toggleAnyone()" title="Anyone can complete">
                <div class="member-avatar anyone-avatar">
                    <span style="font-size: 18px;">👪</span>
                    ${isAnyone ? '<span class="check-badge">✓</span>' : ''}
                </div>
                <div class="member-label">Anyone</div>
            </button>
        ` : '';

        const memberCircles = members.map(m => {
            const isSel = f.memberIds.includes(m.id);
            const name = m.nickname || (m.full_name || '').split(' ')[0] || 'Unknown';
            const initial = (m.full_name || m.nickname || '?')[0].toUpperCase();
            const color = m.assigned_color || '#999';
            return `
                <button type="button" class="member-circle ${isSel ? 'selected' : ''} ${isAnyone ? 'dimmed' : ''}"
                    onclick="ChoresPage._toggleMember('${m.id}')" title="${this._escape(name)}">
                    <div class="member-avatar" style="background: ${color};">
                        ${this._escape(initial)}
                        ${isSel ? '<span class="check-badge">✓</span>' : ''}
                    </div>
                    <div class="member-label">${this._escape(name)}</div>
                </button>
            `;
        }).join('');

        return `
            <div class="chore-field">
                <div class="chore-field-header">
                    <label class="chore-field-label required">Assign To</label>
                    <div class="quick-selectors">
                        <button type="button" class="quick-btn ${isEveryoneActive ? 'active' : ''}"
                            onclick="ChoresPage._selectAllMembers()">Everyone</button>
                        <button type="button" class="quick-btn ${isKidsActive ? 'active' : ''}"
                            onclick="ChoresPage._selectKids()">Kids</button>
                        <button type="button" class="clear-link" onclick="ChoresPage._clearMembers()">Clear</button>
                    </div>
                </div>
                <div class="member-row">
                    ${anyoneCircle}
                    ${memberCircles || '<span style="color: var(--text-muted); font-size: var(--font-size-sm); padding: 12px;">No family members. Add them in Family first.</span>'}
                </div>
            </div>
        `;
    },

    _renderRecurrenceField(f) {
        return `
            <div class="chore-field">
                <label class="chore-field-label required">Recurrence</label>
                <select class="chore-field-input" id="chore-f-recurrence" onchange="ChoresPage._setRecurrence(this.value)">
                    <option value="one_time" ${f.recurrence === 'one_time' ? 'selected' : ''}>One Time</option>
                    <option value="weekly" ${f.recurrence === 'weekly' ? 'selected' : ''}>Daily/Weekly</option>
                    <option value="custom" ${f.recurrence === 'custom' ? 'selected' : ''}>Custom</option>
                </select>
            </div>
            ${f.recurrence === 'one_time' ? this._renderOneTimeOptions(f) : ''}
            ${f.recurrence === 'weekly' ? this._renderWeeklyOptions(f) : ''}
            ${f.recurrence === 'custom' ? this._renderCustomOptions(f) : ''}
        `;
    },

    _renderOneTimeOptions(f) {
        return `
            <div class="chore-field">
                <label class="chore-field-label">By Date</label>
                <input type="date" class="chore-field-input" value="${f.dueDate}"
                    oninput="ChoresPage._form.dueDate = this.value">
            </div>
            ${this._renderTimeToggle(f)}
        `;
    },

    _renderWeeklyOptions(f) {
        const allSelected = f.weeklyDays.length === 7;
        const weekdaysOnly = f.weeklyDays.length === 5
            && ['mon', 'tue', 'wed', 'thu', 'fri'].every(d => f.weeklyDays.includes(d));

        const dayButtons = this.WEEKDAYS.map(day => `
            <button type="button" class="day-btn ${f.weeklyDays.includes(day.value) ? 'selected' : ''}"
                onclick="ChoresPage._toggleWeekday('${day.value}')">${day.label}</button>
        `).join('');

        return `
            <div class="chore-field">
                <div class="chore-field-header">
                    <label class="chore-field-label">Day</label>
                    <div class="quick-selectors">
                        <button type="button" class="quick-btn ${allSelected ? 'active' : ''}"
                            onclick="ChoresPage._selectAllDays()">Everyday</button>
                        <button type="button" class="quick-btn ${weekdaysOnly ? 'active' : ''}"
                            onclick="ChoresPage._selectWeekdaysOnly()">Weekdays</button>
                        <button type="button" class="clear-link" onclick="ChoresPage._clearDays()">Clear</button>
                    </div>
                </div>
                <div class="weekday-grid">${dayButtons}</div>
            </div>
            ${this._renderTimeToggle(f)}
            ${this._renderEarlyCompletionToggle(f)}
        `;
    },

    _renderCustomOptions(f) {
        return `
            <div class="chore-field-row">
                <div class="chore-field" style="flex: 0 0 200px;">
                    <label class="chore-field-label">Every</label>
                    <div class="number-control">
                        <button type="button" class="num-btn" onclick="ChoresPage._adjustCustomN(-1)">−</button>
                        <input type="number" class="num-input" value="${f.customN}" min="1" max="99"
                            oninput="ChoresPage._form.customN = parseInt(this.value) || 1">
                        <button type="button" class="num-btn" onclick="ChoresPage._adjustCustomN(1)">+</button>
                    </div>
                </div>
                <div class="chore-field" style="flex: 1;">
                    <label class="chore-field-label">Period</label>
                    <select class="chore-field-input" oninput="ChoresPage._form.customUnit = this.value">
                        <option value="days" ${f.customUnit === 'days' ? 'selected' : ''}>Days</option>
                        <option value="weeks" ${f.customUnit === 'weeks' ? 'selected' : ''}>Weeks</option>
                        <option value="months" ${f.customUnit === 'months' ? 'selected' : ''}>Months</option>
                    </select>
                </div>
            </div>
            <div class="chore-field">
                <label class="chore-field-label">Starting</label>
                <input type="date" class="chore-field-input" value="${f.customStartDate}"
                    oninput="ChoresPage._form.customStartDate = this.value">
            </div>
            ${this._renderTimeToggle(f)}
            ${this._renderEarlyCompletionToggle(f)}
        `;
    },

    _renderTimeToggle(f) {
        return `
            <div class="chore-field">
                <label class="toggle-row">
                    <span class="toggle-text">Set Time</span>
                    <label class="toggle"><input type="checkbox" ${f.dueTimeEnabled ? 'checked' : ''}
                        onchange="ChoresPage._toggleTime(this.checked)">
                        <span class="toggle-slider"></span></label>
                </label>
                <input type="time" class="chore-field-input" value="${f.dueTime}"
                    ${!f.dueTimeEnabled ? 'disabled' : ''}
                    style="margin-top: 8px; ${!f.dueTimeEnabled ? 'opacity: 0.5;' : ''}"
                    oninput="ChoresPage._form.dueTime = this.value">
            </div>
        `;
    },

    _renderEarlyCompletionToggle(f) {
        return `
            <div class="chore-field">
                <label class="toggle-row">
                    <span class="toggle-text">Can Complete Early</span>
                    <label class="toggle"><input type="checkbox" ${f.allowEarlyCompletion ? 'checked' : ''}
                        onchange="ChoresPage._form.allowEarlyCompletion = this.checked">
                        <span class="toggle-slider"></span></label>
                </label>
                <div class="field-hint">Shows in upcoming chores and can be done before the scheduled day</div>
            </div>
        `;
    },

    // =========================================================
    //  Form interactions
    // =========================================================

    _onBackdropClick(event) { if (event.target === event.currentTarget) this.closeEdit(); },
    _setRecurrence(value) { this._form.recurrence = value; App.renderPage(); },
    _toggleTime(enabled) { this._form.dueTimeEnabled = enabled; App.renderPage(); },

    _toggleAnyone() {
        if (this._form.assignmentType === 'anyone') this._form.assignmentType = 'members';
        else { this._form.assignmentType = 'anyone'; this._form.memberIds = []; }
        App.renderPage();
    },

    _toggleMember(id) {
        if (this._form.assignmentType === 'anyone') this._form.assignmentType = 'members';
        const idx = this._form.memberIds.indexOf(id);
        if (idx >= 0) this._form.memberIds.splice(idx, 1);
        else this._form.memberIds.push(id);
        App.renderPage();
    },

    _selectAllMembers() {
        this._form.assignmentType = 'members';
        this._form.memberIds = (this._familyMembers || []).map(m => m.id);
        App.renderPage();
    },

    _selectKids() {
        this._form.assignmentType = 'members';
        this._form.memberIds = (this._familyMembers || []).filter(m => m.relationship === 'child').map(m => m.id);
        App.renderPage();
    },

    _clearMembers() {
        this._form.memberIds = [];
        this._form.assignmentType = 'members';
        App.renderPage();
    },

    _toggleWeekday(value) {
        const idx = this._form.weeklyDays.indexOf(value);
        if (idx >= 0) this._form.weeklyDays.splice(idx, 1);
        else this._form.weeklyDays.push(value);
        App.renderPage();
    },

    _selectAllDays() { this._form.weeklyDays = this.WEEKDAYS.map(d => d.value); App.renderPage(); },
    _selectWeekdaysOnly() { this._form.weeklyDays = ['mon', 'tue', 'wed', 'thu', 'fri']; App.renderPage(); },
    _clearDays() { this._form.weeklyDays = []; App.renderPage(); },

    _adjustCustomN(delta) {
        this._form.customN = Math.max(1, Math.min(99, this._form.customN + delta));
        App.renderPage();
    },

    // =========================================================
    //  Save/delete
    // =========================================================

    _buildPayload() {
        const f = this._form;
        const payload = {
            title: f.title.trim(),
            emoji: f.emoji.trim() || '✓',
            points: f.points,
            allow_early_completion: f.allowEarlyCompletion,
        };

        if (f.assignmentType === 'anyone') {
            payload.assignment_type = 'anyone';
            payload.assigned_member_ids = [];
        } else {
            payload.assignment_type = 'individual';
            payload.assigned_member_ids = f.memberIds;
        }

        if (f.recurrence === 'one_time') {
            payload.repeats = false;
            payload.due_date = f.dueDate;
        } else if (f.recurrence === 'weekly') {
            payload.repeats = true;
            payload.repeat_interval_n = 1;
            payload.repeat_interval_unit = 'weeks';
            payload.repeat_days = f.weeklyDays;  // store as strings: ['mon','wed','fri']
        } else {
            payload.repeats = true;
            payload.repeat_interval_n = f.customN;
            payload.repeat_interval_unit = f.customUnit;
            payload.repeat_days = [];
            payload.due_date = f.customStartDate;
        }

        if (f.dueTimeEnabled) payload.due_time = f.dueTime;

        return payload;
    },

    async _save() {
        const f = this._form;

        if (!f.title.trim()) { Toast.error('Please enter a chore name'); return; }
        if (f.assignmentType === 'members' && f.memberIds.length === 0) {
            Toast.error('Please select at least one family member, or choose "Anyone"');
            return;
        }
        if (f.recurrence === 'weekly' && f.weeklyDays.length === 0) {
            Toast.error('Please select at least one day of the week');
            return;
        }

        this._saving = true;
        App.renderPage();

        const payload = this._buildPayload();
        try {
            console.log('[ChoresPage] Saving chore with payload:', payload);
            if (this._editingId === 'new') {
                const result = await DashieAuth.dbRequest('create_chore', payload);
                const newChore = result.chore || result.data;
                if (newChore) {
                    this._chores.push(newChore);
                    DashieAuth.broadcast('chore-completions', 'chore-changed', {
                        action: 'create', chore_id: newChore.id, data: newChore, timestamp: Date.now(),
                    }).catch(() => {});
                    Toast.success('Chore added');
                }
            } else {
                const result = await DashieAuth.dbRequest('update_chore', {
                    chore_id: this._editingId,
                    updates: payload,
                });
                const updated = result.chore || result.data;
                if (updated) {
                    const i = this._chores.findIndex(c => c.id === this._editingId);
                    if (i >= 0) this._chores[i] = updated;
                    DashieAuth.broadcast('chore-completions', 'chore-changed', {
                        action: 'update', chore_id: updated.id, data: updated, timestamp: Date.now(),
                    }).catch(() => {});
                    Toast.success('Changes saved');
                }
            }
            this._editingId = null;
            this._form = null;
        } catch (e) {
            console.error('[ChoresPage] Save failed:', e, 'Payload was:', payload);
            Toast.error(Toast.friendly(e, 'save this chore'));
        } finally {
            this._saving = false;
            App.renderPage();
        }
    },

    async _delete() {
        const chore = this._chores.find(c => c.id === this._editingId);
        if (!chore) return;
        if (!confirm(`Delete "${chore.title}"?`)) return;

        this._deleting = true;
        App.renderPage();

        try {
            const deletedId = this._editingId;
            await DashieAuth.dbRequest('delete_chore', {
                chore_id: deletedId,
                hard_delete: false,
            });
            this._chores = this._chores.filter(c => c.id !== deletedId);
            this._editingId = null;
            this._form = null;
            DashieAuth.broadcast('chore-completions', 'chore-changed', {
                action: 'delete', chore_id: deletedId, timestamp: Date.now(),
            }).catch(() => {});
        } catch (e) {
            console.error('[ChoresPage] Delete failed:', e);
            Toast.error(Toast.friendly(e, 'delete this chore'));
        } finally {
            this._deleting = false;
            App.renderPage();
        }
    },

    edit(id) {
        const chore = this._chores.find(c => c.id === id);
        this._form = this._initForm(chore);
        this._editingId = id;
        App.renderPage();
    },

    add() {
        this._form = this._initForm(null);
        this._editingId = 'new';
        App.renderPage();
        setTimeout(() => {
            const el = document.getElementById('chore-f-title');
            if (el) el.focus();
        }, 50);
    },

    closeEdit() {
        this._editingId = null;
        this._form = null;
        App.renderPage();
    },

    // =========================================================
    //  Options modal — delegated to shared OptionsModal component
    // =========================================================

    openOptions() {
        OptionsModal.open(this._userSettings || {}, this._allFamilyMembers || [], (full) => {
            this._userSettings = full;
            const participants = full.chores?.participants;
            this._familyMembers = (Array.isArray(participants) && participants.length > 0)
                ? this._allFamilyMembers.filter(m => participants.includes(m.id))
                : this._allFamilyMembers;
            App.renderPage();
        });
    },

    // Legacy methods retained for backward compat but no longer used:
    _renderOptionsModalLegacy() {
        const f = this._optionsForm;
        if (!f) return '';
        const members = this._allFamilyMembers || [];

        // null participants means "all members" — render as all-selected but note it's implicit
        const participantsList = f.participants === null ? members.map(m => m.id) : f.participants;

        const memberCircles = members.map(m => {
            const isSel = participantsList.includes(m.id);
            const name = m.nickname || (m.full_name || '').split(' ')[0] || 'Unknown';
            const initial = (m.full_name || m.nickname || '?')[0].toUpperCase();
            const color = m.assigned_color || '#999';
            return `
                <button type="button" class="member-circle ${isSel ? 'selected' : ''}"
                    onclick="ChoresPage._toggleOptionsParticipant('${m.id}')" title="${this._escape(name)}">
                    <div class="member-avatar" style="background: ${color};">
                        ${this._escape(initial)}
                        ${isSel ? '<span class="check-badge">✓</span>' : ''}
                    </div>
                    <div class="member-label">${this._escape(name)}</div>
                </button>
            `;
        }).join('');

        return `
            <div class="modal-backdrop" onclick="ChoresPage._onOptionsBackdropClick(event)">
                <div class="modal" onclick="event.stopPropagation()">
                    <div class="modal-header">
                        <span class="modal-title">Chores &amp; Rewards Options</span>
                        <button class="modal-close" onclick="ChoresPage.closeOptions()">✕</button>
                    </div>
                    <div class="modal-body">
                        <div class="chore-field">
                            <label class="toggle-row">
                                <span class="toggle-text">Enable Chores</span>
                                <label class="toggle"><input type="checkbox" ${f.choresEnabled ? 'checked' : ''}
                                    onchange="ChoresPage._optionsForm.choresEnabled = this.checked; App.renderPage();">
                                    <span class="toggle-slider"></span></label>
                            </label>
                            <div class="field-hint">Master switch for chores. Disabling hides chores on all devices.</div>
                        </div>

                        <div class="chore-field">
                            <label class="toggle-row">
                                <span class="toggle-text">Enable Rewards</span>
                                <label class="toggle"><input type="checkbox" ${f.rewardsEnabled ? 'checked' : ''}
                                    onchange="ChoresPage._optionsForm.rewardsEnabled = this.checked; App.renderPage();">
                                    <span class="toggle-slider"></span></label>
                            </label>
                            <div class="field-hint">Family members can redeem points for rewards when enabled.</div>
                        </div>

                        <div class="chore-field">
                            <label class="toggle-row">
                                <span class="toggle-text">Allow "Anyone" Chores</span>
                                <label class="toggle"><input type="checkbox" ${f.anyoneEnabled ? 'checked' : ''}
                                    onchange="ChoresPage._optionsForm.anyoneEnabled = this.checked; App.renderPage();">
                                    <span class="toggle-slider"></span></label>
                            </label>
                            <div class="field-hint">When on, chores can be marked "Anyone" so any participant can complete them.</div>
                        </div>

                        <div class="chore-field">
                            <label class="chore-field-label">Upcoming Days</label>
                            <input type="number" class="chore-field-input" value="${f.upcomingDays}"
                                min="1" max="30" style="max-width: 120px;"
                                oninput="ChoresPage._optionsForm.upcomingDays = parseInt(this.value) || 7">
                            <div class="field-hint">How many days ahead to show upcoming chores.</div>
                        </div>

                        <div class="chore-field">
                            <div class="chore-field-header">
                                <label class="chore-field-label">Chore Participants</label>
                                <div class="quick-selectors">
                                    <button type="button" class="quick-btn" onclick="ChoresPage._selectAllOptionsParticipants()">All</button>
                                    <button type="button" class="quick-btn" onclick="ChoresPage._selectKidsOptionsParticipants()">Kids Only</button>
                                    <button type="button" class="clear-link" onclick="ChoresPage._clearOptionsParticipants()">Clear</button>
                                </div>
                            </div>
                            <div class="field-hint" style="margin-bottom: 8px;">Only selected members appear in the Assignments view.</div>
                            <div class="member-row">${memberCircles}</div>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-ghost" onclick="ChoresPage.closeOptions()" ${this._optionsSaving ? 'disabled' : ''}>Cancel</button>
                        <button class="btn btn-primary" onclick="ChoresPage._saveOptions()" ${this._optionsSaving ? 'disabled' : ''}>
                            ${this._optionsSaving ? 'Saving…' : 'Save'}
                        </button>
                    </div>
                </div>
            </div>
        `;
    },

    _onOptionsBackdropClick(event) {
        if (event.target === event.currentTarget) this.closeOptions();
    },

    _toggleOptionsParticipant(id) {
        const f = this._optionsForm;
        // Convert from implicit "null = all" to explicit list on first interaction
        if (f.participants === null) {
            f.participants = (this._allFamilyMembers || []).map(m => m.id);
        }
        const idx = f.participants.indexOf(id);
        if (idx >= 0) f.participants.splice(idx, 1);
        else f.participants.push(id);
        App.renderPage();
    },

    _selectAllOptionsParticipants() {
        this._optionsForm.participants = (this._allFamilyMembers || []).map(m => m.id);
        App.renderPage();
    },

    _selectKidsOptionsParticipants() {
        this._optionsForm.participants = (this._allFamilyMembers || [])
            .filter(m => m.relationship === 'child').map(m => m.id);
        App.renderPage();
    },

    _clearOptionsParticipants() {
        this._optionsForm.participants = [];
        App.renderPage();
    },

    async _saveOptions() {
        const f = this._optionsForm;
        if (!f) return;

        this._optionsSaving = true;
        App.renderPage();

        try {
            // Patch only the keys this modal owns via the canonical
            // serialized writer — the server merges them over the stored
            // blob, so other sections can't be clobbered.
            const patch = {
                chores: {
                    enabled: f.choresEnabled,
                    anyoneEnabled: f.anyoneEnabled,
                    participants: f.participants,  // null means "all members"
                    upcomingDays: f.upcomingDays,
                },
                rewards: {
                    enabled: f.rewardsEnabled,
                },
            };
            await DashieAuth.patchUserSettings(patch);

            // Mirror the patch into local render state
            this._userSettings = {
                ...(this._userSettings || {}),
                chores: { ...(this._userSettings?.chores || {}), ...patch.chores },
                rewards: { ...(this._userSettings?.rewards || {}), ...patch.rewards },
            };

            // Re-derive visible family members
            const participants = patch.chores.participants;
            this._familyMembers = (Array.isArray(participants) && participants.length > 0)
                ? this._allFamilyMembers.filter(m => participants.includes(m.id))
                : this._allFamilyMembers;

            this._optionsOpen = false;
            this._optionsForm = null;
        } catch (e) {
            console.error('[ChoresPage] Save options failed:', e);
            Toast.error(Toast.friendly(e, 'save options'));
        } finally {
            this._optionsSaving = false;
            App.renderPage();
        }
    },

    // =========================================================
    //  Utilities
    // =========================================================

    _formatFrequency(c) {
        if (!c.repeats) {
            if (c.due_date) return `Due ${this._formatDate(c.due_date)}`;
            return 'One time';
        }
        const repeatDays = c.repeat_days || [];
        if (c.repeat_interval_unit === 'weeks' && repeatDays.length > 0) {
            if (repeatDays.length === 7) return 'Every day';
            if (repeatDays.length === 5 && ['mon','tue','wed','thu','fri'].every(d => repeatDays.includes(d))) return 'Weekdays';
            if (repeatDays.length === 2 && ['sat','sun'].every(d => repeatDays.includes(d))) return 'Weekends';
            const names = repeatDays
                .map(v => this.WEEKDAYS.find(d => d.value === v)?.full)
                .filter(Boolean);
            return names.join(', ');
        }
        const n = c.repeat_interval_n || 1;
        const unit = c.repeat_interval_unit || 'days';
        return n === 1 ? `Every ${unit.slice(0, -1)}` : `Every ${n} ${unit}`;
    },

    _formatDate(iso) {
        if (!iso) return '—';
        try {
            return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        } catch (e) { return iso; }
    },

    _sameDate(d1, d2) {
        if (!d1 || !d2) return false;
        return d1.getFullYear() === d2.getFullYear()
            && d1.getMonth() === d2.getMonth()
            && d1.getDate() === d2.getDate();
    },

    /** Format a Date as "YYYY-MM-DD" using LOCAL time, not UTC */
    _localDateString(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${dd}`;
    },

    _sameIsoDay(iso, date) {
        try { return this._sameDate(new Date(iso), date); }
        catch (e) { return false; }
    },

    _escape(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    },
};
