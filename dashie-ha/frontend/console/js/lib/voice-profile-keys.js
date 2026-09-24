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
    // 🔴 THE ACCOUNT *IS* THE DEFAULT PROFILE (John, 2026-09-24). `user_settings.voice.*`
    // / `ai.default*` is not a legacy layer — it is Default's storage, renamed. So there
    // is no "un-migrated household" state and no empty state: every household has
    // Default, always. `voiceProfiles` holds the NAMED profiles only.
    //
    // Second copy of the resolution ORDER in the webapp's js/data/settings/voice-profiles.js,
    // gated the same way as the key list (`lint:profile-keys` pins DEFAULT_PROFILE_ID
    // across every spelling; `lint:profile-layer` runs these functions for real).

    /** The id meaning "the account paths". Never a key inside `voiceProfiles`. */
    DEFAULT_PROFILE_ID: 'default',

    /**
     * The household's NAMED profiles, or null when it has none.
     *
     * 🔴 A deleted profile is stored as null, not removed — patchUserSetting cannot
     * delete a key (D-121). A blob stored under `default` is ignored on purpose: Default
     * is the account paths, so a key by that name is a stale artefact, not a profile.
     */
    named(settings) {
        const raw = settings?.voiceProfiles;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const out = {};
        for (const [id, p] of Object.entries(raw)) {
            if (p && typeof p === 'object' && id !== this.DEFAULT_PROFILE_ID) out[id] = p;
        }
        return Object.keys(out).length > 0 ? out : null;
    },

    /**
     * Which layer supplies THIS DEVICE's defaults.
     *
     * 🔴 Reads the device's own pointer — `settings.voice.profileId`, a SYNCED device key
     * since CONTRACTS #148 landed. The first version of this page read that field before
     * anything wrote it and got `undefined` for every device in every household, which is
     * exactly what "no assignments" looks like (§12.8 finding 1). It is real now.
     *
     * @returns {{source: 'default'|'profile'|'dangling', id: string, name: string, profile: ?object}}
     *   default  — following Default: the account paths answer. The normal case.
     *   profile  — following a named profile, authoritative for every key it carries.
     *   dangling — the pointer names a profile that no longer exists; Default answers,
     *              which always exists, so the device stays configured.
     */
    layer(settings, device) {
        const id = String(device?.settings?.voice?.profileId || '') || this.DEFAULT_PROFILE_ID;
        if (id === this.DEFAULT_PROFILE_ID) {
            return { source: 'default', id, name: 'Default', profile: null };
        }
        const p = this.named(settings)?.[id];
        if (p) return { source: 'profile', id, name: String(p.name || id), profile: p };
        return { source: 'dangling', id, name: '', profile: null };
    },

    /**
     * The value a device with no override of its own will actually run, and the layer
     * that supplied it.
     *
     * 🔴 A NAMED profile does NOT fall through to Default. It is complete, so it answers
     * for every key it declares including the ones it holds as '' — per-key fallback
     * would resurrect Default's value the moment a user cleared a field, which cannot be
     * told apart from a save that failed.
     *
     * @param accountValue what the caller read from the account paths — i.e. Default.
     */
    inherited(settings, device, category, key, accountValue) {
        const L = this.layer(settings, device);
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
