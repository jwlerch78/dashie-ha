// converse.js — the /api/voice/converse turn handler: bridge contract in, brain Turn out.
//
// The integration POSTs a VoiceRequest (CONTRACTS.md: pass-through philosophy — unknown
// fields must survive) and executes any HA actions in the returned Turn itself. This
// handler owns the route decision; v0 routes every turn to the configured
// OpenAI-compatible endpoint (add-on options llm_url / llm_model / llm_api_key).
// Hosted (Chickadee Cloud) routing arrives with the account machinery.

'use strict';

const auth = require('./auth');
const { CLOUD } = require('./config');
const { readOptions } = require('./options');
const { createChickadeeIO } = require('./brain/chickadee-io');
const brain = require('./brain/voice-brain.bundle.js');

const CLOUD_TIMEOUT_MS = 60000;

/** Hosted route: the SAME brain, run by Chickadee Cloud under the account
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
                ? 'Your Chickadee Cloud balance is empty. Add credits to keep using hosted voice.'
                : 'Chickadee Cloud could not complete that request right now.';
        }
        console.log(`CHICKADEE-BRAIN route=cloud type=${turn?.type || '?'} ok=${resp.ok && turn?.ok !== false} ` +
            `degraded=${turn?.metadata?.degraded || '-'} latency=${Date.now() - t0}ms`);
        return { status: resp.ok ? 200 : resp.status, body: turn };
    } catch (e) {
        clearTimeout(timer);
        console.error('DROP: cloud brain unreachable:', e.message);
        return speak("I couldn't reach Chickadee Cloud just now. Please try again in a moment.");
    }
}

/** Speakable 200 turn — never a bare 4xx the satellite renders as "couldn't handle". */
function speak(text) {
    return { status: 200, body: { ok: true, type: 'chat', text } };
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
    const endpoint = String(opts.llm_url || '').trim();
    const model = String(opts.llm_model || '').trim();
    // Route: a configured endpoint (BYO/local) wins; otherwise a signed-in
    // account runs on Chickadee Cloud; otherwise speak setup guidance.
    if (!endpoint || !model) {
        try {
            const { jwt } = await auth.getValidJwt();
            const nCloud = ((payload.provided_context || {}).ha_entities || []).length;
            console.log(`CHICKADEE-TURN route=cloud text="${text}" entities=${nCloud}`);
            return await converseCloud({ ...payload, text }, jwt);
        } catch (e) {
            if (e.message !== 'not_signed_in') throw e;
        }
        console.warn('DROP: converse with no brain configured (sign in, or set llm_url + llm_model in the add-on Configuration tab)');
        return speak("The Chickadee brain isn't set up yet. Sign in to Chickadee Cloud from the add-on's panel, or point me at an A.I. model server in its configuration.");
    }

    const io = createChickadeeIO({
        endpoint,
        model,
        key: String(opts.llm_api_key || ''),
    });

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
    console.log(`CHICKADEE-TURN text="${text}" endpoint_id=${brainReq.endpoint_id} ` +
        `conversation_id=${brainReq.conversation_id || '-'} entities=${nEntities} model=${model}`);

    const t0 = Date.now();
    try {
        const turn = await brain.runOrchestration(
            { req: brainReq, userId: 'local', token: '', supabase: null },
            io,
        );
        console.log(`CHICKADEE-BRAIN type=${turn?.type || '?'} ok=${turn?.ok !== false} ` +
            `latency=${Date.now() - t0}ms brain=${brain.BRAIN_SOURCE_SHA?.slice(0, 9) || '?'}`);
        return { status: 200, body: turn };
    } catch (e) {
        console.error('DROP: brain crashed:', (e && e.stack) || e);
        return { status: 500, body: { error: 'brain_error', message: (e && e.message) || String(e) } };
    }
}

module.exports = { converse };
