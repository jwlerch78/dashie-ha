/* ============================================================
   Dashie Console — App Router
   ============================================================ */

const App = {
    _currentPage: 'devices',
    _sidebarOpen: false,
    _refreshing: false,           // true while a title-bar page refresh is in flight
    _deletionScheduledAt: null,   // global "scheduled for deletion" banner state
    _deletionPollTimer: null,

    pages: {
        // Delta pages (typeof-guarded): these modules exist only in the Dashie
        // build — the open-core console ships without their files, the guard
        // resolves to null, and renderPage/navigate treat a null page as
        // unregistered. Core pages below keep bare references so a missing
        // core file fails loudly at load.
        devices:       { page: typeof DevicesPage       !== 'undefined' ? DevicesPage       : null },
        preferences:   { page: typeof PreferencesPage   !== 'undefined' ? PreferencesPage   : null },
        'video-feeds': { page: typeof VideoFeedsPage    !== 'undefined' ? VideoFeedsPage    : null },
        family:        { page: typeof FamilyPage        !== 'undefined' ? FamilyPage        : null },
        calendar:      { page: typeof CalendarPage      !== 'undefined' ? CalendarPage      : null },
        chores:        { page: typeof ChoresPage        !== 'undefined' ? ChoresPage        : null },
        rewards:       { page: typeof RewardsPage       !== 'undefined' ? RewardsPage       : null },
        locations:     { page: typeof LocationsPage     !== 'undefined' ? LocationsPage     : null },
        photos:        { page: typeof PhotosPage        !== 'undefined' ? PhotosPage        : null },
        // Core pages (present in every build)
        'voice-ai':    { page: VoiceAiPage },
        'scheduled-actions': { page: ScheduledActionsPage },
        account:       { page: AccountPage },
        credits:       { page: CreditsPage },
        'api-keys':    { page: ApiKeysPage },
        'local-engines': { page: LocalEnginesPage },
    },

    async init() {
        // If we just landed here after a successful account deletion, show
        // a one-time goodbye toast and strip the query param so a refresh
        // doesn't re-fire it. Done before auth init so it shows even if
        // the rest of init takes time.
        this._consumeDeletedParam();

        // Stash any `?next=` return intent (external entry pages pass it —
        // e.g. the Dashie build's checkout page) before auth, so it survives
        // the Google OAuth round-trip. Honored once authed.
        this._captureNextParam();

        // NOTE: the dropdown-options catalog fetch deliberately does NOT run
        // here. It is the only network call the console could make before
        // sign-in, and PRIVACY.md promises no startup phone-home — so it is
        // kicked off from _showApp(), i.e. only once auth is known good.
        // Bundled fallback values cover the signed-out console entirely.
        // See js/lib/option-catalog.js.

        // Wire up auth state change callback
        DashieAuth.onAuthStateChange = (isAuth) => {
            if (isAuth) {
                // Kick off profile load (tier + special_access) in parallel
                // with the first paint — FeatureGate's 'alpha-only' rule
                // depends on this. Re-render once it lands so any
                // alpha-gated UI flips visibility correctly.
                DashieAuth.loadUserProfile().then(() => this.renderPage()).catch(() => {});
                this._showApp();
                // Subscribe-prompt gate: if the user has no current entitlement
                // (trial expired / canceled past expiry), show the prompt.
                // Fire-and-forget — runs in background after first paint.
                if (typeof SubscribeGate !== 'undefined') SubscribeGate.checkAndShow();
            } else {
                this._showSignedOut();
            }
        };

        // Initialize auth (checks localStorage for JWT, handles OAuth callback)
        try {
            const result = await DashieAuth.init();

            // Add-on funnel banner: the add-on installed/updated its HA
            // integration and core needs a restart to load it. Only renders
            // when the runtime advertises the flag (the Dashie for HA add-on
            // does) — absent field = no-op for every other build.
            this._renderIntegrationRestartBanner();

            // If init returned a promise (OAuth callback), it handled the redirect
            if (result === true) {
                // OAuth callback was handled — JWT is now set.
                // Honor a pending purchase return-intent before showing the app.
                if (this._honorPostLoginNext()) return;
                DashieAuth.loadUserProfile().then(() => this.renderPage()).catch(() => {});
                this._showApp();
                if (typeof SubscribeGate !== 'undefined') SubscribeGate.checkAndShow();
                return;
            }
        } catch (e) {
            console.error('[App] Auth init error:', e);
        }

        if (DashieAuth.isAuthenticated) {
            // Honor a pending purchase return-intent before showing the app.
            if (this._honorPostLoginNext()) return;
            DashieAuth.loadUserProfile().then(() => this.renderPage()).catch(() => {});
            this._showApp();
            if (typeof SubscribeGate !== 'undefined') SubscribeGate.checkAndShow();
        } else {
            this._showSignedOut();
        }
    },

    // ── Global "scheduled for deletion" banner ───────────────────────

    /** Fetch the account's deletion state; show the persistent banner while
     *  pending, and sign out if the account has since been hard-deleted. */
    async _checkDeletionState() {
        if (!DashieAuth.isAuthenticated) return;
        let resp;
        try {
            resp = await DashieAuth.edgeFunctionRequest('check-subscription', { auth_user_id: DashieAuth.jwtUserId });
        } catch (_) { return; }   // transient — don't act on a network blip
        // Were tracking a pending deletion and the profile is now gone (hard-
        // deleted → null status)? The cron / another session finished it — sign out.
        if (this._deletionScheduledAt && (!resp || resp.subscription_status == null)) {
            this._onAccountDeleted();
            return;
        }
        this._deletionScheduledAt = resp?.deletion_scheduled_at || null;
        this._renderGlobalBanner();
        this._syncDeletionPoll();
    },

    _syncDeletionPoll() {
        const pending = !!this._deletionScheduledAt;
        if (pending && !this._deletionPollTimer) {
            this._deletionPollTimer = setInterval(() => this._checkDeletionState(), 30000);
        } else if (!pending && this._deletionPollTimer) {
            clearInterval(this._deletionPollTimer);
            this._deletionPollTimer = null;
        }
    },

    _renderGlobalBanner() {
        const el = document.getElementById('global-banner');
        if (el) el.innerHTML = this._deletionBannerHtml() || this._integrationRestartBannerHtml();
    },

    _deletionBannerHtml() {
        const at = this._deletionScheduledAt;
        if (!at) return '';
        const when = new Date(at);
        const mins = Math.max(0, Math.round((when.getTime() - Date.now()) / 60000));
        const label = mins < 120
            ? `in ${mins} minute${mins === 1 ? '' : 's'}`
            : `on ${when.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;
        return `
            <div style="background: var(--status-error, #c00); color:#fff; padding:10px 16px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
                <div style="font-size:14px; font-weight:500;">⚠ Your account is scheduled for deletion <strong>${label}</strong>. All data will be permanently removed.</div>
                <div style="display:flex; gap:8px; flex-shrink:0;">
                    <button class="btn btn-sm" style="background:#fff; color:var(--status-error,#c00); font-weight:600; border:none;" onclick="App.keepAccount()">Keep account</button>
                    <button class="btn btn-sm" style="background:transparent; color:#fff; border:1px solid rgba(255,255,255,0.7);" onclick="App.deleteNow()">Delete now</button>
                </div>
            </div>`;
    },

    /** "Keep account" — cancel the pending deletion. */
    async keepAccount() {
        try {
            await DashieAuth.dbRequest('cancel_account_deletion', {});
            this._deletionScheduledAt = null;
            this._renderGlobalBanner();
            this._syncDeletionPoll();
            if (typeof Toast !== 'undefined') Toast.success('Your account has been restored.');
            if (this._currentPage === 'account' && typeof AccountPage !== 'undefined' && AccountPage._data) {
                AccountPage._data.deletion_scheduled_at = null;
                this.renderPage();
            }
        } catch (e) {
            if (typeof Toast !== 'undefined') Toast.error('Could not restore account: ' + (e?.message || e));
        }
    },

    /** "Delete now" — hard-delete immediately (skips the remaining grace). */
    async deleteNow() {
        const ok = await ConfirmModal.confirm({
            title: 'Delete account now?',
            message: 'This permanently deletes your account and ALL data right now — calendars, photos, family, devices, everything. This cannot be undone.',
            confirmLabel: 'Delete now',
            cancelLabel: 'Cancel',
            danger: true,
        });
        if (!ok) return;
        try {
            const r = await DashieAuth.dbRequest('delete_account_now', {});
            if (r?.deleted !== true) throw new Error(r?.error || 'Deletion did not complete');
            this._onAccountDeleted();
        } catch (e) {
            if (typeof Toast !== 'undefined') Toast.error('Delete failed: ' + (e?.message || e));
        }
    },

    /** Tear down the session + redirect to login after the account is gone. */
    _onAccountDeleted() {
        if (this._deletionPollTimer) { clearInterval(this._deletionPollTimer); this._deletionPollTimer = null; }
        try { localStorage.clear(); } catch (_) {}
        try { sessionStorage.clear(); } catch (_) {}
        try { DashieAuth.signOut?.(); } catch (_) {}
        window.location.replace(window.location.origin + window.location.pathname + '?deleted=1');
    },

    /**
     * One-shot handler for `?deleted=1` query param after a successful
     * Delete Account flow. Shows a goodbye toast, then strips the param so
     * a refresh doesn't re-trigger. Called from init() before auth bootstrap.
     */
    _consumeDeletedParam() {
        try {
            const params = new URLSearchParams(window.location.search);
            if (params.get('deleted') === '1') {
                // Toast may not be loaded if scripts loaded out of order — guard.
                if (typeof Toast !== 'undefined') {
                    Toast.info(`Your ${BRAND.productName} account has been deleted. Thanks for trying ${BRAND.productName}.`);
                } else {
                    // Fallback for the (unusual) case where Toast hasn't loaded yet
                    setTimeout(() => {
                        if (typeof Toast !== 'undefined') {
                            Toast.info(`Your ${BRAND.productName} account has been deleted. Thanks for trying ${BRAND.productName}.`);
                        }
                    }, 200);
                }
                params.delete('deleted');
                const newSearch = params.toString();
                const cleanUrl = window.location.pathname + (newSearch ? '?' + newSearch : '') + window.location.hash;
                window.history.replaceState({}, '', cleanUrl);
            }
        } catch (_) { /* non-fatal */ }
    },

    // ── Post-login return intent (`?next=`) ──────────────────────────
    // External entry pages bounce unauthenticated users here so they can
    // sign in with Google, passing `?next=<path>` (the page to return to —
    // the Dashie build's checkout flow uses this). We stash it before auth
    // and, once authenticated, redirect there instead of showing the
    // console, so the originating flow has no dead end.

    _NEXT_STORAGE_KEY: 'dashie-post-login-next',

    /** Capture `?next=` into sessionStorage so it survives the OAuth round-trip.
     *  Called from init() before auth bootstrap. */
    _captureNextParam() {
        try {
            const next = new URLSearchParams(window.location.search).get('next');
            if (next) sessionStorage.setItem(this._NEXT_STORAGE_KEY, next);
        } catch (_) { /* non-fatal */ }
    },

    /** If a return intent is stashed, redirect to it and return true. Only
     *  same-origin relative paths are honored (open-redirect guard). */
    _honorPostLoginNext() {
        let next;
        try {
            next = sessionStorage.getItem(this._NEXT_STORAGE_KEY);
            if (next) sessionStorage.removeItem(this._NEXT_STORAGE_KEY);
        } catch (_) { return false; }
        if (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) {
            window.location.replace(next);
            return true;
        }
        return false;
    },

    /**
     * Wire SettingsSync to Console's Supabase client + the authenticated
     * user. Console-auth lazily creates a Supabase realtime client for
     * its own broadcasts; we reuse it so we share the websocket. Fires
     * one-shot; subsequent _showApp() calls (re-auth, etc.) are no-ops
     * because SettingsSync.connect() is itself idempotent.
     */
    _connectSettingsSync() {
        try {
            if (!window.SettingsSync) {
                console.warn('[App] SettingsSync not loaded — skipping realtime sync wiring');
                return;
            }
            const userId = DashieAuth.user && DashieAuth.user.id;
            if (!userId) {
                console.warn('[App] SettingsSync wiring skipped — no user id');
                return;
            }
            const sbClient = DashieAuth._getSupabaseClient
                ? DashieAuth._getSupabaseClient()
                : null;
            if (!sbClient) {
                console.warn('[App] SettingsSync wiring skipped — Supabase client unavailable');
                return;
            }
            window.SettingsSync.configure(sbClient, userId);
            window.SettingsSync.connect();
        } catch (e) {
            console.warn('[App] SettingsSync wiring failed (non-fatal)', e && e.message);
        }
    },

    /**
     * "Restart Home Assistant to activate the integration" banner + one-click
     * restart (POST api/system/restart-core). Shown pre- and post-login (the
     * #global-banner div lives outside #content). After the restart is issued,
     * polls api/runtime until the pending flag clears, then reloads.
     */
    /** '' unless the add-on says its integration awaits activation. Two states:
     *  (1) core hasn't restarted → "Restart Home Assistant"; (2) core restarted
     *  and the discovery "Configure" card is parked unclicked → "Configure"
     *  (the banner absorbs the click via /api/system/configure-integration, so
     *  the user never has to find the card under Settings → Devices & Services).
     *  integration_discovered_pending is absent on older add-ons → falls through
     *  to the restart state (unchanged behavior). */
    /** Shared banner shell so the three integration states look identical. */
    _integrationBannerShell(spanHtml, buttonHtml) {
        return `
            <div class="integration-restart-banner" style="display:flex; align-items:center; justify-content:center; gap:14px; flex-wrap:wrap; padding:10px 16px; background: var(--accent-bg, rgba(44,110,206,0.08)); border: 1px solid var(--accent, #2C6ECE); border-radius: 8px; font-size:14px; text-align:left;">
                <span style="flex:1; min-width:220px;">${spanHtml}</span>
                ${buttonHtml}
            </div>`;
    },

    _integrationRestartBannerHtml() {
        const info = typeof DashieAuth !== 'undefined' && DashieAuth._addonRuntimeInfo;
        if (!info) return '';
        // State 1: integration installed but not loaded → activate. Sub-state:
        // the discovery card is parked → absorb the click (one-click Configure).
        if (info.integration_pending_restart === true) {
            if (info.integration_discovered_pending === true) {
                return this._integrationBannerShell(
                    `✅ ${BRAND.productName} is discovered in Home Assistant — <b>finish setup</b> to activate voice &amp; AI.`,
                    `<button class="btn btn-primary btn-sm" onclick="App._configureIntegrationFromBanner(this)">Configure ${BRAND.productName}</button>`);
            }
            return this._integrationBannerShell(
                `✅ The ${BRAND.productName} integration is installed — <b>restart Home Assistant</b> to activate it. You'll then get a one-click "Configure" button here.`,
                `<button class="btn btn-primary btn-sm" onclick="App._restartCoreFromBanner(this)">Restart Home Assistant</button>`);
        }
        // State 2: integration loaded, but the add-on has re-copied a newer
        // version that this loaded code predates → restart to apply. Self-clears
        // once the restart reloads the integration. Absent on older add-ons.
        if (info.integration_update_pending_restart === true) {
            return this._integrationBannerShell(
                `🔄 A ${BRAND.productName} integration update is ready — <b>restart Home Assistant</b> to apply it.`,
                `<button class="btn btn-primary btn-sm" onclick="App._restartCoreFromBanner(this, true)">Restart Home Assistant</button>`);
        }
        return '';
    },

    _renderIntegrationRestartBanner() {
        const html = this._integrationRestartBannerHtml();
        if (!html) return;
        // Authed chrome: the strip above the content area. NOTE renderPage()
        // also rewrites #global-banner — its slot composition includes this
        // banner, so the two writers agree.
        const el = document.getElementById('global-banner');
        if (el) el.innerHTML = html;
        // Login screen: the overlay is position:absolute inset:0 and COVERS
        // #global-banner (the funnel's restart step is usually reached
        // pre-login, which is exactly when it must be visible) — so also
        // render a copy at the top of the login card.
        const card = document.getElementById('login-card');
        if (card && !card.querySelector('.integration-restart-banner')) {
            card.insertAdjacentHTML('afterbegin', html + '<div style="height:14px"></div>');
        }
    },

    async _restartCoreFromBanner(btn, updateMode = false) {
        // Explicit consent before touching Core — restarting HA interrupts
        // every automation/dashboard for ~a minute.
        const confirmed = typeof ConfirmModal !== 'undefined'
            ? await ConfirmModal.confirm({
                title: 'Restart Home Assistant?',
                message: updateMode
                    ? 'Home Assistant will restart to apply the integration update. Automations and dashboards will be unavailable for about a minute.'
                    : 'Home Assistant will restart to activate the integration. Automations and dashboards will be unavailable for about a minute.',
                confirmLabel: 'Restart Home Assistant',
                cancelLabel: 'Not now',
            })
            : window.confirm('Restart Home Assistant now? It will be unavailable for about a minute.');
        if (!confirmed) return;
        document.querySelectorAll('.integration-restart-banner button').forEach(b => {
            b.disabled = true; b.textContent = 'Restarting… (about a minute)';
        });
        if (btn) { btn.disabled = true; }
        try {
            await fetch(DashieAuth._addonUrl('/api/system/restart-core'), { method: 'POST' });
        } catch (e) { /* the restart drops connections — expected */ }
        // Poll until HA is back, then reload. The "done" transition differs by
        // flow: an update-apply restart clears integration_update_pending_restart;
        // an activate restart clears pending_restart (or parks the discovery card,
        // whose one-click Configure state the reload should surface).
        const poll = setInterval(async () => {
            try {
                const r = await fetch(DashieAuth._addonUrl('/api/runtime'), { cache: 'no-store' });
                if (r.ok) {
                    const j = await r.json();
                    const done = updateMode
                        // Wait for the integration to be LOADED again with the
                        // new code — not the transient mid-restart window where
                        // it's unloaded (pending true) and update_pending reads
                        // false only because nothing is loaded to compare.
                        ? (j.integration_pending_restart === false && j.integration_update_pending_restart === false)
                        : (j.integration_pending_restart === false || j.integration_discovered_pending === true);
                    if (done) {
                        clearInterval(poll);
                        window.location.reload();
                    }
                }
            } catch (e) { /* still restarting */ }
        }, 5000);
    },

    /** "Configure" — complete the parked discovery flow so the integration
     *  loads, without the user hunting for the card under Settings → Devices
     *  & Services. The add-on drives the flow via its Supervisor session. */
    async _configureIntegrationFromBanner(btn) {
        document.querySelectorAll('.integration-restart-banner button').forEach(b => {
            b.disabled = true; b.textContent = 'Configuring…';
        });
        if (btn) { btn.disabled = true; }
        try {
            const resp = await fetch(DashieAuth._addonUrl('/api/system/configure-integration'), { method: 'POST' });
            const j = await resp.json().catch(() => ({}));
            if (resp.ok && j.ok) {
                // Refresh the cached runtime so the banner clears, then reload
                // into the now-configured console.
                try {
                    const r = await fetch(DashieAuth._addonUrl('/api/runtime'), { cache: 'no-store' });
                    if (r.ok) DashieAuth._addonRuntimeInfo = await r.json();
                } catch (_) {}
                window.location.reload();
                return;
            }
            throw new Error(j.error || `HTTP ${resp.status}`);
        } catch (e) {
            if (typeof Toast !== 'undefined') Toast.error('Could not finish setup: ' + (e?.message || e) + '. You can also complete it under Settings → Devices & Services.');
            document.querySelectorAll('.integration-restart-banner button').forEach(b => {
                b.disabled = false; b.textContent = `Configure ${BRAND.productName}`;
            });
        }
    },

    /** Signed-out router — ONE decision point, on purpose.
     *
     *  On the published build reached over HA ingress, "no Dashie account" is a
     *  normal operating mode (your own engines, nothing hosted), not a locked
     *  door — so render the REAL console, with the account-only surfaces gated.
     *  Home Assistant already authenticated this person; a second login here was
     *  identity for billing, demanded of someone who isn't billing.
     *
     *  This replaced a landing card (2026-07-30). The card *asserted* "no account
     *  required" instead of showing it, and its one actionable element — a deep
     *  link to the add-on's Configuration page — 404'd on the first real box.
     *  The convincing artifact is the console working, with the paid tier as the
     *  only thing greyed out.
     *
     *  Everywhere else the account IS the product — the family build and the
     *  plain web console both keep the login screen. Any failure falls through
     *  to _showLogin(), so the worst case is today's behaviour.
     *
     *  Three call sites used to hard-code _showLogin(); they all come here now
     *  rather than each growing its own copy of this rule. */
    _showSignedOut() {
        try {
            if (DashieAuth.isLocalMode) {
                this._showApp({ localMode: true });
                return;
            }
        } catch (e) {
            console.warn('[App] DROP: local-mode render failed, falling back to login', e);
        }
        this._showLogin();
    },

    _showLogin() {
        // Tear down any background pollers left running from a previously
        // authed session (devices auto-refresh interval, fresh-device poll,
        // SSE event stream). Otherwise they keep hitting now-unauthenticated
        // endpoints and — before the renderPage() auth guard — would repaint
        // the dashboard over this login screen.
        try { if (typeof DevicesPage !== 'undefined') DevicesPage._stopPollers?.(); } catch (_) {}
        try { if (typeof DevicesEvents !== 'undefined') DevicesEvents.stop?.(); } catch (_) {}

        document.getElementById('sidebar').innerHTML = '';
        document.getElementById('top-bar').innerHTML = '';
        const addonMode = DashieAuth.isAddonMode;
        const onClick = addonMode ? 'App._handleAddonSignIn()' : 'DashieAuth.signIn()';

        // Purchase-intent login copy (delta): the Dashie checkout page sends
        // buyers here to sign in first, and the delta tailors the login copy
        // so it's clear which account to use. Absent module → null → defaults.
        const purchase = window.SubscribeGate?.loginPurchaseCopy?.() || null;

        const title = addonMode ? `Sign in to ${BRAND.productName}`
            : purchase ? purchase.title
            : `Welcome to ${BRAND.consoleName}`;
        const subtitle = addonMode
            ? `Connect your Home Assistant to your ${BRAND.productName} account.`
            : purchase ? purchase.subtitle
            : 'Manage your devices, household, and account from any browser.';
        const publishedBuild = typeof FeatureGate !== 'undefined' && FeatureGate.isPublishedBuild();
        const googleDesc = purchase
            ? purchase.googleDesc
            : publishedBuild
            ? `Sign in — or create your ${BRAND.productName} account`
            : `Use your ${BRAND.productName} account`;

        // Email/password path — live only when the add-on's runtime advertises
        // it (email_auth in /api/runtime; the Dashie for HA add-on does, the Dashie
        // add-on and the standalone web console don't yet).
        const emailAvailable = addonMode
            && typeof LoginEmail !== 'undefined' && LoginEmail.isAvailable();

        document.getElementById('content').innerHTML = `
            <div class="dashie-login-overlay">
                <div class="dashie-login-card" id="login-card">
                    <img src="${BRAND.logo}" alt="${BRAND.productName}" class="dashie-login-logo">
                    <div class="dashie-login-title">${title}</div>
                    <div class="dashie-login-subtitle">${subtitle}</div>

                    <div class="dashie-login-buttons">
                        <button class="dashie-path-btn primary" onclick="${onClick}">
                            <span class="dashie-path-icon">
                                <svg width="36" height="36" viewBox="0 0 48 48">
                                    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                                    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                                    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                                    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                                </svg>
                            </span>
                            <span class="dashie-path-text">
                                <span class="dashie-path-label">Sign in with Google</span>
                                <span class="dashie-path-desc">${googleDesc}</span>
                            </span>
                        </button>

                        <div class="dashie-path-divider"><span>or</span></div>

                        <button class="dashie-path-btn secondary${emailAvailable ? '' : ' disabled'}"
                                ${emailAvailable ? 'onclick="LoginEmail.show()"' : 'disabled'}>
                            <span class="dashie-path-icon dashie-path-icon-email">
                                <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
                                </svg>
                            </span>
                            <span class="dashie-path-text">
                                <span class="dashie-path-label">Sign in with Email</span>
                                <span class="dashie-path-desc">${emailAvailable ? 'Use your email and password' : 'Coming soon'}</span>
                            </span>
                        </button>
                    </div>

                    <div class="dashie-login-footer">
                        <div class="dashie-login-legal">
                            <a href="${BRAND.urls.privacy}" target="_blank" rel="noopener">Privacy Policy</a>
                            <span class="dashie-legal-sep">&bull;</span>
                            <a href="${BRAND.urls.terms}" target="_blank" rel="noopener">Terms of Service</a>
                        </div>
                        ${BRAND.footerNote ? `<div style="margin-top:6px; font-size:11px; color: var(--text-muted, #999);">${BRAND.footerNote}</div>` : ''}
                        <div class="dashie-login-version" id="dashie-login-version"></div>
                    </div>
                </div>
            </div>
        `;
        this._populateLoginVersion();
        document.getElementById('sidebar').style.display = 'none';
        // The overlay just replaced #content — re-inject the restart banner
        // into the fresh login card (see _renderIntegrationRestartBanner).
        this._renderIntegrationRestartBanner();
    },

    async _populateLoginVersion() {
        const el = document.getElementById('dashie-login-version');
        if (!el) return;
        // Console version is hard-coded for now; add-on exposes its version via /api/runtime.
        const consoleVersion = (window.DASHIE_CONSOLE_VERSION || '0.1.0');
        let text = `Console v${consoleVersion}`;
        if (DashieAuth.isAddonMode) {
            try {
                const info = await fetch(DashieAuth._addonUrl('/api/runtime')).then(r => r.ok ? r.json() : null);
                if (info?.version) text += ` · Add-on v${info.version}`;
            } catch (e) { /* ignore */ }
        }
        el.textContent = text;
    },

    /**
     * Start sign-in from anywhere in a RUNNING console (the top-bar menu in
     * local mode, a locked Cloud/Hybrid card). One entry point on purpose —
     * the add-on and the web console reach an account by different routes
     * (device-flow link vs Google redirect), and that fork should exist once.
     *
     * Distinct from the login SCREEN's button, which is drawn before there is a
     * console to return to; this is for a user already using the thing.
     */
    startSignIn() {
        // In LOCAL MODE the console itself is rendered, so there is no
        // #login-card in the DOM — and _showAddonWaitingScreen() bails silently
        // when it can't find one. That made the menu item a dead button: the
        // device flow started server-side and nothing ever painted.
        //
        // Show the login screen instead of starting a flow. It offers Google
        // AND email (skipping straight to the device code would silently drop
        // the email option), its buttons already route correctly per mode, and
        // Cancel returns here via _cancelAddonSignIn -> _showSignedOut, which in
        // local mode lands back on the console rather than a wall.
        if (!document.getElementById('login-card')) return this._showLogin();
        if (DashieAuth.isAddonMode) return this._handleAddonSignIn();
        return DashieAuth.signIn();
    },

    async _handleAddonSignIn() {
        try {
            const link = await DashieAuth._signInAddonMode();
            this._showAddonWaitingScreen(link);
        } catch (e) {
            console.error('[App] Sign-in start failed:', e);
            if (typeof Toast !== 'undefined') Toast.error('Could not start sign-in. Please try again.');
        }
    },

    _showAddonWaitingScreen(link) {
        const card = document.getElementById('login-card');
        if (!card) return;
        card.innerHTML = `
            <img src="${BRAND.logo}" alt="${BRAND.productName}" class="dashie-login-logo">
            <div class="dashie-login-title">Sign in with your ${BRAND.productName} account</div>
            <div class="dashie-login-subtitle">
                ${BRAND.productName} needs to authenticate outside of your Home Assistant instance.
                Tap the button below to open the sign-in page in a new tab.
                This screen will update once you've logged in there.
            </div>

            <div class="dashie-login-buttons">
                <a href="${link.verification_url}" target="_blank" rel="noopener"
                   class="dashie-path-btn primary" style="text-decoration: none;">
                    <span class="dashie-path-icon">
                        <svg width="36" height="36" viewBox="0 0 48 48">
                            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                        </svg>
                    </span>
                    <span class="dashie-path-text">
                        <span class="dashie-path-label">Open sign-in page</span>
                        <span class="dashie-path-desc">Opens in a new tab</span>
                    </span>
                </a>
            </div>

            <div class="dashie-link-code-box" style="margin-top: 20px;">
                <div class="dashie-link-code-label">Verification Code</div>
                <div class="dashie-link-code-value">${link.user_code}</div>
            </div>

            <div class="dashie-link-waiting">
                <div class="dashie-link-spinner"></div>
                <span>Waiting for approval…</span>
            </div>

            <div style="margin-top: 12px; display: flex; justify-content: center;">
                <button class="btn btn-ghost btn-sm" onclick="App._cancelAddonSignIn()">Cancel</button>
            </div>

            <div class="dashie-login-footer">
                <div class="dashie-login-legal">
                    <a href="${BRAND.urls.privacy}" target="_blank" rel="noopener">Privacy Policy</a>
                    <span class="dashie-legal-sep">&bull;</span>
                    <a href="${BRAND.urls.terms}" target="_blank" rel="noopener">Terms of Service</a>
                </div>
                ${BRAND.footerNote ? `<div style="margin-top:6px; font-size:11px; color: var(--text-muted, #999);">${BRAND.footerNote}</div>` : ''}
                <div class="dashie-login-version" id="dashie-login-version"></div>
            </div>
        `;
        this._populateLoginVersion();
    },

    async _cancelAddonSignIn() {
        await DashieAuth.cancelSignIn();
        this._showSignedOut();
    },

    /**
     * Render the console shell.
     *
     * `localMode: true` renders the SAME shell with no account behind it. Every
     * account-shaped side effect below is skipped rather than allowed to fail —
     * in particular OptionCatalog, which is the console's only pre-sign-in
     * network call and whose absence PRIVACY.md promises. "It would just 401"
     * is not good enough for a signed-out phone-home.
     */
    _showApp({ localMode = false } = {}) {
        document.getElementById('sidebar').style.display = '';

        if (!localMode) {
            // Dropdown-options catalog. Gated on auth on purpose — this is the
            // console's only pre-sign-in network call, and a signed-out phone-home
            // would falsify PRIVACY.md. Fire-and-forget; bundled fallbacks render
            // until it lands, and the signed-out console never fetches at all.
            if (typeof OptionCatalog !== 'undefined') OptionCatalog.init();

            // Connect SettingsSync now that auth is known good. Pages register
            // their consumers on first render — the manager retains them, so
            // ordering between connect() and register() doesn't matter. Fire
            // and forget; failures only mean realtime falls back to TTL.
            this._connectSettingsSync();

            // Global "scheduled for deletion" banner — fetch state + poll while pending.
            this._checkDeletionState();
        }

        if (localMode) {
            // No Dashie identity to show — but HA has one, and the add-on reports
            // it over ingress (ingress-identity.js: identity, never authorization).
            // Showing it is the honest statement of what is signing you in here.
            // ha_user is an OBJECT — {id, name, display_name} from
            // server/ingress-identity.js — not a string. Pick the printable
            // field; either name may be absent, so fall through to the id
            // rather than rendering "undefined" at a user.
            const haUser = DashieAuth.runtimeInfo?.ha_user || null;
            const haName = haUser ? (haUser.display_name || haUser.name || haUser.id || null) : null;
            MockData.user.name = haName || '';
            MockData.user.email = '';
            MockData.user.picture = '';
            MockData.user.initials = haName ? this._getInitials(haName) : '';
        } else if (DashieAuth.user) {
            // Update mock user data from real auth if available
            const stored = this._getStoredUserData();
            if (stored) {
                MockData.user.email = stored.email || DashieAuth.user.email;
                MockData.user.name = stored.name || '';
                MockData.user.picture = stored.picture || '';
                MockData.user.initials = this._getInitials(MockData.user.name || MockData.user.email);
            } else {
                MockData.user.email = DashieAuth.user.email;
                MockData.user.picture = '';
                MockData.user.initials = this._getInitials(DashieAuth.user.email);
            }
        }

        // The 'devices' boot default may itself be hidden in this build
        // (published console) — resolve the real home before hash handling.
        if (!this._isRoutable(this._currentPage)) {
            this._currentPage = this._homePage();
        }

        // Check URL hash for initial page. If the hash points at a beta-gated
        // page that's hidden in this env, fall back to home and silently
        // rewrite the URL.
        const hash = window.location.hash.replace('#', '');
        if (hash && this._isRoutable(hash)) {
            this._currentPage = hash;
        } else if (hash) {
            // Quietly redirect — no toast, no error; user may have an old
            // bookmark or a link from a different env.
            window.location.hash = this._currentPage;
        }

        this.renderPage();
        this._resetContentScroll();

        // Kick off a balance fetch so the sidebar's credits widget shows
        // the real number on first paint. CreditsService re-renders the
        // sidebar in place once the result lands; the rest of the page
        // doesn't need to wait. Skipped in local mode: there is no account to
        // have a balance, and this is a cloud call (same no-phone-home rule as
        // OptionCatalog above).
        if (!localMode) window.CreditsService?.fetch();

        // Listen for hash changes
        window.addEventListener('hashchange', () => {
            const hash = window.location.hash.replace('#', '');
            if (hash && this.pages[hash] && hash !== this._currentPage) {
                if (!this._isRoutable(hash)) {
                    window.location.hash = this._currentPage;
                    return;
                }
                this._currentPage = hash;
                this.renderPage();
                this._resetContentScroll();
            }
        });
    },

    _getStoredUserData() {
        try {
            const data = localStorage.getItem('dashie-user-data');
            return data ? JSON.parse(data) : null;
        } catch (e) { return null; }
    },

    _getInitials(str) {
        if (!str) return '?';
        // Tolerate a non-string rather than throwing. This is called during
        // _showApp, so a bad argument used to take down the whole console —
        // and in local mode that surfaced as an unexplained login wall, because
        // _showSignedOut's catch degrades a render failure to _showLogin().
        // An avatar is not worth that; a missing monogram is.
        if (typeof str !== 'string') return '?';
        const parts = str.split(/[\s@]+/);
        if (parts.length >= 2 && parts[0] && parts[1]) {
            return (parts[0][0] + parts[1][0]).toUpperCase();
        }
        return str[0].toUpperCase();
    },

    /** A page is routable when it's registered in THIS build (delta pages
     *  resolve to a null entry in open-core) AND the feature gate shows it. */
    _isRoutable(slug) {
        if (!this.pages[slug]?.page) return false;
        return typeof FeatureGate === 'undefined' || FeatureGate.isPageEnabled(slug);
    },

    /** The default landing page — 'devices' unless this build hides it (published). */
    _homePage() {
        // The published (HA) edition lands on Voice & AI, not Devices. Devices
        // used to be absent here so this resolved to voice-ai by accident;
        // publishing the Devices pages on 2026-07-30 would have silently flipped
        // the landing page for every HA user. Voice/AI IS the product in that
        // edition — and it is the only home that works signed out, so this also
        // keeps local mode and the signed-in console landing in the same place.
        if (typeof FeatureGate !== 'undefined' && FeatureGate.isPublishedBuild()) return 'voice-ai';
        return this._isRoutable('devices') ? 'devices' : 'voice-ai';
    },

    navigate(page) {
        if (!this.pages[page]) return;
        // Silently redirect to home if the user (or a stale link) targets a
        // beta-gated page that's hidden in this environment (or a delta page
        // this build doesn't ship).
        if (!this._isRoutable(page)) {
            page = this._homePage();
        }

        // Reset sub-page state when navigating away. Delta pages are reached
        // through the registry (absent → null entry → no-op) so this carries
        // no bare references to modules the open-core build doesn't ship.
        if (this._currentPage === 'devices' && page !== 'devices' && this.pages.devices?.page) {
            this.pages.devices.page._detailDeviceId = null;
        }
        if (this._currentPage === 'family' && page !== 'family' && this.pages.family?.page) {
            this.pages.family.page._editingId = null;
        }

        this._currentPage = page;
        window.location.hash = page;
        this.closeSidebar();

        // If page has a refresh method, call it to re-fetch fresh data
        const pageObj = this.pages[page]?.page;
        if (pageObj && typeof pageObj.onNavigateTo === 'function') {
            pageObj.onNavigateTo();
        }

        this.renderPage();
        this._resetContentScroll();
    },

    renderPage() {
        // Auth guard (the "auto logs back in after sign-out" fix): background
        // tasks call renderPage() asynchronously — the devices page's
        // _pollUntilFreshDevices / auto-refresh timers, SSE events, the credits
        // fetch, the option catalog, FeatureGate. If the user signed out while
        // one was in flight, it would otherwise repaint an authed page straight
        // over the login screen ~1s later, looking exactly like an auto-login.
        // renderPage only ever renders authed pages; the login UI is drawn by
        // _showLogin(), so bailing here when signed out is always correct —
        // EXCEPT in local mode, where the published console legitimately runs
        // with no account (see DashieAuth.isLocalMode).
        //
        // ⚠️ This guard is a safety property. The whitelist is re-checked HERE
        // as well as in _isRoutable/navigate, because renderPage() is reached
        // from background timers, SSE events and CreditsService — paths that
        // never went through a navigation door. A whitelist miss falls back to
        // home and says so; it must never render an account page.
        if (!DashieAuth.isAuthenticated) {
            if (!DashieAuth.isLocalMode) return;
            if (FeatureGate.requiresAccount(this._currentPage)) {
                console.warn(`DROP: local mode blocked page '${this._currentPage}' — ` +
                             `account required; falling back to home`);
                this._currentPage = this._homePage();
            }
        }

        // Expired-trial branch: a user the server says has no console value
        // (no HA, no registered devices) gets a focused purchase landing
        // instead of an empty console. Fail-open — only lock when the server
        // *explicitly* reports has_console_value:false, so an old edge fn (no
        // field) or unloaded state never strands device/HA users.
        if (this._expiredLockToPurchase()) { this._renderExpiredLanding(); return; }

        const entry = this.pages[this._currentPage];
        if (!entry || !entry.page) return;

        const pageObj = entry.page;

        // Sidebar
        document.getElementById('sidebar').innerHTML = Sidebar.render(this._currentPage);

        // Top bar
        const title = pageObj.topBarTitle ? pageObj.topBarTitle() : this._currentPage;
        const subtitle = pageObj.topBarSubtitle ? pageObj.topBarSubtitle() : '';

        // Show a refresh-data icon next to the title for pages that support it.
        const showRefresh = typeof pageObj.refresh === 'function';
        let topBarHtml = TopBar.render(title, subtitle, showRefresh);

        // Inject action buttons if page provides them
        if (pageObj.topBarActions) {
            const actionsHtml = pageObj.topBarActions();
            topBarHtml = topBarHtml.replace(
                '<div class="top-bar-right">',
                `<div class="top-bar-right"><div class="page-header-actions">${actionsHtml}</div>`
            );
        }

        document.getElementById('top-bar').innerHTML = topBarHtml;

        // Content
        document.getElementById('content').innerHTML = pageObj.render();

        // Global banner slot: pending-deletion takes priority; otherwise a
        // persistent "trial/subscription ended — Subscribe" banner for expired
        // users who still have console value (Devices/HA management stays usable).
        const _gb = document.getElementById('global-banner');
        if (_gb) _gb.innerHTML = this._deletionBannerHtml() || this._integrationRestartBannerHtml() || this._expiredBannerHtml();
        // No scroll reset here — `renderPage` is also called for in-place
        // state updates (e.g. toggling hide on a calendar row), and resetting
        // scroll mid-page is jarring. Navigation paths handle scroll reset
        // explicitly via `_resetContentScroll()`.
    },

    _resetContentScroll() {
        const el = document.getElementById('content');
        if (el) el.scrollTop = 0;
    },

    // ── Expired-trial branching (Part B3) ────────────────────────────
    // The server (check-subscription) tells us whether an expired user still
    // has console value via has_console_value (is_ha_user || has active
    // device). We branch the expired UX on it rather than guessing.

    /** True only when the user is confirmed expired AND the server explicitly
     *  reports no console value → lock the console to a purchase landing.
     *  Fail-open: missing field / unloaded state never locks. */
    _expiredLockToPurchase() {
        if (typeof FeatureGate === 'undefined') return false;
        if (FeatureGate.hasEntitlement()) return false; // not expired (or unknown)
        const st = FeatureGate._subscriptionState;
        return !!st && st.has_console_value === false;
    },

    /** Session-scoped dismiss flag for the expired banner (resets on reload;
     *  the delta's persistent sidebar CTAs keep the path available). */
    _expiredBannerDismissed: false,

    /** Persistent "trial/subscription ended" banner for expired users who keep
     *  console access (device/HA management). Rendering lives in the
     *  SubscribeGate delta module (subscription surfaces are Dashie-only);
     *  open-core builds ship without it and this is always ''. */
    _expiredBannerHtml() {
        return window.SubscribeGate?.expiredBannerHtml?.() ?? '';
    },

    /** Hide the expired banner for the rest of this session. */
    _dismissExpiredBanner() {
        this._expiredBannerDismissed = true;
        const gb = document.getElementById('global-banner');
        if (gb) gb.innerHTML = this._deletionBannerHtml() || this._integrationRestartBannerHtml() || '';
    },

    /** Full-content purchase landing for expired users with no console value.
     *  Rendering lives in the SubscribeGate delta module; open-core builds
     *  never lock (see _expiredLockToPurchase) and never reach this. */
    _renderExpiredLanding() {
        window.SubscribeGate?.renderExpiredLanding?.();
    },

    // Re-fetch the current page's data in place via its refresh() hook — keeps
    // the user on the page (no navigation, no full reload). The title-bar
    // refresh icon (TopBar) calls this; _refreshing drives its spin state.
    async refreshCurrentPage() {
        const pageObj = this.pages[this._currentPage]?.page;
        if (!pageObj || typeof pageObj.refresh !== 'function' || this._refreshing) return;
        this._refreshing = true;
        this.renderPage();   // repaint so the icon shows its spinning state
        try {
            await pageObj.refresh();
        } catch (e) {
            console.warn('[App] page refresh failed:', e?.message);
            if (typeof Toast !== 'undefined') {
                Toast.error(Toast.friendly ? Toast.friendly(e, 'refresh') : 'Refresh failed');
            }
        } finally {
            this._refreshing = false;
            this.renderPage();
        }
    },

    toggleSidebar() {
        this._sidebarOpen = !this._sidebarOpen;
        const sidebar = document.getElementById('sidebar');
        sidebar.classList.toggle('open', this._sidebarOpen);

        let overlay = document.querySelector('.sidebar-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'sidebar-overlay';
            overlay.onclick = () => this.closeSidebar();
            document.getElementById('app').appendChild(overlay);
        }
        overlay.classList.toggle('visible', this._sidebarOpen);
    },

    closeSidebar() {
        this._sidebarOpen = false;
        document.getElementById('sidebar').classList.remove('open');
        const overlay = document.querySelector('.sidebar-overlay');
        if (overlay) overlay.classList.remove('visible');
    },
};

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());
