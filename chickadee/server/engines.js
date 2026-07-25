// engines.js — STT/TTS engine routing for the integration's stt/tts entities.
//
// The integration streams Assist audio to POST /api/voice/stt (WAV body) and asks
// POST /api/voice/tts ({text, voice?}) for spoken audio; this module forwards each
// to the CONFIGURED engine (add-on options). v0 targets any OpenAI-compatible
// engine server — whisper.cpp/faster-whisper (/v1/audio/transcriptions) and
// Kokoro/Piper-shim (/v1/audio/speech) — the same "Local Engines" lane the Dashie
// console productized. The hosted (Chickadee Cloud) engines slot into this same
// seam with the account port.

'use strict';

const { readOptions } = require('./options');

const STT_TIMEOUT_MS = 60000;
const TTS_TIMEOUT_MS = 60000;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

function authHeaders(key) {
    return key ? { Authorization: `Bearer ${key}` } : {};
}

/** Read a full request body as a Buffer (bounded). */
function readRawBody(req, limit = MAX_AUDIO_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

/** POST /api/voice/stt — body: audio/wav bytes → { text }. */
async function handleStt(req, res, sendJson) {
    const opts = readOptions();
    const base = String(opts.stt_url || '').trim().replace(/\/+$/, '');
    if (!base) {
        console.warn('DROP: stt requested but stt_url is not configured');
        sendJson(res, 503, { error: 'stt_unconfigured', message: 'Set stt_url in the add-on configuration.' });
        return;
    }
    let audio;
    try {
        audio = await readRawBody(req);
    } catch (e) {
        sendJson(res, 400, { error: 'bad_audio', message: e.message });
        return;
    }
    const url = /\/audio\/transcriptions$/.test(base) ? base : base + '/v1/audio/transcriptions';
    const model = String(opts.stt_model || 'whisper-1');

    // Hand-rolled multipart (dependency-free): file + model fields.
    const boundary = '----chickadee' + Date.now().toString(16);
    const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
        `Content-Type: audio/wav\r\n\r\n`);
    const mid = Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, audio, mid]);

    const t0 = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), STT_TIMEOUT_MS);
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, ...authHeaders(opts.stt_api_key) },
            body,
            signal: ctl.signal,
        });
        clearTimeout(timer);
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            console.warn(`DROP: stt engine HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 200)}`);
            sendJson(res, 502, { error: 'stt_engine_error', message: `HTTP ${resp.status}` });
            return;
        }
        const text = String(data.text || '').trim();
        console.log(`CHICKADEE-STT text="${text}" bytes=${audio.length} latency=${Date.now() - t0}ms`);
        sendJson(res, 200, { text });
    } catch (e) {
        clearTimeout(timer);
        console.warn('DROP: stt engine unreachable:', e.message);
        sendJson(res, 504, { error: 'stt_unreachable', message: e.message });
    }
}

/** POST /api/voice/tts — { text, voice? } → audio bytes (engine's WAV). */
async function handleTts(req, res, sendJson) {
    const opts = readOptions();
    const base = String(opts.tts_url || '').trim().replace(/\/+$/, '');
    if (!base) {
        console.warn('DROP: tts requested but tts_url is not configured');
        sendJson(res, 503, { error: 'tts_unconfigured', message: 'Set tts_url in the add-on configuration.' });
        return;
    }
    let payload;
    try {
        payload = JSON.parse((await readRawBody(req, 1024 * 1024)).toString('utf8') || '{}');
    } catch (e) {
        sendJson(res, 400, { error: 'bad_json', message: e.message });
        return;
    }
    const text = String(payload.text || '').trim();
    if (!text) { sendJson(res, 400, { error: 'bad_request', message: 'text is required' }); return; }
    const url = /\/audio\/speech$/.test(base) ? base : base + '/v1/audio/speech';
    const voice = String(payload.voice || opts.tts_voice || '');

    const t0 = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TTS_TIMEOUT_MS);
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders(opts.tts_api_key) },
            // model is ignored by every server we target (Kokoro validates it exists).
            body: JSON.stringify({ model: 'kokoro', input: text, voice, response_format: 'wav', speed: 1.0 }),
            signal: ctl.signal,
        });
        clearTimeout(timer);
        if (!resp.ok) {
            const detail = await resp.text().catch(() => '');
            console.warn(`DROP: tts engine HTTP ${resp.status}: ${detail.slice(0, 200)}`);
            sendJson(res, 502, { error: 'tts_engine_error', message: `HTTP ${resp.status}` });
            return;
        }
        const audio = Buffer.from(await resp.arrayBuffer());
        console.log(`CHICKADEE-TTS chars=${text.length} voice=${voice || '(default)'} bytes=${audio.length} latency=${Date.now() - t0}ms`);
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
        res.end(audio);
    } catch (e) {
        clearTimeout(timer);
        console.warn('DROP: tts engine unreachable:', e.message);
        sendJson(res, 504, { error: 'tts_unreachable', message: e.message });
    }
}

/** GET/POST /api/voice/voices — the configured TTS engine's voice catalog,
 *  normalized to { voices: [{voice_id, name}] } (Kokoro's {id,name} and the
 *  Piper shim's {voice_id,name} both map). Feeds HA's native voice picker via
 *  the integration's tts entity. */
async function handleVoices(req, res, sendJson) {
    const opts = readOptions();
    const base = String(opts.tts_url || '').trim().replace(/\/+$/, '');
    if (!base) { sendJson(res, 200, { voices: [] }); return; }
    const url = (/\/audio\/speech$/.test(base) ? base.replace(/\/audio\/speech$/, '/audio/voices') : base + '/v1/audio/voices');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    try {
        const resp = await fetch(url, { headers: authHeaders(opts.tts_api_key), signal: ctl.signal });
        clearTimeout(timer);
        const data = await resp.json().catch(() => ({}));
        const list = Array.isArray(data?.voices) ? data.voices : Array.isArray(data) ? data : [];
        const voices = list
            .map((v) => (typeof v === 'string'
                ? { voice_id: v, name: v }
                : { voice_id: String(v.voice_id || v.id || v.name || ''), name: String(v.name || v.voice_id || v.id || '') }))
            .filter((v) => v.voice_id);
        console.log(`[engines] voices: ${voices.length} from ${url}`);
        sendJson(res, 200, { voices });
    } catch (e) {
        clearTimeout(timer);
        console.warn('DROP: voices fetch failed:', e.message);
        sendJson(res, 200, { voices: [] });   // picker degrades to free-text, never errors
    }
}

module.exports = { handleStt, handleTts, handleVoices };
