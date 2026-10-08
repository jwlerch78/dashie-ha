#!/usr/bin/env node
/**
 * check-gemini-stt — D5, BYOK speech-to-text on the household's own Gemini key.
 *
 * Drives the REAL gemini-stt.js and the REAL engines.handleStt, with `fetch`, the
 * key store and the household voice config stubbed IN MEMORY (no key file and no
 * settings file is written; usage.json is snapshotted and restored).
 *
 * ── WHAT EACH LEG GUARDS ─────────────────────────────────────────────────────
 *   • the raw key reaches Google in a HEADER and nowhere else: not the URL, not a
 *     log line, not a response to the caller.
 *   • both response shapes are read (`parts[].text` per Google's doc, and
 *     `parts[].audioTranscription.text` as captured in litellm#44539). Reading only
 *     one returns "" for a real transcription, which looks like the user saying
 *     nothing.
 *   • a 200 in neither shape is an ERROR with its own marker, never "".
 *   • household Gemini outranks `stt_url` (O, decision 1), and says so with
 *     STT-OVERRIDE. That marker is distinct from every failure marker.
 *   • a Gemini failure does NOT fall through to the operator's engine or the cloud.
 *   • success records ONE usage row under provider `gemini` / billing `byok`, a
 *     store key of its own; a failure records nothing.
 *
 * Exit 0 = ALL PASS, 1 = a violation, 2 = cannot check.
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'dashie-ha', 'server');
const require_ = createRequire(import.meta.url);

let config, keyStore, acctCfg, usageStore, G, engines;
try {
    config = require_(join(SERVER, 'config.js'));
    if (config.DATA_DIR === '/data') {
        console.error('check-gemini-stt: refusing to run — DATA_DIR is /data (a real add-on volume).');
        process.exit(2);
    }
    // Stub BEFORE gemini-stt loads: it destructures readKeys at require time.
    // options.js reads a FIXED /data/options.json, so a file in the checkout's
    // DATA_DIR is never read (that made 4a pass vacuously once; 4i caught it).
    // Stub the export before engines/satellite-engines destructure it.
    const optionsMod = require_(join(SERVER, 'options.js'));
    let OPTS = {};
    optionsMod.readOptions = () => OPTS;
    globalThis.__setOptions = (o) => { OPTS = o; };
    keyStore = require_(join(SERVER, 'key-store.js'));
    let STORE = {};
    keyStore.readKeys = () => STORE;
    globalThis.__setKeys = (s) => { STORE = s; };
    acctCfg = require_(join(SERVER, 'account-config.js'));
    let VOICE = {};
    acctCfg.getAccountVoiceConfig = async () => VOICE;   // satellite-engines requires it lazily
    globalThis.__setVoice = (v) => { VOICE = v; };
    usageStore = require_(join(SERVER, 'usage-store.js'));
    G = require_(join(SERVER, 'gemini-stt.js'));
    engines = require_(join(SERVER, 'engines.js'));
} catch (e) {
    console.error(`check-gemini-stt: cannot check — module did not load: ${e.message}`);
    process.exit(2);
}

const SNAP = {};
for (const f of [usageStore.USAGE_FILE]) SNAP[f] = existsSync(f) ? readFileSync(f, 'utf8') : null;
process.on('exit', () => {
    for (const [f, v] of Object.entries(SNAP)) {
        try { if (v === null) rmSync(f, { force: true }); else writeFileSync(f, v); } catch { /* best effort */ }
    }
});

const KEY = 'AIzaFAKE-check-gemini-stt-0123456789';
const errors = [], pass = [];
const ok = (m) => pass.push(m), fail = (m) => errors.push(m);

/** A canonical 16 kHz mono 16-bit WAV of `ms` silence. */
function wav(ms = 500) {
    const pcm = Buffer.alloc(16000 * 2 * ms / 1000);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
    h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36);
    h.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([h, pcm]);
}

/** Run fn with fetch + console captured. Returns {logs, calls}. */
async function capture(fetchImpl, fn) {
    const logs = [], calls = [];
    const real = { log: console.log, warn: console.warn, error: console.error, fetch: globalThis.fetch };
    const sink = (...a) => logs.push(a.map(String).join(' '));
    console.log = sink; console.warn = sink; console.error = sink;
    globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return fetchImpl(url, init); };
    try { await fn(); } finally {
        console.log = real.log; console.warn = real.warn; console.error = real.error; globalThis.fetch = real.fetch;
    }
    return { logs, calls };
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const googleText = (t) => json(200, { candidates: [{ content: { parts: [{ text: t }] } }] });
const googleAT = (t) => json(200, { candidates: [{ content: { parts: [{ audioTranscription: { text: t } }] } }] });

/** Drive the real handleStt. Returns {status, body}. */
async function callHandleStt(audio) {
    const req = Readable.from([audio]);
    let out = null;
    await engines.handleStt(req, null, (_res, status, body) => { out = { status, body }; });
    return out;
}
function setOptions(o) { __setOptions(o); }
const usageText = () => JSON.stringify(usageStore.readUsage());

// ── 1: parser, both shapes, and "" vs null kept apart ───────────────────────
{
    const a = G.parseTranscript({ candidates: [{ content: { parts: [{ text: 'turn on the lights' }] } }] });
    const b = G.parseTranscript({ candidates: [{ content: { parts: [{ audioTranscription: { text: 'turn off the fan' } }] } }] });
    const c = G.parseTranscript({ candidates: [{ content: { parts: [{ text: '' }] } }] });
    const d = G.parseTranscript({ candidates: [{ content: { parts: [{ inlineData: {} }] } }] });
    const e = G.parseTranscript({});
    if (a === 'turn on the lights') ok('1a: parts[].text read'); else fail(`[1a] parts[].text → ${JSON.stringify(a)}`);
    if (b === 'turn off the fan') ok('1b: parts[].audioTranscription.text read'); else fail(`[1b] audioTranscription → ${JSON.stringify(b)} (the litellm#44539 shape reads as empty)`);
    if (c === '') ok('1c: an empty transcript is "" (silence), not null'); else fail(`[1c] empty text → ${JSON.stringify(c)}`);
    if (d === null && e === null) ok('1d: an unrecognised shape is null, not ""'); else fail(`[1d] unrecognised → ${JSON.stringify(d)} / ${JSON.stringify(e)}`);
}

// ── 2: the request, and where the key goes ──────────────────────────────────
{
    __setKeys({ gemini: { key: KEY } });
    const audio = wav();
    let r;
    const { logs, calls } = await capture(async () => googleAT('hello'), async () => { r = await G.transcribe(audio); });
    const c = calls[0];
    const body = c ? JSON.parse(c.init.body) : {};
    const part = body?.contents?.[0]?.parts?.[0]?.inlineData;
    if (calls.length === 1 && /models\/gemini-3\.5-transcribe:generateContent$/.test(c.url)) ok('2a: one POST to gemini-3.5-transcribe:generateContent');
    else fail(`[2a] calls=${calls.length} url=${c?.url}`);
    if (c?.init?.headers?.['x-goog-api-key'] === KEY) ok('2b: the key travels in the x-goog-api-key header');
    else fail('[2b] the key is not in the x-goog-api-key header');
    if (c && !c.url.includes(KEY) && !c.url.includes('key=')) ok('2c: the key is not in the URL'); else fail('[2c] the key (or a key= param) is in the URL');
    if (part?.mimeType === 'audio/wav' && Buffer.from(part.data, 'base64').equals(audio)) ok('2d: the WAV is sent inline, byte-identical');
    else fail('[2d] inlineData is not the exact WAV as audio/wav');
    if (r?.ok && r.text === 'hello') ok('2e: a 200 returns the transcript'); else fail(`[2e] result ${JSON.stringify(r)}`);
    if (!logs.join('\n').includes(KEY)) ok('2f: no log line contains the key'); else fail('[2f] a log line contains the raw key');
}

// ── 3: failures — distinct, keyless, never "" ───────────────────────────────
{
    __setKeys({ gemini: { key: KEY } });
    let r1, r2, r3;
    const a = await capture(async () => json(403, { error: { message: 'API key not valid' } }), async () => { r1 = await G.transcribe(wav()); });
    const b = await capture(async () => json(200, { candidates: [{ content: { parts: [{ thought: true }] } }] }), async () => { r2 = await G.transcribe(wav()); });
    __setKeys({});
    const c = await capture(async () => googleText('x'), async () => { r3 = await G.transcribe(wav()); });
    if (!r1.ok && r1.error === 'gemini_stt_http' && !JSON.stringify(r1).includes(KEY) && !a.logs.join().includes(KEY)) ok('3a: a non-2xx is gemini_stt_http, keyless in result and logs');
    else fail(`[3a] ${JSON.stringify(r1)}`);
    if (!r2.ok && r2.error === 'gemini_stt_unparsed' && b.logs.some((l) => l.includes('DROP: gemini-stt unrecognised-shape') && l.includes('thought'))) ok('3b: an unrecognised 200 is an error with its own marker naming the part keys');
    else fail(`[3b] ${JSON.stringify(r2)} logs=${JSON.stringify(b.logs)}`);
    if (!r3.ok && r3.status === 503 && r3.error === 'gemini_stt_no_key' && c.calls.length === 0) ok('3c: no stored key → 503 and Google is never called');
    else fail(`[3c] ${JSON.stringify(r3)} calls=${c.calls.length}`);
}

// ── 4: handleStt — precedence, override marker, no fall-through, usage ──────
{
    __setVoice({ sttProvider: 'gemini' });
    __setKeys({ gemini: { key: KEY } });
    setOptions({ stt_url: 'http://whisper.lan:9000', stt_model: 'whisper-1' });
    const before = usageText();
    let out;
    const s = await capture(async (url) => String(url).includes('generativelanguage') ? googleAT('play jazz') : json(200, { text: 'WRONG ENGINE' }),
        async () => { out = await callHandleStt(wav()); });
    if (out?.status === 200 && out.body?.text === 'play jazz' && s.calls.every((c) => c.url.includes('generativelanguage'))) ok('4a: household gemini outranks stt_url — Gemini answered, the operator engine was not called');
    else fail(`[4a] ${JSON.stringify(out)} urls=${s.calls.map((c) => c.url)}`);
    const over = s.logs.filter((l) => l.startsWith('STT-OVERRIDE:'));
    if (over.length === 1 && over[0].includes('whisper.lan') && !s.logs.some((l) => l.includes('DROP:'))) ok('4b: the override logs STT-OVERRIDE once (host only), and no DROP marker on success');
    else fail(`[4b] logs=${JSON.stringify(s.logs)}`);
    const after = usageText();
    if (after !== before && /gemini/.test(after) && /byok/.test(after)) ok('4c: success records a gemini/byok usage row');
    else fail('[4c] no gemini/byok usage row after a successful call');
    if (!/whisper\.lan/.test(after.replace(before, ''))) ok('4d: the success did not record under the operator engine'); else fail('[4d] usage recorded under whisper.lan');

    const mid = usageText();
    const f = await capture(async (url) => String(url).includes('generativelanguage') ? json(500, { error: { message: 'boom' } }) : json(200, { text: 'FELL THROUGH' }),
        async () => { out = await callHandleStt(wav()); });
    if (out?.status === 502 && f.calls.length === 1 && f.calls[0].url.includes('generativelanguage')) ok('4e: a Gemini failure does not fall through (one call, to Google only)');
    else fail(`[4e] ${JSON.stringify(out)} calls=${f.calls.map((c) => c.url)}`);
    if (f.logs.some((l) => l.startsWith('DROP: stt-gemini-failed')) && f.logs.filter((l) => l.startsWith('STT-OVERRIDE:')).length === 1) ok('4f: the failure has its own marker, distinct from STT-OVERRIDE');
    else fail(`[4f] logs=${JSON.stringify(f.logs)}`);
    if (usageText() === mid) ok('4g: a failure records no usage row'); else fail('[4g] a failed call wrote usage');

    __setKeys({});
    const n = await capture(async () => json(200, { text: 'FELL THROUGH' }), async () => { out = await callHandleStt(wav()); });
    if (out?.status === 503 && out.body?.error === 'gemini_stt_no_key' && n.calls.length === 0 && n.logs.some((l) => l.startsWith('DROP: stt-gemini-no-key'))) ok('4h: chosen but no key → 503 stt-gemini-no-key, nothing called');
    else fail(`[4h] ${JSON.stringify(out)} calls=${n.calls.length} logs=${JSON.stringify(n.logs)}`);

    // Positive control on the routing: with the household NOT on gemini, the same
    // stt_url box goes to the operator engine. Without this, 4a could pass because
    // nothing ever reaches the operator engine at all.
    __setVoice({ sttProvider: 'sherpa_moonshine_base' });
    const p = await capture(async () => json(200, { text: 'operator engine' }), async () => { out = await callHandleStt(wav()); });
    if (out?.status === 200 && out.body?.text === 'operator engine' && p.calls[0]?.url.startsWith('http://whisper.lan:9000') && !p.logs.some((l) => l.startsWith('STT-OVERRIDE:'))) ok('4i: control — a non-gemini household still uses stt_url, with no override marker');
    else fail(`[4i] ${JSON.stringify(out)} urls=${p.calls.map((c) => c.url)}`);
}

for (const m of pass) console.log(`  ✓ ${m}`);
for (const m of errors) console.error(`  ✗ ${m}`);
if (errors.length) { console.error(`check-gemini-stt: ${errors.length} violation(s)`); process.exit(1); }
console.log(`check-gemini-stt: ALL PASS (${pass.length} legs)`);
