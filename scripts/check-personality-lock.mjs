#!/usr/bin/env node
/**
 * check-personality-lock — a built-in personality the household cannot speak as is
 * DISABLED in the picker and dimmed in the catalog, custom ones never are, and an
 * unreadable key status locks nothing.
 *
 * 🔴 WHY THIS GATE EXISTS, AND IT IS THE REASON TO READ BEFORE CHANGING IT.
 *
 * Until 2026-10-15 the opposite policy was in force — `renderPersonalityCard` argued
 * at length that "every personality stays SELECTABLE". John reversed it that day
 * ("unselectable"). The reversal passed EVERY existing gate, all six of them, green.
 *
 * Not because the gates were bad: because that policy was recorded in a COMMENT and
 * asserted NOWHERE. No leg read `renderPersonalityCard` at all. So a documented rule
 * and an absent rule were indistinguishable to every instrument we had, and either
 * direction of the flip was silent. That is trap 239's shape one level up: an
 * unasserted policy is not a weak test, it is no test, and it reports success.
 *
 * ⇒ The legs below assert the CURRENT rule and are mutation-proved, so the NEXT
 * reversal — in either direction — is loud.
 *
 * WHAT A GREEN HERE DOES NOT PROVE:
 *   · that the disabled attribute STOPS a selection on a real browser. These legs read
 *     rendered HTML; `disabled` on an <option> is enforced by the browser, not by us.
 *   · that the catalog row DIMS. Leg 6 proves both surfaces ask the same decider,
 *     which is the drift that matters; the row's CSS is not read here.
 *   · anything about the tablet. The console stores a personality id; what a device
 *     does with one is a third authority this file cannot see.
 *   · that any voice actually SPEAKS. Availability is about keys, not audio.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSOLE = join(HERE, '..', 'dashie-ha', 'frontend', 'console');
const FILES = {
    manifest: join(CONSOLE, 'js', 'lib', 'provider-manifest.js'),
    avail:    join(CONSOLE, 'js', 'lib', 'provider-availability.js'),
    cards:    join(CONSOLE, 'js', 'components', 'voice-ai-defaults-cards.js'),
    page:     join(CONSOLE, 'js', 'pages', 'voice-ai.js'),
};
for (const [n, f] of Object.entries(FILES)) {
    if (!existsSync(f)) { console.error(`check-personality-lock: cannot check — ${n} missing at ${f}`); process.exit(2); }
}

let pass = 0, fail = 0;
const t = (name, ok, why) => {
    if (ok) { pass++; console.log(`✅ ${name}`); }
    else { fail++; console.log(`❌ ${name}${why ? `\n      ${why}` : ''}`); }
};

/** A context holding the REAL manifest, availability and card renderer. */
function load({ keys = {}, withManifest = true, mutate = null } = {}) {
    const sb = { console };
    sb.window = sb; sb.globalThis = sb;
    const ctx = vm.createContext(sb);
    if (withManifest) vm.runInContext(readFileSync(FILES.manifest, 'utf8'), ctx, { filename: FILES.manifest });
    let availSrc = readFileSync(FILES.avail, 'utf8');
    if (mutate) availSrc = mutate(availSrc);
    vm.runInContext(availSrc, ctx, { filename: FILES.avail });
    vm.runInContext(readFileSync(FILES.cards, 'utf8'), ctx, { filename: FILES.cards });
    sb.ProviderAvailability._setKeyStatusForTest(keys);
    sb.ProviderAvailability._setEnginesForTest(null);   // no local engines on this box
    return sb;
}

// A roster shaped like the real one: a standard row with NO preference, two paid
// characters, and one custom. The refs name providers the manifest really knows.
const TEMPLATES = [
    { key: 'dashie',  name: 'Standard', voices: [] },
    { key: 'wizard',  name: 'Wizard',   voices: ['elevenlabs:dumbledore'] },
    { key: 'butler',  name: 'Butler',   voices: ['inworld:butler', 'elevenlabs:butler'] },
    { key: 'cowboy',  name: 'Cowboy',   voices: ['elevenlabs:cowboy'] },
    { key: 'santa',   name: 'Santa',    voices: ['elevenlabs:santa'] },
];
const CUSTOM = [{ id: 'mean-surfer', name: 'Mean surfer dude', voices: ['elevenlabs:dumbledore'] }];

const render = (sb, currentId = 'dashie') =>
    sb.VoiceAiDefaultsCards.renderPersonalityCard({ templates: TEMPLATES, custom: CUSTOM, currentId });

/** Every <option …> in a rendered card. */
const options = (html) => (html.match(/<option\b[^>]*>[^<]*<\/option>/g) || []);
const optFor = (html, value) => options(html).find(o => o.includes(`value="${value}"`)) || '';
const isDisabled = (o) => /\bdisabled\b/.test(o);

console.log('── check-personality-lock ───────────────────────────────────────────\n');

// ── FLOOR ────────────────────────────────────────────────────────────────────
// Everything below asks "is this option disabled". If the fixture rendered no
// options, every such question answers "no" and every leg passes on nothing.
{
    const sb = load({ keys: {} });
    const html = render(sb);
    const n = options(html).length;
    t('leg 0 FLOOR — the fixture really renders the roster (≥5 built-ins + 1 custom)',
      n >= 6, `only ${n} <option> elements rendered — every lock leg below would pass vacuously`);
    t('leg 0b FLOOR — a locked option is REACHABLE in this fixture (≥1 disabled with no keys)',
      options(html).some(isDisabled), 'nothing is disabled even with zero keys — the legs cannot distinguish lock from no-lock');
}

// ── 1/2/3 — who locks and who does not ───────────────────────────────────────
{
    const sb = load({ keys: {} });          // no keys at all
    const html = render(sb);
    t('leg 1 — a built-in whose voice needs an unavailable provider is DISABLED',
      isDisabled(optFor(html, 'wizard')), `wizard option rendered as: ${optFor(html, 'wizard')}`);
    t('leg 2 — a CUSTOM personality with the SAME unresolvable voices is NOT disabled',
      !isDisabled(optFor(html, 'mean-surfer')),
      'custom personalities are the household\'s own and are never gated (John 2026-10-15)');
    t('leg 3 — the STANDARD personality (empty preference list) is NOT disabled',
      !isDisabled(optFor(html, 'dashie')),
      'an empty voices list is a meaningful value, not a missing one — it IS the standard voice');
}

// ── 4 — the key that matters: never lock on an unreadable answer ─────────────
{
    const sb = load({ keys: {}, withManifest: false });
    const html = render(sb);
    t('leg 4 — with no ProviderManifest loaded, NOTHING is disabled (unknown ≠ unavailable)',
      !options(html).some(isDisabled),
      'this is the first-paint state of every visit; locking here greys the whole list on each page load');
}

// ── 5 — a locked option that is SELECTED still renders, and stays selected ───
{
    const sb = load({ keys: {} });
    const html = render(sb, 'wizard');
    const o = optFor(html, 'wizard');
    t('leg 5 — a LOCKED option that is the stored value is still rendered AND still selected',
      o !== '' && /\bselected\b/.test(o) && isDisabled(o),
      `dropping it leaves the <select> showing a DIFFERENT personality than the stored one — a picker lying about this household. Got: ${o || '(no option)'}`);
}

// ── 6 — one decider, two surfaces ────────────────────────────────────────────
{
    const sb = load({ keys: {} });
    const hasFn = typeof sb.ProviderAvailability.personalityLock === 'function';
    const pageSrc = readFileSync(FILES.page, 'utf8');
    const cardsSrc = readFileSync(FILES.cards, 'utf8');
    t('leg 6 — the catalog row and the picker both ask ProviderAvailability.personalityLock',
      hasFn && /A\.personalityLock\(/.test(pageSrc) && /A\.personalityLock\(/.test(cardsSrc),
      'two implementations of "can this household have this personality" drift: one surface dims a row the other still offers');
    t('leg 6b — and the page does NOT re-derive the rule locally',
      !/kind === 'degraded'[\s\S]{0,120}locked: true/.test(pageSrc),
      'the page carried its own copy of the lock rule — the hand-mirror leg 6 exists to prevent');
}

// ── 7 — the positive control: keys present ⇒ nothing locked ──────────────────
{
    const sb = load({ keys: { elevenlabs: true, inworld: true } });
    const html = render(sb);
    t('leg 7 ⚖️ CONTROL — with ElevenLabs + Inworld keys stored, NO option is disabled',
      !options(html).some(isDisabled),
      'a lock that survives the key being present is not a lock, it is a broken row');
}
{
    // 🔴 THE ONE JOHN RULED ON (2026-10-15): an ElevenLabs key alone must unlock a
    // character whose FIRST preference is Inworld, via its ElevenLabs alternate —
    // *"let's get an elevenlabs voice for those 3 characters so elevenlabs can unlock
    // them."* Butler is the real case: tts_voices says Butler is Inworld "Clive", so
    // without a second ref an ElevenLabs household keeps him locked.
    const elOnly = render(load({ keys: { elevenlabs: true } }));
    t('leg 7b ⚖️ CONTROL — an ElevenLabs key alone unlocks a straight-ElevenLabs character',
      !isDisabled(optFor(elOnly, 'wizard')),
      `wizard resolves on elevenlabs:dumbledore. Got: ${optFor(elOnly, 'wizard')}`);
    t('leg 7c — …and unlocks an INWORLD-first character through its ElevenLabs alternate',
      !isDisabled(optFor(elOnly, 'butler')),
      'butler prefers inworld:butler and falls to elevenlabs:butler — the ordered chain is what makes John\'s ruling work');
    const iwOnly = render(load({ keys: { inworld: true } }));
    t('leg 7d — an INWORLD key alone leaves a straight-ElevenLabs character LOCKED',
      isDisabled(optFor(iwOnly, 'wizard')),
      'the chain must not resolve a provider the household has no key for — that would unlock a voice nothing can speak');
}

// ── MUTATION — feed it the regression and watch it redden ────────────────────
{
    const unlockAll = (src) => src.replace(
        'function personalityLock(voices, isCustom) {',
        'function personalityLock(voices, isCustom) { return { locked: false };');
    const sb = load({ keys: {}, mutate: unlockAll });
    const html = render(sb);
    const mutantHidesIt = !isDisabled(optFor(html, 'wizard'));
    t('leg 8 🧪 MUTATION — a decider that never locks makes leg 1 FAIL (so leg 1 is real)',
      mutantHidesIt,
      'the mutant still produced a disabled wizard, so leg 1 is not actually reading the decider');
}

console.log(`\ncheck-personality-lock: ${pass} pass, ${fail} fail`);
console.log(`
📌 FLOOR — what a green here does NOT prove:
   · that \`disabled\` actually STOPS a click. The browser enforces it; these legs read HTML.
   · that the catalog ROW dims. Leg 6 proves both surfaces share the decider, not the CSS.
   · anything about the tablet, or about a voice actually being audible.
   · that the roster's voice refs are CORRECT. Measured 2026-10-15: the add-on's local
     templates say \`elevenlabs:butler\`, while tts_voices says Butler is INWORLD "Clive".
     This gate asserts the LOCK rule, not the catalog's provider accuracy.`);

if (fail > 0) process.exit(1);
console.log('\n✅ ALL PASS — built-ins lock, custom never does, unknown locks nothing, and one decider serves both surfaces');
