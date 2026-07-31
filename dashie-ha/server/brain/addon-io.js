// brain/addon-io.js — The add-on's implementation of the brain's OrchestratorIO.
//
// The brain CORE is shared (voice-brain.bundle.js, generated from the same TS the
// Dashie cloud edge fn runs — see src/). This file is the Dashie for Home Assistant add-on's I/O
// SHELL, ported from the Dashie add-on's node-io.js.
//
// ── ONE SHELL, TWO POSTURES (Step 7 Option B, 2026-07-31) ────────────────────────
// Every account-backed capability below branches on ONE input: `accountToken`, the
// add-on's own Dashie JWT (auth.getValidJwt). That single `if` is the whole gating
// model — account presence first, entitlement second — in the one place a reader
// would look for it.
//
//   SIGNED OUT (no accountToken) — the open, no-account posture:
//     - callGateway   → any OpenAI-compatible endpoint (Ollama / llama.cpp / vLLM /
//                       LM Studio / a BYOK cloud provider's compat URL). Identical
//                       in both postures — the AI always runs on the user's own box
//                       or key on this route.
//     - personality   → base prompt (null) until the persona/config system is ported.
//     - credits       → fail-open; billing 'byok' means the core never rejects a turn
//                       on balance — the AI runs on the user's own endpoint/key.
//     - metered tools → OFF (web search / image retrieval are hosted, account-billed
//                       services; without an account there is nothing to bill them to).
//     - logging       → local console only; no cloud interaction log without an account.
//     NOTHING here contacts a Dashie service. PRIVACY.md's local-mode paragraph
//     ("no Dashie service is contacted — no account, no telemetry, no version ping")
//     stays true VERBATIM, because the branch keys on the presence of the very thing
//     local mode is defined by lacking. The cloud config module is not even REQUIRED
//     on this path (see `cloud()` below) — that is deliberate, not incidental.
//
//   SIGNED IN (accountToken present) — parity with the full Dashie add-on:
//     - web search / sports / image retrieval, under the ACCOUNT's JWT
//     - account AI toggles (webSearchEnabled / retrievePictures / zipCode)
//     - credit-aware tool gating (get_credit_balance)
//     - turns land in the Console's History tab (log_ai_interaction, byok:true —
//       recorded, never debited: the AI tokens ran on the user's own key/model)
//     - the account's "Keep transcripts" opt-in
//
// Still stubbed in BOTH postures: personality (`resolvePersonality: async () => null`).
// The full tree fixed this (FB41) but its fix needs a real @supabase/supabase-js client
// (personality.ts makes ~10 PostgREST .from() queries), and taking that dependency is a
// deliberate image-size + local-mode-posture decision we have not made. Deferred on
// purpose — see 20260731_STEP7_DECISION_BRIEF.md §5 item 3. Everything else in this file
// uses raw `fetch` so the dependency stays out.

'use strict';

// Sampling temperature by call INTENT (see Dashie 20260714_LOCAL_MODEL_BENCHMARK_RESULTS
// "DECIDE-vs-NARRATE"): routing/action emission is a classification — sample
// deterministically; prose synthesis keeps warmth.
const TEMPERATURE = { decide: 0, narrate: 0.7 };

/** Balance answer when there is nothing (or nobody) to read. The core with
 *  billing:'byok' never REJECTS a turn on !spendable — it only disables the
 *  Dashie-funded tools — so failing open here risks at most one paid tool call
 *  that debitBalance floors later. */
const FAIL_OPEN_SPEND = { spendable: true, balance: Number.POSITIVE_INFINITY, floor: 0, low: false };

/** The Dashie Cloud connection, required LAZILY.
 *
 *  Never a top-level `require`: on the signed-out path nothing below calls this, so a
 *  box with no account never even loads the module that names a Dashie endpoint. That
 *  is the machine-checkable form of the PRIVACY.md local-mode claim, and it keeps this
 *  file loadable standalone (addon-io.test.ts requires it directly). */
function cloud() {
    return require('../config').CLOUD;
}

/** Fire-and-forget POST to the database-operations edge fn under the account JWT
 *  (mirrors the cloud brain's logging.ts). Never throws — logging must not break a
 *  turn. No token → skip (nothing to attribute). */
async function postDbOp(token, operation, data) {
    if (!token) return;
    try {
        const CLOUD = cloud();
        await fetch(`${CLOUD.url}/functions/v1/database-operations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: CLOUD.anonKey,
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ operation, data }),
        });
    } catch { /* fire-and-forget */ }
}

/**
 * @param {object} opts
 * @param {string} [opts.endpoint]      Base URL of the model server (no trailing /v1).
 * @param {string} [opts.chatUrl]       FULL /chat/completions URL — overrides endpoint.
 * @param {string} opts.model           Default model id.
 * @param {string} [opts.key]           Bearer key (blank for local Ollama/llama.cpp).
 * @param {string} [opts.providerLabel] Human name prefixed onto HTTP errors.
 * @param {string} [opts.accountToken]  The add-on's Dashie JWT, or '' when signed out.
 *                                      THE gate for every account-backed member below.
 * @param {function} [opts.log]
 */
function createAddonIO({ endpoint, chatUrl: chatUrlOpt, model, key = '', providerLabel = '', accountToken = '', extraHeaders = {}, extraBody = {}, log = console.log }) {
    // endpoint may be a base URL (we append /v1/chat/completions — Ollama/llama.cpp/vLLM)
    // or a FULL chat-completions URL for providers whose compat path differs
    // (Gemini: .../v1beta/openai/chat/completions, OpenRouter: .../api/v1/chat/completions).
    const base = String(endpoint || '').replace(/\/+$/, '');
    const chatUrl = chatUrlOpt || (/\/chat\/completions$/.test(base) ? base : base + '/v1/chat/completions');
    const authHeaders = { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extraHeaders };
    const signedIn = !!accountToken;

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

    // ── Runtime-invariant members ────────────────────────────────────────────────
    const io = {
        callGateway,
        resolvePersonality: async () => null,   // base prompt in BOTH postures — see header
        // BYOK: the AI tokens run on the user's own key/model, so an empty balance must
        // never reject the turn (the AI costs Dashie nothing). The core disables the
        // Dashie-funded tools instead.
        billing: 'byok',
        getDefaultModel: async () => model,
        // Operator visibility on a box with no cloud log. Kept in BOTH postures — the
        // add-on's stdout is the only turn-level diagnostic an HA user has.
        logInteraction: (token, data) => {
            try { log(`[brain] turn: type=${data?.response_type || '?'} model=${data?.model || '?'}`); } catch { /* never breaks a turn */ }
            // byok:true = recorded, NEVER debited. Required for cataloged model ids (a BYO
            // Gemini key running gemini-*-flash would otherwise bill Dashie credits); renders
            // as "model (API key)" in the usage views instead of a charge.
            if (signedIn) return postDbOp(token || accountToken, 'log_ai_interaction', { ...data, byok: true });
        },
    };

    if (!signedIn) {
        // ── Signed out: no account to bill, nothing to attribute, nobody to log to ──
        return {
            ...io,
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
            // Runbook F / invariant I4; regression-tested in orchestrator.test.ts + addon-io.test.ts.
            paidTools: false,
            checkSpendable: async () => FAIL_OPEN_SPEND,
            readAccountAiConfig: async () => ({ model: null, webSearchEnabled: false, retrievePicturesEnabled: false, zipCode: null }),
            toolConn: { supabaseUrl: '', anonKey: '' },   // no hosted tool backend without an account
            logWebSearch: () => {},
            logSports: () => {},
            readRetainTranscripts: async () => false,
        };
    }

    // ── Signed in: the account-backed shell (parity with the full add-on) ────────
    const CLOUD = cloud();
    return {
        ...io,
        // The SAME gateway edge fn the cloud brain's gather.ts calls. Throws on failure —
        // the core's web_search branch already degrades a failed search.
        //
        // ⚠️ Second arg is the TURN'S AUTH TOKEN, not an options bag. node-io.js:139 names it
        // `opts` and destructures {provider, count} out of it — which silently yields the
        // defaults every time (destructuring a JWT string), and sends `Bearer ${anonKey}`.
        // web-search-gateway:97 rejects bare-anon behind `gateway_auth_enforce`; that flag is
        // observe-only TODAY, so the anon shape works right up until the flag flips and then
        // dies silently. Send the account JWT.
        runWebSearch: async (query, authToken) => {
            const t0 = Date.now();
            const resp = await fetch(`${CLOUD.url}/functions/v1/web-search-gateway`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    apikey: CLOUD.anonKey,
                    Authorization: `Bearer ${authToken || accountToken}`,
                },
                body: JSON.stringify({ provider: 'tavily', query, options: { count: 10 } }),
            });
            const body = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(body.error || body.message || `HTTP ${resp.status}`);
            if (typeof body.latency !== 'number') body.latency = Date.now() - t0;
            return body;
        },
        // Sports: bound straight from the brain bundle (it calls the sports-gateway edge fn
        // — included, not billed). Pass the Supabase conn explicitly: there is no Deno env
        // here. `jwt` is the same landmine as runWebSearch — sports-gateway:83 gates on the
        // Bearer's `sub`, so the anon key is a today-only shape. Falls back to the empty
        // stub on an old bundle.
        runSports: async (query, authToken) => {
            const brain = require('./voice-brain.bundle.js');
            if (typeof brain.runSports !== 'function') {
                return { provider: 'none', query, games: [], result_count: 0, latency: 0 };
            }
            return brain.runSports(query, {
                supabaseUrl: CLOUD.url,
                anonKey: CLOUD.anonKey,
                jwt: authToken || accountToken,
            });
        },
        // `paidTools` is deliberately ABSENT here (not `true`): the contract type is
        // `paidTools?: false` and the core reads `io.paidTools !== false`. Absent = the
        // cloud shell's behaviour — the account default and the request override decide,
        // exactly as they do on the metered brain. Pinned by addon-io.test.ts.
        //
        // CR1 balance read for the BYOK tool gate. get_credit_balance is the same read the
        // console uses. Fails open (see FAIL_OPEN_SPEND).
        checkSpendable: async () => {
            try {
                const resp = await fetch(`${CLOUD.url}/functions/v1/database-operations`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        apikey: CLOUD.anonKey,
                        Authorization: `Bearer ${accountToken}`,
                    },
                    body: JSON.stringify({ operation: 'get_credit_balance', data: {} }),
                });
                const body = await resp.json().catch(() => ({}));
                const balance = Number(body?.data?.balance ?? body?.balance);
                if (!resp.ok || !isFinite(balance)) return FAIL_OPEN_SPEND;
                return { spendable: balance > 0, balance, floor: 0, low: balance > 0 && balance < 1 };
            } catch { return FAIL_OPEN_SPEND; }
        },
        // Account tool toggles (T3 parity with the cloud brain's ai-settings.ts): without
        // this the core resolves retrieve_pictures to FALSE and the model hallucinates
        // "Here's a picture of Oslo" with no way to show one. `model` stays null: on this
        // runtime the model is already resolved by the caller (ai.model here can be a routing
        // sentinel like 'local'/'hermes', which must not leak into a turn).
        readAccountAiConfig: async () => {
            try {
                const a = await require('../account-config').getAccountVoiceConfig();
                return {
                    model: null,
                    webSearchEnabled: a.webSearchEnabled ?? null,
                    retrievePicturesEnabled: a.retrievePictures ?? null,
                    zipCode: a.zipCode || null,
                };
            } catch {
                return { model: null, webSearchEnabled: null, retrievePicturesEnabled: null, zipCode: null };
            }
        },
        // Supabase connection for core-side tools that reach edge fns over HTTP (image
        // search) — there is no Deno env in Node, so the core must get it from here.
        toolConn: { supabaseUrl: CLOUD.url, anonKey: CLOUD.anonKey },
        logWebSearch: (token, data) => postDbOp(token || accountToken, 'log_web_search', data),
        logSports: (token, data) => postDbOp(token || accountToken, 'log_sports', data),
        // The account's "Keep transcripts" opt-in. With the integration's caller-mode the
        // brain signals metadata.retain_transcript → the integration stores it HA-locally →
        // the Console overlays it onto the interaction by session_id.
        readRetainTranscripts: async () => {
            try { return (await require('../account-config').getAccountVoiceConfig()).retainTranscripts === true; }
            catch { return false; }
        },
    };
}

module.exports = { createAddonIO };
