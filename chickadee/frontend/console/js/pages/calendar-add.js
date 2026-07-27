/* ============================================================
   Calendar Add Account Modal — Iteration 1A.3

   Opens from CalendarPage.add(). Three stages:

   - picker: Google / Microsoft / Apple buttons
   - apple:  CalDAV form (email + app-specific password)
              → caldav-proxy.save_account
   - device: Google/Microsoft hybrid device flow
              → jwt-auth.create_device_code (is_secondary_add: true)
              → user signs in on phone via dashieapp.com/auth.html
              → poll_device_code_status until secondaryAdd authorization
              → jwt-auth.store_tokens to slot the new account
              → CalendarPage refreshes accounts list

   Works in both contexts:
   - Public web (app.dashieapp.com/console): user can open verification URL in
     a new tab on the same device or scan-and-open on a phone.
   - HA addon Ingress: same mechanic — user opens verification URL on a
     phone where Google/Microsoft OAuth redirects work normally.
   ============================================================ */

const CalendarAddModal = {
    /** null when closed, otherwise { stage, ...stage-specific state } */
    _state: null,
    _pollTimer: null,
    POLL_INTERVAL_MS: 3000,

    // ── Lifecycle ───────────────────────────────────────────

    open() {
        this._state = { stage: 'picker' };
        App.renderPage();
    },

    close() {
        this._stopPolling();
        // If we created a device session that hasn't been authorized yet,
        // there's nothing to "cancel" client-side — the session naturally
        // expires server-side after 10 minutes. Closing just stops polling.
        this._state = null;
        App.renderPage();
    },

    _stopPolling() {
        if (this._pollTimer) {
            clearTimeout(this._pollTimer);
            this._pollTimer = null;
        }
    },

    // ── Stage transitions ───────────────────────────────────

    pickProvider(provider) {
        if (provider === 'apple') {
            this._state = { stage: 'apple', email: '', password: '', friendlyName: '', saving: false, error: null };
            App.renderPage();
            setTimeout(() => {
                const el = document.getElementById('cal-add-apple-email');
                if (el) el.focus();
            }, 50);
        } else {
            // Open a placeholder window synchronously, inside the user gesture,
            // so popup blockers don't intercept. We navigate it to the real
            // verification URL once create_device_code resolves. If the popup
            // was blocked (window.open returned null), the modal still shows
            // the URL as a clickable fallback.
            const preOpened = window.open('about:blank', '_blank');
            this._startDeviceFlow(provider, preOpened);
        }
    },

    backToPicker() {
        this._stopPolling();
        this._state = { stage: 'picker' };
        App.renderPage();
    },

    // ── Apple iCloud (CalDAV) ───────────────────────────────

    async submitApple() {
        if (!this._state || this._state.stage !== 'apple') return;
        const email = (document.getElementById('cal-add-apple-email')?.value || '').trim();
        const password = (document.getElementById('cal-add-apple-password')?.value || '');
        if (!email || !password) {
            this._state.error = 'Email and app-specific password are required.';
            App.renderPage();
            return;
        }
        this._state.saving = true;
        this._state.error = null;
        App.renderPage();
        try {
            const accountType = this._nextAccountSlot('caldav');
            await DashieAuth.edgeFunctionRequest('caldav-proxy', {
                operation: 'save_account',
                accountType,
                email,
                password,
                provider: 'icloud',
            });
            // Discover calendars so we can pick the primary to auto-activate.
            // Failure is non-fatal — account is still added, just no auto-active.
            try {
                const calRes = await DashieAuth.edgeFunctionRequest('caldav-proxy', {
                    operation: 'list_calendars',
                    accountType,
                });
                const cals = calRes.calendars || [];
                if (cals.length > 0) {
                    // Mirror the discovered list to the server-side calendar
                    // cache (user_calendar_metadata) so the calendars show up
                    // in the Settings list immediately — same rows the
                    // dashboard writes for caldav accounts. Non-fatal.
                    try {
                        await DashieAuth.dbRequest('cache_calendar_metadata', {
                            provider: 'caldav',
                            account_type: accountType,
                            calendars: cals.map(c => ({
                                calendar_id: this._encodeCaldavUrl(c.url),
                                prefixed_id: `caldav-${accountType}-${this._encodeCaldavUrl(c.url)}`,
                                summary: c.displayName || null,
                                background_color: c.color || null,
                                foreground_color: '#ffffff',
                                is_primary: false,
                                access_role: null,
                            })),
                        });
                    } catch (e) {
                        console.warn('[CalendarAddModal] CalDAV metadata cache failed (non-fatal):', e.message);
                    }
                    // CalDAV has no native "primary" — first calendar (typically
                    // "Home" / "Calendar" on iCloud) is the safe default.
                    const primaryId = `caldav-${accountType}-${this._encodeCaldavUrl(cals[0].url)}`;
                    await CalendarPage._addActiveCalendar(primaryId);
                }
            } catch (e) {
                console.warn('[CalendarAddModal] CalDAV auto-activate primary failed:', e.message);
            }

            this.close();
            CalendarPage._refetchAfterAdd();
        } catch (e) {
            this._state.saving = false;
            // Apple's error messages from CalDAV are dense; surface a friendly hint
            // when it looks like an auth failure.
            const msg = String(e?.message || e);
            this._state.error = /401|403|unauthor/i.test(msg)
                ? 'Sign-in failed. Make sure you used an app-specific password from appleid.apple.com (not your normal Apple ID password).'
                : msg;
            App.renderPage();
        }
    },

    // ── Google / Microsoft device flow ──────────────────────

    async _startDeviceFlow(provider, preOpenedWindow) {
        this._state = {
            stage: 'device',
            provider,
            status: 'starting',
            userCode: null,
            verificationUrl: null,
            deviceCode: null,
            error: null,
            popupBlocked: !preOpenedWindow,
        };
        App.renderPage();

        try {
            const accountType = this._nextAccountSlot(provider);
            const baseUrl = (DashieAuth.config?.url || '').includes('cwglbtos')
                ? 'https://dev.dashieapp.com'
                : 'https://dashieapp.com';
            const result = await DashieAuth.authRequest({
                operation: 'create_device_code',
                data: {
                    device_type: 'web_console',
                    base_url: baseUrl,
                    is_secondary_add: true,
                    target_account_type: accountType,
                    provider,
                    device_info: { source: 'console' },
                },
            });

            if (!result?.success) {
                throw new Error(result?.message || 'Failed to start device flow');
            }

            // Navigate the pre-opened window to the verification URL. If the
            // user closed it before we got here, fall back to the link in the
            // modal (popupBlocked stays true so the UI shows the link).
            let popupOk = false;
            if (preOpenedWindow && !preOpenedWindow.closed) {
                try {
                    preOpenedWindow.location.href = result.verification_url;
                    popupOk = true;
                } catch (e) {
                    // Cross-origin restrictions on the placeholder can sometimes
                    // throw; treat as blocked.
                    popupOk = false;
                }
            }

            this._state = {
                stage: 'device',
                provider,
                status: 'pending',
                userCode: result.user_code,
                verificationUrl: result.verification_url,
                deviceCode: result.device_code,
                accountType,
                popupBlocked: !popupOk,
                error: null,
            };
            App.renderPage();
            this._scheduleNextPoll();
        } catch (e) {
            // Close the placeholder if we opened one — no point leaving a
            // blank tab around.
            if (preOpenedWindow && !preOpenedWindow.closed) {
                try { preOpenedWindow.close(); } catch (_) {}
            }
            this._state = {
                stage: 'device',
                provider,
                status: 'error',
                error: e.message,
                userCode: null,
                verificationUrl: null,
                deviceCode: null,
            };
            App.renderPage();
        }
    },

    _scheduleNextPoll() {
        this._stopPolling();
        this._pollTimer = setTimeout(() => this._poll(), this.POLL_INTERVAL_MS);
    },

    async _poll() {
        this._pollTimer = null;
        if (!this._state || this._state.stage !== 'device') return;
        if (!this._state.deviceCode) return;
        try {
            const result = await DashieAuth.authRequest({
                operation: 'poll_device_code_status',
                data: { device_code: this._state.deviceCode },
            });
            // Status === 'authorization_pending' (and other not-yet-done) → keep polling.
            if (result?.status === 'authorization_pending' || result?.status === 'pending') {
                this._scheduleNextPoll();
                return;
            }
            if (result?.status === 'expired_token' || result?.status === 'expired') {
                this._state.status = 'expired';
                this._state.error = 'Verification window expired. Please try again.';
                App.renderPage();
                return;
            }
            if (result?.success && result?.status === 'authorized' && result?.secondaryAdd) {
                await this._completeDeviceAdd(result);
                return;
            }
            // Unexpected status — treat as soft error, surface message.
            this._state.status = 'error';
            this._state.error = result?.message || `Unexpected status: ${result?.status || 'unknown'}`;
            App.renderPage();
        } catch (e) {
            // Transient network errors: keep polling but back off slightly.
            console.warn('[CalendarAddModal] poll error', e.message);
            this._pollTimer = setTimeout(() => this._poll(), this.POLL_INTERVAL_MS * 2);
        }
    },

    /**
     * Called after poll_device_code_status returns secondaryAdd: true. Stashes
     * the returned tokens into user_auth_tokens via store_tokens, then
     * refreshes CalendarPage's accounts list and closes the modal.
     */
    async _completeDeviceAdd(pollResult) {
        const provider = pollResult.provider || this._state.provider;
        const accountType = pollResult.targetAccountType || this._state.accountType;
        const user = pollResult.user || {};
        const tokens = pollResult.tokens || {};
        try {
            await DashieAuth.authRequest({
                operation: 'store_tokens',
                provider,
                account_type: accountType,
                data: {
                    access_token: tokens.access_token,
                    refresh_token: tokens.refresh_token,
                    expires_in: tokens.expires_in || 3600,
                    scope: tokens.scope,
                    email: user.email,
                    display_name: user.name || user.email,
                    provider_info: { type: provider === 'microsoft' ? 'microsoft_oauth' : 'web_oauth' },
                },
            });

            // Discover the account's calendars and mirror them to the
            // server-side cache (user_calendar_metadata) — the same write the
            // dashboard's getCalendars() → _cacheCalendarsServerSide() does.
            // Without this, list_cached_calendars has no rows for the new
            // account, so the Settings calendar list (console AND on-device)
            // shows nothing until a dashboard session happens to run a full
            // fetch (FB14). Also yields the real primary instead of a guess.
            let primaryId = null;
            try {
                const calendars = await this._fetchProviderCalendars(provider, accountType, tokens);
                if (calendars && calendars.length > 0) {
                    await DashieAuth.dbRequest('cache_calendar_metadata', {
                        provider,
                        account_type: accountType,
                        calendars,
                    });
                    const primary = calendars.find(c => c.is_primary) || calendars[0];
                    primaryId = primary?.prefixed_id || null;
                }
            } catch (e) {
                console.warn('[CalendarAddModal] calendar discovery failed (non-fatal):', e.message);
            }

            // Auto-activate the primary calendar so the user sees events on
            // their dashboard immediately. Falls back to the predicted id
            // when discovery failed. Non-fatal on failure.
            try {
                if (!primaryId) primaryId = await this._predictPrimaryPrefixedId(provider, accountType, user, tokens);
                if (primaryId) await CalendarPage._addActiveCalendar(primaryId);
            } catch (e) {
                console.warn('[CalendarAddModal] auto-activate primary failed:', e.message);
            }

            this.close();
            CalendarPage._refetchAfterAdd();
        } catch (e) {
            this._state.status = 'error';
            this._state.error = `Account authorized but failed to save: ${e.message}`;
            App.renderPage();
        }
    },

    /**
     * Computes the prefixed_id used in active_calendar_ids for the new
     * account's primary calendar. Returns null when we can't determine it.
     *
     * - Google: primary calendar's ID equals the user's email, so
     *           `${accountType}-${email}` is reliably correct.
     * - Microsoft: hits Graph /me/calendars to find isDefaultCalendar — we
     *              already have an access token from the device-flow result.
     */
    async _predictPrimaryPrefixedId(provider, accountType, user, tokens) {
        if (provider === 'google') {
            if (!user.email) return null;
            return `${accountType}-${user.email}`;
        }
        if (provider === 'microsoft') {
            if (!tokens.access_token) return null;
            const resp = await fetch('https://graph.microsoft.com/v1.0/me/calendars', {
                headers: { 'Authorization': `Bearer ${tokens.access_token}` }
            });
            if (!resp.ok) {
                console.warn('[CalendarAddModal] MS Graph /calendars failed:', resp.status);
                return null;
            }
            const data = await resp.json();
            const list = Array.isArray(data.value) ? data.value : [];
            const def = list.find(c => c.isDefaultCalendar) || list[0];
            if (!def?.id) return null;
            return `microsoft-${accountType}-${def.id}`;
        }
        return null;
    },

    /**
     * Fetches the new account's full calendar list directly from the
     * provider using the short-lived access token from the device-flow poll
     * result, mapped to the cache_calendar_metadata payload shape.
     *
     * Field mapping mirrors the dashboard exactly (calendar-service.js
     * getCalendars → _cacheCalendarsServerSide, _normalizeMicrosoftCalendar)
     * so the rows we write match what the dashboard's next fetch would write
     * — keeping the edge function's idempotency signature stable and
     * avoiding a spurious calendar_metadata re-broadcast.
     */
    async _fetchProviderCalendars(provider, accountType, tokens) {
        if (!tokens?.access_token) return null;
        if (provider === 'google') {
            const resp = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
                headers: { 'Authorization': `Bearer ${tokens.access_token}` }
            });
            if (!resp.ok) throw new Error(`Google calendarList failed: ${resp.status}`);
            const data = await resp.json();
            return (data.items || []).map(cal => ({
                calendar_id: cal.id,
                prefixed_id: `${accountType}-${cal.id}`,
                summary: cal.summary || null,
                background_color: cal.backgroundColor || null,
                foreground_color: cal.foregroundColor || null,
                is_primary: !!cal.primary,
                access_role: cal.accessRole || null,
            }));
        }
        if (provider === 'microsoft') {
            const resp = await fetch('https://graph.microsoft.com/v1.0/me/calendars', {
                headers: { 'Authorization': `Bearer ${tokens.access_token}` }
            });
            if (!resp.ok) throw new Error(`MS Graph /calendars failed: ${resp.status}`);
            const data = await resp.json();
            return (Array.isArray(data.value) ? data.value : []).map(cal => ({
                calendar_id: cal.id,
                prefixed_id: `microsoft-${accountType}-${cal.id}`,
                summary: cal.name || null,
                background_color: cal.hexColor ? `#${cal.hexColor}` : '#1a73e8',
                foreground_color: '#ffffff',
                is_primary: !!cal.isDefaultCalendar,
                access_role: cal.canEdit ? 'owner' : 'reader',
            }));
        }
        return null;
    },

    /**
     * Mirrors caldavClient.encodeCalendarId — base64url(no padding) of the
     * CalDAV URL, used as the opaque calendar ID inside the prefixed_id
     * scheme. Kept inline so the modal doesn't depend on importing the
     * client module.
     */
    _encodeCaldavUrl(url) {
        return btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },

    /**
     * Smallest unused slot for this provider. Google reserves "primary" for
     * the Dashie sign-in account, so additional Google adds start at
     * account2. Microsoft has no special primary; first MS add lands in
     * "primary" within the microsoft namespace.
     */
    _nextAccountSlot(provider) {
        const taken = new Set(
            (CalendarPage._accounts || [])
                .filter(a => a.provider === provider)
                .map(a => a.account_type)
        );
        if ((provider === 'microsoft' || provider === 'caldav') && !taken.has('primary')) return 'primary';
        for (let i = 2; i <= 99; i++) {
            if (!taken.has(`account${i}`)) return `account${i}`;
        }
        throw new Error('No free account slot');
    },

    // ── Render ──────────────────────────────────────────────

    render() {
        if (!this._state) return '';
        let body = '';
        if (this._state.stage === 'picker') body = this._renderPicker();
        else if (this._state.stage === 'apple') body = this._renderApple();
        else if (this._state.stage === 'device') body = this._renderDevice();
        return `
            <div onclick="if(event.target===this)CalendarAddModal.close()"
                 style="position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 16px;">
                <div style="background: var(--bg-card, #fff); border-radius: 12px; max-width: 480px; width: 100%; max-height: 90vh; overflow: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3);">
                    ${body}
                </div>
            </div>
        `;
    },

    _renderPicker() {
        return `
            <div style="padding: 24px;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
                    <h2 style="margin: 0; font-size: 18px;">Add a calendar account</h2>
                    <button class="btn btn-ghost btn-sm" onclick="CalendarAddModal.close()" aria-label="Close">✕</button>
                </div>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    <button onclick="CalendarAddModal.pickProvider('google')" style="display: flex; align-items: center; gap: 12px; padding: 14px 16px; background: var(--bg-card, #fff); border: 1px solid var(--border, #e5e7eb); border-radius: 8px; cursor: pointer; text-align: left;">
                        ${this._googleIcon()}
                        <div style="flex: 1;">
                            <div style="font-weight: 500;">Google</div>
                            <div style="font-size: 12px; color: var(--text-muted);">Gmail, Workspace, Google Calendar</div>
                        </div>
                        <span style="color: var(--text-muted);">›</span>
                    </button>
                    <button onclick="CalendarAddModal.pickProvider('microsoft')" style="display: flex; align-items: center; gap: 12px; padding: 14px 16px; background: var(--bg-card, #fff); border: 1px solid var(--border, #e5e7eb); border-radius: 8px; cursor: pointer; text-align: left;">
                        <div style="width: 28px; height: 28px; border-radius: 50%; background: #0078d4; display: flex; align-items: center; justify-content: center; color: white; font-weight: 600; font-size: 14px;">M</div>
                        <div style="flex: 1;">
                            <div style="font-weight: 500;">Microsoft</div>
                            <div style="font-size: 12px; color: var(--text-muted);">Outlook, Microsoft 365, Hotmail</div>
                        </div>
                        <span style="color: var(--text-muted);">›</span>
                    </button>
                    <button onclick="CalendarAddModal.pickProvider('apple')" style="display: flex; align-items: center; gap: 12px; padding: 14px 16px; background: var(--bg-card, #fff); border: 1px solid var(--border, #e5e7eb); border-radius: 8px; cursor: pointer; text-align: left;">
                        ${this._appleIcon()}
                        <div style="flex: 1;">
                            <div style="font-weight: 500;">Apple iCloud</div>
                            <div style="font-size: 12px; color: var(--text-muted);">iCloud Calendar via CalDAV</div>
                        </div>
                        <span style="color: var(--text-muted);">›</span>
                    </button>
                </div>
            </div>
        `;
    },

    _renderApple() {
        const { saving, error } = this._state;
        return `
            <div style="padding: 24px;">
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
                    <button class="btn btn-ghost btn-sm" onclick="CalendarAddModal.backToPicker()" aria-label="Back">←</button>
                    <h2 style="margin: 0; font-size: 18px;">Add Apple iCloud</h2>
                </div>
                <div style="background: var(--bg-muted, #f9fafb); border-radius: 8px; padding: 12px 14px; font-size: 13px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 16px;">
                    Apple requires an <strong>app-specific password</strong> (not your regular Apple ID password). Generate one at
                    <a href="https://appleid.apple.com/account/manage" target="_blank" rel="noopener" style="color: var(--accent, #ff9500);">appleid.apple.com</a>
                    → Sign-In and Security → App-Specific Passwords.
                </div>
                <div class="form-group">
                    <label class="form-label">Apple ID email</label>
                    <input type="email" class="form-input" id="cal-add-apple-email" placeholder="you@icloud.com" autocomplete="email" ${saving ? 'disabled' : ''}>
                </div>
                <div class="form-group" style="margin-top: 12px;">
                    <label class="form-label">App-specific password</label>
                    <input type="password" class="form-input" id="cal-add-apple-password" placeholder="xxxx-xxxx-xxxx-xxxx" autocomplete="new-password" ${saving ? 'disabled' : ''}>
                </div>
                ${error ? `<div style="margin-top: 12px; padding: 10px 12px; background: var(--status-error-bg, #fee); color: var(--status-error, #c00); border-radius: 6px; font-size: 13px;">${this._escape(error)}</div>` : ''}
                <div style="display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end;">
                    <button class="btn btn-ghost" onclick="CalendarAddModal.close()" ${saving ? 'disabled' : ''}>Cancel</button>
                    <button class="btn btn-primary" onclick="CalendarAddModal.submitApple()" ${saving ? 'disabled' : ''}>${saving ? 'Adding…' : 'Add Account'}</button>
                </div>
            </div>
        `;
    },

    _renderDevice() {
        const { provider, status, userCode, verificationUrl, error } = this._state;
        const providerLabel = provider === 'microsoft' ? 'Microsoft' : 'Google';
        if (status === 'starting') {
            return `
                <div style="padding: 32px; text-align: center;">
                    <div style="width: 32px; height: 32px; border: 3px solid #e5e7eb; border-top-color: var(--accent, #ff9500); border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 12px;"></div>
                    <div>Starting ${providerLabel} sign-in…</div>
                    <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
                </div>
            `;
        }
        if (status === 'error' || status === 'expired') {
            return `
                <div style="padding: 24px;">
                    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
                        <button class="btn btn-ghost btn-sm" onclick="CalendarAddModal.backToPicker()" aria-label="Back">←</button>
                        <h2 style="margin: 0; font-size: 18px;">Sign-in problem</h2>
                    </div>
                    <div style="padding: 12px 14px; background: var(--status-error-bg, #fee); color: var(--status-error, #c00); border-radius: 6px; font-size: 13px; margin-bottom: 16px;">
                        ${this._escape(error || 'Something went wrong.')}
                    </div>
                    <div style="display: flex; gap: 8px; justify-content: flex-end;">
                        <button class="btn btn-ghost" onclick="CalendarAddModal.close()">Cancel</button>
                        <button class="btn btn-primary" onclick="CalendarAddModal.pickProvider('${this._escape(provider)}')">Try Again</button>
                    </div>
                </div>
            `;
        }
        // Pending — popup auto-opened the URL in another tab; this modal
        // shows the polling spinner and waits. If the popup was blocked,
        // surface a clickable link as a fallback.
        const { popupBlocked } = this._state;
        const blockedFallback = popupBlocked
            ? `<div style="background: var(--status-warn-bg, #fff7ed); color: var(--status-warn, #b45309); border-radius: 8px; padding: 12px 14px; font-size: 13px; line-height: 1.5; margin-bottom: 16px;">
                   Couldn't open a new tab automatically (popup blocker?).
                   <a href="${this._escape(verificationUrl)}" target="_blank" rel="noopener" style="color: inherit; text-decoration: underline; font-weight: 500;">Click here to continue sign-in.</a>
               </div>`
            : '';
        return `
            <div style="padding: 24px;">
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
                    <button class="btn btn-ghost btn-sm" onclick="CalendarAddModal.close()" aria-label="Close">✕</button>
                    <h2 style="margin: 0; font-size: 18px;">Add ${providerLabel} account</h2>
                </div>
                <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5;">
                    Sign in with the ${providerLabel} account you want to add in the new tab. This page will update automatically when you're done.
                </p>
                ${blockedFallback}
                <div style="display: flex; align-items: center; gap: 8px; justify-content: center; color: var(--text-muted); font-size: 13px; padding: 8px 0;">
                    <div style="width: 14px; height: 14px; border: 2px solid #e5e7eb; border-top-color: var(--accent, #ff9500); border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
                    <span>Waiting for sign-in…</span>
                    <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
                </div>
                <div style="display: flex; gap: 8px; margin-top: 20px; justify-content: flex-end;">
                    <button class="btn btn-ghost" onclick="CalendarAddModal.close()">Cancel</button>
                </div>
            </div>
        `;
    },

    // ── Provider icon helpers (small, modal-only) ──────────

    _googleIcon() {
        return `<div style="width: 28px; height: 28px; border-radius: 50%; background: #fff; border: 1px solid var(--border, #e5e7eb); display: flex; align-items: center; justify-content: center;">
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
            </svg>
        </div>`;
    },

    _appleIcon() {
        return `<div style="width: 28px; height: 28px; border-radius: 50%; background: #000; display: flex; align-items: center; justify-content: center;">
            <svg width="16" height="16" viewBox="0 0 384 512" fill="#fff" aria-hidden="true">
                <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/>
            </svg>
        </div>`;
    },

    _escape(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
};
