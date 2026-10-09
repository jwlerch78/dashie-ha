#!/usr/bin/env node
/**
 * check-voice-simple-mode — D8: Simple mode withholds controls, and the page
 * still reports their VALUES.
 *
 * ── WHY THIS IS A GATE ──────────────────────────────────────────────────────
 *
 * John, 2026-10-08: the Voice & AI section is overwhelming; he asked for
 * *"show/hide advanced"*. Hiding controls is easy and the obvious implementation
 * is also the dangerous one:
 *
 *   🔴 SIMPLE MAY HIDE A CONTROL. IT MUST NEVER HIDE A VALUE.
 *
 * A household that pointed speech-to-text at their own Whisper box, seeing a
 * Simple page that neither shows the card nor names the choice, is reading a
 * page that describes a system they are NOT running. That is strictly worse than
 * the busy page Simple exists to fix, and it is silent: nothing errors, nothing
 * logs, and the setting really is still in effect on every tablet.
 *
 * The mechanism that prevents it is one character wide. `_renderAiDefaults`
 * computes `pipelineReal`/`sttReal` (is the pipeline live?) separately from
 * `showPipeline`/`showStt` (do we draw its cards?), and the section summary must
 * read the FORMER. Writing `showPipeline` there — the name that was there before
 * D8, and the one an editor reaches for — hides the card and the value together.
 *
 * ── WHAT EACH LEG IS FOR ────────────────────────────────────────────────────
 *
 * 1–2   the harness reaches the real render, and the two modes genuinely differ.
 *       Without leg 2 every "Simple hides X" leg could pass on a render that
 *       failed to produce X in either mode.
 * 3–5   Simple shows its three controls. The partition is not "hide everything".
 * 6–10  Simple withholds what ADVANCED_ONLY names, asked of the real markup.
 * 11    🔴 THE SAFETY LEG, and it is asked against a NON-DEFAULT world. A leg
 *       that only ever sees preset-implied values would pass on a Simple mode
 *       that hid everything and said nothing, because the default labels appear
 *       in the preset line anyway.
 * 12    Advanced is the superset — every element Simple withholds comes back.
 * 13–15 the partition is a partition, and the mode store refuses what it does
 *       not declare (loudly — the DROP convention).
 * 16    🔴 FAULT INJECTION on the real page source: put `showStt`/`showPipeline`
 *       back in the summary and require leg 11 to BREAK. The mutation count is
 *       asserted first, because a sed that matches nothing reports every leg
 *       green and is indistinguishable from a passing fix (trap 13 — the
 *       positive control cannot rescue a probe that never touched the subject).
 *
 * ⚠️ Blind to: whether Simple LOOKS less busy. This counts elements in markup;
 * it cannot measure that the result reads as calm. The mockup is the record of
 * intent, a browser the only check on the result.
 *
 * Exit 0 = every leg passes, 1 = a violation, 2 = cannot check.
 */
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
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
    `${B}/lib/prompt-tool-catalog.js`,
    `${B}/lib/freeform-prompt.js`,
    `${B}/components/voice-ai-prompt-section.js`,
    `${B}/lib/voice-ai-mode.js`,
    `${B}/pages/voice-ai.js`,
];
const PAGE = `${B}/pages/voice-ai.js`;
for (const f of FILES) {
    if (!existsSync(f)) { console.log(`BLIND: ${f.replace(ROOT + '/', '')} not found`); process.exit(2); }
}

let pass = 0, fail = 0;
const t = (n, ok, d) => {
    if (ok) { pass++; console.log(`  PASS  ${n}`); }
    else { fail++; console.log(`  FAIL  ${n}${d ? '\n          ' + d : ''}`); }
};
const die = (m) => { console.log(`BLIND: ${m}`); process.exit(2); };

/**
 * A fresh world per render. `mutate` rewrites the PAGE SOURCE before it is
 * evaluated — that is how leg 16 injects the pre-D8 summary without the
 * injection leaking into any other leg.
 */
function build({ mutate = null } = {}) {
    const store = {};
    const warnings = [];
    const sandbox = {
        console: { log() {}, warn: (m) => warnings.push(String(m)), error() {}, info() {} },
        sessionStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
        localStorage: { getItem: (k) => store[`ls:${k}`] ?? null, setItem: (k, v) => { store[`ls:${k}`] = String(v); }, removeItem: (k) => { delete store[`ls:${k}`]; } },
        document: { title: '', querySelector: () => null, getElementById: () => null, visibilityState: 'visible', addEventListener() {} },
        DashieAuth: { isAddonMode: true, isLocalMode: false, isHaContext: true, isAuthenticated: true, async dbRequest() { return {}; } },
        FeatureGate: { isAddonMode: () => true, isPageEnabled: () => true, shouldShow: () => true, optionAllowed: () => true, isPublishedBuild: () => true },
        App: { renderPage() {}, navigate() {} },
        Toast: { success() {}, error() {}, info() {}, friendly: (e) => String(e) },
        BRAND: { assistantName: 'Dashie', consoleName: 'Dashie Console', productName: 'Dashie', cloudName: 'Dashie Cloud' },
        VoiceAiApi: { defaultWakeWord: () => 'hey_dashie', listVoices: async () => [], loadAiDefaults: async () => ({}) },
        Card: { render: (o) => `<div class="card">${o?.body || ''}</div>` },
        ConsoleState: { isDismissed: () => false },
        iconImg: () => '',
        fetch: async () => { throw new Error('no network'); },
        setTimeout, clearTimeout, setInterval, clearInterval,
    };
    sandbox.window = sandbox; sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    let mutations = 0;
    for (const f of FILES) {
        let src = readFileSync(f, 'utf8');
        if (f === PAGE && mutate) { const r = mutate(src); src = r.src; mutations = r.count; }
        try { vm.runInContext(src, ctx, { filename: f }); }
        catch (e) { die(`${f.split('/').pop()} did not evaluate: ${e.message}`); }
    }
    const P = vm.runInContext('VoiceAiPage', ctx);
    const M = vm.runInContext('VoiceAiMode', ctx);
    if (!P || typeof P._renderAiDefaults !== 'function') die('_renderAiDefaults did not load');
    if (!M || typeof M.isSimple !== 'function') die('VoiceAiMode did not load');
    return { P, M, ctx, warnings, mutations, sandbox };
}

/**
 * 🔴 A NON-DEFAULT household: their own Whisper box and their own TTS box, under
 * the Hybrid preset. Deliberately NOT the preset-implied pair — leg 11 is only
 * meaningful if the values it looks for could not have arrived by accident.
 */
const SELF_HOSTED = {
    'voice.pipelinePreset': 'hybrid', 'voice.customizePipeline': true,
    'voice.sttProvider': 'local_stt_url', 'voice.ttsProvider': 'local_url',
    'voice.localSttUrl': 'http://192.168.1.50:8000', 'voice.localTtsUrl': 'http://192.168.1.50:8880',
    'voice.localTtsVoiceId': 'af_heart',
    'ai.model': 'gemini-2.5-flash', 'ai.defaultWakeWord': 'hey_jarvis',
    'ai.defaultPersonalityId': 'butler', 'ai.retrievePicturesEnabled': true,
    'ai.webSearchEnabled': true, 'voice.searchSource': 'tavily',
    'voice.agentMode': 'single', 'voice.alwaysUseAI': false,
};

function render(mode, defaults, opts) {
    const w = build(opts);
    w.P._defaults = { ...defaults };
    w.P._engines = []; w.P._templates = [{ key: 'dashie', name: 'Standard' }, { key: 'butler', name: 'Butler' }];
    w.P._custom = []; w.P._expandedCards = new Set(); w.P._savingKey = null;
    w.M._mode = mode;
    // Open both sections, so "Simple withholds X" is about the PARTITION and not
    // about a section happening to start closed (both default closed since 10-07).
    w.ctx && vm.runInContext(`VoiceAiSections._state = { voice: true, tools: true };`, w.ctx);
    let html;
    try { html = w.P._renderAiDefaults(); }
    catch (e) { die(`_renderAiDefaults threw in ${mode}: ${e.message}`); }
    return { html, ...w };
}

const simple = render('simple', SELF_HOSTED);
const adv = render('advanced', SELF_HOSTED);

console.log('check-voice-simple-mode');
t('1 CONTROL: the harness reaches the real render in both modes',
  simple.html.length > 500 && adv.html.length > 500,
  `simple=${simple.html.length} advanced=${adv.html.length} chars`);
t('2 CONTROL: the two modes genuinely produce different pages',
  simple.html !== adv.html && simple.html.length < adv.html.length,
  'Simple renders the same markup as Advanced — the partition is not wired, and every '
  + '"Simple hides X" leg below would be passing on a page that never showed X either');

// ── Simple shows its three controls ────────────────────────────────────────
t('3 Simple shows the preset picker', /VoiceAiPage\.selectPreset\(|tryStarterGrant\(/.test(simple.html),
  'the preset is the one control everything downstream derives from');
t('4 Simple shows AI Model', simple.html.includes('AI Model'));
t('5 Simple shows Personality', simple.html.includes('Personality'));

// ── …and withholds the rest ───────────────────────────────────────────────
t('6 Simple withholds the Wake word card', !simple.html.includes('Wake word'));
t('7 Simple withholds the Speech-to-text and Text-to-speech CARDS',
  !/VoiceAiPage\.toggleCard\('stt'\)/.test(simple.html) && !/VoiceAiPage\.toggleCard\('tts'\)/.test(simple.html),
  'the pipeline cards are the bulk of the page Simple exists to quiet');
t('8 Simple withholds the AI Prompt & Tools section',
  !simple.html.includes('AI Prompt &amp; Tools') && !simple.html.includes('AI Prompt & Tools'));
t('9 Simple withholds Retrieve pictures and Web search source',
  !simple.html.includes('Retrieve pictures') && !simple.html.includes('Web search source'));
t('10 Simple names the way through to Advanced',
  simple.html.includes('follow the preset') && /VoiceAiMode\.set\('advanced'\)/.test(simple.html),
  "a withheld control must not read as a missing one — Simple's footer is what makes it "
  + 'a view rather than a reduced feature set');

// ── 11. THE SAFETY LEG ────────────────────────────────────────────────────
// Asked of a household running their OWN engines, so the labels could not have
// come from the preset line.
const SELF_STT = 'Local Whisper (your box)';
const SELF_TTS = 'Local TTS (your box)';
t(`11 🔴 Simple still NAMES the live engines in the summary ('${SELF_STT}' / '${SELF_TTS}')`,
  simple.html.includes(SELF_STT) && simple.html.includes(SELF_TTS),
  'SIMPLE IS HIDING A VALUE, not just a control. A household running their own Whisper '
  + 'and TTS boxes sees a page that describes neither — it describes a default they are '
  + 'not running. Cause: the section summary read `showStt`/`showPipeline` (the RENDER '
  + 'flags) instead of `sttReal`/`pipelineReal` (the pipeline’s real state).');
t('11b CONTROL: those labels are NOT what this preset would imply by itself',
  !SELF_STT.includes('Home Assistant') && SELF_HOSTED['voice.sttProvider'] === 'local_stt_url'
  && SELF_HOSTED['voice.ttsProvider'] === 'local_url',
  'leg 11 is asserting against preset defaults, so it would pass on a Simple mode that '
  + 'reported nothing at all');

// ── 12. Advanced is the superset ──────────────────────────────────────────
const BACK = ['Wake word', 'Retrieve pictures', 'Web search source'];
const missing = BACK.filter(x => !adv.html.includes(x));
t(`12 Advanced brings back everything Simple withheld (${BACK.length} checked)`,
  missing.length === 0, `still absent in Advanced: ${missing.join(', ')}`);
t('12b Advanced renders the pipeline cards',
  /VoiceAiPage\.toggleCard\('stt'\)/.test(adv.html) && /VoiceAiPage\.toggleCard\('tts'\)/.test(adv.html));
// ⚠️ Matched on the footer's SENTENCE, not on `VoiceAiMode.set('advanced')`. The
// first version used the call, which is also the segmented control's own onclick —
// present in both modes by design — so it failed against correct code and was a
// finding about the matcher.
const FOOTER = 'follow the preset';
t('12c Advanced renders no Simple footer', !adv.html.includes(FOOTER),
  'the "Speech-to-text and text-to-speech follow the preset" line is still shown on the '
  + 'Advanced page, where those controls are right there');

// ── 13–15. the partition, and the store ───────────────────────────────────
const M = simple.M;
const both = (M.SIMPLE_CARDS || []).filter(k => (M.ADVANCED_ONLY || []).includes(k));
t(`13 the partition is a partition (${M.SIMPLE_CARDS?.length} simple, ${M.ADVANCED_ONLY?.length} advanced-only)`,
  Array.isArray(M.SIMPLE_CARDS) && Array.isArray(M.ADVANCED_ONLY)
  && M.SIMPLE_CARDS.length > 0 && M.ADVANCED_ONLY.length > 0 && both.length === 0,
  `declared in BOTH lists: ${both.join(', ')}`);
{
    const w = build();
    t('14 the default mode is SIMPLE on a fresh browser (John’s D8)',
      w.M.get() === 'simple' && w.M.isSimple() === true);
    w.M.set('advanced');
    t('14b a chosen mode persists and reads back', w.M.get() === 'advanced');
    w.M.set('ludicrous');
    t('15 an undeclared mode is REFUSED, loudly, and does not change the mode',
      w.M.get() === 'advanced' && w.warnings.some(m => m.includes('DROP: VoiceAiMode.set')),
      `warnings seen: ${JSON.stringify(w.warnings)}`);
}

// ── 16. FAULT INJECTION on the real page source ───────────────────────────
{
    const mutate = (src) => {
        let count = 0;
        let out = src.replace(/sttReal \? lbl\(/g, () => { count++; return 'showStt ? lbl('; });
        out = out.replace(/pipelineReal \? lbl\(ttsAll/g, () => { count++; return 'showPipeline ? lbl(ttsAll'; });
        return { src: out, count };
    };
    const broken = render('simple', SELF_HOSTED, { mutate });
    // 🔴 ASSERTED FIRST. A mutation that matched nothing renders an unmodified page,
    // leg 16 then "passes" by finding the labels present, and the whole injection is
    // a green reading of an untouched subject.
    t(`16a CONTROL: the injection actually rewrote the summary (${broken.mutations} site(s))`,
      broken.mutations === 2,
      'the summary no longer reads `sttReal ? lbl(` / `pipelineReal ? lbl(ttsAll` — either it '
      + 'was refactored (update this matcher) or the split is gone and leg 11 is unguarded');
    t('16b the pre-D8 summary DOES lose the engine names in Simple',
      !broken.html.includes(SELF_STT) && !broken.html.includes(SELF_TTS),
      'reading the RENDER flags in the summary no longer hides the values, which means leg 11 '
      + 'is not measuring the invariant it claims — an injection that fails to turn a leg red '
      + 'is a finding about the leg, not about the code');
    t('16c CONTROL: the injected page still renders (the mutation is not just a syntax error)',
      broken.html.length > 500 && broken.html.includes('AI Model'),
      `${broken.html.length} chars`);
}

console.log(`\ncheck-voice-simple-mode: ${pass} pass, ${fail} fail`);
if (fail === 0) console.log('ALL PASS');
process.exit(fail ? 1 : 0);
