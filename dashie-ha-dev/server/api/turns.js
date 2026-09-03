// SPDX-License-Identifier: AGPL-3.0-only
// server/api/turns.js — read and CLEAR the box-local per-turn history (B2b).
//
// ── 🔴 WHY THIS IS A SEPARATE ROUTER FROM api/usage.js ──────────────────────
//
// `api/usage.js` serves the day-bucket aggregate and is read-only BY RULE — it
// has no write verb and must never grow one, because `usage-store.js` argues in
// its own header that a record its own subject can rewrite is not a record.
// (`lint:usage-surface` leg 6 enforces exactly that.)
//
// This router has a DELETE, because John ruled that toggling record-history off
// deletes the history. Putting it here rather than widening the usage router is
// what keeps both statements true at once — and it makes the ruling's SCOPE
// structural rather than a matter of care: the amendment says deletion is of the
// per-turn store, NOT the aggregate counters, and there is now no route that
// could delete the counters even by mistake.
//
// Ingress-protected, like every other console-facing route here.

'use strict';

const express = require('express');
const turnLog = require('../turn-log');

const router = express.Router();

/** GET /api/turns?limit=N → { schema_version, retention_days, turns: [...] } newest first. */
router.get('/', (req, res) => {
    const n = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 2000) : 500;
    res.json({
        schema_version: turnLog.SCHEMA_VERSION,
        retention_days: turnLog.RETENTION_DAYS,
        turns: turnLog.readTurns(limit),
    });
});

/**
 * DELETE /api/turns → { cleared: N }
 *
 * The console calls this after its own confirmation dialog. Returns the row
 * count so the caller can say what actually happened rather than "done" —
 * a delete that silently removed nothing looks identical to one that worked.
 */
router.delete('/', (req, res) => {
    const cleared = turnLog.clearTurns();
    res.json({ cleared });
});

module.exports = router;
