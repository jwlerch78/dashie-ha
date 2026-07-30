// SPDX-License-Identifier: AGPL-3.0-only
// api/settings.js — console-facing read/write for add-on-local settings.
//
// Ingress-protected (HA authenticates the user first); writes additionally
// require the add-on to be signed in. Simplified port of the dashie add-on's
// api/settings.js — householdSharing resolves from the ACCOUNT
// (voice.householdSharing in user_settings).
//
// ⚠️ The refresh_voice_config push is NOT optional. It was dropped in the 0.5.0
// Express port on the premise that "the chickadee integration has no such
// service (nothing caches the account credential downstream)" — true about the
// integration, wrong about who the consumer is. The consumer is each WALL
// TABLET: the service relays to the device's :2323 `refreshVoiceConfig`, which
// runs KioskJwtRefresher.verifySessionNow(). Without it a kiosk only learns its
// session was revoked at the 24h liveness safety net. Field report 2026-07-29:
// sharing turned off, tablets stayed signed in.

'use strict';

const express = require('express');
const auth = require('../auth');
const settingsStore = require('../settings-store');
const accountConfig = require('../account-config');
const supervisor = require('../supervisor');

const router = express.Router();

function requireSignedIn(req, res, next) {
    if (!auth.readStoredJwt()) {
        return res.status(401).json({ error: 'add_on_not_signed_in' });
    }
    next();
}

/** GET /api/settings → add-on-local settings, householdSharing from the account. */
router.get('/', async (req, res) => {
    let householdSharing = false;
    try {
        const cfg = await accountConfig.getAccountVoiceConfig();
        householdSharing = cfg.householdSharing === true;
    } catch (e) { /* fail closed */ }
    res.json({ ...settingsStore.readSettings(), householdSharing });
});

/**
 * PUT /api/settings/household-sharing  { enabled: bool }
 * The CONSOLE writes voice.householdSharing to user_settings itself — this
 * endpoint just makes the change take effect immediately by dropping the
 * cached account config (30s TTL).
 */
router.put('/household-sharing', requireSignedIn, express.json(), async (req, res) => {
    const enabled = req.body?.enabled === true;
    accountConfig.invalidate();
    console.log(`[settings] household-sharing → ${enabled} (account-scoped; cache invalidated)`);
    // Fast path: tell every kiosk to re-verify its session NOW. Best-effort and
    // fire-and-forget — the setting itself is already written by the console.
    supervisor.callService('dashie', 'refresh_voice_config', {}).then(ok => {
        if (ok) console.log('[settings] pushed refresh_voice_config to kiosks');
    });
    let householdSharing = enabled;
    try {
        const cfg = await accountConfig.getAccountVoiceConfig();
        householdSharing = cfg.householdSharing === true;
    } catch (e) { /* fall back to the requested value */ }
    res.json({ householdSharing });
});

module.exports = router;
