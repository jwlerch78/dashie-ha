#!/usr/bin/env node
/**
 * check-entitlement-gate — does the published build's entitlement gate DENY?
 *
 * Guards the 2026-10-06 change that moved the Dashie Cloud dashboard pages
 * (family, calendar, photos, chores, rewards, locations) into the published HA
 * tree. John's rule for them: "those items should only become visible when the
 * user is logged into an active dashie account."
 *
 * ── WHY A GATE AT ALL, AND WHY THESE LEGS ───────────────────────────────────
 *
 * 🔴 THE DEFECT THIS REPLACES WAS A GATE THAT COULD NOT FAIL. Before this date
 * both sets (ENTITLEMENT_GATED_PAGES, HA_ONLY_HIDDEN_PAGES) already listed all
 * six pages CORRECTLY — and `isPageEnabled` returned out of its published
 * branch before ever reading either one. Membership is not enforcement. A green
 * run showing "the pages appear for an entitled user" would have passed
 * identically with no gate at all, which is why every leg below is a DENIAL and
 * the allow legs exist only as controls that keep the denials honest.
 *
 * ── THE TWO WAYS THIS GATE GOES VACUOUS, both of which have bitten ──────────
 *
 * A. EVERYTHING DENIED. If `_subscriptionState` is never populated the gate
 *    denies every page always, and legs 2-4 pass while the product is broken.
 *    Leg 1 (an entitled account SEES calendar) is the control that catches it,
 *    and it runs FIRST. Legs 10-11 are the same shape for the cohort axis: a
 *    page hidden by `alpha-only` would satisfy an entitlement denial for
 *    entirely the wrong reason, so leg 11 proves the alpha user sees it.
 *
 * B. THE HARNESS POPULATES WHAT THE APP DOES NOT. Legs 1-12 set
 *    `_subscriptionState` directly, so they cannot see whether anything in the
 *    shipped app ever calls `setSubscriptionState`. In the published tree
 *    `subscribe-gate.js` does not exist, so if `app.js` lost that call the gate
 *    would deny forever and this harness would stay green. Legs 13-15 are
 *    static assertions on app.js for exactly that arm.
 *
 * ── LEG 6-9: THE REGRESSION THIS GATE CAUGHT ON ITS FIRST RUN ───────────────
 *
 * 🔴 `voice-ai` is a member of ENTITLEMENT_GATED_PAGES, and in the PUBLISHED
 * build it is the free HA product: `PUBLISHED_RULE_OVERRIDES.voiceAi = true`,
 * it is in LOCAL_MODE_PAGES (reachable with NO account), and `App._homePage()`
 * returns it unconditionally for this build — "the only home that works signed
 * out". Applying the entitlement set wholesale therefore hid the add-on's home
 * page from every account-less user, permanently, and from every signed-in user
 * until check-subscription resolved. The build plan's snippet did exactly that.
 * Legs 6-8 pin the exemption; leg 9 pins that it does NOT leak into the full
 * build, where voice-ai genuinely is part of the paid bundle.
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
const APP = `${CONSOLE_DIR}/js/app.js`;
const INDEX = `${CONSOLE_DIR}/index.html`;
for (const f of [GATE, APP, INDEX]) {
    if (!existsSync(f)) { console.log(`BLIND: ${f.replace(ROOT + '/', '')} not found`); process.exit(2); }
}

let pass = 0, fail = 0;
const t = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); } };
const die = (msg) => { console.log(`BLIND: ${msg}`); process.exit(2); };

// ── Load the REAL feature-gate.js into a context we can steer ───────────────
const sandbox = { console };
sandbox.window = sandbox; sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
try { vm.runInContext(readFileSync(GATE, 'utf8'), ctx, { filename: GATE }); }
catch (e) { die(`feature-gate.js did not evaluate: ${e.message}`); }
const FG = vm.runInContext('typeof FeatureGate !== "undefined" ? FeatureGate : null', ctx);
if (!FG || typeof FG.isPageEnabled !== 'function') die('FeatureGate.isPageEnabled did not load');

// The SIDEBAR is the surface John actually reports on ("it's still not showing
// the dashie pages on the left?"), and it is a separate question from the gate:
// isPageEnabled could be perfect while the nav asked something else, or asked
// nothing. Load the real component and render it.
const SIDEBAR = `${CONSOLE_DIR}/js/components/sidebar.js`;
if (!existsSync(SIDEBAR)) die('components/sidebar.js not found');
try { vm.runInContext(readFileSync(SIDEBAR, 'utf8'), ctx, { filename: SIDEBAR }); }
catch (e) { die(`sidebar.js did not evaluate: ${e.message}`); }
const SB = vm.runInContext('typeof Sidebar !== "undefined" ? Sidebar : null', ctx);
if (!SB || typeof SB.render !== 'function') die('Sidebar.render did not load');

/**
 * Ask the real isPageEnabled under a fully-specified world. Every field is
 * named explicitly at each call site rather than defaulted, because a default
 * is how a leg ends up asserting about a state nobody meant to test.
 */
function enabled(page, { build, state, localMode = false, specialAccess = 'standard', tier = 'standard' }) {
    sandbox.BRAND = { build, cloudName: 'Dashie Cloud', productName: 'Dashie',
                     logo: 'assets/logo.svg', icon: 'assets/icon.svg' };
    sandbox.DashieAuth = {
        isLocalMode: localMode, isAddonMode: true, isAuthenticated: !localMode,
        specialAccess, tier, config: { url: 'https://cwglbtosingboqepsmjk.supabase.co' },
    };
    FG._subscriptionState = state;
    return FG.isPageEnabled(page);
}

const ACTIVE       = { subscription_status: 'active',        tier: 'premium' };
const TRIALING     = { subscription_status: 'trialing',      tier: 'premium' };
const EXPIRED      = { subscription_status: 'trial_expired', tier: 'free' };
const HA_ONLY      = { subscription_status: 'ha_only',       tier: 'free' };
const PUB = (state, extra = {}) => ({ build: 'published', state, ...extra });

// ── 1. THE CONTROL THAT MAKES EVERY DENIAL BELOW MEAN SOMETHING ─────────────
// Runs first on purpose. If the gate cannot say YES, it says NO to everything
// and legs 2-4 are satisfied by a product that simply does not work.
const allowActive = enabled('calendar', PUB(ACTIVE));
t('1 CONTROL: an ACTIVE account SEES calendar in the published build', allowActive === true,
  'the gate denies unconditionally — every denial leg below is vacuous');
if (allowActive !== true) {
    console.log('        (refusing to report the denial legs as green; fix leg 1 first)');
    console.log(`check-entitlement-gate: ${pass} pass, ${fail} fail`);
    process.exit(1);
}
t('1a CONTROL: a TRIALING account sees it too — "active" is not status==="active"',
  enabled('calendar', PUB(TRIALING)) === true);

// ── 2-4. THE DENIALS. These are the gate. ───────────────────────────────────
t('2 UNKNOWN state (null) HIDES calendar — fails CLOSED',
  enabled('calendar', PUB(null)) === false,
  'hasEntitlement() is optimistic on null; a network blip would SHOW the paid pages');
t('3 trial_expired HIDES calendar', enabled('calendar', PUB(EXPIRED)) === false);
t('4 ha_only HIDES calendar', enabled('calendar', PUB(HA_ONLY)) === false,
  'a voice-only account has no dashboard entitlement');
// ⚠️ AS AN ALPHA USER, and that is not padding. 'locations' (like chores and
// rewards) is 'alpha-only', so for a standard user it is hidden by the COHORT
// axis whatever entitlement says — its denial here would pass with the
// entitlement gate ripped out entirely. Measured: reverting B2 left leg 4a
// green for 'locations' while family and photos went red. Raising the cohort
// makes the only remaining reason for a denial the one this leg is about.
for (const p of ['family', 'photos', 'locations']) {
    const alpha = { specialAccess: 'alpha' };
    t(`4a ...and the same three denials hold for '${p}' (as an ALPHA user, so cohort cannot mask them)`,
      enabled(p, PUB(null, alpha)) === false && enabled(p, PUB(EXPIRED, alpha)) === false &&
      enabled(p, PUB(HA_ONLY, alpha)) === false);
    t(`4b CONTROL: ...and that same alpha user DOES see '${p}' when entitled`,
      enabled(p, PUB(ACTIVE, alpha)) === true,
      'leg 4a is denying for some reason other than entitlement');
}

// ── 5. Pages that are NOT entitlement-gated must be untouched ───────────────
t('5 CONTROL: devices + account survive trial_expired (not entitlement-gated)',
  enabled('devices', PUB(EXPIRED)) === true && enabled('account', PUB(EXPIRED)) === true,
  'the gate has over-reached into pages an expired user must still reach');

// ── 6-9. voice-ai: free HERE, paid THERE ────────────────────────────────────
t('6 🔴 voice-ai is VISIBLE with NO ACCOUNT (local mode) — it is the home page',
  enabled('voice-ai', PUB(null, { localMode: true })) === true,
  'the add-on home page is hidden for every account-less user');
t('7 🔴 voice-ai is VISIBLE signed in with UNKNOWN state',
  enabled('voice-ai', PUB(null)) === true,
  'the home page would blank until check-subscription resolves');
t('8 voice-ai survives trial_expired in the published build — it is the free HA product',
  enabled('voice-ai', PUB(EXPIRED)) === true);
t('9 CONTROL: the exemption does NOT leak — voice-ai IS hidden when expired in the FULL build',
  enabled('voice-ai', { build: 'full', state: EXPIRED }) === false,
  'a published-build exemption has been applied to the paid bundle');

// ── 10-11. The cohort axis is SEPARATE, and leg 11 proves leg 10's reason ───
t("10 chores stays hidden for an entitled STANDARD user (John: still alpha)",
  enabled('chores', PUB(ACTIVE)) === false && enabled('rewards', PUB(ACTIVE)) === false);
t('11 CONTROL: an ALPHA user with the same active account DOES see chores',
  enabled('chores', PUB(ACTIVE, { specialAccess: 'alpha' })) === true,
  'leg 10 is passing on the entitlement axis, not the cohort one — the axes are entangled');
t('12 ...and an alpha user with no entitlement still does NOT see chores',
  enabled('chores', PUB(null, { specialAccess: 'alpha' })) === false,
  'cohort must not be able to override entitlement');

// ── 13-15. THE OTHER HALF: is the state ever populated in the shipped app? ──
const app = readFileSync(APP, 'utf8');
t('13 app.js CALLS FeatureGate.setSubscriptionState — the published build has no other writer',
  /FeatureGate\.setSubscriptionState\(/.test(app),
  'subscribe-gate.js is a delta file absent from this tree; without this call the gate denies forever');
const fn = app.match(/async _refreshAccountState\(\)\s*\{[\s\S]*?\n    \},/);
t('14 ...from inside _refreshAccountState, after the check-subscription fetch',
  !!fn && /check-subscription/.test(fn[0]) && /FeatureGate\.setSubscriptionState\(/.test(fn[0]),
  'the call exists but not on the path that holds the response');
t('15 ...and _refreshAccountState is actually reached from _showApp',
  /_showApp\([\s\S]*?this\._refreshAccountState\(\)/.test(app),
  'authored but unreached — nothing invokes the only writer');

// ── 16-18. Tree presence: the pages must really be here ─────────────────────
const PAGES = ['family', 'calendar', 'calendar-add', 'calendar-edit', 'calendar-options',
               'chores', 'rewards', 'locations', 'photos', 'photos-upload', 'photos-album-edit'];
const missing = PAGES.filter((p) => !existsSync(`${CONSOLE_DIR}/js/pages/${p}.js`));
t('16 all 11 dashboard page modules exist in the published tree', missing.length === 0, missing.join(', '));
const html = readFileSync(INDEX, 'utf8');
const untagged = PAGES.filter((p) => !html.includes(`js/pages/${p}.js`));
t('17 ...and every one has a <script> tag in index.html', untagged.length === 0,
  `present but never loaded: ${untagged.join(', ')}`);
t('18 CLOSED_DELTA_PAGES no longer claims these pages are absent',
  !['family', 'calendar', 'chores', 'rewards', 'locations', 'photos'].some((p) => FG.CLOSED_DELTA_PAGES.has(p)),
  'a page cannot be both present in the tree and a member of the absent-by-definition set');


// ── 19-24. THE NAV, driven. The gate is not the observable; this is. ───────
function sidebar(world) {
    enabled('devices', world);           // sets BRAND + DashieAuth + state
    try { return SB.render('devices'); } catch (e) { return `THREW ${e.message}`; }
}
const navActive  = sidebar(PUB(ACTIVE));
const navUnknown = sidebar(PUB(null));
const navHaOnly  = sidebar(PUB(HA_ONLY));

// 🔴 GUARD BEFORE THE ABSENCE LEGS. A render that threw returns a string
// containing none of the row labels, so every "does NOT contain Calendar" leg
// below would pass on a sidebar that never rendered. This exact shape made two
// legs of check-bluetooth-surface green earlier today.
for (const [name, html] of [['active', navActive], ['unknown', navUnknown], ['ha_only', navHaOnly]]) {
    if (typeof html !== 'string' || html.startsWith('THREW') || !html.includes('sidebar-nav-item')) {
        t(`19pre the ${name} sidebar did not render`, false,
          `${String(html).slice(0, 160)} — every absence leg below would be vacuous`);
        console.log(`check-entitlement-gate: ${pass} pass, ${fail} fail`);
        process.exit(1);
    }
}
t('19pre CONTROL: all three sidebars rendered real nav items, so the absence legs mean something',
  true);

// ⚠️ THREE pages are 'alpha-only', not two. `locations: 'alpha-only'`
// (feature-gate.js:524) has NO published override, so a signed-in, fully-entitled
// STANDARD user does not see Locations either — only Calendar, Family and Photos.
// Recorded because the build plan's own ruling paragraph listed locations among
// what a standard user sees, and leg 19 caught that claim, not a code defect.
const DASH_ROWS = ['Calendar', 'Family', 'Photos'];
const ALPHA_ROWS = ['Chores', 'Rewards', 'Locations'];
t('19 an ACTIVE standard account SEES calendar/family/photos in the nav',
  DASH_ROWS.every((r) => navActive.includes(`>${r}<`)),
  DASH_ROWS.filter((r) => !navActive.includes(`>${r}<`)).join(', ') + ' missing');
t("19a ...and NOT the three 'alpha-only' rows",
  !ALPHA_ROWS.some((r) => navActive.includes(`>${r}<`)),
  ALPHA_ROWS.filter((r) => navActive.includes(`>${r}<`)).join(', ') + ' shown to a standard user');
t('20 UNKNOWN state renders NONE of the six — and not as locked rows either',
  ![...DASH_ROWS, ...ALPHA_ROWS].some((r) => navUnknown.includes(`>${r}<`)),
  [...DASH_ROWS, ...ALPHA_ROWS].filter((r) => navUnknown.includes(`>${r}<`)).join(', ') + ' still shown');
t('21 ...and the "Dashie Cloud" section LABEL collapses with it — no orphan heading',
  !navUnknown.includes('Dashie Cloud'),
  'the section header survives its last item, leaving an empty labelled block');
t('22 CONTROL: the ACTIVE sidebar DOES carry that section label',
  navActive.includes('Dashie Cloud'),
  'leg 21 is passing because the label never renders at all');
t('23 ha_only hides the dashboard rows but KEEPS Voice & AI — the product it pays for',
  !DASH_ROWS.some((r) => navHaOnly.includes(`>${r}<`)) && navHaOnly.includes('>Voice & AI<'));
t('24 Voice & AI is in the nav in ALL THREE states, including unknown',
  [navActive, navUnknown, navHaOnly].every((h) => h.includes('>Voice & AI<')),
  'the home-page row vanishes with the entitlement state — the leg-6 defect, at the nav');
t('25 chores/rewards stay out of the nav for an entitled STANDARD user (John\'s ruling)',
  !navActive.includes('>Chores<') && !navActive.includes('>Rewards<'));
t('26 CONTROL: ...and an ALPHA user with the same account DOES get all three',
  (() => { const h = sidebar(PUB(ACTIVE, { specialAccess: 'alpha' }));
           return ALPHA_ROWS.every((r) => h.includes(`>${r}<`)); })(),
  'leg 25/19a are passing on entitlement, not on the cohort rule John set');

console.log(`check-entitlement-gate: ${pass} pass, ${fail} fail`);
if (!fail) console.log('✅ entitlement gate: denies on unknown/expired/ha_only, keeps voice-ai free, cohort axis intact, and the NAV agrees');
process.exit(fail ? 1 : 0);
