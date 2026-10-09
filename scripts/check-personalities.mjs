#!/usr/bin/env node
/**
 * check-personalities — the account-less personality roster, and the voice
 * degradation model that must never take a whole personality down with it.
 *
 * ── WHAT WENT WRONG, AND WHAT WOULD HIDE IT ──────────────────────────────────
 *
 * The console showed NO personalities on an account-less box. Not a bug in the
 * page: it asked `list_personality_templates`, an account-backed call, of a box
 * with no account. The tempting fix — a `try/catch` returning `[]` — renders an
 * empty list *correctly and permanently*. Every leg below exists because its
 * failure mode looks like a normal, working console:
 *
 *   • an empty roster reads as "this household has none"
 *   • a degraded voice that removed the PERSONALITY reads as "that one isn't
 *     available", when the persona and its prompt were never affected
 *   • "(voice not available)" persisted reads as truth forever, including after
 *     the key that would fix it arrives
 *   • a template key renamed silently unsets the personality for any household
 *     that chose it — `ai.defaultPersonalityId` stores the key
 *
 * Exit 0 = every leg passes, 1 = a violation, 2 = cannot check.
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ADDON = join(HERE, '..', 'dashie-ha');
const CONSOLE = join(ADDON, 'frontend', 'console');
const FILES = {
    templates: join(ADDON, 'server', 'personality-templates.js'),
    router: join(ADDON, 'server', 'api', 'voice-console.js'),
    brand: join(CONSOLE, 'js', 'lib', 'brand.js'),
    manifest: join(CONSOLE, 'js', 'lib', 'provider-manifest.js'),
    availability: join(CONSOLE, 'js', 'lib', 'provider-availability.js'),
    // Loaded so LEG 8 exercises the REAL local-engine predicate rather than a
    // stub of it: the 'ha-tts-engine' detector asks HaEngines.haOption('tts'),
    // which runs VoiceAiOptions._piperOption. A stub here would test the gate.
    options: join(CONSOLE, 'js', 'lib', 'voice-ai-options.js'),
    engines: join(CONSOLE, 'js', 'lib', 'ha-engines.js'),
    api: join(CONSOLE, 'js', 'lib', 'voice-ai-api.js'),
    editor: join(CONSOLE, 'js', 'pages', 'voice-ai-personality-edit.js'),
    page: join(CONSOLE, 'js', 'pages', 'voice-ai.js'),
    // Loaded lazily inside LEG 10 (it is pure data and nothing before it needs it),
    // but declared here so a missing file exits 2 BLIND rather than failing a leg as
    // if the map were wrong.
    icons: join(CONSOLE, 'js', 'lib', 'personality-icons.js'),
};
for (const [name, f] of Object.entries(FILES)) {
    if (!existsSync(f)) {
        console.error(`check-personalities: cannot check — ${name} not found at ${f}`);
        process.exit(2);
    }
}

const require_ = createRequire(import.meta.url);
let T;
try {
    T = require_(FILES.templates);
} catch (e) {
    console.error(`check-personalities: cannot check — personality-templates.js did not load: ${e.message}`);
    process.exit(2);
}

// Load the console libs (manifest + the availability join) into one scope.
const sandbox = { console, document: { title: '', querySelector: () => null },
    DashieAuth: { isAddonMode: true, isLocalMode: false, _addonUrl: (p) => p },
    fetch: async () => { throw new Error('check-personalities: no network'); } };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
try {
    for (const k of ['brand', 'manifest', 'options', 'engines', 'availability']) {
        vm.runInContext(readFileSync(FILES[k], 'utf8'), ctx, { filename: FILES[k] });
    }
} catch (e) {
    console.error(`check-personalities: cannot check — console lib did not evaluate: ${e.message}`);
    process.exit(2);
}
const A = sandbox.window.ProviderAvailability;
if (!A) {
    console.error('check-personalities: cannot check — ProviderAvailability did not load');
    process.exit(2);
}

let failed = 0;
function check(name, ok, detail, why) {
    if (ok) { console.log(`✅ ${name}`); return; }
    console.error(`❌ ${name}\n     ${detail}\n     why it matters: ${why}`);
    failed++;
}

// ── LEG 1 — the roster exists, is complete, and is not empty ────────────────
{
    const list = T.listTemplates();
    const keys = list.map(t => t.key);
    const wanted = ['dashie', 'princess', 'butler'];
    const missing = wanted.filter(k => !keys.includes(k));
    check(`leg 1a — the V1 roster ships (${keys.length} template(s): ${keys.join(', ')})`,
        list.length >= 3 && missing.length === 0,
        `missing: ${missing.join(', ') || '(none)'} — got ${JSON.stringify(keys)}`,
        'John\'s V1 scope is Friendly Assistant, Princess and Butler. An empty or short roster is the exact symptom this unit exists to fix, and it renders as a normal, working, empty list');

    const incomplete = list.filter(t => !t.key || !t.name || !t.personality_overview);
    check('leg 1b — every template has the fields the prompt builder reads',
        incomplete.length === 0,
        `incomplete: ${JSON.stringify(incomplete.map(t => t.key))}`,
        'personality-prompt-builder falls back to an EMPTY prefix when a personality has no structured fields — so a half-filled template produces a personality that renders, is selectable, and behaves exactly like no personality at all');

    const copy = T.listTemplates();
    copy[0].name = 'MUTATED';
    check('leg 1c — listTemplates() returns a copy (the shipped roster is not mutable in process)',
        T.listTemplates()[0].name !== 'MUTATED',
        'a consumer mutated the shipped roster',
        'the roster is static data shared by every request; one page mutating it changes what every later reader sees, for the life of the process');
}

// ── LEG 2 — the keys are persisted values, so they must be STABLE ───────────
{
    // `ai.defaultPersonalityId` stores this key. A rename does not error
    // anywhere — the stored id simply stops matching, and the household's
    // personality silently reverts.
    const EXPECTED = ['butler', 'dashie', 'princess'];
    const keys = T.listTemplates().map(t => t.key).sort();
    check('leg 2 — the template keys are exactly the pinned set (a rename must be a deliberate change to this leg)',
        JSON.stringify(keys) === JSON.stringify(EXPECTED),
        `expected ${JSON.stringify(EXPECTED)}\n     got      ${JSON.stringify(keys)}`,
        'ai.defaultPersonalityId stores the key. Renaming one unsets the personality for every household that chose it, with no error anywhere — the same shape as the wake-word ids that are kept precisely because they are persisted');
}

// ── LEG 3 — the join: key present AND adapter shipped ───────────────────────
{
    A._setKeyStatusForTest({});
    const noKey = A.isAvailable('elevenlabs');
    A._setKeyStatusForTest({ elevenlabs: true });
    const withKey = A.isAvailable('elevenlabs');
    A._setKeyStatusForTest({ deepgram: true, inworld: true });
    const keyedNoAdapter = A.isAvailable('deepgram') || A.isAvailable('inworld');
    const unknown = A.isAvailable('nonesuch');

    check('leg 3a — a shipped adapter with NO key is not available',
        noKey === false, `isAvailable('elevenlabs') with no key = ${noKey}`,
        'an adapter with nothing to spend cannot serve a voice; reporting it available makes a personality advertise a voice that will fail at speech time');
    check('leg 3b — POSITIVE CONTROL: key + shipped adapter IS available',
        withKey === true, `isAvailable('elevenlabs') with a key = ${withKey}`,
        'without this the join could be a function that always says no, and every other leg here would still pass');
    check('leg 3c — a stored key with NO adapter is NOT available',
        keyedNoAdapter === false, `deepgram/inworld with keys stored = ${keyedNoAdapter}`,
        'this is the reassuring-direction failure: the credential store says yes, the console shows a stored key, and nothing on the box can spend it — the WS-I.8 shape, where keys validated green while turns kept billing elsewhere');
    check('leg 3d — an unknown provider id is NOT available (never an optimistic default)',
        unknown === false, `isAvailable('nonesuch') = ${unknown}`,
        'a typo in a voice ref would otherwise render a premium voice as available on a box that has never heard of the provider');
}

// ── LEG 4 — voice resolution degrades the VOICE, never the personality ─────
{
    A._setKeyStatusForTest({ elevenlabs: true });
    const first = A.resolveVoice(['elevenlabs:butler', 'inworld:butler']);
    A._setKeyStatusForTest({});
    const none = A.resolveVoice(['elevenlabs:butler', 'inworld:butler']);
    const bare = A.resolveVoice(['piper-amy']);
    const empty = A.resolveVoice([]);

    check('leg 4a — resolution takes the FIRST preference this box can speak',
        first === 'elevenlabs:butler', `got ${JSON.stringify(first)}`,
        'the list is ordered on purpose — John\'s voice matrix arrives one row at a time, and taking any resolvable entry rather than the best one silently downgrades every personality that has a preference');
    check('leg 4b — no preference resolves ⇒ null, which the UI renders as "(voice not available)"',
        none === null, `got ${JSON.stringify(none)}`,
        'null is a VOICE result, not a personality result. The personality stays selected and functional and speaks in the standard voice: a Butler with no Butler voice is still a Butler, and removing it would degrade a working feature over a missing key');
    check('leg 4c — a ref with no provider prefix always resolves (it names a voice on the configured engine)',
        bare === 'piper-amy', `got ${JSON.stringify(bare)}`,
        'the vocabulary is deliberately open; a bare ref must not be treated as an unknown provider and silently dropped');
    check('leg 4d — an EMPTY preference list resolves to null and is NOT a degraded state',
        empty === null,
        `got ${JSON.stringify(empty)}`,
        'a personality that prefers nothing (the standard voice) must not be labelled "(voice not available)" — that is why the callers check list.length before asking');
}

// ── LEG 5 — "(voice not available)" is never PERSISTED ─────────────────────
//
// 🔴 The one that would rot silently. It is a transient fact — the key may
// arrive tomorrow — and writing it freezes it, the same class as recording
// "Not shared" off an empty observation map.
{
    const api = readFileSync(FILES.api, 'utf8');
    const editor = readFileSync(FILES.editor, 'utf8');
    const payloadStart = api.indexOf('_personalityPayload(p)');
    const payload = payloadStart >= 0 ? api.slice(payloadStart, payloadStart + 1400) : '';
    const inPayload = /voice not available/i.test(payload);
    const inEditorSave = /voice not available/i.test(editor.slice(editor.indexOf('const payload = {'), editor.indexOf('const payload = {') + 900));
    check('leg 5 — the unavailable state never reaches a write path',
        payloadStart >= 0 && !inPayload && !inEditorSave,
        `found in _personalityPayload=${inPayload} found in the editor's save payload=${inEditorSave}`,
        'persisting it freezes a transient fact: the personality would keep reporting an unavailable voice after the key that fixes it is added, and nothing would ever clear it');
}

// ── LEG 6 — the account-less data path is wired, at the API seam ───────────
{
    const api = readFileSync(FILES.api, 'utf8');
    const methods = ['listTemplates', 'listCustom', 'createPersonality', 'updatePersonality',
        'deletePersonality', 'saveOverride', 'listOverrides'];
    const unbranched = methods.filter(m => {
        const i = api.indexOf(`${m}(`);
        return i < 0 || !/isLocalMode/.test(api.slice(i, i + 700));
    });
    check(`leg 6a — every personality method has an account-less branch (${methods.length} checked)`,
        unbranched.length === 0,
        `no isLocalMode branch in: ${unbranched.join(', ')}`,
        'one unbranched method is a feature that silently stops working on exactly the boxes this unit is for — create works, delete 401s, and the list never changes');

    const router = readFileSync(FILES.router, 'utf8');
    check('leg 6b — the box serves the roster route the console now asks for',
        /router\.get\(\s*'\/personality-templates'/.test(router),
        'no /personality-templates route in api/voice-console.js',
        'the console would fetch a 404, the catch would report it, and the page would show the load error rather than a roster — which is at least honest, and still broken');
}

// ── LEG 7 — templates are NOT generated from the other edition ─────────────
{
    const src = readFileSync(FILES.templates, 'utf8');
    check('leg 7 — the roster is hand-authored, not a generated artifact',
        !/AUTO-GENERATED|DO NOT EDIT BY HAND/i.test(src),
        'the templates file carries a generated-artifact banner',
        'John ruled the two editions\' rosters INDEPENDENTLY AUTHORED (s127): they genuinely differ, so a generator would force agreement between two things that are not the same thing. A later alignment discussion is deferred, not assumed');
}

// ── LEG 8 — the KEYLESS fallback actually resolves (the 2026-10-09 fix) ────
//
// 🔴 THE DEFECT THIS PINS. Princess and Butler each end their voice preference
// list on `piper:…`, written so a household with no paid key still gets a
// character voice. That entry could never win: `isAvailable` looks every
// provider up in ProviderManifest, `piper` was not in it, and an unknown id is
// false by design (leg 3d). So on EVERY stock box the keyless half of every
// chain was dead and two of three V1 personalities reported "(voice not
// available)" while Home Assistant's own Piper ran on the same machine.
//
// Measured before the fix, Gemini-key-only box: princess null, butler null;
// control with an ElevenLabs key resolved elevenlabs:* correctly. So the chain
// worked for people who had paid and failed for everyone else — which is the
// configuration the HA release is judged on.
//
// ⚠️ 8d/8e ARE THE LEGS THAT MATTER MOST, and they guard the tempting WRONG fix.
// The obvious patch is two `auth: 'none'` rows. READINESS[NONE] is `() => true`,
// so that would report Kokoro available on a box with no Kokoro — the
// reassuring direction, invisible from the console, and only audible when a
// voice fails to speak. Availability for a local engine must consult DETECTION.
{
    const PIPER_ONLY = { available: true, kokoro: { installed: false }, brain: {}, stt: [],
        tts: [{ engine_id: 'tts.piper', name: 'piper',
                voices: [{ voice_id: 'en_GB-alan-low', name: 'alan' }] }] };
    const KOKORO_TOO = { ...PIPER_ONLY, kokoro: { installed: true } };
    const byKey = (k) => T.listTemplates().find((x) => x.key === k);
    const res = (k) => A.resolveVoice(byKey(k).voices);

    // Only run if the templates still END on a keyless engine — otherwise this
    // whole leg is about a fallback that no longer exists and would pass
    // vacuously while asserting nothing.
    const chains = ['princess', 'butler'].map(byKey).filter(Boolean);
    const keylessTailed = chains.filter((t) => {
        const last = String((t.voices || [])[(t.voices || []).length - 1] || '');
        return /^(piper|kokoro):/.test(last);
    });
    check(`leg 8 PRECONDITION — the V1 chains still end on a keyless engine (${keylessTailed.length}/${chains.length})`,
        chains.length > 0 && keylessTailed.length === chains.length,
        `chains ending keyless: ${keylessTailed.map((t) => t.key).join(', ') || 'none'}`,
        'if the templates stop ending on piper:/kokoro: then 8a-8c below assert nothing and would pass on a box where the keyless path is gone again. Re-point this leg deliberately rather than deleting it');

    A._setKeyStatusForTest({ gemini: true });
    A._setEnginesForTest(PIPER_ONLY);
    check('leg 8a — `piper` is a KNOWN provider and reads available when HA offers it',
        A.isAvailable('piper') === true,
        `isAvailable('piper') with a detected HA Piper engine = ${A.isAvailable('piper')}`,
        'this is the fix itself — an engine absent from the manifest can never win a voice chain, however well it works');
    const pr = res('princess'), bu = res('butler');
    check('leg 8b — Princess resolves on a box with NO paid key',
        typeof pr === 'string' && /^(piper|kokoro):/.test(pr), `got ${JSON.stringify(pr)}`,
        'the shipped defect: "(voice not available)" on every stock box, which is what made personalities look ElevenLabs-dependent');
    check('leg 8c — Butler too', typeof bu === 'string' && /^(piper|kokoro):/.test(bu),
        `got ${JSON.stringify(bu)}`);

    check('leg 8d 🔴 — kokoro reads UNAVAILABLE when the add-on is NOT installed',
        A.isAvailable('kokoro') === false,
        `isAvailable('kokoro') with kokoro.installed=false = ${A.isAvailable('kokoro')}`,
        'THE leg that rejects the wrong fix. Two `auth:\'none\'` rows would return true here, claiming an engine this box does not have — undetectable from the console and audible only when speech fails');
    A._setEnginesForTest(KOKORO_TOO);
    check('leg 8e — POSITIVE CONTROL: ...and AVAILABLE once it is installed',
        A.isAvailable('kokoro') === true,
        `isAvailable('kokoro') with kokoro.installed=true = ${A.isAvailable('kokoro')}`,
        'without this, 8d passes on a detector that always says no and the engines are simply unreachable by another route');

    A._setEnginesForTest(null);
    check('leg 8f — detection unavailable ⇒ local engines read unavailable (FAILS CLOSED)',
        A.isAvailable('piper') === false && A.isAvailable('kokoro') === false,
        `piper=${A.isAvailable('piper')} kokoro=${A.isAvailable('kokoro')}`,
        'no HA, a failed probe, or a cloud console must degrade the voice rather than claim an engine nobody observed');

    A._setEnginesForTest(PIPER_ONLY);
    A._setKeyStatusForTest({ gemini: true, elevenlabs: true });
    check('leg 8g — CONTROL: a paid key still WINS the chain (preference order intact)',
        res('butler') === 'elevenlabs:butler', `got ${JSON.stringify(res('butler'))}`,
        'the keyless entries are a FALLBACK, not a replacement — if they started winning, every household that paid for ElevenLabs would silently lose the voice it chose');

    // The AUTH.NONE shape, tested where the adapter gate cannot mask it.
    // (isAvailable('espn') is false regardless, because espn's adapter is
    // 'pending' — so asserting through isAvailable would have been a tautology.)
    const M = sandbox.window.ProviderManifest;
    const espn = M.byId('espn');
    check('leg 8h — CONTROL: the AUTH.NONE readiness rule is untouched',
        !!espn && M.isConfigured(espn, undefined) === true,
        `isConfigured(espn, undefined) = ${espn && M.isConfigured(espn, undefined)}`,
        'the delegation in isAvailable routes all three shapes through READINESS; if NONE stopped answering true, keyless providers would become unconfigurable again — the bug that rule exists to prevent');

    // ── 8i — the manifest↔detector join, at BUILD time ─────────────────────
    //
    // `provider-manifest.js` DECLARES `detect: 'ha-tts-engine'`; this file's
    // DETECTORS map IMPLEMENTS that key. Two files must agree on two strings.
    // A typo there already fails closed and warns loudly at runtime, which is
    // the right behaviour — but a runtime DROP on a household's box is not a
    // gate, and the symptom ("that personality has no voice") is indistinguishable
    // from the defect D6 just fixed.
    //
    // Asserted BEHAVIOURALLY rather than by comparing two lists: with every
    // engine present, every LOCAL_ENGINE row must read available. A row whose
    // `detect` names nothing stays false and turns this red. That scales to new
    // rows with no per-row fixture to maintain here — which would itself be the
    // hand-mirror this check is about.
    //
    // 📌 Triage note (lint:discovery, 2026-10-09): the mirror-shaped comment in
    // provider-availability.js is BENIGN for JS_KOTLIN_CONTRACTS.md — that
    // registry governs the JS↔Kotlin LANGUAGE boundary ("Kotlin can't import
    // JS"), and this join is JS↔JS inside one directory. It gets this gate
    // instead of a row.
    {
        const M2 = sandbox.window.ProviderManifest;
        const localRows = M2.PROVIDERS.filter((p) => p.auth === M2.AUTH.LOCAL_ENGINE);
        A._setKeyStatusForTest({});
        A._setEnginesForTest(KOKORO_TOO);          // piper engine + kokoro installed
        const dead = localRows.filter((p) => A.isAvailable(p.id) !== true).map((p) => p.id);
        check(`leg 8i — every LOCAL_ENGINE row's \`detect\` reaches a real detector (${localRows.length} row(s): ${localRows.map((p) => p.id).join(', ')})`,
            localRows.length > 0 && dead.length === 0,
            `rows that stayed unavailable with every engine present: ${dead.join(', ') || '(none)'}`,
            'a row whose `detect` names no detector fails closed and warns at RUNTIME, on a household\'s box, with the symptom "that personality has no voice" — which is indistinguishable from the defect D6 fixed. This makes the join a build-time failure instead');
    }

    A._setKeyStatusForTest({});
    A._setEnginesForTest(null);
}

// ── LEG 9 — the Kokoro mapping (John's D7, 2026-10-09) ─────────────────────
//
// ⚠️ WHAT THIS CAN AND CANNOT DO. `resolveVoice` checks the PROVIDER, never the
// voice ID, and `_detectKokoro` returns `voices: []` by design (enumeration is a
// later step), so nothing on this side can verify that a Kokoro voice NAME
// exists. A wrong ID resolves happily and fails at SPEECH time, on a box.
//
// So 9a asserts SHAPE against Kokoro's documented `{language}{gender}_{name}`
// convention — `bf_alice` is b + f + _alice. That catches a typo'd or
// Piper-styled ref without hand-mirroring Kokoro's 54-voice catalogue into this
// repo, which would be a list that drifts the first time Kokoro ships a voice.
// It cannot catch a well-formed name that does not exist; that needs the add-on
// on a real box and is on John's device list. Stated here so a green run is not
// read as "the voices were verified".
{
    const all = T.listTemplates();
    const refs = all.flatMap((t) => (t.voices || []).map((v) => ({ key: t.key, ref: String(v) })));
    const kokoro = refs.filter((r) => r.ref.startsWith('kokoro:'));

    check(`leg 9 CONTROL — the roster actually carries Kokoro refs (${kokoro.length}: ${kokoro.map((r) => r.ref).join(', ') || 'NONE'})`,
        kokoro.length > 0,
        'no kokoro: ref in any template',
        'D7 mapped the roster onto Kokoro; with none present 9a and 9c below iterate nothing and pass while asserting nothing');

    const KOKORO_NAME = /^[a-z][fm]_[a-z]+$/;
    const malformed = kokoro.filter((r) => !KOKORO_NAME.test(r.ref.slice('kokoro:'.length)));
    check('leg 9a — every Kokoro ref matches the {language}{gender}_{name} convention',
        malformed.length === 0,
        `malformed: ${malformed.map((r) => `${r.key} → ${r.ref}`).join(', ')}`,
        'a Piper-styled ref (en_GB-alan-low) or a typo resolves as soon as the add-on is installed, because resolveVoice only checks the provider — then fails at speech time with nothing in the console to see');

    const dashie = all.find((t) => t.key === 'dashie');
    check('leg 9b 🔴 — the DEFAULT personality still prefers NO voice',
        !!dashie && (dashie.voices || []).length === 0,
        `dashie.voices = ${JSON.stringify(dashie && dashie.voices)}`,
        'naming a voice here makes the default personality OVERRIDE the household\'s own text-to-speech choice — a family that picked Piper "Amy" would silently get something else, because the personality outranked their setting. It also turns the one personality that can never be degraded into one that renders "(voice not available)" on an engine-less box. Read the note on that field before changing this');

    const order = (t) => {
        const ix = (pfx) => (t.voices || []).findIndex((v) => String(v).startsWith(pfx));
        return { el: ix('elevenlabs:'), ko: ix('kokoro:'), pi: ix('piper:') };
    };
    const misordered = all.filter((t) => {
        const o = order(t);
        if (o.ko < 0) return false;
        if (o.el >= 0 && o.el > o.ko) return true;      // paid must rank first
        if (o.pi >= 0 && o.ko > o.pi) return true;      // kokoro must beat piper
        return false;
    }).map((t) => t.key);
    check('leg 9c — ranking holds: a paid voice outranks Kokoro, Kokoro outranks Piper',
        misordered.length === 0,
        `misordered: ${misordered.join(', ')}`,
        'the list is a PREFERENCE order. Kokoro above ElevenLabs would silently demote the voice a paying household chose; Piper above Kokoro would hand a Butler the plainer engine when the better-suited one is installed');
}


// ── LEG 10 — the personality SURFACE: icon, description, status, upgrade hint ─
//
// John, 2026-10-08: personalities should *"give them icon + description +
// active-inactive status"*, and 2026-10-09: *"we should tell them which key to add
// to get the personality."* Legs 1-9 prove the roster and the resolver; these prove
// the household is actually TOLD.
//
// 🔴 Leg 10d is the one that matters most, and it is a NEGATIVE. The hint must never
// name a provider whose adapter is `pending`: that credential stores and validates,
// and nothing on the box spends it. Sending a household to sign up for Inworld to
// hear Princess costs them a signup, a dashboard and a paste, and changes nothing —
// and because it LOOKS like the fix, the voice still being missing afterwards reads
// as a broken product rather than an unbuilt adapter.
{
    const M = sandbox.window.ProviderManifest;
    const I = (() => {
        try {
            vm.runInContext(readFileSync(FILES.icons, 'utf8'), ctx, { filename: FILES.icons });
            return sandbox.window.PersonalityIcons;
        } catch (e) { return null; }
    })();
    const all = T.listTemplates();

    check('leg 10 CONTROL — the icon map loaded',
        !!I && typeof I.for === 'function' && typeof I.DEFAULT === 'string',
        `PersonalityIcons = ${I ? 'loaded' : 'MISSING'}`,
        'every leg below is about what it declares; without it they assert nothing');

    const noIcon = all.filter(t => I.for(t.key) === I.DEFAULT && t.key !== 'dashie');
    check(`leg 10a — every CHARACTER personality has its own icon (${all.length} template(s))`,
        !!I && noIcon.length === 0,
        `falling back to the generic face: ${noIcon.map(t => t.key).join(', ')}`,
        'the icon is how a household tells Princess from Butler at a glance; a roster where '
        + 'they all wear the generic persona face has the field and none of the benefit. '
        + "('dashie' is exempt: the generic face IS its mark.)");

    const iconFiles = [...new Set(all.map(t => I.for(t.key)).concat(I.DEFAULT))];
    const missingFiles = iconFiles.filter(n => !existsSync(join(CONSOLE, 'assets', 'icons', `${n}.svg`)));
    check(`leg 10b — every icon the map names EXISTS on disk (${iconFiles.length} file(s))`,
        missingFiles.length === 0,
        `named but absent: ${missingFiles.map(n => n + '.svg').join(', ')}`,
        'a map entry pointing at a missing asset renders a broken-image box beside a '
        + 'personality name, and nothing in the console can tell — the <img> just fails');

    const noDesc = all.filter(t => !t.description || !String(t.description).trim());
    check('leg 10c — every personality ships a description',
        noDesc.length === 0,
        `no description: ${noDesc.map(t => t.key).join(', ')}`,
        'the description is the line under the name that says what this personality IS; '
        + 'without it the row is a bare name and the icon is the only clue');

    // The hint is asked of a BARE BOX — no keys, no engines — which is the state every
    // one of these chains is degraded in, and therefore the only state where a hint
    // renders at all.
    A._setKeyStatusForTest({});
    A._setEnginesForTest(null);
    const PENDING = (M.PROVIDERS || []).filter(p => p.adapter !== M.ADAPTER.SHIPPED).map(p => p.id);
    const hints = all.map(t => ({ key: t.key, voices: t.voices || [], hint: A.voiceUpgradeHint(t.voices || []) }));
    const degraded = hints.filter(h => h.voices.length && !A.resolveVoice(h.voices));

    check(`leg 10 CONTROL — on a bare box the character personalities ARE degraded (${degraded.length} of ${all.length})`,
        degraded.length > 0,
        'nothing is degraded on a box with no keys and no engines',
        'leg 10d/10e are about the hint shown WHEN a voice is missing; with nothing missing '
        + 'they would both pass having examined no hint at all');

    const namesPending = hints.filter(h => h.hint && PENDING.some(id => {
        const row = M.byId(id);
        return row && row.voiceHint && h.hint === row.voiceHint;
    }));
    check(`leg 10d 🔴 — no hint names an UNSPENT provider (pending: ${PENDING.join(', ') || 'none'})`,
        namesPending.length === 0,
        `hint points at a pending adapter for: ${namesPending.map(h => h.key).join(', ')}`,
        'the credential would store and validate and nothing on the box would spend it. The '
        + 'household does the work, nothing changes, and because the instruction looked like '
        + 'the fix the remaining silence reads as a broken product');

    // ⚠️ 10d ALONE IS NOT ENOUGH, and the reason is worth stating. It passes today
    // partly for an accidental reason: `inworld` is in both character chains AND has
    // `adapter: 'pending'`, but it also has no `voiceHint` field — so the walk would
    // skip it even with the pending check deleted. A leg that cannot tell which of two
    // guards saved it is not testing either.
    //
    // 🔴 AND THE FIRST VERSION OF THIS LEG WAS ITSELF VACUOUS, which is the more useful
    // record. It injected a hint onto `inworld` and asked the REAL chains, where
    // `elevenlabs:` sits at index 0 — unsatisfied, shipped, and carrying a hint — so
    // the walk returned there and NEVER REACHED inworld. Deleting the pending check
    // left the leg green. Being "in a chain" is not the same as being REACHED, and the
    // control said the former while the leg needed the latter (trap 13).
    //
    // So the chain below is SYNTHETIC and minimal: the pending row first, one keyless
    // engine behind it. On a bare box both are unsatisfied, so the walk must step over
    // the pending one and land on Piper — and asserting it returns PIPER's sentence,
    // not merely "not inworld's", is what proves it stepped over rather than bailed.
    const inworld = M.byId('inworld');
    const piper = M.byId('piper');
    if (!inworld || !piper) {
        check('leg 10d2 CONTROL — the specimens exist', false,
            `inworld=${!!inworld} piper=${!!piper}`,
            'this leg needs a PENDING provider and a SHIPPED keyless one to put behind it');
    } else {
        check('leg 10d2 CONTROL — pending in front, shipped-and-hinting behind',
            inworld.adapter !== M.ADAPTER.SHIPPED
            && piper.adapter === M.ADAPTER.SHIPPED && !!piper.voiceHint,
            `inworld.adapter=${inworld.adapter}, piper.adapter=${piper.adapter}, piper.voiceHint=${!!piper.voiceHint}`,
            'without a hinting row BEHIND the pending one, "the pending row was skipped" and '
            + '"the walk gave up" produce the same null and the leg cannot tell them apart');
        const saved = inworld.voiceHint;
        inworld.voiceHint = 'INJECTED — add an Inworld key for this voice';
        const got = A.voiceUpgradeHint(['inworld:princess', 'piper:en_US-amy-low']);
        inworld.voiceHint = saved;
        check('leg 10d2 🔴 FAULT INJECTION — a REACHED pending row is stepped over, not offered',
            got === piper.voiceHint,
            `expected Piper's hint, got: ${JSON.stringify(got)}`,
            'the `adapter !== SHIPPED` skip is not doing the work. An unspendable credential '
            + 'reaches the upgrade line as soon as somebody writes a sentence for its manifest '
            + 'row — and the household does a signup, a dashboard and a paste for nothing');
    }

    const unactionable = degraded.filter(h => !h.hint);
    check(`leg 10e — every degraded personality names something to DO (${degraded.length} checked)`,
        unactionable.length === 0,
        `degraded with no hint: ${unactionable.map(h => h.key).join(', ')}`,
        '"voice not available" with no next step is a dead end on the one surface where the '
        + 'household could fix it. Every chain here ends in a keyless local engine, so there '
        + 'is always an answer — if one has none, the chain lost its free arm');

    // POSITIVE CONTROL on the hint: install the engine the hint pointed at and the
    // hint must GO AWAY. Without this, 10e passes on a function that returns a
    // constant string whatever the box holds.
    A._setEnginesForTest({ available: true, tts: [{ engine_id: 'tts.piper', name: 'piper' }], stt: [], kokoro: { installed: true } });
    const stillHinting = all.filter(t => (t.voices || []).length && A.voiceUpgradeHint(t.voices));
    check('leg 10f — POSITIVE CONTROL: with the local engines installed, no hint is offered',
        stillHinting.length === 0,
        `still hinting: ${stillHinting.map(t => t.key).join(', ')}`,
        'the hint does not depend on what the box actually has, so leg 10e was reading a '
        + 'constant — an upgrade suggested to a household that already has it');
    const resolved = all.filter(t => (t.voices || []).length).map(t => A.describeVoice(A.resolveVoice(t.voices)));
    check(`leg 10g — a resolved voice describes READABLY (${resolved.join(', ')})`,
        resolved.length > 0 && resolved.every(d => d && d.includes(' · ') && !d.includes(':')),
        `got: ${JSON.stringify(resolved)}`,
        "the status line reads 'Speaks as <provider> · <voice>'; leaking the raw "
        + "'kokoro:bm_george' ref puts an internal wire value under a personality's name");
    A._setKeyStatusForTest({});
    A._setEnginesForTest(null);
}

console.log('');
if (failed) {
    console.error(`❌ ${failed} leg(s) failed`);
    process.exit(1);
}
console.log('✅ all legs pass — the roster ships account-less, the join is one function, a missing voice degrades the voice alone, and the keyless fallback resolves without claiming engines this box does not have');
