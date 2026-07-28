// SPDX-License-Identifier: AGPL-3.0-only
// api/settings.js — console-facing read/write for add-on-local settings.
//
// Ingress-protected (HA authenticates the user first); writes additionally
// require the add-on to be signed in. Simplified port of the dashie add-on's
// api/settings.js — householdSharing resolves from the ACCOUNT
// (voice.householdSharing in user_settings), and the dashie version's
// refresh_voice_config service push is dropped: the chickadee integration
// has no such service (nothing caches the account credential downstream).

'use strict';

const express = require('express');
const auth = require('../auth');
const settingsStore = require('../settings-store');
const accountConfig = require('../account-config');

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
    let householdSharing = enabled;
    try {
        const cfg = await accountConfig.getAccountVoiceConfig();
        householdSharing = cfg.householdSharing === true;
    } catch (e) { /* fall back to the requested value */ }
    res.json({ householdSharing });
});

module.exports = router;
