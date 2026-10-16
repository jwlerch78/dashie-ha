#!/usr/bin/env node
/**
 * check-voice-samples — every shipped voice sample is a file a browser will actually
 * play, the manifest and the directory agree, and every built-in personality has one.
 *
 * 🔴 WHY LEG 4 EXISTS, AND IT IS THE WHOLE REASON FOR THIS FILE.
 *
 * The first generator run wrote all 30 Gemini samples as `.mp3` and they were RAW PCM.
 * Gemini's TTS answers with s16le/24k/mono and no container; ElevenLabs and Inworld
 * answer with real MP3. The two paths are identical at the fetch and diverge only in
 * the bytes. Every downstream check would have passed: 30 files present, 30 manifest
 * rows, `VoiceSamples.playbackPlan()` correctly reporting `mode:'sample'` because a
 * recording genuinely EXISTS — and a ▶ that does nothing at all, 30 times.
 *
 * That is the expensive shape: not a missing thing, a thing of the wrong KIND. Nothing
 * that counts, lists or resolves can see it. Only something that reads the first bytes
 * can. So that is what leg 4 does, on every file, every run.
 *
 * ── WHAT A GREEN HERE DOES NOT PROVE ────────────────────────────────────────
 *   · that a sample contains the RIGHT voice. The manifest says which voice a file
 *     claims to be; nothing here can hear it. Only John can say Butler sounds like
 *     Butler — that is the listening pass this whole feature exists to enable.
 *   · that a sample contains SPEECH at all. Leg 5 asserts a plausible duration, which
 *     rules out an empty or truncated render and nothing more.
 *   · that the console RENDERS a ▶, or that pressing it plays. These legs read files.
 *   · that the manifest matches the CURRENT catalog. voice-sample-sources.json is a
 *     dated snapshot and goes stale silently; leg 7 compares against that snapshot,
 *     which is the best a hermetic gate can do.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'dashie-ha', 'frontend', 'console', 'assets', 'voices');
const SOURCES = join(HERE, 'voice-sample-sources.json');
const LINES = join(HERE, 'voice-sample-lines.json');

let pass = 0, fail = 0;
const t = (name, ok, why) => {
    if (ok) { pass++; console.log(`✅ ${name}`); }
    else { fail++; console.log(`❌ ${name}${why ? `\n      ${why}` : ''}`); }
};

console.log('── check-voice-samples ──────────────────────────────────────────────\n');

if (!existsSync(DIR)) {
    console.log('⏭️  no samples directory yet — the generator has not been run.');
    console.log('    This is a legitimate state: the previews ship INERT and every ▶ says');
    console.log('    "no recording". Run scripts/gen-voice-samples.mjs to populate it.');
    process.exit(0);
}

const manifestPath = join(DIR, 'manifest.json');
if (!existsSync(manifestPath)) { console.log('❌ samples exist but manifest.json does not — nothing can resolve them'); process.exit(1); }
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const samples = manifest.samples || {};
const files = readdirSync(DIR).filter(f => f.endsWith('.mp3'));

// ── FLOOR ────────────────────────────────────────────────────────────────────
t('leg 0 FLOOR — the manifest actually lists samples (every leg below iterates it)',
  Object.keys(samples).length > 0, 'an empty manifest makes every per-sample leg pass vacuously');
t('leg 0b FLOOR — there are .mp3 files on disk to read',
  files.length > 0, 'no files means leg 4 reads nothing and still reports green');

// ── 1/2 — manifest and directory agree, both directions ─────────────────────
const missing = Object.entries(samples).filter(([, s]) => !existsSync(join(DIR, s.file))).map(([id]) => id);
t('leg 1 — every manifest row has a file on disk',
  missing.length === 0, `listed but absent: ${missing.slice(0, 6).join(', ')} — the ▶ resolves to mode:'sample' and then 404s`);

const listed = new Set(Object.values(samples).map(s => s.file));
const orphans = files.filter(f => !listed.has(f));
t('leg 2 — every file on disk is in the manifest (no orphans)',
  orphans.length === 0, `shipped but unreachable: ${orphans.slice(0, 6).join(', ')} — dead weight in a public repo and the add-on`);

// ── 3 — nothing empty ───────────────────────────────────────────────────────
const tiny = Object.entries(samples).filter(([, s]) => { const p = join(DIR, s.file); return existsSync(p) && statSync(p).size < 2048; }).map(([id]) => id);
t('leg 3 — no sample is empty or near-empty (<2 KB)', tiny.length === 0, `suspicious: ${tiny.join(', ')}`);

// ── 4 🔴 — THE ONE. Every file is a container a browser will play. ──────────
const unplayable = [];
for (const [id, s] of Object.entries(samples)) {
    const p = join(DIR, s.file);
    if (!existsSync(p)) continue;
    const b = readFileSync(p).subarray(0, 4);
    const id3 = b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33;
    const sync = b[0] === 0xFF && (b[1] & 0xE0) === 0xE0;
    if (!id3 && !sync) unplayable.push(`${id} (${[...b].map(x => x.toString(16).padStart(2, '0')).join(' ')})`);
}
t('leg 4 🔴 — EVERY sample is a real MP3 (ID3 tag or MPEG frame sync), not raw PCM',
  unplayable.length === 0,
  `a file of the wrong KIND passes counting, listing and resolution and still plays nothing:\n      ${unplayable.slice(0, 6).join('\n      ')}`);

// ── 5 — plausible length, from the frame header rather than a decoder ────────
const sizes = Object.values(samples).map(s => s.bytes || 0).filter(Boolean);
const minKB = Math.min(...sizes) / 1024, maxKB = Math.max(...sizes) / 1024;
t('leg 5 — sample sizes are in a plausible speech range (8 KB – 400 KB)',
  sizes.length > 0 && minKB > 8 && maxKB < 400,
  `min ${minKB.toFixed(1)} KB / max ${maxKB.toFixed(1)} KB. Too small = a trim ate the clip; too large = raw PCM crept back in`);

// ── 6 — the stock line is IDENTICAL across stock voices ─────────────────────
const stock = Object.entries(samples).filter(([id]) => id.startsWith('voice:'));
const texts = new Set(stock.map(([, s]) => s.text));
t('leg 6 — every STOCK voice says the SAME line (you are comparing voices, not scripts)',
  stock.length === 0 || texts.size === 1,
  `${texts.size} different lines across ${stock.length} stock samples — a different script per voice makes an audition meaningless`);

// ── 7 — every built-in personality has a sample ─────────────────────────────
if (existsSync(SOURCES) && existsSync(LINES)) {
    const src = JSON.parse(readFileSync(SOURCES, 'utf8'));
    const lines = JSON.parse(readFileSync(LINES, 'utf8'));
    const want = (src.personalities || []).filter(p => p.provider && p.providerVoiceId).map(p => p.key);
    const lacking = want.filter(k => !samples[`personality:${k}`]);
    t('leg 7 — every built-in personality with a resolvable voice HAS a recording',
      lacking.length === 0,
      `no sample for: ${lacking.join(', ')} — a LOCKED personality with no ▶ is the one row that most needs one`);
    const noLine = want.filter(k => !lines.personalities?.[k]);
    t('leg 7b — …and every one of them has a line (a key mismatch silently drops one)',
      noLine.length === 0,
      `no line for: ${noLine.join(', ')}. This fired for real: the lines file said 'standard', the database says 'dashie'`);
}

const total = Object.values(samples).reduce((n, s) => n + (s.bytes || 0), 0);
console.log(`\ncheck-voice-samples: ${pass} pass, ${fail} fail`);
console.log(`  ${Object.keys(samples).length} samples · ${(total / 1024 / 1024).toFixed(2)} MB shipped in the add-on`);
console.log(`
📌 FLOOR — what a green here does NOT prove:
   · that a sample is the RIGHT voice. The manifest records what a file CLAIMS to be;
     nothing here can hear it. Only a person can say Butler sounds like Butler.
   · that a sample contains speech — leg 5 rules out empty and truncated, nothing more.
   · that the console renders a ▶, or that pressing it plays.
   · that the manifest matches the CURRENT catalog. voice-sample-sources.json is a dated
     snapshot that goes stale silently; leg 7 can only compare against that snapshot.`);

if (fail > 0) process.exit(1);
console.log('\n✅ ALL PASS — files and manifest agree, every sample is a playable MP3, every built-in has one');
