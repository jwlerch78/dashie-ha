// SPDX-License-Identifier: AGPL-3.0-only
// converse.js — the /api/voice/converse turn handler: bridge contract in, brain Turn out.
//
// The integration POSTs a VoiceRequest (CONTRACTS.md: pass-through philosophy — unknown
// fields must survive) and executes any HA actions in the returned Turn itself. This
// handler owns the ROUTE DECISION, in this precedence:
//
//   1.  llm_url + llm_model in the add-on's Configuration tab → this box's own endpoint
//   1b. the ACCOUNT's own local endpoint (route 'local' + a resolved localLlmUrl/Model,
//       from the engines store or the console's own-AI fields — account-config resolves
//       the three storage homes into one answer)      → the user's own box
//   2.  a stored BYO provider key that covers the CHOSEN AI model → that provider, on the
//       user's own key (brain/providers.js resolveByokTarget)
//   3.  a signed-in Dashie account                             → Dashie Cloud (metered)
//   4.  nothing                                                → spoken setup guidance
//
// 🔴 Tier 1b was MISSING until 2026-08-21, and its absence is the second instance of the
// degradation described below: account-config answered route:'local', the integration
// duly sent the turn here, and this handler — finding no Configuration-tab endpoint —
// fell through and had it answered by gemini. Measured: every X-Dashie-Brain-Route:local
// call came back model=gemini-2.5-flash while the user's own qwen3 box sat idle, logged
// and billed as a cloud turn. Same shape as the BYOK case, different input.
//
// 🔴 Routes 1-with-a-key, 2 and 3 all spend money the household pays for, and
// until 2026-08-02 NONE of them consulted household sharing — see the spend gate
// below. Route 1 with an EMPTY key spends nothing (the user's own hardware) and
// is never gated.
//
// Rule 2 landed 2026-07-31 (Step 7). It had TWO consumers waiting on it and zero
// implementations:
//   - the console tells the user "a BYO provider key unlocks a cloud-AI preset in EVERY
//     mode, including local … the brain runs BYOK without an account" (voice-ai.js
//     _hasCreditsOrKey). That was simply false — `resolveByokTarget` had no callers.
//   - /api/internal/voice-config ALREADY answers `route: 'local'` for a BYOK account
//     (account-config withRoute → resolveBrainRoute), so the integration duly sent the
//     turn here — and this handler then forwarded it to the metered cloud brain anyway.
//     A stored key validated green, routed "local", and still billed credits: the exact
//     silent degradation WS-I.8 exists to forbid.
//
// The account JWT is resolved ONCE per turn and threaded into the brain shell
// (`accountToken`) and the orchestration deps (`token`/`userId`). That one value is what
// switches addon-io between its no-account and account-backed postures — see
// brain/addon-io.js. Signed out, nothing on this path contacts a Dashie service.

'use strict';

const auth = require('./auth');
const capability = require('./capability');
const { CLOUD } = require('./config');
const { readOptions } = require('./options');
const settingsStore = require('./settings-store');
const { createAddonIO } = require('./brain/addon-io');
const { resolveByokTarget } = require('./brain/providers');
const brain = require('./brain/voice-brain.bundle.js');

const CLOUD_TIMEOUT_MS = 60000;

/** Hosted route: the SAME brain, run by Dashie Cloud under the account
 *  (metered). The VoiceRequest passes through untouched — one contract. */
async function converseCloud(payload, jwt) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CLOUD_TIMEOUT_MS);
    const t0 = Date.now();
    try {
        const resp = await fetch(`${CLOUD.url}/functions/v1/voice-conversation`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: CLOUD.anonKey,
                Authorization: `Bearer ${jwt}`,
            },
            body: JSON.stringify(payload),
            signal: ctl.signal,
        });
        clearTimeout(timer);
        const turn = await resp.json().catch(() => ({}));
        // Degraded-but-silent turns (e.g. insufficient_credits) assume a client
        // that renders its own notice — a headless satellite must SPEAK it.
        if (turn && turn.ok !== false && !turn.voice && !turn.text && turn.metadata?.degraded) {
            console.warn(`DROP-averted: cloud turn degraded=${turn.metadata.degraded} with no voice — speaking a notice`);
            turn.voice = turn.metadata.degraded === 'insufficient_credits'
                ? 'Your Dashie Cloud balance is empty. Add credits to keep using hosted voice.'
                : 'Dashie Cloud could not complete that request right now.';
        }
        console.log(`DASHIE-BRAIN route=cloud type=${turn?.type || '?'} ok=${resp.ok && turn?.ok !== false} ` +
            `degraded=${turn?.metadata?.degraded || '-'} latency=${Date.now() - t0}ms`);
        return { status: resp.ok ? 200 : resp.status, body: turn };
    } catch (e) {
        clearTimeout(timer);
        console.error('DROP: cloud brain unreachable:', e.message);
        return speak("I couldn't reach Dashie Cloud just now. Please try again in a moment.");
    }
}

/** Speakable 200 turn — never a bare 4xx the satellite renders as "couldn't handle". */
function speak(text) {
    return { status: 200, body: { ok: true, type: 'chat', text } };
}

/** The add-on's own Dashie account, or nulls when signed out. Never throws:
 *  "not signed in" is a normal, supported state on this edition. */
async function resolveAccount() {
    try {
        const { jwt, userId } = (await auth.getValidJwt()) || {};
        return { jwt: jwt || '', userId: userId || '' };
    } catch (e) {
        if (e.message !== 'not_signed_in') console.warn('DROP-averted: account resolve failed, continuing signed-out:', e.message);
        return { jwt: '', userId: '' };
    }
}

/** Which AI model has this box been told to use? Signed in that's the ACCOUNT's
 *  ai.model (user_settings); signed out it's the account-less console blob the
 *  Voice & AI page writes to /api/settings/local. Either way it's just a model
 *  ID — the only question rule 2 asks is "does a stored key cover it?". */
async function chosenModel(signedIn) {
    if (signedIn) {
        try { return (await require('./account-config').getAccountVoiceConfig()).model || ''; }
        catch { return ''; }
    }
    try { return String(settingsStore.readUserSettings()?.ai?.model || ''); }
    catch { return ''; }
}

/**
 * Run one turn. Auth (bridge secret) is checked by the caller (index.js).
 * @param {object} payload parsed VoiceRequest body
 * @returns {Promise<{status: number, body: object}>}
 */
async function converse(payload) {
    const text = String(payload.text || '').trim();
    if (!text) return { status: 400, body: { error: 'bad_request', message: 'text is required' } };

    const opts = readOptions();
    const { jwt, userId } = await resolveAccount();
    const endpoint = String(opts.llm_url || '').trim();
    const optModel = String(opts.llm_model || '').trim();
    // Cached with a TTL inside account-config, so this is not a per-turn round trip.
    // Signed out there is no account to ask, and a read failure must not take voice
    // out — it degrades to the tiers below, which is what happened before this tier
    // existed at all.
    const acct = jwt
        ? await require('./account-config').getAccountVoiceConfig().catch(() => null)
        : null;

    // ── Route (see the file header for the precedence and why) ──────────────────
    let shell = null;      // createAddonIO options for an on-box/BYOK turn
    let routeTag = '';     // for the DASHIE-TURN log line
    let metered = false;   // does this route spend the household's money?
    if (endpoint && optModel) {
        shell = { endpoint, model: optModel, key: String(opts.llm_api_key || '') };
        routeTag = 'local';
        // The KEY decides, not the route: empty means Ollama on the user's own
        // hardware and no money moves; non-empty means a paid endpoint.
        metered = !!shell.key.trim();
    } else if (acct?.route === 'local' && acct.localLlmUrl && acct.localLlmModel) {
        // ── TIER 1b — the ACCOUNT's own local endpoint (added 2026-08-21) ───────
        //
        // 🔴 This is the tier whose absence made "local" mean gemini. account-config
        // ALREADY resolved the endpoint and ALREADY answered route:'local' — its header
        // even says it exists "→ endpoint + model for the LAN inference call" — and this
        // handler never read it, so a turn the integration correctly sent here as local
        // fell through to BYOK/cloud and was answered, logged and BILLED as a cloud turn.
        //
        // That is verbatim the degradation this file's own header calls forbidden: "a
        // stored key validated green, routed 'local', and still billed credits — the exact
        // silent degradation WS-I.8 exists to forbid." Same shape, different input: BYOK
        // then, the account's own box now.
        //
        // Below the Configuration tab deliberately: a box-level override stays the most
        // specific answer. Same key-decides metering rule as tier 1 — a keyless Ollama on
        // the user's own hardware spends nothing and is never gated.
        shell = { endpoint: acct.localLlmUrl, model: acct.localLlmModel, key: String(acct.localLlmKey || '') };
        routeTag = 'local:account';
        metered = !!shell.key.trim();
    } else {
        const byok = resolveByokTarget(await chosenModel(!!jwt));
        if (byok) {
            // `byok.model` is the WIRE id (our catalog id direct, `vendor/model` via
            // OpenRouter) — send THAT, not the catalog id the account stored.
            shell = {
                chatUrl: byok.chatUrl,
                model: byok.model,
                key: byok.key,
                providerLabel: byok.label,
                extraHeaders: byok.headers || {},
            };
            routeTag = `byok:${byok.provider}`;
            metered = true;   // the household's own provider key, always
        }
    }

    // ── 🔴 THE SPEND GATE (added 2026-08-02, D's ruling) ───────────────────────
    //
    // This handler had NO sharing check on ANY of its four routes. The
    // credential-VENDING lane (`/api/internal/*`) was gated from birth; the lane
    // that actually SPENDS was not — so with household sharing off, a satellite
    // turn arriving through HA-Assist still spent the household's BYOK key, and
    // on a signed-in box still spent account CREDITS. Both editions.
    //
    // Why the gate is at HOUSEHOLD scope here and per-device on the other lane:
    // the lease governs what the box LENDS A SATELLITE, and on this lane the box
    // lends nothing — Home Assistant asks, and the box spends on its own behalf.
    // There is no satellite in the transaction to attach a lease to, and none
    // could be attached anyway: `conversation.py` hardcodes `endpoint_id:
    // "ha-voice"`, so a per-device check here would be gating a constant. The
    // household is the only party this lane can name. (Per-device revocation on
    // this lane is deferred, not rejected — it needs the device to identify
    // itself on the assist frames, and a gate keyed on an identity only SOME
    // satellites send is a coverage map nobody can see.)
    if (metered && !(await capability.readHouseholdSharing())) {
        console.warn(`SPEND: refused route=${routeTag} reason=sharing_disabled account=${jwt ? 'yes' : 'no'}`);
        return speak(
            "Voice sharing is turned off for this household, so I can't use the shared A.I. right now. " +
            "Turn household sharing back on in the Dashie panel to use it again.",
        );
    }

    if (!shell) {
        if (jwt) {
            // Route 3 is metered too — Dashie Cloud spends the account's credits.
            // It is checked here rather than above because it is the fall-through:
            // `shell` stays null precisely when neither on-box route applied.
            if (!(await capability.readHouseholdSharing())) {
                console.warn('SPEND: refused route=cloud reason=sharing_disabled account=yes');
                return speak(
                    "Voice sharing is turned off for this household, so I can't use Dashie Cloud right now. " +
                    "Turn household sharing back on in the Dashie panel to use it again.",
                );
            }
            const nCloud = ((payload.provided_context || {}).ha_entities || []).length;
            console.log(`DASHIE-TURN route=cloud text="${text}" entities=${nCloud}`);
            return await converseCloud({ ...payload, text }, jwt);
        }
        console.warn('DROP: converse with no brain configured (sign in, add a provider API key, or set llm_url + llm_model in the add-on Configuration tab)');
        return speak("The Dashie brain isn't set up yet. Sign in to Dashie Cloud from the add-on's panel, or point me at an A.I. model server in its configuration.");
    }

    const model = shell.model;
    // accountToken is THE gate: present → the account-backed shell (tools, credit-aware
    // gating, console History); absent → the no-account shell (no Dashie service contacted).
    const io = createAddonIO({ ...shell, accountToken: jwt });

    // Pass-through: forward the request as received, defaulting only what the brain
    // requires. options.model pins the turn to the configured model.
    const brainReq = {
        ...payload,
        text,
        conversation_id: payload.conversation_id || null,
        endpoint_id: payload.endpoint_id || 'ha-voice',
        language: payload.language || 'system',
        options: { ...(payload.options || {}), model },
        provided_context: payload.provided_context || null,
    };

    const nEntities = ((payload.provided_context || {}).ha_entities || []).length;
    console.log(`DASHIE-TURN route=${routeTag} account=${jwt ? 'yes' : 'no'} text="${text}" ` +
        `endpoint_id=${brainReq.endpoint_id} conversation_id=${brainReq.conversation_id || '-'} ` +
        `entities=${nEntities} model=${model}`);

    const t0 = Date.now();
    try {
        const turn = await brain.runOrchestration(
            // token/userId carry the ACCOUNT when there is one: the core threads `token`
            // into logInteraction, the web-search/sports gateways and image-search
            // attribution. Signed out they stay ''/'local' — the pre-Step-7 shape, and the
            // shell refuses every account-backed call anyway.
            { req: brainReq, userId: userId || 'local', token: jwt || '', supabase: null },
            io,
        );
        console.log(`DASHIE-BRAIN type=${turn?.type || '?'} ok=${turn?.ok !== false} ` +
            `latency=${Date.now() - t0}ms brain=${brain.BRAIN_SOURCE_SHA?.slice(0, 9) || '?'}`);
        return { status: 200, body: turn };
    } catch (e) {
        console.error('DROP: brain crashed:', (e && e.stack) || e);
        return { status: 500, body: { error: 'brain_error', message: (e && e.message) || String(e) } };
    }
}

module.exports = { converse };
