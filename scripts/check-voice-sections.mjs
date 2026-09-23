#!/usr/bin/env node
/**
 * check-voice-sections — the Voice & AI Settings tab's two groups must actually
 * render, and the section list must agree with what the page draws.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 *
 * That tab rendered FIFTEEN elements in one 760px column, eleven of them
 * conditional (preset x Customize x agent mode x HA reachable). John, 2026-09-22:
 * *"I think it's probably too busy as is."* It now groups into Voice & LLM and
 * AI Tools & Settings, each collapsing to a summary line.
 *
 * The regrouping introduced a JOIN between two hand-maintained lists:
 * `VoiceAiSections._DEFAULT_OPEN` (which sections exist) and the ids the page
 * passes to `S.render({ id })`. A join like that is exactly what left four device
 * card tiles dead — nothing was broken in either file, which is why nothing caught
 * it. So this gate is DRIVEN: it evaluates the real modules and calls the real
 * `_renderAiDefaults()`, rather than reading the source and hoping.
 *
 * It also pins the things John specified by eye and would notice regressing: two
 * across rather than three, the pickers that belong in each section, and an
 * expanded card taking the whole row instead of squeezing into one column.
 *
 * ⚠️ What this gate is BLIND to: it proves the markup is produced, not that it
 * LOOKS right. Nothing here measures rendered width, overlap or truncation — a
 * value that overflows its column passes every leg. The mockups are the record of
 * intent; a browser is the only thing that can check the result.
 *
 * 🔴 Leg 15 is DIFFERENTIAL for a reason worth keeping. Its first version asserted
 * that `grid-column: 1 / -1` appears when a card is expanded — which is true
 * whether or not the expanded card spans, because the full-width notes block in
 * the same grid emits it too. It passed its own fault injection and proved
 * nothing. It now counts spans closed vs open and requires the number to rise.
 *
 * Exit 0 = every leg passes, 1 = a violation, 2 = cannot check.
 */
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const B = `${ROOT}/dashie-ha/frontend/console/js`;
const FILES = [
  `${B}/lib/voice-ai-options.js`,
  `${B}/components/voice-ai-cards.js`,
  `${B}/components/voice-ai-preset-picker.js`,
  `${B}/components/voice-ai-defaults-cards.js`,
  `${B}/components/voice-ai-sections.js`,
  `${B}/pages/voice-ai.js`,
];
const store = {};
const sandbox = {
  console: { log(){}, warn(){}, error(){}, info(){} },
  sessionStorage: { getItem: (k) => store[k] ?? null, setItem: (k,v) => { store[k]=String(v); }, removeItem: (k) => { delete store[k]; } },
  localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
  document: { title:'', querySelector: () => null, getElementById: () => null, visibilityState: 'visible', addEventListener(){} },
  DashieAuth: { isAddonMode: true, isLocalMode: false, isHaContext: true, isAuthenticated: true, async dbRequest(){ return {}; } },
  FeatureGate: { isAddonMode: () => true, isPageEnabled: () => true, shouldShow: () => true, optionAllowed: () => true, isPublishedBuild: () => true },
  App: { renderPage(){}, navigate(){} },
  Toast: { success(){}, error(){}, info(){}, friendly: (e)=>String(e) },
  BRAND: { assistantName: 'Dashie', consoleName: 'Dashie Console' },
  VoiceAiApi: { defaultWakeWord: () => 'hey_dashie', listVoices: async () => [], loadAiDefaults: async () => ({}) },
  Card: { render: (o) => `<div class="card">${o?.body||''}</div>` },
  ConsoleState: { isDismissed: () => false },
  iconImg: () => '',
  fetch: async () => { throw new Error('no network'); },
  setTimeout, clearTimeout, setInterval, clearInterval,
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
for (const f of FILES) {
  try { vm.runInContext(readFileSync(f,'utf8'), ctx, { filename: f }); }
  catch (e) { console.log(`BLIND: ${f.split('/').pop()} did not evaluate: ${e.message}`); process.exit(2); }
}
const P = vm.runInContext('VoiceAiPage', ctx);
const S = vm.runInContext('VoiceAiSections', ctx);
if (!P || typeof P._renderAiDefaults !== 'function') { console.log('BLIND: _renderAiDefaults did not load'); process.exit(2); }
if (!S || typeof S.render !== 'function') { console.log('BLIND: VoiceAiSections did not load'); process.exit(2); }

// Minimal page state — enough for the render path to run.
P._defaults = {
  'voice.pipelinePreset': 'cloud', 'voice.customizePipeline': true,
  'voice.sttProvider': 'dashie_cloud', 'voice.ttsProvider': 'dashie_cloud',
  'ai.model': 'gemini-2.5-flash', 'ai.defaultWakeWord': 'hey_dashie',
  'ai.defaultPersonalityId': 'dashie', 'ai.retrievePicturesEnabled': true,
  'ai.webSearchEnabled': true, 'voice.searchSource': 'google',
  'voice.agentMode': 'single', 'voice.alwaysUseAI': false,
};
P._engines = []; P._templates = [{ key:'dashie', name:'Standard' }]; P._custom = [];
P._expandedCards = new Set(); P._savingKey = null;

let pass=0, fail=0;
const t=(n,c,d)=>{ if(c){pass++;console.log(`  PASS  ${n}`);} else {fail++;console.log(`  FAIL  ${n}${d?' — '+d:''}`);} };

let html;
try { html = P._renderAiDefaults(); }
catch (e) { console.log(`BLIND: _renderAiDefaults threw: ${e.message}`); process.exit(2); }

t('1 renders something at all', typeof html === 'string' && html.length > 500, `${html?.length} chars`);
t('2 section "Voice & LLM" is present', html.includes('Voice &amp; LLM') || html.includes('Voice & LLM'));
t('3 section "AI Tools & Settings" is present', html.includes('AI Tools &amp; Settings') || html.includes('AI Tools & Settings'));
t('4 both sections are collapsible buttons', (html.match(/VoiceAiSections\.toggle\(/g)||[]).length === 2,
  `${(html.match(/VoiceAiSections\.toggle\(/g)||[]).length} toggles`);
t('5 the two-across grid is used', html.includes('repeat(2, minmax(0, 1fr))'));
t('6 Voice & LLM defaults OPEN (the one people come to change)', S.isOpen('voice') === true);
t('7 AI Tools defaults CLOSED', S.isOpen('tools') === false);
t('8 a closed section renders no body', !html.includes('Always use AI for chores'));
// the five section-1 pickers
for (const [n,lab] of [['AI Model','AI Model'],['Wake word','Wake word'],['Personality','Default personality'],['STT','Speech-to-text'],['TTS','Text-to-speech']])
  t(`9 section 1 carries ${n}`, html.includes(lab), lab);
// search + entities must NOT be in section 1 any more
t('10 Web search source left section 1', !html.slice(0, html.indexOf('AI Tools')).includes('Web search source'));

// Open tools and re-render
S.toggle('tools');
const html2 = P._renderAiDefaults();
t('11 opening Tools reveals its toggles', html2.includes('Always use AI for chores'));
t('12 Web search source is in section 2', html2.includes('Web search source'));
t('13 Retrieve pictures is in section 2', html2.includes('Retrieve pictures'));
t('14 summary names the preset when collapsed', /Cloud/i.test(html2));

// An expanded card must span both columns.
// 🔴 DIFFERENTIAL, not a substring test. The full-width notes block inside the
// same grid ALSO emits `grid-column: 1 / -1`, so "the string is present" is true
// whether or not the expanded card spans — the first version of this leg passed
// its own mutation (removing S.full() from gridCard) and proved nothing. Count
// the spans with nothing expanded, then with one card open: it must go UP.
const spans = (h) => (h.match(/grid-column: 1 \/ -1/g) || []).length;
P._expandedCards = new Set();
const spansClosed = spans(P._renderAiDefaults());
P._expandedCards = new Set(['model']);
const html3 = P._renderAiDefaults();
t('15 an expanded card adds a full-row span', spans(html3) === spansClosed + 1,
  `closed ${spansClosed}, expanded ${spans(html3)}`);
t('15b the expanded card really did expand', html3.includes('Choose AI Model'));
P._expandedCards = new Set();

// Compact form: the 170px label must be gone from the gridded rows
t('16 gridded rows drop the 170px label reservation', !/min-width: 170px/.test(html2.slice(html2.indexOf('repeat(2, minmax(0, 1fr)'), html2.indexOf('repeat(2, minmax(0, 1fr)')+4000)));

// HA Assist hides section 2 entirely (HA owns the conversation agent)
P._defaults['voice.pipelinePreset'] = 'ha_assist';
const html4 = P._renderAiDefaults();
t('17 HA Assist renders no AI Tools section', !html4.includes('AI Tools'));
P._defaults['voice.pipelinePreset'] = 'cloud';

// POSITIVE CONTROLS
t('18 control — an unknown section id is refused, loudly', (() => {
  let warned = false;
  const prev = sandbox.console.warn;
  sandbox.console.warn = (m) => { if (String(m).includes('DROP:')) warned = true; };
  S.toggle('nope');
  sandbox.console.warn = prev;
  return warned;
})());
t('19 control — the harness reaches the real render', html2.includes('VoiceAiSections.toggle'));

console.log(`check-voice-sections: ${pass} pass, ${fail} fail`);
if (fail) { console.error(`\ncheck-voice-sections FAILED (${fail} leg(s))`); process.exit(1); }
console.log('check-voice-sections ALL PASS');
