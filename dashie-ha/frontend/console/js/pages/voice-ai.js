/* ============================================================
   Voice & AI page — account-global settings.

   Two sections:
   1. AI Defaults — the account-wide ai.* settings (model, web
      search, pictures, conversation memory + duration, always-
      use-AI). Persisted to the user_settings blob; apply to every
      surface signed into this account.
   2. Personalities — the household personality catalog: built-in
      templates (with editable family-notes overrides) and custom
      personalities (full CRUD via the editor modal).

   Per-device choices (which personality/voice a given tablet uses,
   control method, pipeline providers) live on the Devices page, not
   here. All data is in Supabase, so this works in cloud and add-on
   mode alike. Gated alpha-only via FeatureGate.
   ============================================================ */

/** DLG-6 "Open dialog after commands" — keep listening after every COMMAND, not just
 *  questions. Hidden since 2026-07-18 (John): built and verified, but unclear that users
 *  want it once they've lived with it. Kept, not deleted, in case it's requested.
 *
 *  ⚠️ Hiding the row is only half of it. The Android runtime gates the BEHAVIOR on its own
 *  flag (VoiceFeatureFlags.KEEP_DIALOG_OPEN_ENABLED) because accounts already have
 *  voice.alwaysOpenDialog stored TRUE — the cloud/hybrid preset used to seed it — and a
 *  UI-only hide would leave those users chaining with no way to stop it. Stored values are
 *  left intact so re-enabling restores each user's prior choice.
 *
 *  To re-enable: flip this to true, flip the Kotlin flag, and decide deliberately whether
 *  the cloud/hybrid preset should seed it ON again (those two saveDefault calls were
 *  REMOVED, not gated, so "on by default" has to be a fresh choice).
 *
 *  ⚠️ This file is mirrored byte-for-byte into dashieapp_staging/console/ — edit both. */
const KEEP_DIALOG_OPEN_UI = false;

const VoiceAiPage = {
    _defaults: null,        // {dotted: value}
    _engines: null,         // GET /api/voice/engines result — add-on mode only (detection-gated picker)
    _keyStatus: null,       // GET /api/keys/status providers booleans — add-on mode only (preset gating)
    // (household sharing is now the ACCOUNT setting voice.householdSharing — it rides in
    //  _defaults with the other account defaults; the old per-instance _sharing fetch is gone)
    _templates: null,       // built-in personality rows
    _custom: null,          // custom personality rows
    _overrides: null,       // {template_key: {family_notes}}
    _loading: false,
    _error: null,
    _savingKey: null,       // dotted key currently saving (for inline "saving…")
    _syncRegistered: false,
    _activeTab: 'settings', // 'settings' | 'chat' | 'analysis'
    _expandedCards: new Set(), // expanded component cards (model/stt/tts/search)
    _probedOptions: {},     // dotted key → [{value,label}] learned by probing an own-box URL
                            // (Kokoro/Piper voices, Ollama models) → renders as a dropdown
    _previewAudio: null,    // the ▶ voice sample currently playing (never two at once)

    setTab(tab) {
        if (tab !== 'settings' && tab !== 'personalities' && tab !== 'chat' && tab !== 'analysis' && tab !== 'benchmark') return;
        this._activeTab = tab;
        if (tab === 'chat' && typeof VoiceAiChat !== 'undefined' && !VoiceAiChat._open) {
            VoiceAiChat.open();
        }
        App.renderPage();
    },

    // Account-default AI model catalog, grouped by provider. Single source
    // of truth: js/ai/ai-models-catalog.js in dashieapp_staging (bundled
    // into the Console as window.AiModelCatalog at build time). The picker
    // updates automatically when models are added/removed/renamed there —
    // no Console-side edits required, no drift possible.
    get MODEL_GROUPS() {
        if (typeof window.AiModelCatalog === 'undefined') return [];
        return window.AiModelCatalog.dropdownGroups();
    },

    MEMORY_OPTIONS: [
        ['5', '5 minutes'], ['30', '30 minutes'], ['60', '1 hour'],
        ['360', '6 hours'], ['0', 'Never (until refresh)'],
    ],

    // Voice pipeline option sets (account-level) live in window.VoiceAiOptions
    // (voice-ai-options.js): the preset defs (Cloud/Hybrid/Local/HA Assist) and
    // the STT/TTS/search rows. The old controlMethod dropdown and Live/Dialog/
    // Single agent-mode dropdown are replaced by the preset picker + the model
    // card (Live models at top) + the Dialog toggle (Open Brain plan §6).
    // voice.agentMode (live|dialog|single) stays the canonical stored key:
    //   Live model selected in the AI Model card → agentMode='live'
    //   Dialog toggle ON → 'dialog' · OFF → 'single'

    // Live S2S models, grouped at the top of the AI-model card (Cloud preset
    // only — Live is fully cloud + credits). Bound to voice.conversationModel
    // (the Live engine reads it). Speaks in a Google voice (beta).
    // ⚠️ Ids must stay within CONVERSATION_MODEL_IDS (voice-ai-value-ids.js,
    // gated by lint:voice-options). Google retires Live aliases without notice —
    // a retired id here bricks live mode for whoever picks it (the engine
    // self-heals with a 1008 DROP→retry, but pickers must not sell dead models;
    // gemini-2.5-flash-native-audio-latest was removed for exactly this).
    CONVERSATION_MODELS: [
        ['gemini-3.1-flash-live-preview', 'Gemini 3.1 Live'],
        ['gemini-2.5-flash-native-audio-preview-12-2025', 'Gemini 2.5 Live'],
    ],

    // Gemini Live prebuilt voices (voice.liveVoiceName) — the fixed Google roster a
    // Live session can speak in. Ids MUST stay within CONVERSATION_VOICE_IDS
    // (js/data/settings/voice-ai-value-ids.js), gated by lint:voice-options. Labels
    // carry Google's style word; no in-app preview yet (audition at AI Studio).
    CONVERSATION_VOICES: [
        ['Aoede', 'Aoede — Breezy'],
        ['Zephyr', 'Zephyr — Bright'],
        ['Puck', 'Puck — Upbeat'],
        ['Charon', 'Charon — Informative'],
        ['Kore', 'Kore — Firm'],
        ['Fenrir', 'Fenrir — Excitable'],
        ['Leda', 'Leda — Youthful'],
        ['Orus', 'Orus — Firm'],
        ['Callirrhoe', 'Callirrhoe — Easy-going'],
        ['Autonoe', 'Autonoe — Bright'],
        ['Enceladus', 'Enceladus — Breathy'],
        ['Iapetus', 'Iapetus — Clear'],
        ['Umbriel', 'Umbriel — Easy-going'],
        ['Algieba', 'Algieba — Smooth'],
        ['Despina', 'Despina — Smooth'],
        ['Erinome', 'Erinome — Clear'],
        ['Algenib', 'Algenib — Gravelly'],
        ['Rasalgethi', 'Rasalgethi — Informative'],
        ['Laomedeia', 'Laomedeia — Upbeat'],
        ['Achernar', 'Achernar — Soft'],
        ['Alnilam', 'Alnilam — Firm'],
        ['Schedar', 'Schedar — Even'],
        ['Gacrux', 'Gacrux — Mature'],
        ['Pulcherrima', 'Pulcherrima — Forward'],
        ['Achird', 'Achird — Friendly'],
        ['Zubenelgenubi', 'Zubenelgenubi — Casual'],
        ['Vindemiatrix', 'Vindemiatrix — Gentle'],
        ['Sadachbia', 'Sadachbia — Lively'],
        ['Sadaltager', 'Sadaltager — Knowledgeable'],
        ['Sulafat', 'Sulafat — Warm'],
    ],

    /** Drop HA-only voice options (va_default / piper / voice_assistant) for
     *  accounts without Home Assistant. Gated on the live user_profiles.is_ha_user
     *  flag (DashieAuth.isHaUser). Accepts both descriptor objects ({haOnly}) and
     *  the control-method [value, label, haOnly] tuples. */
    _haFilter(options) {
        if (DashieAuth.isHaUser) return options;
        return options.filter(o => Array.isArray(o) ? !o[2] : !o.haOnly);
    },

    render() {
        const editorHtml = (typeof VoiceAiPersonalityEdit !== 'undefined') ? VoiceAiPersonalityEdit.render() : '';
        const tabBar = this._renderTabBar();

        if (this._activeTab === 'chat') {
            // VoiceAiChat owns its own state; just render it under the tab bar.
            const chatHtml = (typeof VoiceAiChat !== 'undefined' && VoiceAiChat._open)
                ? VoiceAiChat.render()
                : `<div style="color: var(--text-muted); padding: 40px 0; text-align: center;">Opening chat…</div>`;
            return `${tabBar}${chatHtml}${editorHtml}`;
        }

        if (this._activeTab === 'analysis') {
            const html = (typeof VoiceAiAnalysis !== 'undefined')
                ? VoiceAiAnalysis.render()
                : `<div style="color: var(--text-muted); padding: 40px 0; text-align: center;">Analysis unavailable.</div>`;
            return `${tabBar}${html}${editorHtml}`;
        }

        if (this._activeTab === 'benchmark') {
            const html = (typeof VoiceAiBenchmark !== 'undefined')
                ? VoiceAiBenchmark.render()
                : `<div style="color: var(--text-muted); padding: 40px 0; text-align: center;">Benchmark unavailable.</div>`;
            return `${tabBar}${html}${editorHtml}`;
        }

        if (!this._defaults && !this._loading && !this._error) {
            this._fetch();
            return `${tabBar}${this._renderLoading()}${editorHtml}`;
        }
        if (this._loading && !this._defaults) return `${tabBar}${this._renderLoading()}${editorHtml}`;
        if (this._error && !this._defaults) return `${tabBar}${this._renderError()}${editorHtml}`;

        if (this._activeTab === 'personalities') {
            return `${tabBar}<div style="max-width: 760px;">${this._renderPersonalities()}</div>${editorHtml}`;
        }
        return `${tabBar}${this._renderMain()}${editorHtml}`;
    },

    /** Tab strip rendered at the top of every Voice & AI sub-view.
     *  Replaces the old "AI Chat Interface" top-bar button. */
    _renderTabBar() {
        const tab = (id, label) => {
            const active = this._activeTab === id;
            return `
                <button onclick="VoiceAiPage.setTab('${id}')"
                    style="background: none; border: none; padding: 10px 4px; cursor: pointer; font-size: 14px; font-weight: ${active ? '600' : '500'};
                           color: ${active ? 'var(--text-primary)' : 'var(--text-muted)'};
                           border-bottom: 2px solid ${active ? 'var(--accent)' : 'transparent'};
                           margin-bottom: -1px;">
                    ${label}
                </button>`;
        };
        return `
            <div style="display: flex; gap: 24px; border-bottom: 1px solid var(--border, #d1d5db); margin-bottom: 20px; max-width: 760px;">
                ${tab('settings', 'Voice & AI Settings')}
                ${tab('personalities', 'Personalities')}
                ${tab('chat', 'AI Chat Interface')}
                ${tab('analysis', 'History')}
                ${tab('benchmark', 'Benchmark')}
            </div>`;
    },

    topBarTitle() { return 'Voice & AI'; },
    topBarSubtitle() { return 'Account-wide AI defaults and personalities'; },

    // Tab strip in _renderTabBar() replaces the old "AI Chat Interface"
    // action button — keeping topBarActions absent so the top-bar UI is
    // empty here (matches every other inline-tabbed page in the Console).

    onNavigateTo() { this._fetch(); },

    async refresh() {
        // The top-bar refresh must reload whatever sub-tab is showing, not just the
        // Settings data. The Analysis tab owns its own server fetch (the intelligence
        // log) — delegate to it so a click pulls fresh interactions.
        if (this._activeTab === 'analysis' && typeof VoiceAiAnalysis !== 'undefined') {
            return VoiceAiAnalysis.refresh();
        }
        if (this._activeTab === 'benchmark' && typeof VoiceAiBenchmark !== 'undefined') {
            return VoiceAiBenchmark.refresh();
        }
        // Top-bar refresh forces a fresh engine scan — so re-detecting after
        // installing a Piper/Whisper add-on is just "refresh the page".
        await this._fetch(true);
    },

    _registerSyncOnce() {
        if (this._syncRegistered || !window.SettingsSync) return;
        this._syncRegistered = true;
        // Personality writes broadcast 'personalities' from the edge handler;
        // refresh the catalog when another surface edits it.
        window.SettingsSync.register('personalities', async () => {
            if (App._currentPage !== 'voice-ai') return;
            await this._fetchPersonalities();
            App.renderPage();
        });
    },

    async _fetch(forceEngines = false) {
        this._registerSyncOnce();
        this._loading = true;
        this._error = null;
        try {
            // Which keys are actually PERSISTED (vs DEFAULTS-filled) — the fresh-account
            // seed gates on this so it never overwrites an explicit stored choice.
            const storedKeys = new Set();
            const [defaults] = await Promise.all([
                VoiceAiApi.loadAiDefaults(storedKeys),
                this._fetchPersonalities(),
                // Live margined rate card for the TTS/Search cost strings —
                // internally best-effort, falls back to the hardcoded estimates.
                window.VoiceAiOptions?.applyLiveRates?.(),
                // BYO-key booleans (add-on API Keys page) — gate the Cloud/Hybrid
                // presets on credits OR a key. Best-effort — null on failure.
                this._fetchKeyStatus(),
            ]);
            this._defaults = defaults;
            this._storedKeys = storedKeys;
            // Household sharing is ACCOUNT-scoped (voice.householdSharing) as of 2026-07-13 —
            // it arrives with the account defaults above. The old per-instance /api/settings
            // fetch is gone: storing it on the add-on's /data made a new/wiped account inherit
            // the previous account's sharing state.
            // Piper active but no voice stored (pre-seeding account) → persist
            // amy (low) so the Voice row never renders unset.
            this._seedPiperVoiceIfMissing();
            // Fresh-account default seed — persist the effective config once so the
            // account's stored config == what the UI shows.
            this._seedFreshAccountDefaults();
            // Wake word needs its OWN seed, not a line inside the fresh-account one:
            // that seed early-returns on any account that already picked a preset, i.e.
            // every existing household. They'd render "Hey Dashie" (from DEFAULTS) while
            // user_settings held nothing — and everything downstream reads the PERSISTED
            // value (Kotlin, the brain, the kiosk mirror), so they'd all see nothing.
            // That's Invariant 5's exact gap. Runs for every account, exactly once.
            this._seedWakeWordIfMissing();
            // Saved local engines (Local Engines page) — they render as named rows in the
            // TTS/STT/model pickers, so the list must be cached before the first paint.
            if (window.EnginesStore && DashieAuth.isAddonMode) {
                await EnginesStore.list().catch(() => []);
            }
            // Ask any already-configured own-box engine for its voice/model list so those
            // fields render as dropdowns without the user pressing Test. Not awaited —
            // a LAN box that's off must not delay the page; it re-renders if it answers.
            this._autoProbeLocalUrls();
            // Local-engine DETECTION (GET /api/voice/engines) is a slow LAN scan — the #1 cause of
            // the "stuck on Loading" first open. NEVER block first paint on it: the picker degrades
            // gracefully to URL-based rows when _engines is null, then re-renders when detection
            // lands. Background it here (a forced top-bar refresh awaits it below so "refresh"
            // reflects a completed rescan).
            const enginesDone = this._fetchEngines(forceEngines)
                .then(() => {
                    // The Piper voice seed needs the DETECTED voice list (_defaultPiperVoice reads
                    // _engines) — it ran as a no-op above before detection landed, so re-run it now.
                    // Idempotent: only seeds when ha_engine is active and no voice is stored yet.
                    this._seedPiperVoiceIfMissing();
                    if (App._currentPage === 'voice-ai') App.renderPage();
                })
                .catch(() => {});
            if (forceEngines) await enginesDone;
        } catch (e) {
            console.error('[VoiceAiPage] fetch failed:', e);
            this._error = e.message || String(e);
        } finally {
            this._loading = false;
            App.renderPage();
            // First-open nudge (once per account) to enable Household Sharing so
            // this HA user's kiosk tablets / voice satellites can use the account.
            this._maybePromptHouseholdSharing();
        }
    },

    async _fetchPersonalities() {
        const [templates, custom, overrides] = await Promise.all([
            VoiceAiApi.listTemplates().catch(() => []),
            VoiceAiApi.listCustom().catch(() => []),
            VoiceAiApi.listOverrides().catch(() => []),
        ]);
        this._templates = templates;
        this._custom = custom;
        this._overrides = {};
        for (const o of overrides) this._overrides[o.template_key] = o;
    },

    /** Fetch local voice engine detection (GET /api/voice/engines). Add-on mode
     *  only — a cloud console has no direct line to the user's HA (decision §11.4),
     *  so detection is empty there and the picker shows URL-based local_* rows only.
     *  Best-effort: any failure leaves _engines null (picker degrades, never breaks). */
    /** Fetch local voice engine detection. `force` bypasses the server's 5-min
     *  cache (?refresh=1) — used by the top-bar page refresh so re-scanning after
     *  installing an engine is just the normal refresh. `cache:'no-store'` stops
     *  the browser/ingress serving a stale response (mirrors _probeAddonMode). */
    async _fetchEngines(force = false) {
        if (!DashieAuth.isAddonMode) { this._engines = null; return; }
        try {
            const url = DashieAuth._addonUrl('/api/voice/engines' + (force ? '?refresh=1' : ''));
            const r = await fetch(url, { cache: 'no-store' });
            this._engines = r.ok ? await r.json() : null;
        } catch (e) {
            console.warn('[VoiceAiPage] engine detection unavailable:', e?.message || e);
            this._engines = null;
        }
    },

    /** Which BYO providers have a key on the box (booleans only, never the
     *  keys). Add-on mode only; null elsewhere / on failure — the preset
     *  gate then rests on credits alone. */
    async _fetchKeyStatus() {
        if (!DashieAuth.isAddonMode) { this._keyStatus = null; return; }
        try {
            const r = await fetch(DashieAuth._addonUrl('/api/keys/status'), { cache: 'no-store' });
            this._keyStatus = r.ok ? (await r.json())?.providers || null : null;
        } catch (e) {
            console.warn('[VoiceAiPage] key status unavailable:', e?.message || e);
            this._keyStatus = null;
        }
    },

    getCustom(id) {
        return (this._custom || []).find(p => p.id === id) || null;
    },
    getTemplate(key) {
        return (this._templates || []).find(t => (t.key || t.id) === key) || null;
    },
    overrideNotes(key) {
        return this._overrides?.[key]?.family_notes || '';
    },

    // ── AI default writes ────────────────────────────────────

    async saveDefault(dottedKey, rawValue) {
        // Coerce to the stored type: timeout numeric; model/control-method/STT/TTS
        // are string selects; everything else boolean.
        let value = rawValue;
        const STRING_KEYS = ['ai.model', 'voice.controlMethod', 'voice.conversationModel', 'voice.liveVoiceName', 'voice.agentMode',
            'voice.pipelinePreset',   // cloud | hybrid | local | ha_assist (Open Brain §6)
            'ai.defaultPersonalityId', 'ai.defaultVoiceKey', 'ai.defaultWakeWord',   // account defaults (WS-G Round A)
            'voice.sttProvider', 'voice.ttsProvider',
            'voice.searchSource', 'voice.sportsSource',
            'voice.entitySource',   // 'dashboard' | 'assist' — MUST be a string enum, never coerced to a boolean
            'voice.localLlmUrl', 'voice.localLlmModel',
            'voice.searxngUrl', 'voice.localTtsUrl', 'voice.localTtsVoiceId', 'voice.localSttUrl',
            'voice.localLlmKey',   // BYO-model API key (remote endpoints) — WS-I; read server-side by node-io.js
            'voice.hermesUrl',     // Hermes Agent endpoint — WS-I; key lives in the on-box key store (API Keys page)
            // engine-direct HA voice (detection-gated picker, build plan §8)
            'voice.haTtsEngineId', 'voice.haTtsVoiceId', 'voice.haSttEngineId'];
        if (dottedKey === 'ai.conversationTimeout') value = Number(rawValue);
        else if (STRING_KEYS.includes(dottedKey)) value = String(rawValue);
        else value = (rawValue === true || rawValue === 'true');

        const prev = this._defaults[dottedKey];
        this._defaults[dottedKey] = value;
        this._savingKey = dottedKey;
        App.renderPage();
        try {
            await VoiceAiApi.saveAiDefault(dottedKey, value);
        } catch (e) {
            console.error('[VoiceAiPage] save default failed:', e);
            this._defaults[dottedKey] = prev;  // roll back
            Toast.error(Toast.friendly ? Toast.friendly(e, 'save setting') : `Save failed: ${e.message}`);
        } finally {
            this._savingKey = null;
            App.renderPage();
        }
    },

    // ── Preset handling (Open Brain §6) ──────────────────────

    /** The active preset: the stored voice.pipelinePreset, or — for accounts
     *  that predate presets — a display-only derivation from the granular keys
     *  (persisted on the user's first preset click, matching the no-migration
     *  _LEGACY_MAP pattern). */
    _activePreset() {
        const d = this._defaults;
        const stored = String(d['voice.pipelinePreset'] || '');
        if (stored) return stored;
        if (String(d['voice.controlMethod']) === 'voice_assistant') return 'ha_assist';
        const localVoice = String(d['voice.ttsProvider']) !== 'dashie_cloud'
            && String(d['voice.sttProvider']) !== 'dashie_cloud';
        if (['local', 'hermes'].includes(String(d['ai.model'])) && localVoice) return 'local';
        if (localVoice) return 'hybrid';
        return 'cloud';
    },

    /** Cloud & Hybrid need credits OR a BYO AI key; Local & HA Assist are
     *  always available. Optimistic while balances are still loading so the
     *  picker never flash-disables. */
    _presetAvailable(id) {
        const p = window.VoiceAiOptions.PRESETS.find(x => x.id === id);
        if (!p?.needsCreditsOrKey) return true;
        return this._hasCreditsOrKey();
    },

    _hasCreditsOrKey() {
        // Accounts that don't see the credits feature aren't metered from the
        // console's perspective — don't lock their presets.
        if (typeof FeatureGate !== 'undefined' && !FeatureGate.shouldShow('credits')) return true;
        // A BYO provider key unlocks a cloud-AI preset in EVERY mode, including
        // local: the key lives on the box (/data/api-keys.json) and the brain runs
        // BYOK without an account. Checked before the local-mode bail below on
        // purpose — "no account" must not lock a user out of their own key.
        if (this._keyStatus && Object.values(this._keyStatus).some(Boolean)) return true;
        // Local mode: no account, therefore no credit balance to spend. This is
        // the one place the answer is a definite NO rather than the optimistic
        // default below — and it must not fall through to the balance check,
        // whose "still loading → true" would flash the presets as available.
        if (typeof DashieAuth !== 'undefined' && DashieAuth.isLocalMode) return false;
        const bal = window.CreditsService?.balance();
        if (!bal || typeof bal.balance !== 'number') return true;   // still loading → optimistic
        return bal.balance > 0;
    },

    /** Why a Cloud/Hybrid card is locked, for the card's own copy. */
    _lockedPresetReason() {
        if (typeof DashieAuth !== 'undefined' && DashieAuth.isLocalMode) {
            return `Needs a ${BRAND.productName} account — or add your own AI key`;
        }
        return null;   // signed in: the existing out-of-credits treatment applies
    },

    /**
     * An UNAVAILABLE Cloud/Hybrid card was clicked — try the one-time starter grant
     * before sending the user off to buy credits.
     *
     * Mirrors the tablet's blocked-preset tap (Android SettingsCallbackWiring →
     * StarterGrantClient). A household can activate voice from either surface, and the
     * grant is keyed to the ACCOUNT server-side (`credit_grants.source_ref` unique
     * index), so whichever surface gets there first wins and the other reports
     * `already_claimed` — there is no double-grant to defend against here, and no local
     * "claimed" flag to keep in sync between console and tablet.
     *
     * Falls back to today's behaviour — the Credits page — on anything but a fresh
     * grant, INCLUDING a thrown request. A failure must never leave the click silent
     * (the picker's standing rule) and must never assert credits we can't substantiate.
     */
    async tryStarterGrant(id) {
        const O = window.VoiceAiOptions;
        if (!O.PRESETS.some(p => p.id === id)) return;
        // Local mode: the grant is keyed to an ACCOUNT server-side, so there is
        // nothing to claim and dbRequest would 401. The click still must not be
        // silent (the picker's standing rule) — route to the door instead.
        if (typeof DashieAuth !== 'undefined' && DashieAuth.isLocalMode) {
            App.startSignIn();
            return;
        }
        let res = null;
        try {
            res = await DashieAuth.dbRequest('claim_starter_grant', {});
        } catch (e) {
            console.warn('[VoiceAiPage] starter-grant claim failed:', e.message);
        }

        if (res?.granted) {
            // Refresh the balance BEFORE selectPreset — it re-checks _presetAvailable()
            // against CreditsService's cache, so without this the preset we just funded
            // would still read as unavailable and the click would no-op.
            await window.CreditsService?.fetch({ force: true });
            const amount = this._formatUsd(res.amount);
            // Bare "credits", not BRAND.cloudName — every other console surface (sidebar,
            // credits page, expiry notice, buy modal) says plain "credits". Not rebranding
            // the console's credits noun as a side effect of this feature; if that noun
            // should change, it changes on its own. (The original reason was that cloudName
            // differed per build; it no longer does, but "credits" is still the right word
            // and still what every other surface says.)
            await ConfirmModal.confirm({
                title: 'Cloud Voice & AI',
                message:
                    `Cloud voice & AI runs on credits, which are billed as you use them.` +
                    `\n\nWe've added ${amount} to your account so you can try it out. ` +
                    `You can add more any time, or set up local AI & voice engines instead.`,
                confirmLabel: 'Start using voice',
                hideCancel: true,
            });
            this.selectPreset(id);
            return;
        }

        // Already claimed but funded → the picker was reading a stale balance; just let
        // them through rather than sending a user who has money to the buy page.
        if (res && typeof res.balance === 'number' && res.balance > 0) {
            await window.CreditsService?.fetch({ force: true });
            this.selectPreset(id);
            return;
        }

        App.navigate('credits');
    },

    /** "$0.50", "$1", "$1.25" — a trailing ".00" reads like a price tag on a free thing. */
    _formatUsd(v) {
        const n = Number(v) || 0;
        return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
    },

    /** Preset card clicked. Persists voice.pipelinePreset, keeps the runtime's
     *  engine-domain key (voice.controlMethod) in sync for old APKs, and seeds
     *  any granular provider the new preset filters out — Customize can diverge
     *  afterwards. Explicitly guarded: an unavailable preset never saves
     *  (degradation rule — no silent fall-through to metered usage). */
    selectPreset(id) {
        const O = window.VoiceAiOptions;
        if (!O.PRESETS.some(p => p.id === id)) return;
        if (!this._presetAvailable(id)) return;
        const d = this._defaults;
        this.saveDefault('voice.pipelinePreset', id);
        const cm = id === 'ha_assist' ? 'voice_assistant' : 'dashie_cloud';
        // Persist controlMethod UNCONDITIONALLY (even when it already equals the preset
        // default) so user_settings is the single source of truth. Previously skipped when
        // == default, leaving it blank for accounts on a default — which the anon-kiosk
        // mirror then couldn't read (it had to derive it in the add-on, now removed).
        // 2026-07-13 kiosk-voice-mirror §2/§5 Option A (controlMethod).
        this.saveDefault('voice.controlMethod', cm);

        // Live is Cloud-only (fully cloud + credits) — leaving Cloud drops the
        // agent back to a cascade mode.
        if (id !== 'cloud' && this._agentMode() === 'live') {
            this.saveDefault('voice.agentMode', 'single');
        }
        if (id !== 'ha_assist') {
            // AI model: Local runs the user's own model; Cloud/Hybrid run a cloud
            // model (credits or BYO key — the key routing itself is Phase 2).
            // HA Assist has no Dashie brain → ai.model untouched.
            const model = String(d['ai.model'] || '');
            // 'local' and 'hermes' are both local-family sentinels — entering the
            // Local preset must not clobber a Hermes choice, and leaving it resets
            // either back to the cloud default.
            const isLocalModel = model === 'local' || model === 'hermes';
            if (id === 'local' && !isLocalModel) this.saveDefault('ai.model', 'local');
            if (id !== 'local' && isLocalModel) this.saveDefault('ai.model', VoiceAiApi.DEFAULTS['ai.model']);
        }
        // Voice engines: seed only when the current provider contradicts the
        // preset (it would vanish from the filtered picker otherwise).
        this._seedProvider(id, 'tts', 'voice.ttsProvider');
        this._seedProvider(id, 'stt', 'voice.sttProvider');

        // Cloud-AI feature defaults (John, 2026-07-13): Cloud & Hybrid turn on
        // conversation dialog + open-dialog-after-commands + retrieve pictures
        // out of the box — they're the cloud-brain presets where these shine.
        // Local / HA Assist drop Retrieve pictures (it's cloud web-image search,
        // billed to credits); dialog is left as-is for those. Writes real values
        // so the Android runtime honors them, not just the console display.
        if (id === 'cloud' || id === 'hybrid') {
            if (this._agentMode() !== 'live') this.saveDefault('voice.agentMode', 'dialog');
            // voice.alwaysOpenDialog is no longer seeded ON — the row is hidden
            // (KEEP_DIALOG_OPEN_UI) and the runtime ignores it, so seeding it would only
            // write state the user can't see or change.
            this.saveDefault('ai.retrievePicturesEnabled', true);
        } else if (id === 'local' || id === 'ha_assist') {
            this.saveDefault('ai.retrievePicturesEnabled', false);
        }
    },

    /**
     * Fresh-account default seed (2026-07-13) — closes the "effective vs persisted" gap.
     *
     * The console's DEFAULTS are DISPLAY-only. A brand-new account that never clicks a
     * preset persists NOTHING, so `user_settings` is empty while the UI shows
     * Cloud / dialog / pictures. Everything that actually reads the account — the Android
     * runtime and the anon-kiosk voice mirror — reads PERSISTED `user_settings`, so it saw
     * none of it (kiosk kept its own defaults; dialog + pictures read as off).
     *
     * Persist the effective config ONCE, on first Voice & AI render, so stored == shown.
     * Runs only while no preset is stored, so it's exactly-once per account.
     *
     * Deliberately does NOT route through selectPreset(): that guards on _presetAvailable()
     * (credits / BYO key), and a fresh $0 account would seed nothing — but Cloud IS its
     * default config regardless of balance.
     */
    /**
     * Persist ai.defaultWakeWord once, if the account never stored one (Invariant 5 —
     * "a writer must PERSIST what it SHOWS"; display-defaults are not state).
     *
     * Gated on _storedKeys, NOT on the merged `_defaults` value: post-merge you cannot
     * tell "unset" from "stored, equal to the default", and a seed that can't tell the
     * difference will happily overwrite a household's real choice on every page load.
     * That is the haTtsVoiceId self-clobber (audit #2), which silently re-defaulted the
     * user's Piper voice on EVERY console load and mirrored it out to every tablet.
     *
     * Idempotent: once the key is stored, _storedKeys carries it and this no-ops.
     */
    _seedWakeWordIfMissing() {
        const stored = this._storedKeys;
        if (!stored || stored.has('ai.defaultWakeWord')) return;
        const fallback = VoiceAiApi.DEFAULTS['ai.defaultWakeWord'];
        // Never seed a word no APK bundles — the id list is lint-gated against Kotlin's
        // WakeWordModel, so a bad value here can't reach a device, but be explicit.
        const valid = (window.VoiceAiOptions?.WAKE_WORDS || []).some(w => w.id === fallback);
        if (!valid) return;
        this.saveDefault('ai.defaultWakeWord', fallback);
    },

    _seedFreshAccountDefaults() {
        const d = this._defaults;
        if (!d) return;
        if (String(d['voice.pipelinePreset'] || '')) return;   // already chosen/seeded
        const preset = this._activePreset();                   // derived — 'cloud' for a fresh account
        if (!preset) return;

        this.saveDefault('voice.pipelinePreset', preset);
        this.saveDefault('voice.controlMethod', preset === 'ha_assist' ? 'voice_assistant' : 'dashie_cloud');
        this.saveDefault('voice.sttProvider', String(d['voice.sttProvider'] || 'dashie_cloud'));
        this.saveDefault('voice.ttsProvider', String(d['voice.ttsProvider'] || 'dashie_cloud'));
        if (String(d['ai.model'] || '')) this.saveDefault('ai.model', String(d['ai.model']));

        // Cloud/Hybrid ship the conversational defaults ON out of the box — but only
        // for keys the account has never stored. `d` is post-DEFAULTS merge, so it can't
        // distinguish "unset" from "stored default"; _storedKeys can. Legacy no-preset
        // accounts (everyone before the preset-persist fix) reach this seed too, and an
        // unconditional write here flipped their explicit single/false choices back on.
        if (preset === 'cloud' || preset === 'hybrid') {
            const stored = this._storedKeys || new Set();
            if (!stored.has('voice.agentMode') && this._agentMode() !== 'live') this.saveDefault('voice.agentMode', 'dialog');
            if (!stored.has('ai.retrievePicturesEnabled')) this.saveDefault('ai.retrievePicturesEnabled', true);
        }
    },

    /** Seed a stage's provider to the preset's natural default (John, 2026-07-11):
     *  - Cloud: both stages → dashie_cloud (when the current choice isn't cloud).
     *  - Hybrid: voice goes LOCAL — TTS flips to detected Piper, else Android
     *    voice; STT flips to detected Whisper, else STAYS on Deepgram (Android
     *    STT would be a quality downgrade nobody asked for).
     *  - Local: cloud rows are filtered out, so anything cloud/invalid reseeds
     *    to the detected HA engine, else Android voice.
     *  A current choice that's already valid-and-local for the preset is never
     *  overridden (e.g. own-box Kokoro/Whisper URLs stay picked). */
    _seedProvider(presetId, stageKey, dottedKey) {
        const O = window.VoiceAiOptions;
        const all = stageKey === 'tts' ? O.ttsOptions(this._engines) : O.sttOptions(this._engines);
        const opts = O.presetFilter(presetId, this._haFilter(all)).filter(o => !o.install);
        const current = String(this._defaults[dottedKey] || '');
        const has = id => opts.some(o => o.id === id);
        // A saved engine REPLACES the inline local_url/local_stt_url row, so the stored
        // provider value has no matching row id — but it's a perfectly valid local
        // choice. Without this, switching preset would reseed over the user's engine.
        //
        // ⚠️ But the engine only VALIDATES the current provider when the target preset
        // actually permits a local engine — so test the engine's ROW against the same
        // preset filter, don't just ask "does a saved engine exist?".
        //
        // Bug this fixes (2026-07-14): `!!this._engineRowId(stageKey)` is preset-blind —
        // it asks EnginesStore whether a saved engine matches the current flat settings,
        // full stop. Any household with a saved local engine therefore had currentValid
        // === true under EVERY preset, so switching to Cloud hit the `if (currentValid)
        // return` below and NEVER reseeded the providers. Flipping Hybrid → Cloud wrote
        // pipelinePreset='cloud' + controlMethod='dashie_cloud' (and agentMode /
        // alwaysOpenDialog / retrievePictures) while leaving sttProvider='local_stt_url'
        // and ttsProvider='local_url' pointed at the user's own box.
        //
        // The result was a half-applied preset that every downstream surface then synced
        // faithfully: the console card said "Cloud", the tablet's voice settings showed
        // the old local providers, and the pipeline really did still run on the user's
        // Whisper/Kokoro. It reads as "settings sync is stale" — but the sync was right;
        // the account row itself was inconsistent. (Found on floridalerches, whose three
        // saved engines made currentValid unconditionally true.)
        //
        // presetFilter drops locality:'local' rows under 'cloud', so has(engineRow) is
        // false there → we now correctly reseed to dashie_cloud. Under hybrid/local/
        // ha_assist the engine rows survive the filter, so behaviour is unchanged and the
        // user's saved engine is still protected — which was the point of this hatch.
        const engineRow = this._engineRowId(stageKey);
        const currentValid = has(current) || (!!engineRow && has(engineRow));
        const hasHaEngine = has('ha_engine');

        if (presetId === 'hybrid') {
            const currentIsLocal = currentValid && current !== 'dashie_cloud';
            if (currentIsLocal) return;   // deliberate local choice — keep it
            // Hybrid = cloud AI + on-device voice: default to the BUNDLED on-device engines
            // (sherpa STT / built-in device TTS), not HA Whisper/Piper (John 2026-07-28). The
            // device's provider chain falls back to HA/cloud where the engine isn't bundled.
            if (stageKey === 'tts') {
                this._selectProvider('tts', has('android_voice') ? 'android_voice' : 'dashie_cloud');
            } else {
                this._selectProvider('stt', has('sherpa_moonshine_tiny') ? 'sherpa_moonshine_tiny' : 'dashie_cloud');
            }
            return;
        }
        if (currentValid) return;
        const seed = presetId === 'cloud' ? 'dashie_cloud'
            : presetId === 'ha_assist' ? 'va_default'   // the Assist pipeline itself
            : (hasHaEngine ? 'ha_engine' : 'android_voice');
        if (!has(seed)) return;
        this._selectProvider(stageKey, seed);
    },

    /** Persist a TTS/STT provider choice, pinning the detected HA engine id
     *  alongside `ha_engine` selections (single-canonical-row decision §11.1). */
    _selectProvider(stageKey, id) {
        const O = window.VoiceAiOptions;
        if (stageKey === 'tts' && id === 'ha_engine') {
            const eng = O.ttsOptions(this._engines).find(o => o.id === 'ha_engine');
            if (eng?.engineId) this.saveDefault('voice.haTtsEngineId', eng.engineId);
            // Piper always has a concrete voice — default amy (low) (John, 2026-07-12).
            if (!String(this._defaults['voice.haTtsVoiceId'] || '')) {
                this.saveDefault('voice.haTtsVoiceId', this._defaultPiperVoice() || 'en_US-amy-low');
            }
        } else if (stageKey === 'tts' && id === 'local_url') {
            // Own-box TTS always needs a concrete voice: the native client's built-in
            // default is Kokoro's 'af_heart', which a Piper box doesn't have. Seed the
            // first probed/detected voice so an un-touched Voice field still speaks.
            if (!String(this._defaults['voice.localTtsVoiceId'] || '')) {
                const v = this._probedOptions['voice.localTtsVoiceId']?.[0]?.value
                    || (this._engines?.kokoro?.voices || [])[0];
                if (v) this.saveDefault('voice.localTtsVoiceId', typeof v === 'string' ? v : v.voice_id);
            }
        } else if (stageKey === 'stt' && id === 'ha_engine') {
            const eng = O.sttOptions(this._engines).find(o => o.id === 'ha_engine');
            if (eng?.engineId) this.saveDefault('voice.haSttEngineId', eng.engineId);
        }
        this.saveDefault(stageKey === 'tts' ? 'voice.ttsProvider' : 'voice.sttProvider', id);
    },

    /** amy (low) from the detected Piper voice list — the default voice a
     *  Piper selection should always carry. Null when detection is empty. */
    _defaultPiperVoice() {
        const eng = window.VoiceAiOptions.ttsOptions(this._engines).find(o => o.id === 'ha_engine');
        const voices = (eng?.configFields || []).find(f => f.key === 'voice.haTtsVoiceId')?.options || [];
        if (!voices.length) return null;
        const amy = voices.find(v => /amy/i.test(v.value) && /low/i.test(v.value))
            || voices.find(v => /amy/i.test(v.value));
        return (amy || voices[0]).value;
    },

    /** Self-heal for accounts that picked Piper before voice seeding existed
     *  (or whose voice was clobbered): Piper active + no stored voice +
     *  detection has voices → persist amy (low). Runs once per fetch; the
     *  Voice row never shows "— pick a voice —". */
    _seedPiperVoiceIfMissing() {
        const d = this._defaults;
        if (!d || String(d['voice.ttsProvider']) !== 'ha_engine') return;
        if (String(d['voice.haTtsVoiceId'] || '')) return;
        const v = this._defaultPiperVoice();
        if (v) this.saveDefault('voice.haTtsVoiceId', v);
    },

    /** Canonical agent mode (live|dialog|single), deriving the legacy
     *  conversationAlways/conversationModel pair for unmigrated accounts —
     *  mirrors voice-command-router._conversationMode. */
    _agentMode() {
        const d = this._defaults;
        const stored = String(d['voice.agentMode'] || '');
        if (stored) return stored;
        const always = d['voice.conversationAlways'] === true;
        const lm = String(d['voice.conversationModel'] || '');
        return always ? (lm ? 'live' : 'dialog') : 'single';
    },

    /** Dialog toggle (shown when a non-Live model is selected):
     *  ON → conversation dialog (mic stays open) · OFF → single response. */
    setDialogMode(on) {
        this.saveDefault('voice.agentMode', on ? 'dialog' : 'single');
    },

    // ── Component-card handlers ──────────────────────────────

    /** Card option chosen → map the stage to its dotted key and persist.
     *  The model card mixes Live models (top group, Cloud preset) with cascade
     *  models: picking a Live model sets agentMode='live' + conversationModel
     *  (ai.model untouched); picking a cascade model saves ai.model and drops
     *  a live agent back to single (the Dialog toggle re-enables dialog). */
    selectOption(stageKey, id) {
        // A saved-engine row (Local Engines page): "+ Add…" navigates there; a real
        // engine resolves into the flat account keys the tablets read — the device
        // never learns the engine registry exists.
        const P = window.VoiceAiOptions.ENGINE_ROW_PREFIX;
        if (typeof id === 'string' && id.startsWith(P)) {
            this._expandedCards.delete(stageKey);
            const engineId = id.slice(P.length);
            if (engineId === 'add') { App.navigate('local-engines'); return; }
            const engine = window.EnginesStore?.get(engineId);
            if (!engine) return;
            for (const [key, value] of window.EnginesStore.resolveToSettings(engine)) {
                this.saveDefault(key, value);
            }
            // A local model can't run the Live (S2S) agent — drop back to the cascade.
            if (engine.kind === 'llm' && this._agentMode() === 'live') this.saveDefault('voice.agentMode', 'single');
            // TTS: the voice lives on this page, not in the engine — and the voice that was
            // set for the PREVIOUS box almost certainly doesn't exist on this one. Ask the
            // new box what it has and re-seed if the current voice isn't among them.
            if (engine.kind === 'tts') this._reseedVoiceForEngine(engine);
            return;
        }
        // Collapse back to the chosen option — unless it still needs config
        // (a local engine with no URL/model yet): keep the picker open so the
        // required fields are right there, instead of forcing a reopen.
        if (this._needsConfig(stageKey, id)) this._expandedCards.add(stageKey);
        else this._expandedCards.delete(stageKey);
        if (stageKey === 'model') {
            const isLiveModel = this.CONVERSATION_MODELS.some(([v]) => v === id);
            if (isLiveModel) {
                if (this._agentMode() !== 'live') this.saveDefault('voice.agentMode', 'live');
                this.saveDefault('voice.conversationModel', id);
            } else {
                if (this._agentMode() === 'live') this.saveDefault('voice.agentMode', 'single');
                this.saveDefault('ai.model', id);
            }
            return;
        }
        if (stageKey === 'tts' || stageKey === 'stt') {
            this._selectProvider(stageKey, id);
            return;
        }
        if (stageKey === 'search') {
            // 'None' replaces the old Web-search toggle: it maps to
            // ai.webSearchEnabled=false (searchSource untouched, so switching
            // back restores the prior provider). 'google' is display-only (the
            // Gemini-grounding pseudo-source) — never persisted as a source.
            if (id === 'none') {
                this.saveDefault('ai.webSearchEnabled', false);
                return;
            }
            if (this._defaults['ai.webSearchEnabled'] !== true) this.saveDefault('ai.webSearchEnabled', true);
            if (id !== 'google') this.saveDefault('voice.searchSource', id);
            return;
        }
        if (stageKey === 'sports') this.saveDefault('voice.sportsSource', id);
        // HA entities card: 'dashboard' | 'assist' → voice.entitySource (serialized write).
        if (stageKey === 'entities') this.setEntitySource(id);
    },

    /** Inline local-config field (endpoint URL, model, SearXNG URL) → persist as string. */
    saveLocalField(dottedKey, value) {
        this.saveDefault(dottedKey, value);
    },

    /** True when an option carries `required` config fields that are still
     *  empty (e.g. a local engine whose box URL was never entered) — used by
     *  selectOption to keep the picker open until the option is usable. */
    _needsConfig(stageKey, id) {
        const opt = this._stageOptions(stageKey).find(o => o.id === id);
        return (opt?.configFields || []).some(f =>
            f.required && !String(this._defaults[f.key] || '').trim());
    },

    /** The full (unfiltered) option list backing a stage card. */
    _stageOptions(stageKey) {
        const O = window.VoiceAiOptions;
        if (stageKey === 'tts') return O.ttsOptions(this._engines);
        if (stageKey === 'stt') return O.sttOptions(this._engines);
        if (stageKey === 'model') return this._modelOptions(this._activePreset());
        return [];
    },

    /** Expand/collapse a component card. */
    toggleCard(stageKey) {
        if (this._expandedCards.has(stageKey)) this._expandedCards.delete(stageKey);
        else this._expandedCards.add(stageKey);
        App.renderPage();
    },

    // ── Personality actions ──────────────────────────────────

    async deleteCustom(id) {
        const p = this.getCustom(id);
        const ok = await ConfirmModal.confirm({
            title: 'Delete personality',
            message: `"${p?.name || 'This personality'}" will be removed from your account. Any device using it falls back to ${BRAND.assistantName}.`,
            confirmLabel: 'Delete',
            danger: true,
        });
        if (!ok) return;
        try {
            await VoiceAiApi.deletePersonality(id);
            Toast.info(`Deleted "${p?.name || 'personality'}"`);
            await this._fetchPersonalities();
            App.renderPage();
        } catch (e) {
            console.error('[VoiceAiPage] delete failed:', e);
            Toast.error(`Delete failed: ${e.message}`);
        }
    },

    // ── Render ───────────────────────────────────────────────

    _renderMain() {
        // Personalities moved to its own tab; this is the Voice & AI Settings tab.
        return `
            <div style="max-width: 760px;">
                ${this._renderAiDefaults()}
                ${this._renderHouseholdSharing()}
            </div>
        `;
    },

    /** Voice-controllable entity SOURCE (room-awareness build 20260715). Which Home Assistant
     *  entities voice commands can control: the entities on the Dashie DASHBOARD (plug-and-play —
     *  "what's on my screen is controllable") or the user's curated HA "exposed to Assist" list.
     *  Stored account-level in voice.entitySource; the tablet reads it to build ha_entities.
     *
     *  Rendered as a "HA entities" component card (home icon) inside the pipeline group, right
     *  below the Web search source card — HA users only, and only while Customize pipeline is on.
     *  Collapsed shows the picked source; expanded shows both options + the Edit-exposed-list
     *  deep-link (footerHtml). */
    _renderEntitySourceCard() {
        // Default 'dashboard' — the plug-and-play promise. The device side falls back to the exposed
        // list / domain heuristic if the dashboard yields nothing, so this is safe even off-HA.
        const source = String(this._defaults?.['voice.entitySource'] || 'dashboard');
        const options = [
            { id: 'dashboard', label: 'Everything on my dashboard',
              description: `The entities on the dashboard ${BRAND.productName} displays. Add or remove them by editing your dashboard.` },
            { id: 'assist', label: 'My Home Assistant voice-assistant list',
              description: 'The entities you exposed to Assist in Home Assistant.' },
        ];
        // "Edit exposed list" deep-link — target="_top" so it navigates the HA frame out of the
        // console iframe (the console runs inside HA's add-on ingress; a _blank tab would 404).
        const footerHtml = `
            <div style="padding: 12px 14px; border-top: 1px solid var(--border, #e5e7eb); display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                <span style="font-size: 12px; color: var(--text-muted);">Curate the exposed set in Home Assistant:</span>
                <a href="/config/voice-assistants/expose" target="_top" rel="noopener"
                    style="font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.4px; color:#fff; background: var(--accent); padding: 2px 8px; border-radius: 9px; text-decoration: none; white-space:nowrap;">
                    Edit exposed list ↗</a>
            </div>`;
        return VoiceAiCards.render({
            title: 'HA entities', stageKey: 'entities', options, selectedId: source,
            icon: 'icon-home',
            expanded: this._expandedCards.has('entities'),
            anyExpanded: this._expandedCards.size > 0,
            getConfig: (k) => this._defaults?.[k],
            footerHtml,
        });
    },

    /** Persist the voice-controllable entity source (account-level, serialized write). */
    async setEntitySource(value) {
        const v = value === 'assist' ? 'assist' : 'dashboard';
        try {
            await this.saveDefault('voice.entitySource', v);
            App.renderPage();   // re-render so the description + link reflect the choice
        } catch (e) {
            console.warn('[VoiceAiPage] setEntitySource failed:', e);
        }
    },

    /** Household Dashie Intelligence sharing toggle — add-on mode only. Lets un-logged-in
     *  tablets / voice satellites on this network use this account's cloud voice
     *  (billed to its credits). Lives under AI Defaults. */
    _renderHouseholdSharing() {
        if (!DashieAuth.isAddonMode) return '';
        // ACCOUNT-scoped (2026-07-13) — read from the account defaults, not the add-on's
        // /data store. A fresh account is off by default.
        const enabled = this._defaults?.['voice.householdSharing'] === true;
        return `
            <div class="section-header" style="margin-top: 32px;">Household ${BRAND.productName} Intelligence Sharing</div>
            <div class="card">
                <div class="card-body">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap;">
                        <div style="flex:1; min-width:240px;">
                            <div style="font-weight:500; margin-bottom:6px;">Let kiosk tablets &amp; voice satellites use this account</div>
                            <div style="color: var(--text-secondary); font-size: var(--font-size-sm); line-height:1.5;">
                                Household Sharing needs to be on for other devices on your network to use this account's voice &amp; AI credits and API keys. You can alternatively sign into this account on your devices. You can turn it off any time.
                            </div>
                        </div>
                        <button class="btn ${enabled ? 'btn-primary' : 'btn-secondary'}" id="household-sharing-btn"
                            onclick="VoiceAiPage.toggleHouseholdSharing(${enabled})" style="flex-shrink:0;">
                            ${enabled ? 'Sharing On' : 'Sharing Off'}
                        </button>
                    </div>
                </div>
            </div>
        `;
    },

    /** First-open nudge for HA users to turn on Household Sharing. The toggle
     *  lives lower on the page (below AI Defaults) and isn't obvious, but it's
     *  what lets an HA user's kiosk tablets / voice satellites use this
     *  account's voice & AI. Fires once per account (localStorage latch),
     *  add-on + HA users only, and only while sharing is still off. */
    async _maybePromptHouseholdSharing() {
        try {
            if (typeof ConfirmModal === 'undefined') return;
            if (!DashieAuth.isAddonMode || !DashieAuth.isHaUser) return;
            if (this._activeTab !== 'settings') return;
            if (!this._defaults) return;                                        // defaults not loaded yet
            if (this._defaults['voice.householdSharing'] === true) return;      // already on
            const key = `dashie-hh-sharing-prompted-${DashieAuth.jwtUserId || 'anon'}`;
            if (localStorage.getItem(key)) return;
            // Latch first — never nag twice, even if they dismiss with "Not now".
            localStorage.setItem(key, '1');
            const ok = await ConfirmModal.confirm({
                title: 'Turn on Household Sharing?',
                messageHtml: `Household Sharing needs to be on for other devices on your network to use this account's voice &amp; AI credits and API keys. You can alternatively sign into this account on your devices. You can turn it off any time.`,
                confirmLabel: 'Enable now',
                cancelLabel: 'Not now',
            });
            // setHouseholdSharing, NOT toggleHouseholdSharing: this modal carries an
            // EXPLICIT intent ("Enable now"), so it states the value it wants rather than
            // asserting what a button was rendered from.
            if (ok) await this.setHouseholdSharing(true);
        } catch (e) {
            console.warn('[VoiceAiPage] household-sharing prompt failed (non-fatal):', e);
        }
    },

    /**
     * D6 (Kiosk Real Login) — turning sharing OFF must actually sign the kiosks out.
     *
     * Household sharing is the switch that let a LAN tablet authorize ITSELF into this account
     * (silently, with no human at the tablet). Before Kiosk Real Login, flipping it off starved
     * the kiosks within one probe cycle, so "off" meant off.
     *
     * Now a provisioned kiosk holds a REAL 72h session. Blocking new provisioning no longer
     * revokes the existing ones — so without this, "off" would silently mean "no NEW kiosks",
     * and the tablets already on the account would keep working for up to three days. That is
     * exactly the invisible trust D1 set out to avoid, and the native kiosk Settings page tells
     * users this toggle is how to disconnect.
     *
     * So: sharing-off removes every `ha_kiosk` device row. The server's refresh check (D5) then
     * kills each session at its next refresh — worst case the token's remaining TTL.
     *
     * Only kiosks. A phone/TV/tablet the user deliberately signed in is untouched.
     *
     * ⚠️ 2026-07-29: this swept ZERO rows for a household with two live kiosks, because their
     * rows had been re-created as `tablet_android` by the tablets' own `register_device` call
     * (see the server-side HA-origin guard in database-operations/handlers/devices.ts). The
     * server now refuses that insert and heals drifted rows back, so the `ha_kiosk` filter is
     * sound again — but a zero-row sweep is the exact signature of that bug class returning, so
     * it is now REPORTED rather than silently treated as success. Do not "fix" this by widening
     * the filter to guess at kiosk-shaped rows: `ha_app` is the ADD-ON's own row and deleting it
     * signs the add-on out of the account.
     *
     * @returns {Promise<{found:number, removed:number, listed:boolean}>}
     */
    async _signOutKiosksOnSharingOff() {
        let kiosks = [];
        try {
            // ⚠️ controllable_only:false is REQUIRED — list_devices defaults to `tv_only = true`,
            // which filters to `tv_%` / `tablet_%` only. `ha_kiosk` matches NEITHER, so the
            // default call returns zero kiosks and this whole sweep silently no-ops while
            // reporting success. That is exactly what happened on the first live test
            // (2026-07-13): sharing flipped off, no confirm appeared, and the kiosk kept its
            // session. Do not "simplify" this back to `{}`.
            const res = await DashieAuth.dbRequest('list_devices', { controllable_only: false });
            const devices = res?.devices || res || [];
            const all = Array.isArray(devices) ? devices : [];
            kiosks = all.filter(d => d?.device_type === 'ha_kiosk');
            if (!kiosks.length) {
                // Loud, and with the evidence needed to triage it: which types WERE on the
                // account. A silent zero here is what let two signed-in tablets look swept.
                console.warn(
                    '[VoiceAiPage] DROP: sharing-off sweep matched ZERO ha_kiosk rows. If any wall ' +
                    'tablet is still signed in, its row was re-created under the wrong device_type. ' +
                    'Device types seen: ' + JSON.stringify(all.map(d => d?.device_type))
                );
            }
        } catch (e) {
            console.warn('[VoiceAiPage] could not list devices to sign kiosks out:', e.message);
            return { found: 0, removed: 0, listed: false };
        }
        if (!kiosks.length) return { found: 0, removed: 0, listed: true };

        let removed = 0;
        for (const k of kiosks) {
            try {
                // hard_delete: the row must be GONE, not just is_active=false — D5's refresh check
                // looks the device_id up in user_devices, so a soft-deleted row would still
                // resolve and the session would keep renewing.
                await DashieAuth.dbRequest('delete_device', { device_id: k.device_id, hard_delete: true });
                removed++;
            } catch (e) {
                console.warn(`[VoiceAiPage] could not remove kiosk ${k.device_id}:`, e.message);
            }
        }
        if (removed < kiosks.length) {
            console.warn(`[VoiceAiPage] DROP: sweep removed ${removed}/${kiosks.length} kiosk rows — the rest keep their sessions`);
        }
        return { found: kiosks.length, removed, listed: true };
    },

    /**
     * BUTTON entry point. `renderedAs` is an ASSERTION about the state this button was
     * drawn from — deliberately NOT the value to write.
     *
     * It used to pass `${!enabled}`, i.e. the intended new value, computed at RENDER time.
     * That makes a stale render invert the user's intent, and for this particular control
     * that is a security bug rather than a cosmetic one: a page still holding
     * `householdSharing:false` while the account holds `true` draws "Sharing Off" and wires
     * the click to write TRUE — re-affirming sharing and skipping the D6 kiosk sweep (which
     * only runs `if (!enabled)`). The user cannot turn sharing off from that screen at all,
     * and nothing tells them. Observed 2026-07-31 on two accounts; kiosks had been
     * provisioning against an account the console reported as not sharing.
     *
     * So: re-read the account value at CLICK time, and act only if reality still matches
     * what the user was looking at. On a mismatch, correct the UI and stop — the click is
     * not reinterpreted, because "the user clicked a button labelled X" tells us nothing
     * about what they wanted once X turns out to have been wrong. Fails toward LESS
     * sharing: this path can never enable sharing off a stale render.
     */
    async toggleHouseholdSharing(renderedAs) {
        let current;
        try {
            const fresh = await VoiceAiApi.loadAiDefaults();
            current = fresh['voice.householdSharing'] === true;
            if (this._defaults) this._defaults['voice.householdSharing'] = current;
        } catch (e) {
            // Never guess on a security control — a failed read must not become a write.
            console.warn('DROP: household-sharing re-read failed; not toggling:', e.message);
            Toast.error('Could not confirm the current sharing setting — nothing was changed.');
            return;
        }

        if (current !== (renderedAs === true)) {
            App.renderPage();
            Toast.error(
                `This page was out of date — sharing is actually ${current ? 'ON' : 'OFF'}. ` +
                `Nothing was changed; the button now shows the real setting.`
            );
            return;
        }

        return this.setHouseholdSharing(!current);
    },

    /** The actual writer. Explicit intent — callers state the value they want.
     *  Reached from the verified button path above and from the first-open prompt. */
    async setHouseholdSharing(enabled) {
        try {
            // D6: warn BEFORE flipping — the user is about to sign tablets out of the account.
            if (!enabled) {
                let count = 0;
                try {
                    const res = await DashieAuth.dbRequest('list_devices', { controllable_only: false });
                    const devices = res?.devices || res || [];
                    count = (Array.isArray(devices) ? devices : [])
                        .filter(d => d?.device_type === 'ha_kiosk').length;
                } catch { /* non-fatal — fall through to a generic confirm */ }
                if (count > 0) {
                    const one = count === 1;
                    // ConfirmModal, not native confirm() — the browser dialog shows the raw
                    // origin ("192.168.86.46:8123 says") and ignores our styling. This page
                    // already uses ConfirmModal everywhere else.
                    const ok = await ConfirmModal.confirm({
                        title: 'Turn off Household Sharing?',
                        message:
                            `${count} Home Assistant kiosk ${one ? 'tablet' : 'tablets'} will be signed out of ` +
                            `this account. ${one ? 'It' : 'They'} will keep showing Home Assistant, but will ` +
                            `lose access to your calendars, chores and ${BRAND.productName} voice. ` +
                            `Turning sharing back on lets ${one ? 'it' : 'them'} re-authorize automatically.`,
                        confirmLabel: `Sign out ${one ? 'tablet' : 'tablets'}`,
                        cancelLabel: 'Cancel',
                        danger: true,
                    });
                    if (!ok) { App.renderPage(); return; }
                }
            }

            // ACCOUNT-scoped: the console owns settings writes (serialized patchUserSetting).
            await this.saveDefault('voice.householdSharing', enabled);

            // D6: now actually sign the kiosks out. Order matters — sharing is already false, so
            // a tablet that re-provisions in this window is refused by jwt-auth's sharing gate
            // (the authoritative one) rather than racing us back onto the account.
            if (!enabled) {
                const sweep = await this._signOutKiosksOnSharingOff();
                if (sweep.removed > 0) {
                    Toast.success(`Sharing off — ${sweep.removed} kiosk ${sweep.removed === 1 ? 'device' : 'devices'} signed out.`);
                } else if (sweep.listed) {
                    // Say so out loud. Reporting "off" while a tablet stays signed in is the
                    // failure this whole path exists to prevent (field report 2026-07-29).
                    Toast.success('Sharing off — no kiosk devices were on the account.');
                } else {
                    Toast.error('Sharing off, but the device list could not be read — kiosks may still be signed in.');
                }
            }
            // Then tell the add-on to drop its cached account config and push a voice-config
            // refresh to the kiosks, so the change takes effect immediately rather than after
            // the 30s account-config TTL. Best-effort — the setting is already saved.
            try {
                await fetch(DashieAuth._addonUrl('/api/settings/household-sharing'), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled }),
                });
            } catch (e) {
                console.warn('[VoiceAiPage] sharing invalidate/push failed (non-fatal):', e.message);
            }
            App.renderPage();
        } catch (e) {
            console.error('[VoiceAiPage] Toggle household sharing failed:', e);
            Toast.error('Could not update sharing setting: ' + e.message);
        }
    },

    _renderAiDefaults() {
        const d = this._defaults;
        const O = window.VoiceAiOptions;
        const preset = this._activePreset();
        const isHaAssist = preset === 'ha_assist';
        const agentMode = this._agentMode();
        // Live (S2S) owns STT+LLM+TTS+search, so hide the cascade pipeline cards
        // it replaces. Dialog + Single both run the cascade → keep them shown.
        // HA Assist keeps Customize too (mix the Assist pipeline with e.g. the
        // local Android voice) — just without the Dashie-brain cards.
        const isLive = !isHaAssist && agentMode === 'live';
        const customPipeline = d['voice.customizePipeline'] === true;
        const showPipeline = customPipeline && !isLive;
        // STT shows whenever the pipeline is customized — in cascade (with TTS/search) AND
        // in Live mode (on its own, below Live Voice). In Live it's the engine that
        // transcribes the FIRST wake command for the local-vs-Live routing decision; the
        // rest of the pipeline stays hidden (Live speaks its own voice, grounds via the
        // model). Gated on the Customize-pipeline toggle so it's opt-in. Asterisked in Live.
        const showStt = customPipeline;
        // "HA entities" card: which HA entities voice can control. HA users only, and
        // grouped with the pipeline (only while Customize is on) — sits below Web search
        // source. Not shown under HA Assist (HA owns entity control there).
        const showEntities = showPipeline && !isHaAssist && DashieAuth.isHaUser;
        // Gemini cascade models search via native Google grounding (not Tavily) → the
        // Web-search-source card shows "Google" instead. Applies in dialog/single.
        const isGeminiAiModel = String(d['ai.model'] || '').startsWith('gemini-');
        const searchOn = d['ai.webSearchEnabled'] === true;
        // Prune expanded-state for cards that are no longer rendered (Customize
        // off, preset switch, Live hiding the pipeline). A stale entry keeps
        // anyExpanded true and dims every visible card indefinitely.
        const visibleStages = new Set(isHaAssist
            ? (showPipeline ? ['tts', 'stt'] : [])
            : ['model', ...(showStt ? ['stt'] : []), ...(showPipeline ? ['tts', 'search'] : []), ...(showEntities ? ['entities'] : [])]);
        for (const k of [...this._expandedCards]) {
            if (!visibleStages.has(k)) this._expandedCards.delete(k);
        }
        const cfg = k => d[k];
        // WS-F (§13.1): stage icons on the three pipeline card titles — brain (AI),
        // ear (STT), speaking head (TTS). Other cards (search, defaults) stay bare.
        const CARD_ICONS = { model: 'icon-ai-brain', stt: 'icon-ear', tts: 'icon-speaking-head', search: 'icon-search' };
        const card = (title, stageKey, options, selectedId) => VoiceAiCards.render({
            title, stageKey, options, selectedId,
            icon: CARD_ICONS[stageKey] || '',
            expanded: this._expandedCards.has(stageKey),
            anyExpanded: this._expandedCards.size > 0,  // dim the other cards while one is open
            getConfig: cfg,
        });
        const filtered = (stage, all) => O.presetFilter(preset, this._haFilter(all));
        const P = window.VoiceAiPresetPicker;
        const D = window.VoiceAiDefaultsCards;
        // Web search: the toggle is gone (John, 2026-07-12) — "None" is a
        // source-card option instead. Selection maps webSearchEnabled + source.
        const searchOptions = [
            ...(isGeminiAiModel ? this._googleSearchOption() : filtered('search', O.SEARCH)),
            { id: 'none', label: 'None', cost: '', description: `Web search off — ${BRAND.assistantName} answers without searching the web.` },
        ];
        const searchSelected = !searchOn ? 'none' : (isGeminiAiModel ? 'google' : String(d['voice.searchSource']));
        // Voice split out of the TTS card (John, 2026-07-12): the voice-id
        // config field renders as its own row under Text-to-speech, only for
        // engines with a selectable voice (Piper ha_engine / Kokoro local_url).
        // The URL/other fields stay in the card.
        const VOICE_FIELD_KEYS = ['voice.haTtsVoiceId', 'voice.localTtsVoiceId'];
        const ttsAll = this._applyProbed(filtered('tts', O.ttsOptions(this._engines)));
        // A saved engine's row id stands in for the raw provider value, so the card
        // shows "Kokoro (Mac)" rather than the generic "Local TTS (your box)".
        const ttsSelectedId = this._engineRowId('tts') || String(d['voice.ttsProvider']);
        const sttSelectedId = this._engineRowId('stt') || String(d['voice.sttProvider']);
        const ttsSelected = ttsAll.find(x => x.id === ttsSelectedId) || null;
        const voiceField = this._voiceFieldFor(ttsSelected, VOICE_FIELD_KEYS);
        const ttsCardOpts = ttsAll.map(x => {
            if (!x.configFields) return x;
            const rest = x.configFields.filter(f => !VOICE_FIELD_KEYS.includes(f.key));
            return { ...x, configFields: rest.length ? rest : undefined };
        });
        // HA Assist: the link-out card + customizable STT/TTS (mix the Assist
        // pipeline with local engines/Android voice) — no Dashie-brain cards
        // (model/personality/search) since HA owns the conversation agent.
        const body = isHaAssist ? `
            ${P.renderHaAssistCard()}
            ${P.renderCustomizeRow(customPipeline, true)}
            ${showPipeline ? card('Speech-to-text', 'stt', this._applyProbed(filtered('stt', O.sttOptions(this._engines))), sttSelectedId) : ''}
            ${showPipeline ? card('Text-to-speech', 'tts', ttsCardOpts, ttsSelectedId) : ''}
            ${showPipeline && voiceField ? this._renderVoiceRow(voiceField, d) : ''}` : `
            ${P.renderCustomizeRow(customPipeline, true)}
            ${card('AI Model', 'model', this._markKeyed(this._applyProbed(this._modelOptions(preset))), this._selectedModelId(agentMode))}
            ${D.renderWakeWordCard({
                currentId: String(d['ai.defaultWakeWord'] || 'hey_dashie'),
                saving: this._savingKey === 'ai.defaultWakeWord',
            })}
            ${D.renderPersonalityCard({
                templates: this._templates, custom: this._custom,
                currentId: String(d['ai.defaultPersonalityId'] || 'dashie'),
                saving: this._savingKey === 'ai.defaultPersonalityId',
            })}
            ${isLive ? this._renderLiveVoiceRow(d) : ''}
            ${showPipeline ? this._renderEngineDetectionRow() : ''}
            ${showStt ? card(isLive ? 'Speech-to-text*' : 'Speech-to-text', 'stt', this._applyProbed(isLive ? this._haFilter(O.sttOptions(this._engines)) : filtered('stt', O.sttOptions(this._engines))), sttSelectedId) + (isLive ? this._renderLiveSttNote() : '') : ''}
            ${showPipeline ? card('Text-to-speech', 'tts', ttsCardOpts, ttsSelectedId) : ''}
            ${showPipeline && voiceField ? this._renderVoiceRow(voiceField, d) : ''}
            ${showPipeline ? card('Web search source', 'search', this._markKeyed(searchOptions), searchSelected) : ''}
            ${showEntities ? this._renderEntitySourceCard() : ''}`;
            // Sports source card hidden for now (John, 2026-07-11) — ESPN is the
            // only option. The account default-VOICE card was removed 2026-07-12
            // (cloud voice follows the personality; Piper voice lives in the TTS
            // card's config; per-device override on the Devices page).
        return `
            <div style="display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin: 20px 0 10px;">
                <div style="font-size: 15px; font-weight: 600;">Voice &amp; AI Defaults</div>
                ${this._renderLocalityLegend()}
            </div>
            ${VoiceAiPresetPicker.render({
                presets: this._haFilter(O.PRESETS),
                selectedId: preset,
                available: (id) => this._presetAvailable(id),
                isAddonMode: DashieAuth.isAddonMode,
                localMode: DashieAuth.isLocalMode,
            })}
            ${this._renderCloudSuppliers()}
            ${body}

            ${isHaAssist ? '' : `
            ${this._sectionHeader('AI Tools & Settings', '')}
            <div class="card"><div class="card-body">
                ${!isLive ? this._renderDialogRows(d, agentMode) : ''}
                ${this._toggleRow('Retrieve pictures', `Allow the AI to show pictures with its responses. Uses web image search (${O.imageSearchCost}/search).`, 'ai.retrievePicturesEnabled', d['ai.retrievePicturesEnabled'])}
                ${false /* 'Prompt for feedback' HIDDEN 2026-07-17 — not yet implemented on the tablet (no thumbs up/down ships the feedback). Restore: FeatureGate.shouldShow('promptForFeedback') */ ? this._toggleRow('Prompt for feedback on responses', 'Show thumbs up/down after voice responses.', 'ai.promptForFeedback', d['ai.promptForFeedback']) : ''}
                ${FeatureGate.shouldShow('chores') ? this._toggleRow('Always use AI for chores', 'Disable the fast path — routes all chore commands through AI (uses more tokens).', 'voice.alwaysUseAI', d['voice.alwaysUseAI']) : ''}
            </div></div>`}
        `;
        // Conversation memory (+ duration) hidden for now (John, 2026-07-12) —
        // not in use yet. Re-add via ai.conversationContextEnabled /
        // ai.conversationTimeout toggle+select rows when it ships.
    },

    /** Subtext BELOW the STT card in Live mode. Live still needs an STT for the FIRST
     *  wake command — it transcribes it to decide local-vs-Live routing (and to run local
     *  commands). Explains why the STT picker is present in Live mode. */
    _renderLiveSttNote() {
        return `<div style="font-size: 12px; color: var(--text-muted); margin: 2px 4px 12px; line-height: 1.45;">
            * ${BRAND.assistantName} transcribes the first request to decide whether to handle locally or send to Live.
        </div>`;
    },

    /** Live (Gemini S2S) speaks in one fixed Google voice — this row picks which
     *  (voice.liveVoiceName). Empty = the engine default (Aoede). Rendered only in
     *  Live mode, styled as the standard voice row (icon + label + select) so it
     *  matches the other pipeline dropdowns. The cascade voice follows the
     *  personality's TTS voice, set elsewhere. */
    _renderLiveVoiceRow(d) {
        const D = window.VoiceAiDefaultsCards;
        const cur = String(d['voice.liveVoiceName'] || '') || 'Aoede';
        const opts = this.CONVERSATION_VOICES.map(([id, label]) =>
            `<option value="${this._escape(id)}" ${id === cur ? 'selected' : ''}>${this._escape(label)}</option>`).join('');
        return D.renderControlRow({
            label: 'Live voice',
            icon: 'icon-voice',
            saving: this._savingKey === 'voice.liveVoiceName',
            controlHtml: `<select style="${D.SELECT_STYLE}" onchange="VoiceAiPage.saveLocalField('voice.liveVoiceName', this.value)">${opts}</select>`,
            caret: true,
        });
    },

    /** The voice-id field to render as the Voice row under Text-to-speech, for whatever
     *  is selected: a SAVED ENGINE (voices probed from its own URL — the engine's address
     *  lives on the Local Engines page, but its voice stays switchable right here), the
     *  HA Piper engine (voices from detection), or the inline own-box row. Null for cloud/
     *  Android/HA-pipeline, which don't expose a voice here. */
    _voiceFieldFor(ttsSelected, voiceFieldKeys) {
        if (!ttsSelected) return null;
        if (ttsSelected.engineRecord) {
            if (ttsSelected.engineRecord.kind !== 'tts') return null;
            const probed = this._probedOptions['voice.localTtsVoiceId'];
            if (!probed?.length) return { key: 'voice.localTtsVoiceId', label: 'Voice', placeholder: 'af_heart' };
            // A local box offers every language it knows (Piper: 163 voices) — narrow to
            // the household's. The ladder never yields an empty list; `note` explains any
            // fallback (e.g. Piper has no Japanese voices at all).
            const { options } = this._narrowVoices(probed);
            return { key: 'voice.localTtsVoiceId', label: 'Voice', type: 'select', options };
        }
        if (!['ha_engine', 'local_url'].includes(ttsSelected.id)) return null;
        return (ttsSelected.configFields || []).find(f => voiceFieldKeys.includes(f.key)) || null;
    },

    /** The locale to narrow local voices by, in precedence order:
     *   1. Dashie's own language — the language Dashie SPEAKS (AI prompt + cloud voice), so
     *      offering voices in another language would be incoherent. Defaults to 'system'.
     *   2. HA's configured locale (detection.haLanguage) — what the household speaks.
     *      Only present on add-on >= 0.1.219.
     *   3. The browser's locale — the console runs in this household's browser. Without this
     *      rung, an older add-on (no haLanguage) + language 'system' (the DEFAULT) resolved
     *      to '' and NOTHING was narrowed — all 163 Piper voices. Never hang the common case
     *      on one signal that's often absent.
     *  All three absent → no narrowing (filterVoicesByLanguage returns everything). */
    _voiceLocale() {
        const own = String(this._defaults?.['general.language'] || '').trim();
        if (own && own !== 'system') return own;
        const ha = String(this._engines?.haLanguage || '').trim();
        if (ha) return ha;
        return String(navigator?.language || '').trim();
    },

    /** Probed voice options, narrowed to the household's language. THE one place voice lists
     *  get filtered — both render paths (a saved engine's Voice row and the inline local_url
     *  config field) go through here, so a 163-voice dropdown can't sneak back via the path
     *  that forgot to call it. */
    _narrowVoices(probed) {
        return window.VoiceAiOptions.filterVoicesByLanguage(probed, this._voiceLocale());
    },

    /** The Voice row under Text-to-speech (Piper/Kokoro only): a detection-
     *  populated dropdown rendered borderless-bold to match the compact rows,
     *  or a plain text input when no voice list is available. */
    _renderVoiceRow(voiceField, d) {
        const D = window.VoiceAiDefaultsCards;
        const cur = String(d[voiceField.key] || '');
        let control;
        let caret = true;
        if (voiceField.type === 'select' && Array.isArray(voiceField.options)) {
            // Never render unset — an empty stored value displays as the default
            // voice (amy (low) for Piper); _seedPiperVoiceIfMissing persists it.
            const effective = cur
                || (voiceField.key === 'voice.haTtsVoiceId' ? this._defaultPiperVoice() : '')
                || voiceField.options[0]?.value || '';
            const known = voiceField.options.some(v => v.value === effective);
            const opts = [
                ...voiceField.options.map(v =>
                    `<option value="${this._escape(v.value)}" ${v.value === effective ? 'selected' : ''}>${this._escape(v.label)}</option>`),
                (effective && !known) ? `<option value="${this._escape(effective)}" selected>${this._escape(window.VoiceAiOptions._piperVoiceLabel(null, effective))} (current)</option>` : '',
            ].join('');
            control = `<select style="${D.SELECT_STYLE}" onchange="VoiceAiPage.saveLocalField('${voiceField.key}', this.value)">${opts}</select>`;
        } else {
            caret = false;
            control = `<input type="text" value="${this._escape(cur)}" placeholder="${this._escape(voiceField.placeholder || '')}"
                autocomplete="off" onchange="VoiceAiPage.saveLocalField('${voiceField.key}', this.value)"
                style="flex: 1; padding: 7px 9px; border: 1px solid var(--border, #d1d5db); border-radius: 5px; font-size: 13px;">`;
        }
        // ▶ Preview — hear the selected voice before committing to it. Only for own-box
        // engines (we proxy the synthesis through the add-on; see previewVoice).
        // ⚠️ renderControlRow is a flex row (label | control | caret) and SELECT_STYLE spans
        // it via `flex: 1`. Any sibling added here MUST be `flex-shrink: 0` and fixed-width,
        // or it steals that space and squeezes the <select> to an unclickable sliver — which
        // is exactly what a language-fallback note did (John, 2026-07-14).
        const canPreview = DashieAuth.isAddonMode
            && voiceField.key === 'voice.localTtsVoiceId'
            && String(d['voice.localTtsUrl'] || '').trim();
        const preview = canPreview
            ? `<button id="voice-preview-btn" title="Hear this voice"
                   onclick="event.stopPropagation(); VoiceAiPage.previewVoice(this)"
                   style="flex-shrink: 0; width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--border, #d1d5db);
                          background: var(--bg-card, #fff); color: var(--text-primary); cursor: pointer; font-size: 11px; line-height: 1;
                          display: inline-flex; align-items: center; justify-content: center;">▶</button>`
            : '';
        return D.renderControlRow({
            label: 'Voice',
            icon: 'icon-voice',
            saving: this._savingKey === voiceField.key,
            controlHtml: control + preview,
            caret,
        });
    },

    /** Play a sample of the currently-selected own-box voice. The synthesis is proxied by
     *  the add-on (`/api/voice/preview`): this console is HTTPS and the engine is a plain-http
     *  LAN box, so the browser cannot fetch it directly — mixed content. Same reason the
     *  URL probe is server-side. */
    async previewVoice(btn) {
        const d = this._defaults || {};
        const url = String(d['voice.localTtsUrl'] || '').trim();
        const voice = String(d['voice.localTtsVoiceId'] || '').trim();
        if (!url) { Toast.info('Add the engine first.'); return; }
        // Already playing → the button is a stop button. (Also covers a double-click and
        // switching voices mid-sample: never two samples at once.)
        if (this._previewAudio) {
            this._previewAudio.pause();
            URL.revokeObjectURL(this._previewAudio.src);
            this._previewAudio = null;
            if (btn) { btn.disabled = false; btn.textContent = '▶'; }
            return;
        }
        const restore = () => { if (btn) { btn.disabled = false; btn.textContent = '▶'; } };
        if (btn) { btn.disabled = true; btn.textContent = '…'; }
        try {
            const r = await fetch(DashieAuth._addonUrl('/api/voice/preview'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, voice }),
            });
            if (!r.ok) {
                // The endpoint 404s on an add-on older than this feature — say so plainly
                // rather than reporting a bogus engine failure.
                if (r.status === 404) { Toast.error(`Update the ${BRAND.productName} add-on to preview voices.`); restore(); return; }
                const err = await r.json().catch(() => ({}));
                Toast.error(`Couldn't play a sample — ${err.message || `HTTP ${r.status}`}`);
                restore();
                return;
            }
            const blob = await r.blob();
            const audio = new Audio(URL.createObjectURL(blob));
            this._previewAudio = audio;
            audio.onended = () => { URL.revokeObjectURL(audio.src); if (this._previewAudio === audio) this._previewAudio = null; restore(); };
            audio.onerror = () => { Toast.error("Couldn't play the sample."); restore(); };
            await audio.play();
            if (btn) btn.textContent = '⏸';
        } catch (e) {
            Toast.error(`Couldn't play a sample — ${e?.message || e}`);
            restore();
        }
    },

    /** Reachability test for the own-box engine URLs (Local TTS / Local Whisper /
     *  My own AI). Add-on mode proxies through the box (the browser can't reach a
     *  LAN engine cross-origin); elsewhere a best-effort direct fetch. On success
     *  the engine's own option list (voices / models) is cached under the field the
     *  URL `fills`, upgrading that field to a dropdown. */
    async testLocalUrl(fieldKey, kind, btn) {
        const input = document.getElementById(`cfg-${fieldKey}`);
        const url = String(input?.value || this._defaults?.[fieldKey] || '').trim();
        if (!url) { Toast.info('Enter the URL first.'); return; }
        const restore = () => { if (btn) { btn.disabled = false; btn.textContent = 'Test'; } };
        if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
        const result = await this._probeUrl(kind, url, fieldKey);
        if (result?.ok) Toast.success(`Reachable ✓ ${result.detail || ''}`);
        else Toast.error(`Not reachable — ${result?.detail || 'no response'}`);
        restore();
        App.renderPage();   // a fresh option list turns the sibling field into a dropdown
    },

    /** Probe an own-box engine URL. Caches any returned option list under the key the
     *  URL field `fills` (voice.localTtsVoiceId / voice.localLlmModel) → _probedOptions,
     *  which _applyProbed() splices into the config fields. Never throws. */
    async _probeUrl(kind, url, urlFieldKey) {
        let result = null;
        try {
            if (DashieAuth.isAddonMode) {
                const r = await fetch(DashieAuth._addonUrl('/api/voice/probe'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url, kind }),
                });
                // A 404 = the add-on predates the probe endpoint — fall through to a
                // direct attempt rather than reporting a bogus failure.
                result = r.status === 404 ? null : await r.json();
            }
            if (!result) {
                // Direct browser fetch (website console / old add-on): works only for a
                // CORS-permissive box, so failure here is not conclusive — but a success
                // still yields the option list.
                const path = kind === 'tts' ? '/v1/audio/voices' : '/v1/models';
                const r = await fetch(url.replace(/\/+$/, '') + path, { signal: AbortSignal.timeout(5000) });
                const j = await r.json().catch(() => null);
                const list = Array.isArray(j?.voices) ? j.voices : Array.isArray(j?.data) ? j.data : null;
                const options = (list || []).map(v => (typeof v === 'string'
                    ? { value: v, label: v }
                    : { value: String(v.voice_id || v.id || v.name), label: String(v.name || v.voice_id || v.id) }))
                    .filter(o => o.value && o.value !== 'undefined');
                result = { ok: r.ok, detail: `HTTP ${r.status}`, ...(options.length ? { options } : {}) };
            }
        } catch (e) {
            result = { ok: false, detail: e?.message || String(e) };
        }
        const fills = this._fillsKey(urlFieldKey);
        if (fills && result?.options?.length) this._probedOptions[fills] = result.options;
        return result;
    },

    /** The dropdown key a probed URL field populates. A static map, NOT a scan of the
     *  option rows' `fills`: saved engines REPLACE the inline local_url row, so the row
     *  that declares `fills` may not exist — but a selected engine still needs its
     *  voice/model list. */
    _PROBE_FILLS: {
        'voice.localTtsUrl': 'voice.localTtsVoiceId',
        'voice.localLlmUrl': 'voice.localLlmModel',
    },
    _fillsKey(urlFieldKey) {
        return this._PROBE_FILLS[urlFieldKey] || null;
    },

    /** Silently probe the own-box URLs that are already configured, so their voice /
     *  model dropdowns are populated on page load — the user shouldn't have to press
     *  Test to get a picker. Best-effort and fire-and-forget: a re-render follows only
     *  if something new was learned. Runs once per page fetch. */
    async _autoProbeLocalUrls() {
        const d = this._defaults || {};
        const targets = [
            { kind: 'tts', urlKey: 'voice.localTtsUrl' },
            { kind: 'llm', urlKey: 'voice.localLlmUrl' },
        ];
        let learned = false;
        await Promise.all(targets.map(async ({ kind, urlKey }) => {
            const url = String(d[urlKey] || '').trim();
            const fills = this._fillsKey(urlKey);
            if (!url || !fills || this._probedOptions[fills]) return;
            const before = this._probedOptions[fills];
            await this._probeUrl(kind, url, urlKey);
            if (this._probedOptions[fills] !== before) learned = true;
        }));
        if (learned) App.renderPage();
    },

    /** Selecting a TTS engine points the account at a new box, whose voice list is its own.
     *  Drop the previous box's cached voices, probe this one, and re-seed the voice when the
     *  stored one isn't offered here — otherwise the tablets would ask (say) Piper for
     *  Kokoro's `af_heart`. Async + fire-and-forget: the picker already collapsed. */
    async _reseedVoiceForEngine(engine) {
        delete this._probedOptions['voice.localTtsVoiceId'];
        await this._probeUrl('tts', engine.url, 'voice.localTtsUrl');
        const voices = this._probedOptions['voice.localTtsVoiceId'] || [];
        if (!voices.length) { App.renderPage(); return; }   // box unreachable → leave the voice alone
        const current = String(this._defaults['voice.localTtsVoiceId'] || '');
        if (!voices.some(v => v.value === current)) {
            await this.saveDefault('voice.localTtsVoiceId', voices[0].value);
        }
        App.renderPage();
    },

    /** Splice probed option lists into an option's configFields — a free-text field whose
     *  key was probed becomes a `type:'select'`. Detection-supplied options (the Kokoro
     *  add-on / Piper voices) already arrive as selects and are left alone. */
    _applyProbed(options) {
        return options.map(o => {
            if (!o.configFields) return o;
            const fields = o.configFields.map(f => {
                const probed = this._probedOptions[f.key];
                if (!probed || f.type === 'select') return f;
                // Voice lists get language-narrowed here too — this is the INLINE local_url
                // path (no saved engine), which used to splice all 163 Piper voices in raw.
                if (f.key === 'voice.localTtsVoiceId') {
                    return { ...f, type: 'select', options: this._narrowVoices(probed).options };
                }
                return { ...f, type: 'select', options: probed };
            });
            return { ...o, configFields: fields };
        });
    },

    /** Conversation-dialog rows at the top of AI Tools & Settings (moved from
     *  their own card, 2026-07-12): the Dialog toggle (agentMode dialog/single)
     *  + the "Open dialog after commands" sub-option while it's on. Hidden for
     *  Live (built into the model) and HA Assist. */
    _renderDialogRows(d, agentMode) {
        const dialogOn = agentMode === 'dialog';
        const saving = this._savingKey === 'voice.agentMode';
        return `
            <div class="setting-row" style="align-items: flex-start; padding: 10px 0;">
                <div style="flex: 1; padding-right: 12px;">
                    <div class="setting-row-label">Conversation dialog ${saving ? '<span style="color: var(--text-muted);">· saving…</span>' : ''}</div>
                    <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">Keep the mic open after a reply so you can keep talking — no wake word needed. Off = one response per “${BRAND.wakePhrase}”.</div>
                </div>
                <label class="toggle">
                    <input type="checkbox" ${dialogOn ? 'checked' : ''}
                        onchange="VoiceAiPage.setDialogMode(this.checked)">
                    <span class="toggle-slider"></span>
                </label>
            </div>
            ${dialogOn && KEEP_DIALOG_OPEN_UI ? this._toggleRow('Open dialog after commands', `Keep listening after every command — not just questions — without saying “${BRAND.wakePhrase}” again.`, 'voice.alwaysOpenDialog', d['voice.alwaysOpenDialog']) : ''}`;
    },

    /** The AI Model card's option list for the active preset: Live models
     *  grouped at the top (Cloud preset only — Live is fully cloud + credits),
     *  then the preset-filtered catalog (Local → the own-AI row; Cloud/Hybrid →
     *  cloud provider groups). */
    _modelOptions(preset) {
        const O = window.VoiceAiOptions;
        const catalog = O.presetFilter(preset, O.models(this._engines));
        if (preset !== 'cloud') return catalog;
        const live = this._liveModelOptions().map(o => ({ ...o, group: 'Live · realtime conversation' }));
        return [...live, ...catalog];
    },

    /** Selected id for the AI Model card: the Live model while agentMode='live',
     *  else the cascade model — or, when the account is on a local model that
     *  matches a saved engine, that engine's row (so the card shows its NAME). */
    _selectedModelId(agentMode) {
        const d = this._defaults;
        if (agentMode === 'live') return String(d['voice.conversationModel'] || this.CONVERSATION_MODELS[0][0]);
        return this._engineRowId('llm') || String(d['ai.model']);
    },

    /** The `engine:<id>` row id for the saved engine the current flat settings resolve
     *  to, or null (cloud / HA / Android / a hand-typed URL that matches nothing). */
    _engineRowId(kind) {
        const e = window.EnginesStore?.matchSelected(kind, this._defaults);
        return e ? `${window.VoiceAiOptions.ENGINE_ROW_PREFIX}${e.id}` : null;
    },

    /** Live S2S models in the same option shape as O.models() so the AI-model card
     *  renders identically (orange CLOUD cards). Cost prefers the live margined
     *  rate card (what the user pays), falling back to the bundled raw catalog. */
    _liveModelOptions() {
        const O = window.VoiceAiOptions, C = window.AiModelCatalog;
        return this.CONVERSATION_MODELS.map(([id, label]) => {
            const live = O?._liveModelRates?.[id];
            const p = live ? [live.input, live.output] : C?.pricingFor?.(id);   // [inPer1M, outPer1M] | null
            return {
                id, label, locality: 'cloud',
                cost: p ? O._modelCost(p) : '',
                description: id.startsWith('gemini-3.1') ? 'Fastest realtime voice.' : 'More capable realtime voice.',
            };
        });
    },

    /** Web-search "source" shown when a Gemini model is selected: native Google Search
     *  grounding (the model searches Google directly — no Tavily). Fixed, single option. */
    _googleSearchOption() {
        return [{
            id: 'google', label: 'Google', locality: 'cloud', cost: 'Included with Gemini',
            description: 'Gemini searches Google directly and grounds its answer.',
            // Google grounding is part of the Gemini model call, so it runs through
            // the same BYO Gemini key — mark it with the provider so it shows keyed too.
            provider: 'gemini',
        }];
    },

    /** Mark options whose provider has a BYO key stored on the box (Open Brain §5).
     *  A `keyed` option shows the key icon + "API account" instead of a per-turn
     *  cost — its turns run on the user's key, not Dashie credits. No-op off add-on
     *  mode / when no keys are set (this._keyStatus null). */
    _markKeyed(options) {
        const ks = this._keyStatus;
        if (!ks) return options;
        // An OpenRouter key covers EVERY model in the catalog (providers.js OPENROUTER_MODELS
        // maps all 14, incl. claude-*/Nova) — so one key flips the whole picker to "API account",
        // not just the rows whose vendor key is set. Rows without a `provider` (search sources,
        // the local/hermes rows) are unaffected either way.
        const universal = !!ks.openrouter;
        return options.map(o => (o.provider && (ks[o.provider] || universal)) ? { ...o, keyed: true } : o);
    },

    /** Detection status + "Re-scan" for the engine-direct HA rows. Add-on mode
     *  only (detection is add-on-only, §11.4). Tells the user whether local
     *  engines were found and lets them re-probe after installing Piper/Whisper. */
    _renderEngineDetectionRow() {
        if (!DashieAuth.isAddonMode) return '';
        // Only the failure case gets a line — when detection works, the
        // Piper/Whisper rows speak for themselves (hint removed 2026-07-12).
        const e = this._engines;
        if (e && e.available) return '';
        return `
            <div style="margin: 0 0 8px; font-size: 12px; color: var(--text-secondary);">
                ${this._escape('Home Assistant not reachable — showing your-box (URL) options only.')}
            </div>`;
    },

    /** Cloud-vs-local color key — rendered inline in the section-title row,
     *  right of "Voice & AI Defaults" (moved above the preset cards 2026-07-12). */
    _renderLocalityLegend() {
        const O = window.VoiceAiOptions;
        const dot = (c, label) => `<span style="display:inline-flex; align-items:center; gap:6px;"><span style="width:12px; height:12px; border-radius:3px; background:${c};"></span>${label}</span>`;
        return `
            <div style="display:flex; gap: 16px; font-size: 12px; color: var(--text-secondary);">
                ${dot(O.COLOR.cloud, 'Cloud')}
                ${dot(O.COLOR.local, 'Local')}
            </div>`;
    },

    /** Who runs the hosted engines. These names used to live inside the STT/TTS
     *  option labels; they were moved here on 2026-07-30 so a supplier switch is
     *  one edit instead of a stale vendor name sitting in a picker. Moving them
     *  off the labels must not mean losing them — this is where they went.
     *  Suppressed on the Local preset, where no cloud engine is in play. */
    _renderCloudSuppliers() {
        const rows = window.VoiceAiOptions?.CLOUD_SUPPLIERS || [];
        if (!rows.length) return '';
        const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const list = rows.map(r => `${esc(r.stage)}: ${esc(r.vendors)}`).join(' · ');
        return `
            <div style="margin: 8px 2px 0; font-size: 12px; color: var(--text-muted); line-height: 1.5;">
                ${esc(BRAND.cloudName)} engines are currently run by — ${list}.
                Suppliers can change; local and hybrid presets never send audio to them.
            </div>`;
    },

    _renderPersonalities() {
        const templates = this._templates || [];
        const custom = this._custom || [];
        return `
            ${this._sectionHeader('Personalities', 'Shared across the household. Pick which one a device uses on the Devices page.')}
            <div style="display: flex; justify-content: flex-end; margin-bottom: 8px;">
                <button class="btn btn-primary btn-sm" onclick="VoiceAiPersonalityEdit.openNew()">+ New Personality</button>
            </div>
            <div class="card"><div class="card-body" style="padding: 0;">
                ${custom.length ? `<div style="padding: 12px 16px 4px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted);">Custom</div>` : ''}
                ${custom.map(p => this._personalityRow(p, true)).join('')}
                <div style="padding: 12px 16px 4px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted);">Built-in</div>
                ${templates.map(t => this._personalityRow(t, false)).join('')}
            </div></div>
        `;
    },

    _personalityRow(p, isCustom) {
        const id = this._escape(isCustom ? p.id : (p.key || p.id));
        // Voice name intentionally hidden here — matches the tablet's Voice & AI menu,
        // which doesn't surface the underlying voice on the personality list.
        const notes = isCustom ? '' : this.overrideNotes(p.key || p.id);
        const subtitle = [p.description || '', notes ? '✏️ family notes set' : '']
            .filter(Boolean).join(' · ');

        const actions = isCustom
            ? `<button class="btn btn-ghost btn-sm" onclick="VoiceAiPersonalityEdit.openEdit('${id}')">Edit</button>
               <button class="btn btn-ghost btn-sm" title="Delete" onclick="VoiceAiPage.deleteCustom('${id}')">🗑</button>`
            : `<button class="btn btn-ghost btn-sm" onclick="VoiceAiPersonalityEdit.openOverride('${id}')">Family notes</button>`;

        return `
            <div class="list-item" style="border-top: 1px solid var(--border, #e5e7eb);">
                <div class="list-item-content">
                    <div class="list-item-title">${this._escape(p.name)}${isCustom ? '' : ' <span class="list-item-badge">built-in</span>'}</div>
                    ${subtitle ? `<div class="list-item-subtitle">${this._escape(subtitle)}</div>` : ''}
                </div>
                ${actions}
            </div>
        `;
    },

    _sectionHeader(title, sub) {
        return `
            <div style="margin: 20px 0 10px;">
                <div style="font-size: 15px; font-weight: 600;">${title}</div>
                ${sub ? `<div style="font-size: 13px; color: var(--text-muted);">${sub}</div>` : ''}
            </div>
        `;
    },

    _modelRow(current) {
        const saving = this._savingKey === 'ai.model';
        const groups = this.MODEL_GROUPS.map(([label, opts]) => `
            <optgroup label="${this._escape(label)}">
                ${opts.map(([v, l]) => `<option value="${this._escape(v)}" ${v === current ? 'selected' : ''}>${this._escape(l)}</option>`).join('')}
            </optgroup>
        `).join('');
        return `
            <div class="form-group">
                <label class="form-label">AI model ${saving ? '<span style="color: var(--text-muted); font-weight: 400;">· saving…</span>' : ''}</label>
                <select class="form-select" onchange="VoiceAiPage.saveDefault('ai.model', this.value)">${groups}</select>
            </div>
        `;
    },

    _selectRow(label, dottedKey, options, current) {
        const saving = this._savingKey === dottedKey;
        const opts = options.map(([v, l]) =>
            `<option value="${this._escape(v)}" ${v === String(current) ? 'selected' : ''}>${this._escape(l)}</option>`).join('');
        return `
            <div class="form-group">
                <label class="form-label">${this._escape(label)} ${saving ? '<span style="color: var(--text-muted); font-weight: 400;">· saving…</span>' : ''}</label>
                <select class="form-select" onchange="VoiceAiPage.saveDefault('${dottedKey}', this.value)">${opts}</select>
            </div>
        `;
    },

    _toggleRow(label, sub, dottedKey, checked) {
        const saving = this._savingKey === dottedKey;
        return `
            <div class="setting-row" style="align-items: flex-start; padding: 10px 0;">
                <div style="flex: 1; padding-right: 12px;">
                    <div class="setting-row-label">${this._escape(label)} ${saving ? '<span style="color: var(--text-muted);">· saving…</span>' : ''}</div>
                    ${sub ? `<div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">${this._escape(sub)}</div>` : ''}
                </div>
                <label class="toggle">
                    <input type="checkbox" ${checked ? 'checked' : ''}
                        onchange="VoiceAiPage.saveDefault('${dottedKey}', this.checked)">
                    <span class="toggle-slider"></span>
                </label>
            </div>
        `;
    },

    _renderLoading() {
        return `<div class="empty-state" style="margin-top: 80px;"><div class="empty-state-text">Loading…</div></div>`;
    },

    _renderError() {
        return `
            <div class="empty-state" style="margin-top: 80px;">
                <div class="empty-state-icon">⚠️</div>
                <div class="empty-state-text">Could not load Voice & AI settings</div>
                <div style="color: var(--text-muted); font-size: var(--font-size-sm); margin: 8px 0 16px;">${this._escape(this._error)}</div>
                <button class="btn btn-secondary" onclick="VoiceAiPage._fetch()">Retry</button>
            </div>
        `;
    },

    _escape(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
};
