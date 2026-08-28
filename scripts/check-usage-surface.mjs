#!/usr/bin/env node
/**
 * check-usage-surface — the box-local Usage page is REACHABLE, and it does not
 * invent what the local record cannot know.
 *
 * ── WHY THIS GATE, AND WHY THIS SHAPE ───────────────────────────────────────
 *
 * Two defects this ground has ALREADY SHIPPED, both here in one change:
 *
 * ① **Authored but unreachable.** `usage-store.js` wrote `/data/usage.json` for
 *    months and `readUsage()` was called by nothing outside its own file — a
 *    record accumulating where nobody could see it. Before that, the `onboarding`
 *    page was whitelisted in `LOCAL_MODE_PAGES`, carefully reasoned about in a
 *    comment, and had no `App.PAGES` entry and no reference outside its own file;
 *    being on the list made it LOOK reachable. Before that, 0.1.8 shipped the
 *    Devices page with `isPageEnabled('devices') === false` — built, vendored,
 *    released, unreachable by every user, changelog claiming otherwise.
 *    ⭐ So reachability is not one check, it is a CHAIN, and the chain is what
 *    this file asserts: whitelist → page registry → nav entry → script tag.
 *    Any single missing link renders the other three inert and none of them says
 *    so at runtime.
 *
 * ② **Faking a field the local side cannot know.** The local record has no cost
 *    and no balance — there is no account and no money on a BYOK box. A Usage
 *    page showing "$0.00" would not be empty, it would be WRONG, and wrong about
 *    money. `DevicesSource` established the rule (null, never faked); this
 *    enforces it for the surface where the temptation is strongest.
 *
 * Exit 0 = green, 1 = a real failure, 2 = cannot check.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', 'dashie-ha');
const errors = [];
const pass = [];
const ok = (m) => pass.push(m);
const fail = (m) => errors.push(m);

function read(rel) {
    try { return readFileSync(resolve(ROOT, rel), 'utf8'); }
    catch (e) { console.error(`❌ cannot read ${rel}: ${e.message}`); process.exit(2); }
}

const gate    = read('frontend/console/js/lib/feature-gate.js');
const app     = read('frontend/console/js/app.js');
const sidebar = read('frontend/console/js/components/sidebar.js');
const html    = read('frontend/console/index.html');
const page    = read('frontend/console/js/pages/usage.js');
const source  = read('frontend/console/js/pages/usage-source.js');
const route   = read('server/api/usage.js');
const index   = read('server/index.js');
const brainIo = read('server/brain/addon-io.js');
const store   = read('server/usage-store.js');

// ── Leg 1: the REACHABILITY CHAIN, all four links ───────────────────────────
// ⚠️ Each link is matched INSIDE its own construct, not by a windowed search.
// A first cut used `/LOCAL_MODE_PAGES[\s\S]{0,2000}?'usage'/` and passed under its
// own mutation: removing 'usage' from LOCAL_MODE_PAGES left the very next set,
// LOCAL_ONLY_PAGES: new Set(['usage']), inside the window. The regex was reading
// the wrong set. Extract the set body, then test it.
const setBody = (src, name) => {
    const m = src.match(new RegExp(`${name}\\s*:\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`));
    return m ? m[1] : '';
};
const chain = [
    ["the local-mode whitelist (FeatureGate.LOCAL_MODE_PAGES)", /'usage'/.test(setBody(gate, 'LOCAL_MODE_PAGES'))],
    ["the local-ONLY gate (FeatureGate.LOCAL_ONLY_PAGES)",      /'usage'/.test(setBody(gate, 'LOCAL_ONLY_PAGES'))],
    ["the page registry (App.PAGES)",                           /\busage\s*:\s*\{\s*page\s*:/.test(app)],
    ["a nav entry (Sidebar)",                                   /_gatedNavItem\(\s*'usage'/.test(sidebar)],
    ["a <script> tag (index.html)",                             /js\/pages\/usage\.js/.test(html)],
    ["the adapter's <script> tag (index.html)",                 /js\/pages\/usage-source\.js/.test(html)],
];
const broken = chain.filter(([, present]) => !present).map(([what]) => what);
if (broken.length === 0) {
    ok(`1: the Usage page is reachable — all ${chain.length} links present`);
} else {
    fail(
        `[1] The Usage page is NOT reachable. Missing: ${broken.join(' · ')}.\n` +
        `      Every other link can be present and correct and the page still never renders — ` +
        `that is the 'onboarding' failure (whitelisted, no App.PAGES entry) and the 0.1.8 Devices ` +
        `failure (mounted, isPageEnabled false) in the same repo. Nothing says so at runtime.`
    );
}

// ── Leg 2: the local-only gate is enforced CENTRALLY, not in the sidebar ────
if (/LOCAL_ONLY_PAGES\.has\(page\)/.test(gate) && /isPageEnabled/.test(gate)) {
    ok('2: local-only is enforced inside isPageEnabled (governs nav, routing and hash together)');
} else {
    fail(
        `[2] LOCAL_ONLY_PAGES is not consulted by isPageEnabled. feature-gate's own design note ` +
        `says the whitelist governs the sidebar, _isRoutable, navigate() and hash routing "from ` +
        `this single point" — a sidebar-only branch leaves #usage routable on a signed-in console.`
    );
}

// ── Leg 3: no invented money on a page that has none ────────────────────────
// The local store records calls/errors/units. It records NO cost and NO balance.
const MONEY = [/\$\{?[0-9]/, /\btoFixed\(2\)/, /\bcost\b\s*[:=]\s*[0-9]/, /get_credit_balance/, /\bbalance\b\s*[:=]/];
const moneyHits = MONEY.filter((re) => re.test(page));
if (moneyHits.length === 0) {
    ok('3: the local Usage page invents no cost or balance');
} else {
    fail(
        `[3] The local Usage page appears to render cost/balance. The box-local record has neither ` +
        `— no account, no money, no per-turn rows. Showing "$0.00" is not an empty page, it is a ` +
        `WRONG one, about money. Omit the surface; never zero it (DevicesSource's rule).`
    );
}

// ── Leg 4: the page states its scope TRUTHFULLY, in whichever direction ─────
// Until B2a the page had to disclose that the AI-model leg was uncounted. B2a added
// that capture point, so the caveat became FALSE — and a stale caveat understates the
// record, which is a lie in the direction a reader is least likely to check. This leg
// tracks the code rather than one wording: the disclosure must match the lanes that
// actually have capture points.
{
    const brainCaptured = /lane: 'brain'/.test(brainIo);
    const claimsUncounted = /AI-model leg[\s\S]{0,120}not (recorded|counted)/.test(page);
    const claimsAllThree = /all three legs of a turn/.test(page);
    if (brainCaptured && claimsUncounted) {
        fail(
            `[4] The Usage page still says the AI-model leg is not recorded, but addon-io.js DOES ` +
            `record the brain lane. The caveat is now false and understates the record.`
        );
    } else if (!brainCaptured && claimsAllThree) {
        fail(
            `[4] The Usage page claims it covers all three legs, but no brain-lane capture point ` +
            `exists in addon-io.js. That overstates the record.`
        );
    } else if (brainCaptured ? claimsAllThree : claimsUncounted) {
        ok(`4: the page's scope disclosure matches the lanes that actually record`);
    } else {
        fail(`[4] The Usage page makes no scope disclosure at all. A list of lanes with no statement of coverage reads as "this is everything".`);
    }
}

// ── Leg 5: the range means CALENDAR days, not bucket count ──────────────────
// Buckets exist only for days the box made a call, so `slice(-days)` can return a
// year of them and the page would label it "the last 30 days".
if (/const cutoff\s*=/.test(route) && /allKeys\.filter\(/.test(route)) {
    ok('5: the route windows by calendar date, not by bucket count');
} else {
    fail(
        `[5] GET /api/usage does not window by calendar date. Day buckets exist only for days the ` +
        `box actually made a call, so taking the last N BUCKETS can span a year on a lightly-used ` +
        `box — and the page labels its window "the last N days". The route would be handing the ` +
        `page a false statement to render.`
    );
}

// ── Leg 6: read-only by construction ────────────────────────────────────────
// usage-store's own argument: a record its own subject can rewrite is not a record.
if (!/router\.(post|put|patch|delete)\s*\(/i.test(route)) {
    ok('6: the usage route is read-only (no write verb)');
} else {
    fail(
        `[6] server/api/usage.js exposes a write verb. This is an OBSERVATION store — usage-store.js ` +
        `argues in its own header that a record its own subject can rewrite is not a record, which ` +
        `is why it does not live in the panel-writable settings blob. There must be no write route.`
    );
}

// ── Leg 7: the route is actually MOUNTED and its binding declared ───────────
// An unmounted router is leg 1's failure one layer down; an undeclared `let`
// binding throws at boot, which is louder but just as fatal.
if (/app\.use\(\s*'\/api\/usage'/.test(index) && /\busageRouter\b[^=]*?=\s*require\('\.\/api\/usage'\)/.test(index)) {
    if (/let[\s\S]{0,400}?\busageRouter\b/.test(index)) {
        ok('7: the usage router is required, declared and mounted');
    } else {
        fail(`[7] usageRouter is assigned and mounted but never DECLARED in index.js's let list — it throws at boot.`);
    }
} else {
    fail(`[7] server/api/usage.js is not mounted in index.js. The page's only data source would 404.`);
}

// ── Leg 8: the adapter does not fake a per-row cost ─────────────────────────
if (/cost/i.test(source) && !/cost\s*:\s*(?!null)[^,\n]/.test(source)) {
    ok('8: UsageSource documents cost as absent rather than synthesising one');
} else if (!/cost/i.test(source)) {
    fail(
        `[8] UsageSource does not mention cost at all. The rule inherited from DevicesSource is to ` +
        `say explicitly what the local side cannot know — silence is how the next reader adds it.`
    );
} else {
    fail(`[8] UsageSource appears to assign a non-null cost. The box-local record has no cost field.`);
}

// ── Leg 9: the brain lane records ABOVE the signedIn early return (B2a) ─────
// D's contract §2: record REGARDLESS of an account token. The cloud logger returns
// early on !token; inheriting that condition means a box that later LINKS an account
// silently stops keeping its own record, and the local Usage view gains a gap exactly
// at the transition — invisibly, because both halves still appear to work. Below the
// return, this is correct on every box we would test on and wrong on the rest.
{
    const rec = brainIo.indexOf("lane: 'brain'");
    const gate = brainIo.indexOf('if (signedIn) return postDbOp');
    if (rec === -1) {
        fail(`[9] No brain-lane recordLocalUsage call in addon-io.js — the LLM leg is uncounted and the Usage page's caveat is load-bearing.`);
    } else if (gate === -1) {
        fail(`[9] Could not find the signedIn early return in addon-io.js — the ordering this leg exists to assert cannot be checked.`);
    } else if (rec < gate) {
        ok('9: the brain lane records above the signedIn early return (unconditional)');
    } else {
        fail(
            `[9] The brain-lane recordLocalUsage call sits BELOW the signedIn early return. ` +
            `A box that later links an account then silently stops keeping its own record — ` +
            `correct on the account-less box we test on, wrong on every other. D's contract §2.`
        );
    }
}

// ── Leg 10: no spread of the brain's payload into the usage store ──────────
// That object carries session_id / endpoint_id / request_length. The store's entire
// claim is that it holds no ids, and recordLocalUsage takes a NARROW object precisely
// so they cannot arrive by accident. A spread passes every other gate: the entry key
// is provider|model|billing and the extra fields ride along inside the entry.
{
    const call = brainIo.match(/recordLocalUsage\(\{[\s\S]*?\n\s*\}\)/);
    if (!call) {
        fail(`[10] Could not locate the recordLocalUsage call in addon-io.js to check its shape.`);
    } else if (/\.\.\.\s*data/.test(call[0])) {
        fail(
            `[10] The brain-lane usage call SPREADS the brain payload. That object carries ` +
            `session_id, endpoint_id and request_length — this store's whole claim is that it ` +
            `holds no ids, and its sink takes a narrow object so they cannot arrive by accident. ` +
            `Name every field explicitly.`
        );
    } else if (/session_id|endpoint_id|request_length/.test(call[0])) {
        fail(`[10] The brain-lane usage call names an identifying field (session_id / endpoint_id / request_length). The store holds no ids.`);
    } else {
        ok('10: the brain-lane usage call names its fields explicitly and carries no ids');
    }
}

// ── Leg 11: the page labels the window the route SERVED, not the one it asked ─
// The route caps at retention. Ask for 90 against a 60-day retention and you get 60,
// so a page labelling from its own range states something false — which is exactly what
// row 80's 400→60 change did to the existing 90-day button.
if (/daysServed/.test(source) && /this\._daysServed \|\| this\._range/.test(page)) {
    ok('11: the Usage page labels its window from what the route served (retention-capped)');
} else {
    fail(
        `[11] The Usage page labels its window from its own requested range. The route caps the ` +
        `window at the store's retention, so the two diverge the moment a range button exceeds ` +
        `it — the page then states a period it was not given data for.`
    );
}

if (errors.length) {
    console.error(`\n❌ usage-surface check failed (${errors.length} issue${errors.length > 1 ? 's' : ''}):\n`);
    for (const e of errors) console.error('  • ' + e + '\n');
    process.exit(1);
}
console.log(`✅ usage-surface check passed — ${pass.length} assertions:`);
for (const p of pass) console.log(`   · ${p}`);
