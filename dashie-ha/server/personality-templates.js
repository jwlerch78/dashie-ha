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
// ── 2026-10-09: NARROWED, NOT RETIRED ───────────────────────────────────────
//
// John's D7 settled the KOKORO half for THIS edition's V1 roster: Princess
// `bf_alice`, Butler `bm_george`, and the default personality deliberately left
// with no voice at all (see its own note). So the refs above are now concrete
// rather than placeholder.
//
// The omission above STILL STANDS, because what settled is one quadrant of what
// it describes: the matrix was "across Kokoro/Piper/Inworld/Gemini Live... on
// BOTH editions", and Gemini Live and the other edition are untouched. Pinning a
// vocabulary now would still pin the wrong one. Declaring this settled because
// the part we needed is settled is how a decision about one edition becomes an
// accidental decision about two.
//
// 🔴 AND A LIMIT THAT IS NOT A STYLE POINT: `resolveVoice` checks the PROVIDER,
// never the voice ID. `kokoro:bm_george` resolves as soon as the Kokoro add-on
// is installed, whether or not that add-on serves a voice by that name — and
// `server/voice-engines.js:_detectKokoro` returns `voices: []` by design
// ("voice enumeration of the add-on is a later step"), so nothing on this side
// CAN check it. A wrong ID therefore fails at SPEECH time, on a box, silently
// from the console's point of view.
//
// check-personalities asserts the refs are well-formed against Kokoro's
// documented `{lang}{gender}_{name}` convention, which catches a typo in SHAPE
// without hand-mirroring Kokoro's 54-voice catalogue into this repo. It cannot
// catch a well-formed name that does not exist. That one needs the add-on on a
// real box and is on John's device list.
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
        // 🔴 STILL EMPTY, AND DELIBERATELY SO — re-decided 2026-10-09 while
        // mapping the others onto Kokoro, because "give every personality a
        // Kokoro voice" is the obvious next step and it is wrong here.
        //
        // This IS the standard voice, so it has nothing to prefer and nothing to
        // degrade to; an empty list is a valid, meaningful value, not a missing
        // one. Naming a voice here would make the DEFAULT personality OVERRIDE
        // the household's own text-to-speech choice: a family that picked Piper
        // "Amy" in the TTS card would silently get `af_bella` instead, because
        // the personality ranked higher than their setting. The character
        // personalities earn a specific voice — for Butler the voice IS the
        // character — and the default one does not.
        //
        // It would also convert a personality that can never be degraded into
        // one that renders "(voice not available)" on a box with no engines,
        // which is a worse first impression for the row most households see.
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
        // Kokoro inserted ahead of Piper (2026-10-09, John's D7). `bf_alice` is
        // Kokoro's British female voice documented as "elegant, refined", which
        // is the closest thing in a keyless engine to what this persona is for.
        voices: ['elevenlabs:princess', 'inworld:princess', 'kokoro:bf_alice', 'piper:en_US-amy-low'],
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
        // `bm_george` is one of Kokoro's four British male voices — the thing
        // Piper cannot match for this persona, and the reason John asked whether
        // Kokoro had voices suited to the roster. It does: 54 across 9 languages,
        // 4 British male and 4 British female.
        voices: ['elevenlabs:butler', 'inworld:butler', 'kokoro:bm_george', 'piper:en_GB-alan-low'],
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
