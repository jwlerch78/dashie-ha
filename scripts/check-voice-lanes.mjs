#!/usr/bin/env node
/**
 * check-voice-lanes — GET /api/voice/lanes and the voice lanes it describes give ONE
 * answer (HV + B, 2026-10-11).
 *
 *   • AGREEMENT  For each box state that changes the answer, drive the REAL /lanes
 *                handler (through its auth middleware) and the REAL handleTts /
 *                handleStt, and assert /lanes `serves` names the engine the lane
 *                actually called (read off the network the lane touched).
 *   • PLANT      A stale routing function is swapped in for /lanes ONLY; the agreement
 *                legs must then go RED. Without this, an always-equal comparison
 *                would pass on a /lanes that never consulted the lane at all.
 *   • ROWS       Three states kept apart: absent (not this server's question),
 *                false+why (would fail), null (configured, unprobed). Credits:
 *                spendable/empty/unknown. No URL is echoed (host only).
 *   • AUTH       No ingress user → refused (it carries a balance).
 *
 * What a green does NOT prove: that a configured household box is reachable (the
 * endpoint deliberately does not probe it), or anything about the CONSOLE's offering
 * (the cohort gate is the console's). Run: node scripts/check-voice-lanes.mjs
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'dashie-ha', 'server');
const require_ = createRequire(import.meta.url);

// ── box state, read by the two substituted modules ───────────────────────────
const state = { options: {}, acct: {} };
let config, engines, voiceConsole, creditBalance, voiceRoutesPath;
try {
    config = require_(join(SERVER, 'config.js'));
    // /data/options.json is not writable here, and modules destructure readOptions at
    // load: substitute BEFORE anything else loads.
    require_(join(SERVER, 'options.js')).readOptions = () => state.options;
    require_(join(SERVER, 'account-config.js')).getAccountVoiceConfig = async () => state.acct;
    creditBalance = require_(join(SERVER, 'credit-balance.js'));
    engines = require_(join(SERVER, 'engines.js'));
    voiceConsole = require_(join(SERVER, 'api', 'voice-console.js'));
    voiceRoutesPath = require_.resolve(join(SERVER, 'voice-routes.js'));
} catch (e) {
    console.error(`check-voice-lanes: cannot check — module did not load: ${e.message}`);
    process.exit(2);
}
if (config.DATA_DIR === '/data') {
    console.error('check-voice-lanes: refusing to run — DATA_DIR is /data (a real add-on volume).');
    process.exit(2);
}
mkdirSync(config.DATA_DIR, { recursive: true });
const KEYS_FILE = join(config.DATA_DIR, 'api-keys.json');
const SETTINGS_FILE = join(config.DATA_DIR, 'dashie_ha_settings.json');
const FILES = [KEYS_FILE, SETTINGS_FILE, config.JWT_FILE];
const SNAPSHOT = Object.fromEntries(FILES.map(f => [f, existsSync(f) ? readFileSync(f, 'utf8') : null]));
process.on('exit', () => {
    for (const [f, c] of Object.entries(SNAPSHOT)) {
        try { rmSync(f, { force: true }); if (c !== null) writeFileSync(f, c); } catch { /* best effort */ }
    }
});

let failed = 0, passed = 0;
const check = (name, ok, detail) => { if (ok) { passed++; console.log(`✅ ${name}`); } else { failed++; console.error(`❌ ${name}\n     ${detail}`); } };

const SECRET = 'SEKRETkey0000';
function setBox({ signedIn = false, keys = {}, balance = 'none', options = {}, voice = {} }) {
    writeFileSync(KEYS_FILE, JSON.stringify(Object.fromEntries(Object.entries(keys).map(([k]) => [k, { key: `${k}_control_key` }]))));
    if (signedIn) writeFileSync(config.JWT_FILE, JSON.stringify({ jwt: 'control.jwt', expiry: Date.now() + 30 * 86400_000 }));
    else rmSync(config.JWT_FILE, { force: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify({ userSettings: { voice } }));
    state.options = options;
    state.balance = balance;   // a number | 'unknown'
    creditBalance.__resetCacheForTest();
}

/** The one network stub: answers every call and records which engine was reached. */
function netStub(touched) {
    const wav = (() => { const h = Buffer.alloc(44 + 4800); h.write('RIFF', 0); h.writeUInt32LE(36 + 4800, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(4800, 40); return h; })();
    return async (url) => {
        const u = String(url);
        if (u.includes('database-operations')) {
            if (state.balance === 'unknown') return new Response('oops', { status: 500 });
            return new Response(JSON.stringify({ data: { balance: state.balance } }), { status: 200 });
        }
        if (u.includes('generativelanguage')) {
            touched.push('gemini');
            const audio = { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }] } }], usageMetadata: { promptTokenCount: 1 } };
            const stt = { candidates: [{ content: { parts: [{ text: 'hi' }] } }], usageMetadata: { promptTokenCount: 1 } };
            return new Response(JSON.stringify(u.includes('tts') ? audio : stt), { status: 200 });
        }
        if (u.includes('elevenlabs.io')) { touched.push('elevenlabs'); return new Response(new Uint8Array([1, 2, 3]), { status: 200 }); }
        // Gemini STT on CREDITS (the gemini-stt edge, since 10-12): the ENGINE is gemini, so it reports as gemini.
        if (u.includes('/functions/v1/gemini-stt')) { touched.push('gemini'); return new Response(JSON.stringify({ transcript: 'hi', model: 'gemini-3.5-transcribe' }), { status: 200 }); }
        if (u.includes('/functions/v1/inworld-tts') || u.includes('/functions/v1/whisper-stt')) {
            touched.push('dashie_cloud');
            return new Response(u.includes('whisper') ? JSON.stringify({ text: 'hi' }) : new Uint8Array([1]), { status: 200 });
        }
        if (u.includes('operator.box')) { touched.push('operator_url'); return new Response(u.includes('transcriptions') ? JSON.stringify({ text: 'hi' }) : wav, { status: 200 }); }
        if (u.includes('household.box')) { touched.push('household_box'); return new Response(u.includes('transcriptions') ? JSON.stringify({ text: 'hi' }) : wav, { status: 200 }); }
        touched.push(`other:${u.slice(0, 60)}`);
        return new Response('{}', { status: 500 });
    };
}

async function quietly(fn, fetchImpl) {
    const [l, w, e, f] = [console.log, console.warn, console.error, globalThis.fetch];
    const lines = [];
    console.log = console.warn = console.error = (...a) => lines.push(a.join(' '));
    globalThis.fetch = fetchImpl;
    try { return { value: await fn(), lines }; } finally { console.log = l; console.warn = w; console.error = e; globalThis.fetch = f; }
}

/** Drive the REAL /lanes route, middleware included. */
async function lanes(headers = { 'x-remote-user-id': 'u1', 'x-ingress-path': '/x' }) {
    const layer = voiceConsole.stack.find(L => L.route?.path === '/lanes' && L.route.methods.get);
    if (!layer) return { status: 0, body: null };
    const out = { status: 200, body: null };
    // The middleware calls next() without returning it, so awaiting the chain does NOT
    // wait for the async handler: settle on the response being WRITTEN instead.
    let settle;
    const written = new Promise((r) => { settle = r; });
    const res = {
        status(c) { out.status = c; return this; },
        json(b) { out.body = b; settle(); return this; },
        send(b) { out.body = b; settle(); return this; },
        end() { settle(); return this; },
        set() { return this; },
    };
    const req = { headers, query: {} };
    const fns = layer.route.stack.map(s => s.handle);
    let i = 0;
    const next = (err) => { if (err) { out.status = 500; settle(); return; } const fn = fns[i++]; if (fn) return fn(req, res, next); settle(); };
    const q = await quietly(async () => {
        next();
        await Promise.race([written, new Promise((r) => setTimeout(r, 5000))]);
    }, netStub([]));
    out.lines = q.lines;
    return out;
}

/** Drive the REAL lane; report which engine the network says it reached. */
async function drive(kind) {
    const touched = [];
    const out = { status: 200, json: null };
    const body = kind === 'tts' ? Buffer.from(JSON.stringify({ text: 'Timer done.' })) : Buffer.alloc(44 + 3200);
    const req = { query: {}, headers: {}, on(ev, cb) { if (ev === 'data') cb(body); if (ev === 'end') cb(); return this; } };
    const res = { writeHead(s) { out.status = s; }, end() {}, setHeader() {} };
    const sendJson = (_r, s, b) => { out.status = s; out.json = b; };
    await quietly(() => (kind === 'tts' ? engines.handleTts : engines.handleStt)(req, res, sendJson), netStub(touched));
    if (out.status === 503) return null;
    const hit = touched;
    if (hit.includes('household_box')) return kind === 'tts' ? 'local_url' : 'local_stt_url';
    return hit[0] ?? `none(status ${out.status})`;
}

const STATES = [
    ['TTS signed out, no keys', 'tts', { }],
    ['TTS signed out, Gemini key', 'tts', { keys: { gemini: 1 } }],
    ['TTS signed in + SPENDABLE, Gemini key', 'tts', { signedIn: true, keys: { gemini: 1 }, balance: 5 }],
    ['TTS signed in + EMPTY, Gemini key', 'tts', { signedIn: true, keys: { gemini: 1 }, balance: 0 }],
    ['TTS signed in + UNKNOWN credits, Gemini key', 'tts', { signedIn: true, keys: { gemini: 1 }, balance: 'unknown' }],
    ['TTS ElevenLabs key', 'tts', { keys: { elevenlabs: 1 } }],
    ['TTS Gemini + Inworld (speech key rules Gemini out), signed out', 'tts', { keys: { gemini: 1, inworld: 1 } }],
    ['TTS operator tts_url set, Gemini key', 'tts', { keys: { gemini: 1 }, options: { tts_url: `http://operator.box:8880/?k=${SECRET}` } }],
    ['TTS household local_url box', 'tts', { voice: { ttsProvider: 'local_url', localTtsUrl: 'http://household.box:8880' } }],
    ['STT signed out, nothing', 'stt', { }],
    ['STT household chose gemini (+ key)', 'stt', { keys: { gemini: 1 }, voice: { sttProvider: 'gemini' } }],
    ['STT household gemini BEATS operator stt_url', 'stt', { keys: { gemini: 1 }, voice: { sttProvider: 'gemini' }, options: { stt_url: 'http://operator.box:9000' } }],
    ['STT operator stt_url', 'stt', { options: { stt_url: 'http://operator.box:9000' } }],
    // John 10-12: STT's one cloud option is Gemini; key first, then credits. Unset/retired → the Gemini default.
    ['STT signed in + spendable, no key → gemini (credits)', 'stt', { signedIn: true, balance: 5 }],
    ['STT signed in + EMPTY, no key → gemini (credits; the edge decides 402)', 'stt', { signedIn: true, balance: 0 }],
    ['STT signed OUT + Gemini key, nothing chosen → gemini (key)', 'stt', { keys: { gemini: 1 } }],
    ['STT RETIRED dashie_cloud stored, signed in → gemini', 'stt', { signedIn: true, balance: 5, voice: { sttProvider: 'dashie_cloud' } }],
    ['STT RETIRED dashie_cloud stored + operator stt_url → the OPERATOR (alias keeps the old precedence)', 'stt', { signedIn: true, balance: 5, voice: { sttProvider: 'dashie_cloud' }, options: { stt_url: 'http://operator.box:9000' } }],
    ['STT household local_stt_url box', 'stt', { voice: { sttProvider: 'local_stt_url', localSttUrl: 'http://household.box:9000' } }],
];

async function agreementRound(label) {
    let mismatches = 0;
    for (const [name, kind, box] of STATES) {
        setBox(box);
        const L = await lanes();
        setBox(box);   // fresh cache: the lane reads the same ledger answer the endpoint read
        const actual = await drive(kind);
        // A /lanes that never answered would "say" null and agree with every null-lane
        // state for free — so an agreement counts only on a real 200 with this lane.
        const answered = L.status === 200 && L.body?.ok === true && L.body?.[kind] && 'serves' in L.body[kind];
        const said = answered ? L.body[kind].serves : '(no answer)';
        if (label) check(`AGREE ${name}: /lanes says ${said}, the lane reached ${actual}`, answered && said === actual, `status=${L.status} said=${said} actual=${actual}`);
        if (!answered || said !== actual) mismatches++;
    }
    return mismatches;
}

console.log('── agreement: /lanes vs the lane it describes ───────────────────');
await agreementRound(true);

console.log('── PLANT: /lanes reads a STALE routing function (pre-38e2801: signed in ⇒ cloud) ──');
{
    const real = require_(voiceRoutesPath);
    const stale = {
        ...real,
        ttsRoute: async () => { const r = await real.ttsRoute(); if (r.serves === 'gemini' && r.rows.dashie_cloud.why !== 'signed_out') r.serves = 'dashie_cloud'; return r; },
    };
    require_.cache[voiceRoutesPath].exports = stale;   // /lanes requires lazily → sees this; engines holds the real object
    const m = await agreementRound(false);
    require_.cache[voiceRoutesPath].exports = real;
    check(`PLANT goes RED: the stale /lanes disagrees with the lane (${m} state(s))`, m >= 2, `mismatches=${m} — the agreement legs cannot see a stale endpoint`);
    check('…and the real one is green again after removing the plant', (await agreementRound(false)) === 0, 'still mismatched after restore');
}

console.log('── rows ─────────────────────────────────────────────────────────');
// A missing answer must FAIL each row leg, not crash the run before the later legs report.
const answer = (x) => (x.body ? x : { ...x, body: { ok: false, credits: {}, tts: { rows: {} }, stt: { rows: {} } } });
setBox({ signedIn: true, keys: { gemini: 1 }, balance: 0, voice: { localTtsUrl: 'http://household.box:8880/?t=' + SECRET } });
let r = answer(await lanes());
check('rows: device-side engines are ABSENT, not false', r.body.ok === true && ['va_default', 'android_voice', 'sherpa_moonshine_base'].every(k => !(k in r.body.tts.rows) && !(k in r.body.stt.rows)), JSON.stringify(r.body?.tts?.rows));
check('rows: a configured household box is can_serve:null (unprobed), host only', r.body.tts.rows.local_url?.can_serve === null && r.body.tts.rows.local_url?.why === 'configured_unprobed' && r.body.tts.rows.local_url?.url_host === 'household.box:8880', JSON.stringify(r.body.tts.rows.local_url));
check('rows: an unconfigured box is false/not_configured', r.body.stt.rows.local_stt_url?.can_serve === false && r.body.stt.rows.local_stt_url?.why === 'not_configured', JSON.stringify(r.body.stt.rows.local_stt_url));
check('rows: signed in at ZERO → cloud false/no_credits; credits.state empty', r.body.tts.rows.dashie_cloud?.why === 'no_credits' && r.body.credits.state === 'empty', JSON.stringify(r.body.credits));
setBox({ signedIn: true, keys: { gemini: 1 }, balance: 'unknown' });
r = answer(await lanes());
check('rows: UNREADABLE credits → cloud false/credits_unreadable (never true)', r.body.tts.rows.dashie_cloud?.can_serve === false && r.body.tts.rows.dashie_cloud?.why === 'credits_unreadable', JSON.stringify(r.body.tts.rows.dashie_cloud));
setBox({ signedIn: true, keys: { gemini: 1 }, balance: 5 });
r = answer(await lanes());
check('rows: spendable → cloud true; Gemini TTS false/account_pays (the 10-10 rule, key-first not built)', r.body.tts.rows.dashie_cloud?.can_serve === true && r.body.tts.rows.gemini?.why === 'account_pays', JSON.stringify(r.body.tts.rows));
// ── STT Gemini row (John 10-12: one Gemini option, key first then credits; D2 "always show, explain") ──
// can_serve on key OR credits; `why` must name WHICH to fix, never a merged "unavailable" (B's leg 17 maps it).
{
    const sttRow = async (box) => { setBox(box); const x = answer(await lanes()); return { row: x.body.stt?.rows?.gemini, legacy: x.body.stt?.rows?.dashie_cloud, payer: x.body.stt?.payer }; };
    let t = await sttRow({ keys: { gemini: 1 } });
    check('STT row: a stored key → true, payer key (signed out too)', t.row?.can_serve === true && t.row?.payer === 'key' && t.payer === 'key', JSON.stringify(t));
    t = await sttRow({ signedIn: true, balance: 5 });
    check('STT row: no key, credits spendable → true, payer credits', t.row?.can_serve === true && t.row?.payer === 'credits' && t.payer === 'credits', JSON.stringify(t));
    t = await sttRow({ signedIn: true, balance: 0 });
    check('STT row: no key, NO credits → false/no_key_no_credits', t.row?.can_serve === false && t.row?.why === 'no_key_no_credits', JSON.stringify(t));
    check('STT lane: no key, NO credits → lane payer is NULL (never "credits" while the row says it cannot serve)', t.payer === null, JSON.stringify(t));
    t = await sttRow({ signedIn: true, balance: 'unknown' });
    check('STT row: no key, credits UNREADABLE → false/no_key_credits_unreadable (its own why)', t.row?.can_serve === false && t.row?.why === 'no_key_credits_unreadable', JSON.stringify(t));
    t = await sttRow({});
    check('STT row: no key, signed OUT → false/no_key_signed_out', t.row?.can_serve === false && t.row?.why === 'no_key_signed_out', JSON.stringify(t));
    check('STT row: the RETIRED dashie_cloud row mirrors gemini (an old console still reads it)', JSON.stringify(t.legacy) === JSON.stringify(t.row), JSON.stringify(t));
    const whys = new Set();
    for (const box of [{ signedIn: true, balance: 0 }, { signedIn: true, balance: 'unknown' }, {}]) { const x = await sttRow(box); whys.add(x.row?.why); }
    check('STT row: the three can\'t-serve causes are THREE different whys (discriminating)', whys.size === 3 && !whys.has(undefined), JSON.stringify([...whys]));
    // EXPECTED VALUES, not agreement: the AGREE legs above compare /lanes with the lane, which share sttRoute, so a
    // wrong precedence in sttRoute agrees with itself. These pin what the answer MUST be.
    const serves = async (box) => { setBox(box); return answer(await lanes()).body.stt?.serves; };
    let v = await serves({ signedIn: true, balance: 5, voice: { sttProvider: 'dashie_cloud' }, options: { stt_url: 'http://operator.box:9000' } });
    check('STT expected: RETIRED dashie_cloud + operator stt_url → operator_url (the alias keeps dashie_cloud\'s OLD precedence; it is not an explicit gemini)', v === 'operator_url', `serves=${v}`);
    v = await serves({ signedIn: true, balance: 5, voice: { sttProvider: 'gemini' }, options: { stt_url: 'http://operator.box:9000' } });
    check('STT expected (control): an EXPLICIT gemini + operator stt_url → gemini (D5: a chosen gemini beats stt_url)', v === 'gemini', `serves=${v}`);
    v = await serves({ signedIn: true, balance: 5, voice: { sttProvider: 'dashie_cloud' } });
    check('STT expected: RETIRED dashie_cloud, signed in, no box URL → gemini', v === 'gemini', `serves=${v}`);
}
setBox({ keys: { gemini: 1 }, options: { tts_url: `http://operator.box:8880/?k=${SECRET}` } });
r = answer(await lanes());
check('operator engine: its own field, HOST only — the secret-bearing URL is never echoed', r.body.tts?.operator_engine?.url_host === 'operator.box:8880' && !JSON.stringify(r.body).includes(SECRET), JSON.stringify(r.body.tts.operator_engine));

console.log('── mount: where the server SERVES it (the router alone cannot say) ──');
// The legs above find /lanes on the ROUTER object, so a changed app.use() mount would
// leave them green while every household's console 404s into its fail-open (O/B,
// 10-11). This pins the served path from index.js itself. B's console leg 15a reads
// BOTH sides of the join (page fetch string × this mount); this one pins the server half.
{
    const idx = readFileSync(join(SERVER, 'index.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
    const mounts = [...idx.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*voiceConsoleRouter\s*\)/g)].map(m => m[1]);
    const hasRoute = voiceConsole.stack.some(L => L.route?.path === '/lanes' && L.route.methods.get);
    const served = hasRoute ? mounts.map(m => m + '/lanes') : [];
    check(`mount: GET /api/voice/lanes is what the server serves (served: ${JSON.stringify(served)})`,
        served.length === 1 && served[0] === '/api/voice/lanes', `voiceConsoleRouter mounts=${JSON.stringify(mounts)} hasRoute=${hasRoute}`);
    // Control that CAN fail independently of the subject: the same parse must find a
    // DIFFERENT, unrelated mount — so a regex that matches nothing fails here, not silently above.
    check('mount parse control: the same parse finds the unrelated /api/keys mount', /app\.use\(\s*'\/api\/keys'\s*,\s*keysRouter\s*\)/.test(idx), 'parse found no /api/keys mount — the reader is broken, not the subject');
}

console.log('── auth ─────────────────────────────────────────────────────────');
r = await lanes({});
// status 0 = the route was not found at all; that must NOT read as "refused".
check('no ingress user → refused 401/403 by the guard (not a missing route), no balance', (r.status === 401 || r.status === 403) && !(r.body && r.body.credits), `status=${r.status} body=${JSON.stringify(r.body)}`);

console.log(`\n${passed} passed, ${failed} failed`);
console.log('   (a green does NOT prove a household box is reachable — /lanes never probes it — nor anything about the console\'s OFFERING)');
if (!failed) console.log('check-voice-lanes: ALL PASS');
process.exit(failed ? 1 : 0);
