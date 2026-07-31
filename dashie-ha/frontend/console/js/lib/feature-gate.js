/* ============================================================
   Feature Gate — per-EDITION visibility rules for the console.
   One shared console, two editions: the PUBLISHED build (the
   inspectable core that ships in the Dashie for Home Assistant
   add-on) and the FULL build (published core + the closed family
   delta: calendar, chores, family, photos, …).

   Renamed from a brand axis to an edition axis on 2026-07-30 —
   same boundary, correct name. See CONSOLE_ISOLATION.md.

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
     * Truthy in the PUBLISHED console build — the inspectable core shipped by
     * the Dashie for Home Assistant add-on, whose brand.js declares
     * `build: 'published'`. The full (family) build declares `build: 'full'`.
     *
     * FAILS CLOSED. Before 2026-07-30 the full build's brand.js simply had no
     * `build` field, so "unknown" resolved to false → full-build behaviour →
     * every family page visible. That is the wrong direction to fail on the one
     * invariant that matters most here (I1: no family pages in the published
     * build), and it made a typo or a half-generated brand.js indistinguishable
     * from a deliberate full build. Both brand.js files now state it, and
     * anything unrecognised is treated as published (restrictive) with a loud
     * DROP so it can't be silent.
     */
    isPublishedBuild() {
        const build = (typeof BRAND !== 'undefined' && BRAND?.build) || null;
        if (build === 'published') return true;
        if (build === 'full') return false;
        if (!this._warnedUnknownBuild) {
            this._warnedUnknownBuild = true;
            console.warn(
                `DROP: unknown BRAND.build ${JSON.stringify(build)} — expected ` +
                `'published' or 'full'. Treating this as the PUBLISHED build, so the ` +
                `closed family pages stay hidden. Fix the brand.js this console was ` +
                `built with; do not rely on this fallback.`
            );
        }
        return true;
    },

    /** One-shot latch so the unknown-build DROP doesn't spam every re-render. */
    _warnedUnknownBuild: false,

    /**
     * The CLOSED DELTA: pages that do not exist in the published console at all
     * — the family product (and Dashie device management). Checked FIRST in
     * isPageEnabled, so a published build never shows these regardless of
     * account tier or entitlement.
     *
     * "Closed delta", not "hidden": in the published build these page modules
     * are ABSENT from the tree (check-console-tree.sh enforces it), and absent
     * is the stronger claim.
     */
    CLOSED_DELTA_PAGES: new Set([
        // 'devices' left this set on 2026-07-30 — the HA edition manages Dashie
        // devices too. Its family-only OPTIONS (theme, the widgets layout, cloud
        // photo sources) are gated by FAMILY_ONLY_OPTIONS instead, a finer grain.
        'family', 'calendar', 'chores', 'rewards',
        'locations', 'photos',
        // 'video-feeds' and 'preferences' LEFT this set on 2026-07-31 (single
        // add-on collapse). Both are now core-owned page modules in this tree.
        // Their visibility rules differ and are deliberate — see LOCAL_MODE_PAGES:
        // video feeds is an HA capability (no account), Preferences is
        // account-wide Dashie settings (account required, either build).
    ]),

    /**
     * LOCAL MODE whitelist — the ONLY pages reachable in the published console
     * when there is no account (`DashieAuth.isLocalMode`). Everything works
     * against the box: engine config, BYO keys, and the settings store that
     * Stage 1 moved onto /data.
     *
     * A WHITELIST, deliberately, and never to be inverted into a blocklist:
     * a page added to this console later is account-only until someone puts it
     * here on purpose. The failure mode of the other polarity is exposing an
     * account page to a signed-out user, which is the one thing this must not do.
     *
     * Not here, and why: `account`/`credits`/`account-usage` are account BY
     * DEFINITION; `scheduled-actions` renders but every operation is a cloud
     * dbRequest (contract #31), so it would show a feature that cannot save.
     */
    LOCAL_MODE_PAGES: new Set([
        'voice-ai', 'local-engines', 'api-keys',
        // video-feeds (2026-07-31): HA camera feeds belong to the HA user, not to
        // a Dashie account. Every /api/feeds/* route proxies to the integration's
        // feed_registry over the add-on's OWN HA token and touches no account —
        // which is why `requireSignedIn` came off those routes in the same change.
        // Listing it here without that server change would render the page for a
        // signed-out user and 401 all six calls.
        //
        // NOT here, deliberately: 'preferences'. It reads/writes account-wide
        // Dashie settings via DashieAuth (user_settings), so signed out there is
        // nothing to show or save. Visible in BOTH builds once signed in.
        'video-feeds',
    ]),

    /**
     * FAMILY-ONLY OPTIONS — a finer grain than CLOSED_DELTA_PAGES.
     *
     * Publishing the Devices pages (2026-07-30) surfaced a case the page-level
     * gate can't express: sections that belong in BOTH editions but offer an
     * option that only exists in the family product. The section stays; the
     * option goes. Registered here rather than as four ad-hoc isPublishedBuild()
     * branches, for the same reason CLOSED_DELTA_PAGES is a Set and not four
     * scattered checks — one place to read, one place to audit.
     *
     *   '*'      → the whole control is family-only
     *   [values] → those option values are family-only; the rest stay
     */
    FAMILY_ONLY_OPTIONS: {
        // Seasonal theme families (Halloween, Christmas). Decided family-only
        // 2026-07-06. NOTE Dark/Light is a SEPARATE control (device card Quick
        // Controls) and is unaffected.
        'display.themeFamily': '*',
        // 'widgets' IS the family dashboard — calendar/chores/photos widgets.
        // The Layout row itself stays: the HA edition uses single_panel/kiosk.
        'display.layoutMode': ['widgets'],
        // supabase = Dashie Cloud photo albums (family product).
        // google_drive = needs the Google Drive OAuth scope, which the HA
        // edition deliberately does NOT request (brand `dashie_ha` asks for
        // identity only) — so it could not work here even if offered.
        // HA Media / Immich / Unsplash stay: screensaver albums are core here.
        'photos.sourceType': ['supabase', 'google_drive'],
    },

    /**
     * Is `value` of setting `key` offered in this build? `value` omitted asks
     * about the whole control. True in the family build always — this gate only
     * ever REMOVES options from the published one.
     */
    optionAllowed(key, value) {
        if (!this.isPublishedBuild()) return true;
        const rule = this.FAMILY_ONLY_OPTIONS[key];
        if (rule === undefined) return true;
        if (rule === '*') return false;
        return !rule.includes(value);
    },

    /** Filter a [value, label] option list down to what this build offers. */
    filterOptions(key, options) {
        return (options || []).filter(o => this.optionAllowed(key, Array.isArray(o) ? o[0] : o));
    },

    /**
     * True when `page` needs an account that the current session doesn't have.
     * Always false outside local mode — signed-in users and the family build
     * are governed by the tier/entitlement rules below, not by this.
     */
    requiresAccount(page) {
        if (typeof DashieAuth === 'undefined' || !DashieAuth.isLocalMode) return false;
        return !this.LOCAL_MODE_PAGES.has(page);
    },

    /**
     * FEATURE_RULES overrides for the published build. Voice/AI and the
     * Dashie Cloud credits meter ARE the product there, so the family
     * beta-cohort gate ('beta-only') doesn't apply.
     */
    PUBLISHED_RULE_OVERRIDES: {
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
        // Video Feeds — ADD-ON ONLY (2026-07-31, John). Same shape as apiKeys and
        // localEngines: every operation goes through the add-on. FeedsApi._request
        // throws outright when !DashieAuth.isAddonMode, so on the standalone console
        // this page could only ever render an error.
        //
        // Supersedes the 2026-07-22 `true` and its reasoning ("an account without HA
        // simply has no feeds to show"). That framing was about ACCOUNTS; the real
        // constraint is the TRANSPORT — no add-on, no feed registry to reach. Access
        // tier does not enter into it: inside the add-on this is free to every HA
        // user, signed in or not (see LOCAL_MODE_PAGES).
        videoFeeds: 'addon',

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
        if (this.isPublishedBuild() && key in this.PUBLISHED_RULE_OVERRIDES) {
            rule = this.PUBLISHED_RULE_OVERRIDES[key];
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
        // Local mode (published build, no account) — checked FIRST and for every
        // build, so the whitelist governs the sidebar, `_isRoutable`, navigate()
        // and hash routing from this single point.
        if (this.requiresAccount(page)) return false;
        if (this.isPublishedBuild()) {
            if (this.CLOSED_DELTA_PAGES.has(page)) return false;
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
