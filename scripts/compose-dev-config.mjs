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

  /**
   * Lines the DEV channel REPLACES rather than adds. Key → per-block lines.
   *
   * 🔴 `cloud_env` is narrowed to `dev|prod` HERE and not in canonical, and the
   * asymmetry is the point. The list is the Configuration-tab UI, and Home
   * Assistant validates a STORED option against it at add-on start — so removing
   * a value from the list stops any box already storing it from starting at all.
   * The prod channel is at 0.8.6, which predates the dev|prod rename (0.9.21), so
   * field boxes there still store `stable` / `production` / `beta`. Narrowing
   * canonical would brick them on the next promotion, before any add-on code of
   * ours runs and could migrate anything.
   *
   * The dev channel has no such population — it is the test box — so it gets the
   * clean two-value list now. Canonical stays wide until a release has normalised
   * the stored values in the field; see the note beside `cloud_env` there.
   *
   * John, 2026-09-22: *"we need to simplify this to be dev and prd"* and *"we need
   * dev to point to dev by default"*. Both are pinned here rather than inherited,
   * so a future canonical edit cannot quietly widen the dev channel again.
   */
  replace: {
    cloud_env: {
      options: ['  cloud_env: dev'],
      schema: ['  cloud_env: list(dev|prod)'],
    },
  },
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
  // Which block we are in decides which replacement applies: the same key
  // appears once under `options:` (a value) and once under `schema:` (a type).
  let block = 'options';
  const replaced = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A block ends at the next top-level key (or EOF).
    const isTopLevel = (s) => s.length > 0 && !s.startsWith(' ') && !s.startsWith('#');
    if (line === 'schema:') {
      out.push(...DEV_OVERLAY.options, line);
      block = 'schema';
      continue;
    }
    const key = /^ {2}([A-Za-z_][A-Za-z0-9_]*):/.exec(line)?.[1];
    const sub = key && DEV_OVERLAY.replace?.[key]?.[block];
    if (sub) {
      out.push(...sub);
      replaced.add(`${block}.${key}`);
      continue;
    }
    out.push(line);
    if (i === lines.length - 1) out.push(...DEV_OVERLAY.schema);
    else if (isTopLevel(lines[i + 1]) && !isTopLevel(line) && out.includes('schema:')) {
      // defensive: a future top-level key after schema
      out.push(...DEV_OVERLAY.schema);
    }
  }
  // 🔴 A replacement that matched NOTHING is a silent no-op that leaves the dev
  // channel inheriting canonical's wide list while this file claims otherwise —
  // the exact shape of a gate that certifies a tree it never touched. Fail loudly.
  // Both blocks are REQUIRED, not merely checked-if-present. An entry that
  // declares `options` but not `schema` replaces the dev channel's VALUE while
  // silently inheriting canonical's TYPE — so `cloud_env` would read `dev` in
  // the options while the picker still offered all six legacy names, and this
  // file would compose, print ✓ and be wrong about the only thing it exists to
  // do. Caught by fault injection on 2026-09-22; the first version of this
  // guard skipped an undeclared block and passed that mutation.
  for (const key of Object.keys(DEV_OVERLAY.replace || {})) {
    for (const b of ['options', 'schema']) {
      if (!DEV_OVERLAY.replace[key][b]) {
        throw new Error(`DEV_OVERLAY.replace.${key} declares no '${b}' lines — a replacement `
          + `must cover BOTH blocks, or the dev channel inherits canonical's ${b} for '${key}'.`);
      }
      if (!replaced.has(`${b}.${key}`)) {
        throw new Error(`DEV_OVERLAY.replace.${key}.${b} matched no line in canonical — `
          + `the dev channel would silently inherit canonical's value for '${key}'.`);
      }
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
