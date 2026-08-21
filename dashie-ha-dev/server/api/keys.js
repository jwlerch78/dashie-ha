// SPDX-License-Identifier: AGPL-3.0-only
// server/api/keys.js
// Console-facing endpoints for add-on-local BYO API keys (Open Brain plan
// 20260710_OPEN_BRAIN_BYOK_PRESETS_UI.md §4). Ingress-protected, like
// /api/settings/local.
//
//   GET /api/keys         → masked per-provider view (for the console UI)
//   PUT /api/keys         → { provider, value } — set or clear (value: null)
//                           `value` must carry at least one KNOWN field for the provider and
//                           no unknown ones; anything else is a 400 naming the field. Only
//                           `value: null` clears — see the guard in the handler for why those
//                           two had to stop sharing a code path.
//   GET /api/keys/status  → booleans only (which providers are configured);
//                           the device reads this to route the brain (Phase 2)
//
// NO requireSignedIn anywhere in this file, deliberately (2026-07-31, Step 7).
// PUT / used to require a Dashie account, which was the feeds finding a third
// time: `api-keys` is in FeatureGate.LOCAL_MODE_PAGES, so a box with no account
// rendered the page, loaded it, validated a key against the provider — and then
// 401'd on save. A signed-out user could not store their OWN key.
//
// Nothing here reads account state. The key is the USER'S, it is stored on the
// USER'S box (/data/api-keys.json, mode 600, backup_exclude), it never leaves
// the box, and it is the one credential that makes the brain work WITHOUT a
// Dashie account — which is exactly what the console promises on the Voice & AI
// page ("a BYO provider key unlocks a cloud-AI preset in every mode, including
// local"). The gate is Ingress: HA has already authenticated whoever can reach
// this panel, and the add-on publishes no host port.

const express = require('express');
const keyStore = require('../key-store');
const providers = require('../brain/providers');
const { mintEphemeralToken } = require('../live-token');

const router = express.Router();

/** GET /api/keys → masked values + set flags. Full keys never leave the box. */
router.get('/', (req, res) => {
    // `routable` = the providers whose key actually flips brain routing (brain/providers.js).
    // The console renders a key field ONLY for these, so we can never again ship a field that
    // silently does nothing (a stored Claude key used to validate green and still bill Dashie
    // credits, because no adapter existed — WS-I.8 silent degradation).
    res.json({ providers: keyStore.maskedKeys(), routable: providers.ROUTABLE_PROVIDERS });
});

/** GET /api/keys/status → { gemini: bool, claude: bool, ... } */
router.get('/status', (req, res) => {
    res.json({ providers: keyStore.status() });
});

/**
 * POST /api/keys/validate  { provider }
 * Free "is my key valid?" check — a GET to the provider's /models endpoint (no
 * completion, nothing billed). → { ok: true|false|null, detail }.
 */
router.post('/validate', express.json(), async (req, res) => {
    const { provider } = req.body || {};
    if (!keyStore.isKnownProvider(provider)) {
        return res.status(400).json({ error: 'unknown_provider' });
    }
    try {
        const result = await providers.validateProvider(provider);
        res.json(result);
    } catch (e) {
        console.error('[keys] validate failed:', e.message);
        res.json({ ok: false, detail: 'Validation failed to run.' });
    }
});

/**
 * PUT /api/keys  { provider: 'gemini', value: { key: '...' } }
 * Bedrock: value = { accessKeyId, secretAccessKey, region }.
 * value: null clears the provider. Responds with the new masked view.
 */
router.put('/', express.json(), (req, res) => {
    const { provider, value } = req.body || {};
    if (!keyStore.isKnownProvider(provider)) {
        return res.status(400).json({ error: 'unknown_provider' });
    }
    if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
        return res.status(400).json({ error: 'bad_value' });
    }
    // 🔴 A WELL-FORMED PUT WITH THE WRONG FIELD NAME USED TO DELETE THE KEY AND RETURN 200.
    //
    // `writeProvider` copies only the fields it knows (`PROVIDERS[provider]`), so a payload like
    // `{ provider: 'gemini', value: { value: 'sk-…' } }` — right shape, wrong inner field —
    // produced an empty `clean`, which falls into its `delete store[provider]` branch. The
    // response was 200 with a normal body and nothing was logged.
    //
    // ⚠️ That is worse than the "stores nothing" T reported: `null` already means CLEAR, so an
    // object that yields no usable field took the SAME destructive path as an explicit clear. A
    // typo in a field name silently removed a working key. The two intents have to be
    // distinguishable — `null` is a decision, an unrecognised field is a mistake.
    //
    // Rejected rather than DROP-logged-and-continued: there is no partial success to preserve
    // here, and a 4xx naming the field is the thing that makes the caller's bug visible at the
    // moment it happens. Standing rule 2 wants the drop to be loud; a silent 200 was the drop.
    if (value !== null) {
        const known = keyStore.PROVIDERS[provider];
        const given = Object.keys(value);
        const unknown = given.filter(f => !known.includes(f));
        const usable = given.filter(f => known.includes(f) && typeof value[f] === 'string' && value[f].trim());
        if (unknown.length || usable.length === 0) {
            console.warn(
                `DROP: [keys] ${provider} PUT rejected — unknown field(s) [${unknown.join(', ') || 'none'}], ` +
                `usable [${usable.join(', ') || 'none'}], expected [${known.join(', ')}]. ` +
                'Nothing was written; send { value: null } to clear.',
            );
            return res.status(400).json({
                error: unknown.length ? 'unknown_fields' : 'no_usable_fields',
                unknown,
                expected: known,
            });
        }
    }
    try {
        keyStore.writeProvider(provider, value);
        console.log(`[keys] ${provider} → ${keyStore.status()[provider] ? 'set' : 'cleared'}`);
    } catch (e) {
        console.error('[keys] write failed:', e.message);
        return res.status(500).json({ error: 'write_failed' });
    }
    res.json({ providers: keyStore.maskedKeys() });
});

/**
 * POST /api/keys/live-token   { model? }
 * Mint a short-lived, Live-only Gemini ephemeral token from the box's stored gemini key,
 * for a BYOK Live session. The RAW KEY NEVER LEAVES THE BOX — only the token is returned.
 * Ingress-protected like /status (the device brokers this on the household LAN; the relay
 * independently authenticates the device's JWT downstream).
 * → { token, expireTime, newSessionExpireTime } | 503 no_gemini_key | 502 mint_failed
 */
router.post('/live-token', express.json(), async (req, res) => {
    const entry = keyStore.readKeys().gemini;
    const key = entry && typeof entry.key === 'string' ? entry.key : '';
    if (!key) return res.status(503).json({ error: 'no_gemini_key' });
    try {
        // Mint UNCONSTRAINED for now. Model-locking (bidiGenerateContentSetup) 1011s at WS
        // connect — the constrained-setup protocol needs more work (Phase-0/1 finding). The
        // token is still Live-only + short-lived, which is the security that matters here.
        const out = await mintEphemeralToken(key);
        res.json(out); // token only — the raw key never leaves the box
    } catch (e) {
        // e.message / e.detail never contain the key (see live-token.js).
        console.error(`[keys] live-token mint failed: ${e.message}${e.status ? ' status=' + e.status : ''}`);
        res.status(e.message === 'no_gemini_key' ? 503 : 502).json({ error: 'mint_failed', status: e.status || null });
    }
});

module.exports = router;
