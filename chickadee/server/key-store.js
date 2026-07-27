// server/key-store.js
// Add-on-local BYO API keys (model-provider keys for the AI/brain).
//
// Open Brain plan (20260710_OPEN_BRAIN_BYOK_PRESETS_UI.md §4): keys live ONLY
// on the HA box's /data volume — never in Supabase, never synced, never sent
// back to the browser in full (GET returns masked values; /status returns
// booleans). The box is the trust boundary for v1 (plaintext + chmod 600;
// at-rest encryption is a later hardening pass).
//
// Provider shapes:
//   gemini / claude / openai / hermes → { key }
//   bedrock                           → { accessKeyId, secretAccessKey, region }

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const KEYS_FILE = path.join(DATA_DIR, 'api-keys.json');

/** Provider → required fields. A provider counts as "configured" only when
 *  every required field is a non-empty string. */
const PROVIDERS = {
    // OpenRouter is the "one key, every model" option: it proxies EVERY model in our
    // catalog over an OpenAI-compatible endpoint, so a single key covers Claude/GPT/
    // Gemini/Nova without the user signing up for four accounts — and without us
    // building the deferred Anthropic-messages / SigV4 adapters. See brain/providers.js.
    openrouter: ['key'],
    gemini:  ['key'],
    claude:  ['key'],
    openai:  ['key'],
    bedrock: ['accessKeyId', 'secretAccessKey', 'region'],
    hermes:  ['key'],
};

function isKnownProvider(provider) {
    return Object.prototype.hasOwnProperty.call(PROVIDERS, provider);
}

/** Read all stored keys (full values — server-internal only). Never throws. */
function readKeys() {
    try {
        if (!fs.existsSync(KEYS_FILE)) return {};
        return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')) || {};
    } catch (e) {
        console.error('[key-store] Failed to read keys:', e.message);
        return {};
    }
}

/**
 * Set (or clear, with value=null) one provider's credentials and persist
 * atomically with owner-only permissions. Unknown fields are dropped; empty
 * strings are treated as "field not provided". Returns the new full store.
 */
function writeProvider(provider, value) {
    if (!isKnownProvider(provider)) throw new Error(`unknown provider: ${provider}`);
    const store = readKeys();
    if (value === null || value === undefined) {
        delete store[provider];
    } else {
        const clean = {};
        for (const field of PROVIDERS[provider]) {
            const v = value[field];
            if (typeof v === 'string' && v.trim()) clean[field] = v.trim();
        }
        if (Object.keys(clean).length === 0) {
            delete store[provider];
        } else {
            store[provider] = clean;
        }
    }
    const tmp = KEYS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, KEYS_FILE);
    try { fs.chmodSync(KEYS_FILE, 0o600); } catch (e) { /* best effort */ }
    return store;
}

/** True when the provider has all its required fields stored. */
function hasProvider(store, provider) {
    const entry = store[provider];
    if (!entry) return false;
    return PROVIDERS[provider].every(f => typeof entry[f] === 'string' && entry[f].length > 0);
}

/** Booleans-only view — which providers are configured. Safe for any client;
 *  the device reads this to decide brain routing (Phase 2). */
function status() {
    const store = readKeys();
    const out = {};
    for (const provider of Object.keys(PROVIDERS)) {
        out[provider] = hasProvider(store, provider);
    }
    return out;
}

/** '••••1234' — last 4 characters only, never the key. Region is not a
 *  secret, so bedrock.region passes through unmasked. */
function mask(value) {
    const s = String(value || '');
    if (!s) return '';
    return '••••' + s.slice(-4);
}

const UNMASKED_FIELDS = new Set(['region']);

/** Masked view for the console UI: per provider, each stored field masked
 *  (except non-secrets like region) + a `set` flag. Full values never leave
 *  the server. */
function maskedKeys() {
    const store = readKeys();
    const out = {};
    for (const provider of Object.keys(PROVIDERS)) {
        const entry = store[provider] || {};
        const fields = {};
        for (const field of PROVIDERS[provider]) {
            if (!entry[field]) continue;
            fields[field] = UNMASKED_FIELDS.has(field) ? entry[field] : mask(entry[field]);
        }
        out[provider] = { set: hasProvider(store, provider), fields };
    }
    return out;
}

module.exports = { PROVIDERS, isKnownProvider, readKeys, writeProvider, status, maskedKeys };
