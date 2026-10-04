#!/usr/bin/env node
/**
 * check-prompt-golden — Tier 0 of prompt testing: no model calls, no network,
 * no HA box. Three claims, each about a failure that is silent today.
 *
 * ── 1. THE GOLDEN SNAPSHOT ──────────────────────────────────────────────────
 * The Raw view is sold to the user as "everything that will be sent". Every
 * edit to FreeformPrompt.raw, to PromptToolCatalog, or to a tool's signature
 * changes that text — and a prompt change has no symptom a person would notice
 * while clicking around. It shows up weeks later as the assistant behaving
 * differently, which nobody traces back to a refactor. So the assembled text
 * for a fixed set of configurations is committed, and a diff is the review.
 *
 * A golden that moves is NOT a failure — it is a change that must be LOOKED at.
 * `--update` rewrites it; the diff belongs in the commit.
 *
 * ── 2. DECLARATIONS == ENABLED, EXACTLY ─────────────────────────────────────
 * No snapshot gives you this one, because a snapshot only says the text is what
 * it was. A tool the user switched OFF that still reaches the model is the bug
 * that will actually happen: the toggle writes `ai.toolsEnabled`, the Raw view
 * reads it through `signatures()`, and nothing today asserts those two agree.
 * The user would be told a capability is off while the model keeps being handed
 * it — the "confident non-answer" shape, pointed at a privacy control.
 *
 * ── 3. NO INVENTED TOOLS ────────────────────────────────────────────────────
 * A catalog row is just a label and a function name; writing one costs nothing
 * and asserts that Dashie can do a thing. During the mockups a "Photos and
 * albums" tool was drawn that does not exist. Caught by eye, that time. So every
 * catalog id must either map to a tool the brain actually offers
 * (AVAILABLE_TOOLS_LIST in the brain's own templates.ts, read from this repo's
 * copy) or be declared NEW below with the reason it has no counterpart yet.
 *
 * 🔴 WHAT THIS GATE DOES **NOT** COVER, so nobody reads a green as more than it
 * is: it checks what the CONSOLE assembles and previews. The brain's actual send
 * is Stage 2 and does not exist — `dashie__Answer` is not yet a declaration
 * anywhere. CONTRACTS row 180 is the standing note that these two must meet.
 */
process.env.TZ = 'UTC';   // before the first Date touch — see leg 0.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const C = `${ROOT}/dashie-ha/frontend/console`;
const BRAIN = `${ROOT}/dashie-ha/server/brain/src/voice-conversation/templates.ts`;
const GOLDEN = `${ROOT}/scripts/golden/prompt-modes.golden.txt`;
const UPDATE = process.argv.includes('--update');

for (const f of [`${C}/js/lib/prompt-tool-catalog.js`, `${C}/js/lib/freeform-prompt.js`, BRAIN]) {
    if (!existsSync(f)) { console.log(`BLIND: ${f} not found`); process.exit(2); }
}

let pass = 0, fail = 0;
const t = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); } };

global.window = { BRAND: { productName: 'Dashie', assistantName: 'Dashie' } };
require(`${C}/js/lib/prompt-tool-catalog.js`);
require(`${C}/js/lib/freeform-prompt.js`);
const CAT = window.PromptToolCatalog;
const FP = window.FreeformPrompt;

// ── 0 the instrument itself ─────────────────────────────────────────────────
// 🔴 Trap 13: did the instrument do what it claims to the subject? `dateLine`
// reads LOCAL time (toTimeString/getFullYear/getMonth/getDate), so without a
// pinned zone this gate would produce a different golden in every timezone and
// the diff would be read as a prompt change. If the pin silently failed, every
// text leg below would still pass and only the golden would move — so the pin
// is asserted here, loudly, before anything depends on it.
const FIXED = new Date(Date.UTC(2026, 9, 4, 17, 30, 45));
t('0 the clock is pinned to UTC, so the golden is machine-independent',
  FP.dateLine(FIXED) === 'Current time is 17:30:45. Today\'s date is 2026-10-04.',
  `got "${FP.dateLine(FIXED)}" — TZ pin did not take; the golden is not portable`);

// ── the configurations the golden covers ────────────────────────────────────
const HA_RENDERED = 'You are the voice assistant for Lerch Home.\n'
    + 'Answer questions about the world truthfully.\n'
    + 'Respond simply and to the point in plain text.';
const PERSONA = 'Embody this character, Captain Dashie: a steady ship\'s captain who keeps the house on course.';
const RULES = 'Never change a thermostat setpoint by more than 2 degrees.\nKids’ rooms are off-limits after 8pm.';
const ALL_ON = CAT.TOOLS.map((x) => x.id).join(',');
const THREE_OFF = CAT.toggled(CAT.toggled(CAT.toggled(CAT.defaultEnabled(), 'music', false), 'chores', false), 'answer', false);

const CONFIGS = [
    { name: 'freeform / default template / default tools / no personality',
      args: { rendered: HA_RENDERED, toolsStored: undefined, dateLine: FP.dateLine(FIXED) } },
    { name: 'freeform / default template / default tools / personality on',
      args: { rendered: HA_RENDERED, personalityText: PERSONA, toolsStored: undefined, dateLine: FP.dateLine(FIXED) } },
    { name: 'freeform / three tools off (music, chores, answer)',
      args: { rendered: HA_RENDERED, toolsStored: THREE_OFF, dateLine: FP.dateLine(FIXED) } },
    { name: 'freeform / every tool on',
      args: { rendered: HA_RENDERED, toolsStored: ALL_ON, dateLine: FP.dateLine(FIXED) } },
    { name: 'freeform / every tool off',
      args: { rendered: HA_RENDERED, toolsStored: '', dateLine: FP.dateLine(FIXED) } },
    { name: 'freeform / not yet rendered',
      args: { rendered: 'You are the voice assistant for {{ ha_name }}.', pending: true, toolsStored: undefined, dateLine: FP.dateLine(FIXED) } },
];

// ⚠️ CAT.parse() returns id STRINGS; CAT.enabled() returns the tool OBJECTS. Using
// the wrong one yields `undefined` for every field and no error — this gate's own
// first draft did exactly that and the golden printed `enabled ids: ,,,,,,`.
function declared(stored) {
    const sigs = CAT.signatures(stored);
    if (!sigs) return [];
    return sigs.split('\n').map((l) => l.trim().split('(')[0]).filter(Boolean);
}

function render() {
    const out = [];
    out.push('# prompt-modes golden — regenerate with: node scripts/check-prompt-golden.mjs --update');
    out.push('# Clock pinned to 2026-10-04T17:30:45Z, TZ=UTC. A moving diff here is a prompt change to REVIEW.');
    for (const c of CONFIGS) {
        out.push('', '='.repeat(78), `CONFIG: ${c.name}`, '='.repeat(78));
        out.push(`enabled ids: ${CAT.parse(c.args.toolsStored).join(',') || '(none)'}`);
        out.push(`declarations: ${declared(c.args.toolsStored).join(',') || '(none)'}`);
        out.push('--- raw prompt ' + '-'.repeat(63));
        out.push(FP.raw(c.args));
    }
    out.push('', '='.repeat(78), 'SEED on a dynamic -> freeform switch', '='.repeat(78));
    out.push('--- with no house rules ' + '-'.repeat(54), FP.seed(''));
    out.push('--- with house rules ' + '-'.repeat(57), FP.seed(RULES));
    out.push('', '='.repeat(78), 'DYNAMIC mode: the tool names the brain actually offers', '='.repeat(78));
    out.push(brainTools().join('\n'));
    return out.join('\n') + '\n';
}

// The brain's own list, read as text from this repo's copy of templates.ts. Text
// extraction rather than execution on purpose: it is TypeScript for Deno, and a
// gate that needs a second runtime is a gate that stops being run.
function brainTools() {
    const src = readFileSync(BRAIN, 'utf8');
    const i = src.indexOf('export const AVAILABLE_TOOLS_LIST');
    if (i < 0) return [];
    const block = src.slice(i, src.indexOf('\n`;', i));
    const names = [];
    const first = block.match(/LIST = `- ([a-z_]+):/);
    if (first) names.push(first[1]);
    for (const m of block.matchAll(/^- ([a-z_]+):/gm)) names.push(m[1]);
    return [...new Set(names)].sort();
}

// ── 1 the golden ────────────────────────────────────────────────────────────
const built = render();
if (UPDATE) {
    writeFileSync(GOLDEN, built);
    console.log(`golden updated: ${GOLDEN} (${built.split('\n').length} lines)`);
    console.log('⚠️  the diff is the review — read it before committing.');
    process.exit(0);
}
if (!existsSync(GOLDEN)) {
    console.log(`BLIND: no golden at ${GOLDEN}. Create it: node scripts/check-prompt-golden.mjs --update`);
    process.exit(2);
}
const committed = readFileSync(GOLDEN, 'utf8');
if (built === committed) {
    pass++; console.log('  PASS  1 every assembled prompt is byte-identical to the committed golden');
} else {
    fail++;
    const a = committed.split('\n'), b = built.split('\n');
    console.log('  FAIL  1 the assembled prompt moved. First differing lines:');
    for (let i = 0, shown = 0; i < Math.max(a.length, b.length) && shown < 6; i++) {
        if (a[i] !== b[i]) { console.log(`          L${i + 1} golden: ${JSON.stringify(a[i])}`); console.log(`          L${i + 1}  built: ${JSON.stringify(b[i])}`); shown++; }
    }
    console.log('        If this change is intended: node scripts/check-prompt-golden.mjs --update');
}
t('1a CONTROL: the golden is not empty and names a config (so leg 1 can fail)',
  committed.includes('CONFIG: freeform') && committed.length > 500,
  'a truncated golden would make leg 1 pass against nothing');

// ── 2 declarations == enabled, exactly ──────────────────────────────────────
for (const stored of [undefined, '', ALL_ON, THREE_OFF, 'calendar', 'calendar,weather,music']) {
    const want = CAT.enabled(stored).map((x) => x.fn);
    const got = declared(stored);
    const label = stored === undefined ? '(defaults)' : stored === '' ? '(empty)' : stored.length > 28 ? stored.slice(0, 28) + '…' : stored;
    t(`2 declarations == enabled for ${label}`,
      got.length === want.length && got.every((f, i) => f === want[i]),
      `enabled=[${want}] declared=[${got}]`);
    t(`2a ...and no duplicate declaration for ${label}`, new Set(got).size === got.length);
}
t('2b CONTROL: a tool switched off is absent from the declarations',
  !declared(THREE_OFF).includes('dashie__ControlMusic')
  && declared(CAT.defaultEnabled()).includes('dashie__ControlMusic'),
  'signatures() ignores the enabled list — every tool reaches the model');
t('2c CONTROL: an unknown id contributes no declaration',
  declared('calendar,photos_and_albums').length === 1,
  'a fabricated id renders a signature the brain cannot serve');
t('2d every enabled tool also reaches the raw prompt body',
  (() => { const raw = FP.raw({ rendered: 'x', toolsStored: ALL_ON }); return CAT.enabled(ALL_ON).every((x) => raw.includes(`${x.fn}(`)); })(),
  'raw() drops a declaration the sidebar says is on');

// ── 3 no invented tools ─────────────────────────────────────────────────────
// Every catalog id maps to a tool the brain offers, or is declared new HERE —
// deliberately in the gate and not in the catalog, so adding a row fails until
// somebody states which brain tool serves it.
const MAPS_TO = {
    home_assistant: 'home_assistant',
    calendar: 'calendar_events',
    calendar_write: 'calendar_write',
    weather: 'weather_data',
    chores: 'chores',
    locations: 'family_locations',
    music: 'music',
    video_feeds: 'video_feeds',
    sports: 'sports',
    schedule: 'schedule_action',
    web_search: 'web_search',
};
const NEW_IN_FREEFORM = {
    live_context: 'HA\'s GetLiveContext shape. The brain has no counterpart: it inlines live '
        + 'state into the prompt instead of offering a tool. Freeform needs the tool form '
        + 'because the user\'s template is first and nothing structural follows it.',
    answer: 'The response envelope (Stage 2). Declared as a function because function calling, '
        + 'structured output and Google grounding are mutually exclusive in one Gemini call '
        + '(measured 2026-10-03), so it cannot ride on responseSchema beside the tools.',
};
const BRAIN_TOOLS = brainTools();
t('3 the brain tool list was actually read (not an empty set)',
  BRAIN_TOOLS.length >= 15 && BRAIN_TOOLS.includes('home_assistant'),
  `read ${BRAIN_TOOLS.length} names — the extraction matched nothing useful`);
for (const tool of CAT.TOOLS) {
    const mapped = MAPS_TO[tool.id];
    if (mapped) {
        t(`3a ${tool.id} -> brain ${mapped}`, BRAIN_TOOLS.includes(mapped),
          `the brain offers no "${mapped}". Catalog claims a capability that is not served`);
    } else {
        t(`3b ${tool.id} is declared NEW with a reason`, !!NEW_IN_FREEFORM[tool.id],
          'neither mapped to a brain tool nor declared new — an invented capability');
    }
}
t('3c CONTROL: a name the brain does not offer is detected',
  !BRAIN_TOOLS.includes('photos_and_albums'),
  'the brain-tool set is matching everything — leg 3a cannot fail');
for (const id of Object.keys(MAPS_TO).concat(Object.keys(NEW_IN_FREEFORM))) {
    t(`3d ${id} is still a real catalog id`, !!CAT.byId(id),
      'a stale mapping for a tool that was removed — the table is drifting');
}

console.log(`check-prompt-golden: ${pass} pass, ${fail} fail`);
if (!fail) console.log('✅ prompt golden: the assembled prompt is pinned, declarations match the enabled set, and no catalog tool is invented');
process.exit(fail ? 1 : 0);
