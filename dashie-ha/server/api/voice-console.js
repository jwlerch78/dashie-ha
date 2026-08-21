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
const { classifySharingState } = require('../sharing-state');
const { requireIngressUser } = require('../require-ingress-user');

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
const PREVIEW_TEXT = "Hi, I'm your Dashie voice. Tomorrow looks sunny with a high of seventy five.";
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

// GET /api/voice/personality-templates — the built-in roster, account-less.
//
// 🔴 The whole point: the console previously asked `list_personality_templates`,
// an ACCOUNT-backed call, so a box with no account rendered an empty list — not
// a bug in the page, a question only an account could answer. This re-sources
// the answer rather than faking it.
//
// No auth gate, matching `/engines` above: it returns static data that ships in
// the image and is readable by anyone who can already read the add-on's files.
// Gating it would be theatre, and the console needs it on every render.
router.get('/personality-templates', (req, res) => {
    try {
        const personalityTemplates = require('../personality-templates');
        return res.json({ ok: true, templates: personalityTemplates.listTemplates() });
    } catch (e) {
        // Fail LOUD and EMPTY-WITH-A-REASON rather than quietly returning [].
        // A silent empty list here is indistinguishable from "this household has
        // no personalities", which is the exact state this route exists to end.
        console.warn(`DROP: personality-templates unavailable — ${e.message}`);
        return res.status(503).json({ ok: false, reason: 'unavailable', templates: [] });
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
// add-on options endpoint → signed-in Dashie Cloud → setup guidance), just
// Ingress-trusted instead of secret-gated.
router.post('/converse-local', express.json(), async (req, res) => {
    const body = req.body || {};
    if (!body.text || typeof body.text !== 'string') {
        return res.status(400).json({ error: 'bad_request', message: 'text is required' });
    }
    const { status, body: turn, routeTag } = await converse(body);
    // 🏷️ Which tier actually SERVED this turn, on the wire.
    //
    // `X-Dashie-Brain-Route: local` (set by the integration from the account's config)
    // says where the turn was SENT; it cannot say which local tier answered — the
    // Configuration tab, the account's own endpoint, or a BYOK provider all read
    // "local". Verifying tier 1b cost a whole session partly because the only place
    // that distinction existed was an add-on stdout line, and the nearest wire field
    // (`route: "direct"`, the brain's INTERNAL pass routing) reads like an answer and
    // is not one. This header is the answer, and it is greppable.
    if (routeTag) res.set('X-Dashie-Brain-Tier', routeTag);
    res.status(status).json(turn);
});

// GET /api/voice/local-status — debug/info probe: where would a turn route?
//
// ⭐ `tts` reports the route the lane would ACTUALLY take, BYOK included, and
// that is the point of touching it: a household with a speech key gets a
// different engine and nothing else on the box says so. A route you cannot ask
// about is one you have to reproduce a bug to discover — and the same field
// previously answered from the options file alone, which is a description of
// configuration rather than of behaviour.
router.get('/local-status', (req, res) => {
    const opts = readOptions();
    const endpoint = String(opts.llm_url || '').trim();
    const model = String(opts.llm_model || '').trim();
    const signedIn = !!auth.readStoredJwt();
    const byokTts = require('../byok-tts');
    const byokTtsProvider = byokTts.resolveProvider();
    res.json({
        ok: true,
        route: endpoint && model ? 'local' : (signedIn ? 'cloud' : 'unconfigured'),
        endpoint: endpoint || null,
        model: model || null,
        signed_in: signedIn,
        stt: opts.stt_url || (signedIn ? 'dashie_cloud' : null),
        // Same precedence as engines.handleTts, in the same order. If these two
        // ever disagree the probe is the thing that is wrong.
        tts: opts.tts_url || byokTtsProvider || (signedIn ? 'dashie_cloud' : null),
        tts_byok_provider: byokTtsProvider,
    });
});

// ── GET /api/voice/sharing-state — what this household is ACTUALLY lending ───
//
// CONTRACTS #72's five states, classified server-side. The console renders the
// sentences; this decides WHICH state holds.
//
// 🔴 WHY THIS EXISTS AT ALL, and it is the whole point: the Household Sharing
// card already shows the TOGGLE, and the toggle being ON does not mean anything
// is being lent. Sharing ON with no key configured lends nothing, and the
// control renders a confident green either way. That is a control-level green
// standing in for an outcome-level one — the same class as a passing gate on an
// unreachable feature — sitting in the product rather than in the tooling.
// This answers the outcome question: what would a satellite get if it asked
// right now?
//
// 🔴 READ-ONLY, and it must stay that way. `grantableCapabilities(null)` is the
// SAME predicate the lease path uses, called with no side effect: it issues no
// lease, records nothing in LEASE_OBSERVED, and moves no money. Anything that
// made this write would turn an indicator into an actor.
//
// ⭐ WHY THE LIVE PREDICATE AND NOT `LEASE_OBSERVED`: the observational map
// (api/internal.js) is in-memory, bounded to 50, lost on every add-on restart,
// records ONLY successful grants, and does not carry `withheld` at all. So it
// can never answer "why is nothing being shared" — the question with the two
// opposite remedies. The live predicate is authoritative, restart-proof, and
// already carries the reasons. The map remains the only source for the
// PER-DEVICE view, which is exactly why that view must render nothing when a
// device is absent rather than inferring a denial (#72).
//
// The state machine itself is in ../sharing-state.js — one holder, and a holder
// a control can actually call. Whether the console renders one sentence or two
// when `remedy` is present is a RENDERING decision that is not mine alone (#72:
// "so neither surface invents a third"); the payload carries enough for either,
// so nothing is thrown away when it is answered.
router.get('/sharing-state', async (req, res) => {
    // Fail to UNKNOWN, never to a reassuring answer. An indicator that guesses
    // "off" when it cannot read is the 2026-07-31 bug — sharing was ON for a
    // day while the card said Off.
    const unknown = (why) => {
        console.warn(`DROP: sharing-state unavailable — ${why}`);
        return res.json({ ok: true, state: 'unknown', remedy: null, reason: why });
    };

    try {
        const capability = require('../capability');
        const g = await capability.grantableCapabilities(null);
        const { state, remedy } = classifySharingState(g);
        return res.json({
            ok: true,
            state,
            remedy,
            // Supporting facts, so the page can be debugged without re-deriving
            // the classification from a second copy of these rules.
            sharing: !!g.sharing,
            granted: g.granted,
            withheld: g.withheld || {},
        });
    } catch (e) {
        return unknown(`predicate_failed: ${e.message}`);
    }
});

// ── GET /api/voice/lease-observations — which devices have leased recently ───
//
// The PER-DEVICE half of CONTRACTS #72, joined to the Devices roster on
// `endpoint_id` == roster `device_id` (T verified those byte-identical on a real
// box, `706675418675e7903cc1d3db95b3b789`).
//
// 🔴 A DIFFERENT QUESTION FROM THE HOUSEHOLD CARD, and the copy must not blur
// them. This answers *"observed leasing recently"*. `/sharing-state` answers
// *"what would a satellite get right now"* — the live predicate. Sourcing a
// present-tense claim from this map would be a confident falsehood after every
// restart, because the map is empty then and this route would honestly report an
// empty list.
//
// 🔴 NOT AUTHORITATIVE, and `[]` NEVER MEANS "NOTHING IS SHARED". The map is
// in-memory, bounded, lost on restart, and records only SUCCESSFUL grants — a
// refusal leaves no row. Absence is UNKNOWN. #72 pins the consequence: an absent
// device renders NOTHING. `authoritative: false` ships in the payload so a
// consumer cannot read this route's shape without meeting that fact.
//
// ── AUTH: requireIngressUser, and it is STRICTER than the roster ─────────────
//
// O's s99 ruling said to match the roster's auth. ⚠️ I measured it rather than
// assuming, and the premise was wrong: the roster rides `/api/ha/status`, which
// is UNGATED BY DESIGN ("Open (no auth) since the Console needs it on every
// render"). So "identical to the roster" would have meant NO auth. This gate is
// deliberately stricter, which satisfies the ruling's actual intent — never
// WIDER than the roster — trivially. Stricter is not wider.
//
// D's s52 amendment applies verbatim: `requireIngressUser` is the load-bearing
// guard. `isIngress()` is NOT a boundary — it accepts `x-ingress-path`, which
// any caller can supply, so anyone auditing this by reading `isIngress()` would
// test the wrong header and conclude the wrong thing.
router.get('/lease-observations', requireIngressUser('voice-lease-observations'), (req, res) => {
    try {
        const leaseObservations = require('../lease-observations');
        return res.json({
            ok: true,
            // Both flags are load-bearing for the consumer, not decoration.
            authoritative: false,
            note: 'observational only — empty means NOTHING OBSERVED (lost on every restart), never "nothing is shared"',
            leases: leaseObservations.list(),
        });
    } catch (e) {
        // Fail to an explicit unknown rather than an empty list: `[]` and "could
        // not read" are different answers, and only one of them is safe to
        // render as "no devices have leased".
        console.warn(`DROP: lease-observations unavailable — ${e.message}`);
        return res.status(503).json({ ok: false, reason: 'unavailable' });
    }
});

module.exports = router;
