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
    api: join(CONSOLE, 'js', 'lib', 'voice-ai-api.js'),
    editor: join(CONSOLE, 'js', 'pages', 'voice-ai-personality-edit.js'),
    page: join(CONSOLE, 'js', 'pages', 'voice-ai.js'),
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
const sandbox = { console, document: { title: '', querySelector: () => null }, DashieAuth: { isAddonMode: true } };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
try {
    for (const k of ['brand', 'manifest', 'availability']) {
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

console.log('');
if (failed) {
    console.error(`❌ ${failed} leg(s) failed`);
    process.exit(1);
}
console.log('✅ all legs pass — the roster ships account-less, the join is one function, and a missing voice degrades the voice alone');
