// server/api/keys.js
// Console-facing endpoints for add-on-local BYO API keys (Open Brain plan
// 20260710_OPEN_BRAIN_BYOK_PRESETS_UI.md §4). Mirrors api/settings.js:
// ingress-protected reads; writes additionally require the add-on to be
// signed into a Chickadee account.
//
//   GET /api/keys         → masked per-provider view (for the console UI)
//   PUT /api/keys         → { provider, value } — set or clear (value: null)
//   GET /api/keys/status  → booleans only (which providers are configured);
//                           the device reads this to route the brain (Phase 2)

const express = require('express');
const auth = require('../auth');
const keyStore = require('../key-store');
const providers = require('../brain/providers');
const { mintEphemeralToken } = require('../live-token');

const router = express.Router();

function requireSignedIn(req, res, next) {
    const stored = auth.readStoredJwt();
    if (!stored) {
        return res.status(401).json({ error: 'add_on_not_signed_in' });
    }
    next();
}

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
router.put('/', requireSignedIn, express.json(), (req, res) => {
    const { provider, value } = req.body || {};
    if (!keyStore.isKnownProvider(provider)) {
        return res.status(400).json({ error: 'unknown_provider' });
    }
    if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
        return res.status(400).json({ error: 'bad_value' });
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
