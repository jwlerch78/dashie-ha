/* ============================================================
   Rewards Page — per-member redemption view + management
   Mirrors mobile app design
   ============================================================ */

const RewardsPage = {
    _rewards: null,
    _familyMembers: null,
    _allFamilyMembers: null,
    _userSettings: null,
    _pointsByMember: {},
    _redemptions: [],
    _loading: false,
    _error: null,
    _view: 'assignments',           // 'assignments' | 'list'
    _typeFilter: 'all',             // 'all' | 'renewable' | 'one_time'
    _expandedMembers: new Set(),
    _showRecentlyRedeemed: false,   // toggle in top bar
    _editingId: null,               // 'new' | reward.id
    _form: null,
    _saving: false,
    _deleting: false,
    _redeeming: new Set(),          // keys (rewardId + memberId) currently redeeming

    UNDO_WINDOW_MS: 5 * 60 * 1000,   // 5 minutes (matches mobile app)

    render() {
        if (!this._rewards && !this._loading && !this._error) {
            this._fetchData();
            return this._renderLoading();
        }
        if (this._loading && !this._rewards) return this._renderLoading();
        if (this._error && !this._rewards) return this._renderError();

        let html = this._view === 'list' ? this._renderListView() : this._renderAssignmentsView();
        if (this._editingId) html += this._renderModal();
        html += OptionsModal.render();
        html += EmojiPicker.render();
        return html;
    },

    topBarTitle() {
        if (!this._rewards) return 'Rewards';
        const familyPoints = (this._familyMembers || []).reduce((sum, m) =>
            sum + (this._pointsByMember[m.id] || 0), 0);
        return `Rewards  ·  <span style="color: var(--accent); font-weight: 700;">★</span> ${familyPoints.toLocaleString()} family points`;
    },

    topBarSubtitle() { return ''; },

    topBarActions() {
        const editActive = this._view === 'list';
        return `
            <button class="btn btn-primary" onclick="RewardsPage.add()">+ Add Reward</button>
            <button class="btn ${editActive ? 'btn-primary' : 'btn-secondary'}" onclick="RewardsPage._toggleView()">
                <img src="assets/icons/icon-edit.svg" style="width: 14px; height: 14px; margin-right: 4px; ${editActive ? 'filter: brightness(0) invert(1);' : ''}"
                    onerror="this.style.display='none'">
                ${editActive ? 'Done' : 'Edit'}
            </button>
            <button class="btn btn-secondary" onclick="RewardsPage._openOptions()">
                <img src="assets/icons/icon-settings.svg" style="width: 14px; height: 14px; margin-right: 4px; opacity: 0.6;">
                Options
            </button>
        `;
    },

    _toggleView() {
        this._view = this._view === 'list' ? 'assignments' : 'list';
        App.renderPage();
    },

    _openOptions() {
        OptionsModal.open(this._userSettings || {}, this._allFamilyMembers || [], (full) => {
            this._userSettings = full;
            const participants = full.chores?.participants;
            this._familyMembers = (Array.isArray(participants) && participants.length > 0)
                ? this._allFamilyMembers.filter(m => participants.includes(m.id))
                : this._allFamilyMembers;
            App.renderPage();
        });
    },

    // =========================================================
    //  Data loading
    // =========================================================

    async refresh() { await this._fetchData(); },

    async _fetchData() {
        this._loading = true;
        this._error = null;
        try {
            const [rewardsResult, familyResult, settingsResult] = await Promise.all([
                // Always fetch with include_inactive so we have redeemed one-time rewards
                // available when the user toggles "Show Recently Redeemed" on.
                DashieAuth.dbRequest('list_rewards', { include_inactive: true }),
                DashieAuth.dbRequest('list_family_members', {}),
                DashieAuth.loadUserSettings().catch(() => ({})),
            ]);

            this._rewards = rewardsResult.rewards || rewardsResult.data || [];
            this._allFamilyMembers = familyResult.members || familyResult.data || [];
            this._userSettings = settingsResult || {};

            const participants = this._userSettings?.chores?.participants;
            this._familyMembers = (Array.isArray(participants) && participants.length > 0)
                ? this._allFamilyMembers.filter(m => participants.includes(m.id))
                : this._allFamilyMembers;

            // Get points per member from chores dashboard data
            const allMemberIds = this._allFamilyMembers.map(m => m.id);
            const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
            const choreData = await DashieAuth.dbRequest('get_chore_dashboard_data', {
                member_ids: allMemberIds,
                since,
            }).catch(() => ({ points_by_member: {} }));
            this._pointsByMember = choreData.points_by_member || {};

            // Recent redemptions (last 7 days, all statuses — for display)
            const redemptionsResult = await DashieAuth.dbRequest('get_redemptions', {
                since: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(),
            }).catch(() => ({ redemptions: [] }));
            this._redemptions = redemptionsResult.redemptions || redemptionsResult.data || [];
        } catch (e) {
            console.error('[RewardsPage] Fetch failed:', e);
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
                    <div style="color: var(--text-secondary); font-size: var(--font-size-sm);">Loading rewards...</div>
                </div>
                <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
            </div>
        `;
    },

    _renderError() {
        return `
            <div class="card">
                <div class="card-body" style="color: var(--status-error);">
                    <strong>Failed to load rewards:</strong> ${this._escape(this._error)}
                    <div style="margin-top: 12px;">
                        <button class="btn btn-secondary btn-sm" onclick="RewardsPage._retry()">Retry</button>
                    </div>
                </div>
            </div>
        `;
    },

    _retry() { this._error = null; this._rewards = null; App.renderPage(); },

    // =========================================================
    //  Reward filtering helpers
    // =========================================================

    _isAnyoneReward(r) {
        return r.assignment_type === 'anyone' || (!r.assigned_member_ids || r.assigned_member_ids.length === 0);
    },

    _rewardsAvailableToMember(memberId) {
        const showInactive = this._showRecentlyRedeemed;
        return (this._rewards || []).filter(r => {
            // Active: always include if assigned
            if (r.is_active) {
                if (this._isAnyoneReward(r)) return true;
                return (r.assigned_member_ids || []).includes(memberId);
            }
            // Inactive (one-time redeemed): include only when toggle is on
            // AND this member actually redeemed it recently
            if (!showInactive) return false;
            return this._redemptions.some(red =>
                red.reward_id === r.id && red.family_member_id === memberId
            );
        });
    },

    _latestPendingRedemption(rewardId, memberId) {
        const now = Date.now();
        return (this._redemptions || [])
            .filter(r => r.reward_id === rewardId
                && r.family_member_id === memberId
                && r.status === 'pending'
                && (now - new Date(r.redeemed_at).getTime()) < this.UNDO_WINDOW_MS)
            .sort((a, b) => new Date(b.redeemed_at) - new Date(a.redeemed_at))[0] || null;
    },

    _anyRedemptionForOneTime(rewardId, memberId) {
        // For one-time rewards that are now inactive — find the redemption to show "Redeemed"
        return (this._redemptions || [])
            .filter(r => r.reward_id === rewardId && r.family_member_id === memberId)
            .sort((a, b) => new Date(b.redeemed_at) - new Date(a.redeemed_at))[0] || null;
    },

    // =========================================================
    //  Assignments view (per-member redemption view)
    // =========================================================

    _renderAssignmentsView() {
        if (!this._rewards) return '';

        const members = this._familyMembers || [];

        const headerBar = `
            <div class="chores-date-nav">
                <div class="chores-date-label" style="min-width: 0;">All Rewards</div>
                <label class="toggle-row" style="margin-left: auto; gap: 10px;">
                    <span class="toggle-text">Show Recently Redeemed</span>
                    <label class="toggle">
                        <input type="checkbox" ${this._showRecentlyRedeemed ? 'checked' : ''}
                            onchange="RewardsPage._showRecentlyRedeemed = this.checked; App.renderPage()">
                        <span class="toggle-slider"></span>
                    </label>
                </label>
            </div>
        `;

        if (members.length === 0) {
            return `
                ${headerBar}
                <div class="empty-state">
                    <div class="empty-state-icon">🎁</div>
                    <div class="empty-state-text">No participating members.</div>
                    <div style="color: var(--text-muted); font-size: var(--font-size-sm); margin-top: 8px;">
                        Enable members in Options to see their available rewards.
                    </div>
                </div>
            `;
        }

        return headerBar + members.map(m => this._renderMemberSection(m)).join('');
    },

    _renderMemberSection(member) {
        const initial = (member.full_name || member.nickname || '?')[0].toUpperCase();
        const color = member.assigned_color || '#9ca3af';
        const name = member.nickname || (member.full_name || '').split(' ')[0] || 'Unknown';
        const points = this._pointsByMember[member.id] || 0;
        const rewards = this._rewardsAvailableToMember(member.id);
        const isExpanded = this._expandedMembers.has(member.id);

        return `
            <div class="assignment-section ${isExpanded ? 'expanded' : ''}">
                <div class="assignment-row" onclick="RewardsPage._toggleMemberExpand('${member.id}')">
                    <div class="assignment-avatar" style="background: ${color};">${this._escape(initial)}</div>
                    <div class="assignment-info">
                        <div class="assignment-name">${this._escape(name)}</div>
                    </div>
                    <div class="assignment-stats">
                        <div class="stat-pill stat-pill-points">
                            <span style="color: var(--accent);">★</span> ${points}
                        </div>
                        <div class="stat-pill">${rewards.length} reward${rewards.length === 1 ? '' : 's'}</div>
                    </div>
                    <div class="expand-chevron">${isExpanded ? '▾' : '▸'}</div>
                </div>
                ${isExpanded ? `
                    <div class="assignment-chores">
                        ${rewards.length > 0
                            ? rewards.map(r => this._renderRewardItem(r, member, points)).join('')
                            : '<div class="assignment-empty">No rewards available for this member.</div>'}
                    </div>
                ` : ''}
            </div>
        `;
    },

    _renderRewardItem(reward, member, memberPoints) {
        const cost = reward.point_cost || 0;
        const color = member.assigned_color || '#9ca3af';
        const typeBadge = reward.redemption_type === 'one_time'
            ? `<span class="type-badge one-time">One-time</span>`
            : `<span class="type-badge renewable">Renewable</span>`;

        const key = reward.id + member.id;
        const isToggling = this._redeeming.has(key);

        // Determine state
        const pendingRedemption = this._latestPendingRedemption(reward.id, member.id);
        const isOneTimeRedeemed = !reward.is_active;
        const recentOneTime = isOneTimeRedeemed ? this._anyRedemptionForOneTime(reward.id, member.id) : null;

        // Three visual states:
        //  A) Not redeemed yet + can afford → empty circle, clickable
        //  B) Not redeemed yet + can't afford → progress bar, dim, circle disabled
        //  C) Recently redeemed (within undo window, or one-time archived) → filled circle
        const isCompleted = !!pendingRedemption || isOneTimeRedeemed;
        const canAfford = memberPoints >= cost;
        const checkDisabled = isToggling || (!isCompleted && !canAfford);

        // "Redeemed X ago" label for one-time archived or pending redemption
        let redeemedLabel = '';
        if (pendingRedemption) {
            redeemedLabel = `<span style="color: var(--text-muted); margin-left: 8px;">· Redeemed ${this._timeAgo(pendingRedemption.redeemed_at)}</span>`;
        } else if (recentOneTime) {
            redeemedLabel = `<span style="color: var(--text-muted); margin-left: 8px;">· Redeemed ${this._timeAgo(recentOneTime.redeemed_at)}</span>`;
        }

        const progressPct = cost > 0 ? Math.min(100, Math.round((memberPoints / cost) * 100)) : 100;

        return `
            <div class="chore-item ${!canAfford && !isCompleted ? 'insufficient' : ''} ${isCompleted ? 'completed' : ''}">
                <div class="chore-item-emoji">${reward.emoji || '🎁'}</div>
                <div class="chore-item-body">
                    <div class="chore-item-title">${this._escape(reward.title)}</div>
                    <div class="chore-item-meta">
                        ${cost} pts · ${typeBadge}
                        ${!canAfford && !isCompleted ? `<span style="color: var(--text-muted); margin-left: 8px;">· Need ${cost - memberPoints} more</span>` : ''}
                        ${redeemedLabel}
                    </div>
                    ${!canAfford && !isCompleted ? `
                        <div class="reward-progress-track">
                            <div class="reward-progress-fill" style="width: ${progressPct}%; background: ${color};"></div>
                        </div>
                    ` : ''}
                </div>
                <button class="chore-check ${isCompleted ? 'checked' : ''}" style="--check-color: ${color};"
                    onclick="RewardsPage._toggleRedemption('${reward.id}', '${member.id}')"
                    ${checkDisabled ? 'disabled' : ''}
                    title="${isCompleted ? 'Undo' : (canAfford ? 'Redeem' : `Need ${cost - memberPoints} more points`)}">
                    ${isCompleted ? '✓' : ''}
                </button>
            </div>
        `;
    },

    _timeAgo(iso) {
        if (!iso) return '';
        const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
        if (diffSec < 60) return `${diffSec} sec ago`;
        if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`;
        if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} hr ago`;
        return `${Math.floor(diffSec / 86400)} days ago`;
    },

    _toggleMemberExpand(id) {
        if (this._expandedMembers.has(id)) this._expandedMembers.delete(id);
        else this._expandedMembers.add(id);
        App.renderPage();
    },

    async _toggleRedemption(rewardId, memberId) {
        const reward = this._rewards.find(r => r.id === rewardId);
        const member = this._allFamilyMembers.find(m => m.id === memberId);
        if (!reward || !member) return;

        const key = rewardId + memberId;
        if (this._redeeming.has(key)) return;

        const pending = this._latestPendingRedemption(rewardId, memberId);

        this._redeeming.add(key);
        App.renderPage();

        try {
            if (pending) {
                // Undo recent redemption
                const result = await DashieAuth.dbRequest('cancel_redemption', {
                    redemption_id: pending.id,
                });
                if (typeof result.total_points === 'number') {
                    this._pointsByMember[memberId] = result.total_points;
                } else if (typeof result.points_refunded === 'number') {
                    this._pointsByMember[memberId] = (this._pointsByMember[memberId] || 0) + result.points_refunded;
                }
                // Remove from local redemptions cache
                this._redemptions = this._redemptions.filter(r => r.id !== pending.id);
                // If a one-time reward was archived on redeem, we need to re-activate locally
                // The server may re-activate it on cancel_redemption; refetching is safest
                if (reward.redemption_type === 'one_time' && !reward.is_active) {
                    reward.is_active = true;
                }
            } else {
                // New redemption
                const result = await DashieAuth.dbRequest('redeem_reward', {
                    reward_id: rewardId,
                    family_member_id: memberId,
                });
                if (typeof result.total_points === 'number') {
                    this._pointsByMember[memberId] = result.total_points;
                } else {
                    this._pointsByMember[memberId] = Math.max(0, (this._pointsByMember[memberId] || 0) - reward.point_cost);
                }
                if (result.redemption) this._redemptions.unshift(result.redemption);
                // Mark one-time reward as inactive locally (server archives on redemption)
                if (reward.redemption_type === 'one_time') {
                    reward.is_active = false;
                }
            }
        } catch (e) {
            console.error('[RewardsPage] Toggle redemption failed:', e);
            Toast.error(Toast.friendly(e, 'update this redemption'));
        } finally {
            this._redeeming.delete(key);
            App.renderPage();
        }
    },

    // =========================================================
    //  List view (management)
    // =========================================================

    _renderListView() {
        if (!this._rewards || this._rewards.length === 0) {
            return `
                <div class="empty-state">
                    <div class="empty-state-icon">🎁</div>
                    <div class="empty-state-text">No rewards yet.</div>
                    <div style="color: var(--text-muted); font-size: var(--font-size-sm); margin-top: 8px;">
                        Click "+ Add Reward" to create one.
                    </div>
                </div>
            `;
        }

        const filtered = this._rewards.filter(r => {
            if (this._typeFilter === 'all') return true;
            return r.redemption_type === this._typeFilter;
        });

        const filterPills = `
            <div class="filter-pills">
                <button class="filter-pill ${this._typeFilter === 'all' ? 'active' : ''}"
                    onclick="RewardsPage._setFilter('all')">All</button>
                <button class="filter-pill ${this._typeFilter === 'renewable' ? 'active' : ''}"
                    onclick="RewardsPage._setFilter('renewable')">Renewable</button>
                <button class="filter-pill ${this._typeFilter === 'one_time' ? 'active' : ''}"
                    onclick="RewardsPage._setFilter('one_time')">One-Time</button>
            </div>
        `;

        const cards = filtered.map(r => this._renderRewardCard(r)).join('');
        return `
            ${filterPills}
            <div class="chore-list">${cards}</div>
            <p class="page-summary">${filtered.length} reward${filtered.length === 1 ? '' : 's'}</p>
        `;
    },

    _setFilter(filter) { this._typeFilter = filter; App.renderPage(); },

    _renderRewardCard(r) {
        const assigneeChips = this._renderAssigneeChips(r);
        const typeBadge = r.redemption_type === 'one_time'
            ? `<span class="type-badge one-time">One-time</span>`
            : `<span class="type-badge renewable">Renewable</span>`;

        return `
            <div class="chore-card" onclick="RewardsPage.edit('${r.id}')">
                <div class="chore-card-emoji">${r.emoji || '🎁'}</div>
                <div class="chore-card-body">
                    <div class="chore-card-title">${this._escape(r.title)}</div>
                    <div class="chore-card-meta">
                        ${typeBadge}
                        ${assigneeChips ? `<span class="chore-card-dot">·</span>${assigneeChips}` : ''}
                    </div>
                </div>
                <div class="chore-card-points">${r.point_cost ?? 0} pts</div>
            </div>
        `;
    },

    _renderAssigneeChips(r) {
        if (this._isAnyoneReward(r)) {
            return `<span class="assignee-chip assignee-anyone">Anyone</span>`;
        }
        const chips = (r.assigned_member_ids || []).slice(0, 3).map(id => {
            const m = (this._allFamilyMembers || []).find(m => m.id === id);
            if (!m) return '';
            const name = m.nickname || (m.full_name || '').split(' ')[0] || '?';
            const color = m.assigned_color || '#9ca3af';
            return `<span class="assignee-chip" style="background: ${color}1a; border-color: ${color}66; color: ${color};">${this._escape(name)}</span>`;
        }).join('');
        const extra = (r.assigned_member_ids || []).length > 3
            ? `<span class="assignee-chip">+${r.assigned_member_ids.length - 3}</span>`
            : '';
        return chips + extra;
    },

    // =========================================================
    //  Modal (create/edit)
    // =========================================================

    _initForm(reward) {
        return {
            title: reward?.title || '',
            emoji: reward?.emoji || '',
            pointCost: reward?.point_cost ?? 10,
            redemptionType: reward?.redemption_type || 'renewable',
            assignmentType: reward && this._isAnyoneReward(reward) ? 'anyone' : 'members',
            memberIds: [...(reward?.assigned_member_ids || [])],
        };
    },

    _renderModal() {
        const isNew = this._editingId === 'new';
        const f = this._form;
        const title = isNew ? 'Add Reward' : 'Edit Reward';

        return `
            <div class="modal-backdrop" onclick="RewardsPage._onBackdropClick(event)">
                <div class="modal" onclick="event.stopPropagation()">
                    <div class="modal-header">
                        <span class="modal-title">${title}</span>
                        <button class="modal-close" onclick="RewardsPage.closeEdit()">✕</button>
                    </div>
                    <div class="modal-body">
                        <div class="chore-field">
                            <label class="chore-field-label required">Reward Name</label>
                            <input type="text" class="chore-field-input" id="reward-f-title"
                                value="${this._escape(f.title)}" placeholder="e.g., Extra Screen Time" maxlength="100"
                                oninput="RewardsPage._form.title = this.value">
                        </div>
                        <div class="chore-field-row">
                            <div class="chore-field chore-field-icon">
                                <label class="chore-field-label">Icon</label>
                                <button type="button" class="emoji-field-btn ${f.emoji ? '' : 'empty'}"
                                    onclick="RewardsPage._openEmojiPicker()">
                                    ${this._escape(f.emoji || '➕')}
                                </button>
                            </div>
                            <div class="chore-field chore-field-points">
                                <label class="chore-field-label">Point Cost</label>
                                <input type="number" class="chore-field-input"
                                    value="${f.pointCost}" min="1" max="10000"
                                    oninput="RewardsPage._form.pointCost = parseInt(this.value) || 1">
                            </div>
                        </div>
                        <div class="chore-field">
                            <label class="chore-field-label required">Type</label>
                            <select class="chore-field-input"
                                oninput="RewardsPage._form.redemptionType = this.value">
                                <option value="renewable" ${f.redemptionType === 'renewable' ? 'selected' : ''}>Renewable — can redeem repeatedly</option>
                                <option value="one_time" ${f.redemptionType === 'one_time' ? 'selected' : ''}>One-time — archived after first redemption</option>
                            </select>
                        </div>
                        ${this._renderAssignField(f)}
                    </div>
                    <div class="modal-footer">
                        ${!isNew ? `
                            <button class="btn btn-danger btn-sm" onclick="RewardsPage._delete()"
                                ${this._saving || this._deleting ? 'disabled' : ''}
                                style="margin-right: auto;">
                                ${this._deleting ? 'Deleting…' : 'Delete'}
                            </button>
                        ` : ''}
                        <button class="btn btn-ghost" onclick="RewardsPage.closeEdit()" ${this._saving ? 'disabled' : ''}>Cancel</button>
                        <button class="btn btn-primary" onclick="RewardsPage._save()" ${this._saving ? 'disabled' : ''}>
                            ${this._saving ? 'Saving…' : 'Save'}
                        </button>
                    </div>
                </div>
            </div>
        `;
    },

    _renderAssignField(f) {
        const members = this._familyMembers || [];
        const isAnyone = f.assignmentType === 'anyone';
        const hasIndividuals = f.memberIds.length > 0;

        const allMemberIds = members.map(m => m.id);
        const kidIds = members.filter(m => m.relationship === 'child').map(m => m.id);
        const isEveryoneActive = !isAnyone && allMemberIds.length > 0 && allMemberIds.every(id => f.memberIds.includes(id));
        const isKidsActive = !isAnyone && kidIds.length > 0 && f.memberIds.length === kidIds.length && kidIds.every(id => f.memberIds.includes(id));

        const anyoneCircle = `
            <button type="button" class="member-circle anyone-circle ${isAnyone ? 'selected' : ''} ${hasIndividuals && !isAnyone ? 'dimmed' : ''}"
                onclick="RewardsPage._toggleAnyone()" title="Anyone can redeem">
                <div class="member-avatar anyone-avatar">
                    <span style="font-size: 18px;">👪</span>
                    ${isAnyone ? '<span class="check-badge">✓</span>' : ''}
                </div>
                <div class="member-label">Anyone</div>
            </button>
        `;

        const memberCircles = members.map(m => {
            const isSel = f.memberIds.includes(m.id);
            const name = m.nickname || (m.full_name || '').split(' ')[0] || 'Unknown';
            const initial = (m.full_name || m.nickname || '?')[0].toUpperCase();
            const color = m.assigned_color || '#999';
            return `
                <button type="button" class="member-circle ${isSel ? 'selected' : ''} ${isAnyone ? 'dimmed' : ''}"
                    onclick="RewardsPage._toggleMember('${m.id}')" title="${this._escape(name)}">
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
                    <label class="chore-field-label required">Who Can Redeem</label>
                    <div class="quick-selectors">
                        <button type="button" class="quick-btn ${isEveryoneActive ? 'active' : ''}"
                            onclick="RewardsPage._selectAllMembers()">Everyone</button>
                        <button type="button" class="quick-btn ${isKidsActive ? 'active' : ''}"
                            onclick="RewardsPage._selectKids()">Kids</button>
                        <button type="button" class="clear-link" onclick="RewardsPage._clearMembers()">Clear</button>
                    </div>
                </div>
                <div class="member-row">
                    ${anyoneCircle}
                    ${memberCircles || '<span style="color: var(--text-muted); font-size: var(--font-size-sm); padding: 12px;">No participating members. Enable some in Options.</span>'}
                </div>
            </div>
        `;
    },

    _onBackdropClick(event) { if (event.target === event.currentTarget) this.closeEdit(); },

    _openEmojiPicker() {
        EmojiPicker.open(null, (emoji) => {
            this._form.emoji = emoji;
            App.renderPage();
        });
    },

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

    _buildPayload() {
        const f = this._form;
        const payload = {
            title: f.title.trim(),
            emoji: f.emoji.trim() || '🎁',
            point_cost: f.pointCost,
            redemption_type: f.redemptionType,
        };
        if (f.assignmentType === 'anyone') {
            payload.assignment_type = 'anyone';
            payload.assigned_member_ids = [];
        } else {
            payload.assignment_type = 'individual';
            payload.assigned_member_ids = f.memberIds;
        }
        return payload;
    },

    async _save() {
        const f = this._form;

        if (!f.title.trim()) { Toast.error('Please enter a reward name'); return; }
        if (!f.pointCost || f.pointCost < 1) { Toast.error('Please enter a point cost of at least 1'); return; }
        if (f.assignmentType === 'members' && f.memberIds.length === 0) {
            Toast.error('Please select at least one member or choose "Anyone"');
            return;
        }

        this._saving = true;
        App.renderPage();

        try {
            const payload = this._buildPayload();
            if (this._editingId === 'new') {
                const result = await DashieAuth.dbRequest('create_reward', payload);
                const newReward = result.reward || result.data;
                if (newReward) this._rewards.push(newReward);
            } else {
                const result = await DashieAuth.dbRequest('update_reward', {
                    reward_id: this._editingId,
                    updates: payload,
                });
                const updated = result.reward || result.data;
                if (updated) {
                    const i = this._rewards.findIndex(r => r.id === this._editingId);
                    if (i >= 0) this._rewards[i] = updated;
                }
            }
            this._editingId = null;
            this._form = null;
        } catch (e) {
            console.error('[RewardsPage] Save failed:', e);
            Toast.error(Toast.friendly(e, 'save this reward'));
        } finally {
            this._saving = false;
            App.renderPage();
        }
    },

    async _delete() {
        const reward = this._rewards.find(r => r.id === this._editingId);
        if (!reward) return;
        if (!confirm(`Delete "${reward.title}"?`)) return;

        this._deleting = true;
        App.renderPage();

        try {
            await DashieAuth.dbRequest('delete_reward', {
                reward_id: this._editingId,
                hard_delete: false,
            });
            this._rewards = this._rewards.filter(r => r.id !== this._editingId);
            this._editingId = null;
            this._form = null;
        } catch (e) {
            console.error('[RewardsPage] Delete failed:', e);
            Toast.error(Toast.friendly(e, 'delete this reward'));
        } finally {
            this._deleting = false;
            App.renderPage();
        }
    },

    edit(id) {
        const reward = this._rewards.find(r => r.id === id);
        this._form = this._initForm(reward);
        this._editingId = id;
        App.renderPage();
    },

    add() {
        this._form = this._initForm(null);
        this._editingId = 'new';
        App.renderPage();
        setTimeout(() => {
            const el = document.getElementById('reward-f-title');
            if (el) el.focus();
        }, 50);
    },

    closeEdit() {
        this._editingId = null;
        this._form = null;
        App.renderPage();
    },

    // =========================================================
    //  Utilities
    // =========================================================

    _escape(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    },
};
