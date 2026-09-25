/* ============================================================
   VoicePipelineSummary — ONE sentence describing what a device's voice
   pipeline actually is, asked from every surface that needs it.
   ------------------------------------------------------------
   WHY THIS EXISTS

   voice-ai-sections.js said it when the sections were built: *"The same sentence is
   needed in three places — collapsed here, in the profile list, and on a device page
   saying what that device follows. Three copies of 'Hybrid · Deepgram → Inworld ·
   Gemini 2.5 Flash' drift, and the visible symptom is two screens disagreeing about
   one profile, which is the exact failure the profile work exists to remove."*

   It was never built, so the Voice & AI page assembles its own line inline and the
   device card had a different, shorter one. John asked for the card to carry the same
   sentence (2026-09-25), which is the moment to make the holder real rather than
   write a third copy.

   🔴 IT RESOLVES THROUGH THE DEVICE'S PROFILE, not the raw account paths. A tablet
   following "Evenings" must describe Evenings' pipeline. Reading `settings.voice.*`
   directly is the bug this whole layer exists to prevent — and it is the bug
   voiceSetupSummary() still had for `pipelinePreset`, which is why a device on a
   named profile showed the household's preset next to the profile's engines.

   ⚠️ `ai.model` is deliberately the ACCOUNT's, not the profile's. It is not in the
   profile shape (voice-profile-scope routes it to the account), so resolving it
   through the profile layer would invent a value the profile does not hold.
   ============================================================ */

const VoicePipelineSummary = {

    /**
     * Which profile is this device following, by NAME.
     *
     * 'Default' for the household's own settings; the profile's name when it follows a
     * named one; '<id> (missing)' for a dangling pointer — named as dangling, because
     * rendering a bare id reads as a profile whose name looks like a slug, and falling
     * back to 'Default' would claim a state the device is not in.
     */
    profileName(device, settings) {
        const id = String(device?.settings?.voice?.profileId || '');
        if (!id) return 'Default';
        const named = window.VoiceProfileKeys?.named?.(settings) || {};
        return named[id]?.name || `${id} (missing)`;
    },

    /** Does this device hold its own pipeline overrides? Drives the card's diff dot. */
    isCustom(device) {
        const s = window.DevicesDetailModals;
        return !!s?.voiceSetupSummary?.(device)?.custom;
    },

    /** The value this device actually follows for one profile-carried key. */
    _resolved(device, settings, category, key, accountValue) {
        const r = window.VoiceProfileKeys?.inherited?.(settings, device, category, key, accountValue);
        return r ? r.value : (accountValue == null ? '' : String(accountValue));
    },

    _label(list, id) {
        if (!id) return '';
        const hit = (list || []).find((o) => o && o.id === id);
        return hit ? hit.label : String(id);
    },

    /**
     * "Default (Cloud, Gemini 2.5 Flash) · Dashie Cloud STT · On-Device (Built-in)"
     *
     * Shape per John, 2026-09-25: the profile leads, with the pipeline type and the AI
     * model in parentheses beside it, then the two engines.
     *
     * Every part is omitted rather than guessed when it is not known. A household that
     * has never opened Voice & AI has no preset, and printing "Cloud" there would state
     * a setting that does not exist — the same reasoning voiceSetupSummary already
     * carries for its '—'.
     *
     * @param {object} device  the user_devices row
     * @param {object|null} settings  account settings (AccountSettingsStore.get())
     * @param {object|null} engines  HA engine detection, for engine-direct labels
     */
    forDevice(device, settings, engines) {
        const O = window.VoiceAiOptions;
        if (!O) return '';
        const acctVoice = settings?.voice || {};

        const preset = this._resolved(device, settings, 'voice', 'pipelinePreset', acctVoice.pipelinePreset);
        const stt = this._resolved(device, settings, 'voice', 'sttProvider', acctVoice.sttProvider);
        const tts = this._resolved(device, settings, 'voice', 'ttsProvider', acctVoice.ttsProvider);

        const presetLabel = this._label(O.PRESETS, preset);
        // ⚠️ ACCOUNT model, not profile — see the header note.
        const modelLabel = this._label(O.models?.(engines, settings?.ai?.model), settings?.ai?.model);

        const head = [presetLabel, modelLabel].filter(Boolean).join(', ');
        const profile = this.profileName(device, settings);

        // Under HA Voice Assist the Assist pipeline owns STT and TTS, so naming Dashie
        // engines there would describe a route this device is not taking.
        const isHaAssist = preset === 'ha_assist';
        const engineParts = isHaAssist ? [] : [
            this._label(O.sttOptions?.(engines, stt) || O.STT, stt),
            this._label(O.ttsOptions?.(engines, tts) || O.TTS, tts),
        ].filter(Boolean);

        // 🔴 The profile NAME alone is not a summary — it is what we know before the
        // account settings have loaded, and a row reading just "Default" describes a
        // device with no voice setup rather than one we have not looked up yet. Callers
        // treat '' as "render nothing".
        if (!head && !engineParts.length) return '';
        return [head ? `${profile} (${head})` : profile, ...engineParts].join(' · ');
    },
};

window.VoicePipelineSummary = VoicePipelineSummary;
