#!/usr/bin/env node
/**
 * check-bluetooth-surface — the per-tablet Bluetooth chip, server half and card half.
 *
 * ── WHY EACH LEG EXISTS ─────────────────────────────────────────────────────
 * Every one of these is a trap that a hand-written fixture gets wrong while
 * looking right, so each is phrased so a wrong implementation turns it RED.
 *
 * 1 THE STATE IS THE COUNT. `ble_entities.py`'s own docstring forbids re-deriving
 *   it from `devices`: "a second derivation is a second source of truth, and the
 *   two would disagree the moment one of them was changed." `devices` holds every
 *   device THIS TABLET hears, including ones HA prefers another receiver for, so
 *   it is the larger list. A `devices.length` implementation passes a fixture
 *   where they happen to match and is wrong in the field.
 *
 * 2 ...BUT THEY ARE OFTEN EQUAL, and that is not a bug. They match whenever
 *   nothing this tablet hears is better-heard elsewhere — i.e. EVERY SINGLE-TABLET
 *   HOUSEHOLD, the commonest deployment. A relayed instruction to assert
 *   `devices.length > count` would read as rigour and fire falsely for most users.
 *   Leg 2 is the control that keeps anyone from adding it.
 *
 * 3 UNAVAILABLE IS NOT ZERO. 0 means "scanning, nothing claimed yet" — the benign
 *   setup state. `unavailable` means the bridge is down. `Number('unavailable')` is
 *   NaN and `Number(null)` is 0, so a naive coercion reports a dead bridge as a
 *   working idle one. `toNum()` maps both to null; using it IS the fix.
 *
 * 4 THE CHIP RENDERS WITH NO VALUE, alone among card chips. Battery/RAM/Wi-Fi are
 *   omitted on null. John ruled for a greyed chip over omission (2026-10-06), so a
 *   broken bridge cannot look like a tablet that never had one. The distinction
 *   that makes it safe: `m.bluetooth` present = the tablet HAS the sensor; no key
 *   at all = no chip, exactly as before. Leg 10 holds that line.
 *
 * Exit 0 = every leg passes, 1 = a violation, 2 = cannot check.
 */
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = `${ROOT}/dashie-ha/server/ha-metrics.js`;
const CARD = `${ROOT}/dashie-ha/frontend/console/js/pages/devices-card.js`;
const ICON = `${ROOT}/dashie-ha/frontend/console/assets/icons/icon-bluetooth.svg`;
for (const f of [SERVER, CARD, ICON]) {
    if (!existsSync(f)) { console.log(`BLIND: ${f.replace(ROOT + '/', '')} not found`); process.exit(2); }
}

let pass = 0, fail = 0;
const t = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); } };

// ── SERVER HALF: the real METRIC_MAP entry ──────────────────────────────────
const { METRIC_MAP } = require(SERVER);
const map = METRIC_MAP['bluetooth_devices'];
if (typeof map !== 'function') {
    console.log("BLIND: METRIC_MAP['bluetooth_devices'] is not a function — the role key is wrong.");
    console.log('       The sensor sets unique_id = f"{device_id}_bluetooth_devices" and');
    console.log('       _roleFromUniqueId strips the "<device_id>_" prefix, so the key is the suffix.');
    process.exit(2);
}
const bt = (state, devices) => map({ state, attributes: devices === undefined ? {} : { devices } }).bluetooth;

// 5 heard, 3 claimed — the multi-tablet case. A devices.length implementation says 5.
const multi = bt('3', [
    { name: 'Living Room Speaker', address: 'A4:C1:38:9F:2E:01', via: 'this', rssi: -54 },
    { name: "Jack's Watch", address: 'C4:7C:8D:6A:2B:19', via: 'this', rssi: -71 },
    { name: '', address: 'E8:2A:44:10:B7:3C', via: 'this', rssi: -88 },
    { name: 'Kitchen Sensor', address: 'D1:55:9B:00:14:AF', via: 'other', rssi: -49 },
    { name: 'Garage Door', address: 'F0:18:98:2C:77:6E', via: 'other', rssi: -66 },
]);
t('1 count comes from the STATE, not devices.length', multi.count === 3,
  `state was "3" with 5 devices — got ${multi.count}`);
t('1a ...and the full devices list is still carried through', multi.devices.length === 5);

// Single-tablet: every device claimed. count === devices.length, and that is CORRECT.
const single = bt('2', [
    { name: 'Living Room Speaker', address: 'A4:C1:38:9F:2E:01', via: 'this', rssi: -54 },
    { name: 'Hallway Motion', address: 'B6:33:7D:91:0C:52', via: 'this', rssi: -62 },
]);
t('2 CONTROL: count EQUALS devices.length in a single-tablet household, and that is fine',
  single.count === 2 && single.devices.length === 2,
  'an assertion of strict devices.length > count would fire falsely for most users');

t('3 unavailable maps to NULL, not 0', bt('unavailable', []).count === null,
  'a dead bridge would report as a working idle one');
t('3a unknown maps to NULL too', bt('unknown', []).count === null);
t('3b CONTROL: a real zero stays 0 and is NOT null', bt('0', []).count === 0,
  '0 is "scanning, nothing claimed yet" — the benign setup state');
t('3c ...so unavailable and zero are distinguishable', bt('unavailable', []).count !== bt('0', []).count);
t('4 a missing devices attribute yields [] rather than undefined',
  Array.isArray(bt('0', undefined).devices) && bt('0', undefined).devices.length === 0);
t('4a a non-array devices attribute is not passed through raw',
  Array.isArray(map({ state: '1', attributes: { devices: 'nope' } }).bluetooth.devices));

// Field spellings the fixture must not "tidy".
const d = multi.devices;
t('5 address stays UPPER-case', d[0].address === d[0].address.toUpperCase() && /[A-F]/.test(d[0].address));
t('6 an EMPTY name survives — it is a real value, not a missing one',
  d[2].name === '', 'a `??` default would be a bug here where `||` is correct');
t('7 rssi stays a negative int', d[0].rssi === -54 && Number.isInteger(d[0].rssi));
t('8 via "other" entries are carried but NOT counted',
  d.filter((x) => x.via === 'other').length === 2 && multi.count === 3);

// ── CARD HALF: the real _renderStatsRow ─────────────────────────────────────
const sandbox = {
    console, window: null,
    DevicesPage: { _escape: (x) => String(x == null ? '' : x), _localMode: false,
                   _haSlugForDevice: () => 'lerch_32', _haEntityIdsForDevice: () => ({}) },
    DeviceControlState: { resolve: () => null },
    FeatureGate: { isAddonMode: () => true, optionAllowed: () => true },
    DevicesDetailModals: { sleepModeOf: () => ({ mode: 'off' }), _formatTimeout: () => '', immichAlbumSummary: () => '',
                           // Stubbed, with leg 20 asserting the REAL signature matches
                           // this call shape. The modal chrome is DevicesDetailModals'
                           // own concern; what matters here is that title, body and
                           // footer all arrive, so each is made assertable.
                           _modal: (title, body, onClose, footer) =>
                               `<MODAL title="${title}" close="${onClose}">${body}<FOOT>${footer}</FOOT></MODAL>` },
    App: { renderPage: () => {} },
    ICON: (p) => p,
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
try { vm.runInContext(readFileSync(CARD, 'utf8'), ctx, { filename: CARD }); }
catch (e) { console.log(`BLIND: devices-card.js did not evaluate: ${e.message}`); process.exit(2); }
const Card = vm.runInContext('DevicesCard', ctx);
if (!Card || typeof Card._renderStatsRow !== 'function') { console.log('BLIND: _renderStatsRow did not load'); process.exit(2); }

const row = (bluetooth) => {
    try { return Card._renderStatsRow({ device_id: 'abc', metrics: {} }, 'abc', bluetooth === undefined ? {} : { bluetooth }); }
    catch (e) { return `THREW ${e.message}`; }
};
const connected = row({ count: 3, devices: [] });
const listening = row({ count: 0, devices: [] });
const offline = row({ count: null, devices: [] });
const absent = row(undefined);

// 🔴 GUARD BEFORE THE NEGATIVE LEGS. On the first run `_renderStatsRow` threw
// (a missing sandbox stub) and legs 12 and 14 went GREEN — because a string reading
// "THREW ..." contains neither 'icon-bluetooth.svg' nor the word 'permission'. A
// negative assertion is satisfied by a subject that never rendered, so every "does
// NOT contain" leg here is vacuous unless the render is known to have happened.
for (const [name, html] of [['connected', connected], ['listening', listening],
                            ['unavailable', offline], ['no-sensor', absent]]) {
    if (typeof html !== 'string' || html.startsWith('THREW')) {
        console.log(`  FAIL  9pre the ${name} card did not render — ${html}`);
        console.log('        (every negative leg below would pass vacuously; fix this first)');
        console.log(`check-bluetooth-surface: ${pass} pass, ${fail + 1} fail`);
        process.exit(1);
    }
}
t('9pre CONTROL: all four cards actually rendered, so the negative legs mean something',
  [connected, listening, offline, absent].every((h) => typeof h === 'string' && !h.startsWith('THREW')));

t('9 a connected tablet renders the count, tinted', /bt-on/.test(connected) && connected.includes('3'),
  connected.slice(0, 140));
t('9a ...and carries the bluetooth icon', connected.includes('icon-bluetooth.svg'));
t('10 LISTENING (0) renders a chip, and is NOT styled as unavailable',
  listening.includes('icon-bluetooth.svg') && listening.includes('0') && !listening.includes('bt-off'),
  'zero is the benign setup state, not a fault');
t('11 UNAVAILABLE renders a greyed chip — and NOT the digit 0',
  offline.includes('bt-off') && offline.includes('&ndash;') && !/>0</.test(offline),
  'showing 0 for a dead bridge is the exact collapse leg 3 exists to stop');
t('12 a tablet with NO bluetooth sensor renders NO chip at all',
  !absent.includes('icon-bluetooth.svg'),
  'the no-key case must behave like every other chip: no data, no chip');
t('13 CONTROL: the three states are mutually distinguishable',
  connected !== listening && listening !== offline && connected !== offline,
  'the chip would render identically whatever the bridge is doing');
t('14 the greyed state names NO cause',
  !/permission|adapter|location|not running|unreachable/i.test(offline),
  'it covers eight Android-local conditions HA never learns — naming one sends the user after the wrong fault');


// ── THE DEVICE-LIST MODAL (John, 2026-10-07) ──────────────────────────
const MODAL = `${ROOT}/dashie-ha/frontend/console/js/pages/devices-bluetooth-modal.js`;
if (!existsSync(MODAL)) { console.log('BLIND: devices-bluetooth-modal.js not found'); process.exit(2); }

// The modal resolves its own device + metrics, so both lookups are steerable.
let FIXTURE = null;
sandbox.DevicesPage._findDevice = (id) => (FIXTURE && id === 'abc' ? FIXTURE.device : null);
sandbox.DeviceControlState.metricsFor = () => (FIXTURE ? FIXTURE.metrics : null);
try { vm.runInContext(readFileSync(MODAL, 'utf8'), ctx, { filename: MODAL }); }
catch (e) { console.log(`BLIND: devices-bluetooth-modal.js did not evaluate: ${e.message}`); process.exit(2); }
const BT = vm.runInContext('typeof DevicesBluetoothModal !== "undefined" ? DevicesBluetoothModal : null', ctx);
if (!BT || typeof BT.render !== 'function') { console.log('BLIND: DevicesBluetoothModal.render did not load'); process.exit(2); }

const openWith = (bluetooth) => {
    FIXTURE = { device: { device_id: 'abc', device_name: 'Kitchen' }, metrics: { bluetooth } };
    BT._open = true; BT._deviceId = 'abc';
    try { return BT.render(); } catch (e) { return `THREW ${e.message}`; }
};

// 🔴 GUARD FIRST, same reason as 9pre. A render that threw contains none of the
// group headings, so every "is not in the list" leg below would pass on nothing.
const mMulti = openWith({ count: 3, devices: multi.devices });
if (typeof mMulti !== 'string' || mMulti.startsWith('THREW') || !mMulti.includes('<MODAL')) {
    console.log(`  FAIL  15pre the modal did not render — ${String(mMulti).slice(0, 180)}`);
    console.log('        (every negative leg below would pass vacuously; fix this first)');
    console.log(`check-bluetooth-surface: ${pass} pass, ${fail + 1} fail`);
    process.exit(1);
}
t('15pre CONTROL: the modal rendered, so the negative legs below mean something', true);

t('15 the modal lists the devices HA uses THIS tablet for',
  mMulti.includes('Living Room Speaker') && mMulti.includes("Jack's Watch"));
// 🔴 THE LOAD-BEARING LEG. The heading number must be the sensor STATE, never
// the filtered list length -- the same single-source rule the chip obeys. The
// fixture is deliberately inconsistent (state 3, two via-'this' entries) so a
// `viaThis.length` implementation prints (2) and goes red here. A consistent
// fixture could not tell the two implementations apart.
const mSkew = openWith({ count: 3, devices: [multi.devices[0], multi.devices[1], multi.devices[3]] });
t('16 the connected heading prints the sensor STATE, not the number of rows',
  mSkew.includes('Connected via this tablet (3)'),
  'a second derivation of the count -- ble_entities.py forbids exactly this');
t('17 via "other" devices are listed SEPARATELY, not folded into the count group',
  mMulti.includes('Also in range') && mMulti.includes('Kitchen Sensor') &&
  mMulti.indexOf('Kitchen Sensor') > mMulti.indexOf('Also in range'),
  'showing them flat would make the chip look wrong -- the list would contradict the state');
// ⚠️ KEYED ON THE PRIMARY LABEL, not on the address appearing anywhere.
// The first version of this leg was `mMulti.includes('E8:2A:...')` and it did
// NOT catch its own mutation: with `??` in place of `||` the label goes to the
// empty string, but the address is still emitted in the SUBTITLE, so the
// substring was present and the leg stayed green while the row rendered a blank
// name. Measured, by injecting `??` and watching 37/0 hold. Read the labels.
const labels = [...mMulti.matchAll(/overflow-wrap: anywhere;">([^<]*)<\/span>/g)].map((m) => m[1]);
t('18 every row renders a NON-EMPTY primary label', labels.length >= 3 && labels.every((l) => l.trim() !== ''),
  `labels: ${JSON.stringify(labels)}`);
t('18a an UNNAMED device uses its ADDRESS as that label',
  labels.includes('E8:2A:44:10:B7:3C'),
  "name: '' is a real value; `??` instead of `||` keeps the empty string and blanks the row");
t('18b ...and does not then repeat the address in its subtitle',
  (mMulti.match(/E8:2A:44:10:B7:3C/g) || []).length === 1);
t('19 signal strength is shown with the raw dBm, not a bucket alone',
  /Strong · -54 dBm/.test(mMulti) && /Weak · -88 dBm/.test(mMulti));

// Single-tablet: no second group at all.
const mSingle = openWith({ count: 2, devices: single.devices });
t('19a CONTROL: a single-tablet household gets NO "Also in range" section',
  mSingle.includes('Connected via this tablet (2)') && !mSingle.includes('Also in range'),
  'an always-present empty section would be noise for the commonest deployment');

// Zero and unavailable are different states here too, exactly as on the chip.
const mZero = openWith({ count: 0, devices: [] });
t('19b ZERO says scanning, and names no fault',
  /Scanning/i.test(mZero) && !/unavailable|permission|adapter/i.test(mZero),
  '0 is the benign setup state');
const mOff = openWith({ count: null, devices: [] });
t('19c UNAVAILABLE says so, lists nothing, and still names NO cause',
  /unavailable/i.test(mOff) && !/Scanning/i.test(mOff) &&
  !/permission|adapter|location|not running/i.test(mOff),
  'it covers eight Android-local conditions HA never learns');

// ── REACHABILITY. A modal nothing renders is authored-but-unreached. ───────
const cardSrc = readFileSync(CARD, 'utf8');
t('20 the real _modal signature matches the call site',
  /_modal\(title, bodyHtml, onClose, footerHtml, device\)/.test(
      readFileSync(`${ROOT}/dashie-ha/frontend/console/js/pages/devices-detail-modals.js`, 'utf8')),
  'the sandbox stub above would hide a signature change');
t('21 the CHIP opens the modal (not history)',
  /DevicesBluetoothModal\.open\(/.test(cardSrc) &&
  !/historyLink\('bluetooth_devices'/.test(cardSrc),
  'the click still goes to HA history');
t('21a ...and stops propagation, so it does not also switch the page',
  /event\.stopPropagation\(\); DevicesBluetoothModal\.open\(/.test(cardSrc));
for (const host of ['devices.js', 'devices-detail.js']) {
    t(`22 ${host} actually renders the modal`,
      /DevicesBluetoothModal\.render\(\)/.test(
          readFileSync(`${ROOT}/dashie-ha/frontend/console/js/pages/${host}`, 'utf8')),
      'the modal can be opened but never drawn');
}
t('23 index.html loads it AFTER devices-detail-modals (it calls that module)',
  (() => { const h = readFileSync(`${ROOT}/dashie-ha/frontend/console/index.html`, 'utf8');
           const a = h.indexOf('devices-detail-modals.js'), b = h.indexOf('devices-bluetooth-modal.js');
           return a >= 0 && b > a; })(),
  'load order wrong: DevicesDetailModals._modal would be undefined at call time');

console.log(`check-bluetooth-surface: ${pass} pass, ${fail} fail`);
if (!fail) console.log('✅ bluetooth surface: count is the state, unavailable is not zero, all three states are distinct, and the list agrees with the count');
process.exit(fail ? 1 : 0);
