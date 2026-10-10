#!/usr/bin/env node
/**
 * check-gemini-tts — the Gemini adapter on the BYOK speech lane (byok-tts.js +
 * gemini-tts.js + wav-header.js), with only the network stubbed.
 *
 *   • precedence   John 2026-10-10: a Gemini key buys speech ONLY when no speech key
 *                  (ElevenLabs/Inworld) is stored AND the box is not signed in.
 *   • audio        WAV passes through; raw L16 is wrapped with the rate READ from the
 *                  mimeType (a 16 kHz leg exists so a hardcoded 24 kHz goes red);
 *                  anything else is refused loudly. Every served body is proven by
 *                  the box's OWN parser, stt-usage.js wavSeconds().
 *   • metering     a 2xx is billed: Google's token counts + characters are recorded
 *                  even when the audio then proves unusable; a non-2xx records ok=0.
 *   • the key      never in a log line or a returned value.
 *   • the lane     handleTts with only a Gemini key serves audio/wav end to end.
 *
 * Fixture audio is HAND-BUILT here, not made by wav-header.js, so the writer is
 * never the thing that checks the writer. Run: node scripts/check-gemini-tts.mjs
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'dashie-ha', 'server');
const require_ = createRequire(import.meta.url);

let config, byok, usageStore, sttUsage, engines, creditBalance;
try {
    config = require_(join(SERVER, 'config.js'));
    usageStore = require_(join(SERVER, 'usage-store.js'));
    sttUsage = require_(join(SERVER, 'stt-usage.js'));
    byok = require_(join(SERVER, 'byok-tts.js'));
    engines = require_(join(SERVER, 'engines.js'));
    creditBalance = require_(join(SERVER, 'credit-balance.js'));
} catch (e) {
    console.error(`check-gemini-tts: cannot check — module did not load: ${e.message}`);
    process.exit(2);
}
if (config.DATA_DIR === '/data') {
    console.error('check-gemini-tts: refusing to run — DATA_DIR is /data (a real add-on volume).');
    process.exit(2);
}
mkdirSync(config.DATA_DIR, { recursive: true });
const KEYS_FILE = join(config.DATA_DIR, 'api-keys.json');
const FILES = [usageStore.USAGE_FILE, KEYS_FILE, config.JWT_FILE];
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
async function capture(fn, fetchImpl) {
    const lines = [], calls = [];
    const [log, warn, err, realFetch] = [console.log, console.warn, console.error, globalThis.fetch];
    console.log = (...a) => lines.push(a.join(' '));
    console.warn = (...a) => lines.push(a.join(' '));
    console.error = (...a) => lines.push(a.join(' '));
    globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return fetchImpl(url, init); };
    try { return { value: await fn(), lines, calls }; }
    finally { console.log = log; console.warn = warn; console.error = err; globalThis.fetch = realFetch; }
}

const GKEY = 'AIzaControl_do_not_use_0000DEADBEEF';
const setKeys = (o) => writeFileSync(KEYS_FILE, JSON.stringify(o, null, 2));
const signIn = (on) => on
    ? writeFileSync(config.JWT_FILE, JSON.stringify({ jwt: 'control.jwt', expiry: Date.now() + 30 * 86400_000 }))
    : rmSync(config.JWT_FILE, { force: true });
const clearUsage = () => rmSync(usageStore.USAGE_FILE, { force: true });
const usageLines = (lines) => lines.filter(l => l.startsWith('USAGE:'));

// ── fixtures, hand-built ──────────────────────────────────────────────────────
function handWav(pcmBytes, rate, trailer = true) {
    const pcm = Buffer.alloc(pcmBytes, 7);
    const extra = trailer ? Buffer.concat([Buffer.from('C2PA'), Buffer.from([4, 0, 0, 0]), Buffer.from('prov')]) : Buffer.alloc(0);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length + extra.length, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([h, pcm, extra]);
}
const USAGE_META = { promptTokenCount: 6, candidatesTokenCount: 47, totalTokenCount: 53 };
const geminiBody = (mimeType, bytes) => JSON.stringify({
    candidates: [{ content: { parts: [{ inlineData: { mimeType, data: bytes.toString('base64') } }] } }],
    usageMetadata: USAGE_META,
});
const jsonFetch = (mime, bytes) => async () => new Response(geminiBody(mime, bytes), { status: 200, headers: { 'Content-Type': 'application/json' } });
const TEXT = 'The kitchen timer is done.';

// ── 1. precedence ─────────────────────────────────────────────────────────────
// John 2026-10-10: Gemini speaks when no speech key is stored AND the account cannot
// pay — signed out, or signed in WITHOUT a read balance > 0. The read is
// credit-balance.js (shared with the brain's tool gate) and THREE-VALUED: each caller
// decides what 'unknown' means. Speech: unknown → the Gemini key (legs 1f/1g, which
// were 'null' — silence — under the inherited fail-open).
const resolve = async (balanceResp) => {
    creditBalance.__resetCacheForTest();
    return capture(() => byok.resolveProvider(), async (url) => {
        if (!String(url).includes('database-operations')) throw new Error(`unexpected fetch ${url}`);
        return balanceResp();
    });
};
const bal = (n) => () => new Response(JSON.stringify({ data: { balance: n } }), { status: 200 });
const noNet = () => { throw new Error('no network expected on this leg'); };
signIn(false);
setKeys({ gemini: { key: GKEY } });
let p = await resolve(noNet);
check('1a — signed-out + ONLY a Gemini key → gemini, and no balance read', p.value === 'gemini' && p.calls.length === 0, `got ${p.value} calls=${p.calls.length}`);
setKeys({ gemini: { key: GKEY }, elevenlabs: { key: 'el_control' } });
check('1b — Gemini + ElevenLabs → ElevenLabs (stated, not object order)', (await resolve(noNet)).value === 'elevenlabs', '');
setKeys({ gemini: { key: GKEY }, inworld: { key: 'iw_control' } });
check('1c — Gemini + an Inworld key (no adapter) → nothing: a speech key was chosen, and not Gemini', (await resolve(noNet)).value === null, '');
setKeys({ gemini: { key: GKEY } });
signIn(true);
p = await resolve(bal(4.2));
check('1d — SIGNED IN with spendable credits → nothing (the account voice is kept)', p.value === null && p.calls.length === 1, `got ${p.value} calls=${p.calls.length}`);
p = await resolve(bal(0));
check('1e — SIGNED IN with ZERO credits → gemini, with a TTS-FALLBACK marker (John: "fall back for sure")',
    p.value === 'gemini' && p.lines.some(l => l.startsWith('TTS-FALLBACK: signed in, no credits')), `got ${p.value} lines=${p.lines.join(' | ')}`);
const again = await capture(() => byok.resolveProvider(), async () => bal(0)());   // cached 'empty', same state
check('1e2 — the marker fires on the SWITCH, not once per sentence', again.value === 'gemini' && !again.lines.some(l => l.startsWith('TTS-FALLBACK')), again.lines.join(' | '));
p = await resolve(() => new Response('oops', { status: 500 }));
check('1f — SIGNED IN, balance UNREADABLE (non-2xx) → gemini: unknown is NOT "has credits" (MVP has no credits)',
    p.value === 'gemini' && p.lines.some(l => l.includes('credit balance unreadable')), `got ${p.value} lines=${p.lines.join(' | ')}`);
p = await resolve(() => new Response(JSON.stringify({ data: {} }), { status: 200 }));
check('1f2 — SIGNED IN, 200 with NO balance in the body → gemini', p.value === 'gemini', `got ${p.value}`);
p = await resolve(() => { throw new Error('ECONNREFUSED'); });
check('1g — SIGNED IN, cloud UNREACHABLE → gemini', p.value === 'gemini', `got ${p.value}`);
let n = 0;
creditBalance.__resetCacheForTest();
await capture(() => creditBalance.boxCredits(), async () => { n++; throw new Error('down'); });
await capture(() => creditBalance.boxCredits(), async () => { n++; return bal(3)(); });
check('1g2 — an UNKNOWN is never cached: the next turn reads the ledger again', n === 2, `reads=${n}`);
p = await resolve(bal(4.2));
check('1g3 — credits back → the account voice again, with an "ended" marker', p.value === null && p.lines.some(l => l.startsWith('TTS-FALLBACK: ended')), `got ${p.value} lines=${p.lines.join(' | ')}`);
setKeys({ openrouter: { key: 'or_control' } });
p = await resolve(bal(0));
check('1h — CONTROL: signed in at zero with NO Gemini key → nothing, and no balance read', p.value === null && p.calls.length === 0, `got ${p.value} calls=${p.calls.length}`);
signIn(false);

// ── 2. WAV passthrough (the 3.8 models' shape, incl. a trailing C2PA chunk) ──
setKeys({ gemini: { key: GKEY } });
clearUsage();
{
    const wav = handWav(48000, 24000);
    const r = await capture(() => byok.synthesize({ text: TEXT }), jsonFetch('audio/wav', wav));
    const v = r.value;
    check('2a — served ok as audio/wav, bytes unchanged', v.ok === true && v.contentType === 'audio/wav' && Buffer.compare(v.audio, wav) === 0,
        `ok=${v.ok} ct=${v.contentType} len=${v.audio?.length}`);
    check('2b — the box\'s own parser reads it: 1.000 s', sttUsage.wavSeconds(v.audio) === 1, `wavSeconds=${sttUsage.wavSeconds(v.audio)}`);
    const req = JSON.parse(r.calls[0]?.init?.body || '{}');
    check('2c — request: generateContent on the default TTS model, AUDIO modality, a Gemini voice, key in a HEADER',
        /\/models\/gemini-3\.8-flash-tts:generateContent$/.test(r.calls[0]?.url) && !r.calls[0].url.includes(GKEY)
        && r.calls[0].init.headers['x-goog-api-key'] === GKEY
        && req.generationConfig?.responseModalities?.[0] === 'AUDIO'
        && req.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName === 'Kore',
        `url=${r.calls[0]?.url} body=${r.calls[0]?.init?.body}`);
    const u = usageLines(r.lines);
    check('2d — exactly one USAGE: line, provider=gemini, characters billed', u.length === 1 && u[0] === `USAGE: lane=tts provider=gemini units=chars n=${TEXT.length} billing=byok ok=1`, JSON.stringify(u));
    const entry = usageStore.readUsage().days[new Date().toISOString().slice(0, 10)]?.['gemini|gemini-3.8-flash-tts|byok'];
    check('2e — stored units are Google\'s token counts + characters (by value)',
        entry && entry.input_tokens === 6 && entry.output_tokens === 47 && entry.total_tokens === 53 && entry.characters === TEXT.length && entry.lane === 'tts',
        JSON.stringify(entry));
    check('2f — the key is in no log line and no returned field',
        !r.lines.some(l => l.includes(GKEY)) && !JSON.stringify({ ...v, audio: null }).includes(GKEY), r.lines.join(' | '));
}

// ── 3. raw L16 is wrapped; the RATE is read, not assumed ─────────────────────
for (const [rate, bytes, want] of [[24000, 24000, 0.5], [16000, 32000, 1]]) {
    const r = await capture(() => byok.synthesize({ text: TEXT }), jsonFetch(`audio/L16;codec=pcm;rate=${rate}`, Buffer.alloc(bytes, 3)));
    check(`3 — L16 @ ${rate} Hz, ${bytes} bytes → WAV the box's parser reads as ${want} s`,
        r.value.ok === true && r.value.contentType === 'audio/wav' && sttUsage.wavSeconds(r.value.audio) === want
        && r.value.audio.readUInt32LE(24) === rate && r.value.audio.length === 44 + bytes,
        `ok=${r.value.ok} seconds=${sttUsage.wavSeconds(r.value.audio)} rate=${r.value.audio?.readUInt32LE(24)}`);
}

// ── 4. unusable audio: refused LOUDLY, still billed ──────────────────────────
for (const [name, mime, body] of [['an unknown mimeType', 'audio/ogg', Buffer.alloc(100)], ['"audio/wav" that is not RIFF', 'audio/wav', Buffer.alloc(100, 1)], ['L16 with no rate', 'audio/L16;codec=pcm', Buffer.alloc(100)]]) {
    clearUsage();
    const r = await capture(() => byok.synthesize({ text: TEXT }), jsonFetch(mime, body));
    const entry = usageStore.readUsage().days[new Date().toISOString().slice(0, 10)]?.['gemini|gemini-3.8-flash-tts|byok'];
    check(`4 — ${name}: not served, DROP unusable-audio, the billed call still recorded`,
        r.value.ok === false && r.value.status === 502 && r.lines.some(l => l.startsWith('DROP: byok-tts unusable-audio'))
        && entry?.calls === 1 && entry?.errors === 0 && entry?.output_tokens === 47,
        `value=${JSON.stringify({ ...r.value, audio: undefined })} entry=${JSON.stringify(entry)} lines=${r.lines.join(' | ')}`);
}

// ── 5. provider refusal: nothing billed ──────────────────────────────────────
clearUsage();
{
    const r = await capture(() => byok.synthesize({ text: TEXT }), async () => new Response('{"error":{}}', { status: 400 }));
    const entry = usageStore.readUsage().days[new Date().toISOString().slice(0, 10)]?.['gemini|gemini-3.8-flash-tts|byok'];
    check('5 — HTTP 400 → 502 tts_engine_error, DROP, ok=0 with no units',
        r.value.ok === false && r.value.error === 'tts_engine_error' && r.lines.some(l => l.startsWith('DROP: byok-tts provider HTTP 400'))
        && entry?.errors === 1 && entry?.output_tokens === undefined,
        `${JSON.stringify(r.value)} ${JSON.stringify(entry)}`);
}

// ── 6. another engine's voice / model is replaced, loudly ────────────────────
{
    const r = await capture(() => byok.synthesize({ text: TEXT, voice: '21m00Tcm4TlvDq8ikWAM', model: 'eleven_flash_v2_5' }), jsonFetch('audio/wav', handWav(4800, 24000)));
    const req = JSON.parse(r.calls[0]?.init?.body || '{}');
    check('6 — an ElevenLabs voice id + model → Kore on the default model, two DROP markers',
        r.value.ok === true && req.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName === 'Kore'
        && /gemini-3\.8-flash-tts:generateContent$/.test(r.calls[0].url)
        && r.lines.some(l => l.startsWith('DROP: byok-tts gemini-voice-not-gemini')) && r.lines.some(l => l.startsWith('DROP: byok-tts gemini-model-not-tts')),
        r.lines.join(' | '));
    const r2 = await capture(() => byok.synthesize({ text: TEXT, voice: 'Puck', model: 'gemini-3.8-flash-lite-tts' }), jsonFetch('audio/wav', handWav(4800, 24000)));
    check('6b — CONTROL: a real Gemini voice + TTS model are honoured, no DROP',
        JSON.parse(r2.calls[0].init.body).generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName === 'Puck'
        && /gemini-3\.8-flash-lite-tts:generateContent$/.test(r2.calls[0].url) && !r2.lines.some(l => l.startsWith('DROP:')),
        r2.lines.join(' | '));
}

// ── 7. DRIVEN: the lane itself serves it ─────────────────────────────────────
{
    const out = { head: null, body: null, json: null };
    const fakeReq = { on(ev, cb) { if (ev === 'data') cb(Buffer.from(JSON.stringify({ text: TEXT }))); if (ev === 'end') cb(); return this; } };
    const fakeRes = { writeHead(status, headers) { out.head = { status, headers }; }, end(b) { out.body = b; } };
    await capture(() => engines.handleTts(fakeReq, fakeRes, (_r, status, body) => { out.json = { status, body }; }), jsonFetch('audio/wav', handWav(24000, 24000)));
    check('7 — handleTts, signed out, only a Gemini key → 200 audio/wav the parser reads (0.5 s)',
        out.head?.status === 200 && out.head.headers['Content-Type'] === 'audio/wav' && sttUsage.wavSeconds(out.body) === 0.5 && out.json === null,
        `head=${JSON.stringify(out.head)} json=${JSON.stringify(out.json)}`);
}

// ── 8. the OTHER caller keeps ITS meaning of unknown: the brain tool gate allows ──
{
    const { createAddonIO } = require_(join(SERVER, 'brain', 'addon-io.js'));
    const io = createAddonIO({ endpoint: 'http://localhost:11434', model: 'qwen3', accountToken: 'jwt.for.tests', log: () => {} });
    const unk = await capture(() => io.checkSpendable(), async () => new Response('oops', { status: 500 }));
    check('8a — brain gate, balance unreadable → spendable:true (fail OPEN, unchanged)', unk.value.spendable === true && unk.value.balance === Number.POSITIVE_INFINITY, JSON.stringify(unk.value));
    const zero = await capture(() => io.checkSpendable(), async () => bal(0)());
    check('8b — brain gate, zero balance → spendable:false', zero.value.spendable === false && zero.value.balance === 0, JSON.stringify(zero.value));
    const some = await capture(() => io.checkSpendable(), async () => bal(0.5)());
    check('8c — brain gate, 0.5 → spendable, low', some.value.spendable === true && some.value.low === true, JSON.stringify(some.value));
}

// ── 7b. DRIVEN: signed in at ZERO credits — the launch's main path ───────────
{
    signIn(true);
    creditBalance.__resetCacheForTest();
    const out = { head: null, body: null, json: null };
    const fakeReq = { on(ev, cb) { if (ev === 'data') cb(Buffer.from(JSON.stringify({ text: TEXT }))); if (ev === 'end') cb(); return this; } };
    const fakeRes = { writeHead(status, headers) { out.head = { status, headers }; }, end(b) { out.body = b; } };
    const wav = handWav(24000, 24000);
    const r = await capture(() => engines.handleTts(fakeReq, fakeRes, (_r, status, body) => { out.json = { status, body }; }),
        async (url) => String(url).includes('database-operations') ? bal(0)() : jsonFetch('audio/wav', wav)());
    check('7b — handleTts, SIGNED IN at zero credits, only a Gemini key → 200 audio/wav from Gemini (not the cloud, not silence)',
        out.head?.status === 200 && out.head.headers['Content-Type'] === 'audio/wav' && sttUsage.wavSeconds(out.body) === 0.5
        && r.calls.some(c => c.url.includes('generativelanguage')) && !r.calls.some(c => /elevenlabs-tts|inworld-tts/.test(c.url)),
        `head=${JSON.stringify(out.head)} json=${JSON.stringify(out.json)} calls=${r.calls.map(c => c.url).join(' ')}`);
    signIn(false);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (!failed) console.log('check-gemini-tts: ALL PASS');
process.exit(failed ? 1 : 0);
