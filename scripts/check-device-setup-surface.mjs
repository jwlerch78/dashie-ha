#!/usr/bin/env node
/**
 * check-device-setup-surface — console-audit #3: Layout and Orientation do not
 * appear on an ACCOUNT-LESS box, and still do for a signed-in Dashie-for-HA one.
 *
 * ── WHY BOTH DIRECTIONS ARE LEGS ─────────────────────────────────────────────
 *
 * This gate is unusual here in that the WRONG fix is the easy one. The obvious
 * implementation — adding these keys to `FAMILY_ONLY_OPTIONS` — removes the rows
 * from the Dashie-for-HA add-on too, silently reversing a decision that is
 * written down in that very file ("The Layout row itself stays: the HA edition
 * uses single_panel/kiosk"). Nothing would error; a documented behaviour would
 * simply stop happening. So leg 2 is not decoration, it is half the ruling.
 *
 * `isLocalMode` is the only seam that separates the two editions in this
 * console — both ship `BRAND.build: 'published'` — which is why the ruling is
 * expressible at all.
 *
 * Leg 3 covers what the removal MADE reachable: a card that lost every row.
 *
 * Exit 0 = every leg passes, 1 = a violation, 2 = cannot check.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSOLE = join(HERE, '..', 'dashie-ha', 'frontend', 'console');
const FILES = {
    brand: join(CONSOLE, 'js', 'lib', 'brand.js'),
    gate: join(CONSOLE, 'js', 'lib', 'feature-gate.js'),
    modals: join(CONSOLE, 'js', 'pages', 'devices-detail-modals.js'),
};
for (const [name, f] of Object.entries(FILES)) {
    if (!existsSync(f)) {
        console.error(`check-device-setup-surface: cannot check — ${name} not found at ${f}`);
        process.exit(2);
    }
}

const sandbox = {
    console,
    document: { title: '', querySelector: () => null },
    DashieAuth: { isAddonMode: true, isLocalMode: false },
    // The one external collaborator renderDisplayBody reaches for.
    DevicesPage: { _escape: (s) => String(s ?? '') },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
try {
    for (const k of ['brand', 'gate', 'modals']) {
        vm.runInContext(readFileSync(FILES[k], 'utf8'), ctx, { filename: FILES[k] });
    }
} catch (e) {
    console.error(`check-device-setup-surface: cannot check — console module did not evaluate: ${e.message}`);
    process.exit(2);
}
const M = sandbox.window.DevicesDetailModals;
if (!M || typeof M.renderDisplayBody !== 'function') {
    console.error('check-device-setup-surface: cannot check — DevicesDetailModals.renderDisplayBody did not load');
    process.exit(2);
}

let failed = 0;
function check(name, ok, detail, why) {
    if (ok) { console.log(`✅ ${name}`); return; }
    console.error(`❌ ${name}\n     ${detail}\n     why it matters: ${why}`);
    failed++;
}

const DEVICE = { device_id: 'dev-1', settings: { screensaver: {} } };
// layoutMode 'widgets' is the case that shows BOTH rows — the only input under
// which leg 1 can actually fail, so it is the one to test with.
const DISPLAY = { layoutMode: 'widgets', orientationLock: 'auto', themeFamily: 'default' };
const SLEEP = {};
const render = (localMode) => {
    sandbox.DashieAuth.isLocalMode = localMode;
    try { return M.renderDisplayBody(DEVICE, { ...DISPLAY }, SLEEP); }
    catch (e) { return `__THREW__ ${e.message}`; }
};

// ── LEG 1 — account-less: neither row appears ───────────────────────────────
{
    const html = render(true);
    if (html.startsWith('__THREW__')) {
        console.error(`❌ leg 1 — renderDisplayBody threw: ${html}`);
        failed++;
    } else {
        const hasLayout = />Layout</.test(html);
        const hasOrientation = />Orientation</.test(html);
        check('leg 1 — an account-less box shows neither Layout nor Orientation',
            !hasLayout && !hasOrientation,
            `Layout present=${hasLayout} Orientation present=${hasOrientation}`,
            "`widgets` IS the family dashboard, which cannot run without an account — these rows would configure something that cannot exist, and the picker would happily write a value nothing can act on");
    }
}

// ── LEG 2 — POSITIVE CONTROL: signed in, both rows come back ────────────────
//
// 🔴 Half the ruling, not decoration. The easy wrong fix (FAMILY_ONLY_OPTIONS)
// passes leg 1 and fails here, silently reversing a decision documented in
// feature-gate.js itself.
{
    const html = render(false);
    if (html.startsWith('__THREW__')) {
        console.error(`❌ leg 2 — renderDisplayBody threw: ${html}`);
        failed++;
    } else {
        const hasLayout = />Layout</.test(html);
        const hasOrientation = />Orientation</.test(html);
        check('leg 2 — POSITIVE CONTROL: a signed-in box still shows Layout and Orientation',
            hasLayout && hasOrientation,
            `Layout present=${hasLayout} Orientation present=${hasOrientation}`,
            'the kept-row decision for Dashie-for-HA is written down in feature-gate.js ("the HA edition uses single_panel/kiosk"). Removing the rows for BOTH editions passes leg 1 and quietly reverses it — nothing errors, a documented behaviour just stops');
    }
}

// ── LEG 3 — a subsection that lost every row renders NOTHING ────────────────
//
// Made reachable BY leg 1: on an account-less published box the Dashboard card
// can lose Layout, Orientation and Theme at once.
{
    const empty = M._subsectionCard('Dashboard', '');
    const whitespace = M._subsectionCard('Dashboard', '   \n  ');
    const populated = M._subsectionCard('Dashboard', '<div>row</div>');
    check('leg 3 — an empty subsection card renders nothing; a populated one still renders',
        empty === '' && whitespace === '' && populated.includes('Dashboard'),
        `empty=${JSON.stringify(empty).slice(0, 40)} whitespace=${JSON.stringify(whitespace).slice(0, 40)} populated-ok=${populated.includes('Dashboard')}`,
        'a heading with nothing under it reads as "this section failed to load" rather than "there is nothing here", and nothing logs either way — the removal is what made that state reachable');
}

// ── LEG 4 — the gate is on the ACCOUNT seam, not the build seam ─────────────
//
// A static leg on purpose: it asserts WHICH predicate was used, which is the
// thing legs 1+2 together imply but do not name. If someone satisfies both by
// some third route, this says so.
{
    const src = readFileSync(FILES.modals, 'utf8');
    const i = src.indexOf('const showLayout');
    const line = i >= 0 ? src.slice(i, i + 160) : '';
    check('leg 4 — the row gate reads isLocalMode (the account seam), not isPublishedBuild',
        /isLocalMode/.test(line) && !/isPublishedBuild/.test(line),
        `showLayout is: ${line.split('\n')[0] || '(not found)'}`,
        'both editions ship BRAND.build "published", so isPublishedBuild cannot express this ruling at all — a gate written on it would be either always-on or always-off, and would look correct');
}

console.log('');
if (failed) {
    console.error(`❌ ${failed} leg(s) failed`);
    process.exit(1);
}
console.log('✅ all legs pass — Layout/Orientation are account-gated, the signed-in rows survive, and an emptied card renders nothing');
