// SPDX-License-Identifier: AGPL-3.0-only
// engines.js — STT/TTS engine routing for the integration's stt/tts entities.
//
// The integration streams Assist audio to POST /api/voice/stt (WAV body) and asks
// POST /api/voice/tts ({text, voice?}) for spoken audio; this module forwards each
// to the CONFIGURED engine (add-on options). v0 targets any OpenAI-compatible
// engine server — whisper.cpp/faster-whisper (/v1/audio/transcriptions) and
// Kokoro/Piper-shim (/v1/audio/speech) — the same KIND of engine the Dashie
// console's "Local Engines" lane productized. The hosted (Dashie Cloud) engines
// slot into this same seam with the account port.
//
// ── ⚠️ WHY THE stt_*/tts_* ADD-ON OPTIONS EXIST, AND WHY THEY ARE NOT DUPLICATES ──
//
// Read this before proposing their removal. It has been proposed once already, on
// the reasoning that the web console offers the same fields — and that reasoning is
// wrong, because it compares the option NAMES instead of the CONSUMERS:
//
//   these options            → the HA-facing STT/TTS ENTITIES. The integration
//                              (dashie_voice/stt.py, tts.py, const.py:44-45) calls
//                              /api/voice/stt and /api/voice/tts, so this is what
//                              Home Assistant's own Assist pipelines and Wyoming
//                              satellites speak and listen through.
//   console voice.local*     → the DEVICE-DIRECT lane. A Dashie tablet calls its
//                              own configured STT/TTS server itself; nothing in
//                              this file is involved.
//
// Two consumers, two config surfaces. `readOptions()` is the ONLY source here —
// engines.js never reads the account or the panel's local settings blob — so for an
// ACCOUNT-LESS box these options are the sole path: without stt_url there is no
// speech-to-text at all (the 503 below says so literally), and TTS survives only
// via a BYOK speech key. The `llm_url`/`llm_model` removal is not a precedent for
// removing these: it was safe precisely BECAUSE converse.js gained account and
// panel tiers in the same change to read what the console writes. This file has no
// such tier.
//
// Product decision 2026-08-23: convergence IS the intent — one household voice
// configuration, set in the console, that a Dashie voice pipeline and an
// ESP32/Voice-PE style satellite both consume. It is deliberately NOT scheduled,
// because a single flat value cannot express it: an on-device-capable tablet may
// run a local Moonshine STT that an ESP32 endpoint cannot use, so resolution has to
// be per-consumer-CLASS, not one URL for everyone. That design question is open.
//
// 🔵 Known limitation until then: a signed-out box can configure local STT/TTS in
// the web console and those values are written and never read BY THESE ENTITIES.
// It is not visibly broken only because the options below still cover that case —
// which is another reason removing them ahead of the tier would strand people.

'use strict';

const auth = require('./auth');
const { CLOUD } = require('./config');
const { readOptions } = require('./options');
const byokTts = require('./byok-tts');
const sttUsage = require('./stt-usage');
// The per-consumer-CLASS tier this file's header called an open design question
// (2026-08-23), scheduled by John 2026-08-28. Additive: it answers only when the
// add-on option is unset AND the household's chosen engine is one a satellite can
// actually reach, so every box that works today is untouched.
const { resolveSatelliteBase } = require('./satellite-engines');

/** Signed-in JWT or null (never throws — engine handlers decide the fallback). */
async function cloudJwt() {
    try { return (await auth.getValidJwt()).jwt; } catch { return null; }
}

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

/**
 * POST /api/voice/stt — body: audio/wav bytes → { text }.
 *
 * ⚠️ NO BYOK BRANCH HERE YET, and that is deliberate rather than an oversight.
 * John's ruling split the adapter: TTS first (small request, small response, no
 * streaming), STT measured separately before anyone commits to proxying live
 * audio through the add-on. `deepgram` is therefore storable and unspent, which
 * is what the console manifest's `adapter: 'pending'` says about it.
 *
 * 🔴 When the STT twin IS built, read the two ported lessons at the top of
 * `byok-tts.js` first — the `Finalize`-forwarding one is this lane's, it is not
 * guessable from the provider docs, and its failure mode ("the last words of a
 * sentence go missing") looks like a model quality problem rather than a proxy
 * bug.
 *
 * ⭐ The lane IS instrumented already (`stt-usage.js`), which is not the same
 * thing as being BYOK. I once reported that this box makes no STT/TTS calls at
 * all; it makes both, and always has — three true measurements aimed at the
 * wrong three files. So usage capture never had to wait for an adapter.
 */
async function handleStt(req, res, sendJson) {
    const opts = readOptions();
    // Resolved through the per-consumer-class tier: the add-on option first (the
    // operator's direct statement about THIS lane), then the household choice but
    // ONLY when that engine is server-reachable. An on-device household pick
    // resolves to null here, which is the state this function already handles.
    const resolved = await resolveSatelliteBase('stt');
    const base = resolved?.base || '';
    if (resolved?.source === 'household') console.log('[engines] stt base resolved from the household config (no stt_url set)');
    let audio;
    try {
        audio = await readRawBody(req);
    } catch (e) {
        sendJson(res, 400, { error: 'bad_audio', message: e.message });
        return;
    }
    if (!base) {
        // Hosted fallback: Dashie Cloud Whisper under the account (metered).
        const jwt = await cloudJwt();
        if (!jwt) {
            console.warn('DROP: stt requested but no stt_url and not signed in');
            sendJson(res, 503, { error: 'stt_unconfigured', message: 'Sign in, or set stt_url in the add-on configuration.' });
            return;
        }
        await cloudStt(audio, jwt, res, sendJson);
        return;
    }
    const url = /\/audio\/transcriptions$/.test(base) ? base : base + '/v1/audio/transcriptions';
    const model = String(opts.stt_model || 'whisper-1');

    // Hand-rolled multipart (dependency-free): file + model fields.
    const boundary = '----dashieha' + Date.now().toString(16);
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
        console.log(`DASHIE-STT text="${text}" bytes=${audio.length} latency=${Date.now() - t0}ms`);
        // Success path ONLY — the two failure returns above made no successful
        // provider call, so there is no usage to record (D §8c: no zero rows).
        sttUsage.recordSttCall(audio, opts, 'local');
        sendJson(res, 200, { text });
    } catch (e) {
        clearTimeout(timer);
        console.warn('DROP: stt engine unreachable:', e.message);
        sendJson(res, 504, { error: 'stt_unreachable', message: e.message });
    }
}

/** Hosted STT: whisper-stt edge fn (multipart field `audio` → {transcript}). */
async function cloudStt(audio, jwt, res, sendJson) {
    const boundary = '----dashieha' + Date.now().toString(16);
    const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="audio.wav"\r\n` +
        `Content-Type: audio/wav\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const t0 = Date.now();
    try {
        const resp = await fetch(`${CLOUD.url}/functions/v1/whisper-stt`, {
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                apikey: CLOUD.anonKey,
                Authorization: `Bearer ${jwt}`,
            },
            body: Buffer.concat([head, audio, tail]),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            console.warn(`DROP: cloud stt HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 200)}`);
            sendJson(res, 502, { error: 'stt_engine_error', message: `cloud HTTP ${resp.status}` });
            return;
        }
        const text = String(data.transcript || data.text || '').trim();
        console.log(`DASHIE-STT route=cloud text="${text}" bytes=${audio.length} latency=${Date.now() - t0}ms`);
        // Success path only. Recorded as `metered` — a SEPARATE store key from
        // the local branch, because merging metered and BYOK spend into one row
        // is what §5a forbids. This row is for the at-a-glance view; the issuer
        // stays authoritative for its cost.
        sttUsage.recordSttCall(audio, readOptions(), 'cloud');
        sendJson(res, 200, { text });
    } catch (e) {
        console.warn('DROP: cloud stt unreachable:', e.message);
        sendJson(res, 504, { error: 'stt_unreachable', message: e.message });
    }
}

/** Hosted TTS: inworld-tts edge fn ({text, voice_id?} → audio bytes, audio/mpeg). */
async function cloudTts(text, voice, jwt, res, sendJson) {
    const t0 = Date.now();
    try {
        const resp = await fetch(`${CLOUD.url}/functions/v1/inworld-tts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: CLOUD.anonKey,
                Authorization: `Bearer ${jwt}`,
            },
            body: JSON.stringify({ text, ...(voice ? { voice_id: voice } : {}) }),
        });
        if (!resp.ok) {
            const detail = await resp.text().catch(() => '');
            console.warn(`DROP: cloud tts HTTP ${resp.status}: ${detail.slice(0, 200)}`);
            sendJson(res, 502, { error: 'tts_engine_error', message: `cloud HTTP ${resp.status}` });
            return;
        }
        const audio = Buffer.from(await resp.arrayBuffer());
        const ctype = resp.headers.get('Content-Type') || 'audio/mpeg';
        console.log(`DASHIE-TTS route=cloud chars=${text.length} bytes=${audio.length} latency=${Date.now() - t0}ms`);
        res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': 'no-store' });
        res.end(audio);
    } catch (e) {
        console.warn('DROP: cloud tts unreachable:', e.message);
        sendJson(res, 504, { error: 'tts_unreachable', message: e.message });
    }
}

/** POST /api/voice/tts — { text, voice? } → audio bytes (engine's WAV). */
async function handleTts(req, res, sendJson) {
    const opts = readOptions();
    // Same tier as handleStt — see satellite-engines.js for the class rule and why
    // it tests the chosen ENGINE rather than the presence of a URL.
    const resolved = await resolveSatelliteBase('tts');
    const base = resolved?.base || '';
    if (resolved?.source === 'household') console.log('[engines] tts base resolved from the household config (no tts_url set)');
    let payload;
    try {
        payload = JSON.parse((await readRawBody(req, 1024 * 1024)).toString('utf8') || '{}');
    } catch (e) {
        sendJson(res, 400, { error: 'bad_json', message: e.message });
        return;
    }
    const text = String(payload.text || '').trim();
    if (!text) { sendJson(res, 400, { error: 'bad_request', message: 'text is required' }); return; }
    const voice = String(payload.voice || opts.tts_voice || '');
    if (!base) {
        // BYOK: the household's own speech key, spent ON THE BOX (byok-tts.js
        // carries the precedence rationale). Ahead of the account path — a
        // stored key has one meaning — and behind `tts_url`, so no existing
        // install changes behaviour unless it holds a speech key.
        if (byokTts.available()) {
            const r = await byokTts.synthesize({ text, voice, model: payload.model });
            if (r.ok) {
                res.writeHead(200, { 'Content-Type': r.contentType, 'Cache-Control': 'no-store' });
                res.end(r.audio);
                return;
            }
            // Deliberately no silent fall-through to the cloud. The household
            // asked for its own key; billing it to the account instead because
            // ElevenLabs 401'd would spend somebody's money to hide a fault.
            sendJson(res, r.status, { error: r.error, ...(r.message ? { message: r.message } : {}) });
            return;
        }
        // Hosted fallback: Dashie Cloud voice under the account (metered).
        const jwt = await cloudJwt();
        if (!jwt) {
            console.warn('DROP: tts requested but no tts_url, no BYOK speech key and not signed in');
            sendJson(res, 503, { error: 'tts_unconfigured', message: 'Sign in, add a speech provider key in API Keys, or set tts_url in the add-on configuration.' });
            return;
        }
        await cloudTts(text, voice, jwt, res, sendJson);
        return;
    }
    const url = /\/audio\/speech$/.test(base) ? base : base + '/v1/audio/speech';

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
        console.log(`DASHIE-TTS chars=${text.length} voice=${voice || '(default)'} bytes=${audio.length} latency=${Date.now() - t0}ms`);
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
    // Must resolve through the SAME tier as handleTts, or the voice list is fetched
    // from a different box than the speech is synthesised on — the two would agree
    // only when `tts_url` is set, which is precisely the case the tier exists to
    // stop being the only working one.
    const base = (await resolveSatelliteBase('tts'))?.base || '';
    if (!base) { sendJson(res, 200, { voices: [] }); return; }
    // Still needed for tts_api_key below: the tier resolves the BASE, never the
    // credential. An add-on-configured key applies to whichever base answered —
    // a household-resolved own-box endpoint is on the LAN and normally needs none.
    const opts = readOptions();
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
