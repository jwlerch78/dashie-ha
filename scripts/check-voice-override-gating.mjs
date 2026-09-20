#!/usr/bin/env node
/**
 * check-voice-override-gating — a per-device voice override must be offered ONLY where it can
 * actually take effect, and must never be offered where it would silently do nothing.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 *
 * John, 2026-09-20: *"we don't need per device in HA mode. Only in local, cloud, and hybrid."*
 * Under the `ha_assist` preset the HA Assist PIPELINE owns STT, agent and TTS, so a Dashie-side
 * override has nothing to act on.
 *
 * 🔴 THE TRAP THIS GATE EXISTS FOR, and it is a naming trap rather than a logic one:
 * "HA mode" is the `ha_assist` PRESET, **not** the keys with `ha` in their name. `haTtsEngineId`
 * and `haSttEngineId` are what the **local** preset uses (`VoicePresetSeeder`: TTS_HA_ENGINE when
 * an engine id is known). Gating on the key name instead of the preset would remove per-device
 * engines from `local` — a preset that DOES get them — while leaving them under `ha_assist`, which
 * does not. Both halves wrong, and neither visible without driving the code.
 *
 * The second gate is subtler and is the one a reviewer skips: an HA engine id is only read when
 * that stage's provider is `ha_engine`. Offering a Piper voice to a device inheriting a cloud TTS
 * provider produces a setting that visibly saves and silently does nothing — worse than absent.
 * And the provider that matters is the EFFECTIVE one, where `''` on the device is the INHERIT
 * sentinel rather than "not ha_engine".
 *
 * ── HOW ─────────────────────────────────────────────────────────────────────
 *
 * DRIVEN, not static: it evaluates the real `js/pages/devices-detail-modals.js` in a vm context
 * and calls the real `voiceOverridesApply()` / `_renderHaEngineRows()`. A static grep for the
 * preset list would pass while the gate it feeds was bypassed.
 *
 * ── THE CONTROLS ────────────────────────────────────────────────────────────
 *
 * Every "row is hidden" assertion is paired with a case where the SAME call renders it, measured
 * the same way — otherwise a function that returned '' unconditionally (a typo, a bad early
 * return) would pass every hiding leg and look like a working gate.
 *
 * Usage: node scripts/check-voice-override-gating.mjs
 * Exit 0 only on ALL PASS.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SUBJECT = 'dashie-ha/frontend/console/js/pages/devices-detail-modals.js';
const SHAPE = 'dashie-ha/frontend/console/js/lib/voice-capability-shape.generated.js';

const src = fs.readFileSync(path.join(ROOT, SUBJECT), 'utf8');
const ctx = {
    console, window: {}, document: {},
    App: { renderPage() {} }, DevicesPage: {}, Toast: {},
};
ctx.globalThis = ctx;
vm.createContext(ctx);
// The REAL generated shape, not a hand stub: a stub would drift from the Kotlin
// producer silently, and the field names are the whole point of CONTRACTS #79.
vm.runInContext(fs.readFileSync(path.join(ROOT, SHAPE), 'utf8'), ctx);
vm.runInContext(src, ctx);

const M = ctx.window.DevicesDetailModals || ctx.DevicesDetailModals;
if (!M) { console.error('FAIL: devices-detail-modals.js did not export DevicesDetailModals'); process.exit(1); }
if (typeof M.voiceOverridesApply !== 'function' || typeof M._renderHaEngineRows !== 'function') {
    console.error('FAIL: the gating functions are gone. If they were renamed, update this gate — do not delete it.');
    process.exit(1);
}
M._escape = (s) => String(s);

let pass = 0, fail = 0;
const leg = (name, got, want) => {
    const ok = got === want;
    ok ? pass++ : fail++;
    console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : `  (got ${got}, want ${want})`}`);
};

const acct = (over) => { M._accountSettings = { voice: over }; };
const rows = (deviceVoice = {}) => { M._voiceSetupPending = {}; return M._renderHaEngineRows({ settings: { voice: deviceVoice } }); };
const OPTS = {
    raw: {},
    configOptions: (stage, key) => (key === 'voice.haTtsVoiceId'
        ? [{ value: 'en_US-amy-low', label: 'Amy (low)' }]
        : [{ value: 'engine.1', label: 'Engine 1' }]),
};

// ── Gate 1: the preset ──
for (const [preset, want] of [['cloud', true], ['hybrid', true], ['local', true], ['ha_assist', false]]) {
    acct({ pipelinePreset: preset });
    leg(`preset ${preset.padEnd(9)} → overrides ${want ? 'apply' : 'do NOT apply'}`, M.voiceOverridesApply(), want);
}
acct({ pipelinePreset: '' });
leg('preset unknown  → overrides do NOT apply (fail toward the account default)', M.voiceOverridesApply(), false);
M._accountSettings = null;
leg('account settings not loaded → overrides do NOT apply', M.voiceOverridesApply(), false);

// ── Gate 2: engine detection must exist ──
acct({ pipelinePreset: 'local', ttsProvider: 'ha_engine', sttProvider: 'ha_engine' });
ctx.window.HaEngines = { raw: null };
leg('no add-on detection → no HA rows', rows() === '', true);
ctx.window.HaEngines = undefined;
leg('ha-engines.js absent entirely → no HA rows, no throw', rows() === '', true);

// POSITIVE CONTROL for both hiding legs above: the same call, detection present, renders.
ctx.window.HaEngines = OPTS;
leg('CONTROL: detection present → rows DO render', rows().includes('haTtsVoiceId'), true);

// ── Gate 3: effective provider per stage ──
leg('tts=ha_engine → Voice row shown', rows().includes('haTtsVoiceId'), true);
leg('stt=ha_engine → STT engine row shown', rows().includes('haSttEngineId'), true);

acct({ pipelinePreset: 'local', ttsProvider: 'dashie_cloud', sttProvider: 'ha_engine' });
leg('tts NOT ha_engine → Voice row hidden (it would save and do nothing)', rows().includes('haTtsVoiceId'), false);
leg('CONTROL: same call still shows the STT row', rows().includes('haSttEngineId'), true);

// ── Gate 4: the inherit sentinel is INHERIT, not "not ha_engine" ──
acct({ pipelinePreset: 'local', ttsProvider: 'ha_engine', sttProvider: 'ha_engine' });
leg("device ttsProvider='' inherits the account's ha_engine → Voice row shown", rows({ ttsProvider: '' }).includes('haTtsVoiceId'), true);
acct({ pipelinePreset: 'local', ttsProvider: 'dashie_cloud', sttProvider: 'ha_engine' });
leg('device override beats the account → Voice row returns', rows({ ttsProvider: 'ha_engine' }).includes('haTtsVoiceId'), true);

// ── Gate 5: ha_assist wins over everything below it ──
acct({ pipelinePreset: 'ha_assist', ttsProvider: 'ha_engine', sttProvider: 'ha_engine' });
leg('ha_assist + ha_engine providers → still no rows', rows() === '', true);

// ── Gate 6: staged edits are per-key ──
M._voiceSetupPending = {};
M._setVoiceSetupPending('haTtsVoiceId', 'en_US-amy-low');
M._setVoiceSetupPending('haSttEngineId', 'engine.1');
leg('two leaves stage independently', Object.keys(M._voiceSetupPending).length, 2);
M._setVoiceSetupPending('haTtsVoiceId', '');
leg("a staged '' (inherit) beats the stored value", M._voiceSetupValue({ settings: { voice: { haTtsVoiceId: 'x' } } }, 'haTtsVoiceId'), '');

// ── Gate 7: the TTS capability record, and the ABSENT-vs-EMPTY collapse ──
//
// 🔴 THE TRAP THIS SECTION EXISTS FOR, and it is invisible in the only configuration
// anyone reviews. As of 2026-09-20 exactly ONE device of seven publishes `tts.available`;
// the other six publish `tts` with `resolved` ONLY, because their APKs predate the field.
// An empty array and a missing key both read falsy, so a picker that tests truthiness
// treats "your APK is old" as "this device can speak with nothing" — and renders
// perfectly on the one device it is tested against while showing an empty picker on
// every other device in the fleet.
//
// ⇒ ABSENT and EMPTY must resolve to DIFFERENT states. Absent follows CONTRACTS #78
// state A (pre-capability behavior, same as no record at all); empty is a real negative.
const TTS_VOCAB = [{ id: 'dashie_cloud' }, { id: 'local_url' }, { id: 'ha_engine' }, { id: 'android_voice' }];
const withTts = (tts, stackUp = true) => ({ settings: { aiVoice: { voiceCapabilities: { stackUp, lane: 'cascade', tts } } } });

if (typeof M.ttsCapabilityState !== 'function') {
    leg('ttsCapabilityState exists', false, true);
} else {
    ctx.window.VoiceAiOptions = { STT: [], TTS: TTS_VOCAB };

    // 🔴 THE LEG THIS GATE WAS WRITTEN FOR — written RED, before the implementation.
    leg("tts.available ABSENT (old APK) → 'no-field', NOT an empty-capability verdict",
        M.ttsCapabilityState(withTts({ resolved: 'android_voice: …' })).state, 'no-field');

    // CONTROL for the leg above: the SAME call on a record that HAS the field must
    // reach 'ok'. Without this, a function returning 'no-field' unconditionally passes.
    const okState = M.ttsCapabilityState(withTts({ resolved: 'x', available: ['dashie_cloud', 'ha_engine'] }));
    leg("CONTROL: tts.available PRESENT → 'ok'", okState.state, 'ok');
    leg('CONTROL: and it offers the two ids', okState.offerable.join(','), 'dashie_cloud,ha_engine');

    // EMPTY is a real negative and must NOT collapse into the absent case.
    leg("tts.available EMPTY → 'nothing-available' (a real negative, distinct from absent)",
        M.ttsCapabilityState(withTts({ resolved: 'x', available: [] })).state, 'nothing-available');

    // Present but nothing this console offers — the STT side's 'unofferable' precedent.
    leg("tts.available holds only ids this console does not offer → 'unofferable'",
        M.ttsCapabilityState(withTts({ resolved: 'x', available: ['some_retired_engine'] })).state, 'unofferable');

    // The states inherited from the STT reader must behave identically.
    leg("stackUp false → 'stack-down'",
        M.ttsCapabilityState(withTts({ resolved: 'x', available: ['dashie_cloud'] }, false)).state, 'stack-down');
    leg("no record at all → 'no-record'", M.ttsCapabilityState({ settings: {} }).state, 'no-record');

    // The note must not tell a user something false about their own device. An old APK
    // has not reported that it can speak with nothing — it has not reported at all.
    const note = M.ttsCapabilityNote ? M.ttsCapabilityNote('no-field') : '';
    leg("the 'no-field' note does not claim the device has no voices",
        /no voices|nothing|cannot speak/i.test(note), false);
    leg("the 'no-field' note is non-empty (it must explain the absence)", note.length > 0, true);
}

// ── Gate 8: affordability is the CONSOLE's, and UNKNOWN is PERMISSIVE ──
//
// 🔴 The ruling (O, 2026-09-20): intersect only when spend state is KNOWN; when it is null,
// offer the device's list unmodified. `devices` is in LOCAL_MODE_PAGES, so this renders on an
// account-less box where balance is null BY DESIGN and permanently — treating absent as
// "cannot spend" would hide the cloud voice across the whole household in the free edition
// while the device's own tts.available says it is fine.
if (typeof M._renderTtsProviderRow === 'function') {
    ctx.window.VoiceAiOptions = {
        STT: [],
        TTS: [{ id: 'dashie_cloud', label: 'Cloud TTS', locality: 'cloud' },
              { id: 'android_voice', label: 'On-Device', locality: 'local' }],
    };
    acct({ pipelinePreset: 'local' });
    const dev = withTts({ resolved: 'x', available: ['dashie_cloud', 'android_voice'] });
    const rowWith = (bal) => { ctx.CreditsService = { balance: () => bal }; M._voiceSetupPending = {}; return M._renderTtsProviderRow(dev); };

    // THE LEG THE RULING EXISTS FOR: no balance seeded (account-less box, or the seed gave up).
    const unknown = rowWith(null);
    leg('spend UNKNOWN → the cloud voice is still OFFERED (permissive)', /dashie_cloud/.test(unknown) && !/disabled/.test(unknown), true);

    // CONTROLS: the same call must be able to BOTH offer and withhold, or the leg above is vacuous.
    const funded = rowWith({ balance: 250 });
    leg('CONTROL: spend KNOWN and funded → offered', /dashie_cloud/.test(funded) && !/disabled/.test(funded), true);
    const broke = rowWith({ balance: 0 });
    leg('spend KNOWN and empty → the cloud voice is WITHHELD with a readable reason',
        /disabled/.test(broke) && /no credits/.test(broke), true);
    leg('CONTROL: the free on-device voice is offered in ALL THREE states',
        [unknown, funded, broke].every((h) => /android_voice/.test(h)), true);

    // The preset gate still wins over everything in this row.
    acct({ pipelinePreset: 'ha_assist' });
    leg('ha_assist → no TTS row at all', rowWith({ balance: 250 }) === '', true);
    acct({ pipelinePreset: 'local' });

    // An old APK must not render an empty picker — it renders the explanatory note instead.
    const oldApk = (() => { ctx.CreditsService = { balance: () => null }; return M._renderTtsProviderRow(withTts({ resolved: 'x' })); })();
    leg('old APK (no tts.available) → a note, not a <select>', !/<select/.test(oldApk) && oldApk.length > 0, true);
} else {
    leg('_renderTtsProviderRow exists', false, true);
}

console.log(fail === 0 ? `\nALL PASS (${pass} legs)` : `\n${fail} FAILED of ${pass + fail}`);
process.exit(fail ? 1 : 0);
