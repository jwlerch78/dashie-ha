// SPDX-License-Identifier: AGPL-3.0-only
// brain/tool-gate.js — is a tool capability available on this box, and if not, why?
//
// The signed-out shell used to answer one question: "is there an account?" For a
// BYOK build that is the wrong question. There is no account by design, and the
// capabilities are gated by whether the household supplied a key — which is a
// different thing with a different remedy.
//
// ── THREE STATES, NOT TWO ─────────────────────────────────────────────────────
//
// Conflating these is how a user ends up told "search is unavailable" when the
// truth is "you have not added a key yet" or "this add-on cannot do it yet":
//
//   ready         a key is stored (or none is needed) AND the adapter that uses
//                 it exists. The capability actually works.
//   needs-key     the adapter exists; no key is stored. The user can fix this.
//   no-adapter    a key may be stored, but the on-box code that would call the
//                 provider has not shipped. The USER CANNOT FIX THIS, and telling
//                 them to check their key would be a lie.
//
// `no-adapter` is the 5b boundary made runtime-visible: 5b delivers key storage,
// onboarding and gating; the provider adapters are separate work. Until they
// land, a stored key is stored and nothing more, and this module is what stops
// anything downstream from claiming otherwise.
//
// ── EVERY UNAVAILABLE CAPABILITY LOGS A LOUD DROP ─────────────────────────────
//
// A tool that is silently absent is indistinguishable from a tool the model
// chose not to use, which makes it undiagnosable from a transcript. Each miss
// emits a `DROP:` line naming the capability, the reason, and the remedy —
// once per capability per process, because a per-turn line would drown the log
// an HA user actually reads (the add-on's stdout is their only diagnostic).

const keyStore = require('../key-store');

/**
 * Capability → the providers that can serve it, in preference order, and
 * whether the on-box adapter exists yet.
 *
 * `keyless: true` means the capability needs no credential at all — sports from
 * ESPN's public endpoints, images from Wikimedia. Those are never `needs-key`,
 * because there is no key to be missing.
 *
 * Mirrors the console's provider-manifest.js. Two lists, deliberately: this one
 * is what the BOX can do, that one is what the UI offers to configure, and they
 * answer to different owners (a provider can be configurable before its adapter
 * ships — that is exactly the `no-adapter` state).
 */
const CAPABILITIES = {
    web_search: {
        providers: ['tavily', 'brave'],
        keyless: false,
        adapter: false,          // 🔴 flip when the on-box search call lands
        remedy: 'Add a Tavily API key in the console under API Keys (free tier, no card).',
    },
    images: {
        providers: ['pexels'],
        keyless: true,           // Wikimedia serves this without any key
        adapter: false,
        remedy: 'Images work without a key once the image adapter ships; Pexels is optional.',
    },
    sports: {
        providers: ['apisports'],
        keyless: true,           // ESPN's public endpoints need no key
        adapter: false,
        remedy: 'Sports needs no key — it uses ESPN directly once the sports adapter ships.',
    },
    stt: {
        providers: ['deepgram'],
        keyless: true,           // Home Assistant's own Whisper is the default
        adapter: false,
        remedy: 'Speech-to-text uses Home Assistant’s Whisper by default; Deepgram is optional.',
    },
    tts: {
        providers: ['elevenlabs', 'inworld'],
        keyless: true,           // Home Assistant's own Piper is the default
        adapter: false,
        remedy: 'Text-to-speech uses Home Assistant’s Piper by default; ElevenLabs is optional.',
    },
};

/** One DROP per capability per process — see the header. */
const warned = new Set();

/**
 * @returns {{state: 'ready'|'needs-key'|'no-adapter', capability: string,
 *            provider: string|null, reason: string, remedy: string}}
 */
function capabilityState(capability) {
    const spec = CAPABILITIES[capability];
    if (!spec) {
        return {
            state: 'no-adapter', capability, provider: null,
            reason: `unknown capability '${capability}' — nothing on this box claims to serve it`,
            remedy: 'Add it to brain/tool-gate.js if it is real.',
        };
    }

    let stored = {};
    try {
        stored = keyStore.status();
    } catch (e) {
        // A key store that cannot be read is not the same as no keys — say so
        // rather than reporting every capability as unconfigured.
        return {
            state: 'no-adapter', capability, provider: null,
            reason: `could not read the key store: ${e.message}`,
            remedy: 'Check the add-on’s /data volume is writable.',
        };
    }

    const provider = spec.providers.find((p) => stored[p]) || null;

    // Adapter first: with no adapter the key is irrelevant, and blaming a missing
    // key for something the user cannot fix by adding one is the worse error.
    if (!spec.adapter) {
        return {
            state: 'no-adapter', capability, provider,
            reason: provider
                ? `a ${provider} key is stored, but this add-on has no adapter for ${capability} yet`
                : `this add-on has no adapter for ${capability} yet`,
            remedy: spec.remedy,
        };
    }
    if (!provider && !spec.keyless) {
        return {
            state: 'needs-key', capability, provider: null,
            reason: `no key stored for any ${capability} provider (${spec.providers.join(', ')})`,
            remedy: spec.remedy,
        };
    }
    return { state: 'ready', capability, provider, reason: '', remedy: spec.remedy };
}

const isAvailable = (capability) => capabilityState(capability).state === 'ready';

/**
 * Log the miss, once. Returns the state so a caller can both report and branch:
 *   const s = tools.dropIfUnavailable('web_search', log);
 *   if (s.state !== 'ready') throw new Error(s.reason);
 */
function dropIfUnavailable(capability, log) {
    const s = capabilityState(capability);
    if (s.state === 'ready') return s;
    if (!warned.has(capability)) {
        warned.add(capability);
        const line = `DROP: ${capability} unavailable (${s.state}) — ${s.reason}. ${s.remedy}`;
        try { (log || console.warn)(line); } catch { /* never break a turn to log */ }
    }
    return s;
}

/** Every capability's state — for diagnostics and the console's status view. */
function allStates() {
    return Object.keys(CAPABILITIES).map(capabilityState);
}

module.exports = { CAPABILITIES, capabilityState, isAvailable, dropIfUnavailable, allStates };
