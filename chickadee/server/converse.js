// converse.js — the /api/voice/converse turn handler: bridge contract in, brain Turn out.
//
// The integration POSTs a VoiceRequest (CONTRACTS.md: pass-through philosophy — unknown
// fields must survive) and executes any HA actions in the returned Turn itself. This
// handler owns the route decision; v0 routes every turn to the configured
// OpenAI-compatible endpoint (add-on options llm_url / llm_model / llm_api_key).
// Hosted (Chickadee Cloud) routing arrives with the account machinery.

'use strict';

const { readOptions } = require('./options');
const { createChickadeeIO } = require('./brain/chickadee-io');
const brain = require('./brain/voice-brain.bundle.js');

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
    if (!endpoint || !model) {
        console.warn('DROP: converse with no brain configured (set llm_url + llm_model in the add-on Configuration tab)');
        return speak("The Chickadee brain isn't set up yet. In the add-on's configuration, point me at an A.I. model server, then try again.");
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
