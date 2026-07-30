// SPDX-License-Identifier: AGPL-3.0-only
// api/console-auth.js — auth endpoints for the Chickadee console SPA.
//
// Merge of the dashie add-on's api/auth.js (the SPA's add-on-mode contract:
// status/jwt/start-link/poll-link/cancel-link/sign-out) with the Chickadee
// panel's email/password endpoints (email-signin/email-signup — kept at their
// 0.4.0 paths). Reachable only via HA Ingress + the hassio container network
// (ports:{} — no LAN exposure); HA authenticates the user before the request
// reaches us, so these are deliberately not bridge-secret-gated.

'use strict';

const express = require('express');
const auth = require('../auth');
const { CLOUD, CLOUD_ENV } = require('../config');

const router = express.Router();

// One active device-flow link attempt per add-on instance.
let pendingLink = null;   // { device_code, user_code, verification_url, expires_at, interval }

/**
 * GET /api/auth/status — auth state + Supabase target. The SPA captures
 * supabase_url/anon_key even when signed out (console-auth._initAddonMode)
 * so its edge-function calls hit the right project.
 */
router.get('/status', (req, res) => {
    const stored = auth.readStoredJwt();
    const base = {
        supabase_env: CLOUD_ENV,
        supabase_url: CLOUD.url,
        supabase_anon_key: CLOUD.anonKey,
    };
    if (!stored) return res.json({ authenticated: false, ...base });
    return res.json({
        authenticated: true,
        user_id: stored.userId,
        user_email: stored.userEmail,
        user_name: stored.userName || null,
        user_picture: stored.userPicture || null,
        jwt_expires_at: stored.expiry ? new Date(stored.expiry).toISOString() : null,
        ...base,
    });
});

/**
 * GET /api/auth/jwt — the stored JWT (refreshed when near expiry) so the SPA
 * can call Supabase directly.
 */
router.get('/jwt', async (req, res) => {
    try {
        const stored = await auth.getValidJwt();
        return res.json({
            jwt: stored.jwt,
            user_id: stored.userId,
            user_email: stored.userEmail,
            user_name: stored.userName || null,
            user_picture: stored.userPicture || null,
            jwt_expires_at: stored.expiry ? new Date(stored.expiry).toISOString() : null,
        });
    } catch (e) {
        return res.status(401).json({ error: 'not_authenticated', message: e.message });
    }
});

/** POST /api/auth/start-link — begin the device flow (Google path). */
router.post('/start-link', async (req, res) => {
    try {
        const link = await auth.createDeviceCode();
        pendingLink = { ...link, expires_at: Date.now() + link.expires_in * 1000 };
        console.log(`[auth] sign-in started — code ${link.user_code}, approve at ${link.verification_url}`);
        return res.json({
            user_code: link.user_code,
            verification_url: link.verification_url,
            expires_at: new Date(pendingLink.expires_at).toISOString(),
            interval: link.interval,
        });
    } catch (e) {
        console.error('[auth] start-link failed:', e.message);
        return res.status(500).json({ error: 'start_link_failed', message: e.message });
    }
});

/** POST /api/auth/poll-link → { status: pending|authorized|expired|none }. */
router.post('/poll-link', async (req, res) => {
    if (!pendingLink) return res.json({ status: 'none' });
    if (Date.now() >= pendingLink.expires_at) {
        pendingLink = null;
        return res.json({ status: 'expired' });
    }
    try {
        const result = await auth.pollDeviceCode(pendingLink.device_code);
        if (result.status === 'authorized') {
            pendingLink = null;
            const stored = auth.readStoredJwt() || {};
            return res.json({
                status: 'authorized',
                user_id: stored.userId,
                user_email: stored.userEmail,
                user_name: stored.userName || null,
                user_picture: stored.userPicture || null,
            });
        }
        if (result.status === 'expired') pendingLink = null;
        return res.json({ status: result.status === 'expired' ? 'expired' : 'pending' });
    } catch (e) {
        console.warn('[auth] poll failed (treating as pending):', e.message);
        return res.json({ status: 'pending' });
    }
});

/** POST /api/auth/cancel-link — drop the pending device code. */
router.post('/cancel-link', (req, res) => {
    pendingLink = null;
    res.json({ success: true });
});

/** POST /api/auth/sign-out — clear the stored credential. */
router.post('/sign-out', (req, res) => {
    auth.clearStoredJwt();
    pendingLink = null;
    console.log('[auth] signed out (credential cleared)');
    return res.json({ success: true, ok: true });
});

// ── Email/password (0.4.0 contract, kept verbatim) ────────────────────────────

function cleanCreds(body) {
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
    if (!email || !password) return null;
    return { email, password, name };
}

router.post('/email-signin', express.json(), async (req, res) => {
    const creds = cleanCreds(req.body);
    if (!creds) return res.status(400).json({ ok: false, error: 'bad_request', message: 'Email and password are required.' });
    res.json(await auth.emailSignIn(creds));
});

router.post('/email-signup', express.json(), async (req, res) => {
    const creds = cleanCreds(req.body);
    if (!creds) return res.status(400).json({ ok: false, error: 'bad_request', message: 'Email and password are required.' });
    res.json(await auth.emailSignUp(creds));
});

module.exports = router;
