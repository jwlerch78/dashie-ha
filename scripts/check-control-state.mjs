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
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

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

// ── 15 Admin Actions: availability is a RESOLVE question, not a STATE one ───
// John, 2026-10-03: "fix the dead admin commands on settings". All six rows were
// disabled forever, titled "Not supported on this device", on a Fire TV that
// supports all six. `metrics.controls` is built from METRIC_MAP, which mirrors
// switch/number/sensor STATE — a button has no state, so no button role was ever
// in it. Measured on the live box the same day: button.fire_tv_restart_app etc.
// all exist, so the press path was fine the whole time; only the gate lied.
//
// 🔴 The near-miss this leg exists to pin: `entityIds[role]` is NOT the fix.
// There are THREE names per control (Console role / entity_id suffix / the
// integration's unique_id tail), and they disagree for exactly the broken ones.
// relaunch is `restart_app` as an entity and `restart` as an entityIds key. So
// keying on the role lights up three buttons and leaves three dead — which reads
// precisely like a working fix.
const { availableControlRoles, resolveControlEntityId } =
  require(`${ROOT}/dashie-ha/server/ha-control-map.js`);

// Keys as ha-metrics really writes them (unique_id tails), entities as HA really
// names them (entity_id tails). Both halves taken from source + a live read.
const realLookup = (suffix) => ({
  refresh_webview: 'button.probe_refresh_webview',
  restart:         'button.probe_restart_app',
  foreground:      'button.probe_bring_to_foreground',
}[suffix]);
const realEntities = new Set([
  'button.probe_refresh_webview', 'button.probe_restart_app',
  'button.probe_bring_to_foreground', 'button.probe_clear_cache', 'button.probe_clear_storage',
]);  // deliberately NO button.probe_reboot_device
const roles = availableControlRoles({
  lookupEntityId: realLookup, slug: 'probe',
  hasEntity: (id) => realEntities.has(id),
});
t('15 the two roles whose entityIds key differs from their entity suffix resolve anyway',
  roles.includes('relaunch') && roles.includes('bring_to_foreground'),
  `relaunch/bring_to_foreground missing from [${roles}] — the name mismatch is back`);
t('15a ...and the ones keyed identically still resolve',
  roles.includes('refresh') && roles.includes('clear_cache') && roles.includes('clear_storage'));
t('15b CONTROL: a role whose entity HA does NOT have is absent (a leg that can fail)',
  !roles.includes('reboot'),
  'reboot was listed although button.probe_reboot_device is not in the fixture');

t('15c /api/ha/control resolves through the SAME function, not its own copy',
  (() => { const api = readFileSync(`${ROOT}/dashie-ha/server/api/ha.js`, 'utf8');
           return /resolveControlEntityId\(/.test(api)
             && !/`\$\{map\.domain\}\.\$\{slug\}_\$\{map\.suffix\}`/.test(api); })(),
  'the gate and the press must not be able to drift — that is how the tooltip lied');

// ── 15d-f the rendered rows, driven through the top-level detail render ─────
// _renderAdminSection ignores its `m` argument now, so no caller can hand it the
// answer (trap 13) — but drive render() anyway, since that is what a user sees.
const adminBtn = (html, role) => {
  const i = html.indexOf(`'${DEV_ID}', '${role}'`);
  if (i < 0) return null;
  const a = html.lastIndexOf('<button', i);
  return a < 0 ? null : html.slice(a, html.indexOf('</button>', a));
};
const fresh0 = DP._haStatus.lastRun.freshDevices[0];

// Admin Actions ships COLLAPSED (defaultExpanded: false), and _section() emits
// the body only when expanded — so the first version of these legs anchored on
// markup that was never in the render, and four of them "failed" for reasons
// that had nothing to do with the fix. Expand it, then PROVE the body arrived
// before asserting anything about it.
DD._loadSections();
DD._sectionExpanded.admin = true;

fresh0.available_controls = ['relaunch'];
let dh = detailHtml();
t('15d0 the admin body is actually in the render (guard: the next legs are blind without it)',
  dh.includes('Reboot Device') && dh.includes('_pressDestructive'),
  'the section rendered header-only — every leg below would pass or fail by accident');
t('15d a supported admin row is live, and its own button is the anchor',
  adminBtn(dh, 'relaunch') && !/disabled/.test(adminBtn(dh, 'relaunch')),
  'Relaunch stayed disabled although the worker published it as available');
t('15e ...while an unpublished row on the SAME render stays disabled',
  /disabled/.test(adminBtn(dh, 'reboot') || ''),
  'reboot enabled although it was not in available_controls — the gate is a no-op');
t('15f ...and says the true reason, not "not supported"',
  /Not supported on this device/.test(adminBtn(dh, 'reboot') || ''));

fresh0.available_controls = [];
t('15g CONTROL: an empty list disables the row 15d just enabled',
  /disabled/.test(adminBtn(detailHtml(), 'relaunch') || ''),
  'the enabled state in 15d did not come from available_controls at all');

delete fresh0.available_controls;
t('15h unknown is NOT the same as none — the accessor returns null',
  DP._availableControlsForDevice(DEV_ID) === null);
t('15i ...and the row says so rather than asserting unsupported',
  (() => { const b = adminBtn(detailHtml(), 'reboot') || '';
           return /Still reading/.test(b) && !/Not supported/.test(b); })(),
  'a device the worker has not answered for yet was told it lacks the feature');
fresh0.available_controls = ['relaunch'];

t('15j the old state-derived gate cannot come back',
  !/controls\[a\.role\]/.test(detailSrc),
  'metrics.controls can never contain a button role — that was the bug');

// ── 15k end to end: the real extractor, on states shaped like the real box ──
const haMetrics = require(`${ROOT}/dashie-ha/server/ha-metrics.js`);
const ADMIN = ['refresh', 'relaunch', 'bring_to_foreground', 'clear_cache', 'clear_storage', 'reboot'];
const mkStates = (slug, name, buttons) => [
  { entity_id: `sensor.${slug}_device_id`, state: `${slug}-id`,
    attributes: { friendly_name: `${name} Device ID` } },
  ...buttons.map(b => ({ entity_id: `button.${slug}_${b}`, state: 'unknown',
    attributes: { friendly_name: `${name} ${b}` } })),
];
const e2e = haMetrics.buildDeviceMetrics([
  ...mkStates('probe_tv', 'Probe TV',
    ['refresh_webview', 'restart_app', 'bring_to_foreground', 'clear_cache', 'clear_storage', 'reboot_device']),
  ...mkStates('bare_tv', 'Bare TV', []),
]);
const probe = e2e.find(d => d.slug === 'probe_tv');
const bare  = e2e.find(d => d.slug === 'bare_tv');
t('15k buildDeviceMetrics publishes all six admin roles for a fully-equipped device',
  ADMIN.every(r => probe?.availableControls?.includes(r)),
  `got [${probe?.availableControls}]`);
t('15l CONTROL: a device with no button entities publishes none of them',
  ADMIN.every(r => !bare?.availableControls?.includes(r)),
  `a bare device claimed [${bare?.availableControls}] — availability is not being read`);
t('15m CONTROL: the OLD gate would have found zero on the equipped device',
  ADMIN.every(r => probe?.metrics?.controls?.[r] === undefined),
  'metrics.controls now carries button roles, so this gate is measuring the wrong thing');

console.log(`check-control-state: ${pass} pass, ${fail} fail`);
if (!fail) console.log('✅ one control, one state: clicks land and stale polls cannot walk them back');
process.exit(fail ? 1 : 0);
