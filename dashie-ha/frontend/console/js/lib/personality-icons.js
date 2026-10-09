/**
 * PersonalityIcons — which console icon stands for which personality.
 *
 * John, 2026-10-08, on the HA release scope: personalities should *"give them
 * icon + description + active-inactive status"*. This holds the first third.
 *
 * ── WHY THE CONSOLE OWNS THIS AND NOT personality-templates.js ──────────────
 *
 * The roster is static data shipped with the add-on; an icon FILENAME is a
 * frontend asset, and putting one in the server's template rows would make the
 * server assert the existence of a file in `frontend/console/assets/icons/`. It
 * would also only cover ONE of the two sources the console renders from: in
 * cloud mode the templates come back from the account-backed
 * `list_personality_templates`, whose rows have no icon field and never will.
 * A map here answers for both sources with one declaration.
 *
 * ── A MISS IS A DEFAULT, NOT A GAP ──────────────────────────────────────────
 *
 * Custom personalities are user-authored and have no key in this map, and that
 * is the normal case rather than an error — so `for()` returns the generic
 * persona face and says nothing. 🔴 Deliberately NOT a `DROP:` warning: a
 * household with four custom personalities would log four warnings per render
 * about behaving exactly as designed, and a warning that fires when nothing is
 * wrong is how a log stops being read. The loud-drop rule is for a DISPATCH
 * that found no handler; this is a lookup with a declared default.
 *
 * ⚠️ Keys are the PERSISTED personality ids (`ai.defaultPersonalityId`), so they
 * follow the roster's own rule: add rows, never rename them.
 */
const PersonalityIcons = {

    /** The generic persona face — every personality this map does not name. */
    DEFAULT: 'icon-persona',

    BY_KEY: {
        // The standard voice of the house gets the house's own persona mark.
        dashie: 'icon-persona',
        princess: 'icon-crown',
        butler: 'icon-bowtie',
    },

    /** The icon basename for a personality key (no path, no extension — the
     *  renderers build `assets/icons/<name>.svg`, as voice-ai-cards does). */
    for(key) {
        return this.BY_KEY[String(key || '')] || this.DEFAULT;
    },

    /** An `<img>` for a personality row or card. Sized by the caller, because
     *  the row wants it inline with the title and a card wants it larger. */
    img(key, px = 16) {
        const name = this.for(key);
        return `<img src="assets/icons/${name}.svg" alt="" aria-hidden="true"`
            + ` style="width:${px}px; height:${px}px; opacity:0.6; flex-shrink:0;">`;
    },
};

window.PersonalityIcons = PersonalityIcons;
