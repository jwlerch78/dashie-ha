// api-auth.js — sign-in endpoints for the Ingress page (and the dev rig).
//
// Reachable only on the hassio container network + HA Ingress (ports: {} — no
// LAN exposure). Same trust boundary as the bridge itself; deliberately NOT
// bridge-secret-gated so the Ingress page (which can't know the secret) works.

'use strict';

const auth = require('./auth');
const { CLOUD_ENV } = require('./config');
const { readOptions } = require('./options');

// One active link attempt per add-on instance.
let pendingLink = null;   // { device_code, user_code, verification_url, expires_at, interval }

async function handleAuthStatus(req, res, sendJson) {
    const stored = auth.readStoredJwt();
    const opts = readOptions();
    sendJson(res, 200, {
        authenticated: !!stored,
        user_email: stored?.userEmail || null,
        user_name: stored?.userName || null,
        cloud_env: CLOUD_ENV,
        engines: {
            llm: opts.llm_url ? `${opts.llm_model || '?'} @ ${opts.llm_url}` : (stored ? 'Chickadee Cloud' : 'not configured'),
            stt: opts.stt_url ? opts.stt_url : (stored ? 'Chickadee Cloud (Whisper)' : 'not configured'),
            tts: opts.tts_url ? `${opts.tts_url} (${opts.tts_voice || 'default voice'})` : (stored ? 'Chickadee Cloud' : 'not configured'),
        },
    });
}

async function handleStartLink(req, res, sendJson) {
    try {
        const link = await auth.createDeviceCode();
        pendingLink = { ...link, expires_at: Date.now() + link.expires_in * 1000 };
        console.log(`[auth] sign-in started — code ${link.user_code}, approve at ${link.verification_url}`);
        sendJson(res, 200, {
            user_code: link.user_code,
            verification_url: link.verification_url,
            expires_at: new Date(pendingLink.expires_at).toISOString(),
            interval: link.interval,
        });
    } catch (e) {
        console.error('[auth] start-link failed:', e.message);
        sendJson(res, 500, { error: 'start_link_failed', message: e.message });
    }
}

async function handlePollLink(req, res, sendJson) {
    if (!pendingLink) { sendJson(res, 200, { status: 'none' }); return; }
    if (Date.now() >= pendingLink.expires_at) {
        pendingLink = null;
        sendJson(res, 200, { status: 'expired' });
        return;
    }
    try {
        const result = await auth.pollDeviceCode(pendingLink.device_code);
        if (result.status === 'authorized') pendingLink = null;
        sendJson(res, 200, { status: result.status });
    } catch (e) {
        console.warn('[auth] poll failed (treating as pending):', e.message);
        sendJson(res, 200, { status: 'pending' });
    }
}

async function handleSignOut(req, res, sendJson) {
    auth.clearStoredJwt();
    console.log('[auth] signed out (credential cleared)');
    sendJson(res, 200, { ok: true });
}

module.exports = { handleAuthStatus, handleStartLink, handlePollLink, handleSignOut };
