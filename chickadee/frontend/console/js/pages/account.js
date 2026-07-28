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

const AccountPage = {
    _data: null,
    _loading: false,
    _error: null,
    _subRenewsAt: null,      // ISO — active sub's next renewal (Stripe current_period_end)

    async refresh() {
        await this._fetchData();
    },

    render() {
        // Kick off data fetch if not loaded
        if (!this._data && !this._loading && !this._error) {
            this._fetchData();
            return this._renderLoading();
        }

        if (this._loading) return this._renderLoading();
        if (this._error) return this._renderError();

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

                <div class="section-header" style="color: var(--status-error, #c00); margin-top: 32px;">Danger Zone</div>
                <div class="card" style="border-color: var(--status-error, #c00);">
                    <div class="card-body">
                        <div style="font-weight: 500; margin-bottom: 6px;">Delete your ${BRAND.productName} account</div>
                        ${d.deletion_scheduled_at ? `
                        <div style="color: var(--text-secondary); font-size: var(--font-size-sm); line-height: 1.5;">
                            Your account is already scheduled for deletion — use the banner at the top of this page to keep it.
                        </div>` : `
                        <div style="color: var(--text-secondary); font-size: var(--font-size-sm); line-height: 1.5; margin-bottom: 16px;">
                            Schedules your ${BRAND.productName} account for deletion in 15 days. Billing stops now; your data (calendars, photos, chores, rewards, family members, OAuth tokens, voice profiles, devices) is removed when the 15 days are up. You can cancel any time before then with “Keep account.”
                        </div>
                        <button class="btn btn-danger" id="delete-account-btn" onclick="AccountPage.handleDeleteAccount()">Delete Account</button>`}
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
     * Schedule account deletion (soft delete, 15-day grace). Backend
     * (`delete_account` op → handleRequestAccountDeletion) sets
     * deletion_scheduled_at = now()+15d and stops billing (cancel-at-period-end)
     * WITHOUT touching data; the purge cron hard-deletes after the grace. The
     * account stays usable during the window and the user can undo via "Keep
     * account" (cancel_account_deletion) — see App._deletionBannerHtml/keepAccount.
     *
     * This console is the web-discoverable deletion path (Play Store compliance).
     * Confirmation requires typing the email — defense in depth against a misclick
     * on a shared session.
     */
    async handleDeleteAccount() {
        const email = DashieAuth.user?.email || '';
        if (!email) {
            Toast.error('Not signed in — please reload and try again.');
            return;
        }

        const confirmed = await ConfirmModal.confirm({
            title: 'Schedule account deletion?',
            message: [
                'Your account will be permanently deleted in 15 days. Until then:',
                '  • Billing stops now — no further charges',
                '  • Your data stays intact and you can cancel any time',
                '',
                'After 15 days this removes everything — calendars, photos, chores,',
                'rewards, family members, OAuth tokens, voice profiles, and devices.',
                '',
                'You can undo this with “Keep account” before the 15 days are up.',
            ].join('\n'),
            confirmLabel: 'Schedule deletion',
            cancelLabel: 'Keep My Account',
            danger: true,
            requireTypedConfirmation: email,
            typedConfirmationLabel: `Type ${email} to confirm`,
        });
        if (!confirmed) return;

        const btn = document.getElementById('delete-account-btn');
        const restore = () => { if (btn) { btn.disabled = false; btn.textContent = 'Delete Account'; } };
        if (btn) { btn.disabled = true; btn.textContent = 'Scheduling…'; }

        try {
            const result = await DashieAuth.dbRequest('delete_account', {});
            if (result?.scheduled !== true) {
                throw new Error(result?.error || 'Could not schedule deletion');
            }
            // Per the model: schedule, then sign the user out. The pending state +
            // Keep/Delete-now live in the global banner shown on next sign-in.
            Toast.info('Account scheduled for deletion. Signing you out — sign back in any time before the deadline to keep it or delete now.');
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

    // The pending-deletion banner + Keep/Delete-now now live globally on App
    // (App._deletionBannerHtml / keepAccount / deleteNow) so they persist on
    // every page, not just here.
};
