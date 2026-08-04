#!/usr/bin/env node
/**
 * check-stt-usage — the STT lane's usage capture point (D's contract §8c).
 *
 * Calls the REAL exported `recordSttCall`/`wavSeconds` and the REAL usage store,
 * and drives the REAL `handleStt` for the reachability half.
 *
 * ── EVERY LEG IS A NUMBER THAT WOULD BE WRONG RATHER THAN ABSENT ─────────────
 *
 * This lane feeds a figure a household will compare against a provider invoice,
 * so its failures are not crashes — they are plausible numbers:
 *
 *   • a GUESSED `seconds` is worse than a missing one. It becomes a wrong cost,
 *     in an unknown direction, and looks healthy — the charge_rates shape.
 *   • a ZERO ROW on a failed call is indistinguishable from a real call that
 *     transcribed silence, and it inflates the call count.
 *   • the two branches MERGING would put metered spend and the household's own
 *     BYOK spend in one row, which §5a forbids outright.
 *   • the FULL URL as provider identity can carry a key in a query string, which
 *     §6 forbids storing at all.
 *
 * Exit 0 = every leg passes, 1 = a violation, 2 = cannot check.
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'dashie-ha', 'server');
for (const f of ['stt-usage.js', 'usage-store.js', 'engines.js', 'config.js']) {
    if (!existsSync(join(SERVER, f))) {
        console.error(`check-stt-usage: cannot check — ${f} not found`);
        process.exit(2);
    }
}

const require_ = createRequire(import.meta.url);
let S, usageStore, engines, config;
try {
    config = require_(join(SERVER, 'config.js'));
    usageStore = require_(join(SERVER, 'usage-store.js'));
    S = require_(join(SERVER, 'stt-usage.js'));
    engines = require_(join(SERVER, 'engines.js'));
} catch (e) {
    console.error(`check-stt-usage: cannot check — module did not load: ${e.message}`);
    process.exit(2);
}

if (config.DATA_DIR === '/data') {
    console.error('check-stt-usage: refusing to run — DATA_DIR is /data (a real add-on volume).');
    process.exit(2);
}

const USAGE_FILE = usageStore.USAGE_FILE;
mkdirSync(config.DATA_DIR, { recursive: true });
const SNAPSHOT = existsSync(USAGE_FILE) ? readFileSync(USAGE_FILE, 'utf8') : null;
process.on('exit', () => {
    try {
        rmSync(USAGE_FILE, { force: true, recursive: true });
        rmSync(USAGE_FILE + '.tmp', { force: true, recursive: true });
        if (SNAPSHOT !== null) writeFileSync(USAGE_FILE, SNAPSHOT);
    } catch { /* best effort */ }
});

let failed = 0;
function check(name, ok, detail, why) {
    if (ok) { console.log(`✅ ${name}`); return; }
    console.error(`❌ ${name}\n     ${detail}\n     why it matters: ${why}`);
    failed++;
}
const clear = () => { rmSync(USAGE_FILE, { force: true, recursive: true }); rmSync(USAGE_FILE + '.tmp', { force: true, recursive: true }); };
const today = () => new Date().toISOString().slice(0, 10);
const rows = () => usageStore.readUsage().days?.[today()] || {};

async function capture(fn) {
    const lines = [];
    const realLog = console.log, realWarn = console.warn;
    console.log = (...a) => lines.push(a.join(' '));
    console.warn = (...a) => lines.push(a.join(' '));
    try { return { value: await fn(), lines }; }
    finally { console.log = realLog; console.warn = realWarn; }
}
const usageLines = (l) => l.filter(x => x.startsWith('USAGE:'));

/** A canonical 16-bit mono PCM WAV of exactly `seconds` at 16 kHz. */
function wav(seconds, { rate = 16000, channels = 1, bits = 16 } = {}) {
    const dataBytes = Math.round(rate * channels * (bits / 8) * seconds);
    const b = Buffer.alloc(44 + dataBytes);
    b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + dataBytes, 4); b.write('WAVE', 8, 'ascii');
    b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
    b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24);
    b.writeUInt32LE(rate * channels * bits / 8, 28); b.writeUInt16LE(channels * bits / 8, 32);
    b.writeUInt16LE(bits, 34);
    b.write('data', 36, 'ascii'); b.writeUInt32LE(dataBytes, 40);
    return b;
}

// ── LEG 1 — seconds is DERIVED, and fails toward omission ───────────────────
{
    check('leg 1a — a canonical WAV yields exact seconds',
        S.wavSeconds(wav(2.5)) === 2.5,
        `got ${S.wavSeconds(wav(2.5))}`,
        'this is the positive control — without it every "returns null" leg below passes on a function that always gives up');

    const cases = [
        ['not a RIFF file', Buffer.from('this is not audio at all, not even close')],
        ['truncated below a header', wav(1).subarray(0, 30)],
        ['RIFF but not WAVE', (() => { const b = wav(1); b.write('AVI ', 8, 'ascii'); return b; })()],
        ['an extra chunk where `data` should be', (() => { const b = wav(1); b.write('LIST', 36, 'ascii'); return b; })()],
        ['a data length larger than the buffer', (() => { const b = wav(1); b.writeUInt32LE(999999999, 40); return b; })()],
        ['a zero sample rate', (() => { const b = wav(1); b.writeUInt32LE(0, 24); return b; })()],
    ];
    const wrong = cases.filter(([, buf]) => S.wavSeconds(buf) !== null).map(([n]) => n);
    check(`leg 1b — every malformed header returns null rather than a number (${cases.length} cases)`,
        wrong.length === 0,
        `produced a number for: ${wrong.join(' · ')}`,
        'a WRONG seconds silently becomes a wrong cost in an unknown direction and looks entirely healthy — the charge_rates failure mode. Omission is recoverable; a plausible wrong number is not');

    // The `data`-tag case is the one NOT in the spec, so name it separately.
    const listChunk = (() => { const b = wav(1); b.write('LIST', 36, 'ascii'); return b; })();
    check('leg 1c — the `data`-tag check (beyond the spec) catches a WAV with an extra chunk',
        S.wavSeconds(listChunk) === null,
        'a non-canonical WAV produced a number',
        'the @40 length field is only the data size in a canonical 44-byte header; with an extra LIST/fact chunk it is some other field entirely, and reading it yields a plausible number from the wrong bytes');
}

// ── LEG 2 — provider identity is the HOST, never the URL ────────────────────
{
    const withKey = 'http://192.168.1.50:8000/v1?api_key=SECRET123';
    check('leg 2 — hostOf() keeps the host and drops everything that could carry a credential',
        S.hostOf(withKey) === '192.168.1.50:8000' && !String(S.hostOf(withKey)).includes('SECRET'),
        `got ${JSON.stringify(S.hostOf(withKey))}`,
        '§6 forbids storing credentials, and an engine URL can carry a key in its query string — the store would then hold a secret in a file that is deliberately NOT mode 600 and IS backed up');
}

// ── LEG 3 — the two branches do not merge ───────────────────────────────────
{
    clear();
    const audio = wav(1);
    await capture(async () => {
        S.recordSttCall(audio, { stt_url: 'http://192.168.1.50:8000', stt_model: 'whisper-1' }, 'local');
        S.recordSttCall(audio, {}, 'cloud');
    });
    const keys = Object.keys(rows()).sort();
    check('leg 3a — a local turn and a hosted turn land in DIFFERENT store rows',
        keys.length === 2 && keys.includes('192.168.1.50:8000|whisper-1|free') && keys.includes('dashie_cloud|-|metered'),
        `rows: ${JSON.stringify(keys)}`,
        'billing is part of the store key precisely so metered spend and the household\'s own spend can never merge into one number (§5a) — and the hosted row is server-authoritative, so a merged row would also make the local store look like a cost authority it is not');

    clear();
    await capture(async () => {
        S.recordSttCall(audio, { stt_url: 'http://paid.example.com', stt_api_key: 'k' }, 'local');
    });
    check('leg 3b — THE KEY decides byok vs free, not the route',
        Object.keys(rows())[0] === 'paid.example.com|whisper-1|byok',
        `row: ${Object.keys(rows())[0]}`,
        'same route, opposite answers: an empty key is Whisper on the household\'s own hardware where no money moves, a non-empty one is a paid endpoint. Only the key tells them apart — the same discriminator capability.js uses for the brain');
}

// ── LEG 4 — bytes always, seconds only when derived, one USAGE: line ────────
{
    clear();
    const good = await capture(async () => S.recordSttCall(wav(2), { stt_url: 'http://box:8000' }, 'local'));
    const gRow = Object.values(rows())[0];
    check('leg 4a — a parseable turn records BOTH bytes and seconds, in one USAGE: line',
        usageLines(good.lines).length === 1 && gRow?.bytes === wav(2).length && gRow?.seconds === 2,
        `lines=${JSON.stringify(usageLines(good.lines))} row=${JSON.stringify(gRow)}`,
        'seconds is what a provider bills; bytes is what this lane always has. Recording only one of them makes the view either unreconcilable or absent');

    clear();
    const bad = await capture(async () => S.recordSttCall(Buffer.from('not audio at all, definitely'), { stt_url: 'http://box:8000' }, 'local'));
    const bRow = Object.values(rows())[0];
    check('leg 4b — an unparseable turn records bytes ALONE, with a DROP marker and still ONE USAGE: line',
        usageLines(bad.lines).length === 1
        && bad.lines.some(l => l.includes('DROP: stt-usage no-seconds'))
        && bRow?.bytes > 0 && bRow?.seconds === undefined,
        `lines=${JSON.stringify(bad.lines)} row=${JSON.stringify(bRow)}`,
        'a lane that quietly stops emitting seconds looks exactly like a lane nobody used; the view would show bytes forever and nobody would ask why');

    check('leg 4c — the USAGE: marker reports BYTES, the unit that is always present',
        /^USAGE: lane=stt provider=box:8000 units=bytes n=\d+ billing=free ok=1$/.test(usageLines(bad.lines)[0]),
        `marker: ${usageLines(bad.lines)[0]}`,
        'a marker whose number is sometimes absent cannot be grepped and summed — which is the entire reason the marker exists');
}

// ── LEG 5 — NO ZERO ROWS ───────────────────────────────────────────────────
{
    clear();
    await capture(async () => {
        S.recordSttCall(Buffer.alloc(0), { stt_url: 'http://box:8000' }, 'local');
        S.recordSttCall(null, { stt_url: 'http://box:8000' }, 'local');
    });
    check('leg 5 — nothing sent ⇒ nothing recorded (no zero rows)',
        Object.keys(rows()).length === 0,
        `rows: ${JSON.stringify(rows())}`,
        'a zero row is indistinguishable from a real call that transcribed silence, and it inflates the call count the view reports. The failure paths in handleStt made no provider call at all — there is no usage, not zero usage');
}

// ── LEG 6 — DRIVEN: the call site is REACHED on the success path only ───────
//
// 🔴 Presence is not reachability — leg 10 of the TTS gate stayed green against
// a dead-coded branch until it was made to call the function. Locally
// readOptions() reads /data/options.json, which is absent, so handleStt takes the
// HOSTED branch; that is the branch this drives.
//
// ⚠️ The first version of this leg passed for the WRONG REASON and I only
// noticed because 6a went red beside it. With no stored JWT, handleStt returns
// 503 `stt_unconfigured` BEFORE reaching the provider at all — so 6b's "records
// nothing" was trivially true against a request that never happened, and it
// would have stayed green no matter what the capture point did. The credential
// is stubbed below so both halves exercise a real provider round trip. A
// negative check that cannot tell "correctly silent" from "never ran" is the
// same shape as the 0.1.12 self-concealing restart check.
{
    clear();
    const realFetch = globalThis.fetch;
    const auth = require_(join(SERVER, 'auth.js'));
    const realGetValidJwt = auth.getValidJwt;
    auth.getValidJwt = async () => ({ jwt: 'control-jwt-not-a-credential' });
    const fakeReq = (buf) => ({ on(ev, cb) { if (ev === 'data') cb(buf); if (ev === 'end') cb(); return this; } });
    const noop = { writeHead() {}, end() {} };

    globalThis.fetch = async () => new Response(JSON.stringify({ transcript: 'hello' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const ok = await capture(() => engines.handleStt(fakeReq(wav(1)), noop, () => {}));
    const okRows = Object.keys(rows());

    clear();
    globalThis.fetch = async () => new Response('nope', { status: 500 });
    const err = await capture(() => engines.handleStt(fakeReq(wav(1)), noop, () => {}));
    const errRows = Object.keys(rows());
    globalThis.fetch = realFetch;
    auth.getValidJwt = realGetValidJwt;

    check('leg 6a — DRIVEN: a successful handleStt turn records exactly one row and one USAGE: line',
        okRows.length === 1 && usageLines(ok.lines).length === 1,
        `rows=${JSON.stringify(okRows)} usage=${JSON.stringify(usageLines(ok.lines))}`,
        'this is the only assertion that distinguishes a wired capture point from an unreferenced module — the same gap that let a dead-coded TTS branch pass a static check');
    check('leg 6b — DRIVEN: a FAILED handleStt turn records nothing at all',
        errRows.length === 0 && usageLines(err.lines).length === 0,
        `rows=${JSON.stringify(errRows)} usage=${JSON.stringify(usageLines(err.lines))}`,
        'the success-path-only rule has to hold at the CALL SITE, not just in the helper: a capture call placed before the resp.ok check would record every outage as usage');
}

console.log('');
if (failed) {
    console.error(`❌ ${failed} leg(s) failed`);
    process.exit(1);
}
console.log('✅ all legs pass — bytes always, seconds only when derived, the two lanes stay apart, and only successes are recorded');
