#!/usr/bin/env node
/**
 * check-prompt-modes — AI Prompt & Tools: the stored shape survives, and the
 * two modes agree about the one thing they share.
 *
 * ── THE TRAP THIS EXISTS FOR ────────────────────────────────────────────────
 * VoiceAiPage.saveDefault coerces EVERY key not in its STRING_KEYS list to a
 * boolean (`value = (rawValue === true || rawValue === 'true')`). A house-rules
 * paragraph saved through a key that was never added to that list becomes the
 * boolean `false` — no error, no warning, and the row renders empty next time.
 * Four of the five new keys are free text or enums, so this is not a hypothetical.
 *
 * ── AND THE ONE SHARED STORE ────────────────────────────────────────────────
 * House rules seed the Freeform box on a mode switch (John, 2026-10-04), ONCE,
 * into an empty box. Seeding twice overwrites prose the user wrote; never
 * seeding hands them a blank page after they already said what they wanted.
 * Both failures are silent, so both get a leg.
 */
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const C = `${ROOT}/dashie-ha/frontend/console`;
for (const f of ['js/lib/prompt-tool-catalog.js', 'js/lib/freeform-prompt.js',
    'js/components/voice-ai-prompt-section.js', 'js/pages/voice-ai.js', 'js/lib/voice-ai-api.js']) {
    if (!existsSync(`${C}/${f}`)) { console.log(`BLIND: ${f} not found`); process.exit(2); }
}

let pass = 0, fail = 0;
const t = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); } };

// Load the real holders.
global.window = { BRAND: { productName: 'Dashie', assistantName: 'Dashie' } };
global.BRAND = global.window.BRAND;
require(`${C}/js/lib/prompt-tool-catalog.js`);
require(`${C}/js/lib/freeform-prompt.js`);
require(`${C}/js/components/voice-ai-prompt-section.js`);
const CAT = window.PromptToolCatalog;
const FP = window.FreeformPrompt;
const SEC = window.VoiceAiPromptSection;

const pageSrc = readFileSync(`${C}/js/pages/voice-ai.js`, 'utf8');
const apiSrc = readFileSync(`${C}/js/lib/voice-ai-api.js`, 'utf8');

// ── 1 the coercion trap ─────────────────────────────────────────────────────
const STRING_BLOCK = pageSrc.slice(pageSrc.indexOf('const STRING_KEYS'), pageSrc.indexOf('];', pageSrc.indexOf('const STRING_KEYS')));
for (const k of ['ai.promptMode', 'ai.houseRules', 'ai.freeformPrompt', 'ai.personalityMode', 'ai.toolsEnabled']) {
    t(`1 ${k} is in STRING_KEYS`, STRING_BLOCK.includes(`'${k}'`),
      'saveDefault would store the boolean false for it, silently');
}
t('1a CONTROL: a boolean key is NOT in STRING_KEYS (so leg 1 can fail)',
  !STRING_BLOCK.includes("'ai.retrievePicturesEnabled'"),
  'the STRING_KEYS slice is wrong — it is matching the whole file');

// ── 2 defaults agree with the catalog ───────────────────────────────────────
const defMatch = apiSrc.match(/'ai\.toolsEnabled':\s*'([^']*)'/);
t('2 DEFAULTS ai.toolsEnabled is byte-equal to the catalog default',
  !!defMatch && defMatch[1] === CAT.defaultEnabled(),
  `DEFAULTS=${defMatch && defMatch[1]} catalog=${CAT.defaultEnabled()}`);
for (const k of ['ai.promptMode', 'ai.houseRules', 'ai.freeformPrompt', 'ai.personalityMode']) {
    t(`2a ${k} has a default`, apiSrc.includes(`'${k}':`));
}

// ── 3 the catalog's two states ──────────────────────────────────────────────
t('3 undefined means "never set" and yields the defaults', CAT.parse(undefined).length === 7);
t('3a CONTROL: "" means the user cleared them, and stays cleared',
  CAT.parse('').length === 0, 'an empty list was re-filled from the defaults');
t('3b an unknown id is dropped rather than rendered as a blank row',
  CAT.parse('calendar,not_a_tool').length === 1);
t('3c toggling off then on returns the original stored string',
  CAT.toggled(CAT.toggled(CAT.defaultEnabled(), 'music', false), 'music', true) === CAT.defaultEnabled(),
  'order is click order, not catalog order — the stored value will churn');

// ── 4 the shared store: house rules seed the box ────────────────────────────
const RULES = 'Never change a thermostat setpoint by more than 2 degrees.\nKids rooms off-limits after 8pm.';
t('4 seeding carries the house rules into the box', FP.seed(RULES).includes('off-limits after 8pm'));
t('4a ...and keeps the default three lines above them',
  FP.seed(RULES).startsWith(FP.DEFAULT_TEMPLATE));
t('4b CONTROL: with no rules the box is just the default template',
  FP.seed('') === FP.DEFAULT_TEMPLATE && !FP.seed('').includes('off-limits'));
t('4c setPromptMode seeds ONLY into an empty box',
  /ai\.freeformPrompt'\]\s*\|\|\s*''\)\.trim\(\)\)/.test(pageSrc)
  && pageSrc.includes("this.saveDefault('ai.freeformPrompt', window.FreeformPrompt.seed("),
  'a second switch would overwrite the prompt the user wrote');

// ── 5 raw shows what is actually sent ───────────────────────────────────────
const raw = FP.raw({ catalog: CAT, rendered: 'You are the voice assistant for Lerch Home.', personalityText: 'Embody this character, Captain Dashie.', toolsStored: 'calendar,weather', dateLine: FP.dateLine() });
t('5 raw prints a signature for an ENABLED tool', raw.includes('calendar_events('));
t('5a CONTROL: and none for a disabled one (a leg that can fail)',
  !raw.includes('music('), 'disabled tools are reaching the prompt');
t('5b raw carries the personality text', raw.includes('Captain Dashie'));
t('5c an un-rendered template says so instead of showing raw braces as final',
  FP.raw({ catalog: CAT, rendered: '{{ ha_name }}', pending: true, toolsStored: '' }).startsWith('[not rendered yet'));

// ── 6 the section renders both modes, and only one is selected ──────────────
const dyn = SEC.render({ mode: 'dynamic', houseRules: RULES, tools: CAT.defaultEnabled() });
const free = SEC.render({ mode: 'freeform', houseRules: RULES, tools: CAT.defaultEnabled() });
const card = (html, id) => { const i = html.indexOf(`setPromptMode('${id}')`); return i < 0 ? '' : html.slice(html.lastIndexOf('<div', i), html.indexOf('</div>', i)); };
t('6 both mode cards render', !!card(dyn, 'dynamic') && !!card(dyn, 'freeform'));
t('6a the selected card carries the ring, on its own element',
  card(dyn, 'dynamic').includes('box-shadow: 0 0 0 2px var(--accent)'));
t('6b CONTROL: the unselected one does not', !card(dyn, 'freeform').includes('box-shadow'));
t('6c ...and it flips with the mode', card(free, 'freeform').includes('box-shadow: 0 0 0 2px var(--accent)')
  && !card(free, 'dynamic').includes('box-shadow'));
t('6d house rules are offered in dynamic mode', dyn.includes('Add to prompt'));
t('6e CONTROL: and NOT in freeform, where they are already in the box',
  !free.includes('Add to prompt'), 'two editable copies of the same rules');
t('6f the tools line names the enabled tools', dyn.includes('Family calendar') && dyn.includes('Tools enabled — 7'));
t('6g zero tools reads as a sentence, not an empty row',
  SEC.render({ mode: 'dynamic', houseRules: '', tools: '' }).includes('None —'));

// ── 7 the collapsed summary cannot disagree with the open section ───────────
const sum = SEC.summary({ mode: 'dynamic', houseRules: RULES, tools: CAT.defaultEnabled() }).join(' · ');
t('7 summary names the mode and the tool count', sum.includes('dynamic context') && sum.includes('7 tools'));
t('7a ...and the house-rule count it is showing', sum.includes('2 house rules'));
t('7b CONTROL: freeform drops the house-rule count, as the body does',
  !SEC.summary({ mode: 'freeform', houseRules: RULES, tools: '' }).join(' · ').includes('house rule'));

// ── 8 shipped, and in an order that works ───────────────────────────────────
const html = readFileSync(`${C}/index.html`, 'utf8');
const at = (f) => html.indexOf(f);
for (const f of ['js/lib/prompt-tool-catalog.js', 'js/lib/freeform-prompt.js',
    'js/components/voice-ai-prompt-section.js', 'js/pages/voice-ai-house-rules.js',
    'js/pages/voice-ai-freeform.js']) {
    t(`8 ${f} is loaded by index.html`, at(f) > 0);
}
t('8a the holders load before the surfaces that call them',
  at('js/lib/prompt-tool-catalog.js') < at('js/components/voice-ai-prompt-section.js')
  && at('js/lib/freeform-prompt.js') < at('js/pages/voice-ai-freeform.js')
  && at('js/components/voice-ai-prompt-section.js') < at('js/pages/voice-ai.js'));

// ── 9 the two instructed removals ───────────────────────────────────────────
t('9 the section is titled AI Prompt & Tools', pageSrc.includes("title: 'AI Prompt & Tools'")
  && !pageSrc.includes("title: 'AI Tools & Settings'"));
t('9a "Always use AI for chores" no longer renders',
  !/_toggleRow\('Always use AI for chores'/.test(pageSrc),
  'John asked for it hidden on the HA edition');

// ── 10 the parse()/enabled() return-type confusion, as a CLASS ──────────────
// parse() returns id STRINGS; enabled() returns tool OBJECTS. Reading a tool field
// off a parse() result yields undefined with no error, because undefined is a legal
// Set member and a legal falsy. Four sightings in one lane (the golden gate's
// enabled-ids line, _rawText's hasClock, a test fake, and _toolsCard — where it drew
// 0 of 3 stored toggles checked and INVERTED the control), so assert the shape, not
// the instance.
//
// ⚠️ SCOPE, stated because the first version of this leg overstated it (O, 2026-10-05).
// That matcher was `after.includes('=> t.id') || after.includes('=> tool.id')` — a
// two-identifier ALLOWLIST whose two identifiers were the ones the four past bugs
// happened to use. Measured against eight spellings of the same defect: 2 flagged,
// 6 missed (`=> item.id`, a non-arrow callback, `parse(x)[0].id`, `({ id }) =>`,
// `.filter((row) => row.brain)`, and a two-line form). It FELT like class coverage
// precisely because it caught every known case. The param is now carried by
// backreference so any name works, and the three non-arrow spellings are matched.
// STILL NOT COVERED: a result bound to a variable on one line and misused on another
// (`const arr = parse(x);` … `arr.map((t) => t.id)`). That needs flow analysis; this
// is a single-line matcher and the failure message says so rather than implying reach
// it does not have.
const FIELDS = 'id|label|fn|brain|args|on';
const SHAPES = [
    [new RegExp(`\\(?\\s*([A-Za-z_$][\\w$]*)\\s*\\)?\\s*=>[^;]*?\\b\\1\\s*\\.\\s*(?:${FIELDS})\\b`), 'arrow'],
    [new RegExp(`function\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)[^;]*?\\b\\1\\s*\\.\\s*(?:${FIELDS})\\b`), 'function'],
    [new RegExp(`\\)\\s*\\[\\s*\\d+\\s*\\]\\s*\\.\\s*(?:${FIELDS})\\b`), 'index'],
    [new RegExp(`\\(\\s*\\{[^}]*\\b(?:${FIELDS})\\b[^}]*\\}\\s*\\)\\s*=>`), 'destructured'],
];
/** Scan a directory tree. Returns the FILE COUNT as well as the offenders, because a
 *  loop that read nothing also reports zero offenders — see leg 10a. */
// (?<!JSON\.) — `\bparse\s*\(` also matches `JSON.parse(`, and there are 14 JSON.parse
// sites in this tree. Unguarded, an ordinary `JSON.parse(body).map((t) => t.id)` failed
// with "parse() returns id strings — use enabled()", which is nonsense for a JSON parse
// and sends the reader into the wrong lane. Green today only because no such line is
// currently one-liner shaped. The lookbehind skips JSON.parse while still finding a
// catalog parse LATER on the same line, so the nested
// `C.parse(JSON.parse(s).ids).map((t) => t.id)` still flags. (O, 2026-10-05.)
//
// 🔴 ALL FOUR patterns false-positive on that receiver, not one. We each measured the
// innocent line against only the pattern we were holding (arrow, then arrow+destructured)
// and under-counted the same way. A false positive on one pattern is not a fact about
// THAT pattern — it is a fact about the RECEIVER, which every pattern shares. Fixing
// "the one that fired" would have left three live on lines ordinary in any file. Hence
// leg 10f: when a multi-pattern gate false-positives on a subject, re-test that subject
// against EVERY pattern.
const FINDER = /(?<!JSON\.)\bparse\s*\(/;
const FINDER_UNGUARDED = /\bparse\s*\(/;

/** Which SHAPE a line trips, or null. `finder` is injected so a leg can drive the
 *  UNGUARDED spelling through this exact code rather than a copy of it. */
function classify(line, finder = FINDER) {
    const code = line.trim();
    // Skip comments. The first run of this leg flagged voice-ai-freeform.js:212 — the
    // comment that EXPLAINS the bug by quoting its shape. Correct about the shape, wrong
    // about the defect, and a gate that cannot tell code from prose ABOUT code would
    // penalise writing a trap down, which is the habit the .reference/ trap file depends on.
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return null;
    const at = line.search(finder);
    if (at < 0) return null;
    const after = line.slice(at);
    for (const [re, kind] of SHAPES) if (re.test(after)) return kind;
    return null;
}

function scanTree(dir, finder = FINDER) {
    const files = execSync(`/usr/bin/find ${dir} -name '*.js'`, { encoding: 'utf8' })
        .split('\n').filter(Boolean);
    const offenders = [];
    for (const f of files) {
        readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
            const kind = classify(line, finder);
            if (kind) offenders.push(`${f.replace(`${dir}/`, '')}:${i + 1} (${kind})`);
        });
    }
    return { fileCount: files.length, offenders };
}


const real = scanTree(`${C}/js`);
t('10 no SINGLE LINE reads a tool-OBJECT field off a parse() result',
  real.offenders.length === 0,
  `parse() returns id strings — use enabled(): ${real.offenders.join(', ')}`);

// 10a is the control the first version LACKED. It used to re-implement the match over
// a string literal, which proves a COPY of the logic works and nothing about the
// instrument: if the find+readFileSync loop read nothing, leg 10 reports 0 offenders
// and that control stayed green — the exact vacuous zero it was named after (trap 13).
// It now asserts the loop reached the subject, and 10b feeds a real offender through
// the real scanner.
t('10a CONTROL: the scan actually READ the console tree (not a vacuous zero)',
  real.fileCount >= 20, `scanned ${real.fileCount} files — a zero here makes leg 10 meaningless`);

const FIXTURE = mkdtempSync(join(tmpdir(), 'parse-shape-'));
writeFileSync(join(FIXTURE, 'offenders.js'), [
    "const a = C.parse(x).map((t) => t.id);",
    "const b = C.parse(x).map((item) => item.id);",
    "const c = C.parse(x).map(function (row) { return row.label; });",
    "const d = C.parse(x)[0].brain;",
    "const e = C.parse(x).map(({ id }) => id);",
    "const f = C.parse(x).filter((r) => r.brain);",
].join('\n'));
writeFileSync(join(FIXTURE, 'clean.js'), [
    "const g = C.enabled(x).map((t) => t.id);",   // the CORRECT form
    "const h = C.parse(x).includes('answer');",   // ids used as ids
    "const i = C.parse(x).map((s) => s.trim());", // a legal STRING method
    "// const j = C.parse(x).map((t) => t.id);",  // prose about the bug
].join('\n'));
const fix = scanTree(FIXTURE);
t('10b CONTROL: six real spellings pushed through the REAL scanner are all named',
  fix.offenders.length === 6,
  `named ${fix.offenders.length}/6 — ${fix.offenders.join(', ') || 'none'}`);
t('10c CONTROL: ...and the four correct forms are NOT flagged',
  !fix.offenders.some((o) => o.startsWith('clean.js')),
  `the detector flags correct code: ${fix.offenders.filter((o) => o.startsWith('clean.js')).join(', ')}`);
t('10d CONTROL: all four spelling KINDS fire (not one pattern doing all the work)',
  new Set(fix.offenders.map((o) => o.match(/\((\w+)\)$/)?.[1])).size === 4,
  `kinds seen: ${[...new Set(fix.offenders.map((o) => o.match(/\((\w+)\)$/)?.[1]))].join(',')}`);
// 10e is the half a gate built from true positives always lacks: a LEGITIMATE line that
// merely RESEMBLES the defect. 10b feeds six real spellings and 10c four correct forms,
// but neither feeds an innocent line shaped like the bug — and the resembling receiver is
// JSON.parse, which nearly every file has.
//
// ⚠️ The sharper form, and why this fixture is one line per pattern: the untested half is
// not a LIST of lines, it is the cross-product of innocent receivers × patterns. Six
// spellings through one receiver tests one column; the row was never run. The first
// version of this fixture had three innocent lines that between them tripped only TWO
// distinct patterns (two were `arrow`), so it was testing half the row while reading as
// if it covered it.
const INNOCENT = [
    "const a = JSON.parse(body).map((t) => t.id);",                        // arrow
    "const b = JSON.parse(body).map(({ id }) => id);",                     // destructured
    "const c = JSON.parse(body).map(function (r) { return r.label; });",   // function
    "const d = JSON.parse(body)[0].brain;",                                // index
];
const NESTED = "const e = C.parse(JSON.parse(s).ids).map((t) => t.id);";   // guilty, must flag
writeFileSync(join(FIXTURE, 'nearmiss.js'), [...INNOCENT, NESTED].join('\n'));
const near = scanTree(FIXTURE).offenders.filter((o) => o.startsWith('nearmiss.js'));
t('10e CONTROL: no JSON.parse line is flagged, but a catalog parse NESTED in one is',
  near.length === 1 && near[0].startsWith('nearmiss.js:5'),
  `expected only line 5 (the nested catalog parse) — got ${near.join(', ') || 'none'}`);

// 10f is what keeps 10e from being vacuous, the way 10d keeps 10b honest. 10e would pass
// just as happily on a fixture of lines that could never trip ANY pattern — a clean sheet
// proves nothing about the guard unless the sheet would otherwise be dirty. So drive the
// same four lines through the same classify() with the UNGUARDED finder and require all
// four distinct kinds to fire: that is the measurement that says the guard is load-bearing
// across the whole row, not just the column someone happened to look at.
const wouldFire = INNOCENT.map((l) => classify(l, FINDER_UNGUARDED));
t('10f CONTROL: ...and unguarded, those four lines trip all FOUR patterns',
  new Set(wouldFire).size === 4 && !wouldFire.includes(null),
  `kinds tripped without the guard: ${JSON.stringify(wouldFire)} — a fixture that trips `
  + 'fewer than four leaves a pattern whose false positive nothing would catch');
rmSync(FIXTURE, { recursive: true, force: true });

console.log(`check-prompt-modes: ${pass} pass, ${fail} fail`);
if (!fail) console.log('✅ prompt modes: free text survives the store, and the two modes share one set of house rules');
process.exit(fail ? 1 : 0);
