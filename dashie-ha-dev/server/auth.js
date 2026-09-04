// SPDX-License-Identifier: AGPL-3.0-only
// auth.js — persistent JWT storage + Dashie Cloud device-flow auth.
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
const DEVICE_ID_FILE = path.join(DATA_DIR, 'dashie_ha_device_id');

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
    const id = `dashie-ha-addon-${crypto.randomBytes(6).toString('hex')}`;
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
            model: 'Dashie for Home Assistant Add-on',
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
    // Skin for the approval page (brand-config.js in the Dashie webapp).
    //
    // NOT cosmetic — the brand entry also decides the GOOGLE SCOPES. `dashie_ha`
    // requests identity only (openid email profile); the plain `dashie` default
    // requests the full family set including Calendar and Drive. Dropping this
    // param would therefore make a voice add-on ask for your Google Drive, so it
    // must always be sent, and must name a brand that EXISTS — resolveBrand()
    // falls back to `dashie` for an unknown id, which is exactly that failure.
    //
    // ⚠️ Requires the webapp deploy that adds the `dashie_ha` entry. Until that
    // is live, this falls back to the full-scope Dashie brand.
    verification_url += '&brand=dashie_ha';
    // No `&env=`: verificationBase is now per-channel (dev./app.dashieapp.com)
    // and those pages select their Supabase project by HOST. The param existed
    // only for the retired single-origin getchickadee.org.
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
/**
 * Classify one jwt-auth email_signin/email_signup response. PURE — no I/O, no
 * filesystem, no network — so the outcomes can be pinned with fixtures; `emailAuth`
 * below does the I/O around it. Extracted 2026-09-03 (board row 122) because the
 * decision it encodes had a third case that the two-branch `if` could not express.
 *
 * THREE outcomes, not two. Row 122 turned email verification on, and a verified
 * sign-up answers HTTP 200 with `{ success: true, verification_required: true }` and NO
 * jwtToken. The old two-branch `if` sent that to the failure path, where — with no
 * `body.error` to fall back to on a 200 — the machine code `http_200` and our own
 * check-your-email sentence were rendered to the user as the reason their sign-up had
 * FAILED, at the moment it had succeeded.
 */
function classifyEmailAuthResponse(status, body) {
    if (body?.success && body.jwtToken) return { kind: 'signed_in' };

    if (body?.success && body.verification_required) {
        return {
            kind: 'verification_required',
            message: body.message || 'Check your email for a confirmation link, then sign in.',
        };
    }

    // `success: true` with neither a JWT nor a verification flag is a shape no current
    // server sends. Fail CLOSED — an auth decision must not become a success by default —
    // but say so loudly rather than swallowing it (standing rule 2, no silent drops).
    if (body?.success) {
        console.warn(`DROP: ${'email-auth'} — success with neither jwtToken nor ` +
            `verification_required; treating as failure. Keys: ${Object.keys(body).join(',')}`);
    }

    return {
        kind: 'failed',
        error: body?.error || `http_${status}`,
        message: body?.message || body?.details || 'Sign-in failed.',
    };
}

async function emailAuth(operation, { email, password, name }) {
    const { status, body } = await edgeFnCallRaw(operation, {
        email,
        password,
        name,
        device_type: DEVICE_TYPE,
        device_id: getStableDeviceId(),
    });
    const outcome = classifyEmailAuthResponse(status, body);

    if (outcome.kind === 'signed_in') {
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

    if (outcome.kind === 'verification_required') {
        // `ok` stays FALSE deliberately: it means "signed in", and nobody is. The console
        // reloads the page on ok:true, and with no JWT that reload lands straight back on
        // the login screen with nothing said — a silent loop, worse than the bug being
        // fixed. The third case travels as its own flag, which an older console ignores.
        console.log(`[auth] ${operation}: verification required — confirmation email sent`);
        return { ok: false, verificationRequired: true, error: 'verification_required', message: outcome.message };
    }

    console.warn(`[auth] ${operation} rejected: ${outcome.error}`);
    return { ok: false, error: outcome.error, message: outcome.message };
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
    classifyEmailAuthResponse,
    readStoredJwt,
    writeStoredJwt,
    clearStoredJwt,
    createDeviceCode,
    pollDeviceCode,
    emailSignIn,
    emailSignUp,
    getValidJwt,
};
