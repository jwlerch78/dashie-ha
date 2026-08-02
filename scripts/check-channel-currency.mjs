// SPDX-License-Identifier: AGPL-3.0-only
// check-channel-currency.mjs — how far behind the canonical tree is the build a
// channel last SHIPPED?
//
// ── THE GAP THIS CLOSES, and it cost a full test cycle to find ───────────────
//
// Every existing check here asks about FAITHFULNESS: is `dashie-ha-dev/` a
// correct copy of the source it names? On 2026-08-02 that answer was yes — the
// dev channel was byte-consistent with `source @ e2e3a6e`, the SHA its own
// release commit records — and the conclusion drawn from it was wrong, because
// nobody was asking the other question.
//
// `e2e3a6e` was 07-31. The channel had shipped nothing since, while the
// canonical tree gained twenty commits including the capability-lease endpoint
// and the metered-spend gate. A device was then installed, tested against, and
// reported as carrying work that had not existed when that build was cut.
//
// 🔴 Faithful and current are different properties, and only one of them had a
// check. The tell was the usual one: everything green, and the sentence nobody
// could say out loud was "the dev channel is two days behind canon".
//
// Note what this is NOT diagnosing. The mirror was not broken and no version was
// bumped without syncing — the release script had done its job correctly, on old
// input. A wrong mechanism would have sent the fix at the wrong thing; this
// prints the number instead of a theory.
//
// Usage:  node scripts/check-channel-currency.mjs [dev|prod] [--strict]
// Exit 0 unless --strict and the channel is behind.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const STRICT = argv.includes('--strict');
const channel = argv.find((a) => a === 'dev' || a === 'prod') || 'dev';

const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();

// The canonical source, and the paths the channel actually ships FROM it.
// ⚠️ This list must agree with release.sh's MIRRORED_ITEMS. It is a second
// statement of that set and therefore a hand-mirror — declared here rather than
// hidden, because the alternative is parsing a bash array, and a check that
// silently reads a DIFFERENT set than the release copies is worse than one that
// says where its list came from. If they drift, this reports commits the release
// would not have shipped (noise), never the reverse (a miss) — the safe
// direction, since every mirrored path is listed and extras only over-report.
const CANON = 'dashie-ha';
const MIRRORED = ['server', 'frontend', 'Dockerfile', 'run.sh', 'package.json',
                  'package-lock.json', 'DOCS.md', 'CHANGELOG.md', 'icon.png', 'logo.png'];

const LEDGER = new RegExp(`^Release \\[${channel}\\] (\\S+) \\(source @ ([0-9a-f]+), integration @ ([0-9a-f]+)\\)`);

const entry = git('log', '-n', '200', '--format=%H%x00%s')
    .split('\n')
    .map((l) => l.split('\0'))
    .map(([sha, subject]) => ({ sha, subject, m: LEDGER.exec(subject || '') }))
    .find((e) => e.m);

if (!entry) {
    console.error(`❌ no "Release [${channel}] … (source @ x, integration @ y)" commit in the last 200 — cannot answer.`);
    console.error('   Refusing to report a channel as current when its release ledger cannot be read.');
    process.exit(1);
}

const [, version, sourceSha, integrationSha] = entry.m;
const paths = MIRRORED.map((p) => `${CANON}/${p}`);
const behind = git('log', '--format=%h %ad %s', '--date=format:%m-%d %H:%M',
                   `${sourceSha}..HEAD`, '--', ...paths)
    .split('\n').filter(Boolean);

const when = git('log', '-1', '--format=%ad', '--date=format:%Y-%m-%d %H:%M', sourceSha);

console.log(`\n${channel} channel — last released ${version}, source @ ${sourceSha} (${when})`);
console.log(`  integration vendored @ ${integrationSha}`);

if (!behind.length) {
    console.log(`\n✅ current — no commit since ${sourceSha} touches a path this channel ships.`);
    process.exit(0);
}

console.log(`\n🔴 ${behind.length} commit(s) since then touch paths this channel ships:\n`);
for (const line of behind.slice(0, 15)) console.log(`     ${line.slice(0, 110)}`);
if (behind.length > 15) console.log(`     … and ${behind.length - 15} more`);
console.log(
    `\n  What this means concretely: a box running ${version} does NOT contain the ${behind.length}\n` +
    `  change(s) above, however recently it was installed. Cut a ${channel} release before\n` +
    `  testing anything that depends on them — an install is not a release.`,
);

// Reporting by default. Being behind is NORMAL between releases; failing on it
// would fire on every commit and get the check disabled within a day. --strict
// is for the moment before someone tests against a box.
process.exit(STRICT ? 1 : 0);
