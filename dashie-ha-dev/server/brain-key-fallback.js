// SPDX-License-Identifier: AGPL-3.0-only
// server/brain-key-fallback.js — the brain's half of "key first, then credits" (John 2026-10-12:
// "LLM should be the same as TTS and STT - key first then credits"; "BYOK is HA-only").
//
// A household-key (BYOK) turn whose provider REFUSES the key is re-asked of Dashie Cloud on the
// account's credits, so the person still gets an answer, and the key's fault is reported to the
// account first so every tablet shows the "Voice key error" pill. Before this, the turn was LOST:
// the core spoke "replace the key" for every question until someone did.
//
// Why here and not a 409 for the caller to retry (the TTS pattern): /api/voice/converse has TWO
// callers, the tablet and the HA integration. A 409 would need the same fallback in Kotlin AND
// Python, which cannot ship together. Re-asking from here is the route-3 cloud call this add-on
// already makes for a keyless account, decided later; both callers just get a normal turn.
//
// The rules, each a leg in scripts/check-brain-key-fallback.mjs:
//   - KEY FAULTS ONLY, judged by the SHARED vocabulary (generated/key-health-vocab.js): 401, 403,
//     429, and Gemini's 400 API_KEY_INVALID. An outage (5xx), a timeout or our own malformed request
//     is not the key's fault: no fallback, no pill, the turn ends as it did.
//   - PASS 1 ONLY: the refusal must be the turn's FIRST model call and the turn must have ended there.
//     Between pass 1 and pass 2 the core can run paid tools (web search, sports); re-asking after
//     pass 2 would run and bill them twice. A pass-2 refusal keeps the spoken key error.
//   - REPORT FIRST: the key-health row is written (awaited) before the cloud call, as on TTS.
//   - NO CREDITS / NO CLOUD → the ORIGINAL turn. If the cloud answers insufficient_credits, or cannot
//     be reached, "replace the key" is the only honest answer, so the household hears that.
//   - SIGNED OUT → no fallback: there is no account to bill.
// The household-sharing gate is NOT repeated: a BYOK turn is `metered`, so converse.js already
// passed the same household check the cloud route makes.

'use strict';

const { classifyKeyFailure } = require('./generated/key-health-vocab');

/** Wrap the brain's io so the turn's model calls can be read afterwards. Returns the wrapped io and
 *  a reader: how many calls ran, and the first call the PROVIDER refused (its answer and which call it
 *  was). Nothing about the call is changed. A refusal is any answer carrying an HTTP status; a call that
 *  never got an answer (timeout, unreachable) carries none, and is not the key's fault. */
function watchCalls(io) {
    const seen = { calls: 0, refused: null, refusedAt: 0 };
    const inner = io.callGateway;
    const watched = {
        ...io,
        callGateway: async (args) => {
            const n = ++seen.calls;
            const r = await inner(args);
            if (!seen.refused && r && !r.ok && typeof r.http_status === 'number') { seen.refused = r; seen.refusedAt = n; }
            return r;
        },
    };
    return { io: watched, seen: () => ({ ...seen }) };
}

/**
 * After a BYOK turn: decide whether to re-ask Dashie Cloud. Resolves null to keep the turn as it is,
 * or a { status, body, routeTag } to return instead.
 * @param {object} o
 * @param {string} o.provider    the BYOK provider id (resolveByokTarget: gemini / openai / openrouter …)
 * @param {object} o.turn        the turn the brain produced
 * @param {{calls:number, first:object|null}} o.seen   from watchCalls
 * @param {string} o.jwt         the account JWT, '' signed out
 * @param {function} o.askCloud  () → converseCloud's result for this same request
 * @param {object} o.keyHealth   server/key-health.js (a parameter so the gate can watch the order)
 */
async function afterByokTurn({ provider, turn, seen, jwt, askCloud, keyHealth }) {
    if (!seen.calls) return null;
    const refused = seen.refused;
    const status = refused ? classifyKeyFailure(refused.http_status, String(refused.error_body || '')) : null;
    if (!refused || !keyHealth.isKeyFault(status)) {
        // No key fault this turn (an outage or our own request is not one): if the provider answered
        // at all, the key was accepted, so a stale pill is cleared. The turn stands either way.
        if (!refused || seen.refusedAt > 1) keyHealth.reportOk(provider);
        return null;
    }
    await keyHealth.reportFailure(provider, status);               // BEFORE any fallback (tablet pill)
    if (seen.refusedAt !== 1 || seen.calls !== 1 || (turn && turn.ok !== false)) {
        console.warn(`DROP: brain key refused (${provider} ${status}) at call ${seen.refusedAt} of ${seen.calls} ` +
            `— after pass 1, so NOT re-asking the cloud (tools may already have run and billed); the key error stands`);
        return null;
    }
    if (!jwt) {
        console.warn(`DROP: brain key refused (${provider} ${status}) and signed out — no credits to fall back on; the key error stands`);
        return null;
    }
    const cloud = await askCloud();
    const degraded = cloud?.body?.metadata?.degraded;
    if (cloud?.unreachable || cloud?.status !== 200 || degraded === 'insufficient_credits') {
        console.warn(`DROP: brain key refused (${provider} ${status}) and Dashie Cloud could not pay ` +
            `(${cloud?.unreachable ? 'unreachable' : degraded || `HTTP ${cloud?.status}`}) — the key error stands`);
        return null;
    }
    console.log(`BRAIN-FALLBACK: byok ${provider} refused (${status}, HTTP ${refused.http_status}) → Dashie Cloud on account credits`);
    return { status: cloud.status, body: cloud.body, routeTag: `byok:${provider}→cloud` };
}

module.exports = { watchCalls, afterByokTurn };
