/* ============================================================
   Feature Gate — beta visibility rules for the Dashie Console.

   See .reference/FEATURE_GATING.md for the canonical model.

   Rules (composable, per-feature key):

   Access ladder (2026-07-03 restructure): standard < beta < alpha.

   1. 'beta-only'  — visible when DashieAuth.specialAccess is 'beta' OR 'alpha'
      (isBetaUser). The hand-selected cohort. Gates voice/AI, credits, video feeds.
      Hidden for 'standard' (fresh-signup default) users.

   2. 'alpha-only' — visible only when specialAccess === 'alpha' (isAlphaUser),
      i.e. dev/innermost. Gates the least-ready features: chores, rewards,
      locations, scheduled actions. Hidden for standard AND beta.

   3. 'addon'      — visible only inside the HA add-on (Ingress).
      Used for features that depend on the HA integration runtime
      (HA media browser, etc.).

   4. 'dev'        — visible only when talking to the dev Supabase
      project. Used for features still under active development that
      we don't want loose in prod.

   5. true / false — hard show / hard hide.

   Usage:
       FeatureGate.shouldShow('voiceAi')   // boolean
       FeatureGate.isAddonMode()           // bool
       FeatureGate.isAlphaUser()           // bool
       FeatureGate.isDevEnv()              // bool

   Adding a new gated feature: add a key + rule to FEATURE_RULES.
   ============================================================ */

const FeatureGate = {
    /** Truthy when running embedded inside the HA add-on (Ingress). */
    isAddonMode() {
        return typeof DashieAuth !== 'undefined' && DashieAuth.isAddonMode === true;
    },

    /**
     * Truthy in the open-core Chickadee console build (the Chickadee add-on
     * vendors this SPA and generates a brand.js with `build: 'chickadee'`).
     * The Dashie brand.js has no `build` field, so every Chickadee branch
     * below is a no-op for Dashie builds.
     */
    isChickadeeBuild() {
        return typeof BRAND !== 'undefined' && BRAND?.build === 'chickadee';
    },

    /**
     * Pages that don't exist in the Chickadee console: the closed Dashie
     * family product (and Dashie device management). Checked FIRST in
     * isPageEnabled — a Chickadee build never shows these regardless of
     * account tier/entitlement.
     */
    CHICKADEE_HIDDEN_PAGES: new Set([
        'devices', 'family', 'calendar', 'chores', 'rewards',
        'locations', 'photos', 'video-feeds',
        // Preferences duplicates what HA already knows (language/time/units) —
        // the Chickadee stack derives from HA config instead (John, 2026-07-27).
        'preferences',
    ]),

    /**
     * FEATURE_RULES overrides for the Chickadee build. Voice/AI and the
     * Chickadee Cloud credits meter ARE the product there — the Dashie
     * beta-cohort gate ('beta-only') doesn't apply to Chickadee accounts.
     */
    CHICKADEE_RULE_OVERRIDES: {
        voiceAi: true,
        credits: true,
    },

    /**
     * Truthy when the console is talking to the development Supabase project.
     *
     * Single check that covers both modes:
     * - Standalone web: DashieAuth.config picks dev vs prod by hostname.
     * - Add-on mode:    DashieAuth.config is whatever the add-on reports.
     * In both cases the dev project URL contains 'cwglbtos' (development
     * supabase project ref); prod is 'cseaywxc'.
     */
    isDevEnv() {
        const url = (typeof DashieAuth !== 'undefined' && DashieAuth.config?.url) || '';
        return url.includes('cwglbtos');
    },

    /**
     * Truthy when the signed-in user has alpha-tier feature access (i.e.
     * user_profiles.special_access === 'alpha'). The 'developer' tier
     * also counts — developers get full access regardless of rollout.
     *
     * Notes on initial paint:
     * - DashieAuth.loadUserProfile() runs async after auth establishes.
     *   Until it resolves, specialAccess is null and this returns false.
     *   That means alpha-gated UI is hidden during the brief moment
     *   before the profile loads — App.init re-renders once load completes
     *   so the UI corrects itself.
     */
    isAlphaUser() {
        if (typeof DashieAuth === 'undefined') return false;
        if (DashieAuth.tier === 'developer') return true;
        return DashieAuth.specialAccess === 'alpha';
    },

    /**
     * Truthy when the user has BETA access or higher (the ladder is inclusive:
     * standard < beta < alpha). Voice/AI + credits moved alpha→beta in the
     * 2026-07-03 access-tier restructure — this gates the hand-selected cohort.
     * Developer tier counts too.
     */
    isBetaUser() {
        if (typeof DashieAuth === 'undefined') return false;
        if (DashieAuth.tier === 'developer') return true;
        const a = DashieAuth.specialAccess;
        return a === 'beta' || a === 'alpha';
    },

    /**
     * Truthy when the signed-in account is an HA voice-only account
     * (subscription_status === 'ha_only'): no dashboard trial, deliberately
     * scoped to voice/AI. Such accounts hide the whole Dashie Cloud dashboard
     * section (family/calendar/photos/…) — see HA_ONLY_HIDDEN_PAGES. Distinct
     * from is_ha_user: once an ha_only user starts the dashboard trial the
     * status flips to 'trialing' and these pages reappear.
     *
     * Reads the SubscribeGate-provided state; optimistic false before it loads
     * (so we don't flash-hide during initial paint), corrected on re-render.
     */
    isHaOnly() {
        return this._subscriptionState?.subscription_status === 'ha_only';
    },

    /**
     * Per-feature visibility rules.
     *   true              → always visible
     *   false             → always hidden (not ready for beta)
     *   'addon'           → visible only when isAddonMode()
     *   'dev'             → visible only when isDevEnv()
     *   'beta-only'       → visible only when isBetaUser()  (beta OR alpha)
     *   'alpha-only'      → visible only when isAlphaUser() (alpha / dev only)
     */
    FEATURE_RULES: {
        // Voice / AI features (Dashie Cloud token spend) — the hand-selected BETA
        // cohort. Moved alpha→beta in the 2026-07-03 access-tier restructure.
        voiceAi:    'beta-only',
        // Video Feeds — STANDARD access (2026-07-22): HA camera feeds are a core HA
        // capability, not a metered cloud product, so it's visible to all users (an
        // account without HA simply has no feeds to show). Was 'beta-only'.
        videoFeeds: true,

        // Credits / token-bank / BYOK — the beta cohort meters cloud voice/AI and
        // gets starter credits, so it's a beta gate now (was alpha).
        credits:    'beta-only',

        // API Keys (BYO model-provider keys) — stored on the HA box's add-on
        // /data volume, so the page only exists inside the add-on console.
        apiKeys:    'addon',

        // Local Engines (own-box Ollama / Kokoro / Piper / whisper URLs) — the
        // save flow probes the LAN box through the add-on (an https:// website
        // console can't reach a http:// LAN engine), so it's add-on only.
        localEngines: 'addon',

        // Locations / GPS — STAYS alpha (dev/innermost only), mirroring the
        // feature_access catalog (rollout='alpha').
        locations:  'alpha-only',

        // Chores & rewards — STAY alpha, mirroring the feature_access catalog.
        chores:     'alpha-only',
        rewards:    'alpha-only',

        // Scheduled Actions (voice reminders) — STAYS alpha, mirrors feature_access.
        scheduledActions: 'alpha-only',

        // Prompt-for-feedback (thumbs up/down after voice responses) — alpha,
        // mirrors the native settings page's voice_feedback gate (feature_access).
        promptForFeedback: 'alpha-only',
    },

    shouldShow(key) {
        let rule = this.FEATURE_RULES[key];
        if (this.isChickadeeBuild() && key in this.CHICKADEE_RULE_OVERRIDES) {
            rule = this.CHICKADEE_RULE_OVERRIDES[key];
        }
        if (rule === undefined) return true;        // unknown key → visible (safer)
        if (rule === true)  return true;
        if (rule === false) return false;
        if (rule === 'addon')      return this.isAddonMode();
        if (rule === 'dev')        return this.isDevEnv();
        if (rule === 'beta-only')  return this.isBetaUser();
        if (rule === 'alpha-only') return this.isAlphaUser();
        return true;
    },

    /**
     * Map of console route → feature key (for nav gating + redirect-to-home
     * on direct URL hits to a hidden page). Routes not in this map are
     * always shown.
     */
    PAGE_FEATURE: {
        'voice-ai':    'voiceAi',
        'video-feeds': 'videoFeeds',
        'locations':   'locations',
        'chores':      'chores',
        'rewards':     'rewards',
        'scheduled-actions': 'scheduledActions',
        'credits':     'credits',
        'api-keys':    'apiKeys',
        'local-engines': 'localEngines',
    },

    /**
     * Pages that require a current subscription / trial entitlement.
     * When the SubscribeGate detects expired state, these are hidden from
     * the sidebar until the user subscribes. Account and Devices are
     * intentionally excluded — the user needs to reach Account to subscribe
     * or manage; Devices is read-only-ish and useful even for an expired
     * account.
     */
    ENTITLEMENT_GATED_PAGES: new Set([
        'family', 'calendar', 'photos',
        'chores', 'rewards', 'locations',
        'voice-ai',
        // video-feeds is intentionally NOT here (2026-07-22): HA camera feeds are a
        // core HA capability available to ALL HA users, independent of Dashie
        // subscription/trial state — an expired or ha_only account still sees them.
    ]),

    /**
     * The Dashie Cloud dashboard pages hidden for an ha_only (voice-only)
     * account. Deliberately EXCLUDES voice-ai / video-feeds / credits / api-keys
     * — those are the voice/AI product an ha_only user keeps. When the user
     * starts the dashboard trial (status → 'trialing'), isHaOnly() goes false
     * and these reappear.
     */
    HA_ONLY_HIDDEN_PAGES: new Set([
        'family', 'calendar', 'photos',
        'chores', 'rewards', 'locations', 'scheduled-actions',
    ]),

    /** Subscription state — set by SubscribeGate after check-subscription. */
    _subscriptionState: null,

    /**
     * Called by SubscribeGate when the subscription check resolves.
     * Updates the entitlement-valid flag and triggers a sidebar re-render
     * so newly-hidden items disappear on the same tick.
     */
    setSubscriptionState(state) {
        this._subscriptionState = state || null;
        if (typeof App !== 'undefined' && App.renderPage) App.renderPage();
    },

    /** True if the user currently has a valid entitlement. Optimistic
     *  default (true) so we don't flash-hide items during initial load. */
    hasEntitlement() {
        const state = this._subscriptionState;
        if (!state) return true; // optimistic — assume entitled until told otherwise
        const status = state.subscription_status;
        if (status === 'trial_expired') return false;
        if (status === 'canceled') {
            const exp = state.tier_expires_at ? new Date(state.tier_expires_at).getTime() : 0;
            return !(exp > 0 && exp < Date.now());
        }
        return true;
    },

    /** True if the given page route should be visible in the current env. */
    isPageEnabled(page) {
        if (this.isChickadeeBuild()) {
            if (this.CHICKADEE_HIDDEN_PAGES.has(page)) return false;
            const key = this.PAGE_FEATURE[page];
            // Dashie plan/trial entitlement gating doesn't exist in the open
            // build — visibility is the feature rules only; credits are
            // enforced server-side per metered call.
            return !(key && !this.shouldShow(key));
        }
        const key = this.PAGE_FEATURE[page];
        if (key && !this.shouldShow(key)) return false;
        if (this.isHaOnly() && this.HA_ONLY_HIDDEN_PAGES.has(page)) return false;
        if (!this.hasEntitlement() && this.ENTITLEMENT_GATED_PAGES.has(page)) return false;
        return true;
    },
};
