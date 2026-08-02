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
//   auth        HOW you configure it, not what it is. See AUTH below. Renderers
//               dispatch on this rather than on `id` because eleven providers
//               share a handful of shapes, so a new provider is a line here
//               rather than a branch in a growing if/else.
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
//               key exists yet. Storing and validating a key is one piece of
//               work; the adapter that spends it is another. A
//               provider with adapter:'pending' must never be reported as
//               working — the console would be asserting something nobody
//               observed.
//   capabilities WHAT this provider can serve: 'llm' · 'search' · 'stt' · 'tts' ·
//               'images' · 'sports'. The registry was implicitly LLM-only before
//               this existed, which is why a tool provider had nowhere to say
//               what it was for.
//   credential  how the stored secret behaves: { expires, refreshable }. A pasted
//               API key is {false,false} — it stays valid until someone revokes
//               it. Not every credential works that way, and nothing here
//               refreshes anything: this exists so the STATE is expressible,
//               because code that assumes a credential is valid forever is code
//               that has to be found and rewritten the first time one isn't.
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
     * Auth shapes this build knows.
     *
     * The renderer registry dispatches on these, so adding a shape is adding a
     * renderer — never a branch inside an existing one. NONE is listed
     * explicitly so that "nothing to configure" is a shape rather than an
     * absence: a provider with no settings still has state worth reporting.
     *
     * The set is deliberately open. `ProviderAuthRenderers.register()` and
     * `registerReadiness()` let a build that ships additional providers add
     * their shape at runtime without this file naming it — which keeps the
     * dispatch generic rather than turning every future shape into an edit here.
     */
    const AUTH = {
        NONE: 'none',
        API_KEY: 'api-key',
    };

    /** What a provider can serve. */
    const CAP = {
        LLM: 'llm', SEARCH: 'search', STT: 'stt',
        TTS: 'tts', IMAGES: 'images', SPORTS: 'sports',
    };

    /** A pasted API key stays valid until it is revoked — it does not lapse. */
    const CRED_STATIC = Object.freeze({ expires: false, refreshable: false });

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
            capabilities: [CAP.LLM], credential: CRED_STATIC,
            auth: AUTH.API_KEY, required: true, adapter: ADAPTER.SHIPPED,
            unlocks: 'Every model in the picker, from one key',
            keySource: { url: 'https://openrouter.ai/keys', free: 'Pay per use, no subscription' },
            note: 'Covers Claude and Nova too, which a direct key cannot serve yet.',
            fields: [{ id: 'key', label: 'API key', placeholder: 'sk-or-v1-…', secret: true }],
        },
        {
            id: 'gemini', name: 'Google Gemini', kind: 'brain', group: 'direct',
            surfaces: ['api-keys', 'onboarding'],
            capabilities: [CAP.LLM], credential: CRED_STATIC,
            auth: AUTH.API_KEY, required: true, adapter: ADAPTER.SHIPPED,
            unlocks: 'Gemini models',
            keySource: { url: 'https://aistudio.google.com/apikey', free: 'Free tier available' },
            fields: [{ id: 'key', label: 'API key', placeholder: 'AIza…', secret: true }],
        },
        {
            id: 'claude', name: 'Anthropic Claude', kind: 'brain', group: 'direct',
            surfaces: ['api-keys', 'onboarding'],
            capabilities: [CAP.LLM], credential: CRED_STATIC,
            auth: AUTH.API_KEY, required: true, adapter: ADAPTER.SHIPPED,
            unlocks: 'Claude models',
            keySource: { url: 'https://console.anthropic.com/settings/keys', free: 'Pay per use' },
            fields: [{ id: 'key', label: 'API key', placeholder: 'sk-ant-…', secret: true }],
        },
        {
            id: 'openai', name: 'OpenAI', kind: 'brain', group: 'direct',
            surfaces: ['api-keys', 'onboarding'],
            capabilities: [CAP.LLM], credential: CRED_STATIC,
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
            capabilities: [CAP.LLM], credential: CRED_STATIC,
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
            capabilities: [CAP.LLM], credential: CRED_STATIC,
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
            capabilities: [CAP.SEARCH], credential: CRED_STATIC,
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
            capabilities: [CAP.SEARCH], credential: CRED_STATIC,
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
            capabilities: [CAP.STT], credential: CRED_STATIC,
            auth: AUTH.API_KEY, required: false, adapter: ADAPTER.PENDING,
            unlocks: 'Faster, more accurate speech-to-text',
            keySource: { url: 'https://console.deepgram.com/signup', free: '$200 credit, no card' },
            note: 'An upgrade over Home Assistant’s built-in Whisper, which works without any key.',
            fields: [{ id: 'key', label: 'API key', placeholder: '', secret: true }],
        },
        {
            id: 'elevenlabs', name: 'ElevenLabs', kind: 'tool', group: 'speech',
            surfaces: ['api-keys', 'onboarding'],
            capabilities: [CAP.TTS], credential: CRED_STATIC,
            auth: AUTH.API_KEY, required: false, adapter: ADAPTER.PENDING,
            unlocks: 'More natural text-to-speech',
            keySource: { url: 'https://elevenlabs.io/app/settings/api-keys', free: 'Free tier is non-commercial, with attribution' },
            note: 'An upgrade over Home Assistant’s built-in Piper, which works without any key.',
            fields: [{ id: 'key', label: 'API key', placeholder: '', secret: true }],
        },
        {
            id: 'inworld', name: 'Inworld', kind: 'tool', group: 'speech',
            surfaces: ['api-keys', 'onboarding'],
            capabilities: [CAP.TTS], credential: CRED_STATIC,
            auth: AUTH.API_KEY, required: false, adapter: ADAPTER.PENDING,
            unlocks: 'More natural text-to-speech',
            keySource: { url: 'https://platform.inworld.ai/', free: '40 minutes of speech a month' },
            note: 'Alternative to ElevenLabs.',
            fields: [{ id: 'key', label: 'API key', placeholder: '', secret: true }],
        },
        {
            id: 'pexels', name: 'Pexels', kind: 'tool', group: 'images',
            surfaces: ['api-keys', 'onboarding'],
            capabilities: [CAP.IMAGES], credential: CRED_STATIC,
            auth: AUTH.API_KEY, required: false, adapter: ADAPTER.PENDING,
            unlocks: 'Better image results',
            keySource: { url: 'https://www.pexels.com/api/', free: 'Free, no card' },
            note: 'Without it, images come from Wikimedia, which needs no key.',
            fields: [{ id: 'key', label: 'API key', placeholder: '', secret: true }],
        },
        {
            // A LEVER, not a recommendation. Sports is keyless and ESPN-first
            // (see the `espn` entry below); this exists so that if ESPN breaks or
            // starts blocking, the fix is a key the user already can add — or a
            // default flip — rather than an emergency patch to a shipped add-on.
            //
            // Deliberately NOT on the onboarding surface. First run asks for a
            // brain key and optionally a search key; asking for a sports key that
            // ESPN already makes unnecessary would undo exactly that. It is
            // reachable from API Keys when it is needed, which is the only time
            // anyone should see it.
            id: 'apisports', name: 'API-Sports', kind: 'tool', group: 'sports',
            surfaces: ['api-keys'],
            capabilities: [CAP.SPORTS], credential: CRED_STATIC,
            auth: AUTH.API_KEY, required: false, adapter: ADAPTER.PENDING,
            unlocks: 'Scores and schedules if the default source stops working',
            keySource: { url: 'https://api-sports.io/', free: 'Free tier available' },
            note: 'Not needed normally — sports works without any key.',
            deprioritised: true,
            fields: [{ id: 'key', label: 'API key', placeholder: '', secret: true }],
        },

        // ── Keyless ──────────────────────────────────────────────────────────
        // Permanently ready: nothing to configure, nothing to expire, nothing to
        // pay. I originally left these OUT, reasoning that a provider with no
        // settings does not belong in a settings list. That was backwards for a
        // console whose job is to report state — excluding them made it silent
        // about the capabilities that already work, and left the `none` auth
        // shape with no consumer to prove it renders.
        {
            id: 'espn', name: 'ESPN', kind: 'tool', group: 'sports',
            surfaces: ['api-keys'],
            capabilities: [CAP.SPORTS], credential: CRED_STATIC,
            auth: AUTH.NONE, required: false, adapter: ADAPTER.PENDING,
            unlocks: 'Live scores and schedules',
            keySource: {},
            note: 'Public data — no account, no key, nothing to set up.',
            fields: [],
        },
        {
            id: 'wikimedia', name: 'Wikimedia', kind: 'tool', group: 'images',
            surfaces: ['api-keys'],
            capabilities: [CAP.IMAGES], credential: CRED_STATIC,
            auth: AUTH.NONE, required: false, adapter: ADAPTER.PENDING,
            unlocks: 'Image search',
            keySource: {},
            note: 'The default image source — no key needed. Pexels is an optional upgrade.',
            fields: [],
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

    /**
     * Is this capability AVAILABLE to the user?
     *
     * Deliberately not the same question the server answers. `key-store.status()`
     * reports "do I hold credentials for X", which is correctly a non-empty-string
     * test — that is what a credential store knows. Whether a capability is
     * available depends on the auth shape, and conflating the two is what made
     * a keyless provider permanently unconfigurable: it can never satisfy a
     * non-empty-string test, because it has no string.
     *
     * `serverStatus` is the boolean from /api/keys for this provider, or
     * undefined when the server does not track it (keyless providers are not in
     * the credential store — they have no credential to store).
     */
    const READINESS = {
        [AUTH.NONE]: () => true,                       // nothing to configure, always ready
        [AUTH.API_KEY]: (_p, serverStatus) => serverStatus === true,
    };

    /** A build shipping another shape registers how to read its readiness. */
    function registerReadiness(shape, fn) {
        if (READINESS[shape]) {
            console.warn(`DROP: readiness rule for auth shape '${shape}' is already ` +
                `registered — refusing to replace it.`);
            return;
        }
        READINESS[shape] = fn;
    }

    function isConfigured(provider, serverStatus) {
        const fn = READINESS[provider.auth];
        if (!fn) {
            // Fails CLOSED and loudly. An unknown shape reported as configured
            // would be the console claiming a capability it cannot verify.
            console.warn(`DROP: isConfigured() has no rule for auth shape ` +
                `'${provider.auth}' (provider '${provider.id}') — treating as ` +
                `not configured.`);
            return false;
        }
        return fn(provider, serverStatus);
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

    window.ProviderManifest = { AUTH, ADAPTER, CAP, CRED_STATIC, PROVIDERS,
        byKind, bySurface, byId, toolGroups, isConfigured, registerReadiness };
})();
