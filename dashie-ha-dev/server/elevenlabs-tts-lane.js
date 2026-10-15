// SPDX-License-Identifier: AGPL-3.0-only
// server/elevenlabs-tts-lane.js — an ElevenLabs voice for a TABLET, streamed on the household's OWN
// ElevenLabs key (John 2026-10-15: personality voices "should be available with an elevenlabs key").
//
// The tablet asks for it through dashie_voice's streaming view (path K) with
// {stream:true, voice_provider:'elevenlabs', voice:<ElevenLabs voice id>}, the same route as the Gemini
// lane (gemini-tts-lane.js), and gets the same answers, so the tablet reads both with one parser:
//   200 audio/pcm (pcm_24000), X-Tts-Provider: elevenlabs     the household key paid
//   409 {reason:'no_key'}                                      no ElevenLabs key on this box
//   409 {reason:'key_failed', provider, status}                the KEY failed before any audio (status ∈ PILL_STATUSES)
//   502 {reason:'provider_failed', provider, status}           ElevenLabs failed, NOT the key (John 10-12 "Yes - A")
// Never spends credits: what the tablet does next is its own ladder (CloudTtsRouter / TtsLadder.kt).
// 🔴 On key_failed the account row is written BEFORE the 409 (key-health.reportFailure is awaited), as in the
// Gemini lane: the tablet force-refreshes its balance read on that 409 and the pill must already be there.

'use strict';

const { Readable } = require('node:stream');
const keyStore = require('./key-store');
const keyHealth = require('./key-health');
const { recordLocalUsage } = require('./usage-store');
const { classifyKeyFailure } = require('./generated/key-health-vocab');
const { providerFetch } = require('./provider-fetch');

const PROVIDER = 'elevenlabs';
const MODEL = 'eleven_flash_v2_5';               // the tablet's and byok-tts.js's ElevenLabs model (latency)
const FIRST_BYTE_TIMEOUT_MS = 15_000;
const MAX_CHARS = 5000;
const STREAM_URL = (voice) =>
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=pcm_24000`;

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}

function readKey() {
    try { return keyStore.readKeys()?.elevenlabs?.key || ''; } catch { return ''; }
}

/** POST /api/voice/tts with {stream:true, voice_provider:'elevenlabs'}: ElevenLabs on the household key, or a refusal. */
async function streamWithKey(res, { text, voice }) {
    const clean = String(text || '').slice(0, MAX_CHARS);
    if (!clean.trim()) { sendJson(res, 400, { error: 'bad_request', message: 'text is required' }); return; }
    // The tablet always names the voice (the personality's own or its alternate). No silent default:
    // a missing voice would speak a voice nobody chose.
    const voiceId = String(voice || '').trim();
    if (!voiceId) {
        console.warn('DROP: elevenlabs-tts-stream no voice id → 400');
        sendJson(res, 400, { error: 'bad_request', message: 'voice is required' });
        return;
    }
    const key = readKey();
    if (!key) { sendJson(res, 409, { reason: 'no_key' }); return; }

    const t0 = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FIRST_BYTE_TIMEOUT_MS);
    let resp;
    try {
        resp = await providerFetch(STREAM_URL(voiceId), {
            method: 'POST',
            headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: clean, model_id: MODEL,
                voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
            }),
            signal: ctl.signal,
        });
    } catch (e) {
        clearTimeout(timer);
        await keyFailed(res, classifyKeyFailure(null), e?.name === 'AbortError' ? 'timeout' : (e?.message || 'fetch failed'));
        return;
    }
    clearTimeout(timer);
    if (!resp.ok) {
        const errorText = (await resp.text().catch(() => '')).slice(0, 600);   // classification only, never logged
        await keyFailed(res, classifyKeyFailure(resp.status, errorText), `HTTP ${resp.status}`);
        return;
    }

    res.writeHead(200, {
        'Content-Type': 'audio/pcm', 'X-Audio-Format': 'pcm_24000', 'X-Streaming': '1',
        'X-Tts-Payer': 'key', 'X-Tts-Provider': PROVIDER, 'Cache-Control': 'no-store',
    });
    let firstAt = null, bytes = 0;
    const pcm = Readable.fromWeb(resp.body);
    pcm.on('data', (c) => {
        if (firstAt === null) { firstAt = Date.now() - t0; keyHealth.reportOk(PROVIDER); }
        bytes += c.length;
    });
    pcm.on('error', (e) => {
        console.warn(`DROP: elevenlabs-tts-stream mid-stream error after ${bytes} bytes: ${e?.message || e}`);
        res.end();
    });
    pcm.on('end', () => {
        recordLocalUsage({ lane: 'tts', provider: PROVIDER, model: MODEL, billing: 'byok', success: bytes > 0,
            units: { characters: clean.length } });
        console.log(`DASHIE-TTS route=byok-stream provider=${PROVIDER} voice=${voiceId} chars=${clean.length} bytes=${bytes} first_audio=${firstAt ?? 'none'}ms total=${Date.now() - t0}ms`);
    });
    pcm.pipe(res);
}

/** Failed before any audio. The KEY's fault: row FIRST, then 409. Anything else: 502, no row, nobody pays. */
async function keyFailed(res, status, why) {
    recordLocalUsage({ lane: 'tts', provider: PROVIDER, model: MODEL, billing: 'byok', success: false, units: {} });
    if (!keyHealth.isKeyFault(status)) {
        console.warn(`DROP: elevenlabs-tts-stream provider-failed status=${status} (${why}) → 502, not the key's fault`);
        sendJson(res, 502, { reason: 'provider_failed', provider: PROVIDER, status });
        return;
    }
    console.warn(`DROP: elevenlabs-tts-stream key-failed status=${status} (${why}) → 409`);
    await keyHealth.reportFailure(PROVIDER, status);
    sendJson(res, 409, { reason: 'key_failed', provider: PROVIDER, status });
}

module.exports = { streamWithKey, STREAM_URL, MODEL, PROVIDER };
