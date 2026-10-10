#!/usr/bin/env node
/**
 * check-usage-tokens — provider TOKEN counts reach the household's usage record as
 * the provider BILLS them (John 2026-10-09: "we want to relay to them usage metrics",
 * BYOK Gemini on the household's own key).
 *
 * Two defects this gate exists for, both measured on real calls (HV, 2026-10-09):
 *   • Gemini batch STT returned usageMetadata (promptTokenCount 49 for 1.94 s) and the
 *     recorder DROPPED it, keeping only bytes/seconds.
 *   • the brain on Gemini's OpenAI-compatible endpoint reported completion_tokens 2,
 *     total_tokens 234 (thinking tokens are in total, not completion; Google bills them
 *     as output). Recording completion alone showed 2 where Google billed ~222.
 *
 * And one rule both must keep: a count the provider did NOT send is OMITTED, never 0.
 *
 * Exit 0 = every leg passes, 1 = a violation, 2 = cannot check.
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'dashie-ha', 'server');
const require_ = createRequire(import.meta.url);
let S, usageStore, config, brainIo, enginesSrc;
try {
    config = require_(join(SERVER, 'config.js'));
    usageStore = require_(join(SERVER, 'usage-store.js'));
    S = require_(join(SERVER, 'stt-usage.js'));
    brainIo = require_(join(SERVER, 'brain', 'addon-io.js'));
    enginesSrc = readFileSync(join(SERVER, 'engines.js'), 'utf8');
} catch (e) {
    console.error(`check-usage-tokens: cannot check — module did not load: ${e.message}`);
    process.exit(2);
}
if (typeof S.geminiTokenUnits !== 'function' || typeof brainIo.usageFromChatCompletion !== 'function') {
    console.error('check-usage-tokens: cannot check — geminiTokenUnits / usageFromChatCompletion not exported');
    process.exit(2);
}
if (config.DATA_DIR === '/data') {
    console.error('check-usage-tokens: refusing to run — DATA_DIR is /data (a real add-on volume).');
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
const quiet = (fn) => { const w = console.warn, l = console.log; const lines = []; console.warn = (...a) => lines.push(a.join(' ')); console.log = (...a) => lines.push(a.join(' ')); try { return { v: fn(), lines }; } finally { console.warn = w; console.log = l; } };

/** Canonical 16-bit mono 16 kHz WAV of `seconds`. */
function wav(seconds) {
    const n = Math.round(32000 * seconds);
    const b = Buffer.alloc(44 + n);
    b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8, 'ascii');
    b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36, 'ascii'); b.writeUInt32LE(n, 40);
    return b;
}

// ── STT: Gemini usageMetadata → store units ─────────────────────────────────
// The MEASURED shape: transcribe-batch sends prompt + total, and no output count.
const measured = S.geminiTokenUnits({ promptTokenCount: 49, totalTokenCount: 49, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 49 }] });
check('stt 1 — the measured transcribe shape keeps input + total, and does NOT invent an output count',
    measured.input_tokens === 49 && measured.total_tokens === 49 && !('output_tokens' in measured),
    JSON.stringify(measured),
    'Google sent no candidatesTokenCount; a recorded 0 claims a measurement that was never made');

const withOut = S.geminiTokenUnits({ promptTokenCount: 49, candidatesTokenCount: 7, thoughtsTokenCount: 3, totalTokenCount: 59 });
check('stt 2 — output = candidates + thoughts (Google bills thinking as output)',
    withOut.output_tokens === 10, JSON.stringify(withOut),
    'dropping thoughts under-states the invoice on any model that thinks');

const junk = quiet(() => S.geminiTokenUnits({ promptTokenCount: '49', candidatesTokenCount: -1, totalTokenCount: 1.5 }));
check('stt 3 — malformed counts are omitted, and a missing prompt count is a loud DROP',
    Object.keys(junk.v).length === 0 && junk.lines.some((l) => l.startsWith('DROP: stt-usage gemini-no-prompt-tokens')),
    `units=${JSON.stringify(junk.v)} lines=${JSON.stringify(junk.lines)}`,
    'a string or negative count summed into the store becomes a wrong number that looks healthy');

rmSync(USAGE_FILE, { force: true, recursive: true });
quiet(() => S.recordSttCall(wav(2), {}, 'gemini', { promptTokenCount: 49, totalTokenCount: 49 }));
const row = Object.entries(usageStore.readUsage().days?.[new Date().toISOString().slice(0, 10)] || {})
    .find(([k]) => k.startsWith('gemini|'))?.[1];
check('stt 4 — DRIVEN through the real store: the byok gemini row carries input_tokens, and no output_tokens',
    !!row && row.input_tokens === 49 && row.total_tokens === 49 && row.seconds === 2 && !('output_tokens' in row),
    JSON.stringify(row),
    'the helper being right is not enough — the recorder must actually pass the units on');

check('stt 5 — the call site hands Google\'s usage to the recorder',
    /recordSttCall\(audio, readOptions\(\), 'gemini', r\.usage\)/.test(enginesSrc),
    'engines.js gemini branch does not pass r.usage',
    'gemini-stt.js returns usageMetadata; if engines.js drops it, every leg above passes and the store still gets nothing');

// ── Brain: OpenAI-compatible usage → billed output ──────────────────────────
const gem = brainIo.usageFromChatCompletion({ completion_tokens: 2, prompt_tokens: 12, total_tokens: 234 });
check('brain 1 — Gemini compat (measured): output = total − prompt = 222, not completion = 2',
    gem.input_tokens === 12 && gem.output_tokens === 222 && gem.total_tokens === 234,
    JSON.stringify(gem),
    'the Usage view would show ~2 output tokens where Google billed ~222 — a ~100× understatement on the costliest token');

const oai = brainIo.usageFromChatCompletion({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
check('brain 2 — OpenAI-spec (total = prompt + completion): unchanged',
    oai.output_tokens === 5, JSON.stringify(oai),
    'the fix must be a no-op for providers that already put reasoning in completion_tokens');

const noTotal = brainIo.usageFromChatCompletion({ prompt_tokens: 10, completion_tokens: 5 });
check('brain 3 — no total_tokens: falls back to completion, never guesses',
    noTotal.output_tokens === 5 && noTotal.total_tokens === undefined, JSON.stringify(noTotal),
    'a provider that omits total must not have one invented');

const none = brainIo.usageFromChatCompletion(undefined);
check('brain 4 — no usage block: every field absent',
    none.input_tokens === undefined && none.output_tokens === undefined && none.total_tokens === undefined,
    JSON.stringify(none),
    'local models often send no usage; zeros would read as free calls');

console.log('');
if (failed) {
    console.error(`❌ ${failed} leg(s) failed`);
    process.exit(1);
}
console.log('✅ ALL PASS — provider token counts recorded as billed; absent counts stay absent');
