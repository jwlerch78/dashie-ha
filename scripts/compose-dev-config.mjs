#!/usr/bin/env node
// compose-dev-config.mjs — the dev channel's options/schema surface is COMPOSED
// from canonical, never hand-mirrored.
//
//   node scripts/compose-dev-config.mjs            # write
//   node scripts/compose-dev-config.mjs --check    # fail if it would change
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// `release.sh` mirrors canonical `dashie-ha/` into `dashie-ha-dev/` for every
// tracked item EXCEPT `config.yaml`, which is dev-owned — and that exception is
// RIGHT on its own terms: the dev channel's name, slug, description, panel_title
// and its dev-only `lease_ttl_seconds` genuinely must differ, and a slug is
// immutable once shipped.
//
// 🔴 But that one file also carries the entire options/schema surface, which is
// NOT channel-specific. So every canonical config.yaml change landed PROD-ONLY,
// silently, forever — and both gates were blind to it by construction:
// `check-generated-tree.sh` explicitly skips config.yaml (it is hand-authored),
// and `check-channel-currency.mjs` asks whether the channel is CURRENT, not
// whether it AGREES. Faithful ✅, current ✅, still wrong.
//
// Measured when this was written (T s44 cont.2, on John's box running 0.9.19):
// the dev Configuration tab rendered **16 options** where canonical had 10 —
// carrying `log_level` and `ai_auth_enforce` (removed by #48①) AND
// `llm_url`/`llm_model`/`llm_api_key` (removed by the ruled config-tab removal
// before that). John's box had `log_level: debug` actually SET: the precise trap
// the removal was written to close, still open on the only channel he runs.
//
// ── WHY COMPOSE RATHER THAN DIFF-GATE ────────────────────────────────────────
//
// A cross-channel diff gate would have caught this commit and every future one,
// and it was the offered fallback. Composition is chosen because the tier rule
// says eliminate > codegen > lint: a gate leaves two copies and asks a human to
// reconcile them each time, while composing means the second copy cannot drift
// because it is not authored. The failure mode here is "forever, silently",
// which is exactly the kind a lint keeps re-detecting rather than ending.
//
// ── WHAT IS AND IS NOT COMPOSED ──────────────────────────────────────────────
//
// ONLY the region between the markers below — the `options:` and `schema:`
// blocks, copied from canonical WITH their comments (that prose is load-bearing
// documentation and belongs with the keys it explains). Everything above the
// marker stays hand-authored dev identity: name, slug, description, panel_title,
// version, and the channel's own commentary. The composer never touches it.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL = join(ROOT, 'dashie-ha', 'config.yaml');
const DEV = join(ROOT, 'dashie-ha-dev', 'config.yaml');

const BEGIN = '# ── COMPOSED FROM canonical dashie-ha/config.yaml — DO NOT HAND-EDIT BELOW ──';
const END = '# ── END COMPOSED ──';

/**
 * The dev channel's declared additions. This is the ENTIRE channel-specific part
 * of the options/schema surface — everything else is canonical's, verbatim.
 *
 * Keep the rationale with the entry: `lease_ttl_seconds` is deliberately absent
 * from prod's schema so Home Assistant REJECTS it there before it can reach the
 * add-on. That absence is the whole enforcement — there is no code branch, and
 * so no way to leave a 60-second revocation window running in a real household.
 */
const DEV_OVERLAY = {
  options: [
    '  # ⚠️ DEV CHANNEL ONLY — seconds, and it OVERRIDES the minutes above.',
    '  # Declared here and deliberately NOT in the prod channel\'s schema, so Home',
    '  # Assistant rejects it there before it can reach the add-on. That absence is',
    '  # the whole enforcement: no code branch, and no way to leave a 60-second',
    '  # revocation window running in a real household by accident.',
    '  # 0 / unset = off. Exists so the lease test suite costs minutes rather than',
    '  # the 3+ hours a real 30-minute TTL prices it at — without it the suite is',
    '  # priced like a soak and stops being run, which is how a revocation mechanism',
    '  # silently rots.',
    '  lease_ttl_seconds: 0',
  ],
  schema: ['  lease_ttl_seconds: int(0,14400)?'],
};

/** Canonical's options+schema surface: from the `options:` line to EOF. */
function canonicalSurface() {
  const lines = readFileSync(CANONICAL, 'utf8').split('\n');
  const start = lines.findIndex((l) => l === 'options:');
  if (start < 0) throw new Error('canonical config.yaml has no top-level `options:` line');
  return lines.slice(start);
}

/** Insert the overlay lines at the end of `blockName`'s block. */
function withOverlay(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A block ends at the next top-level key (or EOF).
    const isTopLevel = (s) => s.length > 0 && !s.startsWith(' ') && !s.startsWith('#');
    if (line === 'schema:') {
      out.push(...DEV_OVERLAY.options, line);
      continue;
    }
    out.push(line);
    if (i === lines.length - 1) out.push(...DEV_OVERLAY.schema);
    else if (isTopLevel(lines[i + 1]) && !isTopLevel(line) && out.includes('schema:')) {
      // defensive: a future top-level key after schema
      out.push(...DEV_OVERLAY.schema);
    }
  }
  return out;
}

function compose() {
  const dev = readFileSync(DEV, 'utf8');
  const b = dev.indexOf(BEGIN);
  if (b < 0) throw new Error(`dev config.yaml is missing the marker:\n${BEGIN}`);
  const e = dev.indexOf(END, b);
  if (e < 0) throw new Error(`dev config.yaml is missing the closing marker:\n${END}`);
  const head = dev.slice(0, b);
  const tail = dev.slice(e);
  const body = withOverlay(canonicalSurface()).join('\n');
  return `${head}${BEGIN}\n${body}\n${tail}`;
}

const next = compose();
const current = readFileSync(DEV, 'utf8');

if (process.argv.includes('--check')) {
  if (next === current) {
    console.log('✅ dev config.yaml options/schema match canonical + the declared dev overlay');
    process.exit(0);
  }
  console.error('❌ dev config.yaml options/schema have DRIFTED from canonical.\n');
  console.error('   This is the hole that shipped `log_level`, `ai_auth_enforce` and the removed');
  console.error('   `llm_*` fields to the dev channel for weeks while canonical was clean:');
  console.error('   release.sh does not mirror config.yaml, and no other gate reads it.\n');
  console.error('   Fix:  node scripts/compose-dev-config.mjs   (then commit)\n');
  process.exit(1);
}

if (next === current) {
  console.log('⏭️  dev config.yaml already composed — unchanged');
} else {
  writeFileSync(DEV, next);
  console.log('✓ composed dashie-ha-dev/config.yaml from canonical + the dev overlay');
}
