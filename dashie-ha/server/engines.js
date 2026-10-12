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
const geminiLane = require('./gemini-tts-lane');
const keyHealth = require('./key-health');
const sttUsage = require('./stt-usage');
// The per-consumer-CLASS tier this file's header called an open design question
// (2026-08-23), scheduled by John 2026-08-28. Additive: it answers only when the
// add-on option is unset AND the household's chosen engine is one a satellite can
// actually reach, so every box that works today is untouched.
const { resolveSatelliteBase } = require('./satellite-engines');
const geminiStt = require('./gemini-stt');
// The ONE routing answer per lane — handleTts/handleStt route on it, /api/voice/lanes reports it.
const voiceRoutes = require('./voice-routes');

/** The STT wire id for BYOK Gemini. Kotlin `VoiceAiOptions` is the naming source;
 *  the console row and this check mirror it (JS_KOTLIN_CONTRACTS row, D5). */
const STT_GEMINI = 'gemini';

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
    // D5: an EXPLICIT engine in the request (the integration's Gemini STT entity
    // sends ?engine=gemini). HA's /api/stt carries no device identity, so a
    // tablet's PER-DEVICE pick (contract row 78) can only reach this box as the
    // entity it targets. Explicit beats household and stt_url, and is not an
    // override: the caller named its engine. An unknown value is refused loudly.
    const engine = String(req.query?.engine || '').trim();
    if (engine) {
        if (engine === STT_GEMINI) { await geminiSttBranch(req, res, sendJson); return; }
        console.warn(`DROP: stt-unknown-engine — ?engine=${engine.slice(0, 40)} is not a known STT engine`);
        sendJson(res, 400, { error: 'unknown_engine', message: `Unknown STT engine "${engine.slice(0, 40)}".` });
        return;
    }
    // D5: the household chose BYOK Gemini. Checked FIRST, ahead of `stt_url`
    // (O's ruling, decision 1): a picker that says "Gemini" while the operator's
    // Whisper runs is the dishonest-label failure B rejected. The override is
    // never silent; it has its own marker, distinct from the failure markers.
    // Routed on voice-routes.sttRoute() — the answer /api/voice/lanes reports.
    const route = await voiceRoutes.sttRoute();
    if (route.serves === STT_GEMINI) {
        if (String(opts.stt_url || '').trim()) {
            console.warn(`STT-OVERRIDE: household chose ${STT_GEMINI}; the stt_url add-on option (${sttUsage.hostOf(opts.stt_url) || 'unparseable'}) is ignored while it is chosen`);
        }
        await geminiSttBranch(req, res, sendJson);
        return;
    }
    // Resolved through the per-consumer-class tier: the add-on option first (the
    // operator's direct statement about THIS lane), then the household choice but
    // ONLY when that engine is server-reachable. An on-device household pick
    // resolves to null here, which is the state this function already handles.
    const base = route.base;
    if (route.source === 'household') console.log('[engines] stt base resolved from the household config (no stt_url set)');
    let audio;
    try {
        audio = await readRawBody(req);
    } catch (e) {
        sendJson(res, 400, { error: 'bad_audio', message: e.message });
        return;
    }
    if (!base) {
        // Nobody can pay for Gemini (no key stored, not signed in) and no box engine is set: sttRoute
        // returned null. A signed-in box or a stored key never lands here; it routes to Gemini above.
        console.warn('DROP: stt requested but no engine can serve: no Gemini key, not signed in, no stt_url');
        sendJson(res, 503, { error: 'stt_unconfigured', message: 'Add a Gemini key in API Keys, sign in to use your Dashie credits, or set stt_url in the add-on configuration.' });
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

/**
 * The Gemini STT lane. 🔴 John 2026-10-12 (to HV, verbatim): "voice input is one Gemini option for the engine
 * and key first then credits". So the ENGINE is always Gemini and never a local one the household did not
 * choose; the PAYER is the household's key when stored, else the account's credits via the gemini-stt edge
 * (billed + credit-enforced there: checkSpendable → 402, recordSttUsage).
 *   key stored, works      → transcribed on the key (`byok` usage row), key health reported ok.
 *   key stored, Google failed → the failure is reported to the account FIRST (the "Voice key error" pill,
 *                            key-health.js, awaited; John 10-11), then credits if signed in.
 *   no key, signed in      → credits.
 *   no key, signed out     → 503: nobody can pay. Signed out after a key failure → the provider error.
 * Each outcome has its own marker. (Before 10-12 the credits leg called whisper-stt, which is not deployed:
 * every such turn ended 502. fb4939c's "credits" claim was false until this.)
 */
async function geminiSttBranch(req, res, sendJson) {
    let audio;
    try {
        audio = await readRawBody(req);
    } catch (e) {
        sendJson(res, 400, { error: 'bad_audio', message: e.message });
        return;
    }
    let failed = null;
    if (geminiStt.available()) {
        const t0 = Date.now();
        const r = await geminiStt.transcribe(audio);
        if (r.ok) {
            keyHealth.reportOk('gemini');
            console.log(`DASHIE-STT route=gemini payer=key text="${r.text}" bytes=${audio.length} latency=${Date.now() - t0}ms`);
            sttUsage.recordSttCall(audio, readOptions(), 'gemini', r.usage);
            sendJson(res, 200, { text: r.text });
            return;
        }
        if (r.keyFailure) await keyHealth.reportFailure('gemini', r.keyFailure.status);
        failed = r;
    }
    const jwt = (!failed || failed.keyFailure) ? await cloudJwt() : '';
    if (!jwt) {
        if (failed) {
            console.warn(`DROP: stt-gemini-failed — ${failed.error} (status ${failed.status})${failed.keyFailure ? '; not signed in: no credits fallback' : ''}`);
            sendJson(res, failed.status, { error: failed.error, ...(failed.message ? { message: failed.message } : {}) });
        } else {
            console.warn('DROP: stt-gemini-no-payer — no Gemini key is stored and the box is not signed in');
            sendJson(res, 503, { error: 'gemini_stt_no_key', message: 'Add a Gemini key in API Keys, or sign in to use your Dashie credits.' });
        }
        return;
    }
    if (failed) console.warn(`STT-FALLBACK: byok gemini failed (${failed.keyFailure.status}) → gemini-stt on account credits`);
    await creditsGeminiStt(audio, jwt, res, sendJson);
}

/**
 * Gemini STT on the account's CREDITS: the gemini-stt edge fn (raw WAV body → {transcript, model, billed}).
 * The edge is the billing authority (checkSpendable → 402 insufficient_credits, recordSttUsage); the local
 * row is the at-a-glance view, keyed `gemini|<model>|metered` so it never merges with the household's own
 * `gemini|…|byok` spend (§5a). Replaced whisper-stt 10-12, which is not deployed (404 on staging and prod).
 */
async function creditsGeminiStt(audio, jwt, res, sendJson) {
    const t0 = Date.now();
    try {
        const resp = await fetch(`${CLOUD.url}/functions/v1/gemini-stt`, {
            method: 'POST',
            headers: { 'Content-Type': 'audio/wav', apikey: CLOUD.anonKey, Authorization: `Bearer ${jwt}` },
            body: audio,
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.status === 402) {
            console.warn('DROP: stt-gemini-credits insufficient_credits — the account cannot pay and no key is working');
            sendJson(res, 402, { error: 'insufficient_credits', message: 'Out of Dashie credits. Add credits, or add a Gemini key in API Keys.' });
            return;
        }
        if (!resp.ok) {
            console.warn(`DROP: stt-gemini-credits HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 200)}`);
            sendJson(res, 502, { error: 'stt_engine_error', message: `cloud HTTP ${resp.status}` });
            return;
        }
        const text = String(data.transcript || '').trim();
        console.log(`DASHIE-STT route=gemini payer=credits text="${text}" bytes=${audio.length} latency=${Date.now() - t0}ms`);
        sttUsage.recordSttCall(audio, readOptions(), 'cloud', { model: data.model || null });
        sendJson(res, 200, { text });
    } catch (e) {
        console.warn('DROP: stt-gemini-credits unreachable:', e.message);
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

/** The household's picked Gemini voice name, or '' (never throws). */
async function householdGeminiVoice() {
    try {
        const v = await require('./satellite-engines').householdVoice();
        return String(v?.liveVoiceName || '').trim();
    } catch { return ''; }
}

/** Credits-paid Gemini voice for an HA speaker, as WAV (gemini-tts-lane.js creditsBuffered). */
async function sendCreditsGemini(text, voice, jwt, res, sendJson) {
    const r = await geminiLane.creditsBuffered({ text, voice, jwt });
    if (r.ok) {
        res.writeHead(200, { 'Content-Type': r.contentType, 'Cache-Control': 'no-store' });
        res.end(r.audio);
        return;
    }
    sendJson(res, r.status, { error: r.error, ...(r.message ? { message: r.message } : {}) });
}

/** POST /api/voice/tts — { text, voice? } → audio bytes (engine's WAV). */
async function handleTts(req, res, sendJson) {
    const opts = readOptions();
    // Routed on voice-routes.ttsRoute() — the same answer GET /api/voice/lanes reports,
    // so the console's picker and this lane cannot drift (check-voice-lanes.mjs).
    // The base-URL tier is satellite-engines.js's class rule (tests the chosen ENGINE).
    const route = await voiceRoutes.ttsRoute();
    const base = route.base;
    if (route.source === 'household') console.log('[engines] tts base resolved from the household config (no tts_url set)');
    let payload;
    try {
        payload = JSON.parse((await readRawBody(req, 1024 * 1024)).toString('utf8') || '{}');
    } catch (e) {
        sendJson(res, 400, { error: 'bad_json', message: e.message });
        return;
    }
    const text = String(payload.text || '').trim();
    if (!text) { sendJson(res, 400, { error: 'bad_request', message: 'text is required' }); return; }
    // A TABLET asking for the Gemini voice as it is generated (dashie_voice's streaming view, path K).
    // Key or 409; never credits from here (gemini-tts-lane.js). Ahead of tts_url: the tablet asked
    // for Gemini by name, and an operator's engine URL is not that.
    // The household's ONE Gemini voice (voice.liveVoiceName; John 2026-10-11 via B: the household's
    // pick WINS over the operator's tts_voice, which is only the fallback for a box that never picked).
    // Gemini-only by ruling (other engines' voice ids are a different namespace), so it applies only
    // when Gemini will speak this turn.
    const householdVoiceName = await householdGeminiVoice();
    if (payload.stream === true) {
        await geminiLane.streamWithKey(res, { text, voice: payload.voice || householdVoiceName });
        return;
    }
    const geminiSpeaks = route.serves === 'gemini' || (!base && await byokTts.choseGeminiVoice());
    const voice = String(payload.voice || (geminiSpeaks ? householdVoiceName : '') || opts.tts_voice || '');
    if (!base) {
        // BYOK: the household's own speech key, spent ON THE BOX (byok-tts.js
        // carries the precedence rationale). Ahead of the account path — a
        // stored key has one meaning — and behind `tts_url`, so no existing
        // install changes behaviour unless it holds a speech key, OR holds a
        // Gemini key while its account cannot pay (signed out, or no spendable
        // credits — John 2026-10-10; byok-tts.js resolveProvider has the rule).
        if (route.serves === 'elevenlabs' || route.serves === 'gemini') {
            const r = await byokTts.synthesize({ text, voice, model: payload.model });
            if (r.ok) {
                keyHealth.reportOk(route.serves);
                res.writeHead(200, { 'Content-Type': r.contentType, 'Cache-Control': 'no-store' });
                res.end(r.audio);
                return;
            }
            // 🔴 REVERSED 2026-10-11 (John: "broken key goes to credits with small error message"):
            // a failed key now falls back to the account's credits, and the failure is NOT hidden.
            // It is written to the account (key-health.js) so every tablet shows "Voice key error".
            // The usage row names the payer that SERVED the turn (credits), never the key that failed.
            if (r.keyFailure) await keyHealth.reportFailure(r.keyFailure.provider, r.keyFailure.status);
            const jwtFb = await cloudJwt();
            if (!jwtFb) {
                // Signed out: no credits to fall back to. HA's own engines / on-device (John's Q4) is
                // not wired here yet, so this is still the provider's error, loudly.
                console.warn(`DROP: tts byok ${route.serves} failed (${r.keyFailure?.status || r.error}) and not signed in: no credits fallback`);
                sendJson(res, r.status, { error: r.error, ...(r.message ? { message: r.message } : {}) });
                return;
            }
            console.warn(`TTS-FALLBACK: byok ${route.serves} failed (${r.keyFailure?.status || r.error}) → account credits`);
            if (route.serves === 'gemini') { await sendCreditsGemini(text, voice, jwtFb, res, sendJson); return; }
            await cloudTts(text, voice, jwtFb, res, sendJson);
            return;
        }
        // Hosted fallback: Dashie Cloud voice under the account (metered).
        const jwt = await cloudJwt();
        if (!jwt) {
            console.warn('DROP: tts requested but no tts_url, no BYOK speech key and not signed in');
            sendJson(res, 503, { error: 'tts_unconfigured', message: 'Sign in, add a speech provider key in API Keys, or set tts_url in the add-on configuration.' });
            return;
        }
        // The household chose the Gemini voice and has no Gemini key: credits pay for the SAME voice
        // (A2, byok-tts.js resolveProvider), not the account's default cloud voice.
        if (await byokTts.choseGeminiVoice()) { await sendCreditsGemini(text, voice, jwt, res, sendJson); return; }
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
