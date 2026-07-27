/* ============================================================
   DashboardTrial
   ------------------------------------------------------------
   The ha_only → trialing opt-in (HA voice-only account model,
   Phase 6 — .reference/build-plans/20260713_HA_VOICE_ONLY_ACCOUNT_MODEL.md).

   An account that signed up through the HA add-on console is created
   'ha_only': voice & AI only, no dashboard, and — deliberately — its
   30-day trial is still UNSPENT (signup writes no prior_trials row, and
   check-subscription short-circuits ha_only before every auto-trial
   branch, so nothing can consume it behind the user's back).

   This module is the one place that spends it: the sidebar's "Start free
   trial" CTA calls promptAndStart(), which hits the start-dashboard-trial
   edge fn. That fn re-runs the same prior_trials abuse check
   check-subscription does (email + every device id linked to the account),
   so "new email, same tablet" still can't farm trials.

   On success the account flips to trialing/core: the Dashie Cloud pages
   unhide here on the next render, and any tablet clears forceKioskMode on
   its next subscription check (maybeRestoreFromHaOnly) and reloads into the
   full dashboard on its own — no device-side work needed.

   Loaded as a script-tag global before app.js.
   ============================================================ */

const DashboardTrial = {
    _starting: false,

    /** True when the signed-in account still has the dashboard trial available. */
    isAvailable() {
        return typeof FeatureGate !== 'undefined' && FeatureGate.isHaOnly();
    },

    /** Confirm, then start. Safe to call from an onclick. */
    async promptAndStart() {
        if (this._starting || !this.isAvailable()) return;

        const ok = await ConfirmModal.confirm({
            title: `Start your 30-day ${BRAND.cloudName} trial`,
            messageHtml: `
                <p style="margin:0 0 10px;">Your account is set up for <strong>${BRAND.productName} voice &amp; AI on Home
                Assistant</strong>. The free trial adds the full ${BRAND.productName} dashboard on top: family calendar,
                photos, chores &amp; rewards — on any tablet or TV in the house.</p>
                <p style="margin:0 0 10px;">Your voice &amp; AI setup is untouched, and your HA dashboards
                keep working. Nothing to cancel: after 30 days the account simply returns to HA-only unless
                you subscribe.</p>
                <p style="margin:0; color: var(--text-secondary, #666); font-size: 13px;">
                No card required.</p>`,
            confirmLabel: 'Start free trial',
            cancelLabel: 'Not now',
        });
        if (!ok) return;

        this._starting = true;
        try {
            const res = await DashieAuth.edgeFunctionRequest('start-dashboard-trial', {});

            if (res?.started) {
                const days = res.trial_days || 30;
                Toast.success(`Your ${days}-day ${BRAND.cloudName} trial has started 🎉`);
                // Re-read the subscription so the sidebar's Dashie Cloud section
                // unhides on this tick (setSubscriptionState re-renders).
                await this._refreshSubscription();
                return;
            }

            if (res?.reason === 'trial_already_used') {
                const subscribe = await ConfirmModal.confirm({
                    title: 'Trial already used',
                    messageHtml: `
                        <p style="margin:0 0 10px;">This email or one of your devices has already used the
                        free ${BRAND.cloudName} trial, so we can't start another one.</p>
                        <p style="margin:0;">You can subscribe any time — or keep using ${BRAND.productName} voice &amp; AI
                        on Home Assistant exactly as you are now.</p>`,
                    confirmLabel: 'Subscribe',
                    cancelLabel: 'Not now',
                });
                if (subscribe && typeof AccountPage !== 'undefined' && AccountPage.subscribe) AccountPage.subscribe();
                return;
            }

            // not_eligible (already trialing/subscribed — e.g. a second tab beat us):
            // resync rather than argue with the user.
            await this._refreshSubscription();
            Toast.info(`Your account already has ${BRAND.cloudName} access.`);
        } catch (e) {
            console.warn('[DashboardTrial] start failed:', e?.message || e);
            Toast.error(`Couldn't start the trial: ${String(e?.message || e)}`);
        } finally {
            this._starting = false;
        }
    },

    /** Pull fresh subscription state into FeatureGate (which re-renders the page). */
    async _refreshSubscription() {
        try {
            const data = await DashieAuth.edgeFunctionRequest('check-subscription', {});
            if (typeof FeatureGate !== 'undefined') FeatureGate.setSubscriptionState(data);
        } catch (e) {
            console.warn('[DashboardTrial] subscription refresh failed:', e?.message || e);
        }
    },
};
