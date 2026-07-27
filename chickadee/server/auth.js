// auth.js — persistent JWT storage + Chickadee Cloud device-flow auth.
// Ported from the Dashie add-on's auth.js (same account system, same jwt-auth
// edge function; see 20260702 device-flow docs there).
//
// Flow: start-link → edge fn create_device_code → user opens verification_url
// in ANY browser (phone/tablet/desktop — not the HA iframe) and approves →
// add-on polls poll_device_code_status → JWT persisted to /data.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CLOUD, CLOUD_ENV, JWT_FILE, DATA_DIR } = require('./config');

const REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000;   // refresh when <24h remain
const DEVICE_TYPE = 'ha_app';                        // shared flow type (edge-fn validated)
const EDGE_FN_URL = CLOUD.url + '/functions/v1/jwt-auth';
const DEVICE_ID_FILE = path.join(DATA_DIR, 'chickadee_device_id');

/**
 * Stable device id for this add-on install, persisted OUTSIDE the JWT file so
 * it survives sign-out. Sent on every credential mint (device-flow poll +
 * email ops) so jwt-auth registers a user_devices row — without one, an
 * ha_app JWT is `device_revoked` at its first refresh (D5) and the session
 * silently dies at 72h.
 */
function getStableDeviceId() {
    try {
        const id = fs.readFileSync(DEVICE_ID_FILE, 'utf8').trim();
        if (/^[A-Za-z0-9_-]{8,64}$/.test(id)) return id;
    } catch { /* absent — create below */ }
    const id = `chickadee-addon-${crypto.randomBytes(6).toString('hex')}`;
    try { fs.writeFileSync(DEVICE_ID_FILE, id, { mode: 0o600 }); } catch (e) {
        console.warn('[auth] could not persist device id (using ephemeral):', e.message);
    }
    return id;
}

function readStoredJwt() {
    try {
        if (!fs.existsSync(JWT_FILE)) return null;
        const data = JSON.parse(fs.readFileSync(JWT_FILE, 'utf8'));
        if (!data?.jwt || !data?.expiry) return null;
        if (Date.now() >= data.expiry) return null;
        return data;
    } catch (e) {
        console.error('[auth] failed to read stored JWT:', e.message);
        return null;
    }
}

/** Write JWT atomically; identity fields inherit from previous storage / claims. */
function writeStoredJwt({ jwt, userId, userEmail, userName, userPicture }) {
    let expiry = null;
    let payload = {};
    try {
        payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
        expiry = payload.exp ? payload.exp * 1000 : null;
    } catch (e) {
        console.warn('[auth] could not parse JWT payload:', e.message);
    }
    const prev = readStoredJwt() || {};
    const meta = payload.user_metadata || {};
    userId = userId ?? prev.userId ?? payload.sub ?? null;
    userEmail = userEmail ?? prev.userEmail ?? payload.email ?? meta.email ?? null;
    userName = userName ?? prev.userName ?? payload.name ?? meta.name ?? meta.full_name ?? null;
    // Picture (Google profile photo → console top-bar avatar). Inherit the
    // stored one ONLY for the same account — a refresh passes just {jwt}, but
    // a sign-in over a different account must never wear the previous user's
    // photo (same leak the console fixed client-side in 90bac93).
    const sameAccount = !!(prev.userId && userId && prev.userId === userId);
    userPicture = userPicture
        ?? (sameAccount ? prev.userPicture : null)
        ?? meta.picture ?? meta.avatar_url ?? null;

    const data = { jwt, expiry, userId, userEmail, userName, userPicture, savedAt: Date.now() };
    const tmp = JWT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, JWT_FILE);
    return data;
}

function clearStoredJwt() {
    try { fs.unlinkSync(JWT_FILE); } catch { /* absent */ }
}

/** Edge-fn call returning { status, body } — body JSON-parsed when possible. */
async function edgeFnCallRaw(operation, data = {}) {
    const resp = await fetch(EDGE_FN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${CLOUD.anonKey}`,
        },
        body: JSON.stringify({ operation, data }),
    });
    const text = await resp.text().catch(() => '');
    let body;
    try { body = JSON.parse(text); } catch { body = { error: 'bad_response', message: text.slice(0, 200) }; }
    return { status: resp.status, body };
}

async function edgeFnCall(operation, data = {}) {
    const { status, body } = await edgeFnCallRaw(operation, data);
    if (status < 200 || status >= 300) {
        throw new Error(`${operation} HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
    }
    return body;
}

/** Create a device code → { device_code, user_code, verification_url, expires_in, interval }. */
async function createDeviceCode() {
    const result = await edgeFnCall('create_device_code', {
        device_type: DEVICE_TYPE,
        base_url: CLOUD.verificationBase,
        device_info: {
            model: 'Chickadee Add-on',
            os_version: `node-${process.versions.node}`,
            app_version: '0.3.0',
        },
    });
    if (!result.success) throw new Error(`create_device_code failed: ${JSON.stringify(result)}`);

    // The edge fn echoes its own host/path — rebuild against this env's canonical
    // auth page, preserving the query (code + type). Same fix as the Dashie add-on.
    let verification_url = result.verification_url;
    try {
        const q = new URL(verification_url).search;
        verification_url = `${CLOUD.verificationBase}/auth.html${q}`;
    } catch {
        verification_url = `${CLOUD.verificationBase}/auth.html?code=${encodeURIComponent(result.user_code || '')}&type=${DEVICE_TYPE}`;
    }
    // Chickadee skin on the approval pages (brand-config.js there; unknown
    // param = no-op on older deploys, so this is safe to send unconditionally).
    verification_url += '&brand=chickadee';
    return {
        device_code: result.device_code,
        user_code: result.user_code,
        verification_url,
        expires_in: result.expires_in,
        interval: result.interval || 5,
    };
}

/** Poll → { status: 'pending' | 'authorized' | 'expired' }. Persists the JWT on approval. */
async function pollDeviceCode(deviceCode) {
    // device_id: the poll is the mint moment — jwt-auth stamps this stable id
    // into the JWT and registers the user_devices row that keeps it refreshable.
    const result = await edgeFnCall('poll_device_code_status', {
        device_code: deviceCode,
        device_id: getStableDeviceId(),
    });
    if (result.success && result.jwtToken) {
        const stored = writeStoredJwt({
            jwt: result.jwtToken,
            userId: result.user?.id,
            userEmail: result.user?.email,
            userName: result.user?.name,
            userPicture: result.user?.picture,
        });
        console.log(`[auth] signed in as ${stored.userEmail} (${CLOUD_ENV})`);
        return { status: 'authorized', jwtStored: stored };
    }
    if (result.status === 'expired_token' || result.status === 'expired') return { status: 'expired' };
    return { status: 'pending' };
}

/**
 * Email/password sign-in or sign-up via jwt-auth (email_signin/email_signup).
 * Success persists the JWT (same stored shape as the device flow) and returns
 * { ok: true, user }. Failure returns { ok: false, error, message } with the
 * edge fn's structured code (invalid_credentials, account_exists,
 * use_google_signin, rate_limited, ...) for the panel to display.
 */
async function emailAuth(operation, { email, password, name }) {
    const { status, body } = await edgeFnCallRaw(operation, {
        email,
        password,
        name,
        device_type: DEVICE_TYPE,
        device_id: getStableDeviceId(),
    });
    if (body?.success && body.jwtToken) {
        const stored = writeStoredJwt({
            jwt: body.jwtToken,
            userId: body.user?.id,
            userEmail: body.user?.email,
            userName: body.user?.name,
            userPicture: body.user?.picture,
        });
        console.log(`[auth] ${operation}: signed in as ${stored.userEmail} (${CLOUD_ENV})`);
        return { ok: true, user: body.user };
    }
    const error = body?.error || `http_${status}`;
    const message = body?.message || body?.details || 'Sign-in failed.';
    console.warn(`[auth] ${operation} rejected: ${error}`);
    return { ok: false, error, message };
}

const emailSignIn = (creds) => emailAuth('email_signin', creds);
const emailSignUp = (creds) => emailAuth('email_signup', creds);

async function refreshJwt(currentJwt) {
    const resp = await fetch(EDGE_FN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${currentJwt}`,
            apikey: CLOUD.anonKey,
        },
        body: JSON.stringify({ operation: 'refresh_jwt', jwtToken: currentJwt }),
    });
    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        // Deleted account is definitive — drop the credential (Dashie 2026-07-13 lesson:
        // never keep vending a dead identity until natural expiry).
        if (resp.status === 401 && body.includes('account_deleted')) {
            console.warn('[auth] account no longer exists — clearing stored credential');
            clearStoredJwt();
            const err = new Error('account_deleted');
            err.accountDeleted = true;
            throw err;
        }
        throw new Error(`refresh_jwt failed: ${resp.status} ${body.slice(0, 200)}`);
    }
    const result = await resp.json();
    if (!result.success || !result.jwtToken) throw new Error('refresh_jwt invalid response');
    return writeStoredJwt({ jwt: result.jwtToken });
}

/** Valid JWT, refreshing when near expiry. Throws when not signed in. */
async function getValidJwt() {
    const stored = readStoredJwt();
    if (!stored) throw new Error('not_signed_in');
    if (stored.expiry - Date.now() > REFRESH_THRESHOLD_MS) return stored;
    try {
        return await refreshJwt(stored.jwt);
    } catch (e) {
        if (e.accountDeleted) throw new Error('not_signed_in');
        console.warn('[auth] refresh failed, using existing JWT until expiry:', e.message);
        return stored;
    }
}

module.exports = {
    readStoredJwt,
    writeStoredJwt,
    clearStoredJwt,
    createDeviceCode,
    pollDeviceCode,
    emailSignIn,
    emailSignUp,
    getValidJwt,
};
