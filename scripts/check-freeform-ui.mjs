#!/usr/bin/env node
/**
 * check-freeform-ui — the AI Prompt & Tools surface, EXECUTED.
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 *
 * check-prompt-modes and check-prompt-golden are 88 legs of real value, and not one
 * of them CALLS a click handler. They read the HTML a render function returns. So a
 * handler that throws the moment it runs — a typo'd global, a method that moved, a
 * file loading after the holder it needs — leaves every one of them green.
 *
 * That is not hypothetical in this codebase. The six dead Admin Actions (fixed this
 * same week, console 0.9.42) rendered flawless markup and did nothing when pressed.
 * A string-matching gate passes all six.
 *
 * So this one loads the REAL console — all 83 shipped files, in real index.html
 * order, in one shared global scope — and then presses the buttons:
 * setPromptMode, openPromptEditor, openHouseRules, toggleTool. If any of them
 * throws, this is the gate that says so.
 *
 * ── WHAT IT CANNOT SEE ──────────────────────────────────────────────────────
 *
 * 🔴 NOTHING ABOUT APPEARANCE. The stub document measures nothing, so every width
 * and height reads 0. Overflow, the tools sidebar colliding with the editor, phone
 * width — none of that is visible here, and a green run must never be quoted as
 * "the UI is fine". That half needs real Chrome: tools/freeform-fit/.
 *
 * It also does not reach Home Assistant. Whether HA's Jinja renders a user's
 * template is a live question answered by /api/freeform/render against a real box.
 */
import { loadConsole } from './lib/console-harness.mjs';
import vm from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONSOLE_DIR = `${ROOT}/dashie-ha/frontend/console`;

let pass = 0, fail = 0;
const t = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); } };

const H = loadConsole({ consoleDir: CONSOLE_DIR });
const run = (code) => vm.runInContext(code, H.ctx);

// ── 1 the whole console loads, in order, without throwing ───────────────────
t('1 every shipped console file loads with no error',
  H.loadErrors.length === 0,
  H.loadErrors.map((e) => `${e.file}: ${e.error}`).join(' | '));
// ⚠️ NOT a frozen count. This asserted `=== 83` and went red the moment another
// thread added a <script> tag for an unrelated component — failing a release for a
// reason with nothing to do with what this gate tests. The meaningful claim is
// CONSISTENCY: every tag index.html declares is accounted for, plus a floor so a
// broken parse that finds two files cannot pass.
t('1a every declared script is accounted for (executed + skipped + missing)',
  H.declared === H.files.length + H.skipped.length + H.loadErrors.filter((e) => e.error === 'MISSING ON DISK').length,
  `declared=${H.declared} executed=${H.files.length} skipped=${H.skipped.length}`);
t('1a2 CONTROL: the real console is loaded, not a stub (>=60 files)',
  H.files.length >= 60, `only ${H.files.length} files executed — index.html parsing is wrong`);
t('1b exactly two files are skipped, and they are the expected two',
  H.skipped.length === 2 && H.skipped.some((s) => /supabase-js/.test(s.src))
  && H.skipped.some((s) => /^https:\/\//.test(s.src)),
  JSON.stringify(H.skipped));

// 🔴 CONTROL on the INSTRUMENT (trap 158: does the signal reach me by the same path
// as in production?). Classic scripts share one global LEXICAL environment in a
// browser, so a bare `VoiceAiPage` resolves across files while `window.VoiceAiPage`
// is undefined. If this harness ever regresses to running files one-by-one, that
// sharing silently breaks and these legs would report three healthy files as broken.
t('1c CONTROL: a top-level const resolves as a bare identifier (browser fidelity)',
  run('typeof VoiceAiPage') === 'object' && run('typeof App') === 'object'
  && run('typeof VoiceAiApi') === 'object',
  'the harness is not sharing lexical scope — per-file execution regression');
t('1d CONTROL: ...and it is NOT on window, which is why the above matters',
  run('typeof window.VoiceAiPage') === 'undefined',
  'if this becomes defined the gotcha is gone and 1c stops being load-bearing');

// 🔴 Everything below drives REAL code, so one broken file can cascade — and a gate
// that CRASHES prints no summary line at all. The traps file is explicit that a runner
// must require an ALL PASS token rather than the absence of FAIL, so a crash has to
// arrive as a recorded failure with the summary still printed. Found by fault
// injection: a syntax error in prompt-tool-catalog.js killed this script outright.
try {

// ── 2 prime the page the way a real load does, and record what it saves ─────
run(`
  globalThis.__saved = [];
  globalThis.__renders = 0;
  App.renderPage = function () { globalThis.__renders++; };
  // ⚠️ Toast is a top-level const like App/VoiceAiPage, so it cannot be REASSIGNED
  // (that is a TypeError in the shared lexical scope). Mutate its methods instead.
  Toast.error = function () {}; Toast.success = function () {}; Toast.friendly = function () { return 'x'; };
  VoiceAiApi.saveAiDefault = async function (k, v) { globalThis.__saved.push([k, v]); };
  VoiceAiPage._defaults = Object.assign({}, VoiceAiApi.DEFAULTS);
  VoiceAiPage._accountRaw = Object.assign({}, VoiceAiApi.DEFAULTS);
`);
t('2 the page primed from the real DEFAULTS',
  run('typeof VoiceAiPage._defaults["ai.toolsEnabled"]') === 'string');

const flush = () => new Promise((r) => setImmediate(r));
const saved = () => run('JSON.stringify(globalThis.__saved)');
const reset = () => run('globalThis.__saved = [];');

// ── 3 the handlers RUN — the whole point ───────────────────────────────────
async function press(label, code) {
    reset();
    let threw = null;
    try { run(code); await flush(); await flush(); }
    catch (e) { threw = `${e.name}: ${e.message}`; }
    t(`3 ${label} runs without throwing`, threw === null, threw);
    return JSON.parse(saved());
}

const modeSaves = await press("setPromptMode('freeform')", "VoiceAiPage.setPromptMode('freeform')");
t('3a ...and it persists the mode',
  modeSaves.some(([k, v]) => k === 'ai.promptMode' && v === 'freeform'),
  JSON.stringify(modeSaves));
t('3b ...and seeds the box on the FIRST switch, so it is not blank',
  modeSaves.some(([k, v]) => k === 'ai.freeformPrompt' && String(v).includes('voice assistant')),
  JSON.stringify(modeSaves));

const again = await press("setPromptMode('freeform') a second time", "VoiceAiPage.setPromptMode('freeform')");
t('3c CONTROL: switching to the SAME mode saves nothing (no re-seed over the user\'s prose)',
  again.length === 0, JSON.stringify(again));

await press("setPromptMode('dynamic')", "VoiceAiPage.setPromptMode('dynamic')");
await press('openPromptEditor()', 'VoiceAiPage.openPromptEditor()');
await press('openHouseRules()', 'VoiceAiPage.openHouseRules()');

const offSaves = await press("toggleTool('music', false)", "VoiceAiPage.toggleTool('music', false)");
t('3d ...and the stored list loses exactly that tool',
  (() => { const e = offSaves.find(([k]) => k === 'ai.toolsEnabled'); return !!e && !e[1].split(',').includes('music') && e[1].split(',').includes('calendar'); })(),
  JSON.stringify(offSaves));
const onSaves = await press("toggleTool('music', true)", "VoiceAiPage.toggleTool('music', true)");
t('3e ...and gets it back in CATALOG order, not click order',
  (() => { const e = onSaves.find(([k]) => k === 'ai.toolsEnabled'); return !!e && e[1] === run('PromptToolCatalog.defaultEnabled()'); })(),
  JSON.stringify(onSaves));

// ── 4 free text survives the store, for real this time ─────────────────────
// check-prompt-modes asserts the KEY is in STRING_KEYS by reading the source. This
// drives the actual coercion with a paragraph that would be destroyed by it.
const RULES = 'Never change a thermostat setpoint by more than 2 degrees.\nKids’ rooms are off-limits after 8pm.';
reset();
run(`VoiceAiPage.saveDefault('ai.houseRules', ${JSON.stringify(RULES)});`);
await flush(); await flush();
const rulesSaved = JSON.parse(saved()).find(([k]) => k === 'ai.houseRules');
t('4 a multi-line house-rules paragraph reaches the API intact',
  !!rulesSaved && rulesSaved[1] === RULES,
  `got ${JSON.stringify(rulesSaved && rulesSaved[1])}`);
t('4a ...and is NOT coerced to a boolean',
  !!rulesSaved && typeof rulesSaved[1] === 'string' && rulesSaved[1] !== 'false');
reset();
run("VoiceAiPage.saveDefault('ai.retrievePicturesEnabled', 'true');");
await flush(); await flush();
const boolSaved = JSON.parse(saved()).find(([k]) => k === 'ai.retrievePicturesEnabled');
t('4b CONTROL: a real boolean key IS coerced (so leg 4 can fail)',
  !!boolSaved && boolSaved[1] === true, JSON.stringify(boolSaved));

// ── 5 the rendered section follows the state ───────────────────────────────
function sectionFor(mode) {
    run(`VoiceAiPage._defaults['ai.promptMode'] = '${mode}';`);
    return run(`VoiceAiPromptSection.render({ mode: VoiceAiPage._defaults['ai.promptMode'],
        houseRules: VoiceAiPage._defaults['ai.houseRules'],
        tools: VoiceAiPage._defaults['ai.toolsEnabled'] })`);
}
const dynHtml = sectionFor('dynamic');
const freeHtml = sectionFor('freeform');
t('5 the selected mode card carries the ring in dynamic',
  dynHtml.includes("setPromptMode('dynamic')") && dynHtml.includes('box-shadow: 0 0 0 2px var(--accent)'));
t('5a ...and the ring moves with the mode',
  freeHtml.includes('box-shadow: 0 0 0 2px var(--accent)') && dynHtml !== freeHtml);
t('5b the page renders end-to-end for both modes without throwing',
  (() => {
      for (const m of ['dynamic', 'freeform']) {
          run(`VoiceAiPage._defaults['ai.promptMode'] = '${m}';`);
          try { const h = run('VoiceAiPage.render()'); if (typeof h !== 'string' || h.length < 200) return false; }
          catch { return false; }
      }
      return true;
  })(),
  'VoiceAiPage.render() threw or returned nothing for one of the modes');

// ── 6 the overlays render their own bodies ─────────────────────────────────
// ⚠️ These legs first asserted only `typeof h === 'string'`, which an EMPTY STRING
// satisfies — a leg that cannot fail. They now name content that must be present.
const ffHtml = (() => { try { run('VoiceAiFreeform.open()'); return run('VoiceAiFreeform.render()'); } catch (e) { return `THREW ${e.message}`; } })();
t('6 the Freeform overlay renders a real body', typeof ffHtml === 'string' && ffHtml.length > 400, String(ffHtml).slice(0, 120));
t('6a ...carrying the prompt box and the tools sidebar',
  /textarea/i.test(ffHtml) && ffHtml.includes('Home Assistant'), 'the editor body is missing its two halves');
t('6b ...and the Editable/Raw switch', /Raw/.test(ffHtml) && /Editable/.test(ffHtml));

const hrHtml = (() => { try { run('VoiceAiHouseRules.open()'); return run('VoiceAiHouseRules.render()'); } catch (e) { return `THREW ${e.message}`; } })();
t('6c the House Rules modal renders a real body with a textarea',
  typeof hrHtml === 'string' && hrHtml.length > 200 && /textarea/i.test(hrHtml), String(hrHtml).slice(0, 120));

// ── 7 the Raw view — the headline promise of the whole feature ──────────────
// The user is told Raw is "everything that will be sent". That claim is only worth
// anything if the enabled tools are actually IN it, assembled by the real page.
const rawText = (() => {
    try {
        run("VoiceAiPage._defaults['ai.toolsEnabled'] = PromptToolCatalog.defaultEnabled();");
        run("VoiceAiFreeform.open(); VoiceAiFreeform.setView && VoiceAiFreeform.setView('raw');");
        return run('VoiceAiFreeform._rawText()');
    } catch (e) { return `THREW ${e.message}`; }
})();
t('7 the Raw view assembles without throwing', typeof rawText === 'string' && !/^THREW/.test(rawText), String(rawText).slice(0, 160));
t('7a ...and names an ENABLED tool\'s function', typeof rawText === 'string' && rawText.includes('calendar_events('));
t('7b CONTROL: and NOT a disabled one (a leg that can fail)',
  typeof rawText === 'string' && !rawText.includes('sports('),
  'a tool that is off is reaching the Raw view the user is told is what gets sent');

} catch (e) {
    fail++;
    console.log(`  FAIL  CRASH while driving the real console — ${e.name}: ${e.message}`);
    console.log('        (a cascade from an earlier failure; fix the first FAIL above and re-run)');
}

console.log(`check-freeform-ui: ${pass} pass, ${fail} fail`);
if (!fail) console.log('✅ freeform UI: the console loads in order and every AI Prompt & Tools handler actually runs');
process.exit(fail ? 1 : 0);
