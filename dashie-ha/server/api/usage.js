// SPDX-License-Identifier: AGPL-3.0-only
// server/api/usage.js — the READ half of the box-local usage record.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
//
// `usage-store.js` has been writing `/data/usage.json` since the BYOK usage
// contract landed — day-bucketed, schema-versioned, 400-day retention, and
// deliberately metadata-only. `readUsage()` was exported and **called by nothing
// outside its own file**: no route, no page, no consumer. So the box has been
// accumulating a record nobody could see, which is the component-not-outcome
// shape rather than a missing feature. This is the missing reader.
//
// 🔴 It matters most for the ACCOUNT-LESS box. With no account there is no JWT
// and Supabase is unreachable, so `ai_interactions` gets nothing at all — this
// file is the ONLY usage record those households have, and until now it was
// invisible to them. Signed-in boxes keep reading the cloud one; this route is
// additive and turns nothing off.
//
// Ingress-protected (HA authenticates the user before the request reaches us),
// mirroring api/settings.js and api/transcripts.js. READ-ONLY by construction:
// there is no write route here and there must never be one — a record its own
// subject can rewrite is not a record (usage-store.js's own opening argument).

'use strict';

const express = require('express');
const { readUsage, RETENTION_DAYS, SCHEMA_VERSION } = require('../usage-store');

const router = express.Router();

/** Default window. The store holds up to RETENTION_DAYS, but shipping all of it
 *  on every page load is ~1 MB of JSON for a view that opens on "last 30 days".
 *  The response says what it covers, so the page never has to guess. */
const DEFAULT_DAYS = 30;
const MAX_DAYS = RETENTION_DAYS;

/**
 * GET /api/usage?days=N
 *   → { schema_version, retention_days, days_requested, days_available, days: { 'YYYY-MM-DD': { 'provider|model|billing': {calls,errors,…units} } } }
 *
 * `days=N` means "the last N CALENDAR days", not "the last N buckets" — see the
 * cutoff below for why those are not the same thing.
 *
 * `days_available` is the count in the STORE, not in this response: a page that
 * shows 30 days needs to know whether 400 exist, and computing that from a
 * truncated payload is impossible. Never 500s — an unreadable store reads as
 * empty upstream, and an empty record is a true answer for a box that has not
 * run a local turn yet.
 */
router.get('/', (req, res) => {
    const requested = Number.parseInt(req.query.days, 10);
    const days = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_DAYS) : DEFAULT_DAYS;

    const store = readUsage();
    const allKeys = Object.keys(store.days || {}).sort();      // 'YYYY-MM-DD' sorts lexically

    // 🔴 Filter by CALENDAR DATE, not by bucket count. `slice(-days)` looks
    // equivalent and is not: buckets only exist for days the box actually made a
    // call, so on a lightly-used box the last 30 BUCKETS can span a year — and the
    // page, which labels the window "the last 30 days", would then be stating
    // something false about data it was handed. Caught by driving a store with a
    // 45-day-old bucket through `?days=30` and seeing it come back.
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const kept = allKeys.filter((k) => k >= cutoff);

    const out = {};
    for (const k of kept) out[k] = store.days[k];

    res.json({
        schema_version: SCHEMA_VERSION,
        retention_days: RETENTION_DAYS,
        days_requested: days,
        days_available: allKeys.length,
        days: out,
    });
});

module.exports = router;
