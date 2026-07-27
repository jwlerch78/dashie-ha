/* ============================================================
   Voice & AI API — account-global AI defaults + personality
   catalog, both reachable with the console's existing JWT.

   Two backends, no new edge functions:
   - Account AI defaults live in the user_settings blob (nested
     ai.* / voice.*), read via DashieAuth.loadUserSettings and
     written via DashieAuth.patchUserSetting — the canonical
     serialized partial-patch writer, so a write only ever touches
     its own key and can't clobber other settings categories.
   - Personalities (templates + custom) + voices come from
     database-operations via DashieAuth.dbRequest.

   None of this touches HA, so the page works in both cloud and
   add-on mode (gated alpha-only, same as the rest of voice/AI).
   ============================================================ */

const VoiceAiApi = {
    /** The account-global keys this surface owns, by user_settings path.
     *  Kept explicit so a save only ever touches these — everything else
     *  in the blob is preserved verbatim. */
    AI_DEFAULT_KEYS: [
        ['ai', 'model'],
        ['ai', 'defaultPersonalityId'],
        ['ai', 'defaultVoiceKey'],
        // WS-G account default wake word. Added 2026-07-14, closing the LAST open finding
        // of the kiosk-mirror audit (#5): hops 2-7 of the chain (account-config →
        // /voice-config → voice_view → KioskAccountVoiceApplier → VoicePreferences) have
        // always worked, but the console had NO writer and rendered no row — so a
        // console-plus-kiosk household could never actually set the household wake word.
        // lint:kiosk-mirror warned about this on every run; that KNOWN_GAP entry is gone now.
        // Must be READ BACK as well as written (it's in this list, not just DEFAULTS) —
        // check A / the haTtsVoiceId self-clobber: a key the page writes but never reads
        // back gets re-seeded to its default on every load.
        ['ai', 'defaultWakeWord'],
        // Read-only here (owned by Preferences) — the Voice & AI page narrows a local TTS
        // box's voice catalog to the household's language. 'system' falls back to HA's.
        ['general', 'language'],
        ['voice', 'pipelinePreset'],
        ['voice', 'controlMethod'],
        ['voice', 'agentMode'],
        ['voice', 'conversationModel'],
        ['voice', 'conversationAlways'],
        ['voice', 'alwaysOpenDialog'],
        ['voice', 'customizePipeline'],
        ['voice', 'sttProvider'],
        ['voice', 'ttsProvider'],
        // HA engine ids + the Piper voice. These were WRITTEN by the page (via the
        // provider configFields) but never READ BACK — so `d['voice.haTtsVoiceId']` was
        // always undefined, _seedPiperVoiceIfMissing() thought no voice was stored, and it
        // re-persisted amy (low) on EVERY page load, silently resetting the user's chosen
        // Piper voice — which the kiosk applier then mirrored to every tablet in the house.
        // (Audit 2026-07-13, #2.) A key the page writes MUST be in this list.
        ['voice', 'haTtsEngineId'],
        ['voice', 'haTtsVoiceId'],
        ['voice', 'haSttEngineId'],
        ['ai', 'webSearchEnabled'],
        ['ai', 'retrievePicturesEnabled'],
        ['ai', 'promptForFeedback'],
        ['ai', 'conversationContextEnabled'],
        ['ai', 'conversationTimeout'],
        ['ai', 'retainTranscripts'],
        ['voice', 'alwaysUseAI'],
        ['voice', 'searchSource'],
        // Which HA entities voice can control: 'dashboard' (entities on the Dashie dashboard —
        // plug-and-play) or 'assist' (the user's HA "exposed to Assist" list). The tablet's
        // ha-service reads this to build ha_entities; the device side falls back gracefully when
        // the chosen source is empty. Room-awareness build 20260715.
        ['voice', 'entitySource'],
        ['voice', 'sportsSource'],
        ['voice', 'localLlmUrl'],
        ['voice', 'localLlmModel'],
        ['voice', 'hermesUrl'],
        ['voice', 'searxngUrl'],
        ['voice', 'localTtsUrl'],
        ['voice', 'localTtsVoiceId'],
        ['voice', 'localSttUrl'],
        // Household Dashie Intelligence sharing — ACCOUNT-scoped (2026-07-13). Was stored
        // per-add-on-instance in /data (settings-store), which meant a new/wiped account
        // inherited the previous account's sharing state. It's a property of the account
        // ("share THIS account house-wide"), so it lives here: a fresh account is off by
        // default, and the add-on reads it from user_settings via account-config.
        ['voice', 'householdSharing'],
    ],

    DEFAULTS: {
        'ai.model': 'gemini-2.5-flash',
        'general.language': 'system',
        // Account defaults (WS-G): devices follow these unless overridden on
        // the Devices page. '' voice = the personality's own preferred voice.
        'ai.defaultPersonalityId': 'dashie',
        'ai.defaultVoiceKey': '',
        // Every APK bundles hey_dashie (WakeWordModel.HEY_DASHIE), so it is always a safe
        // household default — no device can report it unavailable via the model-gap rule.
        'ai.defaultWakeWord': 'hey_dashie',
        // '' = preset not chosen yet — the page derives one from the granular
        // keys (display-only) and persists on the user's first preset click.
        'voice.pipelinePreset': '',
        'voice.controlMethod': 'dashie_cloud',
        'voice.conversationModel': '',
        'voice.conversationAlways': false,
        'voice.alwaysOpenDialog': false,
        'voice.customizePipeline': false,
        'voice.sttProvider': 'dashie_cloud',
        'voice.ttsProvider': 'dashie_cloud',
        'ai.webSearchEnabled': true,
        'ai.retrievePicturesEnabled': false,
        // Defaults ON, matching the native settings page (getPromptForFeedbackEnabled
        // treats an unset value as enabled — !== false).
        'ai.promptForFeedback': true,
        'ai.conversationContextEnabled': false,
        'ai.conversationTimeout': 30,
        'ai.retainTranscripts': false,
        'voice.alwaysUseAI': false,
        'voice.searchSource': 'dashie',
        'voice.entitySource': 'dashboard',   // plug-and-play default; device side falls back if empty
        'voice.sportsSource': 'espn',
        'voice.localLlmUrl': '',
        'voice.localLlmModel': '',
        'voice.hermesUrl': '',
        'voice.searxngUrl': '',
        'voice.localTtsUrl': '',
        'voice.localTtsVoiceId': '',
        'voice.localSttUrl': '',
        // Account-scoped household sharing — OFF for a fresh account (so the
        // first-open prompt fires and nothing is shared without an explicit opt-in).
        'voice.householdSharing': false,
    },

    /** Legacy → engine-domain value remap. Accounts the console wrote before the
     *  engine-model alignment hold vendor values (deepgram/elevenlabs/dashie/native)
     *  that no longer match the option ids; normalize on load so the dropdowns render
     *  the right selection. Display-only — the normalized value isn't persisted until
     *  the user next saves (honors the no-migration decision). */
    _LEGACY_MAP: {
        'voice.controlMethod': { dashie: 'dashie_cloud', ha: 'voice_assistant' },
        'voice.sttProvider':   { deepgram: 'dashie_cloud', whisper: 'dashie_cloud', native: 'android_voice' },
        'voice.ttsProvider':   { elevenlabs: 'dashie_cloud', openai: 'dashie_cloud', native: 'android_voice' },
    },

    /** Load the account AI defaults as a flat {dotted: value} object,
     *  filling defaults for anything unset and normalizing legacy values.
     *  Pass a Set as `storedKeys` to learn which keys were actually PERSISTED
     *  (vs filled from DEFAULTS) — the returned values can't distinguish the
     *  two, and the fresh-account seed must never overwrite a stored choice. */
    async loadAiDefaults(storedKeys = null) {
        const settings = await DashieAuth.loadUserSettings();
        const out = {};
        for (const [a, b] of this.AI_DEFAULT_KEYS) {
            const key = `${a}.${b}`;
            const v = settings?.[a]?.[b];
            if (v !== undefined) storedKeys?.add(key);
            let val = v === undefined ? this.DEFAULTS[key] : v;
            const lmap = this._LEGACY_MAP[key];
            if (lmap && lmap[val] !== undefined) val = lmap[val];
            out[key] = val;
        }
        return out;
    },

    /** Persist a single account AI default. dottedKey e.g. 'ai.model'.
     *  Delegates to the canonical serialized partial-patch writer — the
     *  hand-rolled load→merge→save this used to do is what raced when
     *  selectOption fired provider + engineId + voice concurrently and
     *  silently dropped voice.ttsProvider (2026-07-10 incident). */
    async saveAiDefault(dottedKey, value) {
        await DashieAuth.patchUserSetting(dottedKey, value);
        return value;
    },

    // ── Voice response feedback (thumbs up/down) ─────────────

    /** Submit a thumbs up/down on a recorded voice interaction → the
     *  voice_feedback channel (database-operations). A down-vote carries a
     *  reason + the transcript snapshot (the reviewer is explicitly flagging
     *  their own retained transcript as an eval candidate — per-submission
     *  consent). Thumbs-up sends rating only; the handler drops any snapshot
     *  fields for an up-vote server-side. Keyed by session_id (+ turn_index
     *  for realtime) so the eval exporter can reconstruct the turn. */
    async submitFeedback({ sessionId, rating, reason = null, detail = null, promptText = null, responseText = null, turnIndex = null, model = null, toolTrace = null }) {
        return DashieAuth.dbRequest('log_voice_feedback', {
            platform: 'console',
            session_id: sessionId || null,
            rating: rating === 'down' ? 'down' : 'up',
            reason,
            detail,
            prompt_text: promptText,
            response_text: responseText,
            turn_index: turnIndex,
            model,
            // Self-contained pipeline trace ({ mode, route, model, steps, totals }) so
            // a down-row is an eval candidate without joining voice_turn_timing. The
            // handler drops it for thumbs-up (transcript/trace only ship on a down-vote).
            tool_trace: toolTrace,
        });
    },

    // ── Personalities ────────────────────────────────────────

    /** Built-in template catalog (read-only, admin-managed). Returns the
     *  raw rows from list_personality_templates. */
    async listTemplates() {
        const res = await DashieAuth.dbRequest('list_personality_templates');
        return res.data || [];
    },

    /** Custom (user-owned) personalities. */
    async listCustom() {
        const res = await DashieAuth.dbRequest('list_personalities');
        return res.data || [];
    },

    async createPersonality(p) {
        const res = await DashieAuth.dbRequest('create_personality', this._personalityPayload(p));
        return res.data;
    },

    async updatePersonality(id, p) {
        const res = await DashieAuth.dbRequest('update_personality', { id, ...this._personalityPayload(p) });
        return res.data;
    },

    async deletePersonality(id) {
        return DashieAuth.dbRequest('delete_personality', { id });
    },

    /** Family-notes override on a built-in template. */
    async saveOverride(templateKey, familyNotes) {
        const res = await DashieAuth.dbRequest('save_personality_override', {
            template_key: templateKey,
            family_notes: familyNotes,
        });
        return res.data;
    },

    async listOverrides() {
        const res = await DashieAuth.dbRequest('list_personality_overrides');
        return res.data || [];
    },

    /** TTS voice catalog (key, name, gender, description). */
    async listVoices() {
        const res = await DashieAuth.dbRequest('list_voices');
        return res.data || [];
    },

    /** Normalize an editor draft to the create/update handler shape. */
    _personalityPayload(p) {
        return {
            name: p.name,
            base_personality: p.base_personality || null,
            personality_overview: p.personality_overview || null,
            similar_persona: p.similar_persona || null,
            adjectives: p.adjectives && p.adjectives.length ? p.adjectives : null,
            topics: p.topics && p.topics.length ? p.topics : null,
            example_phrases: p.example_phrases && p.example_phrases.length ? p.example_phrases : null,
            family_notes: p.family_notes || null,
            voice_mode: p.voice_mode || 'preferred',
            voice: p.voice || null,
        };
    },
};
