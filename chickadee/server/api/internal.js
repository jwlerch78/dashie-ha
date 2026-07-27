// api/internal.js — endpoints for the trusted in-HA caller (the Chickadee
// integration), reached over the hassio Docker network. Ported from the Dashie
// add-on's api/internal.js — this is the LAN-sharing lane: a Dashie tablet in
// kiosk mode gets household voice through the integration's /api/dashie/voice/*
// views, which proxy here.
//
// 🔐 Every call must carry X-Chickadee-Bridge-Secret (enforced from birth —
// no observe mode; same posture as /api/voice/converse). The account
// credential is only vended when the account holder has opted into household
// sharing (voice.householdSharing in user_settings — account-scoped, fails
// closed on any read error).

'use strict';

const express = require('express');
const auth = require('../auth');
const { getAccountVoiceConfig } = require('../account-config');
const bridgeAuth = require('../bridge-auth');
const { CLOUD } = require('../config');

const router = express.Router();

// Bridge-secret gate on every internal route. checkAuth sends the 401 itself.
router.use((req, res, next) => {
    if (bridgeAuth.checkAuth(req, res, (r, s, b) => r.status(s).json(b))) next();
});

async function readSharing() {
    // Fail CLOSED — never share on a config read error.
    try {
        const cfg = await getAccountVoiceConfig();
        return cfg.householdSharing === true;
    } catch (e) {
        return false;
    }
}

/**
 * GET /api/internal/sharing-status
 * Capability probe: signed in AND household sharing on? Never returns the
 * credential. account_email is vended only when sharing is actually available.
 */
router.get('/sharing-status', async (req, res) => {
    const stored = auth.readStoredJwt();
    const signedIn = !!stored;
    const sharing = signedIn ? await readSharing() : false;
    const available = signedIn && sharing;
    return res.json({
        available,
        signed_in: signedIn,
        household_sharing: sharing,
        reason: available ? 'ok' : (!signedIn ? 'add_on_not_signed_in' : 'sharing_disabled'),
        ...(available && stored.userEmail ? { account_email: stored.userEmail } : {}),
    });
});

/**
 * GET /api/internal/account-credential
 * The account JWT for cloud edge-function calls on the account's behalf.
 * Gated on the household-sharing opt-in.
 */
router.get('/account-credential', async (req, res) => {
    if (!(await readSharing())) {
        return res.status(403).json({
            error: 'sharing_disabled',
            message: 'Household cloud sharing is turned off for this account.',
        });
    }
    try {
        const stored = await auth.getValidJwt();
        return res.json({
            jwt: stored.jwt,
            user_id: stored.userId,
            jwt_expires_at: stored.expiry ? new Date(stored.expiry).toISOString() : null,
        });
    } catch (e) {
        return res.status(401).json({ error: 'not_authenticated', message: e.message });
    }
});

/**
 * POST /api/internal/authorize-device   { user_code }
 * Kiosk Real Login: silently authorize a LAN kiosk's pending device code into
 * the household account via jwt-auth `authorize_device_code_account`. The
 * session token never passes through here — the device polls for its own JWT.
 * Sharing-gated here (fail closed) AND authoritatively server-side; jwt-auth
 * restricts the op to device_type='ha_kiosk'.
 */
router.post('/authorize-device', express.json(), async (req, res) => {
    const userCode = (req.body && (req.body.user_code || req.body.device_code)) || '';
    if (!userCode) {
        return res.status(400).json({ error: 'missing_user_code', message: 'user_code is required' });
    }
    if (!(await readSharing())) {
        console.warn('[authorize-device] DENIED — household sharing is off');
        return res.status(403).json({
            error: 'sharing_disabled',
            message: 'Household cloud sharing is turned off for this account.',
        });
    }
    let stored;
    try {
        stored = await auth.getValidJwt();
    } catch (e) {
        return res.status(401).json({ error: 'not_authenticated', message: e.message });
    }
    try {
        const resp = await fetch(`${CLOUD.url}/functions/v1/jwt-auth`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: CLOUD.anonKey,
                Authorization: `Bearer ${stored.jwt}`,
            },
            body: JSON.stringify({
                operation: 'authorize_device_code_account',
                data: { device_code: userCode },
            }),
        });
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok || body?.success !== true) {
            console.warn(`[authorize-device] jwt-auth refused (${resp.status}): ${body?.error || 'unknown'}`);
            return res.status(resp.status === 200 ? 400 : resp.status).json({
                error: body?.error || 'authorize_failed',
                message: body?.message || 'Could not authorize the device.',
            });
        }
        // A silent, human-free provisioning must never be an INVISIBLE one.
        console.log(`[authorize-device] ✅ kiosk code ${userCode} authorized for ${stored.userId} — the device will poll for its own session`);
        return res.json({ success: true, account_email: stored.userEmail || null });
    } catch (e) {
        console.error('[authorize-device] failed:', e?.message || e);
        return res.status(502).json({ error: 'upstream_failed', message: 'Could not reach the cloud to authorize this device.' });
    }
});

/**
 * GET /api/internal/voice-config
 * The account's voice route + kiosk mirror block. Same wire shape as the
 * Dashie add-on's — the integration forwards it on /api/dashie/voice/status.
 * Route semantics here: account-config's resolveBrainRoute (ai.model + the
 * box's BYO key store). The add-on's Configuration-tab llm_url is the ASSIST
 * lane's brain and does not flip this route.
 */
router.get('/voice-config', async (req, res) => {
    try {
        const cfg = await getAccountVoiceConfig();
        return res.json({
            route: cfg.route,
            route_reason: cfg.routeReason || (cfg.route === 'local' ? 'local_model' : 'cloud'),
            model_is_local: cfg.route === 'local',
            agent_mode: cfg.agentMode || '',
            ...(typeof cfg.retrievePictures === 'boolean' ? { retrieve_pictures: cfg.retrievePictures } : {}),
            default_personality_id: cfg.defaultPersonalityId || '',
            default_voice_key: cfg.defaultVoiceKey || '',
            default_wake_word: cfg.defaultWakeWord || '',
            model: cfg.model || '',
            // OMITTED (not {}) when the account read failed — the kiosk applier
            // hard-applies any boolean present in the block (audit 2026-07-13, #4).
            ...(cfg.pipeline ? { pipeline: cfg.pipeline } : {}),
        });
    } catch (e) {
        // Never block the gateway on this — default to cloud.
        return res.json({ route: 'cloud', model_is_local: false, agent_mode: '' });
    }
});

module.exports = router;
