// SPDX-License-Identifier: AGPL-3.0-only
// server/gemini-tts.js — the Gemini adapter for the BYOK TTS lane (byok-tts.js).
//
// WHEN it serves is decided in byok-tts.js resolveProvider(), not here (John
// 2026-10-10: Gemini TTS only when no speech key is stored AND the box is not
// signed in).
//
// Unlike ElevenLabs, Gemini has no audio body to stream: generateContent returns the
// audio base64-encoded inside JSON, next to usageMetadata. So this adapter returns
// the BUFFERED shape `{ ok, status, audio, contentType, units }` that byok-tts.js
// accepts alongside `{ resp, contentType }`.
//
// Measured 2026-10-10 on the test key (one call each, "The kitchen timer is done."):
//   gemini-3.8-flash-tts       → audio/wav, RIFF/WAVE, PCM 24000 Hz mono 16-bit, plus a
//                                trailing C2PA provenance chunk; usage 6 text-in, 47 audio-out
//   gemini-2.5-flash-preview-tts → audio/L16;codec=pcm;rate=24000 (raw, no header)
// Both shapes are handled. Anything else is refused loudly, never relabelled.

'use strict';

const { parseL16Mime, pcmToWav } = require('./wav-header');
const { geminiTokenUnits } = require('./stt-usage');

const URL_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.8-flash-tts';
const DEFAULT_VOICE = 'Kore';

// The household's tts_voice / a request's model may name ANOTHER engine's voice or
// model (an ElevenLabs voice id, a Kokoro voice). Gemini 400s/404s on those, so a
// value that cannot be a Gemini one is replaced, with a marker, not sent.
const GEMINI_VOICE = /^[A-Z][a-z]{1,20}$/;
const GEMINI_TTS_MODEL = /^gemini-[a-z0-9.-]*tts[a-z0-9.-]*$/;

/** Decode one generateContent body into WAV bytes, or a reason it cannot be. */
function audioFromResponse(json) {
    const part = (json?.candidates?.[0]?.content?.parts || []).find(p => p?.inlineData?.data);
    if (!part) return { error: 'no inlineData audio part' };
    const mime = String(part.inlineData.mimeType || '');
    const bytes = Buffer.from(part.inlineData.data, 'base64');
    if (/^audio\/(wav|x-wav|wave)\b/i.test(mime)) {
        if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
            return { error: `mimeType ${mime} but the body is not RIFF/WAVE` };
        }
        return { audio: bytes };
    }
    const l16 = parseL16Mime(mime);
    if (l16) return { audio: pcmToWav(bytes, l16) };
    return { error: `unsupported audio mimeType ${mime.slice(0, 60) || '(none)'}` };
}

const adapter = {
    defaultVoice: DEFAULT_VOICE,
    defaultModel: DEFAULT_MODEL,
    async synth({ key, text, voice, model, fetch }) {
        let useVoice = voice, useModel = model;
        if (!GEMINI_VOICE.test(useVoice)) {
            console.warn(`DROP: byok-tts gemini-voice-not-gemini — "${String(useVoice).slice(0, 40)}" is not a Gemini voice; using ${DEFAULT_VOICE}`);
            useVoice = DEFAULT_VOICE;
        }
        if (!GEMINI_TTS_MODEL.test(useModel)) {
            console.warn(`DROP: byok-tts gemini-model-not-tts — "${String(useModel).slice(0, 60)}" is not a Gemini TTS model; using ${DEFAULT_MODEL}`);
            useModel = DEFAULT_MODEL;
        }
        const resp = await fetch(`${URL_BASE}/${encodeURIComponent(useModel)}:generateContent`, {
            method: 'POST',
            headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text }] }],
                generationConfig: {
                    responseModalities: ['AUDIO'],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: useVoice } } },
                },
            }),
        });
        if (!resp.ok) return { ok: false, status: resp.status, model: useModel };
        let json;
        try { json = await resp.json(); } catch { return { ok: false, status: 200, model: useModel, error: 'body is not JSON' }; }
        // Google has billed from here on (byok-tts.js lesson 1), so units come back
        // even when the audio turns out to be unusable.
        const units = { characters: text.length, ...geminiTokenUnits(json?.usageMetadata) };
        const { audio, error } = audioFromResponse(json);
        if (!audio) return { ok: false, status: 200, model: useModel, units, error };
        return { ok: true, status: 200, audio, contentType: 'audio/wav', model: useModel, units };
    },
};

module.exports = { adapter, audioFromResponse, DEFAULT_MODEL, DEFAULT_VOICE };
