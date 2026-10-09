// SPDX-License-Identifier: AGPL-3.0-only
// server/gemini-stt.js — BYOK speech-to-text on the household's own Gemini key (D5).
//
// One key for brain + STT + grounded search, so a household never has to sign up
// for a separate speech provider. BATCH (`gemini-3.5-transcribe`, generateContent),
// not `-transcribe-live`: both are on the same key, and batch wins on effort and on
// key custody, not on keys (A-KICKOFF-gemini-stt.md, DECIDED §1).
//
// ── 🔴 THE RAW KEY NEVER LEAVES THE BOX ─────────────────────────────────────
// Same rule as live-token.js. The tablet reaches this through HA's /api/stt and the
// integration's STT entity (the add-on has no LAN port), so it never holds the key,
// and nothing here returns, logs or embeds it in an error. The key goes in the
// `x-goog-api-key` HEADER, never the query string, so it cannot ride along in a
// URL that some layer decides to log.
//
// ── ⚠️ TWO RESPONSE SHAPES, BOTH ACCEPTED ───────────────────────────────────
// Google's transcribe doc puts the transcript at `parts[].text`. A real response
// captured in BerriAI/litellm#44539 puts it at `parts[].audioTranscription.text`,
// and a client reading only `.text` returned EMPTY for a successful transcription.
// That failure looks exactly like the user saying nothing, so a 200 whose parts
// match NEITHER shape is not "empty": it logs its own DROP marker naming the part
// keys it did find, and returns an error rather than a silent "".

'use strict';

const { readKeys } = require('./key-store');

const MODEL = 'gemini-3.5-transcribe';
const URL_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const TIMEOUT_MS = 30000;

function _key() {
    const k = readKeys()?.gemini?.key;
    return typeof k === 'string' ? k.trim() : '';
}

/** True when the household has stored a Gemini key on this box. */
function available() {
    return _key().length > 0;
}

/**
 * The transcript from a generateContent response, or `null` when the response
 * carries no part in a shape we recognise. `''` is a real answer (silence);
 * `null` is "could not read it", and the two must never be confused.
 */
function parseTranscript(json) {
    const parts = json?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return null;
    let found = false;
    const out = [];
    for (const p of parts) {
        const t = typeof p?.text === 'string' ? p.text
            : typeof p?.audioTranscription?.text === 'string' ? p.audioTranscription.text
                : null;
        if (t !== null) { found = true; out.push(t); }
    }
    return found ? out.join(' ').replace(/\s+/g, ' ').trim() : null;
}

/** Part keys only, for the unrecognised-shape log. Never values. */
function _shapeOf(json) {
    const parts = json?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return `no parts (top-level keys: ${Object.keys(json || {}).join(',') || 'none'})`;
    return parts.map((p) => Object.keys(p || {}).join('+') || 'empty').join(',') || 'zero parts';
}

/**
 * Transcribe one WAV utterance on the household's Gemini key.
 * @param {Buffer} wav  canonical 16 kHz mono PCM WAV (what stt.py sends)
 * @returns {Promise<{ok: true, text: string, model: string, usage: object|null}
 *                  | {ok: false, status: number, error: string, message?: string}>}
 *   Never throws, and no field ever contains the key.
 */
async function transcribe(wav) {
    const key = _key();
    if (!key) return { ok: false, status: 503, error: 'gemini_stt_no_key', message: 'No Gemini key is stored in API Keys.' };
    if (!Buffer.isBuffer(wav) || wav.length === 0) return { ok: false, status: 400, error: 'bad_audio' };

    const body = {
        contents: [{ parts: [{ inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }] }],
        generationConfig: { audioTranscriptionConfig: { mode: 'VERBATIM' } },
    };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
        const resp = await fetch(`${URL_BASE}/${MODEL}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify(body),
            signal: ctl.signal,
        });
        clearTimeout(timer);
        const json = await resp.json().catch(() => null);
        if (!resp.ok) {
            // Google's error message carries no key; cap it anyway.
            const detail = String(json?.error?.message || '').slice(0, 200);
            console.warn(`DROP: gemini-stt HTTP ${resp.status}: ${detail}`);
            return { ok: false, status: 502, error: 'gemini_stt_http', message: `Gemini HTTP ${resp.status}` };
        }
        const text = parseTranscript(json);
        if (text === null) {
            console.warn(`DROP: gemini-stt unrecognised-shape — 200 with no transcript part (${_shapeOf(json)})`);
            return { ok: false, status: 502, error: 'gemini_stt_unparsed' };
        }
        return { ok: true, text, model: MODEL, usage: json?.usageMetadata || null };
    } catch (e) {
        clearTimeout(timer);
        const msg = e?.name === 'AbortError' ? `timeout after ${TIMEOUT_MS} ms` : String(e?.message || e);
        console.warn(`DROP: gemini-stt unreachable: ${msg}`);
        return { ok: false, status: 504, error: 'gemini_stt_unreachable', message: msg };
    }
}

module.exports = { available, transcribe, parseTranscript, MODEL };
