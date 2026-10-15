// SPDX-License-Identifier: AGPL-3.0-only
// server/gemini-tts-lane.js — the Gemini voice, paid by the household's key OR by account credits,
// always the SAME voice (John 10-11; O: the key decides who pays, never which voice speaks).
//
// Two entry points, one per consumer:
//   streamWithKey   — a TABLET (via dashie_voice's streaming view, path K) asks for Gemini audio as it
//                     is generated. Serves on the household key, or answers 409 so the tablet pays with
//                     credits ITSELF (it calls the edge gemini-tts directly; nothing here spends credits
//                     for a tablet):
//                       409 {reason:'no_key'}                          no Gemini key on this box
//                       409 {reason:'key_failed', provider, status}    the KEY failed before any audio
//                                                                      (status ∈ PILL_STATUSES): credits pay
//                       502 {reason:'provider_failed', provider, status}  Google failed but NOT the key
//                                                                      (an outage, a timeout): nobody pays,
//                                                                      the tablet does not use credits (John
//                                                                      10-12, "Yes - A"). status = the vocab.
//                     🔴 On key_failed the account row is written BEFORE the 409 goes out
//                     (key-health.reportFailure is awaited): the tablet force-refreshes its balance read
//                     on that 409, and the pill must already be there when it does.
//   creditsBuffered — an HA SPEAKER (the integration's TTS entity, which needs whole audio) whose key
//                     failed or is absent: the edge gemini-tts on the account's credits, wrapped as WAV.
//
// The SSE→PCM conversion and the request body are GENERATED from the edge's own module
// (generated/gemini-tts-stream.js), so key audio and credits audio are converted by the same code.
// Voice: gemini-tts.js geminiVoiceOrDefault, one answer for every Gemini path on this box.

'use strict';

const { Readable } = require('node:stream');
const keyStore = require('./key-store');
const geminiTts = require('./gemini-tts');
const keyHealth = require('./key-health');
const { recordLocalUsage } = require('./usage-store');
const { pcmToWav } = require('./wav-header');
const { classifyKeyFailure } = require('./generated/key-health-vocab');
const { sseToPcm, geminiTtsBody, GEMINI_TTS_STREAM_URL } = require('./generated/gemini-tts-stream');
const { providerFetch } = require('./provider-fetch');   // every Google call: the dev fault switch

const FIRST_BYTE_TIMEOUT_MS = 15_000;   // headers from Google; the stream itself may run longer
const MAX_CHARS = 5000;

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}

function readGeminiKey() {
    try { return keyStore.readKeys()?.gemini?.key || ''; } catch { return ''; }
}

/**
 * POST /api/voice/tts with {stream:true} — Gemini audio on the household key, streamed as raw
 * pcm_24000, or a 409 telling the tablet to pay with credits. Never spends credits itself.
 */
async function streamWithKey(res, { text, voice }) {
    const clean = String(text || '').slice(0, MAX_CHARS);
    if (!clean.trim()) { sendJson(res, 400, { error: 'bad_request', message: 'text is required' }); return; }
    const key = readGeminiKey();
    if (!key) { sendJson(res, 409, { reason: 'no_key' }); return; }

    const voiceName = geminiVoiceForCall(voice);
    const model = geminiTts.DEFAULT_MODEL;
    const t0 = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FIRST_BYTE_TIMEOUT_MS);
    let resp;
    try {
        resp = await providerFetch(GEMINI_TTS_STREAM_URL(model), {
            method: 'POST',
            headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
            body: JSON.stringify(geminiTtsBody(clean, voiceName)),
            signal: ctl.signal,
        });
    } catch (e) {
        clearTimeout(timer);
        await keyFailed(res, model, classifyKeyFailure(null), e?.name === 'AbortError' ? 'timeout' : (e?.message || 'fetch failed'));
        return;
    }
    clearTimeout(timer);
    if (!resp.ok) {
        const errorText = (await resp.text().catch(() => '')).slice(0, 600);   // classification only, never logged
        await keyFailed(res, model, classifyKeyFailure(resp.status, errorText), `HTTP ${resp.status}`);
        return;
    }

    // From here Google has accepted the request and bills it; the 200 is committed.
    res.writeHead(200, {
        'Content-Type': 'audio/pcm', 'X-Audio-Format': 'pcm_24000', 'X-Streaming': '1',
        // X-Tts-Provider: the tablet checks the lane that answered is the one it asked for (an older add-on
        // ignores voice_provider and would answer an ElevenLabs request in the Gemini voice).
        'X-Tts-Payer': 'key', 'X-Tts-Provider': 'gemini', 'Cache-Control': 'no-store',
    });
    let firstAt = null, bytes = 0, usage = null;
    const pcm = Readable.fromWeb(resp.body.pipeThrough(sseToPcm({
        onFirstAudio: () => { firstAt = Date.now() - t0; keyHealth.reportOk('gemini'); },
        onUsage: (u) => { usage = u; },
        onDrop: (why) => console.warn(`DROP: gemini-tts-stream ${why}`),
    })));
    pcm.on('data', (c) => { bytes += c.length; });
    pcm.on('error', (e) => {
        // After the 200 a 409 is impossible: end the audio short, loudly. Not a key failure (the key
        // was accepted); the tablet sees a truncated stream.
        console.warn(`DROP: gemini-tts-stream mid-stream error after ${bytes} bytes: ${e?.message || e}`);
        res.end();
    });
    pcm.on('end', () => {
        recordLocalUsage({
            lane: 'tts', provider: 'gemini', model, billing: 'byok', success: bytes > 0,
            units: { characters: clean.length,
                ...(usage ? { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens } : {}) },
        });
        console.log(`DASHIE-TTS route=byok-stream provider=gemini voice=${voiceName} chars=${clean.length} bytes=${bytes} first_audio=${firstAt ?? 'none'}ms total=${Date.now() - t0}ms`);
    });
    pcm.pipe(res);
}

/** The call failed before any audio. The KEY's fault: write the row FIRST, then 409 (credits pay).
 *  Anything else (an outage, a timeout): 502 provider_failed, no row, and nobody pays for it. */
async function keyFailed(res, model, status, why) {
    recordLocalUsage({ lane: 'tts', provider: 'gemini', model, billing: 'byok', success: false, units: {} });
    if (!keyHealth.isKeyFault(status)) {
        console.warn(`DROP: gemini-tts-stream provider-failed status=${status} (${why}) → 502, not the key's fault: no credits`);
        sendJson(res, 502, { reason: 'provider_failed', provider: 'gemini', status });
        return;
    }
    console.warn(`DROP: gemini-tts-stream key-failed status=${status} (${why}) → 409, the tablet pays with credits`);
    await keyHealth.reportFailure('gemini', status);
    sendJson(res, 409, { reason: 'key_failed', provider: 'gemini', status });
}

/** The voice name a Gemini call on this box uses; the credits fallback passes the SAME name. */
function geminiVoiceForCall(voice) {
    return geminiTts.geminiVoiceOrDefault(voice);
}

/**
 * HA-speaker fallback: the edge gemini-tts on the account's credits, the same voice name, as WAV.
 * Resolves to { ok:true, audio, contentType } or { ok:false, status, error }. Never throws.
 */
async function creditsBuffered({ text, voice, jwt }) {
    const CLOUD = require('./config').CLOUD;
    const voiceName = geminiVoiceForCall(voice);
    const t0 = Date.now();
    try {
        const resp = await fetch(`${CLOUD.url}/functions/v1/gemini-tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: CLOUD.anonKey, Authorization: `Bearer ${jwt}` },
            body: JSON.stringify({ text: String(text || '').slice(0, MAX_CHARS), voice_id: voiceName, record_usage: true }),
        });
        if (!resp.ok) {
            // 402 = no credits (checked before any paid call). The body is ours; take only the status.
            console.warn(`DROP: gemini-tts credits HTTP ${resp.status}`);
            return { ok: false, status: resp.status === 402 ? 402 : 502, error: resp.status === 402 ? 'insufficient_credits' : 'tts_engine_error' };
        }
        const pcm = Buffer.from(await resp.arrayBuffer());
        if (!pcm.length) return { ok: false, status: 502, error: 'tts_engine_error', message: 'empty audio' };
        console.log(`DASHIE-TTS route=credits provider=gemini voice=${voiceName} bytes=${pcm.length} latency=${Date.now() - t0}ms`);
        return { ok: true, audio: pcmToWav(pcm, { sampleRate: 24000, channels: 1 }), contentType: 'audio/wav' };
    } catch (e) {
        console.warn(`DROP: gemini-tts credits unreachable: ${e?.message || e}`);
        return { ok: false, status: 504, error: 'tts_unreachable' };
    }
}

module.exports = { streamWithKey, creditsBuffered, geminiVoiceForCall, FIRST_BYTE_TIMEOUT_MS };
