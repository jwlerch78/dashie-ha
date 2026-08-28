/**
 * UsageSource — where a usage view gets its rows.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Usage has always come from Supabase (`get_usage_summary` / `get_usage_daily`),
 * which an ACCOUNT-LESS add-on box cannot reach: no account, no JWT, so
 * `ai_interactions` gets nothing at all. Those boxes do keep a record — the
 * add-on's own `/data/usage.json`, day-bucketed and metadata-only — and until
 * `GET /api/usage` landed it was written by two lanes and read by nobody.
 *
 * Same shape as `DevicesSource`, and for the same reason: one adapter answering
 * "where does this come from", rather than an `if (isLocalMode)` at each fetch
 * site. That precedent is on this ground and it is proven.
 *
 * ── 🔴 THE RULE INHERITED FROM DevicesSource, AND IT BINDS HARDER HERE ───────
 *
 * **Do not fake a field the local side cannot know.** The local store records
 * calls, errors and units per `provider|model|billing` per UTC day. It records
 * **no cost, no balance, and no per-turn rows** — there is no money on a BYOK
 * box and no per-turn record on any box. Synthesising a cost to make a
 * Supabase-shaped page render is how a metrics page starts lying, and this one
 * would be lying about money. `cost` is `null` and the local view omits the
 * cost/balance surfaces entirely rather than zeroing them.
 *
 * ── WHAT THE LOCAL RECORD DOES NOT COVER, SAID OUT LOUD ──────────────────────
 *
 * Only the STT and TTS lanes have capture points. **The LLM leg of a local turn
 * is not in this store** — it is recorded in Supabase or nowhere. A local usage
 * view that silently showed two lanes would read as "this is everything"; the
 * page says which lanes it covers. Closing that gap is the deferred B2 work,
 * not something to paper over here.
 */
const UsageSource = {

    /** Is this console running without an account (add-on, published, unauthed)? */
    _isLocal() {
        return typeof DashieAuth !== 'undefined' && DashieAuth.isLocalMode === true;
    },

    /** Lanes the box-local record actually has capture points for. */
    LOCAL_LANES: ['stt', 'tts'],

    /**
     * Fetch the box-local record.
     * @param {number} days how many day-buckets to ask for
     * @returns {Promise<{rows: Array, local: boolean, daysAvailable: number, retentionDays: number, error: string|null}>}
     *   `rows`: `{ day, provider, model, billing, calls, errors, units }`, newest day first.
     *   `daysServed` is the window the route actually served (retention-capped).
     *   `units` is whatever the store recorded for that key — the shape differs by
     *   lane (characters for TTS, seconds for STT), so it is passed through rather
     *   than flattened into a single fake "amount" column.
     */
    async fetchLocal(days = 30) {
        try {
            const res = await fetch(`api/usage?days=${encodeURIComponent(days)}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return {
                rows: this._flatten(data.days || {}),
                local: true,
                daysAvailable: Number(data.days_available) || 0,
                retentionDays: Number(data.retention_days) || 0,
                // 🔴 What the route ACTUALLY served, which is not always what we asked
                // for: it caps the window at the store's retention. Ask for 90 against a
                // 60-day retention and you get 60 — so a page that labels its window from
                // its own request states something false. Caught when row 80 moved the
                // default from 400 to 60 and the existing 90-day button silently began
                // lying. The caller must label from THIS, never from its own range.
                daysServed: Number(data.days_requested) || 0,
                error: null,
            };
        } catch (e) {
            // An empty record and an unreachable route are DIFFERENT answers and the
            // page says which — "no usage recorded yet" is a fact about the box,
            // "could not read the record" is a fact about the console. Collapsing
            // them would show a brand-new box the same screen as a broken one.
            console.warn('[UsageSource] local read failed:', e?.message || e);
            return { rows: [], local: true, daysAvailable: 0, retentionDays: 0, daysServed: 0, error: e?.message || String(e) };
        }
    },

    /** `{ day: { 'provider|model|billing': {calls,errors,…} } }` → flat rows, newest first. */
    _flatten(days) {
        const rows = [];
        for (const day of Object.keys(days).sort().reverse()) {
            const bucket = days[day] || {};
            for (const key of Object.keys(bucket)) {
                const [provider, model, billing] = String(key).split('|');
                const entry = bucket[key] || {};
                const { calls, errors, ...units } = entry;
                rows.push({
                    day,
                    provider: provider || 'unknown',
                    // '-' is the store's own "no model" sentinel, not a model named '-'.
                    model: model && model !== '-' ? model : null,
                    billing: billing || 'unknown',
                    calls: Number(calls) || 0,
                    errors: Number(errors) || 0,
                    units,
                });
            }
        }
        return rows;
    },

    /** Total calls/errors across rows — the only aggregate the local record supports. */
    totals(rows) {
        return (rows || []).reduce(
            (acc, r) => ({ calls: acc.calls + r.calls, errors: acc.errors + r.errors }),
            { calls: 0, errors: 0 }
        );
    },
};
