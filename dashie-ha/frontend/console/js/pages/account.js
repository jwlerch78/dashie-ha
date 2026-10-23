/* ============================================================
   Account Page
   ------------------------------------------------------------
   Profile and account deletion (the web-discoverable deletion path).
   Credits (balance, usage, transactions) live on the Credits page.
   Plan/subscription surfaces (plan box, subscribe banner, portal
   access) live in the account-plan.js delta module — a Dashie-only
   file that attaches its actions onto this page; open-core builds
   ship without it and every delegate below renders ''.
   ============================================================ */

// 🔴 NO GRACE-PERIOD NUMBER IN THIS FILE (O's ruling, D11, 2026-10-23). This used to hold DELETION_GRACE_DAYS = 90, an
// unguarded display mirror of the backend window (database-operations handlers/account.ts `graceMs`), because the window
// is not readable before the request. The pre-request copy now states no number, and the only date a user ever sees is
// the server's returned `deletion_scheduled_at`. If a number is wanted before the request, add a read op that returns
// it — never a literal here. Registry: JS_KOTLIN_CONTRACTS row 247.

const AccountPage = {
    _data: null,
    _loading: false,
    _error: null,
    _subRenewsAt: null,      // ISO — active sub's next renewal (Stripe current_period_end)

    /**
     * True when this session has no Dashie account to show — i.e. local mode
     * (the published console inside the add-on, signed out).
     *
     * Asks `requiresAccount`, not `isLocked`: the question here is "is there an
     * account", which is the broader condition. If 'account' ever leaves
     * ACCOUNT_LOCKED_PAGES this guard must still hold, because _fetchData would
     * still 401.
     */
    _signedOut() {
        return typeof FeatureGate !== 'undefined' && FeatureGate.requiresAccount('account');
    },

    async refresh() {
        if (this._signedOut()) return;
        await this._fetchData();
    },

    render() {
        // Signed-out state. DEFENCE IN DEPTH — in normal operation the router
        // intercepts 'account' while it is locked (App.renderPage's locked
        // branch) and this module never runs at all. This is the backstop for
        // any path that reaches the page object directly: without it, render()
        // falls straight into _fetchData() and 401s check-subscription.
        if (this._signedOut()) {
            return typeof AccountRequiredPanel !== 'undefined'
                ? AccountRequiredPanel.render('account')
                : '';
        }

        // Kick off data fetch if not loaded
        if (!this._data && !this._loading && !this._error) {
            this._fetchData();
            return this._renderLoading();
        }

        if (this._loading) return this._renderLoading();
        if (this._error) return this._renderError();

        // `?open=delete-account` arrivals: reveal the Danger Zone after this markup is in the DOM.
        if (this._revealDeletion) setTimeout(() => this._revealDeletionIfAsked(), 0);
        return this._renderLoaded();
    },

    topBarTitle() { return 'Account'; },
    topBarSubtitle() { return ''; },

    /** Top-bar action buttons (delta — subscription management in Dashie
     *  builds; open-core renders none). */
    topBarActions() {
        return window.AccountPlan?.topBarActions?.(this._data) ?? '';
    },

    // =========================================================

    async _fetchData() {
        this._loading = true;
        this._error = null;
        try {
            // get_transactions rides along only for subscription_renews_at
            // (Stripe current_period_end) — the Plan box's renewal date. The
            // transaction list itself lives on the Credits page now.
            const [response] = await Promise.all([
                DashieAuth.edgeFunctionRequest('check-subscription', { auth_user_id: DashieAuth.jwtUserId }),
                DashieAuth.dbRequest('get_transactions', { limit: 1 }).then(r => {
                    if (r?.subscription_renews_at) this._subRenewsAt = r.subscription_renews_at;
                }).catch(() => {}),
            ]);
            this._data = response;
            this._loading = false;
            App.renderPage();
        } catch (e) {
            console.error('[AccountPage] Fetch failed:', e);
            this._error = e.message;
            this._loading = false;
            App.renderPage();
        }
    },

    _renderLoading() {
        return `
            <div style="display: flex; align-items: center; justify-content: center; padding: 60px;">
                <div style="text-align: center;">
                    <div class="spinner" style="width: 32px; height: 32px; border: 3px solid #e5e7eb; border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 12px;"></div>
                    <div style="color: var(--text-secondary); font-size: var(--font-size-sm);">Loading account...</div>
                </div>
                <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
            </div>
        `;
    },

    _renderError() {
        return `
            <div class="card">
                <div class="card-body" style="color: var(--status-error);">
                    <strong>Failed to load account data:</strong> ${this._error}
                    <div style="margin-top: 12px;">
                        <button class="btn btn-secondary btn-sm" onclick="AccountPage._retry()">Retry</button>
                    </div>
                </div>
            </div>
        `;
    },

    _retry() {
        this._error = null;
        this._data = null;
        App.renderPage();
    },

    /** On re-entry, soft-refresh the subscription data in place (no loading
     *  flash) so navigating back shows a current plan/renewal state. First
     *  visit goes through render()'s _fetchData. */
    onNavigateTo() {
        if (this._data) this._refreshSubscription();
    },

    async _refreshSubscription() {
        await Promise.all([
            DashieAuth.edgeFunctionRequest('check-subscription', { auth_user_id: DashieAuth.jwtUserId })
                .then(r => { if (r) this._data = r; }).catch(() => {}),
            DashieAuth.dbRequest('get_transactions', { limit: 1 }).then(r => {
                if (r?.subscription_renews_at) this._subRenewsAt = r.subscription_renews_at;
            }).catch(() => {}),
        ]);
        App.renderPage();
    },

    _escape(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },


    _renderLoaded() {
        const user = DashieAuth.user;
        const d = this._data || {};

        // Plan/subscription surfaces (subscribe banner, Plan box) are delta —
        // Dashie builds only. Open-core: identity + danger zone.
        const banner = window.AccountPlan?.expiredBannerCard?.(d) ?? '';
        const planSection = window.AccountPlan?.planBoxSection?.(d) ?? '';

        return `
            <div style="max-width: 800px;">
                ${banner}
                <div style="margin-bottom: 24px; color: var(--text-secondary); font-size: var(--font-size-sm);">
                    ${user.email} · Signed in via Google
                </div>

                ${planSection}

                <div class="section-header" id="danger-zone" style="color: var(--status-error, #c00); margin-top: 32px;">Danger Zone</div>
                <div class="card" id="danger-zone-card" style="border-color: var(--status-error, #c00);">
                    <div class="card-body">
                        <div style="font-weight: 500; margin-bottom: 6px;">Delete your ${BRAND.productName} account</div>
                        ${d.deletion_scheduled_at ? `
                        <div style="color: var(--text-secondary); font-size: var(--font-size-sm); line-height: 1.5;">
                            Your account is already scheduled for deletion — use the banner at the top of this page to keep it.
                        </div>` : `
                        <div style="color: var(--text-secondary); font-size: var(--font-size-sm); line-height: 1.5; margin-bottom: 16px;">
                            Schedule deletion: your account is kept for a grace period, then permanently deleted — calendars, photos, chores, rewards, family members, OAuth tokens, voice profiles and devices. We'll show you the exact date and email it to you. Sign in before then and choose “Keep account” to cancel.
                        </div>
                        <button class="btn btn-danger" id="delete-account-btn" onclick="AccountPage.handleDeleteAccount('schedule')">Schedule deletion</button>
                        <div style="color: var(--text-secondary); font-size: var(--font-size-sm); line-height: 1.5; margin: 20px 0 16px;">
                            Or delete it immediately: your account and all its data are permanently deleted right away. This cannot be undone.
                        </div>
                        <button class="btn btn-danger" id="delete-account-now-btn" onclick="AccountPage.handleDeleteAccount('now')">Delete now</button>`}
                    </div>
                </div>
            </div>
        `;
        // Subscription management lives in topBarActions (delta); Sign Out is
        // in the top-bar avatar dropdown menu (TopBar._renderMenu).
    },

    // =========================================================

    async signOut() {
        // Themed ConfirmModal — not the browser's native confirm(), which
        // renders an unstyled "<host> says" system dialog.
        const confirmed = await ConfirmModal.confirm({
            title: 'Sign out?',
            message: `Sign out of the ${BRAND.consoleName}?`,
            confirmLabel: 'Sign Out',
            cancelLabel: 'Cancel',
        });
        if (!confirmed) return;
        await DashieAuth.signOut();
        this._data = null;
        App._showLogin();
    },

    /**
     * Schedule account deletion (soft delete — the window is the backend's; see
     * the note at the top of this file for why no number is stated here). Backend
     * (`delete_account` op → handleRequestAccountDeletion) sets
     * deletion_scheduled_at = now() + the grace and stops billing (cancel-at-period-end)
     * WITHOUT touching data; the purge cron hard-deletes after the grace. The
     * account stays usable during the window and the user can undo via "Keep
     * account" (cancel_account_deletion) — see App._deletionBannerHtml/keepAccount.
     *
     * This console is the web-discoverable deletion path (Play Store compliance).
     * Confirmation requires typing the email — defense in depth against a misclick
     * on a shared session.
     */
    async handleDeleteAccount(mode) {
        const email = DashieAuth.user?.email || '';
        if (!email) {
            Toast.error('Not signed in — please reload and try again.');
            return;
        }
        // Two explicit choices, one op (D11, 2026-10-23). An unknown mode does NOTHING: a missing argument must never
        // fall through to either deletion. "now" is decided server-side (delete_account + immediate), not chained here.
        if (mode === 'now') return this._deleteNow(email);
        if (mode !== 'schedule') {
            console.warn(`DROP: DELETE_ACCOUNT unknown mode '${mode}' ignored`);
            return;
        }

        const confirmed = await ConfirmModal.confirm({
            title: 'Schedule account deletion?',
            message: [
                'Your account is kept for a grace period, then permanently deleted. We\'ll show you',
                'the exact date and email it to you.',
                '',
                'Until then your data stays intact. Sign in and choose “Keep account” to cancel.',
                '',
                'When the date arrives this removes everything — calendars, photos, chores,',
                'rewards, family members, OAuth tokens, voice profiles, and devices.',
            ].join('\n'),
            confirmLabel: 'Schedule deletion',
            cancelLabel: 'Keep My Account',
            danger: true,
            requireTypedConfirmation: email,
            typedConfirmationLabel: `Type ${email} to confirm`,
        });
        if (!confirmed) return;

        const btn = document.getElementById('delete-account-btn');
        const restore = () => { if (btn) { btn.disabled = false; btn.textContent = 'Schedule deletion'; } };
        if (btn) { btn.disabled = true; btn.textContent = 'Scheduling…'; }

        try {
            const result = await DashieAuth.dbRequest('delete_account', {});
            if (result?.scheduled !== true) {
                throw new Error(result?.error || 'Could not schedule deletion');
            }
            // Per the model: schedule, then sign the user out. The pending state +
            // Keep/Delete-now live in the global banner shown on next sign-in.
            await this._showAppleNoteIfAny(result);
            const when = result.deletion_scheduled_at
                ? new Date(result.deletion_scheduled_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
                : null;
            Toast.info(when
                ? `Your account will be deleted on ${when}. Signing you out — sign back in before then to keep it or delete now.`
                : 'Account scheduled for deletion. Signing you out — sign back in before the deadline to keep it or delete now.');
            setTimeout(() => {
                try { localStorage.clear(); } catch (_) {}
                try { sessionStorage.clear(); } catch (_) {}
                try { DashieAuth.signOut?.(); } catch (_) {}
                window.location.replace(window.location.origin + window.location.pathname);
            }, 1800);
        } catch (err) {
            console.error('[AccountPage] handleDeleteAccount failed:', err);
            restore();
            Toast.error(`Couldn't schedule deletion: ${String(err?.message || err)}`);
        }
    },

    /**
     * Delete NOW (D11; John 2026-10-23: "Yes - give a delete now option"). One request: `delete_account` with
     * `immediate: true`. The server runs the schedule step first (that is where Sign in with Apple is revoked), then
     * the hard delete. If the hard delete does not finish, the server leaves the account SCHEDULED and says so.
     */
    async _deleteNow(email) {
        const confirmed = await ConfirmModal.confirm({
            title: 'Delete account now?',
            message: [
                'This permanently deletes your account and ALL its data right now — calendars, photos, chores,',
                'rewards, family members, OAuth tokens, voice profiles, and devices.',
                '',
                'This cannot be undone.',
            ].join('\n'),
            confirmLabel: 'Delete now',
            cancelLabel: 'Keep My Account',
            danger: true,
            requireTypedConfirmation: email,
            typedConfirmationLabel: `Type ${email} to confirm`,
        });
        if (!confirmed) return;

        const btn = document.getElementById('delete-account-now-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
        try {
            const r = await DashieAuth.dbRequest('delete_account', { immediate: true });
            if (r?.deleted === true) { await this._showAppleNoteIfAny(r); App._onAccountDeleted(); return; }
            if (r?.scheduled === true && r?.deletion_scheduled_at) {
                await this._showAppleNoteIfAny(r);
                const when = new Date(r.deletion_scheduled_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
                Toast.error(`Couldn't finish deleting right away. Your account is scheduled for deletion on ${when}. Signing you out.`);
                setTimeout(() => {
                    try { localStorage.clear(); } catch (_) {}
                    try { sessionStorage.clear(); } catch (_) {}
                    try { DashieAuth.signOut?.(); } catch (_) {}
                    window.location.replace(window.location.origin + window.location.pathname);
                }, 2500);
                return;
            }
            throw new Error(r?.error || 'Deletion did not complete');
        } catch (err) {
            console.error('[AccountPage] _deleteNow failed:', err);
            if (btn) { btn.disabled = false; btn.textContent = 'Delete now'; }
            Toast.error(`Couldn't delete your account: ${String(err?.message || err)}`);
        }
    },

    /** An Apple account deleted from the web is NOT revoked at Apple (appleDeletionGate, account-apple-revoke.ts): the
     *  deletion proceeds and the user must be told the one manual step, or they reasonably think they are done. */
    async _showAppleNoteIfAny(reply) {
        const note = typeof ConsoleAppleSignIn !== 'undefined' ? ConsoleAppleSignIn.notRevokedNote(reply) : '';
        if (!note) return;
        await ConfirmModal.confirm({ title: 'One more step for your Apple ID', message: note, confirmLabel: 'OK', hideCancel: true });
    },

    /** Set by App when the visitor arrived on `?open=delete-account`: scroll to and highlight the Danger Zone, once.
     *  It reveals; it never presses a button or opens a confirm. */
    _revealDeletion: false,

    _revealDeletionIfAsked() {
        if (!this._revealDeletion) return;
        const card = document.getElementById('danger-zone-card');
        if (!card) return;           // not rendered yet (still loading) — the next render tries again
        this._revealDeletion = false;
        try { document.getElementById('danger-zone')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) {}
        card.style.boxShadow = '0 0 0 3px var(--status-error, #c00)';
    },

    // The pending-deletion banner + Keep/Delete-now now live globally on App
    // (App._deletionBannerHtml / keepAccount / deleteNow) so they persist on
    // every page, not just here.
};
