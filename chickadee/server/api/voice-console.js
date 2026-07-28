// SPDX-License-Identifier: AGPL-3.0-only
// api/voice-console.js — console-facing voice endpoints (Ingress-trusted).
//
// Ported from the dashie add-on's api/voice-local.js: the Voice & AI / Local
// Engines pages' probes run SERVER-side because the console is served over
// https (Ingress) and LAN engines are plain http — the browser can't reach
// them cross-origin/mixed-content. The bridge-gated /api/voice/converse|stt|
// tts|voices routes live in index.js — this router only adds the console set.

'use strict';

const express = require('express');
const { converse } = require('../converse');
const { detectVoiceEngines } = require('../voice-engines');
const lanDiscovery = require('../lan-discovery');
const { readOptions } = require('../options');
const auth = require('../auth');

const router = express.Router();

// GET /api/voice/engines — which local STT/TTS engines does the user's HA have?
//   ?refresh=1  bypass the 5-min cache (Console "Re-scan")
//   ?debug=1    attach a `_debug` block with raw WS shapes
// No sign-in gate: reads HA config only, and the Console needs it either way.
router.get('/engines', async (req, res) => {
    try {
        const result = await detectVoiceEngines({
            refresh: req.query.refresh === '1' || req.query.refresh === 'true',
            debug: req.query.debug === '1' || req.query.debug === 'true',
        });
        res.json(result);
    } catch (e) {
        console.error('[voice-console] engine detection failed:', (e && e.stack) || e);
        // Best-effort — never 500 the picker; the Console falls back to URL rows.
        res.json({ available: false, tts: [], stt: [], kokoro: { installed: false, reason: 'error' }, hermes: { installed: false, reason: 'error' }, error: (e && e.message) || String(e) });
    }
});

// POST /api/voice/probe  { url, kind: 'tts' | 'stt' | 'llm' }
// Reachability test behind the Console's "Test" button, returning the engine's
// option list (voices/models) so the sibling free-text field becomes a dropdown.
const PROBE_PATHS = {
    tts: ['/v1/audio/voices'],
    llm: ['/v1/models', '/api/tags'],
    stt: ['/v1/models', '/health'],
};

/** Pull an option list out of whatever shape the engine answered with:
 *  {voices:[…]} (Kokoro/piper-shim), {data:[{id}]} (OpenAI), {models:[{name}]}
 *  (Ollama). `language` passes through so the Console can narrow by locale. */
function extractOptions(j) {
    const norm = (v) => (typeof v === 'string'
        ? { value: v, label: v }
        : (v && (v.voice_id || v.id || v.name))
            ? {
                value: String(v.voice_id || v.id || v.name),
                label: String(v.name || v.voice_id || v.id),
                ...(v.language ? { language: String(v.language) } : {}),
            }
            : null);
    const list = Array.isArray(j?.voices) ? j.voices
        : Array.isArray(j?.data) ? j.data
        : Array.isArray(j?.models) ? j.models
        : null;
    if (!list) return null;
    const opts = list.map(norm).filter(Boolean);
    return opts.length ? opts : null;
}

router.post('/probe', express.json(), async (req, res) => {
    const { url, kind } = req.body || {};
    if (!/^https?:\/\//i.test(String(url || ''))) {
        return res.json({ ok: false, detail: 'enter a full http:// URL (with port)' });
    }
    const base = String(url).replace(/\/+$/, '');
    const paths = PROBE_PATHS[kind] || PROBE_PATHS.stt;
    const noun = kind === 'llm' ? 'model' : kind === 'tts' ? 'voice' : 'model';
    let lastDetail = 'no response';
    for (const p of paths) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 5000);
        try {
            const resp = await fetch(base + p, { signal: ctl.signal });
            clearTimeout(timer);
            if (resp.ok) {
                let detail = `HTTP ${resp.status}`;
                let options = null;
                try {
                    const j = await resp.json();
                    options = extractOptions(j);
                    if (options) detail = `${options.length} ${noun}${options.length === 1 ? '' : 's'} found`;
                } catch (_) { /* non-JSON body is still a reachable server (e.g. /health) */ }
                return res.json({ ok: true, detail, ...(options ? { options } : {}) });
            }
            lastDetail = `HTTP ${resp.status} on ${p}`;
        } catch (e) {
            clearTimeout(timer);
            lastDetail = e?.name === 'AbortError' ? 'timed out (5s)' : (e?.cause?.code || e?.message || 'fetch failed');
        }
    }
    res.json({ ok: false, detail: lastDetail });
});

// POST /api/voice/preview  { url, voice, text? }  → audio/wav
// "Hear this voice" — proxied for the same mixed-content reason as the probe.
const PREVIEW_TEXT = "Hi, I'm your Chickadee voice. Tomorrow looks sunny with a high of seventy five.";
const PREVIEW_TIMEOUT_MS = 20000;   // a cold high-quality voice can take a few seconds

router.post('/preview', express.json(), async (req, res) => {
    const { url, voice, text } = req.body || {};
    if (!/^https?:\/\//i.test(String(url || ''))) {
        return res.status(400).json({ error: 'bad_url', message: 'enter a full http:// URL (with port)' });
    }
    const base = String(url).replace(/\/+$/, '');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PREVIEW_TIMEOUT_MS);
    try {
        const upstream = await fetch(`${base}/v1/audio/speech`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: ctl.signal,
            body: JSON.stringify({
                model: 'kokoro',                       // ignored by every server we support; Kokoro validates it
                input: String(text || PREVIEW_TEXT).slice(0, 300),
                voice: String(voice || ''),
                response_format: 'wav',
                speed: 1.0,
            }),
        });
        clearTimeout(timer);
        if (!upstream.ok) {
            const detail = await upstream.text().catch(() => '');
            return res.status(502).json({ error: 'engine_error', message: `HTTP ${upstream.status}`, detail: detail.slice(0, 200) });
        }
        const audio = Buffer.from(await upstream.arrayBuffer());
        res.set('Content-Type', 'audio/wav');
        res.set('Cache-Control', 'no-store');
        return res.send(audio);
    } catch (e) {
        clearTimeout(timer);
        const msg = e?.name === 'AbortError' ? 'the engine took too long' : (e?.cause?.code || e?.message || 'fetch failed');
        return res.status(504).json({ error: 'unreachable', message: msg });
    }
});

// POST /api/voice/discover  { subnet? } — the Local Engines "Scan network"
// button. USER-INITIATED ONLY, private /24 only (lan-discovery.js).
router.post('/discover', express.json(), async (req, res) => {
    try {
        const subnetOverride = String(req.body?.subnet || '').trim() || null;
        const result = await lanDiscovery.discover({ subnetOverride });
        res.json(result);
    } catch (e) {
        console.error('[voice-console] discovery failed:', (e && e.stack) || e);
        res.json({ ok: false, reason: (e && e.message) || String(e), engines: [] });
    }
});

// POST /api/voice/converse-local — one brain turn for the Console's chat/test
// card. Same route logic as the bridge's /api/voice/converse (converse.js:
// add-on options endpoint → signed-in Chickadee Cloud → setup guidance), just
// Ingress-trusted instead of secret-gated.
router.post('/converse-local', express.json(), async (req, res) => {
    const body = req.body || {};
    if (!body.text || typeof body.text !== 'string') {
        return res.status(400).json({ error: 'bad_request', message: 'text is required' });
    }
    const { status, body: turn } = await converse(body);
    res.status(status).json(turn);
});

// GET /api/voice/local-status — debug/info probe: where would a turn route?
router.get('/local-status', (req, res) => {
    const opts = readOptions();
    const endpoint = String(opts.llm_url || '').trim();
    const model = String(opts.llm_model || '').trim();
    const signedIn = !!auth.readStoredJwt();
    res.json({
        ok: true,
        route: endpoint && model ? 'local' : (signedIn ? 'cloud' : 'unconfigured'),
        endpoint: endpoint || null,
        model: model || null,
        signed_in: signedIn,
        stt: opts.stt_url || (signedIn ? 'chickadee_cloud' : null),
        tts: opts.tts_url || (signedIn ? 'chickadee_cloud' : null),
    });
});

module.exports = router;
