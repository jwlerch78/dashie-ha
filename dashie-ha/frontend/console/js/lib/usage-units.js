/**
 * UsageUnits — what a household is told about the quantities the add-on records.
 *
 * ── WHY THIS EXISTS: A LIVE DEFECT, NOT A POLISH PASS ────────────────────────
 *
 * `usage.js` passed the stored unit map straight to the screen:
 *
 *     Object.entries(r.units).map(([k, v]) => `${k} ${v}`).join(' · ')
 *
 * so on 0.9.55 a household's Usage row reads `3 calls · bytes 186240 · seconds
 * 5.82`. Those are STORE FIELD NAMES. The numbers are right and nobody is
 * mis-billed — it is ugly rather than wrong — but it is live, and it gets worse
 * the moment token recording lands (three more raw names).
 *
 * John approved this holder 2026-10-09 (*"Agree with all recs"*), on the shape
 * that *"points to the existing Account tab rather than building a second
 * surface"*.
 *
 * ── WHY A LIB AND NOT A FORMATTER IN THE PAGE ────────────────────────────────
 *
 * The vocabulary is the SERVER'S: `usage-store.js`'s `UNIT_FIELDS` decides which
 * keys can ever appear. A label map inside the page would be a hand-mirror of
 * that set across a repo layer — exactly what the seam rule forbids — and the
 * gate can only assert the join if there is one place to join to.
 *
 * ── TWO RULES THAT ARE NOT STYLE ─────────────────────────────────────────────
 *
 * 🔴 1. NEVER TWO NUMBERS FOR ONE QUANTITY. The STT lane records `bytes`
 * ALWAYS and `seconds` only when a canonical WAV header yielded one
 * (`usage-store.js:93-97`, and `stt-usage.js:38` — *"a WRONG seconds is worse
 * than a missing one"*). Rendering both says "5.8 seconds, and also 186240
 * bytes", two measurements of the same audio, one of which is an
 * implementation detail. So `seconds` WINS when present and `bytes` is the
 * fallback that only appears when it is the only thing we have.
 *
 * 🔴 2. A DECLARED ORDER. `Object.entries` follows insertion order, which
 * differs by lane and by which fields a provider happened to return — so the
 * same row could read differently on two days for no reason the reader can
 * see. ORDER below is the one true sequence; anything not in it is not shown.
 *
 * ── ⚠️ WHAT THIS CANNOT DO YET, AND WHY — THE LANE IS NOT PERSISTED ────────
 *
 * The original design was `describe(lane, units)`, so the page could say
 * *"not reported"* for a unit the lane EXPECTS but the provider did not send —
 * distinguishing it from a unit the lane has no concept of. That is the
 * distinction `stt-usage.js:111-121` deliberately preserves in the data by
 * OMITTING a field Google did not send rather than storing a 0.
 *
 * **It cannot be rendered, because the lane is thrown away on write.**
 * `usage-store.js:170` keys the entry `${provider}|${model}|${billing}`; `lane`
 * is validated against `LANES`, used for the `USAGE:` log marker, and then
 * discarded. `UsageSource._flatten` splits that same three-part key, so no row
 * reaching this file knows which lane it came from.
 *
 * Inferring it is worse than omitting it:
 *   · FROM THE UNITS — circular. We would be deducing a quantity's meaning from
 *     which quantities are present, in order to explain what they mean.
 *   · FROM THE PROVIDER — not a function, and about to stop being one. D3 adds a
 *     Gemini TTS adapter inside the release window, so `provider: 'gemini'`
 *     will serve the STT lane AND the TTS lane. They avoid colliding in the
 *     store only because their MODEL strings differ, which is luck, not design.
 *
 * ⇒ The fix is one field: persist `lane` on the stored entry. That is
 * `usage-store.js`, which this thread does not own. Until it lands, a unit the
 * provider did not report is simply ABSENT here — which is the status quo and
 * is not a new lie, where a guessed "not reported" would be.
 */
/* ── ✅ AND WHY THERE IS NO COVERAGE FOOTER, THOUGH ONE WAS DESIGNED ──────────
 *
 * The approved shape included a footer saying which lanes this store can and
 * cannot see — pointing a household at Account → Token Usage for Live
 * conversation usage, which lands in Supabase rather than here.
 *
 * It is not built, because the page's own gating makes it unreachable:
 *   · `feature-gate.js:244` — `LOCAL_ONLY_PAGES: new Set(['usage'])`. This page
 *     renders ONLY on an account-less box; a signed-in console shows
 *     `account-usage` instead, which reads the cloud rows directly.
 *   · Live requires a signed-in user: `GeminiLiveEngine.kt:184` sends
 *     `Authorization: Bearer ${cfg.jwt}` for gateway verify + usage attribution.
 *
 * ⇒ On every box where THIS page renders, a Live session is impossible. There is
 * no missing lane to disclose, so a footer disclosing one would name a feature the
 * household cannot use — and `_renderScopeNote()` already states the coverage
 * correctly for the box this page serves: *"It covers all three legs of a turn —
 * speech-to-text, the AI model, and text-to-speech."*
 *
 * ⚠️ If `usage` ever stops being local-only, that changes: the footer becomes
 * necessary in the same change, because the page would then render for a household
 * whose Live usage exists somewhere it cannot see.
 */

const UsageUnits = {

    /** MEASURED = the provider told us. DERIVED = computed from an exact input
     *  against a vendor's STATED rate, with nothing in our hands to check it
     *  (the Live lane's `input_tokens` is `round(seconds × 25)`; that socket
     *  reports no usageMetadata at all).
     *
     *  ⚠️ Recorded in the vocabulary and DELIBERATELY NOT RENDERED. No surface
     *  shows a per-unit provenance chip today, and shipping one that nothing
     *  populates is the "looks finished" failure — the next reader treats a
     *  placeholder as a decision. It is here so the fact is written down once,
     *  where a renderer can ask for it when one exists. */
    KIND: { MEASURED: 'measured', DERIVED: 'derived' },

    /** 🔴 THE ONE SEQUENCE. See rule 2. A key absent from this list is not shown. */
    ORDER: ['seconds', 'bytes', 'characters', 'input_tokens', 'output_tokens', 'total_tokens'],

    /**
     * One row per unit `usage-store.js`'s `UNIT_FIELDS` can hold.
     *
     * `label` null = never shown. `total_tokens` is one of those: it is
     * `input + output` as the provider reported it, so it is a third number that
     * is the sum of the two beside it (John/O, 2026-10-09: omit from display,
     * keep in the data). `bytes` is conditional — see rule 1.
     *
     * 📌 Rows with `label: null` are still DECLARED, so the gate's "every store
     * unit key has a holder row" leg passes and a later reader cannot mistake an
     * omission for an oversight and add a display for it.
     */
    FIELDS: {
        seconds:       { label: 'audio',      kind: 'measured', fmt: 'duration' },
        bytes:         { label: 'audio',      kind: 'measured', fmt: 'bytes', onlyIfNo: 'seconds' },
        characters:    { label: 'spoken',     kind: 'measured', fmt: 'count' },
        input_tokens:  { label: 'tokens in',  kind: 'measured', fmt: 'count' },
        output_tokens: { label: 'tokens out', kind: 'measured', fmt: 'count' },
        total_tokens:  { label: null,         kind: 'measured', fmt: 'count' },
    },

    _fmt(kind, n) {
        const v = Number(n);
        if (!Number.isFinite(v)) return null;
        if (kind === 'duration') {
            // Seconds, to one decimal under a minute; a household thinks in
            // "how long did I talk", not in 5.823.
            return v < 60 ? `${v.toFixed(1)}s` : `${Math.floor(v / 60)}m ${Math.round(v % 60)}s`;
        }
        if (kind === 'bytes') {
            if (v < 1024) return `${Math.round(v)} B`;
            if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB`;
            return `${(v / (1024 * 1024)).toFixed(1)} MB`;
        }
        return Math.round(v).toLocaleString();
    },

    /**
     * Render one row's units as `[{ key, label, text }]`, in ORDER.
     *
     * Returns [] when there is nothing to say — which the caller must render as
     * NOTHING, not as a zero. A row with calls but no units is a real state
     * (an STT call whose audio was not a parseable WAV, before token recording
     * landed), and "0" would claim a measurement that was never taken.
     */
    describe(units) {
        const u = (units && typeof units === 'object') ? units : {};
        const out = [];
        for (const key of this.ORDER) {
            const field = this.FIELDS[key];
            if (!field || !field.label) continue;
            // Rule 1: the fallback unit yields to the better one.
            if (field.onlyIfNo && u[field.onlyIfNo] !== undefined && u[field.onlyIfNo] !== null) continue;
            const raw = u[key];
            if (raw === undefined || raw === null) continue;   // absent, by design — never a 0
            const text = this._fmt(field.fmt, raw);
            if (text === null) continue;
            out.push({ key, label: field.label, text });
        }
        return out;
    },

    /** The units a row holds that this vocabulary does not know. Loud, because an
     *  unrecognised key means the server grew a unit and nothing told the view —
     *  the join the gate exists to protect. */
    unknownKeys(units) {
        const u = (units && typeof units === 'object') ? units : {};
        return Object.keys(u).filter(k => !this.FIELDS[k]);
    },
};

window.UsageUnits = UsageUnits;
