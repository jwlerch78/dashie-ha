// SPDX-License-Identifier: AGPL-3.0-only
// server/wav-header.js — wrap raw 16-bit PCM in a canonical 44-byte WAV header.
//
// /api/voice/tts serves WAV (engines.js handleTts; dashie_voice/tts.py treats any
// non-MPEG body as WAV). Gemini's 3.8 TTS models already answer `audio/wav`, but
// older ones answer raw `audio/L16;codec=pcm;rate=24000` (measured 2026-10-10,
// gemini-2.5-flash-preview-tts). Raw PCM handed on as "WAV" plays as noise or not
// at all, so the rate is READ from the mimeType, never assumed: a wrong rate would
// play at the wrong speed, a failure that sounds plausible rather than loud.
//
// The writer is proven by round-trip through stt-usage.js wavSeconds(), the box's
// existing parser (scripts/check-byok-tts.mjs).

'use strict';

/** `audio/L16;codec=pcm;rate=24000` → { sampleRate, channels }, or null if not L16. */
function parseL16Mime(mime) {
    const parts = String(mime || '').toLowerCase().split(';').map(s => s.trim());
    if (parts[0] !== 'audio/l16') return null;
    const param = (k) => (parts.find(p => p.startsWith(`${k}=`)) || '').slice(k.length + 1);
    const sampleRate = Number(param('rate'));
    const channels = param('channels') ? Number(param('channels')) : 1;
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) return null;
    if (!Number.isInteger(channels) || channels < 1 || channels > 2) return null;
    return { sampleRate, channels };
}

/** 16-bit little-endian PCM → a WAV buffer (header + the same bytes). */
function pcmToWav(pcm, { sampleRate, channels = 1 }) {
    const bits = 16;
    const h = Buffer.alloc(44);
    h.write('RIFF', 0, 'ascii');
    h.writeUInt32LE(36 + pcm.length, 4);
    h.write('WAVE', 8, 'ascii');
    h.write('fmt ', 12, 'ascii');
    h.writeUInt32LE(16, 16);                                  // PCM fmt chunk size
    h.writeUInt16LE(1, 20);                                   // format 1 = PCM
    h.writeUInt16LE(channels, 22);
    h.writeUInt32LE(sampleRate, 24);
    h.writeUInt32LE(sampleRate * channels * (bits / 8), 28);  // byte rate
    h.writeUInt16LE(channels * (bits / 8), 32);               // block align
    h.writeUInt16LE(bits, 34);
    h.write('data', 36, 'ascii');
    h.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([h, pcm]);
}

module.exports = { parseL16Mime, pcmToWav };
