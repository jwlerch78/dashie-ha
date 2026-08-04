#!/usr/bin/env node
/**
 * check-api-keys-surface — can a household actually ENTER a speech-provider key,
 * and does a stored-but-unspent one say so?
 *
 * ── WHY THIS IS DRIVEN AND NOT STATIC ────────────────────────────────────────
 *
 * The defect this closes was not a missing feature. Every component of "the user
 * can enter a Deepgram key" existed and was individually correct — the store
 * accepted it, the manifest declared it with `surfaces: ['api-keys',
 * 'onboarding']`, the honest-state renderer was written — and the outcome was
 * ZERO, because one filter excluded them and the only page that rendered them
 * was never mounted. A static check for "is deepgram in the manifest" would have
 * been green throughout.
 *
 * So this loads the REAL page object into a `vm` context with the REAL manifest
 * and renderer, and asserts on the HTML that comes out. Same lesson as
 * check-byok-tts leg 10, which stayed green against a dead-coded branch until it
 * was made to call the function.
 *
 * ── THE PROPERTIES ───────────────────────────────────────────────────────────
 *
 *   • the three speech providers reach the page at all      (the finding itself)
 *   • `routable` does not eat them — it answers a BRAIN question and would both
 *     hide them and, once keyed, badge them "Not used" with remedy copy telling
 *     the user to switch to OpenRouter, which is nonsense for a TTS key
 *   • a PENDING adapter renders the SHARED wording, not a fourth phrasing
 *   • a SHIPPED adapter does NOT (the positive control — without it, leg 3 would
 *     pass on a page that badges everything)
 *   • every state class the renderer emits has CSS. An unstyled chip renders as
 *     bare text in the middle of a card: the sentence is right there and reads
 *     as decoration, which is the same silent failure as no chip at all
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
    manifest: join(CONSOLE, 'js', 'lib', 'provider-manifest.js'),
    renderers: join(CONSOLE, 'js', 'lib', 'provider-auth-renderers.js'),
    page: join(CONSOLE, 'js', 'pages', 'api-keys.js'),
    css: join(CONSOLE, 'css', 'components.css'),
};

for (const [name, f] of Object.entries(FILES)) {
    if (!existsSync(f)) {
        console.error(`check-api-keys-surface: cannot check — ${name} not found at ${f}`);
        process.exit(2);
    }
}

// ── Load the real console modules into one shared scope ──────────────────────
const warnings = [];
const sandbox = {
    console: { ...console, warn: (...a) => warnings.push(a.join(' ')) },
    document: { getElementById: () => null },
    setTimeout, clearTimeout, fetch: async () => { throw new Error('no network in this control'); },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

try {
    for (const key of ['brand', 'manifest', 'renderers', 'page']) {
        vm.runInContext(readFileSync(FILES[key], 'utf8'), ctx, { filename: FILES[key] });
    }
} catch (e) {
    console.error(`check-api-keys-surface: cannot check — console module did not evaluate: ${e.message}`);
    process.exit(2);
}

const Page = sandbox.window.ApiKeysPage;
const Manifest = sandbox.window.ProviderManifest;
const Renderers = sandbox.window.ProviderAuthRenderers;
if (!Page || !Manifest || !Renderers) {
    console.error('check-api-keys-surface: cannot check — ApiKeysPage / ProviderManifest / ProviderAuthRenderers did not load');
    process.exit(2);
}

let failed = 0;
function check(name, ok, detail, why) {
    if (ok) { console.log(`✅ ${name}`); return; }
    console.error(`❌ ${name}\n     ${detail}\n     why it matters: ${why}`);
    failed++;
}

const SPEECH = Manifest.PROVIDERS.filter(p => p.group === 'speech').map(p => p.id);
if (SPEECH.length < 3) {
    console.error(`check-api-keys-surface: cannot check — the manifest declares ${SPEECH.length} speech provider(s); expected at least 3`);
    process.exit(2);
}

// ── LEG 1 — the speech providers reach the page's list at all ────────────────
{
    const ids = Page.PROVIDERS.map(p => p.id);
    const missing = SPEECH.filter(id => !ids.includes(id));
    check(`leg 1 — every speech provider is on the API Keys page (${SPEECH.length} checked: ${SPEECH.join(', ')})`,
        missing.length === 0,
        `missing from PROVIDERS: ${missing.join(', ')}`,
        'this is the finding itself — they were declared with surfaces:[api-keys] and a filter on kind excluded every one of them, so a household could not enter a speech key at all');
}

// ── LEG 2 — the BRAIN routability filter does not eat them ──────────────────
{
    // What the server really sends: brain providers only. A speech provider can
    // never appear here, however well its adapter works.
    Page._routable = ['openrouter', 'gemini', 'openai', 'hermes'];
    Page._providers = {};
    const visible = Page._visibleProviders();
    const ids = visible.map(p => p.id);
    const missing = SPEECH.filter(id => !ids.includes(id));
    const wronglyOrphaned = visible.filter(p => p.group === 'speech' && p.orphaned).map(p => p.id);
    check('leg 2a — a speech provider survives the `routable` filter with no key stored',
        missing.length === 0,
        `filtered out: ${missing.join(', ')}`,
        '`routable` answers "does this key flip BRAIN routing", which is the wrong question here — applying it hides the very fields this page now exists to offer');
    check('leg 2b — and is never flagged `orphaned`',
        wronglyOrphaned.length === 0,
        `orphaned: ${wronglyOrphaned.join(', ')}`,
        'the orphaned card tells the user to switch to an OpenRouter key and remove this one — advice that is simply false for a text-to-speech credential');
}

// ── LEG 3 — a stored key with a PENDING adapter says so, in the SHARED words ─
{
    const pending = Manifest.PROVIDERS.find(p => p.group === 'speech' && p.adapter === Manifest.ADAPTER.PENDING);
    if (!pending) {
        console.error('❌ leg 3 — no speech provider has adapter:PENDING, so the inert-key state cannot be exercised.\n' +
            '     If every adapter really has shipped, delete this leg deliberately rather than leaving a control that cannot fail.');
        failed++;
    } else {
        Page._providers = { [pending.id]: { set: true, fields: { key: '••••1234' } } };
        const html = Page._renderProviderCard(Page.PROVIDERS.find(p => p.id === pending.id));
        const shared = Renderers.statusLine(pending, true);
        check(`leg 3a — a stored ${pending.name} key renders the shared "not in use yet" chip`,
            html.includes(shared) && shared.includes('not in use yet'),
            `shared chip: ${shared}\n     card contains it: ${html.includes(shared)}`,
            'a second inert-key vocabulary beside the page\'s own `orphaned`/"Not used" is exactly what was ruled against — one holder for the wording, or the two drift and mean different things to the same user');
        check('leg 3b — and does NOT also claim "Key saved"',
            !html.includes('Key saved'),
            'the card carries both the pending chip and the success chip',
            'two chips saying opposite things is worse than the wrong one alone — the green is the one a user believes');
        check('leg 3c — the user can actually type into it (the input exists, with the id save() reads)',
            html.includes(`id="apikey-${pending.id}-key"`),
            `no input with id="apikey-${pending.id}-key" in the card`,
            'a card that renders state and no field is a status page; the ask was that the key be ENTERABLE');
    }
}

// ── LEG 4 — POSITIVE CONTROL: a SHIPPED adapter is not badged pending ────────
{
    const shipped = Manifest.PROVIDERS.find(p => p.group === 'speech' && p.adapter === Manifest.ADAPTER.SHIPPED);
    if (!shipped) {
        console.error('❌ leg 4 — no speech provider has adapter:SHIPPED, so leg 3 has no counterexample and would pass on a page that badges EVERYTHING');
        failed++;
    } else {
        Page._providers = { [shipped.id]: { set: true, fields: { key: '••••1234' } } };
        const html = Page._renderProviderCard(Page.PROVIDERS.find(p => p.id === shipped.id));
        check(`leg 4 — POSITIVE CONTROL: a stored ${shipped.name} key (adapter shipped) reads "Key saved", not "not in use yet"`,
            html.includes('Key saved') && !html.includes('not in use yet'),
            `has "Key saved"=${html.includes('Key saved')} has "not in use yet"=${html.includes('not in use yet')}`,
            'without this, leg 3 passes on a page that shows the inert badge unconditionally — which would understate every working key instead of overstating an inert one');
    }
}

// ── LEG 5 — every state class the renderer can emit is STYLED ───────────────
//
// 🔴 These classes shipped with no stylesheet at all, because their only
// consumer was a page that was never mounted. An unstyled chip is not an error:
// it renders as bare text inside the card and reads as a stray sentence.
{
    const rendererSrc = readFileSync(FILES.renderers, 'utf8');
    const css = readFileSync(FILES.css, 'utf8');
    // `[^"]*`, not `[a-z-]*`: the attribute is `class="pm-state pm-state--ok"`,
    // two tokens with a space. The first attempt could not match a space and so
    // found ZERO classes — and it said so instead of passing, which is the only
    // reason it was caught here rather than by an unstyled chip on a box.
    const classes = [...new Set([...rendererSrc.matchAll(/class="(pm-state[^"]*)"/g)].flatMap(m => m[1].split(/\s+/)))];
    if (classes.length < 2) {
        console.error(`❌ leg 5 — found ${classes.length} pm-state class(es) in the renderer; the pattern cannot see the property`);
        failed++;
    } else {
        const unstyled = classes.filter(c => !css.includes(`.${c}`));
        check(`leg 5 — every provider state class has CSS (${classes.length} checked: ${classes.join(', ')})`,
            unstyled.length === 0,
            `no rule for: ${unstyled.join(', ')}`,
            'the chip still renders, the words are still right, and it looks like an unformatted sentence someone left in a card — a state that is present and invisible is the failure this page family keeps producing');
    }
}

// ── LEG 6 — nothing DROPPED while the console modules loaded ────────────────
{
    check('leg 6 — the manifest and renderer registries loaded with no DROP',
        warnings.filter(w => w.includes('DROP:')).length === 0,
        `drops: ${JSON.stringify(warnings.filter(w => w.includes('DROP:')))}`,
        'the renderer registry warns rather than throws on a missing shape, so a provider added with an unrenderable auth shape would show an error card at runtime and nothing at build time');
}

console.log('');
if (failed) {
    console.error(`❌ ${failed} leg(s) failed`);
    process.exit(1);
}
console.log('✅ all legs pass — speech keys are enterable, survive the brain filter, and an unspent one says so in the shared words');
