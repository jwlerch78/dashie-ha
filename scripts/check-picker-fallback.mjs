#!/usr/bin/env node
/**
 * check-picker-fallback — every device-settings <select> must survive a value
 * it does not offer.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * An <option> is marked `selected` only when it string-matches the stored
 * value. A <select> in which NOTHING matched displays its FIRST option. So a
 * device holding a value the console's hand-written option list does not
 * contain is rendered as some OTHER setting entirely — no error, no warning,
 * nothing to click.
 *
 * John, 2026-09-22: the Samsung's screensaver read one thing in the console
 * while the database and the tablet agreed on another. The console was reading
 * the database correctly the whole time (list_devices does `select('*')`); it
 * simply could not show what it read. `screensaver.mode` had gained ha_page /
 * url / app on the device and this console's list still had five values.
 *
 * Worse in the voice pickers, whose first option is the `''` INHERIT sentinel:
 * an off-list value there reads as "Account default", reporting the wrong
 * RELATIONSHIP to the account rather than merely the wrong value.
 *
 * These lists are hand-copies of Kotlin's and drift by construction, and this
 * repo is public — it cannot read the Android tree to diff them. So the
 * invariant is not "the lists agree" (uncheckable here) but "an off-list value
 * is VISIBLE instead of silently becoming a different setting", which is
 * checkable and is what actually failed.
 *
 * ── SCOPE, STATED HONESTLY ───────────────────────────────────────────────────
 * The device-settings surface only — the two files below. The console has ~34
 * `selected`-ternary option sites in total; the other ~22 (voice-ai, usage,
 * preferences, …) are NOT covered and have the same latent defect. Widening
 * this is a separate change, not something to assume from a green run.
 *
 * Three outcomes: PASS / FAIL / BLIND. BLIND when the helpers or the <select>
 * regions cannot be resolved — a gate that cannot find its subject must not
 * report on it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = `${ROOT}/dashie-ha/frontend/console/js/pages`;

const FILES = [
    { path: `${BASE}/devices-detail.js`,        guard: '_optionsHtml' },
    { path: `${BASE}/devices-detail-modals.js`, guard: '_offListOption' },
];

const problems = [];
const blind = [];
let selectsChecked = 0;

/** Both helpers must exist AND actually do the thing, or we are blind. */
function checkHelper(src, name, file) {
    const at = src.indexOf(`    ${name}(`);
    if (at < 0) { blind.push(`${file}: helper ${name}() not found`); return; }
    const body = src.slice(at, at + 2000);
    if (!body.includes('selected>')) {
        problems.push(`${file}: ${name}() no longer emits a selected option for an off-list value`);
    }
    if (!body.includes('DROP:')) {
        problems.push(`${file}: ${name}() no longer logs a DROP: marker when a value is off-list`);
    }
}

for (const { path, guard } of FILES) {
    if (!existsSync(path)) { blind.push(`missing file: ${path}`); continue; }
    const raw = readFileSync(path, 'utf8');
    const short = path.replace(`${ROOT}/`, '');

    checkHelper(raw, guard, short);

    // Blank out comments before scanning for markup. These files DOCUMENT this
    // very defect in prose — devices-detail-modals.js:1525 contains the words
    // "<select> would silently snap to the first option" — and a gate that
    // scores its own rationale reports BLIND on a file that is fine. Newlines
    // are preserved so reported line numbers stay true.
    const src = raw
        .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
        .replace(/^[ \t]*\/\/.*$/gm, (c) => ' '.repeat(c.length))
        .replace(/^[ \t]*\*.*$/gm, (c) => ' '.repeat(c.length));

    // Every <select> … </select> region must reach a guard, either directly or
    // through an `optionsHtml` variable that is itself built by one.
    const optionsHtmlGuarded = [...src.matchAll(/const\s+optionsHtml\s*=\s*([^;]+);/g)]
        .every((m) => /_optionsHtml\(|_offListOption\(/.test(m[1]));

    const re = /<select\b/g;
    let m;
    while ((m = re.exec(src))) {
        const end = src.indexOf('</select>', m.index);
        if (end < 0) { blind.push(`${short}: unterminated <select> at offset ${m.index}`); continue; }
        const region = src.slice(m.index, end);
        const line = src.slice(0, m.index).split('\n').length;
        selectsChecked++;
        const direct = region.includes('_offListOption(') || region.includes('_optionsHtml(');
        const viaVar = region.includes('${optionsHtml}') && optionsHtmlGuarded;
        if (direct || viaVar) continue;
        // A <select> with no options at all in the region is a template we
        // cannot resolve — blind, not pass.
        if (!/<option|\$\{/.test(region)) {
            blind.push(`${short}:${line}: <select> with no resolvable option source`);
            continue;
        }
        problems.push(`${short}:${line}: <select> builds options without an off-list guard — a value `
            + `the device holds but this list does not offer will silently render as the first option`);
    }
}

if (selectsChecked === 0) blind.push('no <select> regions found — the subject was never reached');

console.log(`check-picker-fallback: ${selectsChecked} <select> regions across ${FILES.length} files`);
for (const b of blind) console.log(`  BLIND: ${b}`);
for (const p of problems) console.log(`  FAIL:  ${p}`);

if (blind.length || problems.length) {
    console.error(`\ncheck-picker-fallback FAILED (${problems.length} problem(s), ${blind.length} blind)`);
    process.exit(1);
}
console.log('check-picker-fallback ALL PASS');
