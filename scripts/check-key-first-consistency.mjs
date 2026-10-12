// SPDX-License-Identifier: AGPL-3.0-only
// check-key-first-consistency.mjs — do the voice lanes AGREE on "key first, then credits"?
//
// John 2026-10-12: "LLM should be the same as TTS and STT - key first then credits for both addon and dashie
// cloud", then ruled option (A): "Yes - A" = a household key that the PROVIDER REFUSES falls back to credits;
// an outage (5xx), a timeout, or an answer we cannot read does NOT, in every lane. Each lane has its own gate;
// this one drives all of them with the SAME provider answers and asserts one table.
//
// LANES (all REAL code; only the network and the box's stores are faked):
//   llm           brain-key-fallback.js afterByokTurn, fed through its own watchCalls (shapes from brain/addon-io.js)
//   stt           engines.js handleStt ?engine=gemini → gemini-stt.js → the credits leg
//   tts-tablet    engines.js handleTts {stream:true} → gemini-tts-lane.js. The add-on does not pay here; it
//                 answers 409 {reason:'key_failed'} and the TABLET pays (CloudTtsRouter.kt). "credits" in this
//                 lane = the add-on TOLD the tablet to pay. Whether the tablet obeys is CloudTtsRouterTest's job.
//   tts-speaker   engines.js handleTts (buffered, an HA speaker) → byok-tts.js → the box's own credits fallback
//
// Run: node scripts/check-key-first-consistency.mjs
// Exit 0 = ALL PASS · 1 = a REGRESSION (a leg went red that is not a known defect, a known defect is now
// fixed and its entry is stale, or the positive control failed) · 4 = TARGET NOT MET (only known defects red)
// · 2 = cannot check.
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashie-ha', 'server');
const require_ = createRequire(path.join(SERVER, 'x.js'));
const stub = (rel, exports) => { const p = require_.resolve(rel); require_.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const noop = () => {};

// ── RED BY DESIGN ────────────────────────────────────────────────────────────────────────────────
// Legs that FAIL on purpose until the lane is fixed to John's ruling (A). Do NOT "fix" this file by
// deleting a row: fix the lane, and the row turns into a STALE error telling you to delete it.
// HISTORY (T, 2026-10-12): at 01a1732 thirteen legs were red here — stt 400-plain/500/503/timeout/200-unreadable,
// tts-tablet 400-plain/500/503/timeout, tts-speaker 400-plain/500/503/timeout — every outage paid with credits.
// 8f151ac (HV, "credits pay only for the KEY's fault, in every lane") fixed all thirteen; this file, run against
// a 01a1732 worktree, shows them RED-BY-DESIGN, so the table can see the defect it now reports as gone.
// The tablet half of tts-tablet (CloudTtsRouter.kt pays on every decline) is NOT covered here: see the floor.
// Shape of an entry: lane: { cases: ['500', ...], owner: '...', why: '...' }
const KNOWN_DEFECTS = {};

// ── The provider answers every lane is given ─────────────────────────────────────────────────────
const KEY_INVALID_BODY = '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}';
const CASES = [
    { id: '401',              http: 401, body: '{"error":{"code":401}}',          keyFault: true },
    { id: '400-key-invalid',  http: 400, body: KEY_INVALID_BODY,                    keyFault: true },
    { id: '403',              http: 403, body: '{"error":{"code":403}}',          keyFault: true },
    { id: '429',              http: 429, body: '{"error":{"code":429}}',          keyFault: true },
    { id: '400-plain',        http: 400, body: '{"error":{"message":"Invalid JSON payload"}}', keyFault: false },
    { id: '500',              http: 500, body: '{"error":{"code":500}}',          keyFault: false },
    { id: '503',              http: 503, body: '{"error":{"code":503}}',          keyFault: false },
    { id: 'timeout',          http: null,                                           keyFault: false },
    { id: '200-unreadable',   http: 200, body: '{"candidates":[]}',               keyFault: false },
];

// ── The box, faked ───────────────────────────────────────────────────────────────────────────────
const state = { kase: null, ttsServes: 'gemini' };
let events = [];
stub('./auth', { getValidJwt: async () => ({ jwt: 'jwt-test', userId: 'user-test' }), readStoredJwt: () => 'jwt-test' });
stub('./options', { readOptions: () => ({}) });
stub('./key-store', {
    readKeys: () => ({ gemini: { key: 'k-gemini' }, elevenlabs: { key: 'k-eleven' } }),
    status: () => ({ gemini: true, elevenlabs: true }),
});
stub('./usage-store', { recordLocalUsage: noop });
stub('./turn-log', new Proxy({}, { get: () => noop }));
stub('./stt-usage', { recordSttCall: noop });
stub('./capability', { signedIn: () => true });
stub('./credit-balance', { boxCredits: async () => ({ spendable: true, balance: 10 }) });
stub('./settings-store', { readUserSettings: () => ({}) });
stub('./satellite-engines', { resolveSatelliteBase: () => null, householdVoice: async () => null });
stub('./voice-routes', { ttsRoute: async () => ({ serves: state.ttsServes, base: null, source: 'test' }) });

const resp = (status, body) => ({
    ok: status >= 200 && status < 300, status,
    text: async () => body, json: async () => JSON.parse(body),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    headers: new Map([['content-type', 'application/json']]),
    body: Readable.toWeb(Readable.from([Buffer.from(`data: ${body}\n\n`)])),
});
globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (/generativelanguage\.googleapis\.com|api\.elevenlabs\.io/.test(u)) {
        events.push('provider');
        const k = state.kase;
        if (k.http === null) { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; }
        return resp(k.http, k.body);
    }
    if (u.includes('/functions/v1/database-operations')) {
        const { operation, data } = JSON.parse(init.body || '{}');
        if (operation === 'report_key_failure') events.push(`pill:${data.status}`);
        return resp(200, '{}');
    }
    if (u.includes('/functions/v1/')) {
        events.push(`credits:${u.split('/functions/v1/')[1].split('?')[0]}`);
        // The credits leg answers like a working edge: audio for TTS, a transcript for STT.
        return { ...resp(200, '{"transcript":"ok","text":"ok"}'), arrayBuffer: async () => new Uint8Array(4800).buffer };
    }
    return resp(200, '[]');
};

let vocab, fallback, engines, keyHealth;
try {
    vocab = require_('./generated/key-health-vocab');
    fallback = require_('./brain-key-fallback');
    keyHealth = require_('./key-health');
    engines = require_('./engines');
} catch (e) { console.error(`check-key-first-consistency: cannot check — ${e.stack || e.message}`); process.exit(2); }

class FakeRes extends Writable {
    constructor() { super(); this.statusCode = null; this.chunks = []; }
    writeHead(s) { this.statusCode = s; return this; }
    setHeader() {}
    _write(c, _e, cb) { this.chunks.push(Buffer.from(c)); cb(); }
    bodyText() { return Buffer.concat(this.chunks).toString('utf8'); }
}
const done = (res) => new Promise((r) => { if (res.writableFinished) r(); else res.on('finish', r); });
const sendJson = (res, status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); };
const req = (body, query = {}) => Object.assign(Readable.from([Buffer.from(body)]), { query, headers: {}, method: 'POST' });

// Each lane → { credits: bool, pill: bool, order: 'pill-first' | 'credits-first' | '-' }
function verdict(paidSignal) {
    const iPill = events.findIndex((e) => e.startsWith('pill:'));
    const iPay = events.findIndex((e) => e === paidSignal || e.startsWith('credits:'));
    const credits = iPay >= 0, pill = iPill >= 0;
    return { credits, pill, order: credits && pill ? (iPill < iPay ? 'pill-first' : 'credits-first') : '-' };
}
const LANES = {
    async llm(k) {
        // addon-io.js shapes: a refusal carries http_status + error_body (:174-182); no answer carries none (:217);
        // a 200 is an answer to the brain, so the turn did not fail on the key.
        const inner = async () => (k.http === null ? { ok: false, unreachable: true }
            : k.http === 200 ? { ok: true, text: '' } : { ok: false, http_status: k.http, error_body: k.body });
        const w = fallback.watchCalls({ callGateway: inner });
        const r = await w.io.callGateway({});
        await fallback.afterByokTurn({
            provider: 'gemini', turn: { ok: r.ok }, seen: w.seen(), jwt: 'jwt-test', keyHealth,
            askCloud: async () => { events.push('credits:voice-conversation'); return { status: 200, body: { response: 'ok' } }; },
        });
        return verdict();
    },
    async stt() {
        const res = new FakeRes();
        await engines.handleStt(req('RIFFfakewav', { engine: 'gemini' }), res, sendJson);
        return verdict();
    },
    async 'tts-tablet'() {
        const res = new FakeRes();
        await engines.handleTts(req(JSON.stringify({ text: 'hello', stream: true })), res, sendJson);
        await done(res);
        let b = {}; try { b = JSON.parse(res.bodyText()); } catch { /* audio */ }
        if (res.statusCode === 409 && b.reason === 'key_failed') events.push('credits:tablet-told-to-pay');
        return verdict();
    },
    async 'tts-speaker'() {
        const res = new FakeRes();
        await engines.handleTts(req(JSON.stringify({ text: 'hello' })), res, sendJson);
        return verdict();
    },
};

const origWarn = console.warn, origLog = console.log;
async function runTable(label) {
    const rows = [];
    for (const lane of Object.keys(LANES)) for (const k of CASES) {
        events = []; state.kase = k; keyHealth.__resetForTest?.();
        console.warn = noop; console.log = noop;
        let v, err = null;
        try { v = await LANES[lane](k); } catch (e) { err = e; }
        console.warn = origWarn; console.log = origLog;
        rows.push({ lane, k, v, err, label });
    }
    return rows;
}
function judge(row) {
    const { lane, k, v, err } = row;
    if (err) return { ok: false, why: `threw: ${err.message}` };
    if (v.credits !== k.keyFault) return { ok: false, why: `credits=${v.credits}, ruling (A) wants ${k.keyFault}` };
    if (v.pill !== k.keyFault) return { ok: false, why: `pill=${v.pill}, wants ${k.keyFault}` };
    if (v.credits && v.order !== 'pill-first') return { ok: false, why: `paid BEFORE the pill was reported (${v.order})` };
    return { ok: true, why: k.keyFault ? 'credits, pill first' : 'no credits, no pill' };
}

// ── 1. The table ─────────────────────────────────────────────────────────────────────────────────
const rows = await runTable('main');
let regressions = 0, knownRed = 0, stale = 0;
console.log('lane         case              result');
for (const row of rows) {
    const j = judge(row), known = KNOWN_DEFECTS[row.lane]?.cases.includes(row.k.id);
    let tag;
    if (j.ok && !known) tag = 'PASS          ';
    else if (j.ok && known) { tag = 'STALE         '; stale++; j.why += ' — FIXED: delete this case from KNOWN_DEFECTS'; }
    else if (!j.ok && known) { tag = 'RED-BY-DESIGN '; knownRed++; }
    else { tag = 'FAIL          '; regressions++; }
    console.log(`${tag}${row.lane.padEnd(12)} ${row.k.id.padEnd(17)} ${j.why}`);
}

// ── 2. The LLM's pass-1-only rule: a DELIBERATE difference, not a gap ────────────────────────────
// A refusal on the brain's SECOND model call keeps the spoken key error (tools may already have run and
// billed). TTS and STT make one provider call per request, so they have no counterpart to assert.
{
    events = [];
    console.warn = noop;
    await fallback.afterByokTurn({
        provider: 'gemini', turn: { ok: false }, jwt: 'jwt-test', keyHealth,
        seen: { calls: 2, refused: { ok: false, http_status: 401, error_body: '' }, refusedAt: 2 },
        askCloud: async () => { events.push('credits:voice-conversation'); return { status: 200, body: {} }; },
    });
    console.warn = origWarn;
    const v = verdict();
    const ok = !v.credits && v.pill;
    console.log(`${ok ? 'PASS          ' : 'FAIL          '}llm          401-on-pass-2     ${ok ? 'pill, no credits (LLM-only rule; TTS/STT have one call)' : `credits=${v.credits} pill=${v.pill}`}`);
    if (!ok) regressions++;
}

// ── 3. Positive control: a mutated SHARED vocabulary must turn a correct lane red ────────────────
// PILL_STATUSES is one Set object shared by brain-key-fallback.js and key-health.js. Adding 'upstream_error'
// makes an outage look like a key fault; the llm 500 leg (correct today) must go red, or this table is blind.
{
    vocab.PILL_STATUSES.add('upstream_error');
    const ctl = (await runTable('control')).find((r) => r.lane === 'llm' && r.k.id === '500');
    vocab.PILL_STATUSES.delete('upstream_error');
    const red = !judge(ctl).ok;
    console.log(`${red ? 'PASS          ' : 'FAIL          '}control      vocab-mutant      ${red ? 'llm 500 went red under a mutated PILL_STATUSES, as required' : 'llm 500 stayed GREEN under a mutated vocabulary — this table cannot see a classifier change'}`);
    if (!red) regressions++;
}

console.log(`
🔴 A green here proves the ADD-ON's four lanes agree. It does NOT prove the overspend is closed: the tablet
   (CloudTtsRouter.kt) is the component that SPENDS on tts-tablet, and as of 2026-10-12 it pays on ANY decline,
   so a new box + an old tablet still pays for an outage. Check the tablet's own JVM test before calling (A) done.
What a green does NOT prove:
  - that a real provider answers with these shapes today (fixtures follow the shared vocabulary, not a live call)
  - that the TABLET obeys the add-on: tts-tablet "credits" = the add-on answered 409 key_failed; CloudTtsRouter.kt decides
  - the LLM lane's gateway translation: llm is fed addon-io.js result shapes; check-brain-key-fallback.mjs drives the real gateway
  - that the credits leg bills (the edge meters), or that a pill renders on any tablet
  - a real outage on a real box: that is Tier 2, and needs a fault hook that does not exist yet (10-12)`);

if (regressions || stale) { console.log(`\n${regressions} REGRESSION(S), ${stale} STALE known-defect entr${stale === 1 ? 'y' : 'ies'} — not passing`); process.exit(1); }
if (knownRed) {
    console.log(`\nTARGET NOT MET: ${knownRed} leg(s) red BY DESIGN — known defects against ruling (A), not regressions:`);
    for (const [lane, d] of Object.entries(KNOWN_DEFECTS)) console.log(`  ${lane}: ${d.cases.join(', ')}\n     why: ${d.why}\n     owner: ${d.owner}`);
    process.exit(4);
}
console.log('\nALL PASS (add-on lanes only — not the tablet payer; see the 🔴 line above)');
