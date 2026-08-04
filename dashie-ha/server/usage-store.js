// SPDX-License-Identifier: AGPL-3.0-only
// server/usage-store.js — the box-local BYOK usage record.
//
// Implements Thread D's contract (`20260804_BYOK_USAGE_RECORDING_CONTRACT.md`)
// §3–§5. One function — `recordLocalUsage()` — called from each lane's single
// choke point. This OBSERVES; it never gates. If implementing something here
// appeared to need the lease, the spend gate or `capability.js`, that would be
// the signal the design is wrong (D's §8), not a reason to widen this file.
//
// ── WHY ITS OWN FILE, AND NOT THE SETTINGS BLOB ──────────────────────────────
//
// 🔴 This is the distinction a later reader is most likely to get backwards,
// because the two call sites look identical.
//
//   CONFIG (personalities, engine choices) → the settings blob is CORRECT.
//     `PATCH /api/settings/local` deep-merges an arbitrary nested partial and is
//     deliberately unauthenticated beyond Ingress. Panel-writable is the INTENT.
//
//   OBSERVATION (this file) → the settings blob is WRONG.
//     The same missing key whitelist means anything that can reach the panel
//     could rewrite the record — and a record its own subject can rewrite is not
//     a record.
//
// Same store, opposite verdicts. The precedent for "its own file beside
// settings" already exists: `key-store.js` → `api-keys.json`.
//
// Deliberately NOT mode 600 / backup-excluded. Those are `key-store`'s because
// it holds secrets; per D's §6 this holds no text, no ids and no keys, and it is
// the ONLY copy of this data — which argues for letting it be backed up.
//
// ── WHAT IS NEVER RECORDED (D §6) ────────────────────────────────────────────
// No prompt or response text · no session/device/user ids · no keys or key
// fingerprints. The sink takes a NARROW object rather than a pass-through of the
// brain's LogData precisely so text cannot arrive here by accident.

'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const USAGE_FILE = path.join(DATA_DIR, 'usage.json');

/** Bumped whenever the stored shape changes. An unknown version reads as EMPTY
 *  rather than being coerced — the standing rule for any cached structure whose
 *  shape can change (CLAUDE.md, the LAYOUT_SCHEMA_VERSION pattern). */
const SCHEMA_VERSION = 1;

/**
 * 🔴 Retention: 400 days, pruned on write — and the reason is NOT disk.
 *
 * D did the arithmetic: ~20 keys/day × ~110 bytes ≈ 2 kB/day ≈ 800 kB/year, so
 * a decade is ~8 MB and a rolling delete would be pure ceremony as a STORAGE
 * decision. The binding constraint is the read-modify-write cost: this whole
 * file is parsed and re-serialised on EVERY recorded call, so an 8 MB JSON is a
 * latency problem on the voice path long before it is a disk problem. 400 days
 * (a year plus slack for year-over-year comparison) keeps the hot file ≈1 MB.
 *
 * ⭐ Contrast with the ingest bucket, where the samples ARE the asset and the
 * fix was to bound the INFLOW instead. Same "unbounded growth" symptom, opposite
 * correct treatment — which is why the two were decided together.
 */
const RETENTION_DAYS = 400;

const LANES = new Set(['brain', 'stt', 'tts']);
const BILLINGS = new Set(['byok', 'metered', 'free']);

/** The one unit each lane is summarised BY in the log marker. The stored entry
 *  keeps every unit it was given; this is only what `USAGE:` reports, so a
 *  single grep of one lane yields one comparable number. */
const MARKER_UNIT = {
    tts: ['chars', 'characters'],
    // 🔴 BYTES, not seconds, and deliberately so. Providers bill STT in seconds,
    // but the lane only has `seconds` when a canonical WAV header yielded one —
    // it is OPTIONAL by design (D §8c.2: a wrong seconds is worse than a missing
    // one). A marker whose number is sometimes absent cannot be grepped and
    // summed, so the marker reports the unit that is ALWAYS there. `seconds`
    // still lands in the store whenever it was derived.
    stt: ['bytes', 'bytes'],
    brain: ['tokens', 'total_tokens'],
};

/** Unit fields the store will sum. Anything else is dropped rather than stored —
 *  an unrecognised unit is far more likely to be a typo than a new quantity, and
 *  a silently-created column is unaggregatable later. */
const UNIT_FIELDS = new Set([
    'input_tokens', 'output_tokens', 'total_tokens', 'seconds', 'characters',
    // STT records bytes ALWAYS and seconds only when a real WAV header derived
    // it, so a row may legitimately carry bytes with no seconds. The view must
    // not read a missing `seconds` as zero usage.
    'bytes',
]);

/** UTC day bucket. Stored in UTC so a box that moves timezone neither
 *  double-counts nor gaps; the view renders in local time. */
function utcDay(at) {
    const d = at instanceof Date ? at : new Date(typeof at === 'number' ? at : Date.now());
    if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
    return d.toISOString().slice(0, 10);
}

/** Read the store. Never throws. An unreadable or unknown-version file reads as
 *  empty — see SCHEMA_VERSION. */
function readUsage() {
    try {
        if (!fs.existsSync(USAGE_FILE)) return { schema_version: SCHEMA_VERSION, days: {} };
        const data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
        if (!data || data.schema_version !== SCHEMA_VERSION) {
            return { schema_version: SCHEMA_VERSION, days: {} };
        }
        return { schema_version: SCHEMA_VERSION, days: (data.days && typeof data.days === 'object') ? data.days : {} };
    } catch (e) {
        console.warn(`DROP: usage-local-read-failed — ${e.message}`);
        return { schema_version: SCHEMA_VERSION, days: {} };
    }
}

/** Drop day buckets older than RETENTION_DAYS before `today`. Mutates `days`. */
function prune(days, today) {
    const cutoff = new Date(`${today}T00:00:00Z`).getTime() - RETENTION_DAYS * 86400000;
    if (!Number.isFinite(cutoff)) return 0;
    let dropped = 0;
    for (const day of Object.keys(days)) {
        const t = new Date(`${day}T00:00:00Z`).getTime();
        // An unparseable key is a corrupted bucket, not a young one — drop it.
        if (!Number.isFinite(t) || t < cutoff) { delete days[day]; dropped++; }
    }
    return dropped;
}

/**
 * Record ONE provider call. Returns nothing and NEVER throws — fail-soft like
 * every recorder in this codebase.
 *
 * 🔴 Call this REGARDLESS of whether an account token exists (D §2). The cloud
 * logger returns early on `!token`; inheriting that condition would mean a box
 * that later links an account silently stops keeping its own record, and the
 * Usage view gains a gap exactly at the transition — invisibly, because both
 * halves still appear to work. The two sinks are independent.
 *
 * ── The two markers, and why only ONE of them can fire ───────────────────────
 *
 *   `USAGE: …`                     emitted AFTER the write succeeds.
 *   `DROP: usage-local-write-failed` emitted INSTEAD when it does not.
 *
 * Deliberate: a `USAGE:` line means "a row exists for this call". Emitting it on
 * a failed write would make the marker claim a record that is not there — and
 * the marker's whole value is that one grep counts recorded calls. The invariant
 * the control asserts is therefore exact: **one recorded call ⇒ exactly one
 * `USAGE:` line.**
 */
function recordLocalUsage(u) {
    try {
        const lane = String(u?.lane || '');
        const billing = String(u?.billing || '');
        if (!LANES.has(lane)) { console.warn(`DROP: usage-local-bad-lane lane=${lane || '(none)'}`); return; }
        if (!BILLINGS.has(billing)) { console.warn(`DROP: usage-local-bad-billing lane=${lane} billing=${billing || '(none)'}`); return; }

        const provider = String(u.provider || 'unknown');
        const model = u.model ? String(u.model) : '-';
        const success = u.success !== false;
        const day = utcDay(u.at);
        const key = `${provider}|${model}|${billing}`;

        const store = readUsage();
        const days = store.days;
        const bucket = (days[day] = days[day] || {});
        const entry = (bucket[key] = bucket[key] || { calls: 0, errors: 0 });

        entry.calls += 1;
        if (!success) entry.errors += 1;

        // 🔴 Units are summed ONLY on success. A 401 from a provider synthesised
        // nothing and was billed nothing; adding its character count would
        // inflate a number the user will compare against a real invoice.
        if (success && u.units && typeof u.units === 'object') {
            for (const [field, value] of Object.entries(u.units)) {
                if (!UNIT_FIELDS.has(field)) {
                    console.warn(`DROP: usage-local-unknown-unit lane=${lane} field=${field}`);
                    continue;
                }
                const n = Number(value);
                if (!Number.isFinite(n) || n < 0) continue;
                entry[field] = +( (entry[field] || 0) + n ).toFixed(3);
            }
        }

        prune(days, day);

        const tmp = USAGE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ schema_version: SCHEMA_VERSION, days }, null, 2));
        fs.renameSync(tmp, USAGE_FILE);

        const [unitName, unitField] = MARKER_UNIT[lane];
        const n = success ? Number(u.units?.[unitField] || 0) : 0;
        console.log(`USAGE: lane=${lane} provider=${provider} units=${unitName} n=${n} billing=${billing} ok=${success ? 1 : 0}`);
    } catch (e) {
        // ⚠️ Per the s53 lesson, an unread marker is the same as no marker. This
        // one's reader ships in the same change: `scripts/check-byok-tts.mjs`
        // drives an unwritable store and asserts this line appears and no
        // `USAGE:` line does.
        console.warn(`DROP: usage-local-write-failed — ${e?.message || e}`);
    }
}

module.exports = {
    SCHEMA_VERSION, RETENTION_DAYS, USAGE_FILE,
    readUsage, recordLocalUsage,
};
