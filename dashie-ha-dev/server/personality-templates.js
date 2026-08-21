// SPDX-License-Identifier: AGPL-3.0-only
// server/personality-templates.js — the built-in personality roster, shipped
// with the add-on as STATIC DATA.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
//
// The console's personality list was empty on an account-less box, and not
// because the page was broken: it asked `list_personality_templates`, an
// ACCOUNT-BACKED call, of a box with no account. Same structural cause as the
// empty Devices roster, and it takes the same fix — RE-SOURCE the answer, do not
// fake it. ⚠️ A `try/catch` returning `[]` at the call site would have rendered
// an empty list correctly and permanently: the silent-empty failure this ground
// has already paid for twice.
//
// ── INDEPENDENTLY AUTHORED, ON PURPOSE (John, s127) ──────────────────────────
//
// The other edition's templates live in the service; these live here. Two
// populations of one concept, deliberately NOT generated from each other: the
// rosters genuinely differ (this is 3 of ~9, bounded by which voices are
// reachable without a paid key), so a generator would force agreement between
// two things that are not the same thing.
//
// 📌 A later discussion about keeping the two rosters aligned without
// maintaining every personality twice is DEFERRED by John — independence stands.
// The field NAMES here deliberately match the account schema's
// (`personality_overview`, `similar_persona`, `adjectives`, `topics`,
// `example_phrases`, `family_notes`) so that alignment, if it ever happens, is
// not made gratuitously hard. That costs nothing and buys the option.
//
// ── THE VOICE FIELD ──────────────────────────────────────────────────────────
//
// 🔴 `voices` is an ORDERED PREFERENCE LIST of OPAQUE STRINGS. There is
// deliberately NO enum, NO validation against a fixed list and NO
// `lint:wire-values` leg on it. John is building a per-personality default-voice
// matrix across Kokoro/Piper/Inworld/Gemini Live that may reshape voice mapping
// on BOTH editions; pinning a vocabulary now would pin the wrong one — and it
// would LOOK FINISHED, which is worse than looking unfinished, because the next
// reader treats a settled enum as a decision rather than a placeholder.
//
// What would retire that omission: the matrix settling. Then the refs become a
// registered vocabulary with a gate, in one change.
//
// Resolution walks the list against the providers actually available. If none
// resolve, the personality STAYS SELECTED AND FUNCTIONAL and only its VOICE
// degrades to the standard one — a Butler with no Butler voice is still a
// Butler. ⚠️ "(voice not available)" is a UI STATE, NEVER A STORED VALUE:
// persisting it would freeze a transient fact (the key may arrive tomorrow),
// which is the same class as writing "Not shared" off an empty map.

'use strict';

/**
 * V1 roster, John's words: Friendly Assistant (the original), Princess, Butler,
 * plus the custom-personality affordance. Later: Pirate, Drill Sergeant, Surfer
 * Dude, Cowboy, Santa, Bad Santa — several of which need ElevenLabs, which is
 * exactly why they are not in V1.
 *
 * `key` is the stable id the console and the device both use, and it is a
 * PERSISTED value (`ai.defaultPersonalityId`): renaming one silently unsets the
 * personality for any household that chose it. Add rows; do not rename them.
 */
const TEMPLATES = [
    {
        key: 'dashie',
        name: 'Friendly Assistant',
        description: 'Warm, brief and helpful — the standard voice.',
        personality_overview:
            'A warm, capable household assistant who answers plainly and gets out of the way. '
            + 'Friendly without being chatty, and never performative.',
        similar_persona: null,
        adjectives: ['warm', 'concise', 'practical'],
        topics: [],
        example_phrases: [],
        // Empty on purpose: this IS the standard voice, so it has nothing to
        // prefer and nothing to degrade to. An empty list is a valid, meaningful
        // value here — not a missing one.
        voices: [],
    },
    {
        key: 'princess',
        name: 'Princess',
        description: 'Sweet, sparkly and a little dramatic.',
        personality_overview:
            'A cheerful storybook princess: kind, sparkly, fond of small ceremonies, and delighted '
            + 'by ordinary things. Encouraging to children without being saccharine.',
        similar_persona: null,
        adjectives: ['cheerful', 'gentle', 'whimsical'],
        topics: ['kindness', 'small celebrations'],
        example_phrases: ['Oh, how lovely!', 'Shall we?'],
        voices: ['elevenlabs:princess', 'inworld:princess', 'piper:en_US-amy-low'],
    },
    {
        key: 'butler',
        name: 'Butler',
        description: 'Formal, dry and unfailingly composed.',
        personality_overview:
            'An impeccably composed household butler: formal, precise, quietly dry, and entirely '
            + 'unflappable. Answers are short, correct, and delivered without fuss.',
        similar_persona: null,
        adjectives: ['formal', 'dry', 'composed'],
        topics: ['the household', 'punctuality'],
        example_phrases: ['Very good.', 'As you wish.'],
        voices: ['elevenlabs:butler', 'inworld:butler', 'piper:en_GB-alan-low'],
    },
];

/** The template rows, as the console's `list_personality_templates` shape.
 *  Deep-copied so a consumer cannot mutate the shipped roster in process. */
function listTemplates() {
    return JSON.parse(JSON.stringify(TEMPLATES));
}

/** One template by key, or null. */
function getTemplate(key) {
    return listTemplates().find(t => t.key === String(key || '')) || null;
}

/** The key a voice degrades TO. Not a template lookup — it is the identity of
 *  "the standard voice", and the fallback must not depend on a roster row that
 *  a later edit could remove. */
const STANDARD_PERSONALITY_KEY = 'dashie';

module.exports = { TEMPLATES, listTemplates, getTemplate, STANDARD_PERSONALITY_KEY };
