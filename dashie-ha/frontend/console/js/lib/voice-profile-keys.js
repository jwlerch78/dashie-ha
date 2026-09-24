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

    /** Does this profile carry every declared key? */
    isComplete(profile) {
        const missing = this.all()
            .filter(([c, k]) => typeof profile?.values?.[c]?.[k] !== 'string')
            .map(([c, k]) => `${c}.${k}`);
        return { complete: missing.length === 0, missing };
    },
};
