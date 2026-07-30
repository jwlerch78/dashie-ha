// brain/addon-io.js — The add-on's implementation of the brain's OrchestratorIO.
//
// The brain CORE is shared (voice-brain.bundle.js, generated from the same TS the
// Dashie cloud edge fn runs — see src/). This file is the Dashie for Home Assistant add-on's I/O
// SHELL, ported from the Dashie add-on's node-io.js and trimmed for the open,
// no-account posture:
//
//   - callGateway   → any OpenAI-compatible endpoint (Ollama / llama.cpp / vLLM /
//                     LM Studio / a BYOK cloud provider's compat URL). Kept verbatim.
//   - personality   → base prompt (null) until the persona/config system is ported.
//   - credits       → fail-open; billing 'byok' means the core never rejects a turn
//                     on balance — the AI runs on the user's own endpoint/key.
//   - metered tools → OFF (web search / image retrieval are hosted, account-billed
//                     services; without an account there is nothing to bill them to).
//   - logging       → local console only; no cloud interaction log without an account.
//
// Hosted mode (Dashie Cloud credits) re-enables the account-backed pieces later.

'use strict';

// Sampling temperature by call INTENT (see Dashie 20260714_LOCAL_MODEL_BENCHMARK_RESULTS
// "DECIDE-vs-NARRATE"): routing/action emission is a classification — sample
// deterministically; prose synthesis keeps warmth.
const TEMPERATURE = { decide: 0, narrate: 0.7 };

/**
 * @param {object} opts
 * @param {string} [opts.endpoint]      Base URL of the model server (no trailing /v1).
 * @param {string} [opts.chatUrl]       FULL /chat/completions URL — overrides endpoint.
 * @param {string} opts.model           Default model id.
 * @param {string} [opts.key]           Bearer key (blank for local Ollama/llama.cpp).
 * @param {string} [opts.providerLabel] Human name prefixed onto HTTP errors.
 * @param {function} [opts.log]
 */
function createAddonIO({ endpoint, chatUrl: chatUrlOpt, model, key = '', providerLabel = '', extraHeaders = {}, extraBody = {}, log = console.log }) {
    // endpoint may be a base URL (we append /v1/chat/completions — Ollama/llama.cpp/vLLM)
    // or a FULL chat-completions URL for providers whose compat path differs
    // (Gemini: .../v1beta/openai/chat/completions, OpenRouter: .../api/v1/chat/completions).
    const base = String(endpoint || '').replace(/\/+$/, '');
    const chatUrl = chatUrlOpt || (/\/chat\/completions$/.test(base) ? base : base + '/v1/chat/completions');
    const authHeaders = { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extraHeaders };

    async function callGateway({ provider, prompt, modelId, kind = 'narrate' }) {
        const t0 = Date.now();
        const useModel = modelId || model;
        try {
            const resp = await fetch(chatUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({
                    model: useModel,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: TEMPERATURE[kind] ?? 0.7,
                    stream: false,
                    ...extraBody,
                }),
            });
            const body = await resp.json().catch(() => ({}));
            const latency_ms = Date.now() - t0;
            if (!resp.ok) {
                const error = body?.error?.message || body?.error || `HTTP ${resp.status}`;
                const msg = typeof error === 'string' ? error : JSON.stringify(error);
                return { ok: false, error: providerLabel ? `${providerLabel}: ${msg}` : msg, latency_ms };
            }
            const content = body?.choices?.[0]?.message?.content ?? '';
            const u = body?.usage || {};
            return {
                ok: true,
                latency_ms,
                raw: {
                    content,
                    usage: {
                        input_tokens: u.prompt_tokens,
                        output_tokens: u.completion_tokens,
                        total_tokens: u.total_tokens,
                    },
                    model: body?.model || useModel,
                    provider: providerLabel ? providerLabel.toLowerCase() : 'local',
                    latency: latency_ms,
                },
            };
        } catch (e) {
            return { ok: false, error: (e && e.message) || String(e), latency_ms: Date.now() - t0 };
        }
    }

    return {
        callGateway,
        // Hosted, account-billed tools — inert without an account. The core's tool
        // branches degrade on a throw / empty result; the toggles below keep it from
        // offering them in the first place.
        runWebSearch: async () => { throw new Error('web search is not available without a Dashie account'); },
        runSports: async (query) => ({ provider: 'none', query, games: [], result_count: 0, latency: 0 }),
        // Image search has no hook here — the core resolves it inline — so the refusal
        // must be DECLARED. Without this, a caller passing retrieve_pictures:true
        // re-enabled it (the request override beats the account default by design, and
        // checkSpendable below fails open so a BYOK turn can run), and the only thing
        // that kept the call away from Dashie was the empty toolConn making the URL
        // relative so fetch threw at parse. Off by rule now, not by coincidence.
        // Runbook F / invariant I4; regression-tested in orchestrator.test.ts.
        paidTools: false,
        resolvePersonality: async () => null,   // base prompt until personas are ported
        checkSpendable: async () => ({ spendable: true, balance: Number.POSITIVE_INFINITY, floor: 0, low: false }),
        readAccountAiConfig: async () => ({ model: null, webSearchEnabled: false, retrievePicturesEnabled: false, zipCode: null }),
        billing: 'byok',
        toolConn: { supabaseUrl: '', anonKey: '' },   // no hosted tool backend in open mode
        logInteraction: (_token, data) => {
            try { log(`[brain] turn logged locally: type=${data?.response_type || '?'} model=${data?.model || '?'}`); } catch { /* never breaks a turn */ }
        },
        logWebSearch: () => {},
        logSports: () => {},
        getDefaultModel: async () => model,
        readRetainTranscripts: async () => false,
    };
}

module.exports = { createAddonIO };
