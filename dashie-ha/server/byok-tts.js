// SPDX-License-Identifier: AGPL-3.0-only
// server/byok-tts.js — BOX-PROXIED text-to-speech with the household's OWN key.
//
// John's ruling (2026-08-04): fork (a), TTS first. The key stays on the box and
// the box makes the provider call. The alternative — handing the raw key to the
// device over the lease — was rejected because it breaks the promise
// `api/keys.js` makes in writing ("it never leaves the box"), and because it
// would leave the speech lane with no place to observe usage at all.
//
// ── WHERE THIS SITS, AND WHY IT IS NOT A NEW ROUTE ───────────────────────────
//
// 🔴 The design proposal said "new `/api/voice/tts`". That route ALREADY EXISTS
// — `index.js:131` registers it as a bridge (secret-gated) handler ahead of the
// console router, so a second `/tts` added to `api/voice-console.js` would be
// shadowed and never reached. It would have reviewed as real work and been
// unreachable by every caller: the component/outcome trap, one more time.
//
// So this is not a route. It is a BRANCH inside the lane's existing single choke
// point, `engines.handleTts` — which is also, happily, exactly the one capture
// point per lane that the usage contract wanted (D's §9 Q2).
//
// ── ORDER OF PRECEDENCE, decided here and stated so it can be overruled ──────
//
//   1. `tts_url`  — an explicit per-lane engine URL in the add-on Configuration
//                   tab. The most specific instruction the operator can give.
//   2. BYOK       — this file. A stored speech key has exactly one meaning.
//   3. Dashie Cloud — the account path, when signed in.
//   4. 503        — unconfigured.
//
// ⚠️ The new branch fires ONLY where the old code would have gone to cloud-or-
// 503, so no existing install changes behaviour unless it holds a speech key.
// The one judgement call is BYOK ahead of the account: a signed-in box with an
// ElevenLabs key spends the key, not the account's credits. That follows from
// what storing the key means, and `capability.js` already treats a stored speech
// key as household money — but it is a product call, so it is one ordered `if`
// in one function rather than something woven through the lane.
//
// ── PORTED FROM THE EDGE FUNCTION, NOT RE-DERIVED ────────────────────────────
//
// `supabase/functions/elevenlabs-tts/index.ts` is the shape: same endpoint, same
// default voice/model, same voice_settings, same 5,000-character bound. Two
// lessons come with it and both are about METERING, not audio:
//
// 🔴 (1) METER WHEN SYNTHESIS IS COMMITTED, NOT WHEN THE BYTES LAND. A 2xx from
//    the provider means it has synthesised and will bill for the full character
//    count regardless of how much audio the caller ends up playing. The edge
//    function learned this the expensive way: it metered in a stream's `flush()`,
//    and a client that cancelled mid-playback aborted the read so `flush()` never
//    fired and the turn went UNBILLED. We buffer rather than stream, which makes
//    the window small — but the rule is recorded at the point it applies, because
//    the moment anyone adds streaming here it becomes load-bearing again.
//
// 🔴 (2) THE SAME CLASS, ON THE STT SIDE — FORWARD `Finalize`, NEVER CLOSE.
//    `deepgram-stt-stream` used to close the socket when the client endpointed;
//    Deepgram had audio buffered but not finalised, so the tail of the sentence
//    was discarded and the client fell back to a truncated interim. Forwarding
//    `Finalize` flushes it into a real final transcript and leaves the socket
//    usable. Written here rather than left in the edge function because THIS is
//    the file the STT twin will be built beside, and the shape is not guessable
//    from the API docs — both failures look like "it mostly works".

'use strict';

const keyStore = require('./key-store');
const { recordLocalUsage } = require('./usage-store');
// B2b (row 80): the per-turn history. Gated inside turn-log — this lane just reports.
const turnLog = require('./turn-log');

const TTS_TIMEOUT_MS = 60000;
const MAX_CHARS = 5000;

/**
 * The providers this box can actually SPEND a key with.
 *
 * 🔴 A key in `key-store.PROVIDERS` means STORED. Membership HERE means SPENT.
 * The two lists are deliberately different sizes: `deepgram` (STT) and `inworld`
 * (a second TTS) are storable today and have no adapter, which is exactly what
 * the console manifest's `adapter: 'pending'` says about them. Adding a row here
 * without an adapter would make that claim false in the one direction nobody
 * checks.
 */
const ADAPTERS = {
    elevenlabs: {
        // Rachel — the edge function's default, kept identical so a household
        // that has heard Dashie's cloud voice hears the same voice here.
        defaultVoice: '21m00Tcm4TlvDq8ikWAM',
        defaultModel: 'eleven_flash_v2_5',
        async synth({ key, text, voice, model }) {
            const resp = await fetchWithTimeout(
                `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
                {
                    method: 'POST',
                    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        text,
                        model_id: model,
                        voice_settings: {
                            stability: 0.5, similarity_boost: 0.75,
                            style: 0.0, use_speaker_boost: true,
                        },
                    }),
                },
            );
            return { resp, contentType: 'audio/mpeg' };
        },
    },
};

function fetchWithTimeout(url, init) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TTS_TIMEOUT_MS);
    return fetch(url, { ...init, signal: ctl.signal }).finally(() => clearTimeout(timer));
}

/**
 * Which BYOK provider would serve this lane, or null.
 *
 * The join both this file and the console need: **a key is present AND an
 * adapter exists.** Neither half alone is an answer — a stored key with no
 * adapter is the inert-credential state, and an adapter with no key cannot run.
 * One function so the picker's "this row needs a key" and this lane's "can I
 * serve" can never drift into two implementations.
 */
function resolveProvider() {
    let status;
    try { status = keyStore.status(); } catch { return null; }
    for (const id of Object.keys(ADAPTERS)) {
        if (status[id] === true) return id;
    }
    return null;
}

/** True when a BYOK TTS provider is both keyed and adapted on this box. */
function available() {
    return resolveProvider() !== null;
}

/**
 * Synthesise one utterance. Resolves to `{ ok, status, audio, contentType,
 * provider, model, error }` — never throws, so the lane's error shape stays the
 * lane's.
 *
 * The key is read here, used here, and never returned, logged or attached to the
 * result. Nothing above this function ever holds it.
 */
async function synthesize({ text, voice, model }) {
    const provider = resolveProvider();
    if (!provider) return { ok: false, status: 503, error: 'byok_tts_unavailable' };

    const adapter = ADAPTERS[provider];
    const clean = String(text || '').slice(0, MAX_CHARS);
    if (!clean) return { ok: false, status: 400, error: 'bad_request' };

    const useVoice = String(voice || '').trim() || adapter.defaultVoice;
    const useModel = String(model || '').trim() || adapter.defaultModel;

    let key = '';
    try { key = keyStore.readKeys()[provider]?.key || ''; } catch { key = ''; }
    if (!key) {
        // resolveProvider() said yes and the read said no — a store that changed
        // under us, or a partially-written entry. Loud, because the two answers
        // disagreeing is a fact about this box, not about this request.
        console.warn(`DROP: byok-tts key vanished between status and read (provider=${provider})`);
        return { ok: false, status: 503, error: 'byok_tts_unavailable' };
    }

    const t0 = Date.now();
    let resp, contentType;
    try {
        ({ resp, contentType } = await adapter.synth({ key, text: clean, voice: useVoice, model: useModel }));
    } catch (e) {
        const msg = e?.name === 'AbortError' ? `timed out (${TTS_TIMEOUT_MS}ms)` : (e?.cause?.code || e?.message || 'fetch failed');
        console.warn(`DROP: byok-tts unreachable provider=${provider}: ${msg}`);
        recordLocalUsage({ lane: 'tts', provider, model: useModel, billing: 'byok', success: false, units: {} });
        return { ok: false, status: 504, error: 'tts_unreachable', message: msg };
    }

    if (!resp.ok) {
        // The body can echo the request; take only the status into the log.
        console.warn(`DROP: byok-tts provider HTTP ${resp.status} (provider=${provider})`);
        recordLocalUsage({ lane: 'tts', provider, model: useModel, billing: 'byok', success: false, units: {} });
        return { ok: false, status: 502, error: 'tts_engine_error', message: `HTTP ${resp.status}` };
    }

    // 🔴 Lesson (1) above: the provider has committed and will bill for the full
    // character count from here on, so the record is written BEFORE the bytes go
    // anywhere. It is not conditioned on the caller receiving them.
    recordLocalUsage({
        lane: 'tts', provider, model: useModel, billing: 'byok',
        success: true, units: { characters: clean.length },
    });
    turnLog.recordTurnIfEnabled({
        lane: 'tts', provider, model: useModel, billing: 'byok',
        success: true, latency_ms: null, units: { characters: clean.length },
    });

    const audio = Buffer.from(await resp.arrayBuffer());
    console.log(`DASHIE-TTS route=byok provider=${provider} chars=${clean.length} bytes=${audio.length} latency=${Date.now() - t0}ms`);
    return { ok: true, status: 200, audio, contentType: contentType || 'audio/mpeg', provider, model: useModel };
}

module.exports = { ADAPTERS, resolveProvider, available, synthesize, MAX_CHARS };
