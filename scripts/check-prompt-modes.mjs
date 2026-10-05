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
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
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

console.log(`check-prompt-modes: ${pass} pass, ${fail} fail`);
if (!fail) console.log('✅ prompt modes: free text survives the store, and the two modes share one set of house rules');
process.exit(fail ? 1 : 0);
