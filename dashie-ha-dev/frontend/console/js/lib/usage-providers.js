/**
 * UsageProviders — what a household is told about WHO served a recorded call.
 *
 * Sibling of `usage-units.js`: that one names the quantities, this one names the
 * party. John approved it 2026-10-09 as item ④ of four ("Yes on all 4").
 *
 * ── WHY THIS EXISTS: FIVE KINDS OF NAME IN ONE COLUMN ────────────────────────
 *
 * `usage.js` printed `r.provider` verbatim, and the store emits five different
 * KINDS of string into that one field:
 *
 *   `brain`          a LANE name    (brain/addon-io.js, literal)
 *   `dashie_cloud`   a WIRE id      (stt-usage.js, literal)
 *   `gemini`         a real provider (stt-usage.js, D5)
 *   `elevenlabs`     an ADAPTERS id (byok-tts.js)
 *   `api.openai.com` a HOST         (stt-usage.js hostOf(stt_url), unbounded)
 *   `unknown`        the fallback   (stt-usage.js)
 *
 * Today the provider string happens to IMPLY the lane, so the column reads as
 * coherent. It stops the moment one provider serves two lanes — a household on
 * one Gemini key would see `gemini` twice with nothing saying which is
 * speech-in and which is speech-out. The lane itself is a separate fix in
 * `usage-store.js` (settled with HV: a field on the entry, never in the key).
 *
 * ── 🔴 THIS IS A JOIN, NOT A NEW MIRROR — AND THAT WAS THE POINT ─────────────
 *
 * The seam rule says to try to SHARE the first copy before writing a second.
 * There already is one: `provider-manifest.js` carries `name` for every provider
 * the console knows (`gemini` → "Google Gemini", `elevenlabs` → "ElevenLabs",
 * `kokoro` → "Kokoro"). So `describe()` asks `ProviderManifest.byId()` FIRST and
 * only falls back for ids the manifest cannot know.
 *
 * ⭐ That is why this file needs no `JS_KOTLIN_CONTRACTS` row, unlike row 200 for
 * the units. A hand-written map of provider names would have been a second
 * spelling of an identity the console already holds, and it would drift the first
 * time a provider was renamed in one place.
 *
 * ── 🔴 WHY `brain` IS NOT RENDERED AS "AI" ───────────────────────────────────
 *
 * It is tempting, and it is the same defect in friendlier words.
 * `provider: 'brain'` is a LANE name sitting in the provider column: the server
 * never records WHICH AI provider ran, so there is no name to show. Printing
 * "AI" would be a lane label wearing a provider's clothes — it reads as a
 * decision and is actually a gap, which is strictly worse than a blank because
 * nobody then asks why.
 *
 * So `brain` reports UNRECORDED, and the row's `model` (e.g. `gemini-2.5-flash`)
 * carries what is genuinely known. We deliberately do NOT resolve that model id
 * back to a provider through `ai-models-catalog.js`: an incomplete catalog would
 * print a confidently WRONG provider name, and deriving identity from a model
 * string is the inference this file exists to avoid.
 *
 * 📌 The real fix is upstream and is HV's: `byok.provider` — the actual provider
 * id — is already computed at `converse.js:228` and used at `:239` for
 * `routeTag`, but only `byok.label` is passed into `createAddonIO` (`:236`), so
 * `addon-io.js:278` records the literal `'brain'` while the id sits one frame up.
 * When that is threaded through, these rows resolve through the manifest like
 * every other row and this branch stops being reached for BYOK brains.
 *
 * ⚠️ It will still be reached, and must be: `providerForModel()`
 * (`brain/providers.js:26`) returns null for a LOCAL model, which has no cloud
 * provider at all. Then "not recorded" is the TRUE answer rather than a recording
 * failure — which is why this branch is not throwaway scaffolding.
 *
 * ── THE THIRD KIND: A HOST IS ALREADY A HOUSEHOLD WORD ───────────────────────
 *
 * `hostOf(opts.stt_url)` yields whatever the operator typed into the add-on
 * options — `api.openai.com`, `192.168.1.40:8080`, a Tailscale name. That set is
 * UNBOUNDED, so no map can cover it, and it needs no map: the household chose
 * that string. It is passed through unchanged and merely labelled as their own
 * engine, which is the one thing the raw string does not say.
 */

const UsageProviders = {
    /** What KIND of answer `describe()` found. The page styles on this; it is
     *  never shown raw. */
    KIND: {
        NAMED: 'named',             // the manifest knows it — a real provider
        DECLARED: 'declared',       // we know it, the manifest cannot (dashie_cloud)
        SELF_HOSTED: 'self-hosted', // a host the operator typed
        UNRECORDED: 'unrecorded',   // no provider was recorded, or there is none
        UNKNOWN_ID: 'unknown-id',   // a string nothing here recognises — drift
    },

    /**
     * Ids the manifest legitimately does not carry, with the reason each is here.
     *
     * 🔴 `dashie_cloud` is a WIRE value on the account contract and is on the
     * brand table's annotated keep-list for that reason (see `stt-usage.js:156`
     * on why it is spelled with an underscore and why a second spelling would
     * split a household's history across two store keys). It is not a BYOK
     * provider, so it has no manifest row — but it absolutely has a name the
     * household already sees elsewhere in this console ("Dashie Cloud"), so this
     * is one declared constant rather than an invention.
     */
    DECLARED: {
        dashie_cloud: 'Dashie Cloud',
    },

    /**
     * Ids that mean "no provider was recorded". Each is a LITERAL written by
     * exactly one call site, so this is a declared set, not a pattern match.
     *
     *   `brain`   — brain/addon-io.js:278, the lane name (see the header)
     *   `unknown` — stt-usage.js:202's fallback when `hostOf()` could not parse
     */
    UNRECORDED: new Set(['brain', 'unknown']),

    /** What the household reads when nothing identifies the provider. Deliberately
     *  not "AI", not the lane, not a guess from the model id. */
    UNRECORDED_TEXT: 'Provider not recorded',

    /** A self-hosted engine's own label. The host is the household's own string;
     *  this only says what KIND of thing it is, which the bare host does not. */
    SELF_HOSTED_SUFFIX: 'your engine',

    /**
     * Name one recorded provider id.
     *
     * @param {string} id the store's `provider` component, verbatim
     * @returns {{kind: string, text: string, raw: string}} `text` is always safe
     *   to show; `kind` says how it was resolved so the page can style or hint.
     *   Never throws, never returns an empty `text`.
     */
    describe(id) {
        const raw = String(id == null ? '' : id).trim();

        // Empty is the same claim as `unknown`: the row exists, the party does not.
        if (!raw) {
            return { kind: this.KIND.UNRECORDED, text: this.UNRECORDED_TEXT, raw };
        }

        if (this.UNRECORDED.has(raw)) {
            return { kind: this.KIND.UNRECORDED, text: this.UNRECORDED_TEXT, raw };
        }

        // 🔴 THE JOIN, and it comes before every fallback below. If the manifest
        // is absent (a page that did not load it) we fall through rather than
        // throw — a Usage row is not worth a broken page — but we do NOT invent a
        // name in that case; an unjoined id lands in UNKNOWN_ID and is reported.
        const M = window.ProviderManifest;
        const named = M && typeof M.byId === 'function' ? M.byId(raw) : null;
        if (named && named.name) {
            return { kind: this.KIND.NAMED, text: String(named.name), raw };
        }

        if (Object.prototype.hasOwnProperty.call(this.DECLARED, raw)) {
            return { kind: this.KIND.DECLARED, text: this.DECLARED[raw], raw };
        }

        // A host: what `hostOf()` produces. Tested LAST of the positive branches
        // so a provider id that happens to contain a dot can never be mistaken
        // for a host — the manifest and the declared list get first refusal.
        if (this._looksLikeHost(raw)) {
            return { kind: this.KIND.SELF_HOSTED, text: raw, raw };
        }

        // Nothing recognised it. Show the raw id — it is the only information
        // there is, and hiding it would make the row less useful, not safer —
        // but mark it so the page can report the drift.
        return { kind: this.KIND.UNKNOWN_ID, text: raw, raw };
    },

    /**
     * `true` when a string is shaped like the host `hostOf()` returns.
     *
     * `hostOf()` builds it with `new URL(s).host`, so it is a hostname with an
     * optional `:port` and never contains a space, a slash or an `@`. A dot or a
     * colon is what separates it from a bare provider id like `elevenlabs`.
     *
     * ⚠️ Deliberately NOT a validator. Its only job is to tell an operator's
     * engine address apart from a provider id we failed to join, and both
     * outcomes show the same `raw` text — so a wrong answer here changes a label,
     * never a number.
     */
    _looksLikeHost(s) {
        if (/[\s/\\@]/.test(s)) return false;
        return s.includes('.') || s.includes(':');
    },

    /**
     * The LANE in household words.
     *
     * Mirrors `usage-store.js`'s `LANES` set — three declared strings, registered on
     * `JS_KOTLIN_CONTRACTS 201` with the provider literals, because the failure is the
     * same: a lane the server starts recording with no label here reaches the screen as
     * a store token.
     *
     * 🔴 `brain` → "AI" HERE, having been REFUSED in the provider column — and that is
     * not a contradiction. In the provider column `brain` was a lane name wearing a
     * provider's clothes, which claimed something untrue. In the LANE column it is the
     * lane, and "AI" is simply its household name. Same string, two positions, one
     * honest answer each.
     */
    LANE_LABELS: {
        brain: 'AI',
        stt: 'speech to text',
        tts: 'voice',
    },

    /**
     * Name one lane, or `null` when there is nothing honest to say.
     *
     * 🔴 Returns null for BOTH absent and `null` — the two states `usage-store.js`
     * distinguishes (not recorded yet vs. two lanes summed, unknowable). The page shows
     * nothing in either case rather than guessing, and NEVER infers the lane from the
     * provider or the units: inferring from units is circular, and inferring from the
     * provider stopped being a function the moment `gemini` began serving three lanes.
     */
    describeLane(lane) {
        if (typeof lane !== 'string' || !lane) return null;
        const label = this.LANE_LABELS[lane];
        if (label) return { kind: 'named', text: label, raw: lane };
        // A lane the server grew and this vocabulary does not know. Show it rather than
        // hide it, and let unknownLanes() report it.
        return { kind: this.KIND.UNKNOWN_ID, text: lane, raw: lane };
    },

    /** Lanes in a set of rows that this vocabulary cannot name. Loud, same reason as
     *  `unknownIds` and `UsageUnits.unknownKeys`. */
    unknownLanes(rows) {
        const list = Array.isArray(rows) ? rows : [];
        const out = [];
        for (const r of list) {
            const d = this.describeLane(r && r.lane);
            if (d && d.kind === this.KIND.UNKNOWN_ID && !out.includes(d.raw)) out.push(d.raw);
        }
        return out;
    },

    /**
     * The provider ids in a set of rows that nothing could name. Loud for the
     * same reason `UsageUnits.unknownKeys` is: a new id means the server grew a
     * provider and nothing told the view.
     *
     * 🔴 A HOST IS NOT DRIFT. Self-hosted engines are unbounded by design, so
     * they are excluded here — otherwise every household running Whisper on a NAS
     * would emit a warning for working correctly, and a warning that fires on
     * normal use is one nobody reads.
     */
    unknownIds(rows) {
        const list = Array.isArray(rows) ? rows : [];
        const out = [];
        for (const r of list) {
            const d = this.describe(r && r.provider);
            if (d.kind === this.KIND.UNKNOWN_ID && !out.includes(d.raw)) out.push(d.raw);
        }
        return out;
    },
};

window.UsageProviders = UsageProviders;
