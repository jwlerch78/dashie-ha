#!/usr/bin/env node
/**
 * check-release-scope — the HA first release is BYOK-only. Does the build
 * actually withhold the pay surfaces, and does withholding them break anything?
 *
 * John, 2026-10-08, for the two-week HA release: *"credits can't be part of the
 * first release"*, *"it needs to be exclusively BYOK to start"*, *"scheduled
 * actions are out for first release (should be alpha gated)"*.
 *
 * ── WHY THIS IS A GATE AND NOT JUST TWO DELETED LINES ───────────────────────
 *
 * The cut itself was two lines out of PUBLISHED_RULE_OVERRIDES. The reason it
 * needs a gate is that ONE OF THOSE TWO LINES WAS A BUG FIX, and deleting it
 * naively reintroduces the bug it fixed.
 *
 * `scheduledActions: true` was added 2026-08-01 because 'scheduled-actions' is
 * in ACCOUNT_LOCKED_PAGES: a signed-out standard user saw it VISIBLE-but-locked,
 * signed in to unlock it, and watched it DISAPPEAR, because the family rule is
 * 'alpha-only'. "Signing in must never remove a feature you were just shown."
 * The same trap was sitting under `credits`.
 *
 * So the cut needed a third change — the PAGE_FEATURE guard in `isLocked()` —
 * and legs D/E below are about THAT, not about the two deletions. A reviewer
 * reading the diff sees two lines vanish and has no way to see the defect that
 * would have shipped with them.
 *
 * ── THE SHAPE OF EACH LEG, AND WHAT WOULD MAKE IT LIE ───────────────────────
 *
 * A. the cut. Hidden-ness is trivially satisfiable (hide everything), so each
 *    denial is paired with a control: voice-ai and devices MUST stay visible.
 *    Without those, "credits is hidden" passes on a console that renders
 *    nothing at all.
 *
 * B. the cut is a COHORT GATE, not a deletion. An alpha user must still see
 *    both pages. If someone later "simplifies" this by deleting the pages or
 *    emptying FEATURE_RULES, leg A stays green and only leg B notices. This is
 *    the leg that distinguishes what John asked for from a superficially
 *    identical wrong answer.
 *
 * C. no pay surfaces in the account-less console, and the two reasons a page
 *    can be un-locked are kept APART. 'devices' is un-locked because it WORKS
 *    without an account (LOCAL_MODE_PAGES); 'credits' is un-locked because the
 *    feature is OFF. Asserting only `isLocked === false` would conflate a
 *    working page with an absent one, so each is asserted together with
 *    whether it is actually enabled.
 *
 * D. 🔴 THE INVARIANT, stated generally rather than about credits: for every
 *    page and every cohort, a page that is LOCKED signed-out must be ENABLED
 *    signed-in. That is the 2026-08-01 defect written as a property, so it
 *    covers pages and cohorts nobody has thought of yet — including whatever
 *    the next release cut touches.
 *
 * E. the fault injection that keeps D honest. D iterates only over pages that
 *    are locked, so a change making NOTHING locked would leave it green with
 *    zero assertions — a vacuous pass of exactly the shape this repo keeps
 *    finding (traps 13, 181a). E restores the pre-fix `isLocked` and requires
 *    the invariant to actually BREAK. If E ever goes green-with-zero, D has
 *    stopped measuring anything.
 *
 * G. 🔴 THE PRESET FUNDING GATE — D3, added 2026-10-09, and the reason it is
 *    here is that the D1 cut BROKE it in a way every other leg stays green for.
 *
 *    Keeping the Cloud preset (John, 2026-10-09: *"We probably can keep cloud,
 *    but it requires a gemini key"*) means a preset now has a KEY requirement.
 *    `_hasCreditsOrKey()` could not express one. It opened with
 *
 *        if (!FeatureGate.shouldShow('credits')) return true;
 *
 *    — right while credits were the only way to fund a cloud preset, and a
 *    BLANKET UNLOCK the instant leg A hid them, which is every standard user on
 *    this release. It also asked only whether SOME key is stored, so a Serper
 *    key unlocked Cloud, which runs on Gemini and cannot touch it.
 *
 *    Both defects are invisible to legs A–F: the pages really are hidden, the
 *    invariant really does hold. What shipped was a picker offering a preset
 *    whose first utterance cannot run — the membership-is-not-enforcement shape
 *    this repo keeps paying for. G drives the REAL `VoiceAiPage._hasKeyFor`
 *    against a fully-specified world, and G9 re-injects the old branch and
 *    requires the result to flip, so G2 cannot pass vacuously.
 *
 * ⚠️ What this is blind to: legs A–F read feature-gate.js only. They do not prove
 * the SIDEBAR asks these questions (check-entitlement-gate drives the real
 * Sidebar.render for that axis), nor that no page body renders a credits CTA of
 * its own. Leg F covers the one such CTA known to exist. Leg G proves the gate
 * FUNCTION answers correctly; it does not prove the picker renders its answer
 * (`available(id)` is passed in by the page — one hop this gate does not walk).
 *
 * 📌 The OTHER pay surface on that page — the credit-priced "Retrieve pictures"
 * row — is cohort-gated the same way and asserted in **check-voice-sections legs
 * 31–33**, which lives there because that is the harness able to drive the real
 * `_renderAiDefaults()`. Keep the two cross-referenced if either moves.
 *
 * Exit 0 = every leg passes, 1 = a violation, 2 = cannot check.
 */
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONSOLE_DIR = `${ROOT}/dashie-ha/frontend/console`;
const GATE = `${CONSOLE_DIR}/js/lib/feature-gate.js`;
const PICKER = `${CONSOLE_DIR}/js/components/voice-ai-preset-picker.js`;
const BRANDJS = `${CONSOLE_DIR}/js/lib/brand.js`;
const OPTIONS = `${CONSOLE_DIR}/js/lib/voice-ai-options.js`;
const PAGE = `${CONSOLE_DIR}/js/pages/voice-ai.js`;
for (const f of [GATE, PICKER, BRANDJS, OPTIONS, PAGE]) {
    if (!existsSync(f)) { console.log(`BLIND: ${f.replace(ROOT + '/', '')} not found`); process.exit(2); }
}

let pass = 0, fail = 0;
const t = (n, ok, d) => {
    if (ok) { pass++; console.log(`  PASS  ${n}`); }
    else { fail++; console.log(`  FAIL  ${n}${d ? '\n          ' + d : ''}`); }
};
const die = (m) => { console.log(`BLIND: ${m}`); process.exit(2); };

const sandbox = { console };
sandbox.window = sandbox; sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
try { vm.runInContext(readFileSync(GATE, 'utf8'), ctx, { filename: GATE }); }
catch (e) { die(`feature-gate.js did not evaluate: ${e.message}`); }
const FG = vm.runInContext('typeof FeatureGate !== "undefined" ? FeatureGate : null', ctx);
if (!FG || typeof FG.isPageEnabled !== 'function' || typeof FG.isLocked !== 'function') {
    die('FeatureGate.isPageEnabled / isLocked did not load');
}
if (!FG.PAGE_FEATURE || !FG.ACCOUNT_LOCKED_PAGES) die('PAGE_FEATURE / ACCOUNT_LOCKED_PAGES did not load');

/** Fully-specified world at every call site — a default is how a leg ends up
 *  asserting about a state nobody meant to test. */
function world({ build = 'published', state = null, localMode = false,
                 specialAccess = 'standard', tier = 'standard' } = {}) {
    sandbox.BRAND = { build, cloudName: 'Dashie Cloud', productName: 'Dashie',
                      logo: 'assets/logo.svg', icon: 'assets/icon.svg' };
    sandbox.DashieAuth = {
        isLocalMode: localMode, isAddonMode: true, isAuthenticated: !localMode,
        specialAccess, tier, config: { url: 'https://cwglbtosingboqepsmjk.supabase.co' },
    };
    FG._subscriptionState = state;
}
const ACTIVE = { subscription_status: 'active', tier: 'premium' };
const en = (p, w) => { world(w); return FG.isPageEnabled(p); };
const lk = (p, w) => { world(w); return FG.isLocked(p); };

// ── A. the cut, with the controls that stop it being vacuous ────────────────
console.log('A — the cut (published build, signed-in STANDARD user)');
const voiceOk = en('voice-ai', { state: ACTIVE }) === true;
t('A1 CONTROL: voice-ai is VISIBLE — the product survived the cut', voiceOk,
  'the gate is denying broadly; every denial below is vacuous');
if (!voiceOk) { console.log(`check-release-scope: ${pass} pass, ${fail} fail`); process.exit(1); }
t('A2 CONTROL: devices is VISIBLE', en('devices', { state: ACTIVE }) === true);
t('A3 credits is HIDDEN', en('credits', { state: ACTIVE }) === false,
  'credits is reachable in the published build — John cut it from the first release');
t('A4 scheduled-actions is HIDDEN', en('scheduled-actions', { state: ACTIVE }) === false);

// ── B. a cohort gate, NOT a deletion ───────────────────────────────────────
console.log('B — the cut is alpha-gated, not removed');
t('B1 an ALPHA user still SEES credits',
  en('credits', { state: ACTIVE, specialAccess: 'alpha' }) === true,
  'the pages are gone entirely rather than alpha-gated — John asked for "alpha gated"');
t('B2 an ALPHA user still SEES scheduled-actions',
  en('scheduled-actions', { state: ACTIVE, specialAccess: 'alpha' }) === true);

// ── C. no pay surfaces in the account-less console ─────────────────────────
console.log('C — the account-less console offers no pay surface');
t('C1 credits is not teased as locked, and is not enabled either (absent, not working)',
  lk('credits', { localMode: true }) === false && en('credits', { localMode: true }) === false);
t('C2 scheduled-actions likewise',
  lk('scheduled-actions', { localMode: true }) === false
  && en('scheduled-actions', { localMode: true }) === false);
t('C3 CONTROL: account STILL teases (it genuinely needs an account)',
  lk('account', { localMode: true }) === true,
  'the isLocked guard over-reached — pages that really do need an account stopped teasing');
t('C4 CONTROL: preferences STILL teases', lk('preferences', { localMode: true }) === true);
t('C5 CONTROL: devices is un-locked because it WORKS, not because it is off',
  lk('devices', { localMode: true }) === false && en('devices', { localMode: true }) === true,
  'devices is in LOCAL_MODE_PAGES; conflating "works without an account" with "feature off" '
  + 'is how C1 would pass on a console that had simply hidden everything');

// ── D. THE INVARIANT ───────────────────────────────────────────────────────
console.log('D — INVARIANT: locked signed-out ⇒ reachable signed-in');
const LOCKED_PAGES = [...FG.ACCOUNT_LOCKED_PAGES];
let dAsserted = 0;
for (const sa of ['standard', 'alpha']) {
    for (const p of LOCKED_PAGES) {
        if (lk(p, { localMode: true, specialAccess: sa }) !== true) continue;
        dAsserted++;
        t(`D [${sa}] '${p}' is locked signed-out, so it must be visible signed-in`,
          en(p, { state: ACTIVE, specialAccess: sa }) === true,
          `signing in REMOVES '${p}' — a feature was shown and then taken away `
          + '(the 2026-08-01 defect). Either un-lock the page or un-hide the feature.');
    }
}
t(`D0 CONTROL: the invariant actually examined something (${dAsserted} page/cohort pairs)`,
  dAsserted > 0, 'nothing is locked, so leg D asserted nothing at all');

// ── E. fault injection: the invariant can fail ─────────────────────────────
console.log('E — fault injection (restore the pre-fix isLocked; D must break)');
const realIsLocked = FG.isLocked;
FG.isLocked = function (page) {
    if (!this.requiresAccount(page)) return false;
    if (!this.ACCOUNT_LOCKED_PAGES.has(page)) return false;
    if (this.CLOSED_DELTA_PAGES.has(page)) return false;
    return true;                      // ← the missing PAGE_FEATURE guard
};
const broken = [];
for (const p of LOCKED_PAGES) {
    if (lk(p, { localMode: true, specialAccess: 'standard' }) !== true) continue;
    if (en(p, { state: ACTIVE, specialAccess: 'standard' }) !== true) broken.push(p);
}
FG.isLocked = realIsLocked;
t(`E1 removing the guard DOES break the invariant (reproduced on: ${broken.join(', ') || 'NOTHING'})`,
  broken.length > 0,
  'leg D is vacuous — the invariant holds even without the guard, so D is not measuring it');

// ── F. the one credits CTA that lives outside the gate ─────────────────────
console.log('F — the preset picker does not offer an unreachable Credits link');
const picker = readFileSync(PICKER, 'utf8');
t('F1 the picker asks the gate before offering a credits link',
  /isPageEnabled\(\s*'credits'\s*\)/.test(picker),
  "voice-ai-preset-picker.js navigates to 'credits' from its locked-card copy. With credits "
  + 'alpha-gated that is a dead link inside the message telling the user how to recover.');
const navCredits = (picker.match(/App\.navigate\('credits'\)/g) || []).length;
t(`F2 CONTROL: the picker still HAS a credits link to gate (${navCredits} call site(s))`,
  navCredits > 0,
  'F1 passes vacuously if the link was deleted outright rather than gated — then this gate '
  + 'is asserting a conditional around nothing');


// ── G. the preset funding gate (D3) ────────────────────────────────────────
//
// Loaded into the SAME sandbox so `_hasKeyFor` calls the real FeatureGate and
// the real DashieAuth that `world()` sets, not stubs of them. `pages/voice-ai.js`
// ends in a bare `const VoiceAiPage = {...};` with no window assignment (the
// router holds the reference in classic-script scope), so the export line is
// appended to reach it. That appends a reference, not behaviour — the methods
// under test are untouched.
console.log('G — the preset funding gate asks for the key the preset NEEDS');
sandbox.document = { title: '', querySelector: () => null };
sandbox.fetch = async () => { throw new Error('check-release-scope: no network'); };
try {
    for (const f of [BRANDJS, OPTIONS]) vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    vm.runInContext(`${readFileSync(PAGE, 'utf8')}\n;window.__VoiceAiPage = VoiceAiPage;`,
                    ctx, { filename: PAGE });
} catch (e) {
    die(`the Voice & AI page did not evaluate: ${e.message}`);
}
const VP = sandbox.__VoiceAiPage;
const O = sandbox.VoiceAiOptions;
if (!VP || typeof VP._hasKeyFor !== 'function' || typeof VP._presetAvailable !== 'function') {
    die('VoiceAiPage._hasKeyFor / _presetAvailable did not load');
}
if (!O || !Array.isArray(O.PRESETS)) die('VoiceAiOptions.PRESETS did not load');

/** One fully-specified funding world. `keys` is the /api/keys/status reading:
 *  an OBJECT is a measurement (keyStore.status() always returns a row per
 *  provider), `null` means no reading was taken at all. */
function fund({ keys, balance = null, ...w }) {
    world(w);
    VP._keyStatus = keys;
    sandbox.CreditsService = { balance: () => balance };
}
const avail = (id, f) => { fund(f); return VP._presetAvailable(id); };

const needs = Object.fromEntries(O.PRESETS.map(p => [p.id, p.needsKey || null]));
t(`G1 CONTROL: the presets declare WHICH key they need (cloud=${needs.cloud}, hybrid=${needs.hybrid})`,
  needs.cloud === 'gemini' && needs.hybrid === 'any',
  'the rows no longer name a key requirement, so every leg below is asserting about a '
  + 'gate with nothing to gate on — this is the vacuous-pass shape, not a copy change');

const NO_KEYS = { gemini: false, openrouter: false, anthropic: false, serper: false };
t('G2 🔴 standard user, box measured with NO keys: Cloud is UNAVAILABLE',
  avail('cloud', { keys: NO_KEYS }) === false,
  'THE D1 DEFECT. With credits alpha-gated, `!shouldShow(\'credits\') => return true` '
  + 'unlocked every preset for every standard user with no key and no credits.');
t('G3 standard user, no keys: Hybrid is UNAVAILABLE too',
  avail('hybrid', { keys: NO_KEYS }) === false);

t('G4 a stored GEMINI key unlocks Cloud',
  avail('cloud', { keys: { ...NO_KEYS, gemini: true } }) === true,
  'the key the preset needs is present and it still will not unlock — the gate now '
  + 'fails CLOSED on a household that did exactly what the card asked');
t('G5 🔴 a stored NON-Gemini key unlocks Hybrid but NOT Cloud',
  avail('hybrid', { keys: { ...NO_KEYS, openrouter: true } }) === true
  && avail('cloud', { keys: { ...NO_KEYS, openrouter: true } }) === false,
  'the second half of the defect: `Object.values(ks).some(Boolean)` asked whether ANY key '
  + 'exists. Cloud runs its brain AND its transcription on Gemini; an OpenRouter key '
  + 'cannot serve either, so unlocking Cloud on one offers a preset that cannot speak.');

t('G6 CONTROL: Local and HA Assist are never gated',
  avail('local', { keys: NO_KEYS }) === true && avail('ha_assist', { keys: NO_KEYS }) === true,
  'the keyless presets started requiring a key — the gate is over-reaching, and G2/G3 '
  + 'would pass on a picker that locks everything');
t('G7 CONTROL: an UNMEASURED key file stays optimistic (no flash-disable)',
  avail('cloud', { keys: null }) === true && avail('hybrid', { keys: null }) === true,
  'off-box (`_fetchKeyStatus` nulls `_keyStatus` outside add-on mode) and in-flight both '
  + 'read as null. Treating "we did not look" as "there is none" locks a working household '
  + 'out of its own key on a measurement that never ran.');

// Credits are still a funding source where they EXIST — the cut is a cohort gate
// (leg B), so an alpha account with a balance must keep working.
t('G8 an ALPHA account with a positive balance and no keys: Cloud is available',
  avail('cloud', { keys: NO_KEYS, specialAccess: 'alpha', state: ACTIVE,
                   balance: { balance: 500 } }) === true,
  'the fix over-corrected: credits were cut from the standard cohort, not deleted');
t('G9 an ALPHA account at ZERO balance with no keys: Cloud is UNAVAILABLE',
  avail('cloud', { keys: NO_KEYS, specialAccess: 'alpha', state: ACTIVE,
                   balance: { balance: 0 } }) === false);

// ── G10. fault injection: restore the pre-fix branch; G2 must flip ─────────
// 🔴 THE STUB IS COMPILED INSIDE THE VM CONTEXT, not in this module. First
// attempt defined it here, where `FeatureGate` is not a binding at all — so
// `typeof FeatureGate !== 'undefined'` was false, the blanket branch never ran,
// and the injection returned the RIGHT answer for the wrong reason. G10 caught
// it (trap 13: did the instrument do to the subject what it claims?), and it
// would have read as "the defect is already gone" rather than as a broken probe.
const realHasKeyFor = VP._hasKeyFor;
vm.runInContext(`window.__VoiceAiPage._hasKeyFor = function () {
    // verbatim first branch of the old _hasCreditsOrKey()
    if (typeof FeatureGate !== 'undefined' && !FeatureGate.shouldShow('credits')) return true;
    const ks = this._keyStatus;
    if (ks && Object.values(ks).some(Boolean)) return true;
    return false;
};`, ctx, { filename: 'inject-pre-fix-gate' });
const injected = {
    cloudNoKeys: avail('cloud', { keys: NO_KEYS }),
    cloudWrongKey: avail('cloud', { keys: { ...NO_KEYS, openrouter: true } }),
};
VP._hasKeyFor = realHasKeyFor;
t('G10 FAULT INJECTION: the pre-fix gate DOES unlock Cloud with no key '
  + `(no-keys => ${injected.cloudNoKeys}, wrong-key => ${injected.cloudWrongKey})`,
  injected.cloudNoKeys === true && injected.cloudWrongKey === true,
  'the old branch no longer produces the wrong answer, which means G2/G5 are not '
  + 'measuring what they claim — an injection that fails to turn a leg red is a '
  + 'finding about the leg, not about the code');
t('G11 CONTROL: the real gate is back in place after the injection',
  VP._presetAvailable('cloud') !== undefined && avail('cloud', { keys: NO_KEYS }) === false,
  'the injection leaked — every leg after it is running against a stub');

console.log(`\ncheck-release-scope: ${pass} pass, ${fail} fail`);
if (fail === 0) console.log('ALL PASS');
process.exit(fail ? 1 : 0);
