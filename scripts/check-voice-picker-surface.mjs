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
    // HV's, read never written — leg 15 needs the MOUNT, which lives only here.
    serverIndex: join(HERE, '..', 'dashie-ha', 'server', 'index.js'),
    voiceRoutes: join(HERE, '..', 'dashie-ha', 'server', 'voice-routes.js'),
    voiceConsole: join(HERE, '..', 'dashie-ha', 'server', 'api', 'voice-console.js'),
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
    const stt = ids(O.sttOptions(null, 'sherpa_moonshine_base'));
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

// ── LEG 10 — the residual invariant, WIDENED past the one row I first scoped it to ──
//
// Leg 3 pins this exact class for `dashie_cloud`: a row that disappears while it is
// still what the account STORES does not error and does not render empty — it makes
// `VoiceAiCards`' `opts.find(…) || opts[0]` display the FIRST row as selected, a value
// nobody chose. I wrote that gate and scoped it to one row.
//
// The same removal happens to the generic own-AI `local` row on every add-on box with a
// saved engine, and nothing pinned it — so it shipped: John's console read "Qwen3 on
// remote GPU · LOCAL" while `ai.model` was still `local` and the flat keys the tablets
// read were empty (a126). This leg is that scope error corrected.
{
    const catalog = join(CONSOLE, 'js', 'lib', 'ai-models-catalog.js');
    const ENGINE = { id: 'eng-x', url: 'http://box:11434', kind: 'llm', name: 'Qwen3 on remote GPU', model: 'qwen3:30b' };
    const load = (enginesStore) => {
        const sb = {
            console: { log() {}, warn() {}, error() {} },
            document: { title: '', querySelector: () => null },
            DashieAuth: { isAddonMode: true, isLocalMode: false, isHaUser: true, isHaContext: true },
        };
        if (enginesStore) sb.EnginesStore = enginesStore;
        sb.window = sb; sb.globalThis = sb;
        const c = vm.createContext(sb);
        vm.runInContext(readFileSync(FILES.brand, 'utf8'), c, { filename: FILES.brand });
        if (existsSync(catalog)) vm.runInContext(readFileSync(catalog, 'utf8'), c, { filename: catalog });
        vm.runInContext(readFileSync(FILES.options, 'utf8'), c, { filename: FILES.options });
        return sb.window.VoiceAiOptions;
    };
    const O2 = load({ cached: (k) => (k === 'llm' ? [ENGINE] : []) });
    const stored = O2.models(null, 'local');
    // This is voice-ai-cards.js's resolution, verbatim.
    const selected = (rows, id) => rows.find(x => x.id === id) || rows[0];

    check('leg 10a — an account still storing ai.model=local sees its OWN row, not the first engine',
        selected(stored, 'local')?.id === 'local',
        `rows=${JSON.stringify(stored.map(o => o.id).slice(0, 3))} selected=${selected(stored, 'local')?.id}`,
        'without the residual the card displays the first saved ENGINE as selected — a name the account never chose — while ai.model stays `local` and the flat keys the tablets read stay empty. That phantom selection is the root the three-homes divergence grew from (a126)');

    check('leg 10b — and the residual says it is set directly, not from a saved engine',
        /set directly/i.test(String(selected(stored, 'local')?.description || '')),
        `description=${JSON.stringify(selected(stored, 'local')?.description)}`,
        'a residual that reads like a normal offer re-advertises a state the user is being nudged out of; it has to say what it is');

    const notStored = O2.models(null, 'gemini-2.5-flash');
    check('leg 10c — NEGATIVE CONTROL: it is never re-OFFERED to an account on something else',
        !notStored.some(o => o.id === 'local'),
        `ids=${JSON.stringify(notStored.map(o => o.id).slice(0, 4))}`,
        'the residual exists only while it is what the account holds — otherwise this leg would be satisfied by simply never removing the row, which is the behaviour the engines swap deliberately replaced');

    const noEngines = load(null).models(null, 'local');
    check('leg 10d — POSITIVE CONTROL: with no saved engines the REAL own-AI row is still there once',
        noEngines.filter(o => o.id === 'local').length === 1,
        `count=${noEngines.filter(o => o.id === 'local').length}`,
        'pins the web-console path and proves the residual does not double the row when nothing replaced it');
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

// ── LEG 8 — the retired STT model is not offered, and the On-Device labels
//            carry the ruled vocabulary ─────────────────────────────────────
//
// 2026-08-20 ruling: `sherpa_moonshine_tiny` is retired from the offering, and
// the On-Device family is named by PROVENANCE, not quality — "(Open Source)"
// for the bundled sherpa model, "(System)" for the OS engine (Kotlin
// VoiceAiOptions.kt is the naming source; "Fast"/"Accurate"/"Native" are the
// retired vocabulary). John's reconfigure landed on the retired engine BECAUSE
// the console still offered it under the old label and voice-ai.js actively
// preferred it when reseeding hybrid.
// Product decision 2026-08-24: "(System)" renamed to "(Built-in)" on both
// surfaces (Kotlin shipped it in vc185, device-verified; console followed in
// ff5f539). The provenance rule is unchanged — only the OS-engine word moved.
{
    setLocalMode(false);
    const stt = O.sttOptions(null, 'android_voice');
    const tts = O.ttsOptions(null, 'android_voice');
    const sttIds = ids(stt);
    check('leg 8a — sherpa_moonshine_tiny is not OFFERED, and the surviving base row is (positive control)',
        !sttIds.includes('sherpa_moonshine_tiny') && sttIds.includes('sherpa_moonshine_base'),
        `stt=${JSON.stringify(sttIds)}`,
        'the model is retired (2026-08-20) — offering it re-lands users on an engine the product has withdrawn, which is exactly how John\'s reconfigure picked it');
    const label = (rows, id) => rows.find(o => o.id === id)?.label;
    check('leg 8b — On-Device labels use the ruled provenance vocabulary (Open Source / Built-in), both stages',
        label(stt, 'sherpa_moonshine_base') === 'On-Device (Open Source)' &&
        label(stt, 'android_voice') === 'On-Device (Built-in)' &&
        label(tts, 'android_voice') === 'On-Device (Built-in)',
        `stt base=${JSON.stringify(label(stt, 'sherpa_moonshine_base'))} stt android=${JSON.stringify(label(stt, 'android_voice'))} tts android=${JSON.stringify(label(tts, 'android_voice'))}`,
        'one id must not read two ways across surfaces — Kotlin says "(Open Source)"/"(Built-in)" since vc185; a console diverging is the JS↔Kotlin label drift the naming ruling closed');
    check('leg 8c — voice-ai.js no longer references the retired id (the hybrid reseed preferred it)',
        !/sherpa_moonshine_tiny/.test(readFileSync(FILES.page, 'utf8')),
        'voice-ai.js still contains "sherpa_moonshine_tiny"',
        'the reseed at the hybrid branch actively SELECTED tiny first — removing the row without fixing the preference would silently reseed to dashie_cloud instead of the surviving on-device engine');
    const residual = O.sttOptions(null, 'sherpa_moonshine_tiny').find(o => o.id === 'sherpa_moonshine_tiny');
    check('leg 8d — a device that already STORED tiny gets a residual (retired wording, no cost) — and only then',
        !!residual && /retired/i.test(String(residual.label) + String(residual.description)) && residual.cost === '',
        `residual=${JSON.stringify(residual)}`,
        'the card resolves a selection with opts.find(…) || opts[0] — without the residual a tiny-storing device renders a DIFFERENT engine as selected while the device still runs tiny; leg 3\'s lying-card defect, reintroduced for the retired id');
}

// ── LEG 9 — "is this an HA context?" has ONE holder ─────────────────────────
//
// The same decision was hand-written four times and diverged into three
// answers (T s43 cont.15): `_haFilter` and `showEntities` read `isHaUser`
// only, voice-ai-options.js:161 read `isAddonMode || isHaUser` (the correct,
// tolerant form), and the sharing nudge required both. Result: inside the
// add-on — where Home Assistant is definitionally present — the console
// filtered out every HA option for any account whose signup-era flag was
// false. The predicate now lives in ONE place (DashieAuth.isHaContext,
// console-auth.js); this leg keeps the copies from coming back.
{
    const codeShaped = /DashieAuth\??\.isHaUser/;
    const pageSrc = readFileSync(FILES.page, 'utf8');
    const optsSrc = readFileSync(FILES.options, 'utf8');
    const authSrc = readFileSync(join(CONSOLE, 'js', 'lib', 'console-auth.js'), 'utf8');
    check('leg 9a — no page/options site reads DashieAuth.isHaUser directly (isHaContext is the one holder)',
        !codeShaped.test(pageSrc) && !codeShaped.test(optsSrc),
        `voice-ai.js hits=${(pageSrc.match(new RegExp(codeShaped, 'g')) || []).length} voice-ai-options.js hits=${(optsSrc.match(new RegExp(codeShaped, 'g')) || []).length}`,
        'a direct isHaUser read re-creates the diverged copy: it answers "was this account HA-flagged at signup" where the question is "is HA present here" — inside the add-on those answers differ, and every HA option disappears');
    check('leg 9b — DashieAuth defines isHaContext as addon-mode OR the flag',
        /isHaContext/.test(authSrc) && /isAddonMode\s*\|\|\s*this\.isHaUser/.test(authSrc),
        'console-auth.js does not define isHaContext as isAddonMode || isHaUser',
        'without the tolerant definition, leg 9a just forces every site through a helper that repeats the bug');
}

// ── LEG 11 — an edit to the ACTIVE engine must reach the tablets ────────────
//
// engines-store.js's own header says the resolved flat keys (voice.localLlmUrl /
// localLlmModel / localSttUrl / localTtsUrl) are "the ONLY thing the tablets ever
// see". The engine RECORD is console-side bookkeeping the device never reads. So a
// user who fixes the URL of the engine they are ALREADY using has changed nothing
// the device can observe unless something re-pushes the resolved keys.
//
// `LocalEnginesPage._reResolveIfSelected()` is that something, and until this leg it
// was entirely ungated: deleting it, or inverting its is-this-the-active-one guard,
// would leave every tablet calling the OLD endpoint with the console showing the new
// one — display and behaviour disagreeing again, silently, which is the exact shape
// a126 traced and a128 closed on the picker side. `remove()` deliberately does NOT
// re-resolve (its confirm dialog promises devices keep working until you pick
// something else), so this leg is about the EDIT path only.
{
    const src = readFileSync(join(CONSOLE, 'js', 'pages', 'local-engines.js'), 'utf8');

    check('leg 11a — saveDraft re-resolves after writing the engine record',
        /await\s+EnginesStore\.save\([\s\S]{0,400}?_reResolveIfSelected\(/.test(src),
        `saveDraft→_reResolveIfSelected wired=${/_reResolveIfSelected\(/.test(src)}`,
        'without it an edited URL updates the registry the device never reads and never reaches voice.local* — the tablets keep calling the old box while the console shows the new one');

    check('leg 11b — and it pushes through resolveToSettings, not a hand-written key list',
        /_reResolveIfSelected\([\s\S]{0,600}?EnginesStore\.resolveToSettings\(/.test(src),
        `resolveToSettings used inside the re-resolve=${/_reResolveIfSelected\([\s\S]{0,600}?resolveToSettings\(/.test(src)}`,
        'a second hand-written mapping of engine→flat keys is the hand-mirror shape: it would drift from engine-resolution.js, which is itself generated and shared with Kotlin');

    check('leg 11c — ⚖️ NEGATIVE CONTROL: it is guarded on being the ACTIVE engine',
        /_reResolveIfSelected\([\s\S]{0,600}?matchSelected\([\s\S]{0,200}?return;/.test(src),
        `active-guard present=${/matchSelected\(/.test(src)}`,
        'without the guard, editing ANY saved engine would overwrite the flat keys and silently switch the household onto an engine nobody selected — which is worse than the bug this fixes, and would make 11a pass trivially');
}

// ── LEG 12 — EVERY DEFINED ROW IS ASSEMBLED, OR DECLARED UNASSEMBLED ────────
//
// 🔴 WHY THIS LEG EXISTS, and it is not hypothetical: `STT`/`TTS` are the row
// DEFINITIONS; `sttOptions()`/`ttsOptions()` are hand-written assemblies that list
// which of them to show. A row added to the definition and not to the assembly is
// authored-but-unreached — it reviews, diffs, lints and SHIPS, and nothing is
// offered. Found 2026-10-11: `gemini` ("Gemini (your key)", D5, added in 446feec
// "mirroring the Kotlin naming source") is defined and absent from the assembly in
// THREE shipped dev releases up to 0.9.56, while its consumer
// (`engines.js:114-140`, routing on `householdSttProvider() === 'gemini'`) works
// and its own server gate `check-gemini-stt.mjs` passes ~18 legs. The engine was
// gated; the front door was never hung. No gate was looking at the seam between a
// definition and its assembly.
//
// ⚖️ It is a DECLARED list, not an auto-pass: an unassembled row must be named here
// WITH a reason, so "not offered" is always a decision somebody wrote down rather
// than an omission nobody noticed. Removing a row from the assembly without adding
// it here fails this leg. Shrinking this list (wiring a row, or deleting it) is
// always safe; adding to it needs a reason that names who decided.
{
    const UNASSEMBLED = {
        // John has not ruled on "ship Gemini STT in the console now, tablet half next
        // release?" (asked 2026-10-08, still open 10-11). Wiring it would answer his
        // question for him; leaving it undeclared would read as an oversight. So it is
        // declared, and this entry is deleted the moment he says yes.
        gemini: 'awaiting John: console-now vs tablet-next-release (asked 2026-10-08)',
    };

    setLocalMode(false);
    // Every row this household could possibly be shown, across both stages, every
    // preset and both stored-provider states — the union, so a row that only appears
    // as a residual still counts as assembled.
    const seen = new Set();
    for (const stored of ['android_voice', 'dashie_cloud', 'sherpa_moonshine_tiny', '']) {
        for (const id of ids(O.ttsOptions(null, stored))) seen.add(id);
        for (const id of ids(O.sttOptions(null, stored))) seen.add(id);
    }
    const defined = [...O.STT, ...O.TTS].map(o => o.id);
    const missing = [...new Set(defined.filter(id => !seen.has(id)))];
    const undeclared = missing.filter(id => !(id in UNASSEMBLED));
    const staleDeclared = Object.keys(UNASSEMBLED).filter(id => seen.has(id));

    check('leg 12a — every row defined in STT/TTS is assembled into its options list, or declared unassembled with a reason',
        undeclared.length === 0,
        `defined=${defined.length} reachable=${seen.size}\n     unassembled=${JSON.stringify(missing)}\n     UNDECLARED=${JSON.stringify(undeclared)}`,
        'a row in the definition but not in the assembly is authored-but-unreached: it ships and is never offered. `gemini` did exactly that for three dev releases while its server gate stayed green — the engine was gated, the front door was not');

    check('leg 12b — ⚖️ and a declared row that IS now assembled must be removed from the list',
        staleDeclared.length === 0,
        `stale declarations=${JSON.stringify(staleDeclared)}`,
        'a declaration that outlives its reason turns this leg into an auto-pass for that id — the baseline would then hide the next omission of the same row, which is the failure mode of every allowlist nobody shrinks');

    check('leg 12c — ⚖️ POSITIVE CONTROL: the assembly really is observed, not assumed',
        seen.has('dashie_cloud') && seen.has('android_voice') && seen.size >= 5,
        `reachable=${JSON.stringify([...seen].sort())}`,
        'if the union came back empty or tiny, 12a would pass vacuously by having nothing to compare — this is the leg that can fail when the probe itself stops working');
}

// ── LEG 13 — A ROW MUST NOT QUOTE A PRICE FOR A LANE THAT CANNOT SERVE ──────
//
// 🔴 The defect, measured 2026-10-11 on the shipped tree: a signed-in household with a
// Gemini key and no credits stores `dashie_cloud` (seeded by _seedFreshAccountDefaults),
// so the card renders "$0.09–0.33/1k chars" — while `/api/voice/lanes` reports
// rows.dashie_cloud.can_serve:false and serves:'gemini'. Their voice WORKS, on their own
// key, free to us, and we quote a price they are never charged.
//
// ⚖️ This leg is about what a row CLAIMS, never about whether it is offered. Offering is
// the cohort gate (feature-gate.js: credits alpha-only) and stays in the console;
// voice-routes.js's header names wiring offer-iff-can_serve as the hasManagedCloud()
// defect inverted. So nothing here asserts a row is absent.
{
    setLocalMode(false);
    const base = () => ids(O.ttsOptions(null, 'dashie_cloud'));
    const rows = (stored) => O.ttsOptions(null, stored);
    const rowOf = (list, id) => list.find(o => o.id === id) || null;

    // The server's answer for the household in question.
    const KEYED_NO_CREDITS = {
        tts: { serves: 'gemini', rows: {
            dashie_cloud: { can_serve: false, why: 'no_credits' },
            gemini:       { can_serve: true,  why: 'ok' },
            local_url:    { can_serve: null,  why: 'configured_unprobed', url_host: 'box.lan:8880' },
        } },
    };

    const applied = O.applyLanes('tts', rows('dashie_cloud'), KEYED_NO_CREDITS);
    const cloud = rowOf(applied, 'dashie_cloud');

    check('leg 13a — a row the server says CANNOT serve carries no cost string',
        !!cloud && !String(cloud.cost || '').trim(),
        `dashie_cloud.cost=${JSON.stringify(cloud && cloud.cost)}`,
        'this is the live defect: the household is quoted $0.09–0.33/1k chars for a lane the server reports can_serve:false, while their voice actually runs on their own Gemini key for free. A price nobody is charged can make a household decline a feature that costs them nothing');

    check('leg 13b — and it says WHY, from the console copy map (the server ships no copy)',
        !!cloud && String(cloud.description || '').includes(O.LANE_WHY_COPY.no_credits),
        `dashie_cloud.description=${JSON.stringify(cloud && cloud.description)}`,
        'a row stripped of its price with no explanation reads as broken; the reason is the server`s machine `why`, rendered here because voice-routes.js deliberately holds no household copy');

    check('leg 13c — ⚖️ CONTROL: can_serve null (configured, unprobed) is left UNCHANGED',
        JSON.stringify(rowOf(applied, 'local_url')) === JSON.stringify(rowOf(rows('dashie_cloud'), 'local_url')),
        `local_url after=${JSON.stringify(rowOf(applied, 'local_url'))}`,
        'null means the server declined to measure reachability — the console probe path owns it. Rendering it as unavailable would restate a measurement nobody took, and a sleeping box would read as broken');

    check('leg 13d — ⚖️ CONTROL: a row the server does not mention is left UNCHANGED (absent is not a negative)',
        JSON.stringify(rowOf(applied, 'android_voice')) === JSON.stringify(rowOf(rows('dashie_cloud'), 'android_voice')),
        `android_voice after=${JSON.stringify(rowOf(applied, 'android_voice'))}`,
        'device-side engines are not this server`s question; treating silence as "cannot serve" would grey out the one lane that always works');

    check('leg 13e — ⚖️ CONTROL: a null lanes answer is a NO-OP (never flash-disable)',
        JSON.stringify(O.applyLanes('tts', rows('dashie_cloud'), null)) === JSON.stringify(rows('dashie_cloud')),
        'applyLanes(…, null) differs from the input',
        'the standing picker rule: an answer we do not have yet is not a negative answer. A slow or failed fetch must not strip prices or disable rows');

    // 🔴 REAIMED 2026-10-13. This used to assert that `serves:'gemini'` against a stored
    // `dashie_cloud` produced "Running on your Gemini key right now." It must NOT any more:
    // the row was renamed to "Gemini" while the STORED id stayed `dashie_cloud` (John ruled
    // display-only, no migration), so those two ids are now ONE ROW and the lane is not
    // contradicting anything. Who PAYS moved to the key icon (`laneKeyed`).
    // ⚠️ The invariant itself is unchanged and is still asserted — by `operator_url`, a
    // genuinely different engine. Re-aimed at a real mismatch rather than relaxed.
    check('leg 13f — the disclosure names what is ACTUALLY serving when it is not what is selected',
        O.servesDisclosure('tts', 'dashie_cloud', { tts: { serves: 'operator_url', rows: {} } })
            === `Running on ${O.SERVES_LABELS.operator_url} right now.`,
        `disclosure=${JSON.stringify(O.servesDisclosure('tts', 'dashie_cloud', { tts: { serves: 'operator_url', rows: {} } }))}`,
        'without it the household reads a priced row as their voice while something else speaks — the card is the only place that disagreement is visible');

    check('leg 13f2 — ⚖️ the ALIAS is EARNED: dashie_cloud/gemini are one row, so no disclosure',
        O.servesDisclosure('tts', 'dashie_cloud', KEYED_NO_CREDITS) === null
        && O._sameRow('dashie_cloud', 'gemini') === true
        && O._sameRow('dashie_cloud', 'operator_url') === false,
        `disclosure=${JSON.stringify(O.servesDisclosure('tts', 'dashie_cloud', KEYED_NO_CREDITS))} `
        + `sameRow(dc,gemini)=${O._sameRow('dashie_cloud', 'gemini')} sameRow(dc,operator)=${O._sameRow('dashie_cloud', 'operator_url')}`,
        'the suppression must be EARNED by a declared alias, not by the sentence quietly going missing. '
        + 'The second clause is the control: if _sameRow said yes to everything, this leg would still '
        + 'pass on the first clause while the picker had stopped disclosing anything at all');

    check('leg 13g — ⚖️ NEGATIVE CONTROL: no disclosure when serves IS the selected row',
        O.servesDisclosure('tts', 'gemini', KEYED_NO_CREDITS) === null,
        `disclosure=${JSON.stringify(O.servesDisclosure('tts', 'gemini', KEYED_NO_CREDITS))}`,
        'a line that always fires is noise, and would claim a disagreement that does not exist');

    check('leg 13h — ⚖️ and the condition is the SELECTED ROW ID, not a hard-coded dashie_cloud',
        O.servesDisclosure('tts', 'local_url', KEYED_NO_CREDITS) === 'Running on your Gemini key right now.',
        `disclosure for selected=local_url → ${JSON.stringify(O.servesDisclosure('tts', 'local_url', KEYED_NO_CREDITS))}`,
        'keying it to one provider builds a one-case fix wearing a general shape: it would stay silent for the next stored provider that cannot serve');
}

// ── LEG 14 — THE PAGE ACTUALLY REACHES IT ───────────────────────────────────
//
// 🔴 Leg 13 proves the FUNCTION is right. This leg proves the page CALLS it, at every
// site that renders a stage card. Written because of this morning: D5's `gemini` STT row
// was defined, correct, reviewed and shipped in three releases while `sttOptions()` never
// assembled it — and `check-gemini-stt.mjs` stayed green through all three, because it
// gated the engine and nothing gated the front door. A decorator nobody calls is the same
// defect with a different noun.
{
    const page = readFileSync(FILES.page, 'utf8');

    check('leg 14a — the page FETCHES /api/voice/lanes',
        /_fetchLanes\s*\(\)\s*\{[\s\S]{0,400}?\/api\/voice\/lanes/.test(page) && /this\._fetchLanes\(\)/.test(page),
        `_fetchLanes defined=${/_fetchLanes\s*\(\)\s*\{/.test(page)} called=${/this\._fetchLanes\(\)/.test(page)}`,
        'the decorator is a no-op without the answer, so an unfetched lanes payload silently restores the priced row — green legs, defect shipped');

    check('leg 14b — a failed read sets _lanes = null (never flash-disable)',
        /catch[\s\S]{0,220}?this\._lanes\s*=\s*null/.test(page),
        'no catch-sets-null found in _fetchLanes',
        'an answer we do not have yet is not a negative answer: on a failed fetch every row must render exactly as authored, prices included');

    // Every stage-card option chain must pass through applyLanes. Matching the CHAINS, not
    // one site: leg 13 of check-usage-surface passed for a day because it was written
    // against the single site just fixed and missed the second renderer.
    const chains = [...page.matchAll(/this\._applyProbed\(\s*(filtered\('tts'|filtered\('stt'|isLive \? this\._haFilter\(O\.sttOptions)/g)];
    const unwrapped = chains.filter((m) => !/applyLanes\(\s*'(tts|stt)'\s*,\s*$/.test(page.slice(Math.max(0, m.index - 40), m.index)));

    check('leg 14c — EVERY stage-card option chain goes through O.applyLanes (not just the one I fixed)',
        chains.length >= 3 && unwrapped.length === 0,
        `chains found=${chains.length} unwrapped=${unwrapped.length}` +
        (unwrapped.length ? `\n     first unwrapped at ...${page.slice(Math.max(0, unwrapped[0].index - 60), unwrapped[0].index + 40).replace(/\n/g, ' ')}...` : ''),
        'a card rendered without the decorator keeps quoting a price for a lane the server says cannot serve — and it is invisible, because the other cards are correct');

    check('leg 14d — the card helper renders the serves DISCLOSURE',
        /withServesNote\s*=\s*\([\s\S]{0,300}?servesDisclosure\(/.test(page) && /const card = [\s\S]{0,80}?withServesNote\(/.test(page),
        `helper defined=${/withServesNote\s*=/.test(page)} card wraps it=${/const card = [\s\S]{0,80}?withServesNote\(/.test(page)}`,
        'without it a household reads a priced row as their voice while something else speaks; the card is the only surface where that disagreement is visible');
}

// ── LEG 15 — THE MOUNT: the path the page fetches is a path the server SERVES ─
//
// 🔴 THE SEAM BOTH GATES STRADDLE WITHOUT COVERING, and it fails open.
// check-voice-lanes.mjs (HV's) proves the handler is right — but it finds `/lanes` on the
// ROUTER OBJECT (`voiceConsole.stack.find(L => L.route?.path === '/lanes')`), so it never
// reads where that router is mounted. Leg 14a proves the page fetches the literal
// '/api/voice/lanes' — but a string in a fetch call is not a route. So change
// `app.use('/api/voice', voiceConsoleRouter)` in server/index.js and BOTH gates stay green
// on both sides of the join, while every household silently gets the priced row again:
// _fetchLanes() reads a 404, sets _lanes = null, and applyLanes(…, null) is a deliberate
// no-op. Nothing logs a defect, because nothing IS a defect anywhere except in the join.
{
    const serverIndex = readFileSync(FILES.serverIndex, 'utf8');
    const voiceConsole = readFileSync(FILES.voiceConsole, 'utf8');
    const page = readFileSync(FILES.page, 'utf8');

    // Derived, never hard-coded: the whole point is to read the mount rather than assume it.
    const mountOf = (src, routerVar) =>
        (src.match(new RegExp(`app\\.use\\(\\s*'([^']+)'\\s*,\\s*${routerVar}\\s*\\)`)) || [])[1] || null;
    const getPathsOf = (src) => [...src.matchAll(/router\.get\(\s*'([^']+)'/g)].map((m) => m[1]);
    const servedSet = (idxSrc, routerSrc, routerVar) => {
        const mount = mountOf(idxSrc, routerVar);
        if (!mount) return null;
        return new Set(getPathsOf(routerSrc).map((p) => `${mount}${p}`.replace(/\/{2,}/g, '/')));
    };

    const fetched = (page.match(/_fetchLanes\s*\(\)\s*\{[\s\S]{0,400}?_addonUrl\(\s*'([^']+)'/) || [])[1] || null;
    const served = servedSet(serverIndex, voiceConsole, 'voiceConsoleRouter');

    check('leg 15a — the path _fetchLanes() calls is MOUNT + a registered route, read from the server',
        !!fetched && !!served && served.has(fetched),
        `page fetches=${JSON.stringify(fetched)}\n     mount=${JSON.stringify(mountOf(serverIndex, 'voiceConsoleRouter'))}` +
        `\n     served=${served ? JSON.stringify([...served]) : 'COULD NOT PARSE'}`,
        'the fix is conditional on the endpoint answering and fails OPEN by design, so a broken mount is invisible: the console restores the priced row with every leg in every gate still green');

    // ⚖️ The control that makes 15a worth anything: prove the extractor READS the mount
    // instead of hard-coding it. Same idiom as leg 13h.
    //
    // 🔴 The anchor is DERIVED, and the first spelling of this leg was wrong in exactly the
    // way it exists to catch. It rewrote the literal '/api/voice' — hard-coding the constant
    // whose absence it was asserting — so once the mount actually moved, the rewrite matched
    // nothing and the CONTROL went red alongside 15a: two failures for one fault, with the
    // control blaming the subject instead of testing the instrument. Measured by injecting a
    // renamed mount into a scratch copy of the tree; caught because the arms were diffed leg
    // by leg rather than by exit code. Rewriting whatever mount is THERE keeps this a control
    // in both arms.
    const liveMount = mountOf(serverIndex, 'voiceConsoleRouter');
    const movedMount = liveMount
        ? serverIndex.replace(`'${liveMount}', voiceConsoleRouter`, "'/api/zz-moved', voiceConsoleRouter")
        : serverIndex;
    const movedServed = servedSet(movedMount, voiceConsole, 'voiceConsoleRouter');
    check('leg 15b — ⚖️ CONTROL: moving whatever mount is THERE makes 15a fail (the leg reads index.js, not a constant)',
        !!liveMount && movedMount !== serverIndex && !!movedServed && !movedServed.has(fetched),
        `live mount=${JSON.stringify(liveMount)} rewrite applied=${movedMount !== serverIndex}` +
        `\n     moved served=${movedServed ? JSON.stringify([...movedServed]) : 'null'}`,
        'a seam check that cannot fail when the seam moves is a decoration; this is the leg that proves 15a is measuring server/index.js. It must stay green when 15a goes red — a control that fails with its subject has stopped being a control');
}

// ── LEG 16 — S0: ANY STORED VALUE RENDERS AS ITSELF, NEVER AS opts[0] ───────
//
// 🔴 The defect this closes, measured 2026-10-12: stored `gemini` displayed as
// "Dashie Cloud", and `selectOption` → `_selectProvider` writes the provider key
// UNCONDITIONALLY, so one tap on the row that already looked selected moved the
// household off their own key. This file had fixed the same class twice per id
// (`_managedCloudRow`, a hand-written `sherpa_moonshine_tiny` block); leg 16b is the
// one that matters, because it asserts the CLASS rather than the two known ids.
{
    setLocalMode(false);
    const shows = (stage, stored) => {
        const list = stage === 'tts' ? O.ttsOptions(null, stored) : O.sttOptions(null, stored);
        const resolved = list.find(o => o.id === stored) || list[0];   // VoiceAiCards.render's own rule
        return resolved ? resolved.id : null;
    };

    check('leg 16a — a stored id the list does not offer renders as ITSELF (gemini, both stages)',
        shows('stt', 'gemini') === 'gemini' && shows('tts', 'gemini') === 'gemini',
        `stt -> ${shows('stt', 'gemini')}  tts -> ${shows('tts', 'gemini')}`,
        'this is the measured defect: the card named Dashie Cloud while the box ran Gemini, and because _selectProvider writes unconditionally, one tap on that row persisted the wrong engine — TTS onto metered credits, STT onto a lane that 502s');

    check('leg 16b — 🔑 THE CLASS, not the ids: an id this gate invented also renders as itself',
        shows('stt', 'a-row-nobody-has-assembled-yet') === 'a-row-nobody-has-assembled-yet' &&
        shows('tts', 'a-row-nobody-has-assembled-yet') === 'a-row-nobody-has-assembled-yet',
        `stt -> ${shows('stt', 'a-row-nobody-has-assembled-yet')}  tts -> ${shows('tts', 'a-row-nobody-has-assembled-yet')}`,
        'the two per-id fixes that preceded this each left the class open, and leg 12 exists because a defined row went unassembled for three releases. A guard that only covers today\'s ids would be the third instance of the same mistake');

    check('leg 16c — ⚖️ CONTROL: an OFFERED id is untouched, and an empty stored value adds no row',
        shows('stt', 'va_default') === 'va_default' && shows('tts', 'dashie_cloud') === 'dashie_cloud' &&
        !O.sttOptions(null, '').some(o => !o.id) &&
        O.sttOptions(null, '').length === O.sttOptions(null, 'va_default').length,
        `va_default -> ${shows('stt', 'va_default')}  dashie_cloud -> ${shows('tts', 'dashie_cloud')}  ` +
        `empty-list=${O.sttOptions(null, '').length} offered-list=${O.sttOptions(null, 'va_default').length}`,
        'without this, 16a/16b are satisfiable by a builder that appends a residual for EVERY value — which would put a duplicate row under every normal selection and make the legs vacuous');

    // ⚖️ The DROP must name BOTH ids (O's requirement, 2026-10-12): without the pair it
    // cannot tell a row WITHDRAWN by an offering rule from one never ASSEMBLED, and those
    // have different fixes.
    const warnings = [];
    const realWarn = sandbox.console.warn;
    sandbox.console.warn = (...a) => warnings.push(a.join(' '));
    O.sttOptions(null, 'gemini');
    sandbox.console.warn = realWarn;
    const marker = warnings.find(w => w.includes('voice-picker-stored-not-offered'));
    check('leg 16d — the DROP marker names BOTH the stored id and the one that would have displayed',
        !!marker && /stored=gemini/.test(marker) && /would-have-displayed=\w+/.test(marker),
        `markers: ${JSON.stringify(warnings)}`,
        'a bare "selection-mismatch" cannot distinguish a withdrawn row from an unassembled one. The pair is what makes the log actionable rather than just alarming');

    check('leg 16e — the retired tiny model keeps its OWN copy after the per-id block was folded in',
        /retired/i.test(String((O.sttOptions(null, 'sherpa_moonshine_tiny').find(o => o.id === 'sherpa_moonshine_tiny') || {}).description)),
        `description=${JSON.stringify((O.sttOptions(null, 'sherpa_moonshine_tiny').find(o => o.id === 'sherpa_moonshine_tiny') || {}).description)}`,
        'generalising a hand-written residual must not flatten its wording: "this model was retired" tells the household what to do, where a generic residual sentence does not');
}

// ── LEG 17 — the lane REASONS stay discriminating (O's requirement) ─────────
{
    const why = O.LANE_WHY_COPY || {};
    const vals = Object.values(why).map(v => String(v || ''));
    const distinct = new Set(vals).size === vals.length;
    const keyAndCredits = String(why.no_credits || '') !== String(why.no_key || '')
        && /credit/i.test(String(why.no_credits || '')) && /key/i.test(String(why.no_key || ''));
    check('leg 17 — "no credits" and "no key" stay DIFFERENT sentences (never merged into "unavailable")',
        distinct && keyAndCredits && vals.length > 0,
        `no_credits=${JSON.stringify(why.no_credits)}\n     no_key=${JSON.stringify(why.no_key)}\n     all distinct=${distinct}`,
        'they are different instructions to the household — add credits, or add a key. A merged "unavailable" is what makes a row\'s state unexplainable, which is the whole reason offer-on-cohort/disclose-on-lane beats withdrawing the row');
}

// ── LEG 18 — NO RENDERED VENDOR NAME COMES FROM A STORED ID ALONE ───────────
//
// 🔴 O's general leg, 2026-10-12, worth more than three specific ones. The lying-card
// class appeared THREE times in one night, each from a different direction:
//   · a row DEFINED and never assembled (S0 / leg 16)
//   · a row WITHDRAWN by an offering rule (the D2 objection — John: "always show, explain")
//   · a row kept on its OLD precedence (O's catch: stored `dashie_cloud` with an operator
//     `stt_url` is served by the OPERATOR, while D6's copy would say "Audio goes to Google")
// The invariant under all three: **the stored id says what the household CHOSE; the lane
// says what actually HAPPENS; and any vendor claim on screen must come from the lane.**
// A display-normalise that maps a stored id to a vendor name is making a factual claim
// about where a household's audio goes, and it cannot make that claim from the id alone.
{
    // ── 18a: a FLOOR ON THIS LEG'S OWN EXTRACTOR ───────────────────────────
    // 🔴 Written because the obvious extraction was wrong and nearly shipped. Grepping
    // `serves = '<literal>'` finds only `gemini` and `dashie_cloud`: the server assigns
    // `operator_url` / `local_stt_url` through a TERNARY, so a leg built on that grep
    // would have asserted a 2-value namespace against a 5-value one and passed. An
    // extractor that under-reports makes every assertion below vacuous, so it is
    // checked against values known to exist before anything is derived from it.
    const routes = readFileSync(FILES.voiceRoutes, 'utf8');
    const servesBlocks = [...routes.matchAll(/serves\s*=\s*([^;]+);/g)].map(m => m[1]);
    const served = new Set(servesBlocks.flatMap(b => [...b.matchAll(/'([a-z_]+)'/g)].map(m => m[1])));
    const KNOWN_PRESENT = ['gemini', 'operator_url', 'local_stt_url', 'local_url', 'dashie_cloud'];
    const missed = KNOWN_PRESENT.filter(v => !served.has(v));
    check('leg 18a — FLOOR: the extractor finds every `serves` value known to exist (incl. ternary arms)',
        missed.length === 0,
        `extracted=${JSON.stringify([...served])}\n     known-present but NOT extracted=${JSON.stringify(missed)}`,
        'a `serves` extractor that under-reports makes 18b/18c vacuous. The naive grep found 2 of 5 because two arms are in a ternary — this leg exists so that failure is loud instead of a green');

    // ── 18b: every value is LABELLED or DECLARED label-free, with a reason ──
    const labels = O.SERVES_LABELS || {};
    const declaredNone = O.SERVES_LABEL_NONE || {};
    const unexplained = [...served].filter(v => !labels[v] && !declaredNone[v]);
    check('leg 18b — every `serves` value is either LABELLED or DECLARED label-free with a reason',
        unexplained.length === 0,
        `unexplained=${JSON.stringify(unexplained)}\n     labelled=${JSON.stringify(Object.keys(labels).filter(k => labels[k]))}` +
        `\n     declared label-free=${JSON.stringify(Object.keys(declaredNone))}`,
        'a serves value with no label makes servesDisclosure return null, which suppresses the sentence SILENTLY — the card then leaves the row\'s own vendor claim standing unchallenged. "No label" and "nobody got round to it" must not look the same');

    // ── 18c: wherever lane ≠ stored, a sentence naming the ACTUAL engine fires ──
    // 🔴 Iterates EVERY served value, not just the labelled ones — and the first spelling
    // of this leg filtered to `labels[v]`, which made it SELF-WEAKENING: deleting a label
    // deleted that value's own test, so the arm that removed `operator_url`'s label left
    // 18c green while 18b and 18e went red. A leg whose coverage shrinks silently when the
    // subject regresses is the shape this whole entry is about. Measured by injection,
    // 2026-10-12. An unlabelled value is now only acceptable if DECLARED label-free.
    const pairs = [];
    for (const serves of [...served]) {
        for (const selected of ['gemini', 'dashie_cloud', 'va_default', 'local_stt_url']) {
            // Alias pairs are ONE row (dashie_cloud ≡ gemini), so there is no mismatch to
            // disclose. Skipped via the SAME predicate the picker uses — not a second list
            // here that could drift from it, and not a hard-coded pair.
            if (serves === selected || O._sameRow(serves, selected)) continue;
            const note = O.servesDisclosure('stt', selected, { stt: { serves, rows: {} } });
            const ok = labels[serves]
                ? (!!note && note.includes(labels[serves]))     // labelled ⇒ must name it
                : (declaredNone[serves] ? note === null : false); // unlabelled ⇒ must be DECLARED
            pairs.push({ serves, selected, ok, labelled: !!labels[serves] });
        }
    }
    const broken = pairs.filter(p => !p.ok);
    const labelledTested = new Set(pairs.filter(p => p.labelled).map(p => p.serves)).size;
    check('leg 18c — for EVERY lane≠stored pair, a disclosure fires naming what actually serves',
        pairs.length > 0 && broken.length === 0 && labelledTested >= 3,
        `${pairs.length} pair(s); labelled values tested=${labelledTested} (floor 3); failing=${JSON.stringify(broken.slice(0, 4))}`,
        'this is the invariant the whole class reduces to: a household must never read a vendor name the lane contradicts, whichever of the three routes produced the mismatch. The floor of 3 is here because the leg used to test only labelled values, so stripping labels quietly shrank it to nothing');

    check('leg 18d — ⚖️ CONTROL: when the lane AGREES with the stored id, no sentence is produced',
        [...served].filter(v => labels[v]).every(v => O.servesDisclosure('stt', v, { stt: { serves: v, rows: {} } }) === null),
        `agreeing pairs that still disclosed: ${JSON.stringify([...served].filter(v => labels[v] && O.servesDisclosure('stt', v, { stt: { serves: v, rows: {} } }) !== null))}`,
        'without this, 18c is satisfiable by a function that returns a sentence unconditionally — which would put a contradiction notice under every correctly-rendered row');

    // ── 18e: O's EXACT case, as a named regression ─────────────────────────
    const operatorNote = O.servesDisclosure('stt', 'dashie_cloud', { stt: { serves: 'operator_url', rows: {} } });
    check('leg 18e — stored retired `dashie_cloud` + operator stt_url: the card names the OPERATOR, never Google',
        !!operatorNote && operatorNote.includes(labels.operator_url) && !/Google|Gemini/i.test(operatorNote),
        `note=${JSON.stringify(operatorNote)}`,
        'HV keeps the retired id on its OLD precedence on purpose, so an operator Whisper box is not silently moved to Gemini — which means D6\'s "Audio goes to Google" would be SPECIFIC AND FALSE for that household. A vague wrong label is a nuisance; a false privacy claim is not');
}

console.log('');
// ── LEG 20 — NO RATES WITHOUT CREDITS (John, 2026-10-14) ────────────────────
//
// 🔴 *"I don't think we should be showing rates at all unless they are on the credits"*.
// Credits are `alpha-only` for the HA first release, so a quoted rate reaches a cohort that
// is sold nothing. VH's headless walkthrough found 14 model token prices doing exactly that.
//
// ⚠️ THIS LEG LIVES HERE AND NOT IN check-voice-sections, AND THE REASON IS THE WHOLE POINT.
// I wrote it there first — it rendered both cohorts, so it looked like the natural home — and
// it passed. It also passed with the rule REMOVED, and against a mutant whose `_costText`
// ignored the cohort entirely. `_renderAiDefaults()` renders the AI Model card as a LABEL; the
// option rows (and therefore every price) are never in its output. The only currency in that
// harness was the pictures `<option>`, which is not a card and never reaches `_costText`.
// ⇒ The leg was an always-green of exactly the shape traps 239 describes, and adding the real
// model catalog there did not rescue it, because the subject was absent rather than unpriced.
// So it sits where the subject IS: the rows, and the one function that renders their cost.
//
// ⚠️ Tests the STRING for a currency mark, not a list of row ids. An enumeration means the next
// priced row has to be remembered; a currency test makes a new one inherit the rule for free,
// and leaves the non-monetary labels alone — 'Free', 'Your Gemini key', 'Included with Gemini'
// are provenance, not prices, and they are the useful half of that column.
{
    const catalog = join(CONSOLE, 'js', 'lib', 'ai-models-catalog.js');
    const cards = join(CONSOLE, 'js', 'components', 'voice-ai-cards.js');
    /** A context whose `credits` gate is set by the caller. Loads the REAL catalog and cards. */
    const loadCohort = (creditsVisible) => {
        const sb = {
            console: { log() {}, warn() {}, error() {} },
            document: { title: '', querySelector: () => null },
            DashieAuth: { isAddonMode: true, isLocalMode: false },
            FeatureGate: { shouldShow: (f) => (f === 'credits' ? creditsVisible : true) },
        };
        sb.window = sb; sb.globalThis = sb;
        const c = vm.createContext(sb);
        for (const f of [FILES.brand, catalog, FILES.options, cards]) {
            vm.runInContext(readFileSync(f, 'utf8'), c, { filename: f });
        }
        return { O: sb.window.VoiceAiOptions, C: sb.window.VoiceAiCards };
    };
    const MONEY = /[$\u00A2]/;
    const rowsOf = (O) => [
        ...O.models(),
        O.STT.find(o => o.id === 'dashie_cloud'), O.STT.find(o => o.id === 'gemini'),
        O.STT.find(o => o.id === 'android_voice'), O.TTS.find(o => o.id === 'dashie_cloud'),
        O.SEARCH.find(o => o.id === 'dashie'), O.SPORTS.find(o => o.id === 'espn'),
    ].filter(Boolean);
    const priced = ({ O, C }) => rowsOf(O).filter(r => MONEY.test(String(C._costText(r))));
    const kept   = ({ O, C }) => rowsOf(O).map(r => String(C._costText(r))).filter(x => x && !MONEY.test(x));

    const alpha = loadCohort(true);
    const std   = loadCohort(false);

    // FLOOR on the READER: if the rows carried no price to begin with, every assertion below is
    // vacuous — which is precisely how the check-voice-sections version fooled me.
    const alphaPriced = priced(alpha);
    check(`leg 20-pre FLOOR — the rows DO carry prices for a credits cohort (${alphaPriced.length} priced)`,
        alphaPriced.length >= 4,
        `only ${alphaPriced.length} priced rows reached the reader — the catalog or the row set is not loaded, so leg 20 would be measuring nothing`,
        'this is the failure that made the first version of this leg an always-green: absent prices are indistinguishable from suppressed ones');

    const stdPriced = priced(std);
    check('leg 20 — a cohort that cannot see credits is quoted NO rate',
        stdPriced.length === 0,
        `still priced: ${JSON.stringify(stdPriced.map(r => [r.label, r.cost]))}`,
        'a rate reached a household that is sold no credits (John 10-14). The decision lives in VoiceAiCards._costText + VoiceAiOptions.ratesVisible()');

    check('leg 20b — and the NON-monetary cost labels survive (provenance, not price)',
        kept(std).length >= 3 && kept(std).some(x => /Free/.test(x)) && kept(std).some(x => /key/i.test(x)),
        `kept: ${JSON.stringify(kept(std))}`,
        'the suppression took the provenance column with it — "Free" and "Your Gemini key" are what tell a household who serves a lane');

    check('leg 20c — ratesVisible() fails CLOSED with no FeatureGate loaded',
        (() => {
            const sb = { console: { log() {}, warn() {}, error() {} }, document: { title: '', querySelector: () => null },
                         DashieAuth: { isAddonMode: true, isLocalMode: false } };
            sb.window = sb; sb.globalThis = sb;
            const c = vm.createContext(sb);
            for (const f of [FILES.brand, catalog, FILES.options]) vm.runInContext(readFileSync(f, 'utf8'), c, { filename: f });
            return sb.window.VoiceAiOptions.ratesVisible() === false;
        })(),
        'no gate loaded and ratesVisible() said true — a half-loaded console would quote prices to everyone');

    // The margined rate card must not even be FETCHED: models() PREFERS it over the vendor
    // catalog, so a loaded card silently upgrades every row from the vendor's published rate
    // to ours. Suppressing only at the render would leave our numbers one careless read away.
    check('leg 20d — applyLiveRates() is a no-op for a cohort that may not be shown rates',
        (() => {
            let asked = false;
            const sb = { console: { log() {}, warn() {}, error() {} }, document: { title: '', querySelector: () => null },
                         DashieAuth: { isAddonMode: true, isLocalMode: false, dbRequest: async () => { asked = true; return {}; } },
                         FeatureGate: { shouldShow: (f) => f !== 'credits' } };
            sb.window = sb; sb.globalThis = sb;
            const c = vm.createContext(sb);
            for (const f of [FILES.brand, catalog, FILES.options]) vm.runInContext(readFileSync(f, 'utf8'), c, { filename: f });
            sb.window.VoiceAiOptions.applyLiveRates();
            return asked === false;
        })(),
        'get_credit_rates was fetched for a cohort that may not be shown a rate — the margined numbers are then loaded and models() prefers them over the vendor catalog');
}

if (failed) {
    console.error(`❌ ${failed} leg(s) failed`);
    process.exit(1);
}
console.log('✅ all legs pass — the managed row is not offered without an account, a box that holds it is still told the truth, and the id remains valid');
// ── WHAT A GREEN HERE DOES NOT PROVE ────────────────────────────────────────
console.log('ℹ️  floor: green means the BASE OPTION LISTS are right. It does NOT prove:');
console.log('    (a) that the row the household actually SEES is priced honestly. Leg 1 asserts the');
console.log('        row is OFFERED whenever there is an account, and that is deliberate — offering');
console.log('        and can_serve are two questions (server/voice-routes.js header). The price is');
console.log('        stripped later, by applyLanes() against GET /api/voice/lanes; legs 13–14 are');
console.log('        what cover that, NOT this leg. Leg 1 reads the list BEFORE any lane is applied,');
console.log('        so its rows are still priced by construction and a green here says nothing');
console.log('        about the rendered price.');
console.log('    (b) 🔴 that the lane answer ever ARRIVES. applyLanes(…, null) is a deliberate no-op');
console.log('        (never flash-disable a row on a failed fetch), and _fetchLanes() sets null on a');
console.log('        throw, a non-ok response AND whenever !DashieAuth.isAddonMode. So on any box');
console.log('        where /api/voice/lanes does not answer, the household sees the PRICED row —');
console.log('        the pre-fix behavior — and every leg in this file is still green. That is the');
console.log('        fix failing open, which is the right default and an invisible one.');
console.log('    (c) that the rendered page shows these rows at all (the cards apply their own');
console.log('        preset/HA filters, and feature-gate decides the cohort).');
console.log('    (d) anything about whether a selected engine can SERVE a turn — that is the server');
console.log('        gates (check-voice-lanes.mjs), and on a tablet it is TtsRoutePlan.kt, a third');
console.log('        authority this file cannot see.');
