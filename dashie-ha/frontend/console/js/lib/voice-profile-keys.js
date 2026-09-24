/* ============================================================
   Voice-profile key set — the console's copy, and why it is a copy
   ------------------------------------------------------------
   A PROFILE is a COMPLETE named set of the account-default layer (John ruled
   2026-09-23; build plan 20260923_VOICE_PROFILES_SPEC_INPUTS.md §11). "Complete"
   means every key is present, so creating one needs the key list.

   🔴 THIS IS A DELIBERATE SECOND COPY, AND IT IS GATED.
   The canonical list is OVERRIDE_SPECS in the webapp's
   js/data/settings/override-resolution.js (plus the three §12 extras). The
   console is a SEPARATE REPO served from the add-on and cannot import it — there
   is no build step that could, and vendoring the module would drag the whole
   resolver across a boundary it has no business crossing. So the seam rule's
   tier 1 (eliminate) is genuinely unavailable and this lands at tier 3 (lint):
   `lint:profile-keys` fails if this list and OVERRIDE_SPECS disagree.

   ⚠️ A profile MISSING a key is not a cosmetic bug: every device inheriting that
   key gets no profile-level answer. Under the per-household fallback that means
   the whole profile is still authoritative, so the key resolves to NOTHING and
   the device goes quiet — which reads as broken hardware, not a bad profile.
   That is why the list is gated rather than merely commented.

   Order matters only for display; the gate compares sets.
   ============================================================ */

window.VoiceProfileKeys = {
    /** category -> [key, ...]. Mirrors OVERRIDE_SPECS + §12's three extras. */
    SHAPE: {
        voice: [
            'sttProvider', 'ttsProvider', 'haSttEngineId', 'haTtsEngineId', 'haTtsVoiceId',
            // Ruling A (John, 2026-09-23): the local engine pair ships TOGETHER — a voice
            // id is meaningless without the endpoint it lives on.
            'localTtsUrl', 'localTtsVoiceId',
            // §9: a profile carries the preset it was seeded from, as a label.
            'pipelinePreset',
        ],
        aiVoice: ['personalityId', 'voiceKey', 'wakeWord'],
    },

    /** The account settings path each key is seeded FROM when a profile is created. */
    accountPath(category, key) {
        if (category === 'aiVoice') {
            return `ai.default${key.charAt(0).toUpperCase()}${key.slice(1)}`;
        }
        return `voice.${key}`;
    },

    /** Every [category, key] pair, flattened. */
    all() {
        return Object.entries(this.SHAPE).flatMap(([cat, keys]) => keys.map((k) => [cat, k]));
    },

    /**
     * Build a COMPLETE profile from the account layer.
     *
     * 🔴 Reads RAW ACCOUNT VALUES. It must never read a device's resolved value: on a
     * device carrying overrides the resolved value is THAT DEVICE's choice, and seeding
     * the household profile from it promotes one tablet's setting to the whole house.
     * The console has no device overrides in scope, which is why creating a profile HERE
     * is structurally safer than migrating on a device — but the rule is stated because
     * the next person to touch this will be tempted by a convenient resolved getter.
     */
    build(name, readAccount) {
        const values = {};
        const unset = [];
        for (const [cat, key] of this.all()) {
            if (!values[cat]) values[cat] = {};
            const v = readAccount(this.accountPath(cat, key));
            const s = (typeof v === 'string') ? v : '';
            if (s === '') unset.push(`${cat}.${key}`);
            values[cat][key] = s;
        }
        return { name, schemaVersion: 1, values, unset };
    },

    // ── The profile LAYER: which default does a device actually follow? ──────
    //
    // 🔴 SECOND COPY of the resolution ORDER in the webapp's
    // js/data/settings/voice-profiles.js. Same reason as the key list above — the
    // console cannot import the resolver — and gated the same way:
    // `lint:profile-keys` pins DEFAULT_PROFILE_ID against the webapp's constant.
    //
    // ⚠️ THE POINTER IS NOT PER-DEVICE YET, AND THAT IS WHY THIS IS ANSWERABLE.
    // The webapp reads the active profile from localStorage['dashie-device-profile-id']
    // (voice-profiles.js ACTIVE_PROFILE_LS). NOTHING WRITES THAT KEY — there is no
    // picker on any surface until phase 2b — so activeProfileId() returns the seeded
    // DEFAULT_PROFILE_ID on every device, always. The household therefore follows ONE
    // profile, and "which default does this device follow?" is a household question.
    //
    // It is also device-INVISIBLE: the key is device-local and is not in
    // SETTINGS_KEY_MAP, so it never reaches user_devices and the console could not
    // read a per-device pointer even if one existed. When 2b introduces a real
    // picker it must ALSO map the pointer as a synced device key, and then
    // layer() takes a device argument. That is the one place this changes.

    /** The id the webapp seeds and falls back to (voice-profiles.js DEFAULT_PROFILE_ID). */
    DEFAULT_PROFILE_ID: 'default',

    /**
     * The household's LIVE profiles, or null when it has none.
     *
     * 🔴 A deleted profile is stored as null, not removed — patchUserSetting cannot
     * delete a key (D-121). Counting null entries makes a household that deleted its
     * last profile read as migrated-with-zero-profiles, which is the state where every
     * answer about the household is wrong while resolution still looks fine.
     */
    live(settings) {
        const raw = settings?.voiceProfiles;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const out = {};
        for (const [id, p] of Object.entries(raw)) if (p && typeof p === 'object') out[id] = p;
        return Object.keys(out).length > 0 ? out : null;
    },

    /**
     * Which layer supplies this household's defaults right now.
     *
     * @returns {{source: 'account'|'profile'|'dangling', id: ?string, name: string,
     *            profile: ?object, has: string[]}}
     *   account  — no profiles exist. The legacy account paths answer, exactly as
     *              before profiles existed. This is a normal, supported steady state.
     *   profile  — a profile with the seeded id exists and is authoritative for EVERY
     *              key it carries, including the ones it holds as ''.
     *   dangling — profiles exist but none carries the seeded id, so every device
     *              falls back to the account layer and logs a DROP. Resolution is
     *              correct; the profiles are simply doing nothing. Surface it.
     */
    layer(settings) {
        const profiles = this.live(settings);
        if (!profiles) return { source: 'account', id: null, name: '', profile: null, has: [] };
        const id = this.DEFAULT_PROFILE_ID;
        const p = profiles[id];
        if (p) return { source: 'profile', id, name: String(p.name || id), profile: p, has: Object.keys(profiles) };
        return { source: 'dangling', id, name: '', profile: null, has: Object.keys(profiles) };
    },

    /**
     * The value a device with no override of its own will actually run, and the
     * layer that supplied it.
     *
     * 🔴 The fallback is PER-HOUSEHOLD, not per-key. A migrated household's profile
     * answers for every declared key including the ones it holds as '' — it does NOT
     * fall through to `accountValue`. Per-key fallback would make clearing a field in
     * a profile resurrect the old account value, which is indistinguishable from a
     * save that failed.
     *
     * @param accountValue what the caller already read from the legacy account layer.
     */
    inherited(settings, category, key, accountValue) {
        const L = this.layer(settings);
        if (L.source === 'profile') {
            const v = L.profile.values?.[category]?.[key];
            return { value: (typeof v === 'string') ? v : '', layer: L };
        }
        return { value: accountValue == null ? '' : String(accountValue), layer: L };
    },

    /** Does this profile carry every declared key? */
    isComplete(profile) {
        const missing = this.all()
            .filter(([c, k]) => typeof profile?.values?.[c]?.[k] !== 'string')
            .map(([c, k]) => `${c}.${k}`);
        return { complete: missing.length === 0, missing };
    },
};
