#!/usr/bin/env node
/**
 * check-duplicate-keys.mjs — a method declared TWICE in one object literal.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `voice-ai-freeform.js` declared `render()` twice: once as `async render()` (ask
 * Home Assistant to render the Jinja template) and again as `render()` (return the
 * modal's HTML). **A duplicate key in an object literal is not a syntax error.** The
 * last one silently wins, so the async method did not exist at runtime and every
 * caller reached the HTML renderer instead — which returns a string and performs no
 * fetch.
 *
 * It surfaced as THREE unrelated-looking bugs, reported separately by John on
 * 2026-10-13: the Render button did nothing; Editable↔Raw would not switch; and the
 * view changed only when some other control forced a repaint. One cause, three
 * symptoms, no error anywhere — the console stayed silent because nothing was wrong
 * as far as JavaScript was concerned.
 *
 * ⇒ The class is worth a gate rather than a remembered rule: it is invisible at
 * author time, invisible at load time, and presents as a behaviour bug somewhere else.
 *
 * ── WHAT IT CHECKS, AND WHAT IT DELIBERATELY DOES NOT ───────────────────────
 *
 * Only files whose whole body is ONE top-level `const X = {` singleton — which is the
 * console's dominant shape. In those, every 4-space-indented `name(` / `name:` belongs
 * to that one object, so a repeat is a genuine duplicate. Files with several object
 * literals are SKIPPED rather than guessed at: a false positive on a correct file
 * gets a gate routed around, and a routed-around gate is worse than none.
 *
 * 🔴 Comments are stripped first. In this codebase live files deliberately document
 * the broken version beside the fixed one, so a prose-blind matcher reports the
 * better-documented file as the broken one.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = join(ROOT, 'dashie-ha/frontend/console/js');

const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** Duplicate 4-space keys in a single-singleton file. [] for anything else. */
export function duplicateKeys(raw) {
    if ((raw.match(/^const \w+ = \{$/gm) || []).length !== 1) return [];
    const seen = new Map();
    for (const m of strip(raw).matchAll(/^ {4}(?:async )?([A-Za-z_$][\w$]*)\s*[(:]/gm)) {
        seen.set(m[1], (seen.get(m[1]) || 0) + 1);
    }
    return [...seen].filter(([, n]) => n > 1).map(([k, n]) => `${k} ×${n}`);
}

const walk = (d) => readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
});

let fail = 0;
let scanned = 0;
const findings = [];

if (!existsSync(BASE)) {
    console.error(`check-duplicate-keys: console js not found at ${BASE} — update this gate if it moved.`);
    process.exit(1);
}

for (const f of walk(BASE)) {
    const raw = readFileSync(f, 'utf8');
    if ((raw.match(/^const \w+ = \{$/gm) || []).length !== 1) continue;
    scanned++;
    const dups = duplicateKeys(raw);
    if (dups.length) { findings.push(`  ✗ ${f.slice(ROOT.length + 1)} — ${dups.join(', ')}`); fail++; }
}

// ⚖️ POSITIVE CONTROL, asserted BEFORE the result is believed. A scan that silently
// stopped matching would report "0 duplicates" over every file — the most convincing
// possible non-answer, and indistinguishable from a clean tree.
const FIXTURE = ['const Thing = {', '    render() { return 1; },', '    other: 2,', '    render() { return 2; },', '};'].join('\n');
const controlDups = duplicateKeys(FIXTURE);
if (controlDups.length !== 1 || !controlDups[0].startsWith('render')) {
    console.error('check-duplicate-keys: 🔴 CONTROL FAILED — the matcher does not detect a known '
        + `duplicate in its own fixture (got ${JSON.stringify(controlDups)}). Every "0 duplicates" `
        + 'below is meaningless until this passes.');
    process.exit(1);
}

if (fail) {
    console.log(`check-duplicate-keys: ${fail} file(s) declare a key twice in one object literal\n`
        + findings.join('\n')
        + '\n\n  The LAST declaration silently wins — the earlier one does not exist at runtime.\n'
        + '  Rename one, and keep the name that outside callers use.');
} else {
    console.log(`check-duplicate-keys: ${scanned} single-singleton file(s), 0 duplicates (control: OK)`);
    console.log('FLOOR — a green here does NOT prove:');
    console.log('  • anything about files with SEVERAL object literals; those are skipped, not checked');
    console.log('  • anything about nested objects, classes, or keys at other indents');
    console.log('  • that the surviving method is the RIGHT one — only that there is one of it');
    console.log('ALL PASS');
}
process.exit(fail ? 1 : 0);
