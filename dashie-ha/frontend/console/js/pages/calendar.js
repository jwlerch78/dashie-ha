/* ============================================================
   Calendar Page — Iteration 1A

   Shows the user's connected calendar accounts and lets them
   toggle which calendars are active. Reads:

   - jwt-auth.list_accounts          → connected provider accounts
   - database-operations.list_cached_calendars → calendar names/colors
                                       resolved with user overrides
                                       and active flag

   Writes:
   - database-operations.save_calendar_config → toggle active calendars
                                                 (debounced 500ms)
   - jwt-auth.remove_account         → unlink an account

   Add Account is a placeholder in 1A — full OAuth flows land in 1C.
   ============================================================ */

const CalendarPage = {
    // ── State ───────────────────────────────────────────────
    _accounts: null,                // [{ provider, account_type, email, ..., auth_invalid, _caldav? }]
    _calendars: null,               // resolved-name calendar list from cache
    _members: null,                 // family members (for assignment avatars)
    _activeIds: null,               // Set of prefixed_id currently active (local edit set)
    _hiddenIds: null,               // Set of prefixed_id hidden from the picker
    _showHidden: false,             // when true, hidden calendars render ghosted inline
    _collapsedAccountKeys: null,    // Set of `${provider}-${account_type}` for collapsed groups
    _editingPrefixedId: null,       // prefixed_id of the calendar whose edit panel is open
    _settings: null,                // full user_settings tree — backs the Calendar Options section
    _loading: false,
    _error: null,
    _saving: false,
    _saveTimer: null,               // active_calendar_ids save debounce
    _hideSaveTimer: null,           // hidden_calendar_ids save debounce
    _removingKey: null,             // `${provider}-${account_type}` while remove in flight
    _syncRegistered: false,         // one-shot guard so we only wire SettingsSync once

    SAVE_DEBOUNCE_MS: 500,

    // ── Render entry ────────────────────────────────────────
    render() {
        const modalHtml = (typeof CalendarAddModal !== 'undefined' && CalendarAddModal._state)
            ? CalendarAddModal.render()
            : '';

        if (!this._accounts && !this._loading && !this._error) {
            this._fetch();
            return this._renderLoading() + modalHtml;
        }
        if (this._loading && !this._accounts) return this._renderLoading() + modalHtml;
        if (this._error && !this._accounts) return this._renderError() + modalHtml;

        if (!this._accounts.length) return this._renderEmpty() + modalHtml;

        // Initialize collapse set on first real render
        if (!this._collapsedAccountKeys) this._collapsedAccountKeys = new Set();

        return this._renderAccountsAndCalendars() + modalHtml;
    },

    topBarTitle() { return 'Calendar'; },
    topBarSubtitle() {
        if (!this._accounts) return '';
        const a = this._accounts.length;
        const active = (this._activeIds && this._activeIds.size) || 0;
        const hidden = (this._hiddenIds && this._hiddenIds.size) || 0;
        const parts = [`${a} account${a === 1 ? '' : 's'}`, `${active} active`];
        if (hidden) parts.push(`${hidden} hidden`);
        let html = parts.join(' · ');
        // Show hidden toggle sits inline immediately after the counts so
        // it reads as "8 hidden  [Show]" rather than living off in the
        // action bar. Underline + accent so it reads as a control rather
        // than continuation of the dimmed subtitle text.
        if (hidden > 0) {
            const label = this._showHidden ? 'Hide' : 'Show';
            html += ` <button onclick="CalendarPage.toggleShowHidden()" style="background: none; border: none; padding: 0 0 0 8px; cursor: pointer; color: var(--accent, #ff9500); text-decoration: underline; font: inherit;">${label}</button>`;
        }
        return html;
    },
    topBarActions() {
        return `<button class="btn btn-primary" onclick="CalendarPage.add()">+ Add Account</button>`;
    },

    /**
     * Register SettingsSync consumers for the 7 calendar kinds. Every
     * one of them maps to "refetch + re-render" because list_cached_calendars
     * resolves all the per-calendar fields (active, hidden, display_name,
     * color, assignment, tags) server-side — one round-trip recovers all
     * states. calendar_accounts also requires re-fetching list_accounts
     * (provider account added/removed). Idempotent via _syncRegistered.
     * @private
     */
    _registerSyncOnce() {
        if (this._syncRegistered) return;
        if (!window.SettingsSync || typeof window.SettingsSync.register !== 'function') return;
        this._syncRegistered = true;

        const refetch = async () => {
            // Skip if the page isn't mounted right now — when the user
            // navigates away, _accounts may still be set but we don't want
            // background refetches happening for an unrendered page. App
            // will re-render on navigate-back anyway.
            if (typeof App !== 'undefined' && App._currentPage && App._currentPage !== 'calendar') {
                return;
            }
            await this._fetch();
        };

        const kinds = [
            'active_calendar_ids',
            'hidden_calendar_ids',
            'calendar_display_names',
            'calendar_color_overrides',
            'calendar_assignment_types',
            'calendar_tags',
            'calendar_metadata',
            'calendar_accounts',
            // Calendar Options (startWeekOn / writeAccess) live in user_settings,
            // so a dashboard-side change broadcasts as 'account_settings'.
            'account_settings'
        ];
        kinds.forEach(k => window.SettingsSync.register(k, refetch));
        console.log('[CalendarPage] Registered ' + kinds.length + ' SettingsSync consumers');
    },

    // ── Data fetching ───────────────────────────────────────
    async refresh() { await this._fetch(); },

    async _fetch() {
        // First-call hook: register SettingsSync consumers so subsequent
        // edits on another surface (dashboard) trigger a re-fetch here.
        // Self-echoes are filtered upstream by the manager via the
        // source_client_id console-auth injects, so a save from this
        // tab doesn't trigger its own refresh.
        this._registerSyncOnce();

        this._loading = true;
        this._error = null;
        try {
            const [accountsRes, caldavRes, calendarsRes, membersRes, settingsRes] = await Promise.all([
                DashieAuth.authRequest({ operation: 'list_accounts' }),
                // CalDAV (Apple iCloud) accounts live in a separate table from
                // user_auth_tokens, so jwt-auth.list_accounts misses them. Pull
                // them from caldav-proxy and merge below. Failure here is
                // non-fatal — the page still works without CalDAV accounts.
                DashieAuth.edgeFunctionRequest('caldav-proxy', { operation: 'list_accounts' })
                    .catch(e => {
                        console.warn('[CalendarPage] CalDAV accounts fetch failed:', e.message);
                        return { accounts: [] };
                    }),
                DashieAuth.dbRequest('list_cached_calendars', {}),
                // Family members are needed to render assignment avatars; if
                // the family fetch fails we still show the rest of the page.
                DashieAuth.dbRequest('list_family_members', {}).catch(e => {
                    console.warn('[CalendarPage] family fetch failed:', e.message);
                    return { members: [] };
                }),
                // Backs the Calendar Options section. Non-fatal: on failure the
                // section stays hidden (render(null) → '') rather than showing
                // pickers that would lie about the stored value.
                DashieAuth.loadUserSettings().catch(e => {
                    console.warn('[CalendarPage] user settings fetch failed:', e.message);
                    return null;
                }),
            ]);

            // Normalize CalDAV accounts to the same shape as jwt-auth's
            // accounts list. CalDAV's last_error becomes auth_invalid.
            const caldavAccounts = (caldavRes.accounts || []).map(a => ({
                provider: a.provider === 'icloud' ? 'caldav' : (a.provider || 'caldav'),
                account_type: a.account_type,
                email: a.email,
                display_name: null,
                expires_at: null,
                scopes: null,
                is_active: !a.last_error,
                auth_invalid: !!a.last_error,
                auth_invalid_reason: a.last_error || null,
                _caldav: true,  // marker so remove path knows to call caldav-proxy
            }));

            this._accounts = [...(accountsRes.accounts || []), ...caldavAccounts];
            this._calendars = calendarsRes.calendars || [];
            this._members = membersRes.members || membersRes.data || [];
            this._settings = settingsRes || null;
            this._activeIds = new Set(
                this._calendars.filter(c => c.is_active).map(c => c.prefixed_id)
            );
            this._hiddenIds = new Set(
                this._calendars.filter(c => c.is_hidden).map(c => c.prefixed_id)
            );

            // Sort accounts: protected first (Google primary, linked parents),
            // then by provider, then alphabetically by email.
            this._accounts.sort((a, b) => {
                const pa = this._isProtectedAccount(a), pb = this._isProtectedAccount(b);
                if (pa !== pb) return pa ? -1 : 1;
                if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
                return (a.email || '').localeCompare(b.email || '');
            });
        } catch (e) {
            console.error('[CalendarPage] Fetch failed:', e);
            this._error = e.message;
        } finally {
            this._loading = false;
            App.renderPage();
        }
    },

    /**
     * Mirrors the dashboard's protected-account rule
     * (calendar-account-handler.js:820-832): only the Google primary
     * account (the one the user signed in with) and any linked-parent
     * accounts can't be removed. Microsoft "primary" is just MS's first-
     * account slot and IS removable. Apple/HA primaries similarly removable.
     */
    _isProtectedAccount(a) {
        if (!a || !a.account_type) return false;
        if (a.provider === 'google' && a.account_type === 'primary') return true;
        if (typeof a.account_type === 'string' && a.account_type.startsWith('linked_')) return true;
        return false;
    },

    _retry() {
        this._error = null;
        this._accounts = null;
        this._calendars = null;
        App.renderPage();
    },

    // ── Render: states ──────────────────────────────────────
    _renderLoading() {
        return `
            <div style="display: flex; align-items: center; justify-content: center; padding: 60px;">
                <div style="text-align: center;">
                    <div style="width: 32px; height: 32px; border: 3px solid #e5e7eb; border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 12px;"></div>
                    <div style="color: var(--text-secondary); font-size: var(--font-size-sm);">Loading calendar…</div>
                </div>
                <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
            </div>
        `;
    },

    _renderError() {
        return `
            <div class="card">
                <div class="card-body" style="color: var(--status-error);">
                    <strong>Failed to load calendar:</strong> ${this._escape(this._error)}
                    <div style="margin-top: 12px;">
                        <button class="btn btn-secondary btn-sm" onclick="CalendarPage._retry()">Retry</button>
                    </div>
                </div>
            </div>
        `;
    },

    _renderEmpty() {
        return `
            <div class="empty-state">
                <div class="empty-state-icon">📅</div>
                <div class="empty-state-text">No calendar accounts connected.</div>
                <div style="color: var(--text-muted); font-size: var(--font-size-sm); margin-top: 8px;">
                    Click "+ Add Account" to connect Google, Microsoft, or Apple.
                </div>
            </div>
        `;
    },

    // ── Render: consolidated Accounts + Calendars ───────────
    _renderAccountsAndCalendars() {
        // Build calendar map per account, filtering out hidden unless toggled.
        const visibleCalendars = this._showHidden
            ? this._calendars
            : this._calendars.filter(c => !this._hiddenIds.has(c.prefixed_id));
        const calsByAccount = new Map();
        for (const cal of visibleCalendars) {
            const key = `${cal.provider}-${cal.account_type}`;
            if (!calsByAccount.has(key)) calsByAccount.set(key, []);
            calsByAccount.get(key).push(cal);
        }
        // Sort calendars within each account: active first, then primary,
        // then alphabetical — keeps the ones the user actually uses on top.
        for (const list of calsByAccount.values()) {
            list.sort((a, b) => {
                const aa = this._activeIds.has(a.prefixed_id) ? 1 : 0;
                const bb = this._activeIds.has(b.prefixed_id) ? 1 : 0;
                if (aa !== bb) return bb - aa;
                if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
                return (a.summary || '').localeCompare(b.summary || '');
            });
        }

        const sections = this._accounts.map(a => {
            const calendars = calsByAccount.get(this._accountKey(a)) || [];
            return this._renderAccountWithCalendars(a, calendars);
        }).join('');

        const savingNote = this._saving
            ? `<div style="color: var(--text-muted); font-size: var(--font-size-sm); margin-top: 8px;">Saving…</div>`
            : '';

        return `
            <div class="section-header" style="margin-top: 0;">Accounts</div>
            ${sections}
            ${CalendarOptions.render(this._settings)}
            ${savingNote}
        `;
    },

    /**
     * Renders one account group: a header (chevron + provider icon + email +
     * badges + remove button) followed by the account's calendars when
     * expanded. The whole header is a click target for collapse toggling;
     * the Remove button is event-stopped so it doesn't bubble.
     */
    _renderAccountWithCalendars(a, calendars) {
        const key = this._accountKey(a);
        const collapsed = this._collapsedAccountKeys.has(key);
        const removing = this._removingKey === key;
        const protectedAcct = this._isProtectedAccount(a);
        const activeCount = calendars.filter(c => this._activeIds.has(c.prefixed_id)).length;
        const totalCount = (this._calendars || []).filter(c => c.provider === a.provider && c.account_type === a.account_type).length;

        const reauthBadge = a.auth_invalid
            ? `<span class="list-item-badge" style="background: var(--status-error-bg, #fee); color: var(--status-error, #c00);">Reauth required</span>`
            : '';
        const protectedBadge = protectedAcct
            ? `<span class="list-item-badge" style="background: var(--bg-muted, #f3f4f6); color: var(--text-muted);">${a.account_type === 'primary' ? 'Sign-in account' : 'Linked'}</span>`
            : '';
        const rightSlot = protectedAcct
            ? protectedBadge
            : (removing
                ? `<span style="color: var(--text-muted); font-size: var(--font-size-sm);">Removing…</span>`
                : `<button class="btn btn-ghost btn-sm"
                           onclick="event.stopPropagation(); CalendarPage._removeClick('${this._escape(a.provider)}','${this._escape(a.account_type)}')">Remove</button>`);
        const chevron = collapsed ? '▸' : '▾';
        const countBadge = `<span style="color: var(--text-muted); font-size: 12px; margin-left: 8px;">${activeCount} of ${totalCount} active</span>`;

        // Calendar rows (with edit panel inline below the editing one)
        let calendarsHtml = '';
        if (!collapsed) {
            if (calendars.length === 0) {
                calendarsHtml = `
                    <div style="padding: 12px 16px; color: var(--text-muted); font-size: 13px;">
                        ${a.auth_invalid
                            ? `Reauthorize this account on the ${BRAND.productName} dashboard to load its calendars.`
                            : `No calendars synced yet. Open the ${BRAND.productName} dashboard to populate them.`}
                    </div>
                `;
            } else {
                calendarsHtml = calendars.map(cal => {
                    let row = this._renderCalendarRow(cal);
                    if (this._editingPrefixedId === cal.prefixed_id) {
                        row += CalendarEditPanel.render(cal, this._members);
                    }
                    return row;
                }).join('');
            }
        }

        return `
            <div class="account-group" style="border: 1px solid var(--border, #e5e7eb); border-radius: 8px; margin-bottom: 12px; overflow: hidden;">
                <div class="account-header"
                     onclick="CalendarPage.toggleAccountCollapse('${this._escape(key)}')"
                     style="display: flex; align-items: center; gap: 12px; padding: 12px 16px; cursor: pointer; background: var(--bg-card, #fff);">
                    <span style="font-size: 38px; line-height: 1; color: var(--text-muted); width: 28px; text-align: center; flex-shrink: 0;">${chevron}</span>
                    ${this._providerIcon(a.provider)}
                    <div style="flex: 1; min-width: 0;">
                        <div class="list-item-title">${this._escape(a.email || '(unknown)')}${countBadge}</div>
                        <div class="list-item-subtitle">${this._providerLabel(a.provider)}</div>
                    </div>
                    ${reauthBadge}
                    ${rightSlot}
                </div>
                ${!collapsed ? `<div class="account-calendars" style="border-top: 1px solid var(--border, #e5e7eb); padding-left: 56px;">${calendarsHtml}</div>` : ''}
            </div>
        `;
    },

    _renderCalendarRow(cal) {
        const checked = this._activeIds.has(cal.prefixed_id);
        const hidden = this._hiddenIds.has(cal.prefixed_id);
        const color = cal.background_color || '#9ca3af';
        // Source name is intentionally NOT shown on the main calendar list
        // — Google calendar source names like "c_a1b2c3@group.calendar..."
        // are very long and overwhelm the row. The source still appears in
        // the edit panel where it's actionable (clear override → revert).
        const subParts = [];
        if (cal.is_primary) subParts.push('primary');
        const assignmentLabel = this._assignmentLabel(cal);
        if (assignmentLabel) subParts.push(assignmentLabel);
        const subtitle = subParts.length
            ? `<div class="list-item-subtitle">${subParts.join(' · ')}</div>`
            : '';
        const tagChips = this._renderTagChips(cal.tags);
        const assignmentIndicator = this._renderAssignmentIndicator(cal);
        const rowStyle = hidden ? 'cursor: pointer; opacity: 0.5;' : 'cursor: pointer;';
        // Hiding an active calendar would be confusing — events still feed
        // the dashboard but the user can't see/manage the calendar in the
        // picker. Active and hidden are mutually exclusive at the UX level:
        // the eye button only appears on inactive rows. To hide an active
        // calendar, deactivate it first.
        const eyeButton = checked
            ? ''
            : `<button class="btn btn-ghost btn-sm" style="padding: 4px 6px;"
                       onclick="event.stopPropagation(); CalendarPage.toggleHidden('${this._escape(cal.prefixed_id)}')"
                       aria-label="${hidden ? 'Show' : 'Hide'} calendar"
                       title="${hidden ? 'Show in picker' : 'Hide from picker'}">
                   ${this._renderEyeIcon(hidden)}
               </button>`;
        const editing = this._editingPrefixedId === cal.prefixed_id;
        const editButton = `<button class="btn btn-ghost btn-sm" style="padding: 4px 6px;"
                onclick="event.stopPropagation(); CalendarPage.editCalendar('${this._escape(cal.prefixed_id)}')"
                aria-label="${editing ? 'Close edit panel' : 'Edit calendar'}"
                title="${editing ? 'Close edit panel' : 'Edit calendar'}">
                ${this._renderEditIcon(editing)}
            </button>`;
        // The whole row toggles active state. Eye and edit buttons use event-stop
        // so they don't bubble up to the active toggle.
        return `
            <div class="checkbox-row ${checked ? 'checked' : ''}"
                 onclick="CalendarPage.toggleCalendar('${this._escape(cal.prefixed_id)}')"
                 style="${rowStyle}">
                <div class="checkbox-icon"></div>
                <span class="color-dot" style="background: ${this._escape(color)};"></span>
                <div class="list-item-content" style="flex: 1; min-width: 0;">
                    <div class="checkbox-label" style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px;">
                        <span>${this._escape(cal.summary)}</span>
                        ${tagChips}
                    </div>
                    ${subtitle}
                </div>
                ${assignmentIndicator}
                ${eyeButton}
                ${editButton}
            </div>
        `;
    },

    /**
     * Returns the assignment indicator on the right of a calendar row.
     * Mirrors dashboard's calendar-assignment-handler.renderCalendarIndicator:
     *   1. If members are assigned → avatar circles
     *   2. If assignment_type === 'informational' → ℹ️
     *   3. Otherwise (family default) → 👥
     */
    _renderAssignmentIndicator(cal) {
        const assigned = this._assignedMembersFor(cal.prefixed_id);
        if (assigned.length > 0) {
            const avatars = assigned.slice(0, 4).map(m => {
                const initial = (m.full_name || '?').charAt(0).toUpperCase();
                const bg = m.assigned_color || '#9ca3af';
                return `<div class="member-avatar" title="${this._escape(m.full_name || '')}" style="width: 22px; height: 22px; border-radius: 50%; background: ${this._escape(bg)}; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; color: white; flex-shrink: 0; margin-left: -4px; border: 2px solid var(--bg-card, #fff);">${initial}</div>`;
            }).join('');
            const overflow = assigned.length > 4
                ? `<div style="font-size: 11px; color: var(--text-muted); margin-left: 4px;">+${assigned.length - 4}</div>`
                : '';
            return `<div style="display: flex; align-items: center; padding-left: 4px;">${avatars}${overflow}</div>`;
        }
        if (cal.assignment_type === 'informational') {
            return `<span class="calendar-type-icon" title="Informational" style="font-size: 18px;">ℹ️</span>`;
        }
        return `<span class="calendar-type-icon" title="Family" style="font-size: 18px;">👥</span>`;
    },

    /**
     * Short text label for the calendar's assignment type, shown in subtext.
     * Returns null when there's nothing meaningful to show (default 'family'
     * with no member overrides) so the subtext doesn't clutter.
     */
    _assignmentLabel(cal) {
        const assigned = this._assignedMembersFor(cal.prefixed_id);
        if (assigned.length === 1) return `assigned to ${this._escape(assigned[0].full_name || 'member')}`;
        if (assigned.length > 1) return `assigned to ${assigned.length} members`;
        if (cal.assignment_type === 'informational') return 'informational';
        return null;
    },

    _assignedMembersFor(prefixedId) {
        if (!Array.isArray(this._members)) return [];
        return this._members.filter(m => Array.isArray(m.assigned_calendars) && m.assigned_calendars.includes(prefixedId));
    },

    _renderTagChips(tags) {
        if (!Array.isArray(tags) || tags.length === 0) return '';
        return tags.map(t => `<span class="calendar-tag-pill" style="background: var(--bg-muted, #f3f4f6); color: var(--text-secondary); padding: 1px 8px; border-radius: 10px; font-size: 11px; line-height: 1.4;">${this._escape(t)}</span>`).join('');
    },

    _renderEyeIcon(isHidden) {
        if (isHidden) {
            return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
        }
        return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    },

    /** Pencil icon for edit; switches to × when the panel is already open */
    _renderEditIcon(active) {
        if (active) {
            return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
        }
        return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    },

    // ── Operations: Add ──────────────────────────────────────
    add() {
        if (typeof CalendarAddModal === 'undefined') {
            Toast.error('Add Account modal not loaded.');
            return;
        }
        CalendarAddModal.open();
    },

    /**
     * Called by CalendarAddModal after a successful add. Drops the cached
     * accounts/calendars so the next render kicks a fresh fetch.
     */
    _refetchAfterAdd() {
        this._accounts = null;
        this._calendars = null;
        this._members = null;
        this._activeIds = null;
        this._hiddenIds = null;
        App.renderPage();
    },

    /**
     * Persists the predicted primary-calendar ID into active_calendar_ids
     * so that newly-added accounts have at least one calendar showing on
     * the dashboard immediately, without the user having to come back and
     * toggle it on. Called by CalendarAddModal after a successful add.
     *
     * The metadata cache won't have the row yet (dashboard's next fetch
     * populates it), so the calendar won't appear in the Console UI until
     * then — but the active flag is in place, so when it does appear it's
     * already enabled.
     */
    async _addActiveCalendar(prefixedId) {
        if (!prefixedId) return;
        if (!this._activeIds) this._activeIds = new Set();
        if (this._activeIds.has(prefixedId)) return;  // already there
        this._activeIds.add(prefixedId);
        await DashieAuth.dbRequest('save_calendar_config', {
            active_calendar_ids: [...this._activeIds],
        });
    },

    // ── Operations: Remove account ──────────────────────────
    async _removeClick(provider, accountType) {
        const account = this._accounts.find(a => a.provider === provider && a.account_type === accountType);
        if (account && this._isProtectedAccount(account)) {
            // The button is hidden for protected rows, but a stale click handler
            // could still fire — fall back to the same warning the dashboard shows.
            const why = account.account_type === 'primary'
                ? `This is your ${BRAND.productName} sign-in account; removing it requires signing out completely.`
                : 'This is a linked family member account; unlink them from Settings → Family to remove it.';
            Toast.info(why);
            return;
        }
        const label = account ? (account.email || `${provider}:${accountType}`) : `${provider}:${accountType}`;
        const ok = await ConfirmModal.confirm({
            title: 'Remove calendar account',
            message: `Remove ${label}?\n\nCalendars from this account will stop appearing on ${BRAND.productName}.`,
            confirmLabel: 'Remove',
            danger: true,
        });
        if (!ok) return;
        this._doRemove(provider, accountType);
    },

    async _doRemove(provider, accountType) {
        this._removingKey = `${provider}-${accountType}`;
        App.renderPage();
        try {
            const account = this._accounts.find(a => a.provider === provider && a.account_type === accountType);
            if (account && account._caldav) {
                // CalDAV (Apple iCloud) accounts live in user_caldav_accounts
                // and are removed via caldav-proxy, not jwt-auth.
                await DashieAuth.edgeFunctionRequest('caldav-proxy', {
                    operation: 'delete_account',
                    accountType,
                });
            } else {
                // jwt-auth's body destructuring uses snake_case (account_type),
                // not camelCase. Sending camelCase here makes account_type
                // undefined server-side, which then falls through to the
                // 'primary' default — so we'd silently delete the WRONG slot
                // (e.g. clicking Remove on google.account2 nuked google.primary).
                await DashieAuth.authRequest({
                    operation: 'remove_account',
                    provider,
                    account_type: accountType,
                });
            }
            // Drop the account locally + drop any of its calendars from the active set
            this._accounts = this._accounts.filter(a => !(a.provider === provider && a.account_type === accountType));
            this._calendars = this._calendars.filter(c => !(c.provider === provider && c.account_type === accountType));
            for (const id of [...this._activeIds]) {
                if (!this._calendars.some(c => c.prefixed_id === id)) this._activeIds.delete(id);
            }
            // Persist the trimmed active set so the dashboard doesn't re-render stale entries
            this._scheduleSave(/*immediate=*/true);
        } catch (e) {
            console.error('[CalendarPage] Remove account failed:', e);
            Toast.error(`Failed to remove account: ${e.message}`);
        } finally {
            this._removingKey = null;
            App.renderPage();
        }
    },

    // ── Operations: Toggle calendar ─────────────────────────
    toggleCalendar(prefixedId) {
        if (this._activeIds.has(prefixedId)) {
            this._activeIds.delete(prefixedId);
        } else {
            this._activeIds.add(prefixedId);
            // Activating implicitly un-hides — keeps active/hidden mutually
            // exclusive without surprising the user with a separate prompt.
            if (this._hiddenIds.has(prefixedId)) {
                this._hiddenIds.delete(prefixedId);
                this._scheduleHiddenSave();
            }
        }
        this._scheduleSave();
        App.renderPage();
    },

    // ── Operations: Hide/show calendar ──────────────────────
    toggleHidden(prefixedId) {
        // Defense-in-depth: the eye button is suppressed for active rows in
        // _renderCalendarRow, but a stale onclick or programmatic call could
        // still land here. Active calendars feed the dashboard; hiding them
        // would be confusing. Deactivate first.
        if (this._activeIds.has(prefixedId) && !this._hiddenIds.has(prefixedId)) {
            Toast.info('Deactivate this calendar before hiding it.');
            return;
        }
        if (this._hiddenIds.has(prefixedId)) {
            this._hiddenIds.delete(prefixedId);
        } else {
            this._hiddenIds.add(prefixedId);
        }
        this._scheduleHiddenSave();
        App.renderPage();
    },

    toggleShowHidden() {
        this._showHidden = !this._showHidden;
        App.renderPage();
    },

    /**
     * Open / close the inline edit panel for a calendar. Clicking edit on
     * the calendar that's already being edited closes the panel.
     */
    editCalendar(prefixedId) {
        if (this._editingPrefixedId === prefixedId) {
            this._editingPrefixedId = null;
        } else {
            this._editingPrefixedId = prefixedId;
            // Make sure the host account is expanded so the panel is visible.
            const cal = this._calendars.find(c => c.prefixed_id === prefixedId);
            if (cal) this._collapsedAccountKeys.delete(`${cal.provider}-${cal.account_type}`);
        }
        App.renderPage();
    },

    toggleAccountCollapse(key) {
        if (!this._collapsedAccountKeys) this._collapsedAccountKeys = new Set();
        if (this._collapsedAccountKeys.has(key)) {
            this._collapsedAccountKeys.delete(key);
        } else {
            this._collapsedAccountKeys.add(key);
            // If we're hiding the account that holds the open edit panel,
            // close the panel — otherwise it'd reopen on next expand and
            // surprise the user.
            if (this._editingPrefixedId) {
                const cal = this._calendars.find(c => c.prefixed_id === this._editingPrefixedId);
                if (cal && `${cal.provider}-${cal.account_type}` === key) {
                    this._editingPrefixedId = null;
                }
            }
        }
        App.renderPage();
    },

    _scheduleHiddenSave() {
        if (this._hideSaveTimer) {
            clearTimeout(this._hideSaveTimer);
        }
        this._hideSaveTimer = setTimeout(() => this._commitHiddenSave(), this.SAVE_DEBOUNCE_MS);
    },

    async _commitHiddenSave() {
        this._hideSaveTimer = null;
        try {
            await DashieAuth.dbRequest('save_hidden_calendars', {
                hidden_calendar_ids: [...this._hiddenIds],
            });
        } catch (e) {
            console.error('[CalendarPage] Save hidden calendars failed:', e);
            Toast.error(`Failed to save hide state: ${e.message}`);
        }
    },

    _scheduleSave(immediate = false) {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        const delay = immediate ? 0 : this.SAVE_DEBOUNCE_MS;
        this._saveTimer = setTimeout(() => this._commitSave(), delay);
    },

    async _commitSave() {
        this._saveTimer = null;
        this._saving = true;
        App.renderPage();
        try {
            await DashieAuth.dbRequest('save_calendar_config', {
                active_calendar_ids: [...this._activeIds],
            });
        } catch (e) {
            console.error('[CalendarPage] Save active calendars failed:', e);
            Toast.error(`Failed to save calendar selection: ${e.message}`);
        } finally {
            this._saving = false;
            App.renderPage();
        }
    },

    // ── Helpers ────────────────────────────────────────────
    _accountKey(a) { return `${a.provider}-${a.account_type}`; },

    _providerLabel(provider) {
        switch (provider) {
            case 'google': return 'Google';
            case 'microsoft': return 'Microsoft';
            case 'caldav': return 'Apple iCloud';
            case 'ha': return 'Home Assistant';
            default: return this._capitalize(provider);
        }
    },

    /**
     * Returns the full <div class="list-item-icon"> markup for an account
     * row. Google uses its 4-color brand "G" (matches the login screen).
     * Apple uses the bitten-apple glyph in white on black. Microsoft / HA /
     * other providers fall back to a colored circle with a letter.
     */
    _providerIcon(provider) {
        if (provider === 'google') {
            return `
                <div class="list-item-icon" style="background: #ffffff; border: 1px solid var(--border, #e5e7eb);">
                    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
                        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                    </svg>
                </div>`;
        }
        if (provider === 'caldav') {
            return `
                <div class="list-item-icon" style="background: #000000;">
                    <svg width="18" height="18" viewBox="0 0 384 512" fill="#ffffff" aria-hidden="true">
                        <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/>
                    </svg>
                </div>`;
        }
        const fallback = {
            microsoft: { bg: '#0078d4', label: 'M' },
            ha:        { bg: '#41bdf5', label: 'H' },
        };
        const f = fallback[provider] || { bg: '#6b7280', label: (provider || '?').charAt(0).toUpperCase() };
        return `<div class="list-item-icon" style="background: ${f.bg};">${f.label}</div>`;
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
