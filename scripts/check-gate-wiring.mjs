#!/usr/bin/env node
/**
 * check-gate-wiring — every `check-*` / `scan-*` script in scripts/ must be
 * INVOKED by something. A gate nobody runs is not a gate.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 *
 * BACKLOG #16, from finding FOUR written-but-never-invoked check-*.mjs gates in
 * this repo in one sitting (2026-08-04, addendum 89) — including the one
 * guarding `lock.open`. Each had been authored carefully, committed with a
 * message describing what it protected, and never wired into anything. The
 * repo looked well-gated. It was well-*authored*.
 *
 *   "Writing a gate and wiring a gate are separate acts, and only one of them
 *    feels like finishing."
 *
 * 🔴 And it is not a historical problem. On the run that introduced this file,
 * this check named `check-keys-write-guard.mjs` — which I wrote MYSELF the
 * previous session, to stop a malformed PUT deleting a stored credential, and
 * left unwired. The habit does not survive on discipline; that is why it is
 * code now.
 *
 * ── A MENTION IS NOT A CALLER (the whole design) ────────────────────────────
 *
 * The obvious implementation — grep the repo for the filename — is wrong, and
 * wrong in the direction that matters. A first pass of exactly that reported
 * `check-console-tree.sh` as wired by `PROVENANCE.md` and a `CONSOLE_ISOLATION.md`,
 * and `check-generated-tree.sh` as wired by two more markdown files. Those are
 * documentation SAYING a gate exists. A gate that is documented and unwired is
 * the precise failure this file exists to catch, so a checker that accepts prose
 * as evidence would certify the disease as the cure.
 *
 * So a caller must be an INVOCATION: `node <path>`, `bash|sh <path>`,
 * `./scripts/<name>`, or a package.json script whose command runs it. Markdown
 * is not searched at all — not as an optimisation, as a statement.
 *
 * ⚠️ What this is blind to: it proves something INVOKES the gate, not that the
 * invoker itself runs, nor that anyone heeds its exit code. `release.sh` piping
 * a gate through `tail` would eat the exit status and still count as wired here
 * — that exact mistake once put a red past origin (see B's handoff §2). Reaching
 * that would need a second leg on pipelines, which is a different check.
 *
 * Exit 0 = every gate has a caller, 1 = an unwired gate, 2 = cannot check.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

if (!existsSync(HERE)) {
    console.error('check-gate-wiring: cannot check — scripts/ not found');
    process.exit(2);
}

// The gates. Anything named like a check, in scripts/.
const GATES = readdirSync(HERE)
    .filter((f) => /^(check|scan)-.*\.(mjs|js|sh)$/.test(f))
    // A gate's own unit test is not a gate; it is wired by whatever runs it.
    .filter((f) => !/\.test\.(mjs|js)$/.test(f))
    .sort();

if (GATES.length === 0) {
    console.error('check-gate-wiring: cannot check — no check-*/scan-* scripts found in scripts/');
    process.exit(2);
}

// Where an invocation could plausibly live. Deliberately NOT *.md — see header.
const SEARCHABLE = /\.(sh|mjs|js|ts|ya?ml|json)$/;

/**
 * ...plus EXTENSIONLESS files that carry a shebang. Git hooks have no
 * extension by definition, and this repo's pre-commit hook is a real caller:
 * `exec "$REPO_ROOT/scripts/check-generated-tree.sh"`. The extension filter
 * alone reported that gate unwired — a false accusation against the one gate
 * here that runs on EVERY commit rather than only at release.
 * 📌 "Which files could invoke something" is not the same question as "which
 * files have a code extension", and the gap between them is exactly where the
 * most-often-run callers live.
 */
function isSearchable(abs, entry) {
    if (SEARCHABLE.test(entry)) return true;
    if (entry.includes('.')) return false;
    try { return readFileSync(abs, 'utf8').slice(0, 2) === '#!'; } catch { return false; }
}
const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', 'dashie-ha-dev', 'dashie-ha/integration', 'dashie-ha-dev/integration']);

function walk(dir, out = []) {
    for (const entry of readdirSync(dir)) {
        const abs = join(dir, entry);
        const rel = relative(ROOT, abs);
        if (SKIP_DIRS.has(entry) || SKIP_DIRS.has(rel)) continue;
        let st;
        try { st = statSync(abs); } catch { continue; }
        if (st.isDirectory()) walk(abs, out);
        else if (isSearchable(abs, entry)) out.push(abs);
    }
    return out;
}

const FILES = walk(ROOT).filter((f) => !GATES.some((g) => f.endsWith(join('scripts', g))));

/**
 * Does `line` INVOKE `name`? Anything that would actually execute it:
 *   node "$X/scripts/foo.mjs"   ./scripts/foo.sh   bash scripts/foo.sh
 *   "lint:foo": "node scripts/foo.mjs"
 * A bare mention in a comment or a string of prose does not count.
 */
function invokes(line, name) {
    const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // ⚠️ The path run is `\S*` — deliberately permissive about quotes and shell
    // expansion. The first cut excluded quote characters from it, on the theory
    // that a quote ends a token. It does not: this repo's own runner writes
    // `node "$ADDON_ROOT/scripts/check-device-removal.mjs"`, where the very next
    // character after `node ` is a double quote. That version condemned 19 of 20
    // gates as unwired.
    //
    // 📌 Which is the lesson worth keeping: a brand-new checker whose first run
    // condemns nearly everything is almost always the CHECKER being wrong, not
    // the repo being that bad. The credible result is the one that agrees with
    // what you can see by eye in the runner — `release.sh` plainly invokes these.
    // I nearly filed 19 findings against a repo that had none of them.
    return new RegExp(
        `(?:^|[\\s"'\`;&|(])(?:node|bash|sh|deno\\s+run|npx)\\s+\\S*${n}`
        + `|(?:^|[\\s"'\`;&|(])["'\`]?[./$]\\S*${n}`,
    ).test(line);
}

/**
 * Gates that legitimately have no runner, each with the reason it is exempt.
 *
 * 🔴 An allowlist, not a skip-list, and every entry states WHY — because the
 * alternative shapes both fail. Wiring these blindly into release.sh would make
 * a release depend on a tool that is not a release gate (and
 * check-channel-currency exits 0 without --strict, so it would pass by not
 * being asked anything, which is worse than absent). Deleting the check because
 * four gates are unwired is how a gate that is red on arrival gets switched off.
 *
 * ⚠️ The bar for adding a row: the gate answers a question NOBODY asks at
 * release time. "I haven't wired it yet" is not a reason — that is the finding.
 */
const UNWIRED_BY_DESIGN = {
    'check-channel-currency.mjs':
        'an ANSWER, not a gate — "how far behind is the shipped channel?" It exits 0 without '
        + '--strict, so wiring it bare would add a step that cannot fail. Run by hand (or with '
        + '--strict) when deciding whether a channel needs a re-cut.',
    'scan-publish-secrets.mjs':
        'belongs to the private->public publish pipe in dashie-ha-app, not to this repo\'s '
        + 'add-on release. That arc is FROZEN (BRAND_ARC_STATE 2026-08-17); wiring it into '
        + 'release.sh here would gate the wrong pipeline. Re-check this row when the arc wakes.',
};

const results = [];
for (const gate of GATES) {
    const callers = [];
    for (const file of FILES) {
        let text;
        try { text = readFileSync(file, 'utf8'); } catch { continue; }
        if (!text.includes(gate)) continue;
        for (const line of text.split('\n')) {
            if (line.includes(gate) && invokes(line, gate)) {
                callers.push(relative(ROOT, file));
                break;
            }
        }
    }
    results.push({ gate, callers: [...new Set(callers)] });
}

let failed = 0;
for (const { gate, callers } of results) {
    if (callers.length) {
        console.log(`✅ ${gate}  ← ${callers.join(', ')}`);
    } else if (UNWIRED_BY_DESIGN[gate]) {
        // Reported, never silent: an exemption you cannot see is a skip-list.
        console.log(`➖ ${gate} — no runner BY DESIGN: ${UNWIRED_BY_DESIGN[gate]}`);
    } else {
        failed++;
        console.error(`❌ ${gate} — NOTHING INVOKES IT`);
    }
}

// An exemption for a gate that no longer exists is stale reasoning left lying
// around; it would quietly excuse a future gate that happened to reuse the name.
for (const name of Object.keys(UNWIRED_BY_DESIGN)) {
    if (!GATES.includes(name)) {
        failed++;
        console.error(`❌ UNWIRED_BY_DESIGN names "${name}", which is not a gate in scripts/ — remove the stale row`);
    }
}

if (failed) {
    console.error(
        `\ncheck-gate-wiring: ${failed} gate(s) with no caller.\n`
        + '  A gate that nothing runs protects nothing, and reads in git log exactly like one\n'
        + '  that does. Wire it into scripts/release.sh (or another runner) in the SAME commit\n'
        + '  that adds it — or, if it is genuinely retired, delete it. Leaving it is the one\n'
        + '  option that keeps the repo looking better-gated than it is.\n'
        + '  ⚠️ A mention in a .md file does not count and is not searched. Documenting a gate\n'
        + '     is what an unwired gate already looks like.',
    );
    process.exit(1);
}
console.log(`\ncheck-gate-wiring: all ${GATES.length} gates have a caller`);
