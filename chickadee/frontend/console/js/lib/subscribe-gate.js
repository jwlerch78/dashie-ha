/* ============================================================
   SubscribeGate
   ------------------------------------------------------------
   Centralized subscribe-prompt logic. After auth resolves on the
   Console, this checks the user's subscription state and shows a
   Subscribe prompt modal if no current entitlement exists.

   The gate is the single canonical entry point to the web subscribe
   flow — see .reference/build-plans/20260520_WEB_EMAIL_SUBSCRIPTION_FLOW.md.
   Email links, marketing-site CTAs, and the Amazon device's
   "subscribe at app.dashieapp.com/console" message all route users
   here; the gate fires automatically because expired state triggers
   the prompt.

   Loaded as a script-tag global before app.js.
   ============================================================ */

const SubscribeGate = {
    _shownThisSession: false,
    _checking: false,

    /**
     * Pure predicate: should the subscribe prompt fire for this user?
     *
     * Triggers when there's no current entitlement:
     *   - trial_expired
     *   - canceled past tier_expires_at
     *
     * Does NOT trigger for:
     *   - trialing / active / complimentary (still entitled)
     *   - canceled within grace (still entitled until tier_expires_at)
     *   - past_due (separate UX — direct to Stripe portal to fix card)
     *
     * @param {object} data — check-subscription response
     * @returns {boolean}
     */
    isRequired(data) {
        if (!data) return false;
        const status = data.subscription_status;
        if (!status) return false;
        if (status === 'trial_expired') return true;
        if (status === 'canceled') {
            const exp = data.tier_expires_at ? new Date(data.tier_expires_at).getTime() : 0;
            return exp > 0 && exp < Date.now();
        }
        return false;
    },

    /**
     * Check subscription state and show the prompt if required.
     * Idempotent within a session — won't re-show after dismiss.
     * Non-blocking — caller doesn't need to await.
     */
    async checkAndShow() {
        // Chickadee build: no Dashie plan/trial — never prompt, never push
        // entitlement state (credits are enforced server-side per call).
        if (typeof FeatureGate !== 'undefined' && FeatureGate.isChickadeeBuild()) return;
        if (this._shownThisSession || this._checking) return;
        if (typeof DashieAuth === 'undefined' || !DashieAuth.isAuthenticated || !DashieAuth.user?.id) return;

        this._checking = true;
        try {
            const data = await DashieAuth.edgeFunctionRequest('check-subscription', {
                auth_user_id: DashieAuth.user.id,
            });
            // Push state into FeatureGate so the sidebar hides cloud
            // features (Calendar, Family, Photos, etc.) when expired.
            // This triggers a re-render via FeatureGate.setSubscriptionState.
            if (typeof FeatureGate !== 'undefined') FeatureGate.setSubscriptionState(data);
            if (this.isRequired(data)) {
                this._shownThisSession = true;
                // Users with no console value get the full-page purchase landing
                // (App._renderExpiredLanding) — don't stack this modal on top.
                // Everyone else gets a one-time nudge; the persistent global
                // banner keeps the CTA visible after dismiss.
                if (data.has_console_value !== false) this.showPrompt(data);
            }
        } catch (e) {
            console.warn('[SubscribeGate] check-subscription failed:', e?.message || e);
            // Fail-open: if the check fails, we don't show the prompt.
            // Better to miss a nudge than to interrupt every sign-in on
            // a network blip.
        } finally {
            this._checking = false;
        }
    },

    /**
     * Render the subscribe-prompt modal. Dismissable — Console is also
     * the cancel / delete-account surface, so users can close and still
     * reach Account → Manage / Delete.
     */
    showPrompt(data) {
        // Tear down any existing instance (defensive — checkAndShow guards
        // against double-fire, but reload-via-hash could re-enter).
        const existing = document.querySelector('.subscribe-prompt-root');
        if (existing) existing.remove();

        const root = document.createElement('div');
        root.className = 'subscribe-prompt-root';
        root.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 1200; display: flex; align-items: center; justify-content: center; padding: 16px;';

        const isCancel = data?.subscription_status === 'canceled';
        const title = isCancel ? `Your ${BRAND.productName} subscription has ended` : `Your ${BRAND.productName} trial has ended`;

        root.innerHTML = `
            <div role="dialog" aria-modal="true" aria-labelledby="subscribe-prompt-title"
                 style="background: var(--bg-card, #fff); border-radius: 12px; max-width: 460px; width: 100%; box-shadow: 0 20px 60px rgba(0,0,0,0.3); padding: 24px; position: relative;">
                <button data-action="dismiss" aria-label="Close"
                        style="position: absolute; top: 12px; right: 12px; background: none; border: none; font-size: 20px; color: var(--text-muted); cursor: pointer; padding: 4px 8px; line-height: 1;">✕</button>
                <h2 id="subscribe-prompt-title" style="margin: 0 0 12px 0; font-size: 19px;">${title}</h2>
                <div style="color: var(--text-secondary); font-size: 14px; line-height: 1.5; margin-bottom: 20px;">
                    Subscribe to keep using ${BRAND.productName}:
                    <ul style="margin: 8px 0 0 0; padding-left: 20px;">
                        <li>Calendar sync across Google, Apple, Microsoft</li>
                        <li>Photo library + slideshows on every screen</li>
                        <li>Chores, rewards, and family sharing</li>
                        <li>All your registered ${BRAND.productName} devices</li>
                    </ul>
                </div>
                <div style="display: flex; gap: 8px; justify-content: flex-end;">
                    <button class="btn btn-ghost" data-action="dismiss">Not now</button>
                    <button class="btn btn-primary" data-action="subscribe">Subscribe to ${BRAND.productName}</button>
                </div>
            </div>
        `;

        // Backdrop click dismisses (only on the root, not when clicking inside the dialog)
        root.addEventListener('click', (e) => {
            if (e.target === root) this._dismiss(root);
        });
        root.querySelectorAll('[data-action="dismiss"]').forEach(el => {
            el.addEventListener('click', () => this._dismiss(root));
        });
        root.querySelector('[data-action="subscribe"]').addEventListener('click', () => {
            this._goToSubscribe();
        });

        // Escape key dismisses
        this._escHandler = (e) => {
            if (e.key === 'Escape') this._dismiss(root);
        };
        document.addEventListener('keydown', this._escHandler);

        document.body.appendChild(root);
    },

    _dismiss(root) {
        if (this._escHandler) {
            document.removeEventListener('keydown', this._escHandler);
            this._escHandler = null;
        }
        if (root && root.parentNode) root.parentNode.removeChild(root);
    },

    /** Pass user identity explicitly — defense in depth against subscribe.html
     *  self-auth missing edge cases. The page also accepts a fall back to the
     *  Supabase session for callers that can't pass identity (email links). */
    _goToSubscribe() {
        const user = DashieAuth.user || {};
        const id = encodeURIComponent(user.id || '');
        const email = encodeURIComponent(user.email || '');
        window.location.href = `/subscribe.html?user=${id}&email=${email}`;
    },
};
