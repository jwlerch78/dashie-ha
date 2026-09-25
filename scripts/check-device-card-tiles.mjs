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
  BRAND: { consoleName:'Dashie Console' },
  iconImg: () => '<img>',
  VoiceAiApi: { DEFAULTS: { 'ai.defaultPersonalityId':'dashie' }, defaultWakeWord: () => 'hey_dashie' },
  AccountSettingsStore: { get: () => ACCOUNT, ensure(){} },
  VoiceProfileKeys: { named: (settings) => (settings?.voiceProfiles ?? null) },
  setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: async () => { throw new Error('no network'); },
};
let FAM = true;
let PROFILE_LABEL = 'Evenings';
let ACCOUNT = { ai: { defaultPersonalityId: 'dashie' }, voiceProfiles: { evenings: { name: 'Evenings' } } };
sandbox.window = sandbox; sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(readFileSync(`${B}/devices.js`,'utf8'), ctx, { filename:'devices.js' });
vm.runInContext(readFileSync(`${B}/devices-card.js`,'utf8'), ctx, { filename:'devices-card.js' });
const DC = vm.runInContext('DevicesCard', ctx);
const device = { device_id:'dev-1', device_type:'tablet', settings:{ display:{ themeFamily:'fern' }, sleep:{}, aiVoice:{}, photos:{} } };
let pass=0, fail=0;
const t=(n,c,d)=>{ if(c){pass++;console.log(`  PASS  ${n}`);} else {fail++;console.log(`  FAIL  ${n}${d?' — '+d:''}`);} };

const html = DC._renderSimpleSettings(device, {});
t('1 a Voice profile tile is rendered', html.includes('>Voice profile<'), 'no Voice profile label in the grid');
t('2 it shows the profile NAME', html.includes('>Evenings<'));
t('3 it opens the profile modal for THIS device', html.includes("openProfile('dev-1')"), 'wrong or undefined device id');
t('4 no undefined id leaked into any handler', !html.includes('undefined'), 'an onclick carries undefined');
// 🔴 `.dtile-l` is screen-reader-only, so the ICON is the visible label. A tile without
// one renders as its bare value -- which is how the 0.9.47 Theme tile drew as just
// "Default" and read as the voice profile.
// Counted in the RENDERED output, not read off the source: `_tile` emits a
// `.dtile-i` span only when an icon was passed, so six tiles must produce six. An
// iconless tile is an unlabelled one, which is exactly what shipped in 0.9.47.
const iconCount = (h) => (h.match(/dtile-i/g) || []).length;
t('5 every rendered tile carries an icon (the icon IS the visible label)',
  iconCount(html) === 6, `${iconCount(html)} icon(s) across 6 tiles`);
t('6 it leads the voice group (before Voice)', html.indexOf('>Voice profile<') < html.indexOf('>Voice<'));
t('7 it sits after Photos', html.indexOf('>Photos<') < html.indexOf('>Voice profile<'));
t('8 the spacer is gone now the grid is full', !html.includes('is-spacer'));
t('9 Theme did NOT come back as a tile (it lives on the header swatch)', !html.includes('>Theme<'));

// No NAMED profile => no tile at all (§7). With only Default there is nothing to assign.
ACCOUNT = { ai: { defaultPersonalityId: 'dashie' } };
const html2 = DC._renderSimpleSettings(device, {});
t('10 no named profile => no tile', !html2.includes('>Voice profile<'));
t('11 ...and the spacer returns so the 2-column rhythm holds', html2.includes('is-spacer'));
t('12 CONTROL: the other five tiles still render in that state',
  html2.includes('>Voice<') && html2.includes('>Personality<') && html2.includes('>Sleep<'));
t('12b CONTROL: the icon count tracks the tile count (so leg 5 can fail)',
  iconCount(html2) === 5, `${iconCount(html2)} icon(s) across 5 tiles`);

// The account store answering null (not loaded yet) must render no tile, not an empty one.
ACCOUNT = null;
t('13 account not loaded yet => no tile, no throw', !DC._renderSimpleSettings(device, {}).includes('>Voice profile<'));

console.log(`check-device-card-tiles: ${pass} pass, ${fail} fail`);
if (!fail) console.log('\u2705 the card tile grid renders and every tile targets its own device');
process.exit(fail ? 1 : 0);
