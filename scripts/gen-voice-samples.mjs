#!/usr/bin/env node
/**
 * gen-voice-samples — render the pre-recorded voice previews ONCE, so nobody pays to
 * hear a voice again.
 *
 * John, 2026-10-15: *"we pre-record a TTS statement relevant to the personality in
 * question so people can hear it … we probably should do that for our stock voices too
 * that require tokens so users aren't paying to generate them everytime."*
 *
 * ── HOW IT RENDERS, AND WHY NOT WITH VENDOR KEYS ────────────────────────────
 * Through Dashie's OWN edge functions (elevenlabs-tts / inworld-tts / gemini-tts), with
 * a bench JWT. Three reasons, in order of how much they matter:
 *   1. the samples then sound like the PRODUCT — same function, same model, same params
 *      a household's turn goes through, not an approximation rendered by another path;
 *   2. no vendor key is ever written to this laptop or near this PUBLIC repo;
 *   3. the credential already exists (tools/voice-bench, /mint-bench-jwt).
 *
 * 🔴 record_usage IS LEFT UNSET ON PURPOSE AND MUST STAY THAT WAY. All three functions
 * default it to false (elevenlabs-tts:146, inworld-tts:137, gemini-tts:100), so no
 * token_usage row or credit debit is written for a render. Passing it true here would
 * bill the bench account for a build step and poison the usage record with traffic no
 * household made.
 *
 * ── INPUTS ──────────────────────────────────────────────────────────────────
 *   scripts/voice-sample-lines.json    what each voice SAYS   (John's, edit freely)
 *   scripts/voice-sample-sources.json  which voice each personality IS (DB snapshot)
 *
 * Refresh the snapshot (read-only) with:
 *   psql "<staging>" -At -c "BEGIN TRANSACTION READ ONLY; SELECT jsonb_pretty(jsonb_build_object(
 *     'personalities', (SELECT jsonb_agg(jsonb_build_object('key',pt.key,'name',pt.name,
 *        'voiceKey',pt.voice,'voiceMode',pt.voice_mode,'provider',tv.provider,
 *        'providerVoiceId',tv.provider_voice_id) ORDER BY pt.key)
 *        FROM personality_templates pt LEFT JOIN tts_voices tv ON tv.key=pt.voice WHERE pt.is_available),
 *     'catalogVoices', (SELECT jsonb_agg(jsonb_build_object('key',v.key,'name',v.name,
 *        'provider',v.provider,'providerVoiceId',v.provider_voice_id) ORDER BY v.provider, v.sort_order)
 *        FROM tts_voices v WHERE v.is_available)));"
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *   node scripts/gen-voice-samples.mjs --dry-run            # plan only, calls nothing
 *   node scripts/gen-voice-samples.mjs --only gemini        # one provider
 *   node scripts/gen-voice-samples.mjs                      # render everything missing
 *   node scripts/gen-voice-samples.mjs --force              # re-render even if present
 *
 * Env (not committed — read from tools/voice-bench/.env in the staging repo):
 *   VOICE_BENCH_JWT, SUPABASE_URL, SUPABASE_ANON_KEY
 *
 * 🔴 --dry-run IS THE DEFAULT POSTURE, not a courtesy. Every real run spends money at a
 * vendor and writes binaries into a public repo. Read the plan, then drop the flag.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT_DIR = join(ROOT, 'dashie-ha', 'frontend', 'console', 'assets', 'voices');
const LINES = join(HERE, 'voice-sample-lines.json');
const SOURCES = join(HERE, 'voice-sample-sources.json');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const FORCE = argv.includes('--force');
const ONLY = (() => { const i = argv.indexOf('--only'); return i >= 0 ? argv[i + 1] : null; })();

const FN = { elevenlabs: 'elevenlabs-tts', inworld: 'inworld-tts', gemini: 'gemini-tts' };

/** The 30 Gemini prebuilt voices — read from the add-on's generated list, never retyped. */
function geminiVoices() {
    const f = join(ROOT, 'dashie-ha', 'server', 'generated', 'gemini-voices.js');
    if (!existsSync(f)) return [];
    const m = readFileSync(f, 'utf8').match(/\[([^\]]*)\]/);
    return m ? JSON.parse(`[${m[1]}]`) : [];
}

/**
 * 🔴 GEMINI ANSWERS WITH RAW PCM, NOT A PLAYABLE FILE — and this cost a whole render to
 * find out. The first run wrote all 30 Gemini samples as `.mp3`, 240 KB each. `file`
 * reported them as `data`, their first bytes were zeros rather than `RIFF`/`ID3`/0xFFE,
 * and a browser <audio> would have refused every one of them. ElevenLabs and Inworld
 * return real MP3 (ID3 / MPEG ADTS), so the two paths LOOK identical at the fetch and
 * diverge only in the bytes.
 *
 * ⚠️ The failure would have been silent in the worst way: 30 files present, a manifest
 * listing them, a ▶ that resolves to `mode: 'sample'`, and nothing but a dead button.
 * `VoiceSamples` would correctly report a recording EXISTS, because one does.
 *
 * So Gemini's PCM is encoded here (s16le/24k/mono, the gemini-tts output format) and
 * leading/trailing silence trimmed — the clips open with ~0.3 s of zeros, which on a
 * preview button reads as a broken press. Vendor MP3 is left BYTE-UNTOUCHED: re-encoding
 * it would lose quality to save a megabyte, and quality is the entire point of a voice
 * audition.
 */
function toPlayableMp3(provider, buf) {
    if (provider !== 'gemini') return buf;        // already a real MP3 from the vendor
    const r = spawnSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
        '-af', 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05:stop_periods=-1:stop_threshold=-50dB:stop_silence=0.15',
        '-codec:a', 'libmp3lame', '-b:a', '64k', '-ac', '1', '-f', 'mp3', 'pipe:1',
    ], { input: buf, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0 || !r.stdout?.length) {
        throw new Error(`ffmpeg failed (${r.status}): ${String(r.stderr || '').slice(0, 160)}`);
    }
    return Buffer.from(r.stdout);
}

/** 🔴 REFUSE TO WRITE ANYTHING A BROWSER CANNOT PLAY. The whole defect above passed
 *  every other check — it had bytes, it had a name, it had a manifest row. The only
 *  thing that distinguishes it is the container, so that is what gets asserted, at the
 *  one moment the bytes are in hand. ID3 tag or an MPEG frame sync (0xFF 0xEx). */
function assertPlayable(id, buf) {
    const id3 = buf.length > 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33;
    const sync = buf.length > 2 && buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0;
    if (!id3 && !sync) {
        throw new Error(`not a playable MP3 (first bytes ${[...buf.slice(0, 4)].map(b => b.toString(16).padStart(2, '0')).join(' ')}) — a browser would refuse it`);
    }
}

const die = (msg) => { console.error(`gen-voice-samples: ${msg}`); process.exit(2); };
if (!existsSync(LINES)) die(`missing ${LINES}`);
if (!existsSync(SOURCES)) die(`missing ${SOURCES}`);

const lines = JSON.parse(readFileSync(LINES, 'utf8'));
const sources = JSON.parse(readFileSync(SOURCES, 'utf8'));

/** Filename for a sample id: stable, lower-case, no characters a URL has to escape. */
const fileFor = (id) => `${id.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.mp3`;

// ── Build the PLAN first. Nothing is rendered until the whole plan is known, so a
//    --dry-run and a real run describe exactly the same set of work.
const plan = [];

for (const p of sources.personalities || []) {
    const text = lines.personalities?.[p.key];
    if (!text) { console.warn(`DROP: gen-voice-samples no line for personality '${p.key}' — skipped`); continue; }
    if (!p.provider || !p.providerVoiceId) { console.warn(`DROP: gen-voice-samples '${p.key}' has no resolved voice — skipped`); continue; }
    plan.push({
        id: `personality:${p.key}`, kind: 'personality',
        provider: p.provider, voiceId: p.providerVoiceId,
        ref: `${p.provider}:${p.voiceKey}`, text,
        note: p.voiceMode === 'preferred'
            ? 'voice_mode=preferred — this demonstrates the default Dashie voice, not a fixed character voice'
            : undefined,
    });
}

const stockLine = lines.stockVoiceLine;
if (stockLine) {
    for (const v of sources.catalogVoices || []) {
        plan.push({ id: `voice:${v.provider}:${v.key}`, kind: 'voice', provider: v.provider,
                    voiceId: v.providerVoiceId, ref: `${v.provider}:${v.key}`, text: stockLine });
    }
    for (const name of geminiVoices()) {
        plan.push({ id: `voice:gemini:${name}`, kind: 'voice', provider: 'gemini',
                    voiceId: name, ref: `gemini:${name}`, text: stockLine });
    }
}

const selected = plan.filter(x => !ONLY || x.provider === ONLY);

// ── Report the plan ──────────────────────────────────────────────────────────
const byProvider = selected.reduce((a, x) => ((a[x.provider] = (a[x.provider] || 0) + 1), a), {});
const chars = selected.reduce((n, x) => n + x.text.length, 0);
console.log('── gen-voice-samples ────────────────────────────────────────────────');
console.log(`  plan: ${selected.length} samples${ONLY ? ` (--only ${ONLY})` : ''} → ${OUT_DIR}`);
for (const [p, n] of Object.entries(byProvider)) console.log(`        ${p.padEnd(12)} ${n}`);
console.log(`  characters to synthesise: ${chars.toLocaleString()} (one-time)`);
console.log(`  record_usage: UNSET — no token_usage row, no credit debit\n`);

if (DRY) {
    for (const x of selected) {
        console.log(`  ${x.id.padEnd(34)} ${x.ref.padEnd(26)} "${x.text.slice(0, 54)}${x.text.length > 54 ? '…' : ''}"`);
        if (x.note) console.log(`  ${''.padEnd(34)} ⚠️  ${x.note}`);
    }
    console.log(`\n✅ DRY RUN — nothing was called, nothing was written, nothing was spent.`);
    console.log(`   Re-run without --dry-run to render. Each sample is rendered ONCE and committed.`);
    process.exit(0);
}

// ── Render ───────────────────────────────────────────────────────────────────
const JWT = process.env.VOICE_BENCH_JWT;
const URL_BASE = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
if (!JWT || !URL_BASE || !ANON) {
    die('need VOICE_BENCH_JWT, SUPABASE_URL and SUPABASE_ANON_KEY in the environment.\n' +
        '  They live in the staging repo: tools/voice-bench/.env (+ tools/voice-bench/config.ts).\n' +
        '  Run with --dry-run to see the plan without them.');
}

mkdirSync(OUT_DIR, { recursive: true });
const manifestPath = join(OUT_DIR, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { version: 1, samples: {} };
manifest.generated = new Date().toISOString().slice(0, 10);
manifest.sourcesReadAt = sources.readAt || null;
manifest.samples = manifest.samples || {};

let made = 0, skipped = 0, failed = 0;
for (const x of selected) {
    const file = fileFor(x.id);
    const abs = join(OUT_DIR, file);
    if (!FORCE && existsSync(abs) && statSync(abs).size > 0) {
        skipped++; manifest.samples[x.id] = { file, ref: x.ref, text: x.text, bytes: statSync(abs).size, ...(x.note ? { note: x.note } : {}) };
        continue;
    }
    const url = `${URL_BASE.replace(/\/$/, '')}/functions/v1/${FN[x.provider]}`;
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${JWT}` },
            // record_usage deliberately absent — see the header.
            body: JSON.stringify({ text: x.text, voice_id: x.voiceId }),
        });
        if (!r.ok) {
            const why = (await r.text().catch(() => '')).slice(0, 200);
            console.log(`  ❌ ${x.id} — HTTP ${r.status} ${why}`);
            failed++; continue;
        }
        const raw = Buffer.from(await r.arrayBuffer());
        if (!raw.length) { console.log(`  ❌ ${x.id} — empty body`); failed++; continue; }
        const buf = toPlayableMp3(x.provider, raw);
        assertPlayable(x.id, buf);
        writeFileSync(abs, buf);
        manifest.samples[x.id] = { file, ref: x.ref, text: x.text, bytes: buf.length, ...(x.note ? { note: x.note } : {}) };
        made++;
        console.log(`  ✅ ${x.id.padEnd(34)} ${(buf.length / 1024).toFixed(1).padStart(6)} KB  ${x.ref}`);
    } catch (e) {
        console.log(`  ❌ ${x.id} — ${e?.message || e}`);
        failed++;
    }
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
const total = Object.values(manifest.samples).reduce((n, s) => n + (s.bytes || 0), 0);
console.log(`\ngen-voice-samples: ${made} rendered, ${skipped} already present, ${failed} failed`);
console.log(`manifest: ${Object.keys(manifest.samples).length} samples, ${(total / 1024 / 1024).toFixed(2)} MB total`);
if (failed) { console.log(`\n⚠️ ${failed} failed — the manifest lists only what EXISTS, so a failed sample simply has no recording and its ▶ says so.`); process.exit(1); }
