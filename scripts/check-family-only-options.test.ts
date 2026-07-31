// I7 — no FAMILY_ONLY_OPTIONS entry is reachable in a published build.
//
// Why this file exists
// ────────────────────
// `check-console-tree.sh` proves the FILE/STRING half of the isolation contract:
// no family page module, no paywall copy, an empty DELTA-SCRIPTS block. It cannot
// see a BEHAVIOURAL leak — a family feature reachable in the published build via a
// runtime branch passes that linter cleanly.
//
// On 2026-07-30 `devices` LEFT `CLOSED_DELTA_PAGES` and was replaced by option-level
// gating (`FAMILY_ONLY_OPTIONS`). That moved three family-only options from
// "absent file, statically provable" to "present file, runtime branch" — i.e.
// straight into that blind spot, on the invariant the isolation contract exists to
// protect. This is the test for it.
//
// Run:  deno test --allow-read scripts/check-family-only-options.test.ts
//       (also run by check-console-tree.sh, which release.sh gates on)

import { assert, assertEquals } from 'jsr:@std/assert@1';

const ROOT = new URL('..', import.meta.url).pathname;
// I7_CONSOLE_DIR points this suite at a COPY of the console tree. It exists so the
// negative cases can be proven — mutate a copy, watch the right test go red — without
// ever editing the real tree (other threads share this clone). Used to verify these
// assertions actually bite; not used by check-console-tree.sh.
const CONSOLE = Deno.env.get('I7_CONSOLE_DIR') || `${ROOT}dashie-ha/frontend/console`;

// ── Load feature-gate.js the way the browser does ──────────────────────────
//
// It is a classic script (a top-level `const FeatureGate = {…}`, no exports), so
// evaluate it with the globals it reads injected as parameters. `typeof X` still
// works on a declared parameter, which is the form the gate uses.
function loadFeatureGate(build: string | null) {
    const src = Deno.readTextFileSync(`${CONSOLE}/js/lib/feature-gate.js`);
    const warnings: string[] = [];
    const fakeConsole = { warn: (m: string) => warnings.push(m), log: () => {}, error: () => {} };
    const BRAND = build === null ? undefined : { build };
    // deno-lint-ignore no-explicit-any
    const factory = new Function('BRAND', 'DashieAuth', 'console', `${src}\nreturn FeatureGate;`) as any;
    return { gate: factory(BRAND, undefined, fakeConsole), warnings };
}

const PUBLISHED = () => loadFeatureGate('published').gate;
const FULL = () => loadFeatureGate('full').gate;

// ── I7.1 — every registered family-only option is refused in the published build ──
//
// Data-driven off FAMILY_ONLY_OPTIONS itself rather than a hardcoded list, so an
// entry added later is covered the moment it is registered.
Deno.test('I7: every FAMILY_ONLY_OPTIONS entry is refused in the published build', () => {
    const gate = PUBLISHED();
    const entries = Object.entries(gate.FAMILY_ONLY_OPTIONS) as [string, string | string[]][];
    assert(entries.length > 0, 'FAMILY_ONLY_OPTIONS is empty — did the gate get gutted?');

    for (const [key, rule] of entries) {
        if (rule === '*') {
            // The whole control is family-only: asking about the control itself
            // must be refused, and so must any value.
            assertEquals(gate.optionAllowed(key), false, `${key}: whole control must be refused`);
            assertEquals(gate.optionAllowed(key, 'anything'), false, `${key}: no value may pass`);
        } else {
            assert(Array.isArray(rule), `${key}: rule must be '*' or an array, got ${typeof rule}`);
            assert(rule.length > 0, `${key}: empty value list gates nothing — use '*' or remove it`);
            for (const value of rule) {
                assertEquals(gate.optionAllowed(key, value), false, `${key}=${value} must be refused`);
            }
            // filterOptions is the form the render path actually calls, in both
            // shapes it accepts ([value,label] pairs and bare values).
            const pairs = rule.map(v => [v, `label:${v}`]);
            assertEquals(gate.filterOptions(key, pairs).length, 0, `${key}: filterOptions must strip pairs`);
            assertEquals(gate.filterOptions(key, [...rule]).length, 0, `${key}: filterOptions must strip bare values`);
            // …and must not over-reach: an unlisted value on a gated key survives.
            const unlisted = `__not_family_only__`;
            assertEquals(gate.optionAllowed(key, unlisted), true, `${key}: unlisted values must survive`);
        }
    }
});

// ── I7.2 — the gate only ever REMOVES, and only from the published build ──────
Deno.test('I7: the full build keeps every option (the gate is subtractive only)', () => {
    const gate = FULL();
    for (const [key, rule] of Object.entries(gate.FAMILY_ONLY_OPTIONS) as [string, string | string[]][]) {
        assertEquals(gate.optionAllowed(key), true, `${key}: full build must keep the control`);
        const values: string[] = rule === '*' ? ['anything'] : rule as string[];
        for (const value of values) {
            assertEquals(gate.optionAllowed(key, value), true, `${key}=${value}: full build must keep it`);
        }
        const pairs = values.map(v => [v, `label:${v}`]);
        assertEquals(gate.filterOptions(key, pairs).length, pairs.length, `${key}: full build must not filter`);
    }
});

Deno.test('I7: an unregistered key is untouched in both builds', () => {
    for (const gate of [PUBLISHED(), FULL()]) {
        assertEquals(gate.optionAllowed('display.orientationLock'), true);
        assertEquals(gate.optionAllowed('display.orientationLock', 'portrait'), true);
        assertEquals(gate.filterOptions('display.orientationLock', [['auto', 'Auto']]).length, 1);
    }
});

// ── I7.3 — an unrecognised BRAND.build fails CLOSED, loudly ──────────────────
//
// This is contract #56's registered defect. The gate used to fail OPEN (missing
// `build` → full-build behaviour → every family option offered), which made a
// half-generated brand.js indistinguishable from a deliberate full build.
Deno.test('I7: unknown/missing BRAND.build is treated as PUBLISHED, with a loud DROP', () => {
    for (const build of [null, '', 'chickadee', 'nonsense']) {
        const { gate, warnings } = loadFeatureGate(build);
        assertEquals(gate.isPublishedBuild(), true, `build=${JSON.stringify(build)} must fail closed`);
        assertEquals(gate.optionAllowed('display.themeFamily'), false);
        assert(warnings.some(w => w.includes('DROP: unknown BRAND.build')),
            `build=${JSON.stringify(build)} must log a DROP marker (CLAUDE.md: no silent drops)`);
    }
    // …and the DROP is a one-shot latch, not per-render spam.
    const { gate, warnings } = loadFeatureGate('nonsense');
    for (let i = 0; i < 5; i++) gate.isPublishedBuild();
    assertEquals(warnings.length, 1, 'the unknown-build DROP must latch after the first warning');
});

// ── I7.4 — REACHABILITY: every registered key has a chokepoint that gates it ───
//
// I7.1 proves the gate REFUSES. It cannot prove anyone ASKS. The failure this
// catches is the likely one: someone registers a fourth entry in
// FAMILY_ONLY_OPTIONS and the option renders anyway because no render path
// consults the gate for that key. Registration would look like protection.
//
// Two accepted routes, matching the two the code actually uses:
//   (a) a LITERAL key passed to optionAllowed()/filterOptions()
//       — e.g. 'display.themeFamily', 'photos.sourceType'
//   (b) the GENERIC picker chokepoint: renderPickerModal() filters every picker
//       by `${ctx.category}.${ctx.key}`, so a key is covered if some call site
//       opens a picker with that category+key — e.g. 'display.layoutMode'
function consoleSources(): { path: string; text: string }[] {
    const out: { path: string; text: string }[] = [];
    for (const dir of ['js/pages', 'js/lib', 'js/components']) {
        let entries: Deno.DirEntry[];
        try { entries = [...Deno.readDirSync(`${CONSOLE}/${dir}`)]; } catch { continue; }
        for (const e of entries) {
            if (!e.isFile || !e.name.endsWith('.js')) continue;
            out.push({ path: `${dir}/${e.name}`, text: Deno.readTextFileSync(`${CONSOLE}/${dir}/${e.name}`) });
        }
    }
    return out;
}

Deno.test('I7: every FAMILY_ONLY_OPTIONS key is reachable by a gate call site', () => {
    const gate = PUBLISHED();
    const sources = consoleSources();
    assert(sources.length > 0, 'found no console sources — did the tree move?');

    for (const key of Object.keys(gate.FAMILY_ONLY_OPTIONS)) {
        const [category, subkey] = key.split('.');
        assert(category && subkey, `${key}: expected a 'category.key' shape`);

        // (a) literal key handed to the gate
        const literal = new RegExp(
            `(optionAllowed|filterOptions)\\s*\\(\\s*['"\`]${category}\\.${subkey}['"\`]`);
        // (b) a picker opened on that category+key, which renderPickerModal gates
        const picker = new RegExp(`openPicker\\([^)]*['"\`]${category}['"\`]\\s*,\\s*['"\`]${subkey}['"\`]`);

        const hit = sources.find(s => literal.test(s.text) || picker.test(s.text));
        assert(hit,
            `${key} is registered in FAMILY_ONLY_OPTIONS but NOTHING consults the gate for it.\n` +
            `  Registering a key does not gate it. Add one of:\n` +
            `    FeatureGate.optionAllowed('${key}') / FeatureGate.filterOptions('${key}', …)\n` +
            `    or route the control through DevicesDetailModals.openPicker(…,'${category}','${subkey}',…)`);
    }
});

// The generic chokepoint is load-bearing for route (b): 'display.layoutMode' has no
// literal call site anywhere, so if renderPickerModal ever stops filtering, that
// option silently returns to the published build and I7.4 would still pass.
Deno.test('I7: renderPickerModal still filters every picker through the gate', () => {
    const text = Deno.readTextFileSync(`${CONSOLE}/js/pages/devices-detail-modals.js`);
    const body = text.slice(text.indexOf('renderPickerModal()'));
    assert(body.length > 0, 'renderPickerModal() is gone — the generic picker chokepoint moved');
    assert(/FeatureGate\.filterOptions\(\s*`\$\{ctx\.category\}\.\$\{ctx\.key\}`/.test(body),
        'renderPickerModal() no longer routes its options through FeatureGate.filterOptions(' +
        '`${ctx.category}.${ctx.key}`). That is the ONLY gate on display.layoutMode.');
});

// renderThemeModal bails independently of the row that opens it: the row is gated,
// but the modal is reachable from any other caller (a stale hash route, a direct
// call). Belt and braces, deliberately — assert both halves stay.
Deno.test('I7: the theme modal refuses independently of the row that opens it', () => {
    const text = Deno.readTextFileSync(`${CONSOLE}/js/pages/devices-detail-modals.js`);
    assert(/renderThemeModal\(\)\s*\{[\s\S]{0,400}?if\s*\(!FeatureGate\.optionAllowed\(['"]display\.themeFamily['"]\)\)\s*return\s*''/.test(text),
        'renderThemeModal() must return early on !optionAllowed(display.themeFamily) — ' +
        'gating only the row that opens it leaves the modal reachable by any other caller.');
});
