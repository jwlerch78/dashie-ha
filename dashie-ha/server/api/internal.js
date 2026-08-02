// SPDX-License-Identifier: AGPL-3.0-only
// api/internal.js — endpoints for the trusted in-HA caller (the Dashie Voice
// integration), reached over the hassio Docker network. Ported from the Dashie
// add-on's api/internal.js — this is the LAN-sharing lane: a Dashie tablet in
// kiosk mode gets household voice through the integration's /api/dashie/voice/*
// views, which proxy here.
//
// 🔐 Every call must carry X-Dashie-Voice-Bridge-Secret (enforced from birth —
// no observe mode; same posture as /api/voice/converse). The account
// credential is only vended when the account holder has opted into household
// sharing (voice.householdSharing in user_settings — account-scoped, fails
// closed on any read error).

'use strict';

const express = require('express');
const auth = require('../auth');
const { getAccountVoiceConfig } = require('../account-config');
const bridgeAuth = require('../bridge-auth');
const { CLOUD, LEASE_TTL_S, LEASE_TTL_IS_DEBUG } = require('../config');

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
        // The configured cloud environment's base URL — the integration derives
        // its brain/token edge-fn URLs from this instead of hardcoding an env.
        cloud_url: CLOUD.url,
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

/**
 * POST /api/internal/voice-lease  — the capability lease (CONTRACTS #65)
 *
 * Issue AND renew: there is no separate renew route and no lease handle to
 * present, because renewal is simply asking again. That is what lets this box
 * store NOTHING about leases — a renewal is a fresh read of grant state — which
 * is how D4 ("a lease must survive an add-on restart") is satisfied by
 * construction rather than by persistence. A stored lease could also outlive a
 * revocation, which is the failure this whole design exists to remove.
 *
 * 🔴 THE STATUS IS THE PROTOCOL. The integration proxies it through verbatim and
 * the device branches on it:
 *
 *   200  granted — here is a fresh expiry
 *   403  a DEFINITE refusal from a box that is present and answering
 *        → the device self-destructs IMMEDIATELY (this is the switch that is
 *          flipped during testing; it has to take effect at once)
 *   503  never sent from here. Unreachability is expressed by this box not
 *        answering at all, and the device treats that as UNKNOWN, not withdrawn:
 *        it keeps its lease and retries until expiry.
 *
 * ⚠️ FRAMING (required wording): the lease is a hygiene/operational control, NOT
 * a security boundary. A granted lease means "the household still grants this";
 * it does NOT mean "this request is permitted" — that is the scope check, made
 * server-side on every request.
 */

// What this box is willing to lease at all. A fixed list is correct rather than
// lazy: the lease is PERMISSION TO ASK, and whether a given call then succeeds
// is decided per-request by the scope check and the tool gate. Naming it here
// keeps a future per-capability refinement to one place.
const LEASABLE_CAPABILITIES = ['voice', 'ai', 'tools'];

// ── OBSERVATIONAL ONLY — this is NOT the lease table, and there isn't one ─────
//
// Grant decisions stay stateless: a renewal is a fresh read of grant state, which
// is what makes a lease survive an add-on restart without persistence and stops a
// stored lease outliving a revocation. Nothing here is ever consulted to decide
// whether to grant.
//
// It exists because leases are deliberately not in Supabase (D7), so without it
// NOTHING can answer "who currently holds capability" — which makes the setup
// state of most lease tests unverifiable (Thread T). Losing it on restart is
// therefore fine, and is itself a useful signal that it is not authoritative.
const LEASE_OBSERVED = new Map();
const LEASE_OBSERVED_MAX = 50;

function recordLease(endpointId, expiresAt, capabilities) {
    const prior = LEASE_OBSERVED.get(endpointId);
    const now = new Date().toISOString();
    LEASE_OBSERVED.set(endpointId, {
        endpoint_id: endpointId,
        issued_at: prior?.issued_at ?? now,
        last_renewal: now,
        renewals: (prior?.renewals ?? 0) + (prior ? 1 : 0),
        expires_at: expiresAt,
        capabilities,
    });
    // Bounded: evict the oldest by last renewal. A debug surface must not be a
    // way to grow the add-on's memory without limit.
    if (LEASE_OBSERVED.size > LEASE_OBSERVED_MAX) {
        const oldest = [...LEASE_OBSERVED.values()].sort((a, b) => a.last_renewal < b.last_renewal ? -1 : 1)[0];
        if (oldest) LEASE_OBSERVED.delete(oldest.endpoint_id);
    }
    return !prior;
}

/**
 * GET /api/internal/voice-lease/debug — who the box has recently leased to.
 * Diagnostic surface for the lease test suite. NOT authoritative: see above.
 */
router.get('/voice-lease/debug', (req, res) => {
    res.json({
        authoritative: false,
        note: 'observational only — grant decisions are stateless and read live; this list is lost on restart',
        ttl_seconds: LEASE_TTL_S,
        ttl_is_debug_override: LEASE_TTL_IS_DEBUG,
        leases: [...LEASE_OBSERVED.values()],
    });
});


router.post('/voice-lease', express.json(), async (req, res) => {
    const endpointId = (req.body?.endpoint_id) || 'ha-voice';
    // 🔴 GREPPABLE MARKERS on every transition (standing rule 2, and Thread T's
    // requirement: a silent transition makes most lease tests unprovable).
    const deny = (reason) => {
        console.warn(`LEASE: refused endpoint=${endpointId} reason=${reason}`);
        return res.status(403).json({ granted: false, reason, capabilities: [] });
    };

    // ── the grant gate ────────────────────────────────────────────────────
    // Sharing is an ACCOUNT concept: it is the household owner declining to let
    // a satellite spend the account's metered capability. Where there is no
    // account there is nothing to withhold, so the gate does not apply.
    //
    // Derived from CLOUD.url rather than a new per-brand constant — the same
    // seam the brain target uses, and self-policing for the same reason: a
    // branded build that failed to blank it would still carry a real project
    // URL, which is exactly what the generator's deny scan fails on.
    if (CLOUD.url) {
        if (!auth.readStoredJwt()) return deny('not_signed_in');
        if (!await readSharing()) return deny('sharing_disabled');
    }

    const asked = Array.isArray(req.body?.capabilities) ? req.body.capabilities : null;
    const granted = asked
        ? LEASABLE_CAPABILITIES.filter((c) => asked.includes(c))
        : LEASABLE_CAPABILITIES;
    if (!granted.length) return deny('capability_unavailable');

    const ttl = LEASE_TTL_S;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const isNew = recordLease(endpointId, expiresAt, granted);
    console.log(
        `LEASE: ${isNew ? 'issued' : 'renewed'} endpoint=${endpointId} ` +
        `caps=${granted.join(',')} ttl=${ttl}s expires=${expiresAt}` +
        (LEASE_TTL_IS_DEBUG ? ' ttl_source=debug_override' : ''),
    );
    return res.json({
        granted: true,
        capabilities: granted,
        expires_at: expiresAt,
        ttl_seconds: ttl,
        // The BOX sets the cadence, so the TTL is reconfigurable without
        // shipping a device build. A third of the TTL gives roughly three
        // attempts before expiry — enough to ride out an add-on restart
        // without widening the revocation window.
        renew_after_seconds: Math.floor(ttl / 3),
    });
});

module.exports = router;
