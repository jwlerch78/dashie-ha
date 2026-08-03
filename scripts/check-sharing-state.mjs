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

// ── LEG 3 — the per-device route is GATED, and the map still behaves ─────────
//
// Two properties, both silent when broken.
//
// 🔴 (a) `/lease-observations` must sit behind `requireIngressUser`. Drop the
// guard and the route still answers 200 with correct data — nothing errors,
// nothing logs, and the only difference is WHO can read which devices leased.
// A gate whose removal looks exactly like success needs a check.
// ⚠️ It is deliberately STRICTER than the roster it joins: the roster rides
// `/api/ha/status`, which is ungated by design. Measured 2026-08-03, because the
// ruling that authorised this route assumed the roster was gated and it is not.
//
// (b) `list()` must return a COPY. It hands the map's contents to a route; if a
// caller could mutate it, the observational record of who holds capability would
// be writable from a request handler.
const OBS = join(HERE, '..', 'dashie-ha', 'server', 'lease-observations.js');
const ROUTER = join(HERE, '..', 'dashie-ha', 'server', 'api', 'voice-console.js');

if (!existsSync(OBS) || !existsSync(ROUTER)) {
    console.error('\ncheck-sharing-state: cannot check leg 3 — lease-observations.js or voice-console.js not found');
    process.exit(2);
}

const routerSrc = readFileSync(ROUTER, 'utf8');
const gated = /router\.get\(\s*'\/lease-observations'\s*,\s*requireIngressUser\(/.test(routerSrc);
if (!gated) {
    console.error(
        "❌ leg 3a — /lease-observations is NOT behind requireIngressUser.\n" +
        "     The route would still answer 200 with correct data; the only change is who can read it.\n" +
        "     isIngress() is NOT a substitute — it accepts a client-suppliable header (D, s52).",
    );
    failed++;
} else {
    console.log('✅ leg 3a — /lease-observations is behind requireIngressUser (stricter than the ungated roster)');
}

let obs;
try {
    obs = require_(OBS);
} catch (e) {
    console.error(`❌ leg 3b — lease-observations.js did not load: ${e.message}`);
    obs = null;
    failed++;
}
if (obs) {
    obs.record('dev-a', '2026-01-01T00:00:00Z', ['voice']);
    const first = obs.list();
    first.push({ endpoint_id: 'INJECTED' });          // mutate the returned array
    const second = obs.list();
    const isCopy = second.length === 1 && second[0].endpoint_id === 'dev-a';
    const absentIsNull = obs.get('never-seen') === null;
    const presentIsFound = obs.get('dev-a')?.endpoint_id === 'dev-a';

    if (isCopy && absentIsNull && presentIsFound) {
        console.log('✅ leg 3b — list() returns a copy · get() is null for an unobserved endpoint (UNKNOWN, not denial)');
    } else {
        console.error(
            `❌ leg 3b — copy=${isCopy} absent-is-null=${absentIsNull} present-found=${presentIsFound}\n` +
            '     get() returning anything but null for an unobserved endpoint would let a consumer\n' +
            '     render "not shared" for a device the box has simply never heard from.',
        );
        failed++;
    }
}

// ── LEG 4 — the per-device row is TTL-GATED ─────────────────────────────────
//
// 🔴 The single property the per-device half's correctness rests on (#72, tense
// resolved 2026-08-03). John's five sentences are all PRESENT tense; the source
// is observational, i.e. past. Drop the `expires_at` check and the row renders
// "Using your Home Assistant's AI keys" for a device that stopped leasing an
// hour ago — and for EVERY device after an add-on restart, since the map is
// empty then and a naive implementation would fall back to something.
//
// Nothing about that failure looks wrong: the card renders, the sentence is one
// of the approved five, and it is simply not true. Exactly the class this whole
// gate family exists for.
//
// Static, because the function reads page state (`this._leases`) and cannot be
// called headlessly — so this asserts the CHECK IS PRESENT rather than
// exercising it. A weaker guarantee, said plainly rather than dressed up.
const DEVICES_PAGE = join(HERE, '..', 'dashie-ha', 'frontend', 'console', 'js', 'pages', 'devices.js');

if (!existsSync(DEVICES_PAGE)) {
    console.error('\ncheck-sharing-state: cannot check leg 4 — devices.js not found');
    process.exit(2);
}

const devicesSrc = readFileSync(DEVICES_PAGE, 'utf8');
const fnStart = devicesSrc.indexOf('_leaseSentenceFor(');
if (fnStart < 0) {
    console.error('\n❌ leg 4 — _leaseSentenceFor() is gone from devices.js; the per-device row has no TTL gate to check');
    failed++;
} else {
    const fn = devicesSrc.slice(fnStart, fnStart + 1600);
    const readsExpiry = /expires_at/.test(fn);
    const comparesToNow = /Date\.now\(\)/.test(fn) && /expiresAt\s*<=\s*Date\.now\(\)|Date\.now\(\)\s*>=\s*expiresAt/.test(fn);
    const guardsUnparseable = /Number\.isFinite/.test(fn);

    if (readsExpiry && comparesToNow && guardsUnparseable) {
        console.log('✅ leg 4 — the per-device row is TTL-gated (reads expires_at · compares to now · unparseable ⇒ silent)');
    } else {
        console.error(
            `❌ leg 4 — the TTL gate is incomplete: reads-expires_at=${readsExpiry} ` +
            `compares-to-now=${comparesToNow} guards-unparseable=${guardsUnparseable}\n` +
            '     Without all three the row can render a PRESENT-tense sentence off a PAST\n' +
            '     observation — false for any device that stopped leasing, and for every\n' +
            '     device after an add-on restart. Nothing about it looks wrong on screen.',
        );
        failed++;
    }
}

// ── LEG 5 — EVERY card render mode emits the lease line ─────────────────────
//
// 🔴 THE DEFECT THIS EXISTS FOR SHIPPED IN 0.1.12 AND 0.1.13. The sentence was
// inlined in `_renderSimpleSettings`, which `render()` reaches only when
// `!DevicesPage._techView`. Every HA user gets the TECHNICAL card, so the
// sentence computed correctly and never reached the DOM for the audience it was
// built for. T found it on the box: `_leaseSentenceFor` returned the string,
// `sentenceAppearsInDOM: false`.
//
// ⚠️ Leg 4 was green throughout, and correctly — it asserts the TTL check is
// PRESENT. Presence is not reachability. That gap is the whole lesson: a
// component-level green read as an outcome-level green, one more time.
//
// 🔴 And the failure was worse than invisible, it was SELF-CONCEALING: the
// restart-negative check ("every card goes silent") would have PASSED, because
// it is trivially true when no card ever rendered. A negative check cannot
// distinguish "correctly silent" from "never spoke".
//
// So this leg counts RENDER MODES, not call sites: every `return` branch of
// `render()` must reach `_renderLeaseLine`. Add a third mode without it and
// this fails instead of shipping another silent surface.
const CARD = join(HERE, '..', 'dashie-ha', 'frontend', 'console', 'js', 'pages', 'devices-card.js');

if (!existsSync(CARD)) {
    console.error('\ncheck-sharing-state: cannot check leg 5 — devices-card.js not found');
    process.exit(2);
}

const cardSrc = readFileSync(CARD, 'utf8');
const holders = (cardSrc.match(/_renderLeaseLine\s*\(/g) || []).length;   // 1 definition + N call sites

// The simple mode reaches it via _renderSimpleSettings; the technical mode
// inlines it in render(). Both must be present.
const simpleReaches = /_renderSimpleSettings\s*\([\s\S]{0,4000}?_renderLeaseLine/.test(cardSrc)
    || /const leaseLine = this\._renderLeaseLine/.test(cardSrc);
const techReaches = /_renderMusicStrip\([\s\S]{0,200}?_renderLeaseLine/.test(cardSrc);

console.log('');
if (holders >= 3 && simpleReaches && techReaches) {
    console.log(`✅ leg 5 — both card render modes emit the lease line (${holders - 1} call sites + 1 holder)`);
} else {
    console.error(
        `❌ leg 5 — a card render mode does not emit the lease line: ` +
        `simple=${simpleReaches} technical=${techReaches} refs=${holders}\n` +
        '     A mode that omits it renders NOTHING and looks exactly like "nothing to report".\n' +
        '     This is the 0.1.12/0.1.13 defect: correct data, correct string, never in the DOM —\n' +
        '     and the restart-negative check PASSES against it, because silence is what it expects.',
    );
    failed++;
}

console.log('');
if (failed) {
    console.error(`❌ ${failed} control(s)/leg(s) failed`);
    process.exit(1);
}
console.log(`✅ ${CASES.length}/${CASES.length} controls + legs 2–5 pass — #72 holds, and every render mode shows it`);
