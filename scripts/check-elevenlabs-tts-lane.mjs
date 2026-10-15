#!/usr/bin/env node
/**
 * check-elevenlabs-tts-lane — a tablet's ElevenLabs voice on the household's OWN key (John 2026-10-15),
 * driven through the real handleTts with only the network stubbed.
 *
 *   R  routing   {stream:true, voice_provider:'elevenlabs'} → elevenlabs-tts-lane.js; no voice_provider →
 *                the Gemini lane exactly as before (control); an unknown voice_provider → 409 no_key and
 *                NO provider call (never the Gemini voice for a voice that is not Gemini's).
 *   S  stream    200 audio/pcm pcm_24000 with X-Tts-Provider: elevenlabs, the bytes ElevenLabs sent, the
 *                voice id + pcm_24000 in the URL, the key only in xi-api-key and never in a log line.
 *   K  refusals  no key → 409 no_key, no call; a key fault (401) → 409 key_failed AFTER the account row
 *                write; an outage (500) → 502 provider_failed, no row; no voice → 400.
 *
 * ⚠️ What a green does NOT prove: that ElevenLabs streams pcm_24000 this way today (the fixture is
 *    hand-built), that HA's streaming view forwards voice_provider (HV's tts_stream_view.py), or a tablet.
 * Run: node scripts/check-elevenlabs-tts-lane.mjs   Exit 0 = ALL PASS, 1 = a failure, 2 = cannot check.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Writable } from 'node:stream';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'dashie-ha', 'server');
const require_ = createRequire(import.meta.url);

let config, engines, keyHealth;
try {
    config = require_(join(SERVER, 'config.js'));
    engines = require_(join(SERVER, 'engines.js'));
    keyHealth = require_(join(SERVER, 'key-health.js'));
} catch (e) {
    console.error(`check-elevenlabs-tts-lane: cannot check — module did not load: ${e.message}`);
    process.exit(2);
}
if (config.DATA_DIR === '/data') { console.error('check-elevenlabs-tts-lane: refusing to run — DATA_DIR is /data.'); process.exit(2); }
mkdirSync(config.DATA_DIR, { recursive: true });
const KEYS_FILE = join(config.DATA_DIR, 'api-keys.json');
const USAGE_FILE = require_(join(SERVER, 'usage-store.js')).USAGE_FILE;
const FILES = [KEYS_FILE, config.JWT_FILE, USAGE_FILE];
const SNAPSHOT = Object.fromEntries(FILES.map(f => [f, existsSync(f) ? readFileSync(f, 'utf8') : null]));
process.on('exit', () => {
    for (const [f, c] of Object.entries(SNAPSHOT)) {
        try { rmSync(f, { force: true }); rmSync(f + '.tmp', { force: true }); if (c !== null) writeFileSync(f, c); } catch { /* best effort */ }
    }
});

let failed = 0, passed = 0;
function check(name, ok, detail) {
    if (ok) { passed++; console.log(`✅ ${name}`); return; }
    failed++; console.error(`❌ ${name}\n     ${detail}`);
}

const ELKEY = 'sk_el_control_do_not_use_DEADBEEF';
const GKEY = 'AIzaControl_do_not_use_0000DEADBEEF';
const VOICE = 'cwo4ramDmreHdb4b1Jxz';
const TEXT = 'Very good, sir. The timer is done.';
const PCM = Buffer.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
const setKeys = (o) => writeFileSync(KEYS_FILE, JSON.stringify(o, null, 2));
const signIn = (on) => on
    ? writeFileSync(config.JWT_FILE, JSON.stringify({ jwt: 'control.jwt', expiry: Date.now() + 30 * 86400_000 }))
    : rmSync(config.JWT_FILE, { force: true });

async function drive(fn, route) {
    const lines = [], calls = [], events = [];
    const [log, warn, err, realFetch] = [console.log, console.warn, console.error, globalThis.fetch];
    console.log = (...a) => lines.push(a.join(' '));
    console.warn = (...a) => lines.push(a.join(' '));
    console.error = (...a) => lines.push(a.join(' '));
    globalThis.fetch = async (url, init) => {
        const body = init?.body ? (() => { try { return JSON.parse(init.body); } catch { return null; } })() : null;
        calls.push({ url: String(url), body, headers: init?.headers || {} });
        events.push(`fetch:${String(url).includes('database-operations') ? body?.operation : String(url).split('/')[2]}`);
        return route(String(url), body);
    };
    try { return { value: await fn(events), lines, calls, events }; }
    finally { console.log = log; console.warn = warn; console.error = err; globalThis.fetch = realFetch; }
}
function sink(events) {
    const out = { head: null, chunks: [] };
    const w = new Writable({ write(c, _e, cb) { out.chunks.push(Buffer.from(c)); cb(); } });
    w.writeHead = (status, headers) => { out.head = { status, headers }; events.push(`writeHead:${status}`); };
    const realEnd = w.end.bind(w);
    w.end = (b) => { if (b) out.chunks.push(Buffer.from(b)); events.push('end'); return realEnd(); };
    return { w, out, done: new Promise((r) => w.on('finish', r)) };
}
const req = (payload) => ({ on(ev, cb) { if (ev === 'data') cb(Buffer.from(JSON.stringify(payload))); if (ev === 'end') cb(); return this; } });
async function tts(payload, route) {
    let s;
    const r = await drive(async (events) => {
        s = sink(events);
        await engines.handleTts(req(payload), s.w, (res, status, body) => {
            res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
        });
        await Promise.race([s.done, new Promise((r) => setTimeout(r, 3000))]);
    }, route);
    const body = Buffer.concat(s.out.chunks);
    let json = null; try { json = JSON.parse(body.toString('utf8')); } catch { /* audio */ }
    return { ...r, head: s.out.head, body, json };
}
const noNet = () => { throw new Error('no network expected'); };
const isEl = (u) => u.startsWith('https://api.elevenlabs.io/');
const isGoogle = (u) => u.includes('generativelanguage');
const pcmOk = () => new Response(PCM, { status: 200, headers: { 'Content-Type': 'audio/pcm' } });
const ops = (calls) => calls.filter(c => c.url.includes('database-operations')).map(c => c.body?.operation);
const EL = { text: TEXT, stream: true, voice_provider: 'elevenlabs', voice: VOICE };

// ── S. the stream ────────────────────────────────────────────────────────────
{
    keyHealth.__resetForTest(); signIn(false); setKeys({ elevenlabs: { key: ELKEY }, gemini: { key: GKEY } });
    const t = await tts(EL, (u) => isEl(u) ? pcmOk() : new Response('{}', { status: 200 }));
    const el = t.calls.find(c => isEl(c.url));
    check('S1 — 200 audio/pcm pcm_24000, X-Tts-Provider elevenlabs, payer key',
        t.head?.status === 200 && t.head.headers['Content-Type'] === 'audio/pcm' && t.head.headers['X-Audio-Format'] === 'pcm_24000'
        && t.head.headers['X-Tts-Provider'] === 'elevenlabs' && t.head.headers['X-Tts-Payer'] === 'key', JSON.stringify(t.head));
    check('S2 — the body is the bytes ElevenLabs sent', t.body.equals(PCM), `got ${[...t.body]}`);
    check('S3 — the voice id and pcm_24000 are in the URL; the key only in xi-api-key',
        !!el && el.url.includes(`/text-to-speech/${VOICE}/stream`) && el.url.includes('output_format=pcm_24000')
        && el.headers['xi-api-key'] === ELKEY && !el.url.includes(ELKEY), el?.url);
    check('S4 — no Gemini call when ElevenLabs was asked for (both keys stored)', !t.calls.some(c => isGoogle(c.url)), t.calls.map(c => c.url).join(' '));
    check('S5 — the key is in no log line', !t.lines.some(l => l.includes(ELKEY)), t.lines.join(' | '));
}

// ── R. routing ───────────────────────────────────────────────────────────────
{
    keyHealth.__resetForTest(); setKeys({ elevenlabs: { key: ELKEY }, gemini: { key: GKEY } });
    const g = await tts({ text: TEXT, stream: true }, (u) => isGoogle(u)
        ? new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: PCM.toString('base64') } }] } }] })}\n\n`, { status: 200 })
        : new Response('{}', { status: 200 }));
    check('R1 — CONTROL: no voice_provider → the Gemini lane, as before (X-Tts-Provider gemini, no ElevenLabs call)',
        g.head?.status === 200 && g.head.headers['X-Tts-Provider'] === 'gemini' && g.calls.some(c => isGoogle(c.url)) && !g.calls.some(c => isEl(c.url)),
        `${JSON.stringify(g.head)} ${g.calls.map(c => c.url).join(' ')}`);
    const u = await tts({ ...EL, voice_provider: 'openai' }, noNet);
    check('R2 — an unknown voice_provider → 409 no_key, a DROP line, and NO provider call',
        u.head?.status === 409 && u.json?.reason === 'no_key' && u.calls.length === 0 && u.lines.some(l => l.startsWith('DROP:')),
        `${JSON.stringify(u.head)} ${JSON.stringify(u.json)} calls=${u.calls.length}`);
}

// ── K. refusals ──────────────────────────────────────────────────────────────
{
    keyHealth.__resetForTest(); setKeys({ gemini: { key: GKEY } });
    const n = await tts(EL, noNet);
    check('K1 — no ElevenLabs key (a Gemini key stored) → 409 no_key, no call', n.head?.status === 409 && n.json?.reason === 'no_key' && n.calls.length === 0, JSON.stringify(n.json));

    setKeys({ elevenlabs: { key: ELKEY } }); signIn(true); keyHealth.__resetForTest();
    const k = await tts(EL, (u) => isEl(u) ? new Response('{"detail":{"status":"invalid_api_key"}}', { status: 401 }) : new Response('{}', { status: 200 }));
    const rowAt = k.events.indexOf('fetch:report_key_failure'), headAt = k.events.indexOf('writeHead:409');
    check('K2 — a key fault (401) → 409 key_failed, provider elevenlabs, the account row written BEFORE the 409',
        k.json?.reason === 'key_failed' && k.json?.provider === 'elevenlabs' && rowAt >= 0 && rowAt < headAt, `${JSON.stringify(k.json)} events=${k.events}`);

    keyHealth.__resetForTest();
    const o = await tts(EL, (u) => isEl(u) ? new Response('upstream', { status: 500 }) : new Response('{}', { status: 200 }));
    check('K3 — an outage (500) → 502 provider_failed and NO account row (not the key\'s fault)',
        o.head?.status === 502 && o.json?.reason === 'provider_failed' && !ops(o.calls).includes('report_key_failure'), `${JSON.stringify(o.json)} ops=${ops(o.calls)}`);

    const v = await tts({ ...EL, voice: '' }, noNet);
    check('K4 — no voice id → 400, no provider call (no silent default voice)', v.head?.status === 400 && !v.calls.some(c => isEl(c.url) || isGoogle(c.url)), `${JSON.stringify(v.json)} calls=${v.calls.map(c => c.url).join(' ')}`);
    signIn(false);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (!failed) console.log('check-elevenlabs-tts-lane: ALL PASS');
process.exit(failed ? 1 : 0);
