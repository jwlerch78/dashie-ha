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
     * The CLOSED DELTA: pages that do not exist in the published console at all.
     * Checked FIRST in isPageEnabled, so a published build never shows these
     * regardless of account tier or entitlement.
     *
     * "Closed delta", not "hidden": membership asserts the page module is
     * ABSENT from the tree (check-console-tree.sh enforces it), and absent is
     * the stronger claim. That is why the set is EMPTY rather than retained as
     * a hiding mechanism — a present-but-hidden page belongs to
     * ENTITLEMENT_GATED_PAGES, and putting it here would make this comment lie.
     *
     * 🔴 EMPTY AS OF 2026-10-06, and kept rather than deleted. The last six
     * members — family, calendar, chores, rewards, locations, photos — left on
     * that date when the HA edition took the Dashie Cloud dashboard pages
     * (John: "i want dashie_ha_dev, but i want to merge in the calendar,
     * family, chores, photos, etc. pages"). Their files are now in this tree
     * and their <script> tags are in index.html.
     *
     * Those pages are NOT ungated by that move — they are gated on a different
     * axis: ENTITLEMENT_GATED_PAGES, which the published branch of isPageEnabled
     * now consults and which fails CLOSED on unknown subscription state. Before
     * 2026-10-06 that branch returned before ever reading it, so the set was
     * membership without enforcement.
     *
     * The Set stays because the EDITION axis is still real: it is the one place
     * to name a page that genuinely ships only in the full build, and
     * isPageEnabled's first published-branch line still reads it. Earlier
     * departures: 'devices' 2026-07-30 (its family-only OPTIONS are gated by
     * FAMILY_ONLY_OPTIONS, a finer grain); 'video-feeds' + 'preferences'
     * 2026-07-31 (single add-on collapse).
     */
    CLOSED_DELTA_PAGES: new Set([]),

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
        // 🔴 'onboarding' was here from 2026-08-01 and is GONE (2026-08-04,
        // John: "delete now — a half-mounted surface doesn't survive to beta").
        //
        // Worth one paragraph because the entry is the clearest artefact of the
        // failure it was part of: the page was whitelisted for local mode,
        // reasoned about carefully in this very comment, and had NO App.PAGES
        // entry and no reference anywhere outside its own file. Being on this
        // list made it look reachable. It never was. What it asked for — the
        // three speech-provider keys — is now on the API Keys page, which is
        // mounted.
        'voice-ai', 'local-engines', 'api-keys',
        // usage (2026-08-28): the box-local usage record, which ONLY an
        // account-less box has any other way of seeing — Supabase is unreachable
        // there, so `ai_interactions` gets nothing and /data/usage.json is the
        // whole record. Paired with LOCAL_ONLY_PAGES below, which keeps it OUT of
        // a signed-in console where Credits already hosts the (richer) cloud view.
        'usage',
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
        // devices (2026-08-03): the surface John asked for by name — "chickadee
        // console needs to be able to see online vs. offline devices and use that
        // UI" — and it had been built, shipped in the artifact, and left
        // UNREACHABLE because this whitelist was never updated. T proved it on the
        // running console: isPageEnabled('devices') === false while all nine
        // devices-*.js loaded. Authored-but-unreached, in its purest form.
        //
        // The account-coupling that would have justified omitting it is GONE:
        // the roster comes from HA via the add-on's own poll (DevicesSource), and
        // control/rename/events are gated on HA ingress identity rather than on
        // holding an account. So signed-out is now a state this page SERVES,
        // which is exactly the bar the video-feeds entry above sets.
        //
        // ⚠️ This does NOT move the landing page. `App._homePage()` returns
        // 'voice-ai' unconditionally for published builds, independent of this
        // whitelist — checked, because the 07-30 concern that created the gate was
        // the landing page silently flipping, not the page existing.
        //
        // ⚠️ 'family' and 'photos' stay OUT: their account-coupling is real and
        // untouched. This flips the one page whose coupling was removed, not the
        // class.
        'devices',
    ]),

    /**
     * ACCOUNT-LOCKED PAGES — the third gating state (2026-08-01, John).
     *
     * Signed out, a page used to have exactly two fates: reachable
     * (LOCAL_MODE_PAGES) or absent from the console entirely. Absent is the
     * right answer for the closed family delta — those modules genuinely do not
     * ship here. It is the WRONG answer for pages that exist, work, and simply
     * need a (free) account: an HA user with no Dashie account currently has no
     * way to learn that Scheduled Actions or Credits exist at all. This set is
     * the middle state — VISIBLE IN THE NAV, NOT REACHABLE — so the console can
     * say what it can do without pretending to do it.
     *
     * ── WHY THIS IS A SEPARATE SET FROM LOCAL_MODE_PAGES, and must stay one ──
     *
     * LOCAL_MODE_PAGES is a whitelist whose polarity is a SAFETY property: a
     * page is account-only until someone deliberately says otherwise, and the
     * failure mode of the other polarity is rendering an account page — with its
     * fetches, its 401s, its half-populated account UI — at a signed-out user.
     * That whitelist is re-checked in three places (the sidebar, `_isRoutable`/
     * `navigate`, and the `renderPage()` guard, which exists because renderPage
     * is reached from background timers, SSE events and CreditsService — paths
     * that never went through a navigation door).
     *
     * Membership HERE grants VISIBILITY ONLY. It is deliberately NOT consulted by
     * `requiresAccount` or `isPageEnabled`, so:
     *
     *   - adding a page here can never make it routable;
     *   - the router intercepts a locked page and renders a STUB
     *     (AccountRequiredPanel) — the real page module never executes;
     *   - if a locked page somehow reaches the renderPage() guard anyway, that
     *     guard still fires and still falls back to home, unchanged.
     *
     * "Visible" must never come to imply "functional". If a page here starts
     * genuinely working without an account, it belongs in LOCAL_MODE_PAGES and
     * should LEAVE this set — the two are mutually exclusive, and `isLocked`
     * enforces that (it is built on `requiresAccount`, which is false for
     * anything whitelisted).
     *
     * Scope is local mode only, i.e. the published build inside the add-on
     * (DashieAuth.isLocalMode is itself addon + published + unauthenticated).
     * The standalone console shows a login wall when signed out, so there is no
     * nav there to surface anything in.
     *
     * `account-usage` is deliberately absent: it is a sub-page reached from
     * Account, not a nav entry, so locking it would surface nothing.
     */
    /**
     * LOCAL-ONLY PAGES — the inverse of ACCOUNT_LOCKED_PAGES.
     *
     * ACCOUNT_LOCKED hides/locks a page that needs an account. This hides a page
     * that needs the ABSENCE of one: `usage` renders the box-local record, which a
     * signed-in console has no reason to show because Credits already hosts the
     * cloud usage view with cost and balance the local record cannot have. Two
     * "Usage" entries in one sidebar, showing different numbers for different
     * lanes, is a support ticket.
     *
     * 🔴 Gated HERE and not in the sidebar, deliberately: this file's own design
     * note says the whitelist governs the sidebar, `_isRoutable`, navigate() AND
     * hash routing "from this single point". A sidebar-only branch would leave
     * `#usage` routable on a signed-in console — visible to nobody, reachable by
     * anybody who typed it.
     */
    LOCAL_ONLY_PAGES: new Set(['usage']),

    ACCOUNT_LOCKED_PAGES: new Set([
        'credits', 'scheduled-actions', 'account', 'preferences', 'devices',
    ]),

    /**
     * ⚠️ BRAND-ARC NOTE (2026-08-01) — read before this set outlives its context.
     *
     * These five are PAY/ACCOUNT surfaces, and this set makes them VISIBLE (locked)
     * exactly where `isLocalMode` is true — i.e. the account-less add-on console.
     * That is right for **Dashie**, which keeps accounts, credits and devices and
     * wants them discoverable before sign-up.
     *
     * It is the OPPOSITE of what **Chickadee** wants. Per BRAND_ARC_STATE.md
     * (07-31 pm) Chickadee is fully open, free, BYOK-only — *no pay surfaces at
     * all*. A locked "Credits — create a free account" teaser IS a pay surface,
     * so on a Chickadee build these pages should be ABSENT, not locked.
     *
     * Deliberately NOT gated on the edition yet: Chickadee's identity (D1–D6 in
     * 20260731_CHICKADEE_INDEPENDENT_EDITION.md — applicationId, integration
     * domains, slug, distribution) is undecided, so there is nothing stable to
     * branch on and a guess would be one more thing to unpick. When that lands,
     * the Chickadee build must exclude this whole set — the same way
     * CLOSED_DELTA_PAGES excludes the family delta — rather than lock it.
     * Straddling the two is the exact failure this brand split exists to end.
     */

    /**
     * True when `page` should appear in the nav but refuse to open — the third
     * state described on ACCOUNT_LOCKED_PAGES.
     *
     * Built ON TOP OF `requiresAccount` rather than beside it, so there is still
     * ONE definition of "this session has no account for this page" (the seam
     * rule). Consequences that fall out of that, all wanted:
     *   - false whenever there is an account, and outside local mode entirely;
     *   - false for anything in LOCAL_MODE_PAGES — a working page is never locked;
     *   - false in the full/family build, which is never in local mode.
     * CLOSED_DELTA_PAGES is excluded explicitly: those modules are ABSENT from
     * this tree, and a nav entry for a page whose file does not exist would be a
     * dead end, not a teaser.
     */
    isLocked(page) {
        if (!this.requiresAccount(page)) return false;
        if (!this.ACCOUNT_LOCKED_PAGES.has(page)) return false;
        if (this.CLOSED_DELTA_PAGES.has(page)) return false;
        return true;
    },

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
     *   '*'      → the whole control needs an account
     *   [values] → those option values need an account; the rest stay
     *
     * 🔴 THE AXIS IS THE ACCOUNT, NOT THE BUILD (John, 2026-09-21):
     *   "the console can still manage a family instance, it shouldn't limit the
     *    family options. it should show both."
     *
     * This table used to key off `isPublishedBuild()`, which was wrong in the
     * case that actually matters: the add-on console can SIGN IN to a Dashie
     * account and manage that household's devices. Keying on the build hid the
     * options of the very account it was managing — a family customer running
     * the HA add-on could not set their own device's theme, and the control
     * simply did not react.
     *
     * ⚠️ This is NOT the page-level contract. `CLOSED_DELTA_PAGES` / I1 stay on
     * the BUILD axis, because those pages are not in this source tree at all —
     * that is source isolation and it is not negotiable here. This table only
     * ever governed options inside pages BOTH editions ship, which is a
     * visibility choice, and the right question for a visibility choice is
     * "whose devices am I looking at", not "which zip was I built from".
     */
    FAMILY_ONLY_OPTIONS: {
        // Seasonal theme families (Halloween, Christmas). Decided family-only
        // 2026-07-06. NOTE Dark/Light is a SEPARATE control (device card Quick
        // Controls) and is unaffected.
        'display.themeFamily': '*',
        // 'widgets' IS the family dashboard — calendar/chores/photos widgets.
        // The Layout row itself stays: the HA edition uses single_panel/kiosk.
        'display.layoutMode': ['widgets'],
        // supabase = Dashie Cloud photo albums; google_drive = Drive albums.
        // Both need an account; neither needs a particular BUILD.
        //
        // 📌 CORRECTED 2026-09-21. This entry used to say google_drive "needs
        // the Google Drive OAuth scope, which the HA edition deliberately does
        // NOT request (brand `dashie_ha` asks for identity only)". That is not
        // merely stale, it is structurally impossible: sign-in does not vary by
        // edition at all — `console-auth.js` contains ZERO `BRAND.` references
        // and both editions share it, requesting one fixed scope string that
        // includes `drive.file` (console-auth.js:839). There is no per-edition
        // OAuth client here to differ. A justification nobody could have
        // checked is how a product decision acquires a technical-sounding
        // reason it never had.
        // HA Media / Immich / Unsplash stay: screensaver albums are core here.
        'photos.sourceType': ['supabase', 'google_drive'],
    },

    /**
     * Is `value` of setting `key` offered here? `value` omitted asks about the
     * whole control. True whenever an account is being managed — this gate only
     * ever REMOVES options from an account-less console.
     */
    /**
     * Is this console managing a Dashie ACCOUNT?
     *
     * FAILS CLOSED, for the same reason isPublishedBuild() does: if we cannot
     * tell, assume there is no account and keep the account-only options out.
     * `isLocalMode` is DashieAuth's one definition of "add-on, published build,
     * genuinely nobody signed in" — deliberately reused rather than re-derived,
     * since a second hand-rolled copy of a three-part predicate is exactly the
     * seam rule's failure mode (console-auth.js says so at its own definition).
     */
    hasAccount() {
        if (typeof DashieAuth === 'undefined') return false;
        return DashieAuth.isLocalMode !== true;
    },

    optionAllowed(key, value) {
        if (this.hasAccount()) return true;
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
        // scheduledActions (2026-08-01, John): OFF 'alpha-only' here.
        //
        // Not a product expansion — a repair. ACCOUNT_LOCKED_PAGES makes
        // 'scheduled-actions' VISIBLE-but-locked signed out, but the family rule is
        // 'alpha-only', so a standard-tier user saw it locked, signed in to unlock
        // it, and watched it DISAPPEAR. Signing in must never remove a feature you
        // were just shown. The locked set cannot express "would be visible if you
        // had the tier" — signed out there is no specialAccess to test — so the
        // repair belongs on the rule, not on the lock.
        //
        // Scoped to the published build ONLY: the family build's 'alpha-only'
        // (FEATURE_RULES) is untouched, so this changes nothing for Dashie users.
        scheduledActions: true,

        // 🔴 `locations` IS DELIBERATELY ABSENT. Do not add it.
        //
        // John, 2026-10-06, asked directly: **"Locations should stay alpha
        // gated."** So a signed-in, fully-entitled STANDARD add-on user sees
        // calendar, family and photos — and not locations, chores or rewards.
        //
        // Recorded here because an absence is indistinguishable from an
        // oversight, and this one looks exactly like one: `locations` is
        // 'alpha-only' (FEATURE_RULES:524) in a build where two of its siblings
        // got explicit overrides, so the obvious reading of this block is that
        // somebody forgot it. Two facts make it a position instead:
        //
        //   1. THE scheduledActions PRECEDENT ABOVE DOES NOT APPLY. That one was
        //      a bug fix, not a product decision: 'scheduled-actions' IS in
        //      ACCOUNT_LOCKED_PAGES, so a standard user saw it locked, signed in
        //      to unlock it, and watched it vanish — "signing in must never
        //      remove a feature you were just shown". `locations` is NOT in
        //      ACCOUNT_LOCKED_PAGES, so it is never shown and then taken away,
        //      and there is no defect of that shape to repair.
        //
        //   2. NOBODY LOSES ANYTHING EITHER WAY. Before 2026-10-06 `locations`
        //      was in CLOSED_DELTA_PAGES and hidden in this build
        //      unconditionally. Leaving it alpha-only puts standard users exactly
        //      where they already were; alpha users GAIN it. So this is additive
        //      whichever way it goes, which is why it was safe to put to John as
        //      a product question rather than treated as a regression.
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

        // Credits / token-bank / BYOK.
        //
        // ⚠️ 2026-10-02 (John): back to ALPHA for the HA console's first release.
        // Not because the feature is unready — because metered credits are a
        // harder sell into the HA community as an opening move, and surface we
        // do not show is surface we do not have to debug. Reversible in one
        // word: this is a gate, NOT a removal, and every credits code path is
        // intact behind it.
        //
        // History: alpha → beta on 2026-07-03 (access-tier restructure), beta →
        // alpha here. Nothing about the beta cohort changed; the release did.
        credits:    'alpha-only',

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
     * 🔴 ENTITLEMENT_GATED_PAGES members that are NOT entitlement-gated in the
     * PUBLISHED build. Read only by the published branch of isPageEnabled.
     *
     * Why this exists (2026-10-06, caught by check-entitlement-gate.mjs leg 6 on
     * its first run): `voice-ai` is in the set above because in the FULL build it
     * is part of the paid bundle. In the published HA build it is the opposite —
     * it is the free product:
     *   • PUBLISHED_RULE_OVERRIDES.voiceAi = true (deliberately off 'beta-only')
     *   • it is in LOCAL_MODE_PAGES, i.e. reachable with NO account at all
     *   • App._homePage() returns it unconditionally for this build, and its
     *     comment calls it "the only home that works signed out"
     *
     * So applying the entitlement set wholesale in the published branch hid the
     * add-on's HOME PAGE from every account-less user, permanently, and from
     * every signed-in user until check-subscription resolved. The build plan's
     * snippet did exactly that and read as correct.
     *
     * ⚠️ This is an edition-scoped exemption, the same shape and the same reason
     * as PUBLISHED_RULE_OVERRIDES above — NOT a removal from
     * ENTITLEMENT_GATED_PAGES, which would wrongly free voice-ai in the paid
     * build too. check-entitlement-gate leg 9 pins that it does not leak.
     *
     * A page belongs here only if it is genuinely free in the HA edition. The
     * six dashboard pages (family/calendar/photos/chores/rewards/locations) are
     * the paid product and must never be added.
     */
    PUBLISHED_ENTITLEMENT_EXEMPT: new Set(['voice-ai']),

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
        // The inverse gate: a local-only page is unreachable WITH an account.
        if (this.LOCAL_ONLY_PAGES.has(page) &&
            !(typeof DashieAuth !== 'undefined' && DashieAuth.isLocalMode === true)) return false;
        if (this.isPublishedBuild()) {
            if (this.CLOSED_DELTA_PAGES.has(page)) return false;
            // 🔴 ENTITLEMENT, IN THE PUBLISHED BUILD TOO (2026-10-06).
            //
            // Until this date the published branch returned below without ever
            // reading ENTITLEMENT_GATED_PAGES or HA_ONLY_HIDDEN_PAGES, and the
            // comment here said plan/trial gating "doesn't exist in the open
            // build". That was true while the dashboard pages were absent from
            // this tree. They are present now, and John's rule for them is:
            //   "those items should only become visible when the user is logged
            //    into an active dashie account."
            // Both sets already listed all six pages correctly, so the defect
            // was never the membership — it was that nothing read it. A correct
            // Set whose reader never runs is not a gate.
            if (this.ENTITLEMENT_GATED_PAGES.has(page) &&
                !this.PUBLISHED_ENTITLEMENT_EXEMPT.has(page)) {
                // 🔴 THIS LINE IS THE LOAD-BEARING ONE — do not "simplify" it
                // into hasEntitlement(), which is deliberately OPTIMISTIC
                // (null state ⇒ entitled) so the full build doesn't flash-hide
                // during initial paint. Optimism is the wrong polarity here: a
                // network blip on check-subscription leaves _subscriptionState
                // null, and the optimistic branch would then SHOW the paid
                // dashboard pages inside the free add-on — failing OPEN on
                // exactly the invariant John set. Unknown ⇒ hidden.
                //
                // Same reasoning as isPublishedBuild() above, whose comment
                // calls the other direction "the wrong direction to fail on the
                // one invariant that matters most". hasEntitlement() is NOT
                // changed globally; the known-state requirement is local to here.
                if (!this._subscriptionState) return false;
                if (!this.hasEntitlement()) return false;
                // An ha_only (voice-only) account has a live entitlement for the
                // voice product and none for the dashboard, so it is a separate
                // question from hasEntitlement() and asked separately.
                if (this.isHaOnly() && this.HA_ONLY_HIDDEN_PAGES.has(page)) return false;
            }
            const key = this.PAGE_FEATURE[page];
            // Cohort (tier x rollout) is a THIRD axis, independent of the two
            // above: 'chores'/'rewards' remain 'alpha-only' by John's 2026-10-06
            // ruling, so a signed-in fully-entitled STANDARD user sees calendar,
            // family, photos and locations but not those two. Intended.
            // Credits stay enforced server-side per metered call.
            return !(key && !this.shouldShow(key));
        }
        const key = this.PAGE_FEATURE[page];
        if (key && !this.shouldShow(key)) return false;
        if (this.isHaOnly() && this.HA_ONLY_HIDDEN_PAGES.has(page)) return false;
        if (!this.hasEntitlement() && this.ENTITLEMENT_GATED_PAGES.has(page)) return false;
        return true;
    },
};
