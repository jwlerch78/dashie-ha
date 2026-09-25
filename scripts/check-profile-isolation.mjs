#!/usr/bin/env node
/**
 * check-profile-isolation — editing a NAMED profile must not touch DEFAULT.
 *
 * ── WHY (John, 2026-09-25) ──────────────────────────────────────────────────
 * *"switching back to default did not bring back the default settings"*, and
 * *"it keeps bouncing around with the models showing in the drop downs"*.
 *
 * One root cause. `VoiceProfileScope.overlay()` returned the CALLER'S object on
 * three early-return paths, so `VoiceAiPage._defaults` became the very same object
 * as `_accountRaw`. The page writes optimistic edits into `_defaults`, so editing a
 * named profile wrote them into Default's in-memory copy — and switching back
 * showed the profile's values as the household's.
 *
 * 🔴 The window was far wider than "editing Default". After every profile save the
 * store was reset, so `settings` was null for the whole refetch, which sent the
 * other two early returns down the by-reference path too — WHILE the user clicked.
 * That same null window is the bouncing: with no profile to overlay, the profile's
 * own rows re-rendered from the ACCOUNT values and then snapped back.
 *
 * 🔴 THIS GATE DRIVES THE SHIPPED MODULES. It calls the real `overlay()` and the
 * real `VoiceAiPage.applyScope()`; it does not re-implement resolution. A harness
 * that models the thing it measures agrees with itself (trap 13).
 *
 * Exit 0 = isolated · 1 = a leak · 2 = BLIND.
 */
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const B = `${ROOT}/dashie-ha/frontend/console/js`;
const FILES = [
  `${B}/lib/voice-profile-keys.js`,
  `${B}/lib/voice-profile-scope.js`,
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
  sessionStorage: { getItem: (k) => store[k] ?? null, setItem: (k,v) => { store[k]=String(v); }, removeItem: (k)=>{ delete store[k]; } },
  localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
  document: { title:'', querySelector: () => null, getElementById: () => null, visibilityState:'visible', addEventListener(){} },
  DashieAuth: { isAddonMode:true, isLocalMode:false, isHaContext:true, isAuthenticated:true, async dbRequest(){ return {}; } },
  FeatureGate: { isAddonMode:()=>true, isPageEnabled:()=>true, shouldShow:()=>true, optionAllowed:()=>true, isPublishedBuild:()=>true },
  App: { renderPage(){}, navigate(){} },
  Toast: { success(){}, error(){}, info(){}, friendly:(e)=>String(e) },
  BRAND: { assistantName:'Dashie', consoleName:'Dashie Console' },
  VoiceAiApi: { defaultWakeWord:()=>'hey_dashie', listVoices:async()=>[], loadAiDefaults:async()=>({}), DEFAULTS:{'ai.model':'gemini-2.5-flash'} },
  Card: { render:(o)=>`<div>${o?.body||''}</div>` },
  ConsoleState: { isDismissed:()=>false },
  iconImg: () => '',
  fetch: async () => { throw new Error('no network'); },
  setTimeout, clearTimeout, setInterval, clearInterval,
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
for (const f of FILES) {
  try { vm.runInContext(readFileSync(f,'utf8'), ctx, { filename:f }); }
  catch (e) { console.log(`BLIND: ${f.split('/').pop()} did not evaluate: ${e.message}`); process.exit(2); }
}
const Scope = vm.runInContext('VoiceProfileScope', ctx);
const Keys  = vm.runInContext('VoiceProfileKeys', ctx);
const P     = vm.runInContext('VoiceAiPage', ctx);
if (!Scope?.overlay || !Keys?.named) { console.log('BLIND: profile modules did not load'); process.exit(2); }
if (typeof P?.applyScope !== 'function') { console.log('BLIND: VoiceAiPage.applyScope did not load'); process.exit(2); }

let pass=0, fail=0;
const t=(n,c,d)=>{ if(c){pass++;console.log(`  PASS  ${n}`);} else {fail++;console.log(`  FAIL  ${n}${d?' — '+d:''}`);} };

const DEFAULT_ACCOUNT = () => ({
  'voice.sttProvider':'dashie_cloud', 'voice.ttsProvider':'dashie_cloud',
  'ai.defaultPersonalityId':'dashie', 'ai.model':'gemini-2.5-flash',
});
const HOUSEHOLD = () => ({ voiceProfiles: { testing: { name:'testing', schemaVersion:1, values:{
  voice:{ sttProvider:'sherpa_moonshine_base', ttsProvider:'ha_engine', haSttEngineId:'', haTtsEngineId:'', haTtsVoiceId:'', localTtsUrl:'', localTtsVoiceId:'', pipelinePreset:'local' },
  aiVoice:{ personalityId:'nova', voiceKey:'', wakeWord:'' } } } } });
const setEditing = (id) => Scope.setEditingId(id);

// ── 1-3: overlay must never hand back the caller's object ───────────────────
// ⚠️ NAMED FOR WHAT THEY ACTUALLY REACH. Legs 2 and 3 do NOT exercise overlay's
// `if (!profile)` branch, although an earlier draft of this gate claimed they did:
// `editingId()` already falls back to Default whenever the stored id does not name
// a live profile, so by the time overlay looks the profile is always there. That
// branch is unreachable defense, and all three legs land on the FIRST early return.
// Left as three legs because they enter through three different call shapes the page
// really makes, but do not read them as coverage of the second branch.
const raw1 = DEFAULT_ACCOUNT();
setEditing('default');
t('1 editing Default returns a COPY, not _accountRaw', Scope.overlay(raw1, HOUSEHOLD()) !== raw1);
setEditing('testing');
t('2 settings=null (the refetch window) returns a COPY', Scope.overlay(raw1, null) !== raw1);
setEditing('ghost');
t('3 a dangling id falls back to Default AND returns a COPY',
  Scope.overlay(raw1, HOUSEHOLD()) !== raw1 && Scope.onDefault(HOUSEHOLD()) === true);

// ── 4: the clean path, driven through the real applyScope ──────────────────
// 🔴 4a-4d PASS EVEN WITH THE BUG PRESENT — measured, not assumed. Editing a valid
// named profile takes overlay's copying path, so no alias is formed and nothing
// leaks. They are a regression guard for the happy case and prove NOTHING about the
// defect John hit. Leg 5 is the discriminating one: the alias forms while the store
// is null, which is the state every save used to leave behind.

P._accountRaw = DEFAULT_ACCOUNT();
sandbox.AccountSettingsStore = { _d: HOUSEHOLD(), get(){ return this._d; }, set(v){ this._d=v; }, ensure(){}, reset(){ this._d=null; } };
setEditing('default');
P.applyScope();
const defaultSttBefore = P._defaults['voice.sttProvider'];

setEditing('testing');
P.applyScope();
t('4a the profile shows ITS value, not the household one', P._defaults['voice.sttProvider'] === 'sherpa_moonshine_base', P._defaults['voice.sttProvider']);
// the optimistic write saveDefault() performs on every change
P._defaults['voice.sttProvider'] = 'android_voice';
P._defaults['ai.defaultPersonalityId'] = 'marcus';
t('4b the optimistic edit did NOT reach _accountRaw',
  P._accountRaw['voice.sttProvider'] === 'dashie_cloud' && P._accountRaw['ai.defaultPersonalityId'] === 'dashie',
  `_accountRaw=${JSON.stringify(P._accountRaw)}`);

setEditing('default');
P.applyScope();
t('4c switching back to Default restores the household values',
  P._defaults['voice.sttProvider'] === defaultSttBefore && P._defaults['voice.sttProvider'] === 'dashie_cloud',
  P._defaults['voice.sttProvider']);
t('4d …and Default keeps its own personality', P._defaults['ai.defaultPersonalityId'] === 'dashie', P._defaults['ai.defaultPersonalityId']);

// ── 5: the same sequence ACROSS THE REFETCH WINDOW (settings null) ──────────
P._accountRaw = DEFAULT_ACCOUNT();
setEditing('testing');
sandbox.AccountSettingsStore.set(null);          // what reset() used to leave behind
P.applyScope();
P._defaults['voice.ttsProvider'] = 'ha_engine';  // user clicks during the refetch
setEditing('default');
sandbox.AccountSettingsStore.set(HOUSEHOLD());
P.applyScope();
t('5 an edit made DURING a refetch does not corrupt Default',
  P._defaults['voice.ttsProvider'] === 'dashie_cloud', P._defaults['voice.ttsProvider']);

// ── 6-8: withValue, the replacement for reset()+ensure() ────────────────────
const h = HOUSEHOLD();
const patched = Scope.withValue(h, 'voiceProfiles.testing.values.voice.ttsProvider', 'elevenlabs');
t('6 withValue sets the deep path', patched.voiceProfiles.testing.values.voice.ttsProvider === 'elevenlabs');
t('7 …without mutating the input', h.voiceProfiles.testing.values.voice.ttsProvider === 'ha_engine');
const grown = Scope.withValue({}, 'voiceProfiles.brandnew.values.voice.sttProvider', 'x');
t('8 withValue grows a path that does not exist yet', grown.voiceProfiles.brandnew.values.voice.sttProvider === 'x');

// ── 9: CONTROL — the harness reaches the real code ─────────────────────────
t('9 CONTROL the real overlay is being called (a profile value appears at all)',
  (() => { setEditing('testing'); return Scope.overlay(DEFAULT_ACCOUNT(), HOUSEHOLD())['voice.sttProvider'] === 'sherpa_moonshine_base'; })());

console.log(`check-profile-isolation: ${pass} pass, ${fail} fail`);
if (fail) { console.error(`\ncheck-profile-isolation FAILED (${fail} leg(s))`); process.exit(1); }
console.log('✅ editing a named profile leaves Default untouched');
