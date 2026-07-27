// server/voice-engines.js — local voice engine detection for the Console picker.
//
// Answers "what local STT/TTS can the user's Home Assistant do, right now?" so
// the Console can turn the Piper (TTS) / Whisper (STT) rows from static
// "coming soon" stubs into detection-gated live rows with real voice dropdowns
// (build plan 20260708_LOCAL_VOICE_STT_TTS_BUILD_PLAN.md §5).
//
// Three sources, all best-effort (a failure in one never fails the whole call):
//   1. TTS engines  — WS tts/engine/list (+ tts/engine/voices per engine)
//   2. STT engines  — WS stt/engine/list (+ stt/engine/get per engine)
//   3. Kokoro add-on — Supervisor add-on list by slug (our optional own-box TTS)
//
// ⚠️ HA API drift (§4.3): the WS command names + response shapes have changed
// across HA releases. Everything here tolerates a reject/odd shape and records
// it in the `debug` block. scripts/probe-voice-engines.js dumps raw shapes for
// validation against a real HA before the native clients depend on them.

const haWs = require('./ha-ws');
const keyStore = require('./key-store');
const { getAccountVoiceConfig } = require('./account-config');

const CACHE_TTL_MS = 5 * 60 * 1000;   // engines change rarely; Re-scan bypasses
let _cache = null;                    // { result, fetchedAt }

/** Pick the language to enumerate voices in. Voice lists are language-specific
 *  (Piper: 26 voices for en_US vs 11 for en_GB, and it lists en_GB *before*
 *  en_US), so prefer en-US explicitly, then any English, then the first
 *  supported language. Phase 1 is EN-first households. */
function _preferredLanguage(supportedLanguages) {
    const langs = (Array.isArray(supportedLanguages) ? supportedLanguages : []).map(String);
    return langs.find(l => /^en[-_]us$/i.test(l))
        || langs.find(l => /^en([-_]|$)/i.test(l))
        || langs[0] || 'en';
}

/** Normalize whatever tts/engine/list returned into a plain array of engines.
 *  HA returns { providers: [...] }; tolerate a bare array too. */
function _providers(listResult) {
    if (!listResult) return [];
    if (Array.isArray(listResult)) return listResult;
    if (Array.isArray(listResult.providers)) return listResult.providers;
    return [];
}

async function _detectTts(debug) {
    let listResult;
    try {
        listResult = await haWs.listTtsEngines();
    } catch (e) {
        if (debug) debug.tts_list_error = e.message;
        return [];
    }
    if (debug) debug.tts_list_raw = listResult;

    const engines = [];
    for (const p of _providers(listResult)) {
        const engineId = p.engine_id || p.engineId;
        if (!engineId) continue;
        const languages = p.supported_languages || p.supportedLanguages || [];
        const language = _preferredLanguage(languages);
        let voices = [];
        try {
            const vres = await haWs.getTtsVoices(engineId, language);
            if (debug && !debug.tts_voices_raw) debug.tts_voices_raw = { engineId, language, vres };
            const arr = Array.isArray(vres?.voices) ? vres.voices : (Array.isArray(vres) ? vres : []);
            voices = arr
                .map(v => ({ voice_id: v.voice_id || v.voiceId || v.id, name: v.name || v.voice_id || v.id }))
                .filter(v => v.voice_id);
        } catch (e) {
            if (debug) (debug.tts_voices_errors = debug.tts_voices_errors || {})[engineId] = e.message;
        }
        engines.push({ engine_id: engineId, name: p.name || engineId, languages, voices });
    }
    return engines;
}

async function _detectStt(debug) {
    let listResult;
    try {
        listResult = await haWs.listSttEngines();
    } catch (e) {
        if (debug) debug.stt_list_error = e.message;
        return [];
    }
    if (debug) debug.stt_list_raw = listResult;

    const engines = [];
    for (const p of _providers(listResult)) {
        const engineId = p.engine_id || p.engineId;
        if (!engineId) continue;
        const languages = p.supported_languages || p.supportedLanguages || [];
        // No stt/engine/get: it's unknown_command on current HA (probe 2026-07-09).
        // The list already carries supported_languages, and native STT POSTs a
        // fixed X-Speech-Content capture format (§4.2) — no per-engine meta needed.
        engines.push({ engine_id: engineId, name: p.name || engineId, languages });
    }
    return engines;
}

/** Is our Kokoro add-on installed/running? Supervisor add-on list by slug
 *  (slugs get a repo prefix, e.g. `local_dashie_kokoro`, so match by suffix).
 *  Reachability/voice enumeration of the add-on is a later step (folding Kokoro
 *  into the Dashie repo, §7) — for now report presence only. */
async function _detectKokoro(debug) {
    const token = process.env.SUPERVISOR_TOKEN;
    if (!token) return { installed: false, reason: 'no_supervisor' };
    try {
        const resp = await fetch('http://supervisor/addons', {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) {
            if (debug) debug.kokoro_error = `addons HTTP ${resp.status}`;
            return { installed: false, reason: `http_${resp.status}` };
        }
        const body = await resp.json();
        const addons = body?.data?.addons || [];
        const hit = addons.find(a =>
            /(^|_)dashie_kokoro$/.test(String(a.slug || '')) ||
            /kokoro/i.test(String(a.name || '')));
        if (debug) debug.kokoro_match = hit || null;
        if (!hit) return { installed: false };
        return {
            installed: true,
            running: hit.state === 'started',
            slug: hit.slug,
            version: hit.version || null,
            // URL + voices are filled once the add-on is folded in (§7); the box
            // exposes Kokoro on 8880 but the host IP isn't known server-side yet.
            url: null,
            voices: [],
        };
    } catch (e) {
        if (debug) debug.kokoro_error = e.message;
        return { installed: false, reason: 'probe_failed' };
    }
}

/** Probe the Hermes add-on's OpenAI-compatible API, capturing the STATUS so the
 *  console can tell apart the setup states: 200 = reachable+authed (ready);
 *  401/403 = reachable but the bearer is missing/wrong (needs the API key);
 *  anything unreachable = running-but-not-up-yet (starting). Bearer comes from
 *  the on-box key store (the 'hermes' provider), never user_settings. */
async function _probeHermesApi(url, key, debug) {
    const base = String(url || '').replace(/\/+$/, '');
    if (!base) return { reachable: false, authed: false };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    try {
        const headers = key ? { Authorization: `Bearer ${key}` } : {};
        const resp = await fetch(`${base}/v1/models`, { headers, signal: ctl.signal });
        clearTimeout(timer);
        if (debug) debug.hermes_probe_status = resp.status;
        if (resp.ok) return { reachable: true, authed: true, status: resp.status };
        // Up, but rejected — 401/403 = no/bad key; other non-ok still means "server is up".
        return { reachable: true, authed: false, status: resp.status };
    } catch (e) {
        clearTimeout(timer);
        if (debug) debug.hermes_probe_error = e.message;
        return { reachable: false, authed: false, error: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message) };
    }
}

/** Is the Dashie Hermes add-on installed / started / reachable / authed? (WS-I.3)
 *  Mirrors _detectKokoro for install state, then — because the add-on brain runs
 *  in THIS container — probes Hermes over the internal supervisor network
 *  (http://<addon-hostname>:8642), which is also the endpoint the brain will use.
 *  Returns a flat state block the console maps to row messaging:
 *    { installed, running, reachable, authed, url, slug, version } */
async function _detectHermes(debug) {
    const token = process.env.SUPERVISOR_TOKEN;
    if (!token) return { installed: false, reason: 'no_supervisor' };
    try {
        const resp = await fetch('http://supervisor/addons', {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) {
            if (debug) debug.hermes_error = `addons HTTP ${resp.status}`;
            return { installed: false, reason: `http_${resp.status}` };
        }
        const body = await resp.json();
        const addons = body?.data?.addons || [];
        const hit = addons.find(a =>
            /(^|_)dashie_hermes$/.test(String(a.slug || '')) ||
            /hermes/i.test(String(a.name || '')));
        if (debug) debug.hermes_match = hit || null;
        if (!hit) return { installed: false };

        const running = hit.state === 'started';
        const result = {
            installed: true, running, reachable: false, authed: false,
            url: null, slug: hit.slug, version: hit.version || null,
        };
        if (!running) return result;

        // Resolve the internal hostname for the probe (same source addon_bridge.py uses).
        let host = null;
        try {
            const info = await fetch(`http://supervisor/addons/${hit.slug}/info`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (info.ok) {
                const j = await info.json();
                host = j?.data?.hostname || j?.data?.ip_address || null;
            }
        } catch (e) {
            if (debug) debug.hermes_info_error = e.message;
        }
        if (!host) return result;   // running but host unknown → treat as "starting"

        result.url = `http://${host}:8642`;
        const key = keyStore.readKeys().hermes?.key || '';
        const probe = await _probeHermesApi(result.url, key, debug);
        result.reachable = probe.reachable;
        result.authed = probe.authed;
        return result;
    } catch (e) {
        if (debug) debug.hermes_error = e.message;
        return { installed: false, reason: 'probe_failed' };
    }
}

/**
 * Detect local voice engines. Cached for CACHE_TTL_MS; `refresh` bypasses the
 * cache (the Console's "Re-scan" affordance). `debug` attaches a `_debug` block
 * with raw WS shapes for §4.3 validation (never cached).
 *
 * Returns: { available, tts: [...], stt: [...], kokoro: {...}, _debug? }
 *   available=false means HA WS isn't reachable (no supervisor token / dev env);
 *   the Console then falls back to URL-based local_* rows only.
 */
/** OpenAI-compatible reachability + model list — GET {url}/v1/models with an
 *  optional bearer. Reused by the brain (BYO-model) block below and available for
 *  a future Hermes add-on probe (Voice Master Plan WS-I). Best-effort. */
async function probeOpenAiCompat(url, key, debug) {
    const base = String(url || '').trim().replace(/\/+$/, '');
    if (!base) return { reachable: false, models: [] };
    try {
        const headers = key ? { Authorization: `Bearer ${key}` } : {};
        const resp = await fetch(`${base}/v1/models`, { headers });
        if (debug) debug.brain_models_status = resp.status;
        if (!resp.ok) return { reachable: false, models: [], error: `HTTP ${resp.status}` };
        const body = await resp.json().catch(() => ({}));
        const models = (Array.isArray(body?.data) ? body.data : []).map(m => m.id || m.name).filter(Boolean);
        return { reachable: true, models };
    } catch (e) {
        if (debug) debug.brain_error = e.message;
        return { reachable: false, models: [], error: e.message };
    }
}

/** BYO-model brain endpoint (WS-I): if the account configured a custom OpenAI-
 *  compatible URL (voice.localLlmUrl — Ollama / self-hosted Hermes / remote), probe
 *  it so the picker can pre-fill URL/models like the Kokoro block does. No URL
 *  configured → { configured:false }. Same shape/pattern as _detectKokoro. */
async function _detectBrain(debug) {
    let acct;
    try { acct = await getAccountVoiceConfig(); } catch { return { configured: false, reason: 'no_account' }; }
    const url = acct?.localLlmUrl || '';
    if (!url) return { configured: false };
    const probe = await probeOpenAiCompat(url, acct?.localLlmKey || '', debug);
    return { configured: true, url, ...probe };
}

/** HA's configured locale as 'en_US' (language + country). The Console uses it to narrow a
 *  local box's voice catalog when the account's own language is 'system' — HA already knows
 *  what this household speaks. Best-effort: '' just means "don't narrow". */
async function _detectHaLanguage(debug) {
    try {
        const cfg = await haWs.getHaConfig();
        const lang = String(cfg?.language || '').trim();          // 'en'
        const country = String(cfg?.country || '').trim();        // 'US'
        if (debug) debug.ha_config_locale = { language: lang, country };
        if (!lang) return '';
        return country ? `${lang}_${country.toUpperCase()}` : lang;
    } catch (e) {
        if (debug) debug.ha_config_error = e.message;
        return '';
    }
}

async function detectVoiceEngines({ refresh = false, debug = false } = {}) {
    if (!haWs.isAvailable()) {
        return { available: false, tts: [], stt: [], kokoro: { installed: false, reason: 'ha_unavailable' }, hermes: { installed: false, reason: 'ha_unavailable' }, brain: { configured: false } };
    }
    if (!refresh && !debug && _cache && (Date.now() - _cache.fetchedAt) < CACHE_TTL_MS) {
        return _cache.result;
    }

    const dbg = debug ? {} : null;
    const [tts, stt, kokoro, hermes, brain, haLanguage] = await Promise.all([
        _detectTts(dbg),
        _detectStt(dbg),
        _detectKokoro(dbg),
        _detectHermes(dbg),
        _detectBrain(dbg),
        _detectHaLanguage(dbg),
    ]);
    const result = { available: true, tts, stt, kokoro, hermes, brain, haLanguage };

    // Cache only the clean (non-debug) result so a debug call never poisons it.
    if (!debug) _cache = { result, fetchedAt: Date.now() };
    return debug ? { ...result, _debug: dbg } : result;
}

module.exports = { detectVoiceEngines, probeOpenAiCompat };
