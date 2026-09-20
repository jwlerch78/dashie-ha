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

const src = fs.readFileSync(path.join(ROOT, SUBJECT), 'utf8');
const ctx = {
    console, window: {}, document: {},
    App: { renderPage() {} }, DevicesPage: {}, Toast: {},
    CAPABILITY_FIELDS: { stt: { _self: 'stt' } },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
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

console.log(fail === 0 ? `\nALL PASS (${pass} legs)` : `\n${fail} FAILED of ${pass + fail}`);
process.exit(fail ? 1 : 0);
