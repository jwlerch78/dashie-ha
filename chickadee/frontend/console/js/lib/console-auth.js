/* ============================================================
   Dashie Console — Auth (self-contained, no module imports)
   Calls the same edge function endpoints as the main app:
   - jwt-auth: exchange_code, bootstrap_jwt, refresh_jwt
   - database-operations: all household/device operations
   ============================================================ */

const DashieAuth = {
    // --- Config (auto-detect environment by hostname) ---
    _configs: {
        production: {
            url: 'https://cseaywxcvnxcsypaqaid.supabase.co',
            anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNzZWF5d3hjdm54Y3N5cGFxYWlkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc2MDIxOTEsImV4cCI6MjA3MzE3ODE5MX0.Wnd7XELrtPIDKeTcHVw7dl3awn3BlI0z9ADKPgSfHhA',
            googleClientId: '221142210647-58t8hr48rk7nlgl56j969himso1qjjoo.apps.googleusercontent.com',
        },
        development: {
            url: 'https://cwglbtosingboqepsmjk.supabase.co',
            anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN3Z2xidG9zaW5nYm9xZXBzbWprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc2NDY4NjYsImV4cCI6MjA3MzIyMjg2Nn0.VCP5DSfAwwZMjtPl33bhsixSiu_lHsM6n42FMJRP3YA',
            googleClientId: '221142210647-58t8hr48rk7nlgl56j969himso1qjjoo.apps.googleusercontent.com',
        },
    },

    _getConfig() {
        // In add-on mode, prefer the Supabase config the add-on reports (matches
        // whatever env the add-on's stored JWT was issued against). The add-on
        // populates this._addonSupabaseConfig in _initAddonMode().
        if (this._addonSupabaseConfig) return this._addonSupabaseConfig;

        const host = window.location.hostname;
        if (host.includes('dev.') || host.includes('local.') || host === 'localhost' || host.startsWith('127.0.0.1')) {
            return this._configs.development;
        }
        return this._configs.production;
    },

    get config() {
        // Don't cache — _addonSupabaseConfig may be populated after first access.
        return this._getConfig();
    },

    _addonSupabaseConfig: null,
    get edgeFunctionUrl() { return this.config.url + '/functions/v1/jwt-auth'; },
    get databaseOpsUrl() { return this.config.url + '/functions/v1/database-operations'; },
    get anonKey() { return this.config.anonKey; },

    // --- JWT State ---
    jwt: null,
    jwtExpiry: null,
    jwtUserId: null,
    jwtUserEmail: null,
    _refreshTimer: null,
    _JWT_STORAGE_KEY: 'dashie-supabase-jwt',
    _REFRESH_THRESHOLD_HOURS: 24,

    // --- Callbacks ---
    onAuthStateChange: null,  // called with (isAuthenticated, user)

    // --- Realtime client (for broadcasts) ---
    _supabaseClient: null,
    _sessionId: null,              // per-page-load session ID for broadcast filtering
    _channels: {},                 // map channelName -> { channel, ready, handlers: { event: [fn] } }

    /** Lazily initialize a Supabase client for realtime broadcasts */
    _getSupabaseClient() {
        if (this._supabaseClient) return this._supabaseClient;
        if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
            console.warn('[DashieAuth] Supabase JS SDK not loaded; broadcasts unavailable');
            return null;
        }
        this._supabaseClient = window.supabase.createClient(this.config.url, this.anonKey, {
            auth: { persistSession: false, autoRefreshToken: false },
            realtime: { params: { eventsPerSecond: 10 } },
        });
        if (this.jwt) this._supabaseClient.realtime.setAuth(this.jwt);
        return this._supabaseClient;
    },

    /** Get a stable per-tab session ID for broadcast self-filtering */
    getSessionId() {
        if (this._sessionId) return this._sessionId;
        this._sessionId = `console-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
        return this._sessionId;
    },

    /**
     * Get or create a persistent channel for the given base name.
     * Keeps one subscription per channel — both broadcast sending and
     * receiving go through the same channel, matching the mobile app pattern.
     */
    async _getOrCreateChannel(channelBase) {
        const sb = this._getSupabaseClient();
        if (!sb || !this.jwtUserId) return null;
        const channelName = `${channelBase}-${this.jwtUserId}`;

        if (this._channels[channelName]?.ready) {
            return this._channels[channelName];
        }

        if (this._channels[channelName]?.readyPromise) {
            await this._channels[channelName].readyPromise;
            return this._channels[channelName];
        }

        const channel = sb.channel(channelName, {
            config: { broadcast: { self: false, ack: false } },
        });
        const entry = { channel, ready: false, handlers: {} };
        this._channels[channelName] = entry;

        // Register a single broadcast listener that fans out to per-event handlers
        channel.on('broadcast', { event: '*' }, (payload) => {
            const event = payload.event;
            const p = payload.payload;
            if (p?.sessionId === this.getSessionId()) return; // self-filter
            const handlers = entry.handlers[event] || [];
            for (const fn of handlers) {
                try { fn(p); } catch (e) { console.error('[DashieAuth] broadcast handler error', e); }
            }
        });

        entry.readyPromise = new Promise((resolve) => {
            channel.subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    entry.ready = true;
                    resolve();
                }
            });
        });

        await entry.readyPromise;
        return entry;
    },

    /** Broadcast on a user-scoped channel (persistent underneath) */
    async broadcast(channelBase, event, payload) {
        try {
            const entry = await this._getOrCreateChannel(channelBase);
            if (!entry) return false;
            await entry.channel.send({
                type: 'broadcast',
                event,
                payload: { ...payload, userId: this.jwtUserId, sessionId: this.getSessionId() },
            });
            return true;
        } catch (e) {
            console.warn('[DashieAuth] broadcast failed', e);
            return false;
        }
    },

    /** Subscribe to broadcast events on a user-scoped channel */
    async subscribeToChannel(channelBase, event, handler) {
        const entry = await this._getOrCreateChannel(channelBase);
        if (!entry) return null;
        entry.handlers[event] = entry.handlers[event] || [];
        entry.handlers[event].push(handler);
        return { channelBase, event, handler };
    },

    /** Unsubscribe a handler from a broadcast channel */
    unsubscribeFromChannel(ticket) {
        if (!ticket) return;
        const channelName = `${ticket.channelBase}-${this.jwtUserId}`;
        const entry = this._channels[channelName];
        if (!entry?.handlers[ticket.event]) return;
        entry.handlers[ticket.event] = entry.handlers[ticket.event].filter(h => h !== ticket.handler);
    },

    /** Load account-level user_settings (via jwt-auth edge function) */
    async loadUserSettings() {
        const data = await this._authRequest({ operation: 'load' });
        const settings = data.settings || {};
        console.log('[DashieAuth] loadUserSettings:',
            'jwt user:', this.jwtUserEmail, this.jwtUserId?.substring(0, 8),
            'response keys:', Object.keys(data),
            'settings type:', typeof data.settings,
            'settings top-level:', settings && typeof settings === 'object' ? Object.keys(settings).slice(0, 10) : settings,
            'general.language:', settings?.general?.language);
        return settings;
    },

    /** Transport for user_settings writes (jwt-auth 'save' op). The server
     *  DEEP-MERGES the payload over the stored blob (objects merge key-by-key,
     *  arrays/scalars replace) — so a partial payload only changes the keys it
     *  includes.
     *
     *  ⚠️ Do NOT call this from pages/components — use patchUserSetting(s)
     *  below (lint:console-writes enforces this). Passing a full stale blob
     *  here reverts every leaf another tab/device changed since it was loaded;
     *  that race silently dropped voice.ttsProvider (2026-07-10 incident).
     *
     *  Also broadcasts on `user_settings_${userId}` so other devices
     *  (tablet webapp via SettingsSync) hear the change and refetch
     *  without waiting for their next boot. Channel naming matches
     *  js/data/sync/settings-sync.js (underscore, not dash). */
    async saveUserSettings(fullSettings) {
        const result = await this._authRequest({ operation: 'save', data: fullSettings });
        this._broadcastSettingsChanged().catch(() => {});
        return result;
    },

    /** Serializes patchUserSetting(s) calls. The server's save op does its own
     *  select→merge→upsert, so two write requests IN FLIGHT AT ONCE can still
     *  race server-side (each merges over the same pre-image). Chaining our
     *  writes closes that window for everything this console session sends —
     *  e.g. a select control saving provider + engineId + voice back-to-back. */
    _patchChain: Promise.resolve(),

    /** THE sanctioned way to write one user_settings key from the console.
     *  Sends ONLY the changed leaf as a nested partial; the server deep-merge
     *  does the read-modify-write atomically against the stored blob, so
     *  nothing outside the patch can be clobbered — no client load→merge→save.
     *  patchUserSetting('voice.ttsProvider', 'piper_ha') */
    async patchUserSetting(dottedKey, value) {
        const parts = dottedKey.split('.');
        const patch = {};
        let node = patch;
        for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]] = {};
        node[parts[parts.length - 1]] = value;
        return this.patchUserSettings(patch);
    },

    /** Multi-key variant: pass a nested partial covering only the keys you
     *  own, e.g. { chores: { enabled: true }, rewards: { enabled: false } }.
     *  Merge semantics: objects merge, arrays/scalars replace, null overwrites;
     *  a key can't be DELETED via patch — write null to clear it. */
    async patchUserSettings(partial) {
        const run = () => this.saveUserSettings(partial);
        const result = this._patchChain.then(run, run);   // run after the prior write settles
        this._patchChain = result.catch(() => {});        // keep the chain alive on error
        return result;
    },

    /** Fire a broadcast on the user_settings_${userId} channel so other
     *  devices' SettingsSync wakes up and refetches user_settings.
     *  Payload shape matches what _handleBroadcast expects:
     *    { kind, source_client_id }
     *  - kind: 'account' covers the general/display/etc account-level
     *    blocks. SettingsSync's registered consumer will refresh.
     *  - source_client_id: this Console's session ID, so the same
     *    Console tab that triggered the save doesn't react to its
     *    own broadcast.
     *  Uses raw Supabase channel APIs (NOT this.broadcast()) because
     *  the channel name uses underscores to match the tablet listener,
     *  while this._getOrCreateChannel adds a dash. */
    async _broadcastSettingsChanged() {
        const sessionId = this.getSessionId();
        // kind MUST be 'account_settings' — the dashboard's
        // registerAccountSettingsSync consumer dispatches on this exact kind,
        // and its legacy blanket handler ignores any kinded broadcast. Sending
        // 'account' meant the tablet silently dropped every console change.
        //
        // Prefer the LIVE SettingsSync channel. When SettingsSync is wired
        // (app.js _connectSettingsSync) it holds a persistent subscription to
        // user_settings_<id> on this same supabase client. Opening a SECOND
        // channel on that same topic to send makes supabase-js hang at
        // subscribe() (a duplicate topic never reaches 'SUBSCRIBED'), so send()
        // never fired and the broadcast was silently dropped — the actual
        // reason console settings changes stopped propagating to the tablet
        // live. Reuse the subscribed channel instead (mirrors the dashboard's
        // broadcastChange, which reuses its one persistent channel).
        if (window.SettingsSync && typeof window.SettingsSync.broadcast === 'function'
            && window.SettingsSync.isConnected && window.SettingsSync.isConnected()) {
            if (window.SettingsSync.broadcast('account_settings', sessionId)) return;
        }
        // Fallback: SettingsSync not wired/connected → no persistent channel
        // holds this topic, so a one-shot subscribe-then-send is safe here.
        const sb = this._getSupabaseClient();
        if (!sb || !this.jwtUserId) return;
        const channelName = `user_settings_${this.jwtUserId}`;
        const ch = sb.channel(channelName, { config: { broadcast: { self: false, ack: false } } });
        await new Promise(resolve => {
            ch.subscribe(status => {
                if (status === 'SUBSCRIBED') resolve();
            });
        });
        await ch.send({
            type: 'broadcast',
            event: 'settings-changed',
            payload: {
                kind: 'account_settings',
                source_client_id: sessionId,
            },
        });
    },

    /** Live-push a per-device settings change to that device (Q4 fix).
     *  The dashboard's DeviceSettingsSync subscribes to `device_settings_<userId>`
     *  and applies a payload when `sourceDeviceId === its own device id`. Without this
     *  the console only wrote the user_devices row — the tablet never got a live push,
     *  so a change didn't land until the tablet's next reload, and for readback-backed
     *  settings (the wake word) the tablet's own readback re-asserted the old value and
     *  reverted the console edit. Broadcasting here makes the tablet apply immediately
     *  (updating its native pref), so the readback then matches instead of stomping.
     *
     *  Payload shape mirrors the webapp's DeviceSettingsService.broadcastSettingsChange
     *  exactly. Send the FULL category (not just the changed key) — applyDeviceSettings'
     *  aiVoice branch defaults absent keys (personalityId||'dashie'), so a partial payload
     *  would reset the sibling settings. `sourceDeviceId` = the TARGET device id (the
     *  receiver applies when it matches its own id; other devices skip). The console holds
     *  no persistent subscription to this topic, so a one-shot subscribe→send is safe (no
     *  duplicate-topic hang). Fire-and-forget; never blocks the save. */
    async _broadcastDeviceSettingsChanged(deviceId, settingsPath, settingsValue) {
        const sb = this._getSupabaseClient();
        if (!sb || !this.jwtUserId || !deviceId) return;
        const channelName = `device_settings_${this.jwtUserId}`;
        const ch = sb.channel(channelName, { config: { broadcast: { self: false, ack: false } } });
        try {
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('timeout')), 5000);
                ch.subscribe(status => {
                    if (status === 'SUBSCRIBED') { clearTimeout(t); resolve(); }
                    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(t); reject(new Error(status)); }
                });
            });
            await ch.send({
                type: 'broadcast',
                event: 'device-settings-changed',
                payload: { settingsPath, sourceDeviceId: deviceId, settingsValue, timestamp: Date.now() },
            });
        } finally {
            try { sb.removeChannel(ch); } catch (_) {}
        }
    },

    // =========================================================
    //  User profile (tier + special_access) — drives FeatureGate
    //
    //  We pull tier + special_access from user_profiles after auth establishes
    //  and cache them on _userProfile. FeatureGate's 'alpha-only' rule reads
    //  specialAccess to decide whether to expose voice/AI/credits UI.
    //
    //  Mirrors the dashboard's featureAccessService pattern (refresh on
    //  visibility change so admin promotions show up without a reload).
    //  See .reference/FEATURE_GATING.md for the model.
    // =========================================================

    _userProfile: null,                // { tier, special_access } once loaded; null until then
    _profileVisListenerAttached: false,

    /** Has the profile fetch completed at least once? */
    get hasProfileLoaded() { return this._userProfile !== null; },

    /** 'alpha' | 'beta' | null (whatever user_profiles.special_access holds) */
    get specialAccess() { return this._userProfile?.special_access || null; },

    /** Subscription tier ('basic' | 'core' | 'plus' | 'vip' | 'developer') */
    get tier() { return this._userProfile?.tier || null; },

    /** Whether this account is flagged as a Home Assistant user (user_profiles.is_ha_user).
     *  Set live, one-way, by send-welcome-email on login when a device has HA enabled.
     *  Gates the HA-only voice pipeline options on the Voice & AI page. */
    get isHaUser() { return this._userProfile?.is_ha_user === true; },

    /**
     * Fetch tier + special_access from user_profiles. Cheap REST call (one
     * row, two columns). Idempotent — repeated calls just refresh the cache.
     * Triggers a re-render via FeatureGate so UI reflects the new state.
     */
    async loadUserProfile() {
        if (!this.jwt || !this.jwtUserId) return null;
        try {
            const url = `${this.config.url}/rest/v1/user_profiles?select=tier,special_access,is_ha_user&auth_user_id=eq.${this.jwtUserId}`;
            const res = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${this.jwt}`,
                    'apikey': this.anonKey,
                    'Accept': 'application/json',
                },
            });
            if (!res.ok) {
                console.warn('[DashieAuth] user_profiles fetch failed', res.status);
                return null;
            }
            const rows = await res.json();
            const row = Array.isArray(rows) ? rows[0] : null;
            if (row) {
                this._userProfile = { tier: row.tier || 'basic', special_access: row.special_access || null, is_ha_user: row.is_ha_user === true };
            }
            this._attachProfileVisibilityRefresh();
            return this._userProfile;
        } catch (e) {
            console.warn('[DashieAuth] loadUserProfile failed', e.message);
            return null;
        }
    },

    /**
     * Attach a visibilitychange listener that refreshes the profile when
     * the document becomes visible. Picks up admin tier-promotions
     * (alpha/beta access changes) without requiring an explicit reload.
     * Idempotent.
     */
    _attachProfileVisibilityRefresh() {
        if (this._profileVisListenerAttached) return;
        if (typeof document === 'undefined') return;
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') return;
            if (!this.jwtUserId) return;
            const before = this.specialAccess;
            this.loadUserProfile().then(() => {
                if (this.specialAccess !== before) {
                    // Notify the app so it can re-render gated UI
                    if (typeof App !== 'undefined' && App.renderPage) App.renderPage();
                }
            }).catch(err => {
                console.warn('[DashieAuth] Visibility-triggered profile refresh failed', err);
            });
        });
        this._profileVisListenerAttached = true;
    },

    // =========================================================
    //  Add-on mode detection
    //  When served by Dashie Console (Node/Express HA add-on), the SPA takes its
    //  JWT from /api/auth/jwt and drives sign-in via the device-flow
    //  endpoints. In browser-only mode, it uses Google OAuth directly.
    // =========================================================

    _addonMode: null,         // null = unknown, true/false after probe
    _addonRuntimeInfo: null,  // cached result of GET /api/runtime

    /**
     * Build an add-on API URL that works under any page prefix (Ingress uses dynamic
     * paths like /api/hassio_ingress/<token>/). Using relative paths resolves against
     * document.baseURI, which is correct whether we're at http://localhost:7123/
     * or https://<ha>/api/hassio_ingress/<token>/.
     */
    _addonUrl(path) {
        return path.replace(/^\//, '');  // 'api/runtime' — browser resolves via baseURI
    },

    async _probeAddonMode() {
        if (this._addonMode !== null) return this._addonMode;
        try {
            const resp = await fetch(this._addonUrl('/api/runtime'), { cache: 'no-store' });
            if (resp.ok) {
                const data = await resp.json();
                if (data?.addon === true) {
                    this._addonMode = true;
                    this._addonRuntimeInfo = data;
                    console.log('[DashieAuth] Running inside Dashie Console', data);
                    return true;
                }
            }
        } catch (e) { /* not running inside the add-on */ }
        this._addonMode = false;
        return false;
    },

    get isAddonMode() {
        // Synchronous accessor — only reliable after init() completes
        return this._addonMode === true;
    },

    // =========================================================
    //  Initialization
    // =========================================================

    async init() {
        // Detect add-on mode FIRST — changes everything downstream
        await this._probeAddonMode();

        if (this._addonMode) {
            return await this._initAddonMode();
        }

        // Browser-only mode (original path)
        this._loadJWTFromStorage();

        // Check if we're returning from an OAuth callback
        const params = new URLSearchParams(window.location.search);
        if (params.has('code') && params.has('state')) {
            return this._handleOAuthCallback(params);
        }

        return this.isAuthenticated;
    },

    /** In add-on mode: fetch server-stored auth state; pull JWT from /api/auth/jwt. */
    async _initAddonMode() {
        try {
            const status = await fetch(this._addonUrl('/api/auth/status')).then(r => r.json());

            // Always capture the add-on's Supabase config (even when not authenticated)
            // so subsequent edge-function calls target the right project.
            if (status?.supabase_url && status?.supabase_anon_key) {
                this._addonSupabaseConfig = {
                    url: status.supabase_url,
                    anonKey: status.supabase_anon_key,
                    googleClientId: this._configs[status.supabase_env === 'production' ? 'production' : 'development'].googleClientId,
                };
                console.log('[DashieAuth] Using Supabase from add-on:', status.supabase_env, status.supabase_url);
            }

            if (status?.authenticated) {
                // Pull the actual JWT from the add-on. /api/auth/jwt also returns
                // user_picture (Google profile photo) so the top-bar avatar can
                // render without requiring a direct Google sign-in in this browser.
                const jwtResp = await fetch(this._addonUrl('/api/auth/jwt'));
                if (jwtResp.ok) {
                    const data = await jwtResp.json();
                    this._setJWTFromAddon(data.jwt, {
                        id: status.user_id,
                        email: status.user_email,
                        name: data.user_name || status.user_name,
                        picture: data.user_picture || status.user_picture,
                    });
                    return true;
                }
            }
        } catch (e) {
            console.error('[DashieAuth] Failed to init add-on mode', e);
        }
        return false;
    },

    /** Set JWT without localStorage persistence (add-on handles persistence server-side). */
    _setJWTFromAddon(token, user) {
        this.jwt = token;
        try {
            const payload = JSON.parse(atob(token.split('.')[1]));
            this.jwtExpiry = payload.exp ? payload.exp * 1000 : null;
            this.jwtUserId = user?.id || payload.sub;
            this.jwtUserEmail = user?.email || payload.email;
        } catch (e) {
            console.error('[DashieAuth] Failed to parse add-on JWT', e);
        }
        // Schedule re-fetch from add-on a bit before expiry rather than client-side refresh
        this._scheduleAddonJWTRefresh();
        if (this._supabaseClient) this._supabaseClient.realtime.setAuth(token);
        // Seed the user-data localStorage entry the SPA uses for display
        try {
            if (user?.name || user?.email) {
                // Preserve a previously stored Google avatar — this path (add-on
                // JWT) has no picture of its own and used to clobber it.
                let prevPicture = '';
                try {
                    prevPicture = JSON.parse(localStorage.getItem('dashie-user-data') || '{}').picture || '';
                } catch (e) {}
                localStorage.setItem('dashie-user-data', JSON.stringify({
                    name: user?.name || '',
                    email: user?.email || '',
                    picture: user?.picture || prevPicture,
                }));
            }
        } catch (e) {}
    },

    _scheduleAddonJWTRefresh() {
        if (this._refreshTimer) clearTimeout(this._refreshTimer);
        if (!this.jwtExpiry) return;
        // Re-fetch from add-on when within 30 min of expiry (the add-on handles
        // the actual refresh itself)
        const delay = Math.max(60_000, this.jwtExpiry - Date.now() - 30 * 60 * 1000);
        this._refreshTimer = setTimeout(() => this._refetchAddonJWT(), delay);
    },

    async _refetchAddonJWT() {
        try {
            const resp = await fetch(this._addonUrl('/api/auth/jwt'));
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            this._setJWTFromAddon(data.jwt, {
                id: this.jwtUserId,
                email: this.jwtUserEmail,
                name: data.user_name,
                picture: data.user_picture,
            });
            console.log('[DashieAuth] JWT re-fetched from add-on');
        } catch (e) {
            console.error('[DashieAuth] Add-on JWT re-fetch failed', e);
            this._refreshTimer = setTimeout(() => this._refetchAddonJWT(), 5 * 60 * 1000);
        }
    },

    // =========================================================
    //  JWT Management (mirrors EdgeClient)
    // =========================================================

    get isAuthenticated() {
        if (!this.jwt) return false;
        if (this.jwtExpiry && Date.now() >= this.jwtExpiry) return false;
        return true;
    },

    get user() {
        if (!this.isAuthenticated) return null;
        return {
            id: this.jwtUserId,
            email: this.jwtUserEmail,
        };
    },

    setJWT(token) {
        this.jwt = token;
        try {
            const payload = JSON.parse(atob(token.split('.')[1]));
            this.jwtExpiry = payload.exp ? payload.exp * 1000 : null;
            this.jwtUserId = payload.sub;
            this.jwtUserEmail = payload.email;
        } catch (e) {
            console.error('[DashieAuth] Failed to parse JWT', e);
        }
        this._saveJWTToStorage();
        this._scheduleRefresh();
        if (this._supabaseClient) this._supabaseClient.realtime.setAuth(token);
    },

    clearJWT() {
        this.jwt = null;
        this.jwtExpiry = null;
        this.jwtUserId = null;
        this.jwtUserEmail = null;
        if (this._refreshTimer) clearTimeout(this._refreshTimer);
        this._refreshTimer = null;
        try { localStorage.removeItem(this._JWT_STORAGE_KEY); } catch (e) {}
        if (this.onAuthStateChange) this.onAuthStateChange(false, null);
    },

    /** First-load race bridge: a page can render + fire a data fetch before
     *  init() has finished loading the JWT from storage. Resolve as soon as a
     *  JWT appears (typically <100ms) or after timeoutMs. NEVER clears state —
     *  if no JWT ever arrives we just fall through to the normal "Not
     *  authenticated" throw, so a genuinely signed-out user isn't kept waiting
     *  long, and an authenticated user no longer gets a spurious failure. */
    _awaitJWT(timeoutMs = 1500) {
        if (this.jwt) return Promise.resolve();
        return new Promise((resolve) => {
            const start = Date.now();
            const tick = () => {
                if (this.jwt || Date.now() - start >= timeoutMs) return resolve();
                setTimeout(tick, 50);
            };
            tick();
        });
    },

    _loadJWTFromStorage() {
        try {
            const stored = localStorage.getItem(this._JWT_STORAGE_KEY);
            if (!stored) return;
            const data = JSON.parse(stored);
            if (Date.now() >= data.expiry) {
                localStorage.removeItem(this._JWT_STORAGE_KEY);
                return;
            }
            this.jwt = data.jwt;
            this.jwtExpiry = data.expiry;
            this.jwtUserId = data.userId;
            this.jwtUserEmail = data.userEmail;
            this._scheduleRefresh();
        } catch (e) {
            localStorage.removeItem(this._JWT_STORAGE_KEY);
        }
    },

    _saveJWTToStorage() {
        if (!this.jwt || !this.jwtExpiry) return;
        try {
            localStorage.setItem(this._JWT_STORAGE_KEY, JSON.stringify({
                jwt: this.jwt,
                expiry: this.jwtExpiry,
                userId: this.jwtUserId,
                userEmail: this.jwtUserEmail,
                savedAt: Date.now(),
            }));
        } catch (e) {
            console.error('[DashieAuth] Failed to save JWT', e);
        }
    },

    _scheduleRefresh() {
        if (this._refreshTimer) clearTimeout(this._refreshTimer);
        if (!this.jwtExpiry) return;

        const thresholdMs = this._REFRESH_THRESHOLD_HOURS * 60 * 60 * 1000;
        const delayMs = Math.max(0, (this.jwtExpiry - thresholdMs) - Date.now());

        if (delayMs <= 0) {
            // Already within threshold — refresh in 5s
            this._refreshTimer = setTimeout(() => this._refreshJWT(), 5000);
        } else {
            this._refreshTimer = setTimeout(() => this._refreshJWT(), delayMs);
        }
    },

    async _refreshJWT() {
        if (!this.jwt) return;
        try {
            const data = await this._authRequest({ operation: 'refresh_jwt' });
            // Re-check: if the user signed out while this refresh was in flight,
            // clearJWT() nulled the token — do NOT re-establish the session
            // (that's the intermittent "signed back in after logout" bug).
            if (!this.jwt) { console.log('[DashieAuth] refresh completed after sign-out — discarding'); return; }
            if (data.jwtToken) {
                this.setJWT(data.jwtToken);
                console.log('[DashieAuth] JWT refreshed');
            }
        } catch (e) {
            console.error('[DashieAuth] JWT refresh failed', e);
            // Retry in 1 hour if not expired
            if (this.jwtExpiry && Date.now() < this.jwtExpiry) {
                this._refreshTimer = setTimeout(() => this._refreshJWT(), 60 * 60 * 1000);
            }
        }
    },

    // =========================================================
    //  Google OAuth Flow
    // =========================================================

    signIn() {
        // Add-on mode: use device flow via /api/auth/start-link
        if (this.isAddonMode) return this._signInAddonMode();

        // Browser-only mode: standard Google OAuth redirect
        sessionStorage.setItem('dashie-oauth-state', Date.now().toString());
        const redirectUri = this._getRedirectUri();
        const params = new URLSearchParams({
            client_id: this.config.googleClientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            // Narrow scopes — must match the dashboard (js/data/auth/auth-config.js).
            // The Console shares one Google OAuth client with the dashboard;
            // requesting the broad `calendar`/`drive` scopes here made the
            // consent screen show "see/edit/delete ALL" access.
            scope: 'profile email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.file',
            access_type: 'offline',
            // 'select_account' → after signing out of Dashie, the Google account
            // chooser appears so the user can switch accounts (Google session in
            // the browser is untouched). 'consent' is kept so access_type=offline
            // still returns a refresh token each time.
            prompt: 'select_account consent',
            state: Date.now().toString(),
            // false: the Console requests a fixed scope set, so incremental
            // authorization isn't needed. With 'true', Google re-merged every
            // scope previously granted to the shared client (the dashboard's
            // set), inflating the consent screen to 8 scopes instead of 6.
            include_granted_scopes: 'false',
        });
        window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    },

    // --- Add-on device flow ---

    _addonPendingLink: null,    // { user_code, verification_url, expires_at }
    _addonPollTimer: null,

    /**
     * Start the device-flow sign-in. Returns { verification_url, user_code }.
     * DOES NOT open the verification URL — caller (the sign-in UI) renders a
     * user-clickable anchor instead. Opening programmatically via window.open
     * is unreliable inside HA Ingress iframes (popup blockers / sandbox may
     * navigate the parent frame instead, which HA rejects with a 403).
     * Polling begins automatically; onAuthStateChange fires on approval.
     */
    async _signInAddonMode() {
        if (this._addonPendingLink && Date.now() < new Date(this._addonPendingLink.expires_at).getTime()) {
            return this._addonPendingLink;
        }
        const resp = await fetch(this._addonUrl('/api/auth/start-link'), { method: 'POST' });
        if (!resp.ok) throw new Error(`start-link failed: ${resp.status}`);
        const link = await resp.json();
        this._addonPendingLink = link;
        this._startAddonPolling();
        return link;
    },

    _startAddonPolling() {
        if (this._addonPollTimer) return;
        const interval = (this._addonPendingLink?.interval || 3) * 1000;
        const tick = async () => {
            try {
                const resp = await fetch(this._addonUrl('/api/auth/poll-link'), { method: 'POST' });
                const data = await resp.json();
                if (data.status === 'authorized') {
                    this._stopAddonPolling();
                    this._addonPendingLink = null;
                    await this._initAddonMode();  // pulls the newly-stored JWT
                    if (this.onAuthStateChange) {
                        this.onAuthStateChange(true, {
                            id: data.user_id,
                            email: data.user_email,
                            name: data.user_name,
                        });
                    }
                    return;
                }
                if (data.status === 'expired' || data.status === 'none') {
                    this._stopAddonPolling();
                    this._addonPendingLink = null;
                    if (this.onAuthStateChange) this.onAuthStateChange(false, null);
                    return;
                }
                // pending — schedule next tick
                this._addonPollTimer = setTimeout(tick, interval);
            } catch (e) {
                console.error('[DashieAuth] Poll error', e);
                this._addonPollTimer = setTimeout(tick, interval * 2);
            }
        };
        this._addonPollTimer = setTimeout(tick, interval);
    },

    _stopAddonPolling() {
        if (this._addonPollTimer) clearTimeout(this._addonPollTimer);
        this._addonPollTimer = null;
    },

    /** Cancel a pending device-flow sign-in (user closed the sign-in page or hit Cancel). */
    async cancelSignIn() {
        this._stopAddonPolling();
        this._addonPendingLink = null;
        if (this.isAddonMode) {
            try { await fetch(this._addonUrl('/api/auth/cancel-link'), { method: 'POST' }); } catch (e) {}
        }
    },

    async signOut() {
        if (this.isAddonMode) {
            try { await fetch(this._addonUrl('/api/auth/sign-out'), { method: 'POST' }); } catch (e) {}
        }
        this.clearJWT();
        this._stopAddonPolling();
        this._addonPendingLink = null;
        try {
            localStorage.removeItem('dashie-user-data');
            localStorage.removeItem('dashie-family-name');
        } catch (e) {}
    },

    _getRedirectUri() {
        // Derive the path prefix from wherever the SPA is loaded. /console is
        // canonical (renamed from /hub 2026-05-20); /hub still resolves via a
        // 301 redirect at the hosting layer, but in practice the SPA is loaded
        // from /console, so the regex normally matches that. Defaults to
        // /console if neither prefix is in the URL.
        //
        // ⚠ Google Cloud Console must have both /console/login AND /hub/login
        // registered as authorized redirect URIs (staging + prod OAuth clients)
        // — the /hub one stays valid while we phase out the old URL, the
        // /console one is what new sign-ins will use.
        const m = window.location.pathname.match(/^\/(hub|console)\b/);
        const prefix = m ? m[0] : '/console';
        return window.location.origin + prefix + '/login';
    },

    async _handleOAuthCallback(params) {
        const code = params.get('code');
        const error = params.get('error');

        // Clean URL immediately
        window.history.replaceState({}, document.title, window.location.pathname);
        sessionStorage.removeItem('dashie-oauth-state');

        if (error) {
            throw new Error(`OAuth error: ${error}`);
        }

        if (!code) return false;

        try {
            // 1. Exchange code for Google tokens via edge function
            const tokens = await this._exchangeCode(code);

            // 2. Fetch Google user info
            const userInfo = await this._fetchGoogleUserInfo(tokens.access_token);

            // 3. Bootstrap Supabase JWT from Google access token
            const jwtResult = await this._bootstrapJWT(tokens.access_token);

            // Store user data for display
            try {
                localStorage.setItem('dashie-user-data', JSON.stringify({
                    name: userInfo.name,
                    email: userInfo.email,
                    picture: userInfo.picture,
                }));
            } catch (e) {}

            if (this.onAuthStateChange) {
                this.onAuthStateChange(true, { ...userInfo, ...jwtResult.user });
            }

            return true;
        } catch (e) {
            console.error('[DashieAuth] OAuth callback failed', e);
            throw e;
        }
    },

    async _exchangeCode(code) {
        const response = await fetch(this.edgeFunctionUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.anonKey}`,
            },
            body: JSON.stringify({
                operation: 'exchange_code',
                data: {
                    code: code,
                    redirect_uri: this._getRedirectUri(),
                    provider_type: 'web_oauth',
                },
            }),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(`Token exchange failed: ${response.status} - ${err.error || err.details || 'Unknown'}`);
        }

        const result = await response.json();
        if (!result.success || !result.tokens) {
            throw new Error('Token exchange failed: no tokens returned');
        }
        return result.tokens;
    },

    async _fetchGoogleUserInfo(accessToken) {
        const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { 'Authorization': `Bearer ${accessToken}` },
        });
        if (!response.ok) throw new Error(`Failed to fetch user info: ${response.status}`);
        return response.json();
    },

    async _bootstrapJWT(googleAccessToken) {
        const response = await fetch(this.edgeFunctionUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.anonKey}`,
            },
            body: JSON.stringify({
                operation: 'bootstrap_jwt',
                googleAccessToken: googleAccessToken,
                provider: 'google',
            }),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            if (response.status === 403 && err.error === 'access_denied') {
                throw new Error(err.message || err.reason || 'Access denied');
            }
            throw new Error(`JWT bootstrap failed: ${response.status} - ${err.error || 'Unknown'}`);
        }

        const data = await response.json();
        if (!data.success || !data.jwtToken) {
            throw new Error('JWT bootstrap failed: no token returned');
        }

        this.setJWT(data.jwtToken);
        return { user: data.user, access: data.access };
    },

    // =========================================================
    //  Authenticated Requests (mirrors EdgeClient.request/databaseRequest)
    // =========================================================

    /**
     * Call jwt-auth edge function with auth
     */
    async authRequest(payload) {
        return this._authRequest(payload);
    },

    /**
     * Call database-operations edge function with auth
     */
    async dbRequest(operation, data = {}) {
        // First-load race: in add-on mode, the page can render and fire
        // _fetchDevices before _initAddonMode has finished setting the JWT
        // (e.g. /api/auth/jwt is slow, or status said authenticated but jwt
        // came back null). Try to pull a fresh JWT from the add-on before
        // failing. One-shot — if this still fails, we throw and surface the
        // error normally (the user gets a Retry button).
        if (!this.jwt && this._addonMode) {
            try {
                const resp = await fetch(this._addonUrl('/api/auth/jwt'));
                if (resp.ok) {
                    const data = await resp.json();
                    if (data?.jwt) {
                        this._setJWTFromAddon(data.jwt, {
                            id: this.jwtUserId,
                            email: this.jwtUserEmail,
                            name: data.user_name,
                            picture: data.user_picture,
                        });
                        console.log('[DashieAuth] Recovered JWT from add-on after first-load race');
                    }
                }
            } catch (e) { /* fall through to throw below */ }
        }
        // Browser-mode first-load race: wait briefly for init() to load the JWT
        // (the add-on path above handles its own equivalent race).
        if (!this.jwt && !this._addonMode) await this._awaitJWT();
        if (!this.jwt) throw new Error('Not authenticated');

        // source_client_id tags every settings write with this Console
        // surface's stable ID. The edge-side broadcaster includes it in
        // the realtime payload; the SettingsSync consumer on this tab
        // sees its own ID and skips its refresh, so we don't trigger
        // ourselves on our own write. Top-level in body so the edge
        // router picks it up regardless of nested data shape.
        const sourceClientId = (typeof window !== 'undefined' && window.SettingsSync)
            ? window.SettingsSync.getClientId()
            : undefined;

        const response = await fetch(this.databaseOpsUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.jwt}`,
                'apikey': this.anonKey,
            },
            body: JSON.stringify({
                operation: operation,
                data: data,
                jwtToken: this.jwt,
                source_client_id: sourceClientId,
            }),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            console.error(`[DashieAuth] dbRequest ${operation} failed ${response.status}:`, err, 'payload:', data);
            const detail = err.error || err.details || err.message || `HTTP ${response.status}`;
            throw new Error(`DB operation failed: ${response.status} - ${detail}`);
        }

        const result = await response.json();
        if (!result.success) {
            console.error(`[DashieAuth] dbRequest ${operation} returned error:`, result, 'payload:', data);
            throw new Error(`DB operation error: ${result.error || 'Unknown'}`);
        }
        return result;
    },

    /**
     * Call any edge function by name with auth
     */
    async edgeFunctionRequest(functionName, body = {}) {
        if (!this.jwt && !this._addonMode) await this._awaitJWT();
        if (!this.jwt) throw new Error('Not authenticated');

        const url = this.config.url + '/functions/v1/' + functionName;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.jwt}`,
                'apikey': this.anonKey,
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(`Edge function ${functionName} failed: ${response.status} - ${err.error || 'Unknown'}`);
        }

        return response.json();
    },

    // Internal: authenticated request to jwt-auth
    async _authRequest(payload) {
        if (!this.jwt) throw new Error('Not authenticated');

        const response = await fetch(this.edgeFunctionUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.jwt}`,
                'apikey': this.anonKey,
            },
            body: JSON.stringify({ ...payload, jwtToken: this.jwt }),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(`Auth request failed: ${response.status} - ${err.error || 'Unknown'}`);
        }

        const data = await response.json();
        if (!data.success) {
            throw new Error(`Auth request error: ${data.error || 'Unknown'}`);
        }
        return data;
    },
};
