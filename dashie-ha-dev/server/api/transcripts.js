// SPDX-License-Identifier: AGPL-3.0-only
// server/api/transcripts.js
// Console-facing read/clear proxy for HA-local voice transcripts.
//
// The Dashie integration (HA core) stores opted-in voice transcripts locally
// (.storage/dashie.voice_transcripts) and exposes them at HA's authed
// /api/dashie/voice/transcripts. The Console can't call that HA endpoint
// directly (no HA token in the browser), so we proxy through the add-on, which
// already holds the supervisor token via ha-client.
//
// Ingress-protected (HA authenticates the user before the request reaches us),
// mirroring api/settings.js.

const express = require('express');
const haClient = require('../ha-client');

const router = express.Router();

/** GET /api/transcripts?limit=N → { transcripts: [...] } (newest first).
 *  Empty list when HA/integration is unreachable — never 500s the Console. */
router.get('/', async (req, res) => {
    const limit = Number.parseInt(req.query.limit, 10) || 100;
    try {
        const data = await haClient.getTranscripts(limit);
        res.json(data || { transcripts: [] });
    } catch (e) {
        console.warn('[transcripts] read failed:', e.message);
        res.json({ transcripts: [] });
    }
});

/** DELETE /api/transcripts → clear all HA-local transcripts. */
router.delete('/', async (req, res) => {
    try {
        const data = await haClient.clearTranscripts();
        res.json(data || { cleared: 0 });
    } catch (e) {
        console.warn('[transcripts] clear failed:', e.message);
        res.status(502).json({ error: 'clear_failed', detail: e.message });
    }
});

module.exports = router;
