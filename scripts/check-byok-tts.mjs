#!/usr/bin/env node
/**
 * check-byok-tts — controls for the box-proxied BYOK TTS adapter and the usage
 * record it writes.
 *
 * Calls the REAL exported `synthesize`/`available` from
 * `dashie-ha/server/byok-tts.js` and the REAL `recordLocalUsage`/`readUsage`
 * from `dashie-ha/server/usage-store.js`, with only the network stubbed. No copy
 * of either module's logic lives here — a test that restates the rules it is
 * testing passes while the shipped path is wrong.
 *
 * ── WHY THESE PROPERTIES ─────────────────────────────────────────────────────
 *
 * Every one is a failure that is INVISIBLE in normal use: the audio still plays,
 * the console still renders, and the only thing that is wrong is a number nobody
 * looks at until it is compared with a provider invoice.
 *
 *   • one call ⇒ one USAGE:  the marker's entire value is that a single grep
 *                            counts recorded calls. Two lines per turn (a retry,
 *                            a second capture point) or zero (a marker moved
 *                            behind a branch) both read as plausible logs.
 *   • the DROP marker's READER  a fail-soft recorder that goes silent is the
 *                            s53 lesson; this drives a real write failure and
 *                            asserts the marker fires and USAGE: does NOT — the
 *                            marker must never claim a row that is not there.
 *   • units only on success  a 401 synthesised nothing and was billed nothing.
 *                            Counting its characters inflates the number in the
 *                            one direction a user would never question.
 *   • storable ≠ spendable   deepgram/inworld are storable TODAY with no
 *                            adapter. `available()` reading the key store alone
 *                            would route a turn into a provider this box cannot
 *                            call, and the failure would look like the provider
 *                            being down.
 *   • the manifest agrees    adapter:'shipped' is a claim the console renders to
 *                            a user. It is the one field here that can be
 *                            falsified by doing nothing.
 *   • the branch is IN the choke point  the proposal called for a new
 *                            `/api/voice/tts`; that route already exists as a
 *                            bridge handler registered ahead of the console
 *                            router, so a second one would be shadowed and
 *                            unreachable. This asserts the branch lives where
 *                            the traffic already goes.
 *
 * Exit 0 = every control passes, 1 = a violation, 2 = cannot check.
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'dashie-ha', 'server');
const BYOK = join(SERVER, 'byok-tts.js');
const USAGE = join(SERVER, 'usage-store.js');
const ENGINES = join(SERVER, 'engines.js');
const MANIFEST = join(HERE, '..', 'dashie-ha', 'frontend', 'console', 'js', 'lib', 'provider-manifest.js');

for (const f of [BYOK, USAGE, ENGINES, MANIFEST]) {
    if (!existsSync(f)) {
        console.error(`check-byok-tts: cannot check — ${f} not found`);
        process.exit(2);
    }
}

const require_ = createRequire(import.meta.url);

let byok, usageStore, config;
try {
    config = require_(join(SERVER, 'config.js'));
    usageStore = require_(USAGE);
    byok = require_(BYOK);
} catch (e) {
    console.error(`check-byok-tts: cannot check — module did not load: ${e.message}`);
    process.exit(2);
}

// 🔴 Refuse to run against a real add-on volume. These controls WRITE the usage
// store and the key store; on a box that is live household data. Locally
// DATA_DIR falls back to dashie-ha/data, which is gitignored.
if (config.DATA_DIR === '/data') {
    console.error('check-byok-tts: refusing to run — DATA_DIR is /data (a real add-on volume). Run this in a checkout, not on a box.');
    process.exit(2);
}

const DATA_DIR = config.DATA_DIR;
const USAGE_FILE = usageStore.USAGE_FILE;
const KEYS_FILE = join(DATA_DIR, 'api-keys.json');
mkdirSync(DATA_DIR, { recursive: true });

// Snapshot anything already there, so a dev's local keys survive a control run.
const SNAPSHOT = {};
for (const f of [USAGE_FILE, KEYS_FILE]) {
    SNAPSHOT[f] = existsSync(f) ? readFileSync(f, 'utf8') : null;
}
function restoreSnapshot() {
    for (const [f, content] of Object.entries(SNAPSHOT)) {
        try {
            rmSync(f, { force: true, recursive: true });
            rmSync(f + '.tmp', { force: true, recursive: true });
            if (content !== null) writeFileSync(f, content);
        } catch { /* best effort */ }
    }
}
process.on('exit', restoreSnapshot);

// ── Harness ──────────────────────────────────────────────────────────────────

let failed = 0;
function check(name, ok, detail, why) {
    if (ok) { console.log(`✅ ${name}`); return; }
    console.error(`❌ ${name}\n     ${detail}\n     why it matters: ${why}`);
    failed++;
}

/** Run `fn` with console captured and the network stubbed. */
async function capture(fn, fetchImpl) {
    const lines = [];
    const realLog = console.log, realWarn = console.warn, realFetch = globalThis.fetch;
    console.log = (...a) => lines.push(a.join(' '));
    console.warn = (...a) => lines.push(a.join(' '));
    if (fetchImpl) globalThis.fetch = fetchImpl;
    try {
        const value = await fn();
        return { value, lines };
    } finally {
        console.log = realLog; console.warn = realWarn; globalThis.fetch = realFetch;
    }
}

const usageLines = (lines) => lines.filter(l => l.startsWith('USAGE:'));
const setKeys = (obj) => writeFileSync(KEYS_FILE, JSON.stringify(obj, null, 2));
const clearStore = () => { rmSync(USAGE_FILE, { force: true, recursive: true }); rmSync(USAGE_FILE + '.tmp', { force: true, recursive: true }); };

const FAKE_KEY = 'sk_control_do_not_use_0000DEADBEEF';
const okFetch = () => async () => new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { status: 200 });
const errFetch = (status) => async () => new Response('nope', { status });

// ── LEG 1 — storable is not spendable ────────────────────────────────────────
//
// The join both this lane and the console's picker need: a key present AND an
// adapter shipped. Either half alone routes a turn somewhere it cannot go.
clearStore();
setKeys({});
check('leg 1a — no keys ⇒ available() false',
    byok.available() === false,
    `available()=${byok.available()} with an empty key store`,
    'a lane that thinks it can serve with no key returns 503s that look like a provider outage');

setKeys({ deepgram: { key: FAKE_KEY }, inworld: { key: FAKE_KEY } });
check('leg 1b — a STORABLE speech key with NO adapter ⇒ still unavailable',
    byok.available() === false && byok.resolveProvider() === null,
    `resolveProvider()=${byok.resolveProvider()} with deepgram+inworld stored`,
    'deepgram and inworld are storable today and have no on-box adapter; routing to them ' +
    'would fail in a way indistinguishable from the provider being down, and would also ' +
    "make the console's adapter:'pending' a lie");

setKeys({ elevenlabs: { key: FAKE_KEY } });
check('leg 1c — POSITIVE CONTROL: a keyed AND adapted provider resolves',
    byok.resolveProvider() === 'elevenlabs',
    `resolveProvider()=${byok.resolveProvider()} with an elevenlabs key stored`,
    'without this, legs 1a/1b would pass on a function that always answers no');

// ── LEG 2 — one turn ⇒ exactly one USAGE: line, with the right fields ─────────
clearStore();
setKeys({ elevenlabs: { key: FAKE_KEY } });
const TEXT = 'Tomorrow looks sunny with a high of seventy five.';
{
    const { value, lines } = await capture(() => byok.synthesize({ text: TEXT }), okFetch());
    const u = usageLines(lines);
    const expected = `USAGE: lane=tts provider=elevenlabs units=chars n=${TEXT.length} billing=byok ok=1`;
    check('leg 2a — one successful turn emits EXACTLY ONE USAGE: line',
        u.length === 1,
        `${u.length} USAGE: line(s): ${JSON.stringify(u)}`,
        'the marker exists so one grep counts recorded calls; two lines per turn double every figure in the Usage view and neither line looks wrong');
    check('leg 2b — the line carries lane, provider, unit and count',
        u[0] === expected,
        `expected  ${expected}\n     got       ${u[0]}`,
        "lane= must come first so a single grep isolates one lane, and n= must be the CHARACTERS the provider bills — not the byte count of the audio");
    check('leg 2c — the turn returned audio',
        value?.ok === true && Buffer.isBuffer(value.audio) && value.contentType === 'audio/mpeg',
        `ok=${value?.ok} audio=${Buffer.isBuffer(value?.audio)} contentType=${value?.contentType}`,
        'a control that only counted log lines would pass on an adapter that never returns audio');

    // ── LEG 3 — the key is never logged and never returned ───────────────────
    const leaked = lines.filter(l => l.includes(FAKE_KEY));
    check('leg 3a — the key appears in NO log line',
        leaked.length === 0,
        `${leaked.length} line(s) contain the key: ${JSON.stringify(leaked)}`,
        "the whole reason this is box-proxied is api/keys.js's written promise that the key never leaves the box; a log line is leaving the box the moment anyone posts a diagnostic bundle");
    check('leg 3b — the key is not on the returned object',
        !JSON.stringify(value ?? {}, (k, v) => (Buffer.isBuffer(v) ? '<buf>' : v)).includes(FAKE_KEY),
        'the synthesize() result serialises to something containing the key',
        'the result crosses into the HTTP layer; anything on it can reach a response body or an error report');

    // ── LEG 4 — the store aggregated it, at D's grain ────────────────────────
    const store = usageStore.readUsage();
    const day = new Date().toISOString().slice(0, 10);
    const entry = store.days?.[day]?.['elevenlabs|eleven_flash_v2_5|byok'];
    check('leg 4 — the store holds one call at day × provider|model|billing grain',
        !!entry && entry.calls === 1 && entry.errors === 0 && entry.characters === TEXT.length,
        `entry=${JSON.stringify(entry)}`,
        'billing is part of the key ON PURPOSE so free and paid usage can never merge into one number');
}

// ── LEG 5 — a provider error records an error and NO units ───────────────────
{
    const { value, lines } = await capture(() => byok.synthesize({ text: TEXT }), errFetch(401));
    const u = usageLines(lines);
    check('leg 5a — a failed turn ALSO emits exactly one USAGE: line, with ok=0 n=0',
        u.length === 1 && u[0] === 'USAGE: lane=tts provider=elevenlabs units=chars n=0 billing=byok ok=0',
        `${u.length} line(s): ${JSON.stringify(u)}`,
        'a lane that records only its successes reports a healthy service that is failing every call');
    check('leg 5b — the failure did not fall through to another engine',
        value?.ok === false && value.status === 502,
        `ok=${value?.ok} status=${value?.status}`,
        "silently billing the account's credits because the household's own key 401'd spends somebody's money to hide a fault");

    const entry = usageStore.readUsage().days?.[new Date().toISOString().slice(0, 10)]?.['elevenlabs|eleven_flash_v2_5|byok'];
    check('leg 5c — units did NOT move on the error (calls 2, errors 1, chars unchanged)',
        !!entry && entry.calls === 2 && entry.errors === 1 && entry.characters === TEXT.length,
        `entry=${JSON.stringify(entry)}`,
        'a 401 synthesised nothing and was billed nothing; counting its characters inflates the figure in the one direction a user would never question');
}

// ── LEG 6 — the DROP marker fires on a write failure, and USAGE: does NOT ─────
//
// The reader the marker gains in the same change. A directory where the store's
// temp file goes makes writeFileSync throw deterministically — no permission
// games, no root-vs-user difference.
{
    clearStore();
    mkdirSync(USAGE_FILE + '.tmp', { recursive: true });
    const { lines } = await capture(() => byok.synthesize({ text: TEXT }), okFetch());
    rmSync(USAGE_FILE + '.tmp', { force: true, recursive: true });
    const drops = lines.filter(l => l.includes('DROP: usage-local-write-failed'));
    check('leg 6a — an unwritable store emits DROP: usage-local-write-failed',
        drops.length === 1,
        `${drops.length} DROP line(s): ${JSON.stringify(lines)}`,
        'every recorder here is deliberately non-fatal, which is exactly why a silent one goes unnoticed for a day');
    check('leg 6b — and emits NO USAGE: line',
        usageLines(lines).length === 0,
        `USAGE: lines: ${JSON.stringify(usageLines(lines))}`,
        'a USAGE: line means "a row exists for this call"; emitting it on a failed write makes the marker claim a record that is not there, and the grep that counts calls silently over-counts');
}

// ── LEG 7 — the schema_version gate ──────────────────────────────────────────
{
    clearStore();
    writeFileSync(USAGE_FILE, JSON.stringify({
        schema_version: usageStore.SCHEMA_VERSION + 1,
        days: { '2026-08-04': { 'x|y|byok': { calls: 999, errors: 0, characters: 999 } } },
    }));
    const read = usageStore.readUsage();
    check('leg 7 — an unknown schema_version reads as EMPTY, not coerced',
        Object.keys(read.days).length === 0,
        `readUsage() returned ${Object.keys(read.days).length} day(s) from a v${usageStore.SCHEMA_VERSION + 1} file`,
        'coercing a shape written by different code produces numbers that are wrong rather than absent, and nothing indicates which');
}

// ── LEG 8 — retention prunes on write ────────────────────────────────────────
//
// Not a tidiness check. The whole file is parsed and re-serialised on EVERY
// recorded call, so an unpruned store is a latency problem on the voice path
// long before it is a disk problem.
{
    clearStore();
    const dayN = (back) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
    const tooOld = dayN(usageStore.RETENTION_DAYS + 5);
    const inWindow = dayN(usageStore.RETENTION_DAYS - 5);
    writeFileSync(USAGE_FILE, JSON.stringify({
        schema_version: usageStore.SCHEMA_VERSION,
        days: {
            [tooOld]: { 'elevenlabs|m|byok': { calls: 1, errors: 0, characters: 10 } },
            [inWindow]: { 'elevenlabs|m|byok': { calls: 1, errors: 0, characters: 10 } },
        },
    }));
    await capture(() => byok.synthesize({ text: 'hi' }), okFetch());
    const days = Object.keys(usageStore.readUsage().days);
    check(`leg 8 — a day older than ${usageStore.RETENTION_DAYS} is pruned on write; one inside the window survives`,
        !days.includes(tooOld) && days.includes(inWindow),
        `days after the write: ${JSON.stringify(days)} (expected ${inWindow} present, ${tooOld} gone)`,
        'the binding constraint is the per-turn read-modify-write cost, not disk — an unbounded store is felt as latency, which nobody attributes to a usage recorder');
}

// ── LEG 9 — the manifest's adapter claim agrees with the shipped adapters ─────
//
// ⚠️ Prints its coverage count. A green that means "there was nothing to check"
// is the clean-NUMBER-not-checked-PROPERTY failure this repo has recorded
// repeatedly, and this leg is exactly the shape that can have it.
{
    const src = readFileSync(MANIFEST, 'utf8');
    const shipped = new Set(Object.keys(byok.ADAPTERS));

    // ⚠️ Per-BLOCK, not a spanning regex. The first attempt matched
    // `id: 'key'` out of a provider's `fields:` array and carried the NEXT
    // provider's adapter value with it — a pattern that reported "3 checked"
    // while one of the three did not exist. Exactly the proxy-not-property
    // failure this file's own header is about, caught by the leg firing.
    const listStart = src.indexOf('const PROVIDERS = [');
    const body = listStart >= 0 ? src.slice(listStart, src.indexOf('\n    ];', listStart)) : '';
    const speech = body.split(/\n        \{\n/).slice(1)
        .map(block => ({
            id: (block.match(/^\s{12}id:\s*'([a-z]+)'/m) || [])[1],
            group: (block.match(/group:\s*'([a-z]+)'/) || [])[1],
            adapter: ((block.match(/adapter:\s*ADAPTER\.([A-Z]+)/) || [])[1] || '').toLowerCase(),
        }))
        .filter(p => p.id && p.group === 'speech');

    if (speech.length < 3 || !speech.some(p => p.id === 'elevenlabs')) {
        console.error(`❌ leg 9 — the manifest parse found ${speech.length} speech provider(s) ${JSON.stringify(speech.map(p => p.id))}; ` +
            'expected at least deepgram, elevenlabs and inworld. The pattern cannot see the property — fix the parse, do not lower the bar.');
        failed++;
    } else {
        const wrong = speech.filter(p => (shipped.has(p.id) ? p.adapter !== 'shipped' : p.adapter !== 'pending'));
        check(`leg 9 — every speech provider's adapter claim matches reality (${speech.length} checked, ${shipped.size} shipped: ${[...shipped].join(', ')})`,
            wrong.length === 0,
            `mismatched: ${JSON.stringify(wrong)}`,
            "adapter:'shipped' is rendered to a user as a working capability. Shipping an adapter without flipping it understates; flipping it without an adapter is the console asserting something nobody observed");
    }
}

// ── LEG 10 — the LANE actually reaches BYOK, driven end to end ───────────────
//
// 🔴 The reachability claim, and the reason it is a leg at all: `/api/voice/tts`
// is registered in index.js as a bridge handler BEFORE the console router is
// mounted, so a second `/tts` route added to api/voice-console.js would be
// shadowed and never reached — built, reviewed, vendored, released, unreachable.
// This is the lane's own end, so it has to be the lane that is driven.
//
// ⭐ THIS LEG WAS STATIC FIRST, AND THE STATIC VERSION COULD NOT FAIL. It
// asserted that `byokTts.available()` appeared in handleTts ahead of
// `cloudTts(` — and it stayed GREEN when the branch was dead-coded to
// `if (false && byokTts.available())`. Presence is not reachability; that is the
// same gap as check-sharing-state's leg 4 vs leg 5, found here by breaking the
// gate on purpose rather than by a box. So handleTts is now CALLED, with fake
// req/res, and the assertion is on what came out of it.
{
    clearStore();
    setKeys({ elevenlabs: { key: FAKE_KEY } });
    const engines = require_(ENGINES);

    const fakeReq = (bodyStr) => ({
        on(event, cb) {
            if (event === 'data') cb(Buffer.from(bodyStr));
            if (event === 'end') cb();
            return this;
        },
    });
    const out = { head: null, body: null, json: null };
    const fakeRes = {
        writeHead(status, headers) { out.head = { status, headers }; },
        end(buf) { out.body = buf; },
    };
    const sendJson = (_res, status, body) => { out.json = { status, body }; };

    const { lines } = await capture(
        () => engines.handleTts(fakeReq(JSON.stringify({ text: TEXT })), fakeRes, sendJson),
        okFetch(),
    );

    const servedByok = out.head?.status === 200
        && out.head?.headers?.['Content-Type'] === 'audio/mpeg'
        && Buffer.isBuffer(out.body)
        && out.json === null;
    check('leg 10a — DRIVEN: handleTts with a stored key serves BYOK audio (not the cloud, not a 503)',
        servedByok,
        `head=${JSON.stringify(out.head)} json=${JSON.stringify(out.json)} body-is-buffer=${Buffer.isBuffer(out.body)}`,
        'this is the only assertion that distinguishes a wired branch from a dead-coded one — the static form of this leg stayed green against `if (false && …)`');
    check('leg 10b — and the driven turn emitted exactly one USAGE: line',
        usageLines(lines).length === 1,
        `USAGE: lines: ${JSON.stringify(usageLines(lines))}`,
        'the capture point has to fire on the path the lane really takes, not only when the adapter is called directly');
}

console.log('');
if (failed) {
    console.error(`❌ ${failed} control(s)/leg(s) failed`);
    process.exit(1);
}
console.log('✅ all controls + legs 1–10 pass — the BYOK TTS lane spends only an adapted key, never logs it, and records exactly one USAGE: line per call');
