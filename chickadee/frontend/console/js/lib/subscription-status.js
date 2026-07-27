/* ============================================================
   SubscriptionStatus — presentation helpers for trial/subscription state.

   Single source of truth for how the Console *presents* the user's
   subscription state (countdown chip, days-remaining), so the top-bar,
   account page, and avatar menu stay consistent. The authoritative state
   itself lives in FeatureGate._subscriptionState (the check-subscription
   response, populated by SubscribeGate.checkAndShow).

   This module is presentation-only — entitlement decisions still belong to
   FeatureGate.hasEntitlement() / SubscribeGate.isRequired().

   Loaded as a script-tag global after feature-gate.js.
   ============================================================ */

const SubscriptionStatus = {
    /** The current check-subscription response, or null if not loaded yet. */
    _state() {
        return (typeof FeatureGate !== 'undefined' && FeatureGate._subscriptionState) || null;
    },

    /**
     * Whole days remaining until tier_expires_at (ceil, floored at 0), or null
     * when there's no expiry date (e.g. active paid subs store null).
     * @param {object} [state] — check-subscription response; defaults to current
     */
    daysRemaining(state) {
        const s = state || this._state();
        const exp = s && s.tier_expires_at ? new Date(s.tier_expires_at).getTime() : 0;
        if (!exp) return null;
        return Math.max(0, Math.ceil((exp - Date.now()) / 86400000));
    },

    /**
     * True while the user is on a healthy (not-yet-expired) trial — the state
     * where a proactive "Subscribe" makes sense.
     * @param {object} [state]
     */
    isTrialing(state) {
        const s = state || this._state();
        return !!s && s.subscription_status === 'trialing';
    },

    /**
     * Descriptor for the persistent top-bar status chip, or null when no chip
     * should show (state unknown, or active/complimentary/expired — expired is
     * handled by the SubscribeGate/expired-branch UX, not the chip).
     *
     * @returns {{ label: string, tone: 'info'|'warn', showSubscribe: boolean,
     *             showManage: boolean } | null}
     */
    chip(state) {
        const s = state || this._state();
        if (!s || !s.subscription_status) return null;

        switch (s.subscription_status) {
            case 'trialing': {
                const d = this.daysRemaining(s);
                const label = d == null
                    ? 'Free trial'
                    : d === 1 ? 'Trial · 1 day left' : `Trial · ${d} days left`;
                // Nudge harder in the final stretch.
                const tone = (d != null && d <= 3) ? 'warn' : 'info';
                return { label, tone, showSubscribe: true, showManage: false };
            }
            case 'canceled': {
                // Only surface a chip while still within the grace window
                // (entitlement intact). Past expiry is the expired-branch UX.
                const d = this.daysRemaining(s);
                if (d == null || d <= 0) return null;
                const label = d === 1 ? 'Ends in 1 day' : `Ends in ${d} days`;
                return { label, tone: 'warn', showSubscribe: true, showManage: false };
            }
            case 'past_due':
                return { label: 'Payment issue', tone: 'warn', showSubscribe: false, showManage: true };
            // active / complimentary / trial_expired → no chip
            default:
                return null;
        }
    },
};
