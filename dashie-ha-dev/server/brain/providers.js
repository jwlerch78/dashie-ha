// server/brain/providers.js — BYO-key provider resolution for the add-on brain (Open Brain
// plan 20260710_OPEN_BRAIN_BYOK_PRESETS_UI.md §5, WS-C).
//
// One question, answered in one place: given the account's chosen AI model and the box's
// key store, WHERE does the brain run and WHAT endpoint does node-io hit?
//
//   ai.model = 'local' | 'hermes'      → add-on brain, user's own endpoint (pre-existing)
//   ai.model = cloud id + BYO key set  → add-on brain, that provider's OpenAI-compatible
//                                        endpoint with the stored key (this module)
//   anything else                      → cloud edge fn (Dashie credits)
//
// v1 BYOK providers are the OpenAI-compatible set: OpenAI + Gemini (its /openai compat
// surface) + Hermes. Claude and Bedrock keys can be STORED (key-store.js) but need thin
// protocol adapters (Anthropic messages / SigV4) — deferred, so a stored claude/bedrock key
// deliberately does NOT flip routing (turns stay on the metered cloud brain, which is not a
// silent-degradation case: nothing was promised to run on that key yet).
//
// The model→provider prefix sniff is ported from the cloud brain
// (supabase/functions/voice-conversation/models.ts) minus the catch-all: models.ts defaults
// unknown ids to 'claude' because it must always pick a gateway lane, but here an unknown id
// (e.g. 'home_assistant', '') must mean "not a BYOK candidate", never "claude".

const keyStore = require('../key-store');

/** Model id → provider id, or null when the id doesn't look like a known cloud model. */
function providerForModel(modelId) {
    if (!modelId || typeof modelId !== 'string') return null;
    const id = modelId.toLowerCase();
    if (id.startsWith('claude-')) return 'claude';
    if (id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3')) return 'openai';
    if (id.startsWith('gemini-')) return 'gemini';
    if (id.startsWith('us.amazon.') || id.startsWith('bedrock-') || id.includes('nova')) return 'bedrock';
    return null;
}

/** Providers node-io can serve today: OpenAI-compatible /chat/completions with a bearer.
 *  chatUrl is the FULL completions URL (Gemini's compat path isn't /v1/...). */
const OPENAI_COMPAT = {
    openai: { chatUrl: 'https://api.openai.com/v1/chat/completions', label: 'OpenAI' },
    gemini: { chatUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', label: 'Gemini' },
    // Anthropic ships an OpenAI-compat surface (Authorization: Bearer <key>, our catalog's
    // claude-* ids verbatim) — verified live 2026-07-14: POST returns an OpenAI-shaped 401,
    // not a 404. So Claude BYOK needs NO Anthropic-messages adapter, just this row. Before
    // this, a stored Claude key validated green and then silently did NOTHING (turns still
    // billed Dashie credits) — the exact silent-degradation WS-I.8 forbids.
    claude: { chatUrl: 'https://api.anthropic.com/v1/chat/completions', label: 'Claude' },
    openrouter: { chatUrl: 'https://openrouter.ai/api/v1/chat/completions', label: 'OpenRouter' },
};

/** Providers whose stored key ACTUALLY changes routing. The console renders a key field only
 *  for these (+ any provider that already has an orphaned key, so it can still be removed) —
 *  a structural guard against re-introducing a field that silently does nothing.
 *  `hermes` routes via ai.model==='hermes' rather than OPENAI_COMPAT, so it's added by hand.
 *  `bedrock` is deliberately ABSENT: it needs SigV4 request signing and has no compat endpoint;
 *  its Nova models are covered by OpenRouter instead. */
const ROUTABLE_PROVIDERS = [...Object.keys(OPENAI_COMPAT), 'hermes'];

/** OUR model id → OpenRouter wire id ("one key, every model", John 2026-07-14).
 *
 *  OpenRouter proxies every model in our catalog over an OpenAI-compatible endpoint, so an
 *  OpenRouter key alone lights up the WHOLE picker — including claude-* and the Nova
 *  (bedrock) ids, which direct-key BYOK still can't serve (they'd need the deferred
 *  Anthropic-messages / SigV4 adapters). All 14 catalog ids verified present on
 *  GET https://openrouter.ai/api/v1/models (2026-07-14).
 *
 *  Explicit table, NOT a derivation rule: the transforms differ per family (claude dashes →
 *  dots, bedrock strips `us.` and `:0`), and an unmapped model must resolve to "no OpenRouter
 *  route" rather than a guessed slug that 404s at request time. Add a row when the catalog
 *  gains a model (js/ai/ai-models-catalog.js). */
const OPENROUTER_MODELS = {
    'claude-sonnet-4-6':          'anthropic/claude-sonnet-4.6',
    'claude-opus-4-8':            'anthropic/claude-opus-4.8',
    'claude-haiku-4-5':           'anthropic/claude-haiku-4.5',
    'gpt-5.5':                    'openai/gpt-5.5',
    'gpt-5.4':                    'openai/gpt-5.4',
    'gpt-5.4-mini':               'openai/gpt-5.4-mini',
    'gpt-5.4-nano':               'openai/gpt-5.4-nano',
    'gemini-3.5-flash':           'google/gemini-3.5-flash',
    'gemini-2.5-flash':           'google/gemini-2.5-flash',
    'gemini-3.1-flash-lite':      'google/gemini-3.1-flash-lite',
    'gemini-2.5-pro':             'google/gemini-2.5-pro',
    'us.amazon.nova-2-lite-v1:0': 'amazon/nova-2-lite-v1',
    'us.amazon.nova-pro-v1:0':    'amazon/nova-pro-v1',
    'us.amazon.nova-micro-v1:0':  'amazon/nova-micro-v1',
};

/** Can an OpenRouter key serve this model? (mapped id + a stored openrouter key) */
function openRouterCovers(modelId) {
    return !!OPENROUTER_MODELS[modelId] && !!keyStore.status().openrouter;
}

/**
 * Should this account's brain run in the add-on, and why?
 * @param {object} acct  getAccountVoiceConfig() result (needs .model)
 * @returns {{route: 'local'|'cloud', reason: 'local_model'|'hermes'|'byok'|'cloud', provider?: string}}
 */
function resolveBrainRoute(acct) {
    const model = acct?.model || null;
    if (model === 'hermes') return { route: 'local', reason: 'hermes' };
    if (model === 'local') return { route: 'local', reason: 'local_model' };
    const provider = providerForModel(model);
    // Direct provider key first (cheaper — no OpenRouter margin — and the more specific
    // configuration), then OpenRouter as the universal fallback for anything else.
    if (provider && OPENAI_COMPAT[provider] && keyStore.status()[provider]) {
        return { route: 'local', reason: 'byok', provider };
    }
    if (openRouterCovers(model)) return { route: 'local', reason: 'byok', provider: 'openrouter' };
    return { route: 'cloud', reason: 'cloud' };
}

/**
 * Resolve the concrete inference target for a BYOK cloud model. Returns null when the model has
 * neither a direct provider key (with an adapter) nor OpenRouter coverage — callers surface an
 * EXPLICIT error (degradation rule WS-I.8: never silently fall back to the metered Dashie brain).
 *
 * Precedence: direct key → OpenRouter. `model` in the result is the WIRE id to send (our catalog
 * id for a direct call, the `vendor/model` slug for OpenRouter) — callers must use it, not acct.model.
 * @returns {{chatUrl: string, key: string, provider: string, label: string, model: string} | null}
 */
function resolveByokTarget(model) {
    const provider = providerForModel(model);
    if (provider && OPENAI_COMPAT[provider]) {
        const entry = keyStore.readKeys()[provider];
        if (entry && entry.key) {
            return {
                chatUrl: OPENAI_COMPAT[provider].chatUrl, key: entry.key, provider,
                label: OPENAI_COMPAT[provider].label, model,
            };
        }
    }
    // OpenRouter fallback: proxies the whole catalog (incl. claude-* / Nova, which direct-key
    // BYOK still can't serve) over the same OpenAI-compatible path, under one key.
    const orModel = OPENROUTER_MODELS[model];
    if (orModel) {
        const entry = keyStore.readKeys().openrouter;
        if (entry && entry.key) {
            return {
                chatUrl: OPENAI_COMPAT.openrouter.chatUrl, key: entry.key, provider: 'openrouter',
                label: 'OpenRouter', model: orModel,
                // OpenRouter's app-attribution headers (optional, but they rank/allow-list on them).
                headers: { 'HTTP-Referer': 'https://github.com/jwlerch78/dashie-ha-console', 'X-Title': 'Dashie' },
            };
        }
    }
    return null;
}

/** Free key-validation probes: each provider's model-LIST endpoint (GET, no
 *  completion) → 200 = key valid, 401/403 = key rejected. Listing models bills
 *  nothing, so this answers "is my key good?" without a charge. Claude uses the
 *  Anthropic header shape (x-api-key + version), not a bearer. */
const VALIDATE = {
    openai: { url: 'https://api.openai.com/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
    gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
    claude: { url: 'https://api.anthropic.com/v1/models', headers: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }) },
    // /key returns the key's own metadata (label, limit, usage) — auth-required and free,
    // so it's the right no-charge probe. (/models is PUBLIC on OpenRouter and would 200
    // for a garbage key, which would make the Test button lie.)
    openrouter: { url: 'https://openrouter.ai/api/v1/key', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
};

/**
 * Validate a stored provider key WITHOUT spending anything (a free /models GET).
 * @returns {Promise<{ok: boolean|null, detail: string}>}
 *   ok:true  key works · ok:false key rejected/absent/unreachable · ok:null no test for this provider.
 */
async function validateProvider(provider) {
    const spec = VALIDATE[provider];
    if (!spec) return { ok: null, detail: 'No no-charge test available for this provider yet.' };
    const entry = keyStore.readKeys()[provider];
    if (!entry || !entry.key) return { ok: false, detail: 'No key is stored — save one first.' };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
        const resp = await fetch(spec.url, { headers: spec.headers(entry.key), signal: ctl.signal });
        clearTimeout(timer);
        if (resp.ok) {
            let n = null;
            try { const j = await resp.json(); n = Array.isArray(j?.data) ? j.data.length : null; } catch { /* body optional */ }
            return { ok: true, detail: n != null ? `Key is valid (${n} models available).` : 'Key is valid.' };
        }
        if (resp.status === 401 || resp.status === 403) return { ok: false, detail: `Key was rejected (HTTP ${resp.status}) — check it and re-save.` };
        return { ok: false, detail: `Unexpected response (HTTP ${resp.status}).` };
    } catch (e) {
        clearTimeout(timer);
        return { ok: false, detail: e?.name === 'AbortError' ? 'Timed out reaching the provider (8s).' : (e?.message || 'Could not reach the provider.') };
    }
}

module.exports = { providerForModel, resolveBrainRoute, resolveByokTarget, validateProvider, OPENAI_COMPAT, ROUTABLE_PROVIDERS };
