// SPDX-License-Identifier: AGPL-3.0-only
// js/lib/provider-manifest.js
//
// THE list of configurable providers. One copy, two consumers: the first-run
// onboarding flow and the API-keys settings page. Neither keeps its own array —
// a second copy is the hand-mirror that goes stale the first time a provider is
// added to one and not the other.
//
// ── The descriptor ────────────────────────────────────────────────────────────
//
//   id          stable key. Matches the server's key-store provider id exactly.
//   name        human label.
//   kind        'brain' | 'tool'. A brain provider answers; a tool provider
//               gives the brain a capability.
//   auth        HOW you configure it, not what it is. See AUTH below — this is
//               the field a hosted option would extend, and the reason the
//               renderers dispatch on it rather than on `id`.
//   fields      for auth 'api-key': the inputs. Multi-field is normal
//               (Bedrock needs three), so nothing may assume one.
//   required    true only for a provider without which the product does not
//               function. Exactly one thing is required: a brain.
//   unlocks     what the user GETS. Shown in onboarding, because "Tavily" means
//               nothing and "web search" means everything.
//   keySource   where to get one, and what the free tier is. Onboarding that
//               says "paste a key" without saying where is not onboarding.
//   surfaces    WHERE this provider is configurable. Not every provider belongs
//               on every screen: Hermes has its own dedicated row on the voice
//               page (endpoint URL + key together), so listing it on the API-keys
//               page would give one credential two controls. Being explicit here
//               is what lets both screens read ONE list without either of them
//               growing a special case.
//   adapter     🔴 'shipped' | 'pending'. Whether the on-box code that USES this
//               key exists yet. See the 5b boundary in the Thread B plan: 5b
//               stores and validates keys; adapters are separate work. A
//               provider with adapter:'pending' must never be reported as
//               working — the console would be asserting something nobody
//               observed.
//   note        anything the user should know before choosing it.
//
// ── What is deliberately absent ───────────────────────────────────────────────
//
//   Serper — image search. Its terms say it "does not provide end-user
//   (consumer) services", and a household is exactly the consumer it disclaims.
//   Not listed, not reachable, not a comment in a picker. Images come from
//   Wikimedia (keyless) or Pexels.
//
//   Anything priced. No cost, balance, quota-remaining or purchase field exists
//   in this descriptor, and none should be added. This product reports state; it
//   does not sell. A provider's own signup page is where money happens.
//
//   ⚠️ `keySource.free` is NOT an exception to that, and the difference is worth
//   being precise about because the two look alike. It is a STATIC sentence
//   describing a third party's free tier ("$200 credit, no card") so a household
//   can decide whether to sign up at all — that is onboarding information, and
//   omitting it would make "paste a key" a worse experience for no principle.
//   What is forbidden is anything LIVE or OURS: a balance we fetch, a quota we
//   count down, a price we quote, a button that takes money. Static description
//   of someone else's offer, yes. Meter, no.
//
//   Sports and weather. Zero-key by design — ESPN needs no key, weather comes
//   from HA's own entities. A provider with nothing to configure does not
//   belong in a configuration list.

(function () {
    'use strict';

    /**
     * Auth shapes. The renderer registry dispatches on these, so adding a shape
     * is adding a renderer — never a branch inside an existing one.
     *
     * NONE exists to be explicit that "no configuration" is a shape rather than
     * an absence; DEVICE_FLOW is declared and deliberately unbuilt (see
     * provider-auth-renderers.js).
     */
    const AUTH = {
        NONE: 'none',
        API_KEY: 'api-key',
        DEVICE_FLOW: 'device-flow',
    };

    /** Adapter state — is there on-box code that actually uses this key yet? */
    const ADAPTER = {
        SHIPPED: 'shipped',
        PENDING: 'pending',
    };

    const PROVIDERS = [
        // ── Brain ────────────────────────────────────────────────────────────
        // Already shipped and already routed; these entries move the existing
        // api-keys.js array into the shared list rather than inventing anything.
        {
            id: 'openrouter', name: 'OpenRouter', kind: 'brain', group: 'universal',
            surfaces: ['api-keys', 'onboarding'],
            auth: AUTH.API_KEY, required: true, adapter: ADAPTER.SHIPPED,
            unlocks: 'Every model in the picker, from one key',
            keySource: { url: 'https://openrouter.ai/keys', free: 'Pay per use, no subscription' },
            note: 'Covers Claude and Nova too, which a direct key cannot serve yet.',
            fields: [{ id: 'key', label: 'API key', placeholder: 'sk-or-v1-…', secret: true }],
        },
        {
            id: 'gemini', name: 'Google Gemini', kind: 'brain', group: 'direct',
            surfaces: ['api-keys', 'onboarding'],
            auth: AUTH.API_KEY, required: true, adapter: ADAPTER.SHIPPED,
            unlocks: 'Gemini models',
            keySource: { url: 'https://aistudio.google.com/apikey', free: 'Free tier available' },
            fields: [{ id: 'key', label: 'API key', placeholder: 'AIza…', secret: true }],
        },
        {
            id: 'claude', name: 'Anthropic Claude', kind: 'brain', group: 'direct',
            surfaces: ['api-keys', 'onboarding'],
            auth: AUTH.API_KEY, required: true, adapter: ADAPTER.SHIPPED,
            unlocks: 'Claude models',
            keySource: { url: 'https://console.anthropic.com/settings/keys', free: 'Pay per use' },
            fields: [{ id: 'key', label: 'API key', placeholder: 'sk-ant-…', secret: true }],
        },
        {
            id: 'openai', name: 'OpenAI', kind: 'brain', group: 'direct',
            surfaces: ['api-keys', 'onboarding'],
            auth: AUTH.API_KEY, required: true, adapter: ADAPTER.SHIPPED,
            unlocks: 'GPT models',
            keySource: { url: 'https://platform.openai.com/api-keys', free: 'Pay per use' },
            fields: [{ id: 'key', label: 'API key', placeholder: 'sk-…', secret: true }],
        },
        {
            // Filtered out of the picker unless already stored — no OpenAI-compatible
            // endpoint, so the server cannot route it. Kept so an existing key still
            // renders and can be removed. See api-keys.js _visibleProviders().
            id: 'bedrock', name: 'Amazon Bedrock', kind: 'brain', group: 'direct',
            surfaces: ['api-keys'],
            auth: AUTH.API_KEY, required: true, adapter: ADAPTER.SHIPPED,
            unlocks: 'Nova models',
            keySource: { url: 'https://console.aws.amazon.com/iam/', free: 'Pay per use' },
            note: 'Not routable directly — OpenRouter covers Nova instead.',
            fields: [
                { id: 'accessKeyId', label: 'Access key ID', placeholder: 'AKIA…', secret: true },
                { id: 'secretAccessKey', label: 'Secret access key', placeholder: '', secret: true },
                { id: 'region', label: 'Region', placeholder: 'us-east-1', secret: false },
            ],
        },
        {
            id: 'hermes', name: 'Hermes', kind: 'brain', group: 'direct',
            surfaces: ['voice-ai'],
            auth: AUTH.API_KEY, required: true, adapter: ADAPTER.SHIPPED,
            unlocks: 'A self-hosted or third-party OpenAI-compatible endpoint',
            keySource: { url: '', free: 'Your own server' },
            fields: [{ id: 'key', label: 'API key', placeholder: '', secret: true }],
        },

        // ── Tools ────────────────────────────────────────────────────────────
        // Every one optional. Each has a working fallback, so a household that
        // configures none of these still has a functioning assistant — that is
        // what makes "bring your brain key, optionally a search key" true rather
        // than aspirational.
        {
            id: 'tavily', name: 'Tavily', kind: 'tool', group: 'search',
            surfaces: ['api-keys', 'onboarding'],
            auth: AUTH.API_KEY, required: false, adapter: ADAPTER.PENDING,
            unlocks: 'Web search',
            keySource: { url: 'https://app.tavily.com/home', free: '1,000 searches a month, no card' },
            note: 'The recommended search provider — the only one with a real free tier.',
            fields: [{ id: 'key', label: 'API key', placeholder: 'tvly-…', secret: true }],
        },
        {
            // Kept working for anyone who already has a key; not recommended.
            // Brave ended its free tier in Feb 2026 — a new signup needs a card
            // with no spend cap, which is not something to send a household into.
            id: 'brave', name: 'Brave Search', kind: 'tool', group: 'search',
            surfaces: ['api-keys', 'onboarding'],
            auth: AUTH.API_KEY, required: false, adapter: ADAPTER.PENDING,
            unlocks: 'Web search',
            keySource: { url: 'https://brave.com/search/api/', free: 'No free tier since Feb 2026' },
            note: 'Card required with no spend cap. Prefer Tavily unless you already have a key.',
            deprioritised: true,
            fields: [{ id: 'key', label: 'API key', placeholder: 'BSA…', secret: true }],
        },
        {
            id: 'deepgram', name: 'Deepgram', kind: 'tool', group: 'speech',
            surfaces: ['api-keys', 'onboarding'],
            auth: AUTH.API_KEY, required: false, adapter: ADAPTER.PENDING,
            unlocks: 'Faster, more accurate speech-to-text',
            keySource: { url: 'https://console.deepgram.com/signup', free: '$200 credit, no card' },
            note: 'An upgrade over Home Assistant’s built-in Whisper, which works without any key.',
            fields: [{ id: 'key', label: 'API key', placeholder: '', secret: true }],
        },
        {
            id: 'elevenlabs', name: 'ElevenLabs', kind: 'tool', group: 'speech',
            surfaces: ['api-keys', 'onboarding'],
            auth: AUTH.API_KEY, required: false, adapter: ADAPTER.PENDING,
            unlocks: 'More natural text-to-speech',
            keySource: { url: 'https://elevenlabs.io/app/settings/api-keys', free: 'Free tier is non-commercial, with attribution' },
            note: 'An upgrade over Home Assistant’s built-in Piper, which works without any key.',
            fields: [{ id: 'key', label: 'API key', placeholder: '', secret: true }],
        },
        {
            id: 'inworld', name: 'Inworld', kind: 'tool', group: 'speech',
            surfaces: ['api-keys', 'onboarding'],
            auth: AUTH.API_KEY, required: false, adapter: ADAPTER.PENDING,
            unlocks: 'More natural text-to-speech',
            keySource: { url: 'https://platform.inworld.ai/', free: '40 minutes of speech a month' },
            note: 'Alternative to ElevenLabs.',
            fields: [{ id: 'key', label: 'API key', placeholder: '', secret: true }],
        },
        {
            id: 'pexels', name: 'Pexels', kind: 'tool', group: 'images',
            surfaces: ['api-keys', 'onboarding'],
            auth: AUTH.API_KEY, required: false, adapter: ADAPTER.PENDING,
            unlocks: 'Better image results',
            keySource: { url: 'https://www.pexels.com/api/', free: 'Free, no card' },
            note: 'Without it, images come from Wikimedia, which needs no key.',
            fields: [{ id: 'key', label: 'API key', placeholder: '', secret: true }],
        },
    ];

    /** Providers of a kind, in display order (deprioritised ones last). */
    function byKind(kind) {
        return PROVIDERS
            .filter(p => p.kind === kind)
            .sort((a, b) => (a.deprioritised ? 1 : 0) - (b.deprioritised ? 1 : 0));
    }

    /** Providers configurable on a given screen, optionally of one kind. */
    function bySurface(surface, kind) {
        return PROVIDERS
            .filter(p => (p.surfaces || []).includes(surface))
            .filter(p => !kind || p.kind === kind)
            .sort((a, b) => (a.deprioritised ? 1 : 0) - (b.deprioritised ? 1 : 0));
    }

    function byId(id) {
        return PROVIDERS.find(p => p.id === id) || null;
    }

    /** Distinct capability groups among tool providers, in first-seen order. */
    function toolGroups() {
        const seen = [];
        for (const p of byKind('tool')) if (!seen.includes(p.group)) seen.push(p.group);
        return seen;
    }

    window.ProviderManifest = { AUTH, ADAPTER, PROVIDERS, byKind, bySurface, byId, toolGroups };
})();
