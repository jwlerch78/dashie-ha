#!/usr/bin/env node
/**
 * check-fanout-scope — "Also apply to" copies THE CHANGE, not the whole dialog.
 *
 * ── WHY (John, 2026-09-25) ──────────────────────────────────────────────────
 * He changed a wake time from 7:00 to 6:30 and applied it to his Mio tablets. It
 * also DISABLED "show clock during sleep" on them.
 *
 * Two faults, and the second is the one that made it data loss:
 *   · _fanOutTo copied every key the dialog manages, so one edit stamped nine.
 *   · sleepEffective() RESOLVES an absent toggle to `false`. The source device had
 *     never had an opinion about the clock, so the fan-out did not copy a choice —
 *     it manufactured one and wrote it to devices where the setting was deliberately
 *     on. Nothing errored; the write lands and reports success.
 *
 * John's ruling: *"apply this change to is the right approach."*
 *
 * 🔴 DRIVEN. It loads the shipped modules and captures what reaches
 * update_device_settings. check-apply-targets is static and cannot see this: the
 * spec list was CORRECT the whole time — it is supposed to contain all nine keys, so
 * that gate was green while the fan-out wrote all nine on a one-field edit.
 *
 * Exit 0 = only the change travels · 1 = a violation · 2 = BLIND.
 */
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const B = `${ROOT}/dashie-ha/frontend/console/js/pages`;
for (const f of ['devices.js', 'devices-detail-modals.js']) {
  if (!existsSync(`${B}/${f}`)) { console.log(`BLIND: ${f} not found`); process.exit(2); }
}

const writes = [];
const sandbox = {
  console: { log(){}, warn(){}, error(){}, info(){} },
  document: { title:'', querySelector: () => null, visibilityState:'visible', addEventListener(){} },
  localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
  sessionStorage: { getItem: () => null, setItem(){}, removeItem(){} },
  DashieAuth: {
    isAddonMode:false, isLocalMode:false, isHaContext:true, isAuthenticated:true,
    async dbRequest(op, args) { writes.push({ op, ...args }); return {}; },
    async _broadcastDeviceSettingsChanged() { return {}; },
  },
  FeatureGate: { isAddonMode:()=>false, isPageEnabled:()=>true, optionAllowed:()=>true, filterOptions:(k,o)=>o },
  ConsoleState: { isDismissed: () => false, dismiss(){}, restore(){} },
  Toast: { success(){}, error(){}, info(){}, friendly:(e)=>String(e) },
  App: { renderPage(){}, navigate(){} },
  BRAND: { assistantName:'Dashie', consoleName:'Dashie Console', cloudName:'Dashie Cloud' },
  VoiceAiApi: { DEFAULTS:{}, defaultWakeWord:()=>'hey_dashie' },
  AccountSettingsStore: { get: () => ({}), set(){}, ensure(){} },
  VoiceProfileKeys: { named: () => null, inherited: () => null, DEFAULT_PROFILE_ID:'default' },
  HaEngines: { raw: null, loaded: true },
  iconImg: () => '',
  setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: async () => { throw new Error('no network'); },
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(readFileSync(`${B}/devices.js`,'utf8'), ctx, { filename:'devices.js' });
  vm.runInContext(readFileSync(`${B}/devices-detail-modals.js`,'utf8'), ctx, { filename:'devices-detail-modals.js' });
} catch (e) { console.log(`BLIND: modules did not evaluate: ${e.message}`); process.exit(2); }

const P = vm.runInContext('DevicesPage', ctx);
const M = vm.runInContext('DevicesDetailModals', ctx);
if (!P?._onSettingChange || !M?._fanOutTo) { console.log('BLIND: entry points missing'); process.exit(2); }

let pass=0, fail=0;
const t=(n,c,d)=>{ if(c){pass++;console.log(`  PASS  ${n}`);} else {fail++;console.log(`  FAIL  ${n}${d?' — '+d:''}`);} };

// 🔴 THE FIXTURE IS JOHN'S. Source has NO sleepShowClock key at all — that absence is
// what sleepEffective() used to resolve to false and write over the Mios' `true`.
const src = { device_id:'src', device_name:'Kitchen', is_active:true,
  last_seen_at: new Date().toISOString(),
  settings:{ sleep:{ enabled:true, sleepMethod:'schedule', sleepTime:'22:00', wakeTime:'07:00' }, display:{} } };
const mio = { device_id:'mio', device_name:'Mio', is_active:true,
  last_seen_at: new Date().toISOString(),
  settings:{ sleep:{ enabled:true, sleepMethod:'schedule', sleepTime:'22:00', wakeTime:'07:00', sleepShowClock:true }, display:{} } };
P._devices = [src, mio];
P._saving = {};

const openSleep = () => { M._resetAlso(); M._sleepOpen = true; M._sleepDeviceId = 'src';
  M._themeOpen = M._photosOpen = M._personalityOpen = M._voiceOpen = M._voiceSetupOpen = M._profileOpen = false; };

// ── 1. one edit travels alone ───────────────────────────────────────────────
openSleep();
M._alsoTargets = new Set(['mio']);
M.noteAlsoChange('sleep', 'wakeTime');
src.settings.sleep.wakeTime = '06:30';
writes.length = 0;
await M._fanOutTo(['mio']);
const sent = writes.filter((w) => w.op === 'update_device_settings');
t('1 the fan-out wrote to the ticked device', sent.length === 1, `${sent.length} write(s)`);
const payload = sent[0]?.settings_value || {};
t('2 it carried the changed key', payload.wakeTime === '06:30', JSON.stringify(payload));
t('3 🔴 and NOTHING else — sleepShowClock was never touched',
  !('sleepShowClock' in payload), `payload = ${JSON.stringify(payload)}`);
t('4 ...nor the other seven keys the dialog manages',
  Object.keys(payload).length === 1, `payload = ${JSON.stringify(payload)}`);

// ── 2. the exact regression, asserted as a value not an absence ─────────────
t('5 the Mio would keep its clock', mio.settings.sleep.sleepShowClock === true);

// ── 3. applying with no edit copies nothing ────────────────────────────────
openSleep();
M._alsoTargets = new Set(['mio']);
writes.length = 0;
await M._fanOutTo(['mio']);
t('6 nothing changed => nothing written', writes.length === 0, `${writes.length} write(s)`);

// ── 4. CONTROLS — the harness can see a write, and two edits both travel ───
openSleep();
M._alsoTargets = new Set(['mio']);
M.noteAlsoChange('sleep', 'wakeTime');
M.noteAlsoChange('sleep', 'sleepShowClock');
src.settings.sleep.sleepShowClock = false;
writes.length = 0;
await M._fanOutTo(['mio']);
const p2 = writes[0]?.settings_value || {};
t('7 CONTROL two edits both travel', p2.wakeTime === '06:30' && p2.sleepShowClock === false, JSON.stringify(p2));
t('8 CONTROL a deliberately changed toggle IS copied', 'sleepShowClock' in p2);

console.log(`check-fanout-scope: ${pass} pass, ${fail} fail`);
if (fail) { console.error(`\ncheck-fanout-scope FAILED (${fail} leg(s))`); process.exit(1); }
console.log('✅ "Also apply to" carries the change and only the change');
