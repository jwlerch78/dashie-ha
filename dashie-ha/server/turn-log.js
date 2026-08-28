// SPDX-License-Identifier: AGPL-3.0-only
// server/turn-log.js — the box-local PER-TURN history (B2b, row 80).
//
// ── WHY A SECOND STORE AND NOT A BIGGER usage.json ──────────────────────────
//
// `usage-store.js` is day-bucketed aggregates and it re-serialises the WHOLE
// file on every recorded call. That is a deliberate choice and its 60-day
// retention is tied to it: aggregates are bounded by the number of distinct
// `provider|model|billing` keys, so a busy household costs the same as a quiet
// one. **Per-turn rows scale with USAGE instead** — ~200 turns/day × ~150 B is
// ~11 MB/year — and re-serialising that on the voice path is a latency problem,
// not a disk one. So this is an APPEND-ONLY log beside the buckets, never a
// bigger bucket file.
//
// ── 🔴 THE TWO ARTIFACTS DO NOT SHARE A POLICY, AND THAT IS THE POINT ───────
//
// The aggregate answers "how much did we use this year" and is cheap to keep.
// This file answers "what happened recently" and is a **presence record**: a
// timestamped sequence of voice interactions says when the house is awake, when
// it is empty, when someone got up at 3am. Nobody analyses turn-level detail
// from fourteen months ago, so it keeps a much shorter window (30 days), and it
// is DELETABLE without losing anything the Usage page shows — because the
// aggregate is written independently and survives.
//
// That independence is what makes John's ruling safe to implement literally:
// "toggling off deletes history" deletes THIS file and nothing else.
//
// ── 🔴 AND IT IS BACKUP-EXCLUDED, IN THE SAME CHANGE THAT CREATES IT ────────
//
// `usage-store.js` argues, correctly, that IT should be backed up: "per D §6
// this holds no text, no ids and no keys". That reasoning does not extend here
// and B2b is exactly the change that breaks it — a per-turn log is the thing
// that argument was assuming did not exist. `/data` rides into HA's add-on
// backups, including ones uploaded to cloud backup targets, so this file is
// listed in `backup_exclude` in BOTH channel `config.yaml`s in the same commit
// as the first write. Not the next commit: a per-turn log that exists for one
// release without that line is a household occupancy record sitting in whatever
// cloud the user pointed Home Assistant backups at.
//
// ── WHAT IS STILL NEVER RECORDED ───────────────────────────────────────────
// No prompt or response text. No user id. Same narrow-object discipline as
// `usage-store` — the sink names its fields and never spreads a caller's object.

'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const TURNS_FILE = path.join(DATA_DIR, 'turns.jsonl');

/** Bumped when the row shape changes. A row with an unknown version is skipped
 *  on read rather than coerced — same rule as usage-store's SCHEMA_VERSION. */
const SCHEMA_VERSION = 1;

/**
 * 🔴 30 days, deliberately SHORTER than the aggregate's 60 — see the header.
 * This is a presence record; the aggregate is a counter. They are different
 * artifacts and a shared retention would be a coincidence, not a decision.
 *
 * ⚠️ NOT a setting, deliberately: row 80 ruled "for now just change default"
 * for the aggregate's window, and shipping half a settings surface here would
 * be worse than shipping none. When retention becomes a setting it covers both.
 */
const RETENTION_DAYS = 30;

/** Rewrite-on-prune threshold. The log is append-only in the hot path; pruning
 *  is the one operation that rewrites it, and doing that per-append would give
 *  back exactly the read-modify-write cost this file exists to avoid. */
const PRUNE_EVERY = 200;
let _appendsSincePrune = 0;

const LANES = new Set(['brain', 'stt', 'tts']);

/** True when this box is recording per-turn history.
 *
 *  🔴 The gate is an ON-BOX setting, and that is a correction to the original
 *  plan rather than a preference. The console's existing "record history" toggle
 *  writes `user_settings.retain_transcripts` — a SUPABASE column, reachable only
 *  with an account. On an account-less box it cannot be read or written and
 *  resolves false server-side, so gating this store on it would have produced a
 *  store that records nothing on exactly the boxes it exists for.
 *
 *  The account value may SEED this, never BE it: when the local key is absent
 *  and an account exists, the account's choice is honoured. That is a read-time
 *  fallback, not a mirrored write — there is one source of truth per box and no
 *  second copy to drift.
 */
function isRecordingEnabled(localSettings, accountRetain) {
    const v = localSettings?.ai?.recordHistory;
    if (typeof v === 'boolean') return v;
    // Absent → follow the account if there is one. No account, no key → OFF.
    // Opt-in is the honest default for a presence record.
    return accountRetain === true;
}

/** Append one turn row. Never throws — an observer must not break a turn. */
function recordTurn(t) {
    try {
        const lane = String(t?.lane || '');
        if (!LANES.has(lane)) { console.warn(`DROP: turn-log-bad-lane lane=${lane || '(none)'}`); return; }

        // Named fields only — never a spread of a caller's object. The brain's
        // payload carries session_id/endpoint_id/request_length and this store
        // holds no ids; usage-store's sink takes a narrow object for the same
        // reason and this one inherits the discipline rather than re-deciding it.
        const row = {
            v: SCHEMA_VERSION,
            at: new Date(typeof t.at === 'number' ? t.at : Date.now()).toISOString(),
            lane,
            provider: String(t.provider || 'unknown'),
            model: t.model ? String(t.model) : '',
            billing: String(t.billing || ''),
            success: t.success !== false,
            units: {},
            latency_ms: Number.isFinite(Number(t.latency_ms)) ? Number(t.latency_ms) : null,
        };
        if (t.units && typeof t.units === 'object') {
            for (const [k, val] of Object.entries(t.units)) {
                const n = Number(val);
                if (Number.isFinite(n) && n >= 0) row.units[k] = n;
            }
        }

        fs.appendFileSync(TURNS_FILE, JSON.stringify(row) + '\n');
        console.log(`TURN: lane=${row.lane} provider=${row.provider} ok=${row.success ? 1 : 0}`);

        if (++_appendsSincePrune >= PRUNE_EVERY) { _appendsSincePrune = 0; prune(); }
    } catch (e) {
        // ⚠️ An unread marker is the same as no marker; this one's reader ships in
        // the same change (scripts/check-turn-log.mjs drives an unwritable store).
        console.warn(`DROP: turn-log-write-failed — ${e?.message || e}`);
    }
}

/** Read rows newest-first, optionally limited. Never throws; a malformed line is
 *  skipped rather than failing the whole read — an append-only log's last line
 *  can be torn by a power cut and one bad row must not hide the other 5,000. */
function readTurns(limit = 500) {
    try {
        if (!fs.existsSync(TURNS_FILE)) return [];
        const lines = fs.readFileSync(TURNS_FILE, 'utf8').split('\n');
        const out = [];
        for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
            const line = lines[i].trim();
            if (!line) continue;
            try {
                const row = JSON.parse(line);
                if (row && row.v === SCHEMA_VERSION) out.push(row);
            } catch { /* torn or foreign line — skip it, keep reading */ }
        }
        return out;
    } catch (e) {
        console.warn(`DROP: turn-log-read-failed — ${e.message}`);
        return [];
    }
}

/** Drop rows older than RETENTION_DAYS. Rewrites the file; called on a counter,
 *  not per append. Never throws. */
function prune() {
    try {
        if (!fs.existsSync(TURNS_FILE)) return 0;
        const cutoff = Date.now() - RETENTION_DAYS * 86400000;
        const lines = fs.readFileSync(TURNS_FILE, 'utf8').split('\n');
        const kept = [];
        let dropped = 0;
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const row = JSON.parse(line);
                const t = Date.parse(row?.at);
                // An unparseable row is a corrupted line, not a young one — drop it.
                if (Number.isFinite(t) && t >= cutoff) kept.push(line); else dropped++;
            } catch { dropped++; }
        }
        if (dropped > 0) {
            const tmp = TURNS_FILE + '.tmp';
            fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '');
            fs.renameSync(tmp, TURNS_FILE);
            console.log(`TURN: pruned=${dropped} kept=${kept.length}`);
        }
        return dropped;
    } catch (e) {
        console.warn(`DROP: turn-log-prune-failed — ${e?.message || e}`);
        return 0;
    }
}

/**
 * Delete the per-turn history. This is what "toggling off deletes history"
 * means, and its SCOPE is the point: it removes THIS file only. The day-bucket
 * counters in `usage.json` are a different artifact and survive — so the Usage
 * page keeps showing how much the box has used while the record of WHEN each
 * turn happened is gone. Returns the number of rows removed, for the confirm
 * dialog's own honesty.
 */
function clearTurns() {
    try {
        if (!fs.existsSync(TURNS_FILE)) return 0;
        const n = readTurns(Number.MAX_SAFE_INTEGER).length;
        fs.unlinkSync(TURNS_FILE);
        _appendsSincePrune = 0;
        console.log(`TURN: cleared rows=${n}`);
        return n;
    } catch (e) {
        console.warn(`DROP: turn-log-clear-failed — ${e?.message || e}`);
        return 0;
    }
}

/**
 * Resolve the gate for THIS box and record the turn if it is on.
 *
 * 🔴 ONE HOLDER, and it resolves the gate ITSELF rather than taking it as an
 * argument. Three lanes call this. If each passed its own inputs, that would be
 * three copies of a rule with a local key, an account fallback and a default —
 * and the failure mode of a missed copy is a lane that silently never records,
 * which looks exactly like a quiet box. A lane says WHAT happened; this file
 * alone decides WHETHER it is kept.
 *
 * ⚠️ Fire-and-forget by construction. The account fallback is an async read
 * (cached, but still a promise) and an observer must never put a promise on the
 * voice path. `at` is therefore stamped HERE, synchronously, before deferring —
 * dating a row by however long the deferral took would make a presence record
 * that is approximately right, which is worse than one that admits it has none.
 *
 * Never throws. Returns nothing: callers must not branch on whether recording
 * happened, or the gate becomes a thing three lanes reason about again.
 */
function recordTurnIfEnabled(t) {
    const at = Number.isFinite(Number(t?.at)) ? Number(t.at) : Date.now();
    Promise.resolve()
        .then(async () => {
            let localSettings;
            try { localSettings = require('./settings-store').readUserSettings(); }
            catch { localSettings = null; }

            // The account value SEEDS the local key when the key is absent; it never
            // replaces it. Read lazily so a box with the local key set explicitly
            // never pays for an account round trip it cannot use.
            let accountRetain;
            if (typeof localSettings?.ai?.recordHistory !== 'boolean') {
                try { accountRetain = (await require('./account-config').getAccountVoiceConfig()).retainTranscripts === true; }
                catch { accountRetain = undefined; }
            }

            if (!isRecordingEnabled(localSettings, accountRetain)) return;
            recordTurn({ ...t, at });
        })
        .catch((e) => { console.warn(`DROP: turn-log-gate-failed — ${e?.message || e}`); });
}

module.exports = {
    SCHEMA_VERSION, RETENTION_DAYS, TURNS_FILE,
    isRecordingEnabled, recordTurn, recordTurnIfEnabled, readTurns, prune, clearTurns,
};
