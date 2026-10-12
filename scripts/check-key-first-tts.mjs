#!/usr/bin/env node
/**
 * check-key-first-tts — the Gemini voice paid by the household's key OR by credits, and a broken key
 * that falls back to credits WITHOUT hiding the fault (John 2026-10-11; O: the key decides who pays,
 * never which voice speaks). Only the network is stubbed; the lane is driven end to end.
 *
 *   A  resolveProvider: the household's CHOSEN voice is an input. Chose Gemini → the Gemini key pays
 *      (even with an ElevenLabs key, even with spendable credits); no Gemini key → null (credits pay
 *      for the same voice). Any other choice → the released rules, unchanged.
 *   S  tablet stream ({stream:true}): PCM on the key, or 409 no_key / key_failed. On key_failed the
 *      account row is written BEFORE the 409 (the tablet force-refreshes on it). An outage is
 *      key_failed for routing but writes NO row (it is not the key's fault).
 *   H  HA speaker: a failed key falls back to credits (Gemini → the edge gemini-tts with the SAME
 *      voice; ElevenLabs → the cloud voice), and the failure is reported. Signed out → no fallback.
 *
 * ⚠️ What a green does NOT prove: that HA, the integration's streaming view (K) or a tablet carries
 *    any of this; that Google returns these shapes today (fixtures are hand-built from the measured
 *    10-10/10-11 calls); or the signed-in ACCOUNT read of the chosen voice (these legs choose via the
 *    panel blob, the same `ttsProvider` key read through the same householdVoice()).
 * Run: node scripts/check-key-first-tts.mjs   Exit 0 = ALL PASS, 1 = a failure, 2 = cannot check.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Writable } from 'node:stream';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'dashie-ha', 'server');
const require_ = createRequire(import.meta.url);

let config, byok, engines, creditBalance, settingsStore, keyHealth;
try {
    config = require_(join(SERVER, 'config.js'));
    byok = require_(join(SERVER, 'byok-tts.js'));
    engines = require_(join(SERVER, 'engines.js'));
    creditBalance = require_(join(SERVER, 'credit-balance.js'));
    settingsStore = require_(join(SERVER, 'settings-store.js'));
    keyHealth = require_(join(SERVER, 'key-health.js'));
} catch (e) {
    console.error(`check-key-first-tts: cannot check — module did not load: ${e.message}`);
    process.exit(2);
}
if (config.DATA_DIR === '/data') { console.error('check-key-first-tts: refusing to run — DATA_DIR is /data.'); process.exit(2); }
mkdirSync(config.DATA_DIR, { recursive: true });
const KEYS_FILE = join(config.DATA_DIR, 'api-keys.json');
const SETTINGS_FILE = join(config.DATA_DIR, 'dashie_ha_settings.json');
// The account's last-known-good cache can answer householdVoice() even signed out; it is moved aside
// so the panel blob below is the ONLY source of the choice (otherwise the legs depend on this box).
const ACCOUNT_CACHE = join(config.DATA_DIR, 'account-config.cache.json');
const USAGE_FILE = require_(join(SERVER, 'usage-store.js')).USAGE_FILE;
const FILES = [KEYS_FILE, SETTINGS_FILE, config.JWT_FILE, USAGE_FILE, ACCOUNT_CACHE];
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

// ── harness ──────────────────────────────────────────────────────────────────
const GKEY = 'AIzaControl_do_not_use_0000DEADBEEF';
const setKeys = (o) => writeFileSync(KEYS_FILE, JSON.stringify(o, null, 2));
// The panel blob nests the console's settings under `userSettings` (settings-store.js readUserSettings).
const choose = (ttsProvider) => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ userSettings: { voice: ttsProvider ? { ttsProvider } : {} } }));
    try { require_(join(SERVER, 'account-config.js')).invalidate(); } catch { /* older module */ }
};
rmSync(ACCOUNT_CACHE, { force: true });
const signIn = (on) => on
    ? writeFileSync(config.JWT_FILE, JSON.stringify({ jwt: 'control.jwt', expiry: Date.now() + 30 * 86400_000 }))
    : rmSync(config.JWT_FILE, { force: true });
const reset = () => { creditBalance.__resetCacheForTest(); keyHealth.__resetForTest(); };

/** Run fn with fetch stubbed by `route(url, init)`; every call is recorded in ORDER with `events`. */
async function drive(fn, route) {
    const lines = [], calls = [], events = [];
    const [log, warn, err, realFetch] = [console.log, console.warn, console.error, globalThis.fetch];
    console.log = (...a) => lines.push(a.join(' '));
    console.warn = (...a) => lines.push(a.join(' '));
    console.error = (...a) => lines.push(a.join(' '));
    globalThis.fetch = async (url, init) => {
        const body = init?.body ? (() => { try { return JSON.parse(init.body); } catch { return null; } })() : null;
        calls.push({ url: String(url), body, headers: init?.headers || {} });
        events.push(`fetch:${String(url).includes('database-operations') ? body?.operation : String(url).split('/').pop().split('?')[0]}`);
        return route(String(url), body);
    };
    try { return { value: await fn(events), lines, calls, events }; }
    finally { console.log = log; console.warn = warn; console.error = err; globalThis.fetch = realFetch; }
}
const noNet = () => { throw new Error('no network expected'); };
const ok200 = (o) => new Response(JSON.stringify(o ?? { data: {} }), { status: 200 });
const bal = (n) => ok200({ data: { balance: n } });

/** A response sink that is a real Writable (pipe needs one) and records writeHead/end in `events`. */
function sink(events) {
    const out = { head: null, chunks: [], json: null };
    const w = new Writable({ write(c, _e, cb) { out.chunks.push(Buffer.from(c)); cb(); } });
    w.writeHead = (status, headers) => { out.head = { status, headers }; events.push(`writeHead:${status}`); };
    const realEnd = w.end.bind(w);
    w.end = (b) => { if (b) out.chunks.push(Buffer.from(b)); events.push('end'); return realEnd(); };
    const done = new Promise((r) => w.on('finish', r));
    return { w, out, done };
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

// SSE fixture, hand-built from the measured 10-11 stream shape (VH): raw L16 24 kHz parts + usageMetadata.
const PCM = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
const sse = (pcm) => [
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.subarray(0, 4).toString('base64') } }] } }] })}`,
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.subarray(4).toString('base64') } }] } }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 49 } })}`,
    '',
].join('\n');
const sseOk = () => new Response(sse(PCM), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const geminiBad = () => new Response(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }), { status: 400 });
const TEXT = 'The kitchen timer is done.';
const isGoogle = (u) => u.includes('generativelanguage');
const ops = (calls) => calls.filter(c => c.url.includes('database-operations')).map(c => c.body?.operation);

// ── A. resolveProvider takes the chosen voice ────────────────────────────────
{
    reset(); signIn(false);
    choose('gemini'); setKeys({ gemini: { key: GKEY }, elevenlabs: { key: 'el_control' } });
    let r = await drive(() => byok.resolveProvider(), noNet);
    check('A1 — chose Gemini + Gemini AND ElevenLabs keys → gemini (the choice, not a cheaper voice)', r.value === 'gemini', `got ${r.value}`);
    setKeys({ elevenlabs: { key: 'el_control' } });
    r = await drive(() => byok.resolveProvider(), noNet);
    check('A2 — chose Gemini, NO Gemini key, an ElevenLabs key → null (credits pay for Gemini; no switch to ElevenLabs)', r.value === null, `got ${r.value}`);
    choose(''); setKeys({ gemini: { key: GKEY }, elevenlabs: { key: 'el_control' } });
    r = await drive(() => byok.resolveProvider(), noNet);
    check('A3 — no Gemini choice → released rules unchanged (ElevenLabs over Gemini)', r.value === 'elevenlabs', `got ${r.value}`);
    reset(); signIn(true); choose('gemini'); setKeys({ gemini: { key: GKEY } });
    r = await drive(() => byok.resolveProvider(), (u) => u.includes('database-operations') ? bal(5) : new Response('', { status: 500 }));
    check('A4 — SIGNED IN with spendable credits, chose Gemini + key → gemini, and no balance read (KEY FIRST)',
        r.value === 'gemini' && !ops(r.calls).includes('get_credit_balance'), `got ${r.value} ops=${ops(r.calls)}`);
    choose('');
    reset();
    r = await drive(() => byok.resolveProvider(), (u) => u.includes('database-operations') ? bal(5) : new Response('', { status: 500 }));
    check('A5 — signed in with credits, NO Gemini choice → null (the account voice is kept, as released)', r.value === null, `got ${r.value}`);
}

// ── S. tablet stream ─────────────────────────────────────────────────────────
{
    reset(); signIn(true); choose('gemini');
    setKeys({});
    let t = await tts({ text: TEXT, stream: true }, noNet);
    check('S1 — stream, no Gemini key → 409 {reason:no_key}; Google never called, no row written',
        t.head?.status === 409 && t.json?.reason === 'no_key' && !t.calls.some(c => isGoogle(c.url)) && !ops(t.calls).some(o => /^report_key/.test(o)),
        `head=${JSON.stringify(t.head)} json=${JSON.stringify(t.json)} calls=${t.calls.map(c => c.url).join(' ')}`);

    setKeys({ gemini: { key: GKEY } });
    t = await tts({ text: TEXT, stream: true, voice: 'Aoede' }, (u) => isGoogle(u) ? sseOk() : ok200());
    check('S2 — stream on the key → 200 audio/pcm pcm_24000, the exact PCM bytes, payer=key',
        t.head?.status === 200 && t.head.headers['Content-Type'] === 'audio/pcm' && t.head.headers['X-Audio-Format'] === 'pcm_24000'
        && t.head.headers['X-Tts-Payer'] === 'key' && t.body.equals(PCM),
        `head=${JSON.stringify(t.head)} body=${[...t.body]}`);
    const g = t.calls.find(c => isGoogle(c.url));
    check('S3 — the requested Gemini voice is the one sent, via streamGenerateContent?alt=sse, key in a header not the URL',
        g?.body?.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName === 'Aoede'
        && /:streamGenerateContent\?alt=sse$/.test(g.url) && !g.url.includes(GKEY) && g.headers['x-goog-api-key'] === GKEY,
        `url=${g?.url} voice=${JSON.stringify(g?.body?.generationConfig)}`);
    check('S4 — a key that WORKS reports ok to the account (clears any open episode)', ops(t.calls).includes('report_key_ok'), `ops=${ops(t.calls)}`);
    check('S5 — the key never appears in a log line', !t.lines.some(l => l.includes(GKEY)), t.lines.filter(l => l.includes(GKEY)).join(' | '));

    reset();
    t = await tts({ text: TEXT, stream: true }, (u) => isGoogle(u) ? geminiBad() : ok200({ data: { recorded: true } }));
    check('S6 — bad key (Gemini 400 API_KEY_INVALID) → 409 {key_failed, gemini, invalid_key}',
        t.head?.status === 409 && t.json?.reason === 'key_failed' && t.json.provider === 'gemini' && t.json.status === 'invalid_key',
        `head=${JSON.stringify(t.head)} json=${JSON.stringify(t.json)}`);
    const wi = t.events.indexOf('fetch:report_key_failure'), hi = t.events.indexOf('writeHead:409');
    check('S7 — the account row is written BEFORE the 409 goes out (the tablet force-refreshes on it)',
        wi !== -1 && hi !== -1 && wi < hi, `events=${t.events.join(' → ')}`);

    reset();
    t = await tts({ text: TEXT, stream: true }, (u) => isGoogle(u) ? new Response('down', { status: 503 }) : ok200());
    check('S8 — a Google OUTAGE → 409 key_failed/upstream_error for routing, but NO row (not the key\'s fault)',
        t.head?.status === 409 && t.json?.status === 'upstream_error' && !ops(t.calls).includes('report_key_failure'),
        `json=${JSON.stringify(t.json)} ops=${ops(t.calls)}`);

    reset();
    t = await tts({ text: TEXT, stream: true }, (u) => isGoogle(u) ? new Response('{"error":{"message":"Invalid JSON payload"}}', { status: 400 }) : ok200());
    check('S9 — a plain 400 (OUR malformed request) → status other, NO row', t.json?.status === 'other' && !ops(t.calls).includes('report_key_failure'),
        `json=${JSON.stringify(t.json)} ops=${ops(t.calls)}`);

    reset();
    t = await tts({ text: TEXT, stream: true, voice: '21m00Tcm4TlvDq8ikWAM' }, (u) => isGoogle(u) ? sseOk() : ok200());
    const gv = t.calls.find(c => isGoogle(c.url))?.body?.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName;
    check('S10 — a non-Gemini voice id → the box\'s ONE Gemini default (gemini-tts.js DEFAULT_VOICE), not the edge\'s',
        gv === require_(join(SERVER, 'gemini-tts.js')).DEFAULT_VOICE, `voice=${gv}`);
}

// ── H. HA speakers: a failed key falls back to credits, loudly ───────────────
{
    const wav24 = (u) => new Response(Buffer.alloc(9600, 3), { status: 200, headers: { 'Content-Type': 'audio/pcm' } });
    reset(); signIn(true); choose('gemini'); setKeys({ gemini: { key: GKEY } });
    let t = await tts({ text: TEXT, voice: 'Aoede' }, (u) => isGoogle(u) ? new Response('', { status: 401 }) : u.includes('gemini-tts') ? wav24(u) : ok200());
    const edge = t.calls.find(c => /\/functions\/v1\/gemini-tts$/.test(c.url));
    check('H1 — HA speaker, Gemini key 401 → the edge gemini-tts on credits, 200 audio/wav (RIFF)',
        t.head?.status === 200 && t.head.headers['Content-Type'] === 'audio/wav' && t.body.toString('ascii', 0, 4) === 'RIFF' && !!edge,
        `head=${JSON.stringify(t.head)} calls=${t.calls.map(c => c.url).join(' ')}`);
    const keyVoice = t.calls.find(c => isGoogle(c.url))?.body?.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName;
    check('H2 — the credits call asks for the SAME voice the key call did (a fallback turn never changes the voice)',
        !!keyVoice && edge?.body?.voice_id === keyVoice && edge?.body?.record_usage === true, `key=${keyVoice} credits=${edge?.body?.voice_id}`);
    const fi = t.events.indexOf('fetch:report_key_failure'), ei = t.events.findIndex(e => e === 'fetch:gemini-tts');
    check('H3 — the key failure is reported (the pill), before the credits call', fi !== -1 && ei !== -1 && fi < ei, `events=${t.events.join(' → ')}`);
    check('H4 — never the cloud default voice (inworld) for a household that chose Gemini', !t.calls.some(c => c.url.includes('inworld-tts')), t.calls.map(c => c.url).join(' '));

    reset(); setKeys({});
    t = await tts({ text: TEXT }, (u) => u.includes('gemini-tts') ? wav24(u) : u.includes('inworld') ? noNet() : ok200());
    check('H5 — chose Gemini, NO key, signed in → credits pay for Gemini (edge gemini-tts), not the account\'s inworld voice',
        t.head?.status === 200 && t.calls.some(c => /\/gemini-tts$/.test(c.url)) && !t.calls.some(c => c.url.includes('inworld-tts')),
        `head=${JSON.stringify(t.head)} calls=${t.calls.map(c => c.url).join(' ')}`);

    reset(); choose(''); setKeys({ elevenlabs: { key: 'el_control' } });
    t = await tts({ text: TEXT }, (u) => u.includes('elevenlabs.io') ? new Response('', { status: 401 }) : u.includes('inworld-tts') ? new Response(Buffer.from('ID3mp3'), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }) : ok200());
    const rep = t.calls.find(c => c.body?.operation === 'report_key_failure');
    check('H6 — ElevenLabs key 401, signed in → reported as elevenlabs/invalid_key, then the cloud voice on credits (200)',
        t.head?.status === 200 && rep?.body?.data?.provider === 'elevenlabs' && rep.body.data.status === 'invalid_key' && t.calls.some(c => c.url.includes('inworld-tts')),
        `head=${JSON.stringify(t.head)} rep=${JSON.stringify(rep?.body)}`);

    reset(); signIn(false); choose('gemini'); setKeys({ gemini: { key: GKEY } });
    t = await tts({ text: TEXT }, (u) => isGoogle(u) ? new Response('', { status: 401 }) : noNet());
    check('H7 — signed OUT, key 401 → no credits to fall back to: the provider error, loudly (no account call at all)',
        t.head?.status === 502 && !t.calls.some(c => c.url.includes('supabase') || c.url.includes('functions/v1')) && t.lines.some(l => l.includes('DROP: tts byok')),
        `head=${JSON.stringify(t.head)} calls=${t.calls.map(c => c.url).join(' ')}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log('   (green does NOT prove HA, the K view or a tablet carries this; fixtures are hand-built; the signed-in ACCOUNT read of the choice is not driven here)');
if (!failed) console.log('check-key-first-tts: ALL PASS');
process.exit(failed ? 1 : 0);
