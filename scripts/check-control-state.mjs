#!/usr/bin/env node
/**
 * check-control-state — a live device control has ONE state, and a click on it
 * is acknowledged and not walked back by a stale poll.
 *
 * ── WHY (John, 2026-09-30, on the Office Fire TV Stick) ─────────────────────
 * "When I click the dark/light icon from the device card it doesn't do anything"
 * and "from the full settings page it started oscillating on one click and
 * didn't do anything on another. It also doesn't reliably show the current
 * state." Two symptoms, one defect, in opposite directions:
 *
 *   devices-card.js    rendered from `fresh?.metrics || device.metrics`  (5s)
 *   devices-detail.js  rendered from `device.metrics`                    (30s)
 *   toggleSwitch()     wrote its optimistic value into `device.metrics`
 *
 * So the card's optimistic write landed in an object the card never read (pill
 * could not move), while on the detail page it DID land and the next 30s
 * refresh overwrote it with a stale row (pill flipped back, then forward).
 *
 * 🔴 WHAT NO STATIC GATE COULD HAVE SEEN. Every one of those lines is correct
 * in its own file. The defect is the DISAGREEMENT between two files plus a
 * write aimed at the third reading. So this gate DRIVES the real holder and the
 * real renderers and compares the two surfaces' answers to each other -- it
 * does not pattern-match source, except in the two legs that exist to stop the
 * old shape coming back.
 *
 * ⚠️ Leg 7 asserts the DROP warn actually FIRES on an unsettled expiry (O's
 * requirement, and the right one): an un-exercised warn path is how "we log
 * that" silently becomes false. A pending value that expires QUIETLY is a
 * second version of the bug being fixed -- the pill reverts and nothing says
 * why.
 *
 * Exit 0 = every leg passes · 1 = a violation or a render throw · 2 = BLIND.
 */
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const C = `${ROOT}/dashie-ha/frontend/console/js`;
for (const f of ['lib/device-control-state.js', 'pages/devices.js', 'pages/devices-card.js', 'pages/devices-detail.js']) {
  if (!existsSync(`${C}/${f}`)) { console.log(`BLIND: ${f} not found`); process.exit(2); }
}

/**
 * A collaborator stub that answers any un-named method with a no-op returning
 * ''. The modal surface on the detail page is ~30 renderers, none of which this
 * gate is about; hand-stubbing them one error at a time is how a gate ends up
 * measuring its own scaffolding. Everything whose VALUE matters is named
 * explicitly below and takes precedence.
 */
const modalStub = (real) => new Proxy(real, {
  get: (t, k) => (k in t ? t[k] : () => ''),
  has: () => true,
});

const warns = [];
const sandbox = {
  console: { log(){}, warn(m){ warns.push(String(m)); }, error(){} },
  document: { title:'', querySelector: () => null, visibilityState:'visible' },
  localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
  // Real sessionStorage-shaped stub: DevicesPage._techView is a GETTER that
  // reads it, so without this the gate can only ever exercise ONE of the card's
  // two render paths — and both of them had the defect.
  sessionStorage: { _v:{}, getItem(k){ return this._v[k] ?? null; }, setItem(k,x){ this._v[k]=String(x); }, removeItem(k){ delete this._v[k]; } },
  DashieAuth: { isAddonMode:true, isLocalMode:false, _addonUrl:(p)=>p, async dbRequest(){ return { devices: [] }; } },
  FeatureGate: { isAddonMode:()=>true, isPageEnabled:()=>true, optionAllowed:()=>true, hasAccount:()=>true },
  ConsoleState: { dismiss(){}, restore(){}, isDismissed:()=>false },
  Toast: { success(){}, error(){}, friendly:(e)=>String(e) },
  App: { renderPage(){} },
  DevicesDetailModals: modalStub({
    personalityName: () => 'Friendly', immichAlbumSummary: () => 'Album',
    buildThemeSummary: () => 'Default', _profileNow: () => 'Default',
    voiceSetupSummary: () => ({ custom:false, label:'Cloud' }),
    buildSleepSummary: () => '10pm', _formatTimeout: () => '5 min',
    photoAlbumSummary: () => 'All', wakeWordLabel: () => 'Hey Dashie',
    sleepModeOf: () => 'schedule', _sleepNow: () => '10pm', buildPhotoSummary: () => 'All',
    sleepEffective: () => ({ enabled:true, sleepTime:'22:00', wakeTime:'06:30' }),
    wakeWordName: () => 'Hey Dashie', _accountSettings: {},
  }),
  DevicesRename: { conflictHaName:()=>null, conflictDevices:()=>[], renderBanner:()=>'', renderNameRow:()=>'' },
  DevicesClaim: { renderBanner:()=>'', fetch: async()=>{} },
  DevicesCamera: modalStub({ _open:false }),
  DevicesEvents: { start(){}, stop(){} },
  HistoryChart: { render:()=>'' },
  iconImg: (f) => `<img src="${f}">`,
  VoiceAiApi: { DEFAULTS: {}, defaultWakeWord: () => 'hey_dashie' },
  AccountSettingsStore: { get: () => null, ensure(){} },
  VoiceProfileKeys: { named: () => ({}), inherited: () => ({ value: '' }), DEFAULT_PROFILE_ID: 'default' },
  VoicePipelineSummary: { parts: () => null, profileName: () => 'Default' },
  HaEngines: { raw: null, loaded: true },
  setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: async () => { throw new Error('no network'); },
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
const load = (f) => vm.runInContext(readFileSync(`${C}/${f}`,'utf8'), ctx, { filename: f });
load('lib/brand.js');
load('lib/device-control-state.js');
load('pages/devices.js');
load('pages/devices-card.js');
load('pages/devices-detail.js');

const DCS = vm.runInContext('DeviceControlState', ctx);
const DP  = vm.runInContext('DevicesPage', ctx);
const DC  = vm.runInContext('DevicesCard', ctx);
const DD  = vm.runInContext('DevicesDetail', ctx);

let pass = 0, fail = 0;
const t = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); } };

// ── the fixture: a device whose 30s CACHED row and 5s FRESH feed DISAGREE ────
// This is the whole shape of the bug. The cached row says light; the worker
// feed says dark. Before the fix the card read one and the detail page the
// other, and they showed the user different things about the same tablet.
const DEV_ID = 'dev-firetv';
const mkDevice = () => ({
  device_id: DEV_ID, device_type: 'tv', device_name: 'Office Fire TV Stick',
  is_active: true, last_seen_at: new Date().toISOString(),
  settings: { display: { themeFamily: 'default', darkMode: true }, sleep: {}, aiVoice: {}, photos: {}, voice: {} },
  // the STALE 30s row. `battery.level` is deliberately not a control: it is how
  // the `m` derivation gets tested BEHAVIOURALLY (see leg 3b).
  metrics: { controls: { dark_mode: false, screen: true, lock: false, volume: 3 }, battery: { level: 99 } },
});
let device = mkDevice();
DP._devices = [device];
DP._liveOverrides = {};
DP._haStatus = { lastRun: { freshDevices: [
  { device_id: DEV_ID, has_live_data: true,
    metrics: { controls: { dark_mode: true, screen: true, lock: false, volume: 3 }, battery: { level: 42 } } },  // the FRESH 5s feed
] } };

// ── 1-2 the holder owns the precedence, in one place ────────────────────────
t('1 metricsFor prefers the 5s worker feed over the 30s cached row',
  DCS.metricsFor(device).controls.dark_mode === true,
  JSON.stringify(DCS.metricsFor(device).controls));
t('2 CONTROL: with no fresh feed it falls back to the cached row (a leg that can fail)',
  (() => { const saved = DP._haStatus; DP._haStatus = null;
           const v = DCS.metricsFor(device).controls.dark_mode; DP._haStatus = saved; return v === false; })());

// ── 3 THE CORE DEFECT: the two surfaces must agree ──────────────────────────
// 🔴 These drive the TOP-LEVEL render(), never an inner helper with an `m` the
// gate built itself. The first version called
// `_renderQuickControls(device, DCS.metricsFor(device), …)` -- passing the
// correct `m` IN -- so it stayed green with the page's own `m = device.metrics`
// derivation fully reverted. A probe that supplies the thing under test
// measures itself. (Caught by fault injection, not by reading it.)
//
// ⚠️ And it anchors on the PILL, not on `icon-moon.svg` appearing anywhere:
// the Sleep tile uses that same icon, so an html.includes() check was true
// before and after and could not detect the change. The boolean baked into the
// pill's own onclick is the state the surface actually resolved, and the title
// is the user-visible claim; both are asserted, on both surfaces.
const darkPill = (html) => {
  const onclick = (html.match(/toggleSwitch\('[^']*',\s*'dark_mode',\s*(true|false)\)/) || [])[1];
  const title = /Dark mode — tap for light/.test(html) ? 'dark'
              : (/Light mode — tap for dark/.test(html) ? 'light' : null);
  return { onclick, title };
};
const showsDark  = (h) => { const p = darkPill(h); return p.onclick === 'true'  && p.title === 'dark'; };
const showsLight = (h) => { const p = darkPill(h); return p.onclick === 'false' && p.title === 'light'; };

// Both card layouts, because both had the defect: the simple card's pill row
// and the tech card's media row are separate copies of the same three reads.
const cardHtml = (tech) => { DP.setTechView(tech); return DC.render(device); };
const detailHtml = () => { DP._detailDeviceId = DEV_ID; return DD.render(device); };
DCS.reset();
t('3 card (both layouts) and detail all resolve the SAME value',
  DCS.resolve(device, 'dark_mode') === true
  && showsDark(cardHtml(false)) && showsDark(cardHtml(true)) && showsDark(detailHtml()),
  `simple=${JSON.stringify(darkPill(cardHtml(false)))} tech=${JSON.stringify(darkPill(cardHtml(true)))} detail=${JSON.stringify(darkPill(detailHtml()))}`);
t('3a CONTROL: the fixture\'s two sources really do disagree, or leg 3 proves nothing',
  device.metrics.controls.dark_mode === false
  && DP._haStatus.lastRun.freshDevices[0].metrics.controls.dark_mode === true);
// 🔴 Leg 3 canNOT catch a page reverting to `m = device.metrics`, and that is
// not a weakness to paper over -- it is a fact about the fix. `resolve()` reads
// `metricsFor()` itself, so a CONTROL is correct on both surfaces even if the
// page's own `m` is stale. What a stale `m` still breaks is every metric that is
// NOT a control. So the `m` derivation gets its own behavioural leg, on a
// non-control metric, and leg 12 keeps guarding the source shape. Discovered by
// fault injection: fault A (detail page back on the 30s row) was caught by leg
// 12 alone, and reading leg 3's name would have told you otherwise.
t('3b the detail page renders NON-control metrics from the 5s feed too',
  detailHtml().includes('42%') && !detailHtml().includes('99%'),
  'the page is still deriving `m` from the 30s cached row');

// ── 4 a click is acknowledged immediately ──────────────────────────────────
DCS.reset();
DCS.note(DEV_ID, 'dark_mode', false);          // the user clicks "go light"
t('4 a click is reflected at once, before the device has reported anything',
  DCS.resolve(device, 'dark_mode') === false);
t('4a ...and the pill moves on BOTH card layouts (driven through render())',
  showsLight(cardHtml(false)) && showsLight(cardHtml(true)),
  `simple=${JSON.stringify(darkPill(cardHtml(false)))} tech=${JSON.stringify(darkPill(cardHtml(true)))}`);
t('4b ...and on the detail page with it',
  showsLight(detailHtml()), JSON.stringify(darkPill(detailHtml())));

// ── 5 THE OSCILLATION FIX: a stale poll may not walk it back ────────────────
// The worker feed still says dark (it has not caught up). Before the fix this
// is the moment the pill flipped back.
t('5 a poll that still disagrees does NOT revert the pending value',
  DCS.resolve(device, 'dark_mode') === false,
  'a stale poll walked back a change the user just made — this is the oscillation');

// ── 6 settlement on observation ────────────────────────────────────────────
DP._haStatus.lastRun.freshDevices[0].metrics.controls.dark_mode = false;  // device agrees
t('6 pending clears the moment the device agrees',
  DCS.resolve(device, 'dark_mode') === false && DCS.isPending(DEV_ID, 'dark_mode') === false);
DP._haStatus.lastRun.freshDevices[0].metrics.controls.dark_mode = true;   // device moves on its own
t('6a ...so a later genuine change from the device is shown, not suppressed',
  DCS.resolve(device, 'dark_mode') === true);

// ── 7 TTL expiry, and it is LOUD (O's requirement) ─────────────────────────
DCS.reset(); warns.length = 0;
DCS.note(DEV_ID, 'dark_mode', false);
DCS._pending[`${DEV_ID}:dark_mode`].at = Date.now() - (DCS.PENDING_TTL_MS + 1000);
const expired = DCS.resolve(device, 'dark_mode');
t('7 an unsettled pending value expires back to the device\'s own value', expired === true);
t('7a ...and says so LOUDLY with a grep-able DROP marker',
  warns.some(w => w.startsWith('DROP:') && w.includes('dark_mode') && w.includes(DEV_ID)),
  `warns seen: ${JSON.stringify(warns)}`);
t('7b CONTROL: a pending value that has NOT expired warns nothing',
  (() => { DCS.reset(); warns.length = 0; DCS.note(DEV_ID, 'dark_mode', false);
           DCS.resolve(device, 'dark_mode'); return warns.length === 0; })());

// ── 8 a role nobody renders still cannot age out in silence ────────────────
DCS.reset(); warns.length = 0;
DCS.note(DEV_ID, 'camera_stream_enabled', true);
DCS._pending[`${DEV_ID}:camera_stream_enabled`].at = Date.now() - (DCS.PENDING_TTL_MS + 1000);
DCS.note(DEV_ID, 'screen', false);   // any later click sweeps
t('8 sweep() expires an un-rendered role and warns',
  warns.some(w => w.startsWith('DROP:') && w.includes('camera_stream_enabled')),
  `warns seen: ${JSON.stringify(warns)}`);

// ── 9 the failure path drops the intent ────────────────────────────────────
DCS.reset();
DCS.note(DEV_ID, 'screen', false);
DCS.forget(DEV_ID, 'screen');
t('9 forget() drops the intent so a failed command shows the truth',
  DCS.resolve(device, 'screen') === true);

// ── 9b the settings chip is DISCOVERABLE on every live card layout ──────────
// John, 2026-10-02: "it's not intuitive that clicking on the card goes to
// settings." The card was always clickable; nothing said so. Driven through
// render(), because the defect this guards against is a chip added to one of
// the card's layouts and not the other.
const chip = (h) => (h.match(/aria-label="Open device settings"/g) || []).length;
t('9b the settings chip renders on BOTH live card layouts',
  chip(cardHtml(false)) === 1 && chip(cardHtml(true)) === 1,
  `simple=${chip(cardHtml(false))} tech=${chip(cardHtml(true))}`);
// 🔴 This leg must read the CHIP'S OWN button, not the page. Its first version
// tested the whole card html for `stopPropagation(); showDetail('dev-firetv')`
// and passed with stopPropagation deleted from the chip — because the footer's
// "All settings >" link carries the identical onclick. An anchor that is not
// unique to the subject is not an anchor. (Caught by fault injection.)
const chipBtn = (h) => {
  const i = h.indexOf('aria-label="Open device settings"');
  if (i < 0) return '';
  return h.slice(h.lastIndexOf('<button', i), h.indexOf('</button>', i));
};
t('9c ...and it opens THIS device, with stopPropagation so the card handler cannot double-fire',
  /event\.stopPropagation\(\);\s*DevicesPage\.showDetail\('dev-firetv'\)/.test(chipBtn(cardHtml(false)))
  && /event\.stopPropagation\(\);\s*DevicesPage\.showDetail\('dev-firetv'\)/.test(chipBtn(cardHtml(true))),
  JSON.stringify(chipBtn(cardHtml(false)).slice(0, 180)));

// ── 10-12 the old shapes may not come back ─────────────────────────────────
// Comments are stripped first: a doc block that QUOTES the old shape is not a
// violation of it, and a gate that counts its own prose reports itself.
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const cardSrc   = strip(readFileSync(`${C}/pages/devices-card.js`, 'utf8'));
const detailSrc = strip(readFileSync(`${C}/pages/devices-detail.js`, 'utf8'));

t('10 no surface WRITES device.metrics.controls any more (the unread object)',
  !/device\.metrics\.controls\s*(\[|=)/.test(cardSrc) && !/device\.metrics\.controls\s*(\[|=)/.test(detailSrc),
  (cardSrc.match(/.*device\.metrics\.controls.*/g) || []).join(' | '));
t('11 no surface READS a control straight off device.metrics, bypassing the holder',
  !/device\.metrics\??\.controls/.test(cardSrc) && !/device\.metrics\??\.controls/.test(detailSrc),
  'the lock chip read the 30s row directly while the pill beside it read the 5s feed');
t('12 neither page writes the fresh-over-cached precedence inline any more',
  !/fresh\?\.metrics\s*\|\|/.test(cardSrc) && !/=\s*device\.metrics\s*\|\|\s*\{\}/.test(detailSrc),
  'a second copy of the precedence is a second thing to get wrong');

// ── 13 the phantom settings key ────────────────────────────────────────────
t('13 the card reads display.darkMode, not the phantom display.displayMode',
  !/displayMode/.test(cardSrc) && /display\?\.darkMode/.test(cardSrc),
  'display.displayMode exists nowhere in the estate — that indicator never lit');

// ── 14 the holder is actually SHIPPED, not just written ────────────────────
const html = readFileSync(`${C}/../index.html`, 'utf8');
const idx = (s) => html.indexOf(s);
t('14 device-control-state.js is loaded by index.html', idx('js/lib/device-control-state.js') > 0);
t('14a ...before every page that renders through it',
  idx('js/lib/device-control-state.js') < idx('js/pages/devices.js')
  && idx('js/lib/device-control-state.js') < idx('js/pages/devices-card.js')
  && idx('js/lib/device-control-state.js') < idx('js/pages/devices-detail.js'),
  'a holder defined after its callers is a ReferenceError at first render');

console.log(`check-control-state: ${pass} pass, ${fail} fail`);
if (!fail) console.log('✅ one control, one state: clicks land and stale polls cannot walk them back');
process.exit(fail ? 1 : 0);
