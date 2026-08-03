#!/usr/bin/env node
/**
 * check-sharing-state — controls for CONTRACTS #72's state classification.
 *
 * Calls the REAL exported `classifySharingState` from
 * `dashie-ha/server/sharing-state.js`. No copy of its rules lives here; a test
 * that restates the logic it is testing passes while the shipped path is wrong,
 * which is the hand-mirror failure one floor down.
 *
 * ── WHY THESE PROPERTIES AND NOT OTHERS ──────────────────────────────────────
 *
 * Every case below is one where getting it wrong is INVISIBLE — the card still
 * renders, the sentence still reads fluently, and it says the wrong true thing
 * or a confident false one:
 *
 *   • unknown-is-not-off        the 2026-07-31 bug: sharing was ON for a day
 *                               while the card rendered Off, because an
 *                               unreadable state collapsed into the reassuring
 *                               answer. A security-ish control must fail LOUD.
 *   • sharing_off dominance     a box with keys and sharing off is ALSO
 *                               truthfully "using built-in voice". Reporting
 *                               the benign half is how an operator concludes
 *                               there is nothing to do.
 *   • the remedy split          `capability_unavailable` and `sharing_disabled`
 *                               imply OPPOSITE actions (add a key vs turn
 *                               sharing on). Collapsing them reproduces the
 *                               2026-07-13 undebuggable state, and the console
 *                               is where both remedies live.
 *   • nothing-granted           renders NOTHING rather than a withheld string:
 *                               claiming a withholding that did not happen is
 *                               the same class as "Not shared" off an empty map.
 *
 * Exit 0 = every control passes, 1 = a violation, 2 = cannot check.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, '..', 'dashie-ha', 'server', 'sharing-state.js');

if (!existsSync(MODULE)) {
    console.error(`check-sharing-state: cannot check — ${MODULE} not found`);
    process.exit(2);
}

const require_ = createRequire(import.meta.url);
let classifySharingState;
try {
    ({ classifySharingState } = require_(MODULE));
} catch (e) {
    console.error(`check-sharing-state: cannot check — module did not load: ${e.message}`);
    process.exit(2);
}
if (typeof classifySharingState !== 'function') {
    console.error('check-sharing-state: cannot check — classifySharingState is not exported');
    process.exit(2);
}

/** Build the shape `capability.grantableCapabilities()` returns. */
const g = (states, sharing, granted, withheld) => ({
    states: new Map(Object.entries(states)),
    sharing,
    granted,
    withheld: withheld || {},
});

const CASES = [
    // ── the two GRANTED states ───────────────────────────────────────────────
    {
        name: 'metered + sharing on → using_keys',
        input: g({ voice: 'free', ai: 'metered', tools: 'free' }, true, ['voice', 'ai', 'tools']),
        expect: { state: 'using_keys', remedy: null },
        why: 'a key exists and the household lends it — the only state that says keys are in use',
    },
    {
        name: 'POSITIVE CONTROL — everything free and present → using_free, no remedy',
        input: g({ voice: 'free', ai: 'free', tools: 'free' }, true, ['voice', 'ai', 'tools']),
        expect: { state: 'using_free', remedy: null },
        why: 'a local Ollama with no key is genuinely free — there is nothing to configure, so a remedy here would invent a problem',
    },

    // ── the dominance rule ───────────────────────────────────────────────────
    {
        name: 'metered + sharing OFF → sharing_off (NOT using_free)',
        input: g({ voice: 'free', ai: 'metered', tools: 'free' }, false, ['voice', 'tools'],
            { ai: 'sharing_disabled' }),
        expect: { state: 'sharing_off', remedy: null },
        why: 'voice+tools ARE granted and free, so "using built-in voice" is literally true — and reporting it would hide that a key is being withheld',
    },
    {
        name: 'sharing OFF also suppresses a not_configured remedy',
        input: g({ voice: 'free', ai: 'metered', tools: 'absent' }, false, ['voice'],
            { ai: 'sharing_disabled', tools: 'capability_unavailable' }),
        expect: { state: 'sharing_off', remedy: null },
        why: 'two instructions for one situation sends the operator to the wrong page first; state already names the action',
    },

    // ── the remedy split ─────────────────────────────────────────────────────
    {
        name: 'no ai configured, free engines granted → using_free + not_configured',
        input: g({ voice: 'free', ai: 'absent', tools: 'free' }, true, ['voice', 'tools'],
            { ai: 'capability_unavailable' }),
        expect: { state: 'using_free', remedy: 'not_configured' },
        why: "#72's state 2 parenthetical (HA Whisper/Piper, keyless tools) IS this case, and its state 3 describes the same box from the other end — both of John's sentences are true here",
    },
    {
        name: 'not_configured survives sharing being ON',
        input: g({ voice: 'free', ai: 'absent', tools: 'free' }, false, ['voice', 'tools'],
            { ai: 'capability_unavailable' }),
        expect: { state: 'using_free', remedy: 'not_configured' },
        why: 'with nothing metered anywhere, the sharing flag is irrelevant — turning it on would lend nothing, so the remedy must still be "add a key"',
    },

    // ── render-nothing states ────────────────────────────────────────────────
    {
        name: 'nothing granted and nothing metered → unknown (render NOTHING)',
        input: g({ voice: 'absent', ai: 'absent', tools: 'absent' }, true, [],
            { voice: 'capability_unavailable', ai: 'capability_unavailable', tools: 'capability_unavailable' }),
        expect: { state: 'unknown', remedy: null },
        why: 'there is no honest sentence for a box that can grant nothing; a withheld string would claim a withholding that never happened',
    },

    // ── unknown-is-not-off (the 2026-07-31 shape) ────────────────────────────
    {
        name: 'null input → unknown, never sharing_off',
        input: null,
        expect: { state: 'unknown', remedy: null },
        why: 'an unreadable state must LOOK unreadable — collapsing it into the reassuring answer is the bug this whole card was rewritten for',
    },
    {
        name: 'missing states map → unknown, never sharing_off',
        input: { sharing: false, granted: [], withheld: {} },
        expect: { state: 'unknown', remedy: null },
        why: 'a partial payload (an older add-on, a changed predicate) must not fall through into a confident denial',
    },
];

let failed = 0;
for (const c of CASES) {
    let got;
    try {
        got = classifySharingState(c.input);
    } catch (e) {
        console.error(`❌ ${c.name}\n     threw: ${e.message}\n     why it matters: ${c.why}`);
        failed++;
        continue;
    }
    const ok = got && got.state === c.expect.state && (got.remedy ?? null) === c.expect.remedy;
    if (ok) {
        console.log(`✅ ${c.name}`);
    } else {
        console.error(
            `❌ ${c.name}\n` +
            `     expected  state=${c.expect.state} remedy=${c.expect.remedy}\n` +
            `     got       state=${got?.state} remedy=${got?.remedy ?? null}\n` +
            `     why it matters: ${c.why}`,
        );
        failed++;
    }
}

// ── LEG 2 — every state the classifier can EMIT has console prose ────────────
//
// 🔴 The failure this exists for is silent in both directions and in the worst
// possible way: add a state to sharing-state.js and the console's
// `_sharingSentence()` falls through to `return null`, which is a LEGITIMATE
// value here — it means "render nothing". So a state the server computes
// correctly renders as an empty card, no error, no warning, nothing in the
// console log. The indicator simply stops indicating and looks like a box with
// nothing to report.
//
// ⚠️ This is a COVERAGE check, not a behaviour test, and the distinction is the
// point: it asserts the console mentions each state, not that it words it
// correctly. Wording is #72's job and John's — a lint on prose fires on correct
// code (that argument is why #72 carries no gate). What is checkable without
// touching prose is whether a branch EXISTS, and that is the half that breaks
// silently.
const CONSOLE_PAGE = join(HERE, '..', 'dashie-ha', 'frontend', 'console', 'js', 'pages', 'voice-ai.js');
const CLASSIFIER = MODULE;

if (!existsSync(CONSOLE_PAGE)) {
    console.error(`\ncheck-sharing-state: cannot check leg 2 — ${CONSOLE_PAGE} not found`);
    process.exit(2);
}

const { readFileSync } = await import('node:fs');
const classifierSrc = readFileSync(CLASSIFIER, 'utf8');
const pageSrc = readFileSync(CONSOLE_PAGE, 'utf8');

// The states the classifier can return: `state = '<x>'` assignments.
const emitted = new Set([...classifierSrc.matchAll(/\bstate\s*=\s*'([a-z_]+)'/g)].map((m) => m[1]));
if (!emitted.size) {
    console.error('\ncheck-sharing-state: cannot check leg 2 — found no state assignments in the classifier');
    process.exit(2);
}

// `unknown` renders nothing BY DESIGN (#72), so it needs no branch — but it
// must still be a state the classifier can reach, which the cases above pin.
const needsProse = [...emitted].filter((s) => s !== 'unknown').sort();
const sentenceFn = pageSrc.slice(pageSrc.indexOf('_sharingSentence()'));
const missing = needsProse.filter((s) => !sentenceFn.slice(0, 1200).includes(`'${s}'`));

console.log('');
if (missing.length) {
    console.error(
        `❌ leg 2 — the classifier emits state(s) the console does not handle: ${missing.join(', ')}\n` +
        `     _sharingSentence() would return null for these, which reads as "nothing to report"\n` +
        `     rather than as a bug. Add a branch in voice-ai.js.`,
    );
    failed++;
} else {
    console.log(`✅ leg 2 — all ${needsProse.length} rendering state(s) have console prose (${needsProse.join(', ')})`);
}

console.log('');
if (failed) {
    console.error(`❌ ${failed} control(s)/leg(s) failed`);
    process.exit(1);
}
console.log(`✅ ${CASES.length}/${CASES.length} controls + leg 2 pass — #72's classification holds and the console covers it`);
