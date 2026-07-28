/* ============================================================
   ConsoleIntentClassifier — lightweight HA fast path
   ------------------------------------------------------------
   Mirrors the slice of the tablet's IntentClassifier that matters
   here: clear smart-home commands get intercepted and forwarded
   to HA's Assist pipeline directly, bypassing the AI entirely.
   Same effect, way smaller code surface than porting the full
   4k-line classifier from the webapp.

   Decision rule:
     classify(text) returns { matched: bool, confidence, intent? }
     where intent = {
       category: 'homeassistant',
       command:  'forward_to_assist',
       transcript: <original text>,
     }

     matched=true when the text contains BOTH a verb pattern AND
     a known HA-domain noun (or a thermostat verb with a degree).
     confidence is heuristic — 0.9 for verb+noun, 0.8 for
     "set X to N degrees", lower for partial matches we still
     route through (so the caller can decide to short-circuit).

   We deliberately let ambiguous text fall through to AI. The
   classifier's job is to catch the obvious commands ("turn off
   the family room lights") that the AI was misformatting in the
   second pass, not to compete with the AI on grey-area queries.
   ============================================================ */

(function () {
    const VERBS = [
        // On / off — most common
        /\bturn\s+(?:the\s+)?(?:on|off)\b/i,
        /\bturn\s+\w[\w\s'-]*\s+(?:on|off)\b/i,
        /\bswitch\s+(?:the\s+)?(?:on|off)\b/i,
        /\bswitch\s+\w[\w\s'-]*\s+(?:on|off)\b/i,
        /\btoggle\b/i,
        // Covers and doors
        /\b(?:open|close|shut)\b/i,
        // Locks
        /\b(?:lock|unlock)\b/i,
        // Brightness
        /\b(?:dim|brighten)\b/i,
        /\bset\s+\w[\w\s'-]*\s+to\s+\d+%?\b/i,
        // Thermostat
        /\bset\s+\w[\w\s'-]*\s+to\s+\d+\s*(?:degrees?|°)\b/i,
        /\b(?:warm|cool|heat)\s+(?:up|down|the)\b/i,
        // Scenes / scripts / automations
        /\b(?:activate|run|start|trigger)\b/i,
        // Media
        /\b(?:pause|resume|stop|play)\b/i,
    ];

    // Nouns that strongly indicate an HA entity domain. Words like
    // "kitchen" / "office" don't qualify on their own — only when paired
    // with a domain noun.
    const HA_NOUNS = [
        'light', 'lights', 'lamp', 'lamps',
        'switch', 'switches', 'plug', 'outlet',
        'garage', 'door', 'doors', 'gate',
        'lock', 'locks',
        'thermostat', 'heat', 'heater', 'ac', 'air conditioner', 'hvac',
        'fan', 'fans',
        'scene', 'automation', 'script',
        'cover', 'covers', 'blind', 'blinds', 'curtain', 'curtains', 'shade', 'shades',
        'tv', 'speaker', 'speakers', 'music',
    ];

    function _hasVerb(text) {
        for (const re of VERBS) {
            if (re.test(text)) return true;
        }
        return false;
    }

    function _hasNoun(text) {
        const lower = ` ${text.toLowerCase()} `;
        for (const n of HA_NOUNS) {
            if (lower.includes(` ${n} `) || lower.includes(` ${n}.`) || lower.includes(` ${n},`)) {
                return true;
            }
        }
        return false;
    }

    /** Detects "set thermostat to 72" style — verb + degree even without
     *  one of the noun list matching (since "thermostat" is in the list
     *  already, this mostly catches "set it to 72 degrees" follow-ups). */
    function _hasDegreeTarget(text) {
        return /\b\d+\s*(?:degrees?|°)\b/i.test(text);
    }

    function classify(text) {
        if (!text || typeof text !== 'string') return { matched: false, confidence: 0 };
        const trimmed = text.trim();
        if (trimmed.length === 0) return { matched: false, confidence: 0 };

        const hasVerb = _hasVerb(trimmed);
        const hasNoun = _hasNoun(trimmed);
        const hasDegree = _hasDegreeTarget(trimmed);

        let confidence = 0;
        if (hasVerb && hasNoun) confidence = 0.9;
        else if (hasVerb && hasDegree) confidence = 0.85;
        else if (hasNoun && hasDegree) confidence = 0.7;

        if (confidence < 0.7) return { matched: false, confidence };

        return {
            matched: true,
            confidence,
            intent: {
                category: 'homeassistant',
                command: 'forward_to_assist',
                transcript: trimmed,
            },
        };
    }

    window.ConsoleIntentClassifier = { classify };
})();
