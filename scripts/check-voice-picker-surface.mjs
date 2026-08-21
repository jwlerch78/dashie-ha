#!/usr/bin/env node
/**
 * check-voice-picker-surface — the managed cloud STT/TTS row is not OFFERED on a
 * box that has no account to bill it to, and a box that already stored it is
 * still told the truth about what it is running.
 *
 * John, 2026-08-04, on the managed cloud row in this edition: *"not here anymore
 * in this model."* Console-audit #4 is the same defect from the other side — the
 * pipeline reading "Cloud" on a box with no account and no keys.
 *
 * ── THE ONE THAT MATTERS MOST IS LEG 3 ───────────────────────────────────────
 *
 * `VoiceAiCards.render()` resolves a selection with `opts.find(…) || opts[0]`.
 * So simply deleting the row from a box that has `dashie_cloud` STORED does not
 * produce an error or an empty card — it produces a card that says a DIFFERENT
 * engine is selected while the stored value, and the device, still say cloud.
 * Nothing logs, nothing looks wrong, and the console is now lying about which
 * engine the household is using. The residual row exists for exactly that, and
 * this is the leg that would catch its removal by someone tidying up.
 *
 * Exit 0 = every leg passes, 1 = a violation, 2 = cannot check.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSOLE = join(HERE, '..', 'dashie-ha', 'frontend', 'console');
const FILES = {
    brand: join(CONSOLE, 'js', 'lib', 'brand.js'),
    options: join(CONSOLE, 'js', 'lib', 'voice-ai-options.js'),
    page: join(CONSOLE, 'js', 'pages', 'voice-ai.js'),
    gate: join(CONSOLE, 'js', 'lib', 'feature-gate.js'),
    index: join(CONSOLE, 'index.html'),
    app: join(CONSOLE, 'js', 'app.js'),
};
for (const [name, f] of Object.entries(FILES)) {
    if (!existsSync(f)) {
        console.error(`check-voice-picker-surface: cannot check — ${name} not found at ${f}`);
        process.exit(2);
    }
}

// ── Load the real option builder ─────────────────────────────────────────────
const sandbox = {
    console,
    document: { title: '', querySelector: () => null },
    DashieAuth: { isLocalMode: false, isAddonMode: true },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
try {
    vm.runInContext(readFileSync(FILES.brand, 'utf8'), ctx, { filename: FILES.brand });
    vm.runInContext(readFileSync(FILES.options, 'utf8'), ctx, { filename: FILES.options });
} catch (e) {
    console.error(`check-voice-picker-surface: cannot check — module did not evaluate: ${e.message}`);
    process.exit(2);
}
const O = sandbox.window.VoiceAiOptions;
if (!O || typeof O.ttsOptions !== 'function') {
    console.error('check-voice-picker-surface: cannot check — VoiceAiOptions did not load');
    process.exit(2);
}

let failed = 0;
function check(name, ok, detail, why) {
    if (ok) { console.log(`✅ ${name}`); return; }
    console.error(`❌ ${name}\n     ${detail}\n     why it matters: ${why}`);
    failed++;
}
const ids = (list) => list.map(o => o.id);
const setLocalMode = (v) => { sandbox.DashieAuth.isLocalMode = v; };

// ── LEG 1 — POSITIVE CONTROL: with an account, the row is offered ────────────
{
    setLocalMode(false);
    const tts = ids(O.ttsOptions(null, 'android_voice'));
    const stt = ids(O.sttOptions(null, 'android_voice'));
    check('leg 1 — POSITIVE CONTROL: an account-bearing console still offers the managed cloud row',
        tts.includes('dashie_cloud') && stt.includes('dashie_cloud'),
        `tts=${JSON.stringify(tts)}\n     stt=${JSON.stringify(stt)}`,
        'the family build and the web console are account products; removing the row there would delete a working paid option, and without this leg legs 2–3 would pass on a builder that always drops it');
}

// ── LEG 2 — account-less: never OFFERED ─────────────────────────────────────
{
    setLocalMode(true);
    const tts = ids(O.ttsOptions(null, 'android_voice'));
    const stt = ids(O.sttOptions(null, 'sherpa_moonshine_tiny'));
    check('leg 2 — an account-less box is not offered a row it has no account to pay for',
        !tts.includes('dashie_cloud') && !stt.includes('dashie_cloud'),
        `tts=${JSON.stringify(tts)}\n     stt=${JSON.stringify(stt)}`,
        'offering it names a service the box cannot buy — audit #4, and the reason the row reads as configured on a box with no keys at all');
}

// ── LEG 3 — account-less WITH it stored: the residual keeps the card honest ──
{
    setLocalMode(true);
    const tts = O.ttsOptions(null, 'dashie_cloud');
    const stt = O.sttOptions(null, 'dashie_cloud');
    const ttsRow = tts.find(o => o.id === 'dashie_cloud');
    const sttRow = stt.find(o => o.id === 'dashie_cloud');
    check('leg 3a — a box that already STORED the managed row still sees it (residual)',
        !!ttsRow && !!sttRow,
        `tts has it=${!!ttsRow} stt has it=${!!sttRow}`,
        'VoiceAiCards resolves a selection with `opts.find(…) || opts[0]` — without the residual, the card silently displays a DIFFERENT engine as selected while the stored value and the device still say cloud. No error, no log, and the console is lying about what is running');
    check('leg 3b — and the residual says it is not available, with no cost quoted',
        !!ttsRow && /not available/i.test(String(ttsRow.description)) && ttsRow.cost === '',
        `description=${JSON.stringify(ttsRow?.description)} cost=${JSON.stringify(ttsRow?.cost)}`,
        'a residual that looks like a normal offer is worse than no residual: it re-advertises the thing being withdrawn, and a per-character price for a service this box cannot buy is a quote for nothing');
    check('leg 3c — the residual survives presetFilter(\'cloud\') — the exact state John saw',
        ids(O.presetFilter('cloud', tts)).includes('dashie_cloud'),
        `preset-filtered cloud rows: ${JSON.stringify(ids(O.presetFilter('cloud', tts)))}`,
        'the cloud preset keeps only locality:cloud rows; if the residual were dropped there the card would render EMPTY on the one box configuration this change is about');
    setLocalMode(false);
}

// ── LEG 4 — the id stays a valid persisted wire value ───────────────────────
{
    const declared = [...O.TTS, ...O.STT].filter(o => o.id === 'dashie_cloud').length;
    check('leg 4 — `dashie_cloud` is still DECLARED in both base tables (the id is not retired)',
        declared === 2,
        `found ${declared} declaration(s); expected 2 (one TTS, one STT)`,
        'the id is a persisted wire value shared with the device and the backend (brand.js:14-17). Dropping the ROW is a display decision; retiring the ID would invalidate every box that already chose it, including one that later signs in and should find its choice intact');
}

// ── LEG 5 — every RENDERING call site passes the stored value ───────────────
//
// 🔴 The reachability half. A site that builds a stage list for display without
// the current id gets a list with no residual, and the selection resolves to
// opts[0] — the leg-3 failure, reintroduced at one call site out of five, in a
// file with 1,500 lines. Sites that only look up `ha_engine` are exempt BY
// PATTERN, not by line number.
{
    const src = readFileSync(FILES.page, 'utf8');
    const calls = [...src.matchAll(/\b(?:tts|stt)Options\(this\._engines([^)]*)\)([\s\S]{0,40})/g)];
    if (calls.length < 5) {
        console.error(`❌ leg 5 — found ${calls.length} option-builder call(s) in voice-ai.js; expected at least 5. The pattern cannot see the property.`);
        failed++;
    } else {
        const bare = calls.filter(m => !m[1].trim() && !/\.find\(\s*o\s*=>\s*o\.id === 'ha_engine'\s*\)/.test(m[2]));
        check(`leg 5 — every option-builder call that feeds a picker passes the stored id (${calls.length} call sites checked)`,
            bare.length === 0,
            `${bare.length} bare call(s) not followed by an ha_engine lookup`,
            'a bare call builds a list with no residual; the card then shows opts[0] as selected while the box runs something else — leg 3 all over again, at one site out of five');
    }
}

// ── LEG 6 — the unmounted onboarding page is GONE, and gone everywhere ──────
//
// Deleting a file is easy; leaving a <script> tag pointing at it, or a whitelist
// entry implying it exists, is what makes a deletion look like a mistake to the
// next reader — and a 404 script tag is silent in every browser.
{
    const page = join(CONSOLE, 'js', 'pages', 'onboarding.js');
    const html = readFileSync(FILES.index, 'utf8');
    const gate = readFileSync(FILES.gate, 'utf8');
    const app = readFileSync(FILES.app, 'utf8');
    // Comment lines stripped: the property is "'onboarding' is not a MEMBER of
    // the set", and the set's body is mostly prose explaining why each entry is
    // or is not there — including, now, a paragraph about this very removal.
    // Matching the raw slice made that paragraph fail the leg, which is the
    // check testing its own documentation rather than the code.
    const gateSet = gate
        .slice(gate.indexOf('LOCAL_MODE_PAGES'), gate.indexOf('LOCAL_MODE_PAGES') + 2500)
        .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    const results = {
        file: !existsSync(page),
        script: !/pages\/onboarding\.js/.test(html),
        whitelist: !/'onboarding'/.test(gateSet),
        pages: !/OnboardingPage/.test(app),
    };
    check('leg 6 — the onboarding page is deleted: no file, no <script>, no LOCAL_MODE_PAGES entry, no App.PAGES reference',
        Object.values(results).every(Boolean),
        JSON.stringify(results),
        'a <script> tag for a deleted file 404s silently in every browser, and a whitelist entry for a page that does not exist reads as "this is reachable" to the next person — which is precisely how this page survived unmounted for three days');
}

// ── LEG 7 — the own-AI (local) MODEL row survives models() ───────────────────
//
// `models()` builds the own-AI row first ("My Local LLM leads the list"), then
// runs it through `withSavedEngines`, which REPLACES that inline row with the
// saved engine rows. But withSavedEngines early-returns `options` UNCHANGED
// when `!isAddonMode || !EnginesStore` — i.e. it returns the very array it was
// handed. models() then does `out.length = 0; out.push(...withEngines)`, so on
// that path it empties the array and pushes from the array it just emptied, and
// the own-AI row disappears.
//
// 🔴 Consequence: on the WEBSITE console there is no local/self-hosted brain
// option at all — the entire Local group is absent from the AI Model picker.
// Silent: no error, no empty card, just cloud-only choices, which reads as
// "Dashie doesn't do local" rather than as a bug.
//
// These legs run in their OWN vm contexts because they need the real model
// catalog loaded; the shared sandbox above deliberately has neither it nor an
// EnginesStore, which is exactly why every leg above stayed green while this
// defect shipped.
{
    const catalog = join(CONSOLE, 'js', 'lib', 'ai-models-catalog.js');
    const loadWith = (auth, enginesStore) => {
        const sb = {
            console: { log() {}, warn() {}, error() {} },
            document: { title: '', querySelector: () => null },
            DashieAuth: auth,
        };
        if (enginesStore) sb.EnginesStore = enginesStore;
        sb.window = sb; sb.globalThis = sb;
        const c = vm.createContext(sb);
        vm.runInContext(readFileSync(FILES.brand, 'utf8'), c, { filename: FILES.brand });
        if (existsSync(catalog)) vm.runInContext(readFileSync(catalog, 'utf8'), c, { filename: catalog });
        vm.runInContext(readFileSync(FILES.options, 'utf8'), c, { filename: FILES.options });
        return sb.window.VoiceAiOptions;
    };
    const ownAi = (rows) => rows.some(m => m.id === 'local' || m.group === 'Local');
    const cloudCount = (rows) => rows.filter(m => m.locality === 'cloud').length;

    const web = loadWith({ isAddonMode: false, isLocalMode: false }, null).models();
    check('leg 7a — the WEB console offers an own-AI (local / self-hosted) model row',
        ownAi(web),
        `model ids = ${JSON.stringify(web.map(m => m.id))}`,
        'withSavedEngines early-returns the SAME array models() then clears, so the own-AI row is pushed from an emptied array and vanishes. A website user cannot select a local or self-hosted brain at all, and nothing reports it');

    const addonNoStore = loadWith({ isAddonMode: true, isLocalMode: false }, null).models();
    check('leg 7b — so does the add-on console before EnginesStore has loaded',
        ownAi(addonNoStore),
        `model ids = ${JSON.stringify(addonNoStore.map(m => m.id))}`,
        'same aliasing, reached by the other half of the early-return condition — a first-paint race would drop the row inside the add-on too');

    const addonWithStore = loadWith({ isAddonMode: true, isLocalMode: false }, { cached: () => [] }).models();
    check('leg 7c — POSITIVE CONTROL: with EnginesStore present the row is there, and cloud rows load in every shape',
        ownAi(addonWithStore) && cloudCount(web) > 0 && cloudCount(addonWithStore) > 0,
        `withStore ownAi=${ownAi(addonWithStore)} cloud(web)=${cloudCount(web)} cloud(withStore)=${cloudCount(addonWithStore)}`,
        'without this, 7a/7b are satisfiable by a models() that returns nothing at all — "row missing" would be indistinguishable from "builder broken". It also pins the ONE shape that already worked, so the fix must not regress it');
}

console.log('');
if (failed) {
    console.error(`❌ ${failed} leg(s) failed`);
    process.exit(1);
}
console.log('✅ all legs pass — the managed row is not offered without an account, a box that holds it is still told the truth, and the id remains valid');
