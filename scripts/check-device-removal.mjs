#!/usr/bin/env node
/**
 * check-device-removal — every Remove/Delete button on the Devices surface goes
 * through ONE holder, and none of them calls the soft `delete_device` path.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 *
 * Backlog #14 §5a re-pointed Remove at `unclaim_devices`, because the soft path
 * was a placebo: the row stayed, `is_active` went false, and the credential
 * renewed forever. The spec's table named TWO buttons. There were FOUR — the
 * dismissed-row Delete and the archived-row Delete in `devices.js` still called
 * the soft path two days after §5a "landed", each with its own confidently wrong
 * confirm copy.
 *
 * 🔴 That is why this gate asserts the CALL and not the button. A spec that
 * enumerates surfaces can under-count them; `dbRequest` cannot be under-counted,
 * because it is what actually reaches the server.
 *
 * It also pins D's §5c precondition — *"retire the soft path once nothing calls
 * it"*. §5c is blocked on that sentence being true, so it needs to stay true.
 *
 * Exit 0 = every leg passes, 1 = a violation, 2 = cannot check.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = join(HERE, '..', 'dashie-ha', 'frontend', 'console', 'js', 'pages');
const FILES = { detail: join(PAGES, 'devices-detail.js'), list: join(PAGES, 'devices.js') };
for (const [k, f] of Object.entries(FILES)) {
    if (!existsSync(f)) {
        console.error(`check-device-removal: cannot check — ${k} not found at ${f}`);
        process.exit(2);
    }
}

// ── The sandbox. Only the collaborators the removal path actually reaches; a
//    stub that is too generous hides a missing dependency, and one that is too
//    thin fails to load for reasons that look like findings.
const calls = [];
let confirmMessage = '';
let unclaimResult = null;
const restored = [];

const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: { title: '', querySelector: () => null },
    DashieAuth: {
        isAddonMode: true,
        isLocalMode: false,
        async dbRequest(op, params) {
            calls.push({ op, params });
            if (op === 'unclaim_devices') return unclaimResult;
            return { ok: true };
        },
    },
    ConfirmModal: {
        async confirm({ message }) { confirmMessage = message || ''; return true; },
    },
    ConsoleState: { dismiss() {}, restore: (ns, id) => restored.push(`${ns}:${id}`) },
    Toast: { success() {}, error() {}, friendly: (e) => String(e) },
    App: { renderPage() {} },
    setTimeout, clearTimeout, fetch: async () => { throw new Error('no network in this harness'); },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
try {
    for (const k of ['detail', 'list']) {
        vm.runInContext(readFileSync(FILES[k], 'utf8'), ctx, { filename: FILES[k] });
    }
} catch (e) {
    console.error(`check-device-removal: cannot check — a console module did not evaluate: ${e.message}`);
    process.exit(2);
}
// Both modules are top-level `const`, which in a vm context is a LEXICAL binding
// and never becomes a property of the sandbox — reading `sandbox.DevicesPage`
// silently yields undefined. Evaluate an expression in the same context instead.
let DP; let DD;
try {
    ({ DevicesPage: DP, DevicesDetail: DD } =
        vm.runInContext('({ DevicesPage, DevicesDetail })', ctx));
} catch (e) {
    console.error(`check-device-removal: cannot check — modules did not bind: ${e.message}`);
    process.exit(2);
}
if (!DP || !DD || typeof DD._remove !== 'function') {
    console.error('check-device-removal: cannot check — DevicesPage/DevicesDetail._remove did not load');
    process.exit(2);
}

let failed = 0;
function check(name, ok, detail, why) {
    if (ok) { console.log(`✅ ${name}`); return; }
    failed++;
    console.error(`❌ ${name}\n     ${detail}\n     why it matters: ${why}`);
}

const WITH_INSTALL = { device_id: 'dev-1', device_name: 'Tablet', install_id: 'inst-1' };
const NO_INSTALL = { device_id: 'dev-2', device_name: 'Browser', install_id: null };

function reset(devices, unclaim = { unclaimed: ['inst-1'], rejected: [] }) {
    calls.length = 0;
    restored.length = 0;
    confirmMessage = '';
    unclaimResult = unclaim;
    DP._devices = devices.map((d) => ({ ...d }));
    DP._detailDeviceId = null;
}
const softCalls = () => calls.filter((c) => c.op === 'delete_device' && !c.params?.hard_delete);
const opNames = () => calls.map((c) => c.op).join(',');

// ── 1-3 — all three entry points reach unclaim_devices ─────────────────────
const ENTRY_POINTS = [
    ['leg 1 — Danger-Zone Remove', () => DD._remove('dev-1', 'Tablet')],
    ['leg 2 — the DISMISSED-row Delete', () => DP.deleteDismissedDevice('dev-1', 'Tablet')],
    ['leg 3 — the ARCHIVED-row Delete', () => DP._deleteArchived('dev-1', 'Tablet')],
];
for (const [name, drive] of ENTRY_POINTS) {
    reset([WITH_INSTALL]);
    await drive();
    check(`${name} calls unclaim_devices`,
        calls.length === 1 && calls[0].op === 'unclaim_devices'
            && JSON.stringify(calls[0].params) === JSON.stringify({ install_ids: ['inst-1'] }),
        `calls=[${opNames()}] params=${JSON.stringify(calls[0]?.params)}`,
        'legs 2 and 3 are the two the §5a spec did not list — they called the soft path for two days after §5a was reported landed, so this is the regression that already happened once');
}

// ── 4 — the soft path has NO caller ────────────────────────────────────────
{
    let anySoft = 0;
    for (const [, drive] of ENTRY_POINTS) {
        reset([WITH_INSTALL]);
        await drive();
        anySoft += softCalls().length;
    }
    check('leg 4 — no entry point calls the SOFT delete_device',
        anySoft === 0, `soft calls across all three entry points: ${anySoft}`,
        "D's §5c is blocked on exactly this sentence — \"retire the soft path once nothing calls it\". The soft path leaves the row with is_active=false and the credential renewing forever, which is the placebo #14 was raised to remove");
}

// ── 5 — residue 2: no install row falls back to the HARD delete ────────────
{
    reset([NO_INSTALL]);
    await DD._remove('dev-2', 'Browser');
    check('leg 5 — a device with no install row hard-deletes instead',
        calls.length === 1 && calls[0].op === 'delete_device' && calls[0].params?.hard_delete === true,
        `calls=[${opNames()}] params=${JSON.stringify(calls[0]?.params)}`,
        'spec §6 residue 2: unclaim_devices has no install_id to release, so a hard delete is the honest equivalent — it revokes correctly and does not re-present, which is what the confirm text for this case says');

    // 🔴 Assert the NEGATION explicitly, not the absence of a word. The first
    // cut of this leg tested `!/reappear/` and went red on copy that reads "It
    // will NOT reappear as an addable device" — i.e. it failed the correct
    // sentence for containing the word it was checking the polarity of. A
    // keyword-absence test cannot express polarity, which is the whole property
    // here: both copies mention reappearing, and they mean opposite things.
    check('leg 6 — the no-install confirm says the device will NOT reappear',
        /\bnot\s+reappear|won'?t\s+reappear|never\s+reappear/i.test(confirmMessage),
        `message=${JSON.stringify(confirmMessage)}`,
        'the retired copy promised "it\'ll reappear as a fresh discovered/install entry" for a device that cannot — promising the outcome the revocation guard exists to prevent is the specific defect §5a was written for, and it must not come back through the no-install branch');

    reset([WITH_INSTALL]);
    await DD._remove('dev-1', 'Tablet');
    check('leg 6b — POSITIVE CONTROL: the WITH-install confirm does promise it comes back',
        /appear again|reappear|re-add/i.test(confirmMessage) && !/\bnot\s+reappear/i.test(confirmMessage),
        `message=${JSON.stringify(confirmMessage)}`,
        'the two cases genuinely differ and the copy must differ with them. Leg 6 alone is satisfiable by copy that promises nothing to anyone, which would be honest and useless — this is the half that says the branch still tells a user what will happen');
}

// ── 7-9 — a REFUSED removal must not report success ────────────────────────
{
    reset([WITH_INSTALL], { unclaimed: [], rejected: [{ id: 'inst-1', reason: 'still claimed' }] });
    const ok = await DD._remove('dev-1', 'Tablet');
    check('leg 7 — a rejected unclaim returns false',
        ok === false, `returned ${ok}`,
        'the callers branch on this; a truthy return on a refusal makes every caller clean up state for a device that is still there');
    check('leg 8 — and the device stays in the roster',
        (DP._devices || []).some((d) => d.device_id === 'dev-1'), `roster=${JSON.stringify((DP._devices || []).map((d) => d.device_id))}`,
        'unclaim_devices RESOLVES on rejection ({unclaimed, rejected}) rather than throwing, so a try/catch alone reports a deletion that did not happen — and the lie survives until the next refresh repaints the row');

    reset([WITH_INSTALL], { unclaimed: [], rejected: [{ id: 'inst-1', reason: 'still claimed' }] });
    await DP.deleteDismissedDevice('dev-1', 'Tablet');
    check('leg 9 — a rejected removal does NOT drop the dismissal entry',
        restored.length === 0, `ConsoleState.restore called with: ${JSON.stringify(restored)}`,
        'un-dismissing a device that is still there hides the failure by making the row look handled — the second lie outlives the first. onRemoved runs only after the server confirms');
}

// ── 10 — POSITIVE CONTROL: a confirmed removal DOES clean up ───────────────
{
    reset([WITH_INSTALL]);
    const ok = await DP.deleteDismissedDevice('dev-1', 'Tablet');
    check('leg 10 — POSITIVE CONTROL: a confirmed removal drops the dismissal and the roster row',
        restored.length === 1 && !(DP._devices || []).some((d) => d.device_id === 'dev-1'),
        `restored=${JSON.stringify(restored)} roster=${JSON.stringify((DP._devices || []).map((d) => d.device_id))}`,
        'legs 8 and 9 are satisfiable by a function that never cleans up at all. This is the half that says the refusal legs are measuring a branch rather than a no-op');
}

console.log('');
if (failed) {
    console.error(`❌ ${failed} leg(s) failed`);
    process.exit(1);
}
console.log('✅ 11 legs pass — three buttons, one holder, no soft path, and a refusal cleans up nothing');
