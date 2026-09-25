#!/usr/bin/env node
/**
 * check-device-card-tiles — the device card's tile grid RENDERS, and every tile
 * points at its own device.
 *
 * ── WHY (John, 2026-09-25: *"use the empty 6th slot"*) ──────────────────────
 * The card grid is a hand-written list of six tiles inside one template literal.
 * Nothing else renders it, so a mistake there is invisible to every static gate:
 * check-card-dialogs proves the MODAL is rendered on this page, and passed the
 * whole time the tile was wrong.
 *
 * 🔴 It caught a real one on its first run. The Theme tile was written with
 * `idAttr`, which is in scope in _renderCompactHeader but NOT in
 * _renderSimpleSettings -- so the template literal threw a ReferenceError and
 * took out the ENTIRE card render, not just the tile. `node --check` passes on
 * that file: the name is only resolved when the function runs.
 *
 * ⚠️ It DRIVES the shipped module -- vm-loads devices.js + devices-card.js and
 * calls the real _renderSimpleSettings. It does not read the source and pattern
 * match, because the defect it exists for is a runtime one.
 *
 * Leg 8/9 are the pair that matters for Theme specifically: where the theme
 * EDITOR is unavailable the tile must be ABSENT, not present-and-dead. The row
 * this replaced was drawn unconditionally and opened a modal that returned '' --
 * John hit it on a device holding `fern` (2026-09-21).
 *
 * Exit 0 = every leg passes · 1 = a violation or a render throw · 2 = BLIND.
 */
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const B = `${ROOT}/dashie-ha/frontend/console/js/pages`;
if (!existsSync(`${B}/devices-card.js`)) { console.log('BLIND: devices-card.js not found'); process.exit(2); }
const sandbox = {
  console: { log(){}, warn(){}, error(){} },
  document: { title:'', querySelector: () => null, visibilityState:'visible' },
  localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
  DashieAuth: { isAddonMode:false, isLocalMode:false, async dbRequest(){ return { devices: [] }; } },
  FeatureGate: { isAddonMode:()=>false, isPageEnabled:()=>true, optionAllowed:(k)=>k!=='display.themeFamily'?true:FAM },
  ConsoleState: { dismiss(){}, restore(){}, isDismissed:()=>false },
  Toast: { success(){}, error(){}, friendly:(e)=>String(e) },
  App: { renderPage(){} },
  DevicesDetailModals: {
    personalityName: () => 'Friendly', immichAlbumSummary: () => 'Album',
    buildThemeSummary: (d) => (d?.themeFamily === 'fern' ? 'Fern' : 'Default'),
    _profileNow: () => PROFILE_LABEL,
    voiceSetupSummary: () => ({ custom:false, label:'Cloud' }),
    buildSleepSummary: () => '10pm', _formatTimeout: () => '5 min',
    ensureAccountSettings: () => {}, _accountSettings: { ai: { defaultPersonalityId: 'dashie' } },
    photoAlbumSummary: () => 'All albums', wakeWordLabel: () => 'Hey Dashie',
    sleepModeOf: () => 'schedule', sleepEffective: (x) => ({ enabled:true, sleepMethod:'schedule', sleepTime:'22:00', wakeTime:'06:30', ...(x||{}) }),
    _sleepNow: () => '10pm-6:30am', buildPhotoSummary: () => 'All albums',
    wakeWordName: () => 'Hey Dashie', _inherited: () => '', _labelFor: () => 'x',
  },
  DevicesRename: { conflictHaName:()=>null, conflictDevices:()=>[], renderBanner:()=>'' },
  DevicesClaim: { renderBanner:()=>'', fetch: async()=>{} },
  DevicesCamera: { _open:false },
  iconImg: () => '<img>',
  VoiceAiApi: { DEFAULTS: { 'ai.defaultPersonalityId':'dashie' }, defaultWakeWord: () => 'hey_dashie' },
  AccountSettingsStore: { get: () => ACCOUNT, ensure(){} },
  VoiceProfileKeys: {
    named: (settings) => (settings?.voiceProfiles ?? null),
    inherited: (settings, device, cat, key, acct) => ({ value: device?.settings?.[cat]?.[key] || acct || '' }),
    DEFAULT_PROFILE_ID: 'default',
  },
  HaEngines: { raw: null },
  setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: async () => { throw new Error('no network'); },
};
let FAM = true;
let PROFILE_LABEL = 'Evenings';
let ACCOUNT = {
  ai: { defaultPersonalityId: 'dashie', model: 'gemini-2.5-flash' },
  voice: { pipelinePreset: 'cloud', sttProvider: 'dashie_cloud', ttsProvider: 'dashie_cloud' },
  voiceProfiles: { evenings: { name: 'Evenings' } },
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
// 🔴 The REAL brand and model catalog, not stubs. Stubbing them is how leg 12 first
// "failed": the summary was correct and the harness could not spell the label. A stub
// that is thinner than the shipped collaborator produces findings about the stub.
vm.runInContext(readFileSync(`${B}/../lib/brand.js`,'utf8'), ctx, { filename:'brand.js' });
vm.runInContext(readFileSync(`${B}/../lib/ai-models-catalog.js`,'utf8'), ctx, { filename:'ai-models-catalog.js' });
vm.runInContext(readFileSync(`${B}/../lib/voice-ai-options.js`,'utf8'), ctx, { filename:'voice-ai-options.js' });
vm.runInContext(readFileSync(`${B}/../lib/voice-pipeline-summary.js`,'utf8'), ctx, { filename:'voice-pipeline-summary.js' });
vm.runInContext(readFileSync(`${B}/devices.js`,'utf8'), ctx, { filename:'devices.js' });
vm.runInContext(readFileSync(`${B}/devices-card.js`,'utf8'), ctx, { filename:'devices-card.js' });
const DC = vm.runInContext('DevicesCard', ctx);
const device = { device_id:'dev-1', device_type:'tablet', settings:{
  display:{ themeFamily:'fern' }, sleep:{}, aiVoice:{}, photos:{},
  voice:{ profileId:'evenings' } } };
let pass=0, fail=0;
const t=(n,c,d)=>{ if(c){pass++;console.log(`  PASS  ${n}`);} else {fail++;console.log(`  FAIL  ${n}${d?' — '+d:''}`);} };

// The summary holder is the real module -- loaded below beside the page files -- so
// these legs exercise the shipped sentence, not a stub of it.
const html = DC._renderSimpleSettings(device, {});

// ── the 2x2 tile grid ───────────────────────────────────────────────────────
t('1 four tiles remain', ['>Sleep<','>Photos<','>Wake word<','>Personality<'].every(x => html.includes(x)));
t('2 the Voice profile TILE is gone (absorbed by the wide row)', !html.includes('>Voice profile<'));
t('3 the Voice TILE is gone (absorbed by the wide row)',
  !/>Voice<\/span>/.test(html), 'a standalone Voice tile is still rendered');
t('4 no spacer -- 4 tiles is already a clean 2x2', !html.includes('is-spacer'));
t('5 every tile still carries an icon (the icon IS the visible label)',
  (html.match(/dtile-i/g) || []).length === 5, `${(html.match(/dtile-i/g) || []).length} icons across 4 tiles + 1 row`);

// ── the full-width Voice & AI row ───────────────────────────────────────────
t('6 the wide row is rendered', html.includes('dtile-wide'));
t('7 it is labelled Voice & AI', html.includes('Voice &amp; AI</span>'));
t('8 it opens the voice-setup dialog for THIS device', html.includes("openVoiceSetup('dev-1')"));
t('9 no undefined id leaked into any handler', !html.includes('undefined'));
// 🔴 The sentence must carry the PROFILE, the preset and the model -- John's shape:
// "Default (Cloud, Gemini 2.5 Flash) - Dashie Cloud STT - On-Device".
t('10 the summary names the profile', html.includes('Evenings'));
t('11 ...the preset', /Evenings \(Cloud/.test(html), html.slice(html.indexOf('dtile-wide'), html.indexOf('dtile-wide') + 400));
t('12 ...and the AI model', html.includes('Gemini 2.5 Flash'));
// TWO LINES: profile + pipeline on .dtile-v, engines muted on .dtile-v2.
const wide = html.slice(html.indexOf('dtile-wide'));
const line1 = (wide.match(/dtile-v">([^<]*)</) || [])[1] || '';
const line2 = (wide.match(/dtile-v2">([^<]*)</) || [])[1] || '';
t('12a row 1 is the profile and its pipeline, and ONLY that',
  /^Evenings \(Cloud, Gemini 2\.5 Flash\)$/.test(line1), JSON.stringify(line1));
t('12b row 2 is the engines, muted and separate', /STT/.test(line2) && !/Evenings/.test(line2), JSON.stringify(line2));
t('12c the engines are NOT also on row 1 (that was the one-line form)', !/STT/.test(line1), JSON.stringify(line1));

// A device on DEFAULT says Default, not the profile's name.
device.settings.voice = {};
const htmlDef = DC._renderSimpleSettings(device, {});
t('13 a device on Default says Default', /Default \(/.test(htmlDef));
t('14 ...and not the other profile', !htmlDef.includes('Evenings'));

// Nothing known yet => no row, rather than an empty one reading as "no voice setup".
ACCOUNT = null;
t('15 account not loaded => no wide row, no throw', !DC._renderSimpleSettings(device, {}).includes('dtile-wide'));
t('16 CONTROL: the four tiles still render in that state',
  DC._renderSimpleSettings(device, {}).includes('>Sleep<'));

console.log(`check-device-card-tiles: ${pass} pass, ${fail} fail`);
if (!fail) console.log('\u2705 the card tile grid renders and every tile targets its own device');
process.exit(fail ? 1 : 0);
