#!/usr/bin/env node
/**
 * check-usage-lane — usage-store.js keeps each row's LANE on the entry (not in the
 * key, no SCHEMA_VERSION bump; agreed HV + B 2026-10-10):
 *   absent = not recorded yet → backfilled on the next call
 *   string = known
 *   null   = two lanes summed into one row → unknowable, and STICKY
 *
 * 🔴 Leg 3 is the one that matters, and it is B's design: a READ after a mismatch
 * cannot tell sticky from un-sticky (the console maps null and absent to the same
 * lane-unknown, and `entry.lane = undefined` serialises exactly like `delete`). Only
 * a SECOND CALL after the mismatch discriminates — and it is asserted on the RAW
 * stored JSON, never through a reader that cannot see the difference.
 *
 * Run: node scripts/check-usage-lane.mjs
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'dashie-ha', 'server');
const require_ = createRequire(import.meta.url);
let config, store;
try {
    config = require_(join(SERVER, 'config.js'));
    store = require_(join(SERVER, 'usage-store.js'));
} catch (e) {
    console.error(`check-usage-lane: cannot check — module did not load: ${e.message}`);
    process.exit(2);
}
if (config.DATA_DIR === '/data') {
    console.error('check-usage-lane: refusing to run — DATA_DIR is /data (a real add-on volume).');
    process.exit(2);
}
mkdirSync(config.DATA_DIR, { recursive: true });
const FILE = store.USAGE_FILE;
const SNAP = existsSync(FILE) ? readFileSync(FILE, 'utf8') : null;
process.on('exit', () => { try { rmSync(FILE, { force: true }); if (SNAP !== null) writeFileSync(FILE, SNAP); } catch { /* best effort */ } });

let failed = 0, passed = 0;
const check = (name, ok, detail) => { if (ok) { passed++; console.log(`✅ ${name}`); } else { failed++; console.error(`❌ ${name}\n     ${detail}`); } };
const quiet = (fn) => { const lines = []; const [l, w] = [console.log, console.warn]; console.log = console.warn = (...a) => lines.push(a.join(' ')); try { fn(); } finally { console.log = l; console.warn = w; } return lines; };
const DAY = new Date().toISOString().slice(0, 10);
const KEY = 'gemini|shared-model|byok';
const rec = (lane, units) => quiet(() => store.recordLocalUsage({ lane, provider: 'gemini', model: 'shared-model', billing: 'byok', success: true, units }));
const raw = () => readFileSync(FILE, 'utf8');
const entryOf = () => JSON.parse(raw()).days[DAY][KEY];

// 1. a new row carries its lane
rmSync(FILE, { force: true });
rec('tts', { characters: 10 });
check('1 — a new row records its lane', entryOf().lane === 'tts', JSON.stringify(entryOf()));

// 2. a pre-lane row is backfilled, and its counts survive
writeFileSync(FILE, JSON.stringify({ schema_version: store.SCHEMA_VERSION, days: { [DAY]: { [KEY]: { calls: 4, errors: 1, characters: 40 } } } }));
rec('tts', { characters: 10 });
check('2 — a pre-lane row is backfilled; history kept (no schema wipe)', JSON.stringify(entryOf()) === JSON.stringify({ calls: 5, errors: 1, characters: 50, lane: 'tts' }), JSON.stringify(entryOf()));

// 3. mismatch → null, and null is STICKY across a further call (raw JSON)
rmSync(FILE, { force: true });
rec('stt', { seconds: 2 });
const drop = rec('tts', { characters: 10 });
check('3a — a second lane on the same key: DROP usage-local-lane-mismatch', drop.some(l => l.startsWith('DROP: usage-local-lane-mismatch')), drop.join(' | '));
rec('tts', { characters: 10 });   // ← the discriminating call
check('3b — after ANOTHER call the raw file still literally holds "lane": null', /"lane": null/.test(raw()) && entryOf().lane === null, raw());
check('3c — counting continues on the merged row', entryOf().calls === 3 && entryOf().seconds === 2 && entryOf().characters === 20, JSON.stringify(entryOf()));

// 4. control: the same lane twice is not a mismatch
rmSync(FILE, { force: true });
rec('stt', { seconds: 1 });
const same = rec('stt', { seconds: 1 });
check('4 — CONTROL: the same lane twice raises no DROP and keeps the lane', !same.some(l => l.startsWith('DROP:')) && entryOf().lane === 'stt', same.join(' | '));

console.log(`\n${passed} passed, ${failed} failed`);
if (!failed) console.log('check-usage-lane: ALL PASS');
process.exit(failed ? 1 : 0);
