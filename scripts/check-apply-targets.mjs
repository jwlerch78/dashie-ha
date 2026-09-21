#!/usr/bin/env node
/**
 * check-apply-targets.mjs — "Also apply to" must copy EVERY setting its dialog
 * writes.
 *
 * ── WHY (John, 2026-09-21) ──────────────────────────────────────────────────
 * John asked the question this gate exists to answer: "is it going to apply all
 * of the sleep settings to all tablets selected? Or just the sleep and wake
 * times?" The answer was *just some of them*. The Sleep dialog writes nine
 * settings; the fan-out list named six. Show Clock, Reduce Brightness, Motion
 * Wake and the Black Overlay option were silently left behind — and the dialog
 * says "Also apply to", which any reader takes to mean the dialog.
 *
 * 🔴 This is trap 33 in HEADLESS_HARNESS_MEASUREMENT_TRAPS: a control that
 * discriminates PART of a set is the most convincing possible evidence for the
 * part it never touched. Four of the settings DID copy, so the feature looked
 * like it worked — the failure is invisible unless you compare the two lists,
 * which nothing did. The bug predates the multi-select: the old apply-to-all
 * carried the same six-key list, and I inherited it without checking.
 *
 * ⚠️ `_APPLY_ALL_KEYS[x].keys` is a HAND-MIRROR of what a dialog renders. The
 * seam rule says a mirror gets a gate in the same change; this is that gate.
 * It reads each modal's own render body and fails when a key the dialog writes
 * is missing from the spec it fans out.
 *
 * Exit 0 = every written key is copied · 1 = drift · 2 = BLIND.
 * Run: node scripts/check-apply-targets.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'dashie-ha/frontend/console/js/pages/devices-detail-modals.js');

/** spec key → the render function whose writes it must cover. */
const RENDERERS = {
  theme: 'renderThemeModal',
  sleep: 'renderSleepModal',
  personality: 'renderVoicePersonalityModal',
  voice: 'renderVoiceVoiceModal',
  photos: 'renderPhotosModal',
};

/**
 * Keys a dialog renders but must NOT fan out. Each needs a REASON, not just an
 * entry — an exemption list without reasons becomes the place drift hides.
 */
const EXEMPT = {
  'sleep.sleepMode': 'UI-only projection of enabled + sleepMethod; nothing stores it '
    + '(the modal says so at its own definition). Fanning it out would write a key no device reads.',
};

/**
 * Dialogs whose writes the body scan CANNOT see, checked against a canonical key
 * list instead. The scan looks for `(device, 'cat', 'key'`; a dialog that stages
 * edits and writes them on submit matches nothing, and "writes nothing" is BLIND
 * here — so without this such a dialog could never be covered at all.
 */
const DERIVED = {
  voiceSetup: {
    list: 'VOICE_LEAF_KEYS', category: 'voice',
    why: 'stages into _voiceSetupPending and writes on submit, so the (device, cat, key) scan reads zero',
  },
};

/**
 * Dialogs that deliberately do NOT fan out, and dialogs that simply are not wired
 * yet. Both must be DECLARED.
 *
 * 🔴 THIS BLOCK IS THE POINT OF THE 2026-09-21 REWRITE. Before it, the gate walked a
 * hand-written RENDERERS map, so a dialog with no spec was not "failing" — it was
 * INVISIBLE, and so was a spec added without a matching renderer entry. Five of the
 * ten dialogs had no fan-out at all and the gate reported a clean pass on the five it
 * happened to know about. A gate that certifies only what it was told about answers a
 * question nobody asked.
 */
const NO_FANOUT = {
  _pinDeviceId: 'REFUSED: a PIN is a per-device secret. Copying one to every screen is a '
    + 'security decision disguised as a convenience, and the user cannot see it happen.',
};
const UNWIRED = {
  _wakeWordDeviceId: 'candidate — on the card, plausible to fan out; not yet specced',
  _screensaverDeviceId: 'candidate — not yet specced',
  _advancedDisplayDeviceId: 'candidate — not yet specced',
};

function blind(msg) {
  console.error(`❌ check-apply-targets: BLIND — ${msg}`);
  process.exit(2);
}

if (!existsSync(SRC)) blind(`devices-detail-modals.js not found at ${SRC}`);
const src = readFileSync(SRC, 'utf8');

// ── the declared fan-out sets ───────────────────────────────────────────────
const table = src.match(/_APPLY_ALL_KEYS:\s*\{([\s\S]*?)\n    \},/);
if (!table) blind('could not find _APPLY_ALL_KEYS. Reporting agreement about a list this gate never read would be a lie.');

// Collected across every check below, reported once at the end.
const problems = [];

// ── COVERAGE: every dialog and every spec must be ACCOUNTED FOR ─────────────
// Derived from the source, not from a list in this file, so a new dialog or a new
// spec cannot arrive unnoticed.
const specIdKeys = new Map([...table[1].matchAll(/(\w+):\s*\{\s*idKey:\s*'(_\w+)'/g)]
  .map(m => [m[1], m[2]]));
if (specIdKeys.size === 0) blind('could not read any idKey from _APPLY_ALL_KEYS');

for (const name of specIdKeys.keys()) {
  if (!RENDERERS[name] && !DERIVED[name]) {
    problems.push(`_APPLY_ALL_KEYS.${name} exists but this gate checks nothing against it.\n`
      + `    → add it to RENDERERS (body-scanned) or DERIVED (canonical-list), or the spec is unverified.`);
  }
}

const dialogIdKeys = new Set([...src.matchAll(/_(\w+)DeviceId\b/g)].map(m => `_${m[1]}DeviceId`));
const covered = new Set(specIdKeys.values());
for (const idKey of dialogIdKeys) {
  if (covered.has(idKey) || NO_FANOUT[idKey] || UNWIRED[idKey]) continue;
  problems.push(`the dialog behind ${idKey} has no fan-out spec and is not declared.\n`
    + `    → give it an _APPLY_ALL_KEYS entry, or declare it in NO_FANOUT (with a reason) or UNWIRED.`);
}

const declared = {};
for (const name of Object.keys(RENDERERS)) {
  // Find this spec, then its `keys: [` and scan to the MATCHING bracket. A regex
  // for the whole block broke on the first entry whose shape differed (photos),
  // and a gate that cannot parse a list must not report on it.
  const at = table[1].indexOf(`${name}:`);
  if (at === -1) blind(`_APPLY_ALL_KEYS has no '${name}' entry`);
  const kAt = table[1].indexOf('keys: [', at);
  if (kAt === -1) blind(`'${name}' has no \`keys\` list`);
  let depth = 0, end = -1;
  for (let i = kAt + 'keys: '.length; i < table[1].length; i++) {
    const c = table[1][i];
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) blind(`'${name}' \`keys\` list is unterminated`);
  const list = table[1].slice(kAt, end);
  declared[name] = new Set([...list.matchAll(/\['([a-zA-Z]+)',\s*'([a-zA-Z]+)'\]/g)].map(m => `${m[1]}.${m[2]}`));
  if (declared[name].size === 0) blind(`'${name}' declares zero keys`);
}

// ── what each dialog actually writes ────────────────────────────────────────
for (const [name, fn] of Object.entries(RENDERERS)) {
  const start = src.indexOf(`    ${fn}() {`);
  if (start === -1) blind(`render function ${fn}() not found — it was renamed, and a gate that cannot find the dialog cannot certify it`);
  // 🔴 Bound at the NEXT MEMBER, not at the first `return this._modal(`.
  // renderVoiceVoiceModal has an EARLY return (the branch where the chosen
  // personality locks the voice), so cutting at the first one dropped the half
  // of the body that does the writing — and the gate then read zero writes and
  // would have passed anything. Caught only because "wrote nothing" is BLIND
  // here rather than vacuously green.
  const rest = src.slice(start + 4);
  const nextMember = rest.search(/\n    [a-zA-Z_$][\w$]*\s*\(/);
  const end = nextMember === -1 ? src.length : start + 4 + nextMember;
  const body = src.slice(start, end);

  // Every write goes through a helper taking (device, category, key, …).
  const writes = new Set([...body.matchAll(/\(\s*device\s*,\s*'([a-zA-Z]+)'\s*,\s*'([a-zA-Z]+)'/g)]
    .map(m => `${m[1]}.${m[2]}`));
  if (writes.size === 0) blind(`${fn}() appears to write NOTHING. Either the helper signature changed or the body was mis-bounded; either way a green here would be meaningless.`);

  for (const key of writes) {
    if (EXEMPT[key]) continue;
    if (!declared[name].has(key)) {
      problems.push(
        `${fn}() writes '${key}' but _APPLY_ALL_KEYS.${name} does not copy it.\n` +
        `    → ticking a device in "Also apply to" silently leaves that setting behind,\n` +
        `      while the settings beside it DO copy — so the feature looks like it worked.\n` +
        `      Add ['${key.split('.')[0]}', '${key.split('.')[1]}'] to the spec, or add an EXEMPT entry saying why not.`);
    }
  }
}

// An exemption for a key nothing writes is dead weight that hides the next one.
for (const key of Object.keys(EXEMPT)) {
  if (!src.includes(`'${key.split('.')[1]}'`)) {
    problems.push(`EXEMPT lists '${key}' but nothing in the modals writes it — stale exemption, remove it.`);
  }
}

// ── DERIVED dialogs: the spec must cover the canonical list, exactly ─────────
// Not "at least": a spec that copies a key the dialog cannot edit writes a value
// the user never chose, which is the mirror of the bug this gate was built for.
let derivedChecked = 0;
for (const [name, d] of Object.entries(DERIVED)) {
  const at = table[1].indexOf(`${name}:`);
  if (at === -1) blind(`DERIVED names '${name}' but _APPLY_ALL_KEYS has no such entry`);
  const kAt = table[1].indexOf('keys: [', at);
  if (kAt === -1) blind(`'${name}' has no \`keys\` list`);
  let depth = 0, end = -1;
  for (let i = kAt + 'keys: '.length; i < table[1].length; i++) {
    const c = table[1][i];
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) blind(`'${name}' \`keys\` list is unterminated`);
  const specKeys = new Set([...table[1].slice(kAt, end)
    .matchAll(/\['([a-zA-Z]+)',\s*'([a-zA-Z]+)'\]/g)].map(m => `${m[1]}.${m[2]}`));

  const listMatch = src.match(new RegExp(`${d.list}:\\s*\\[([^\\]]*)\\]`));
  if (!listMatch) blind(`could not read ${d.list} — the canonical list for '${name}'`);
  const canonical = new Set([...listMatch[1].matchAll(/'([a-zA-Z]+)'/g)]
    .map(m => `${d.category}.${m[1]}`));
  if (canonical.size === 0) blind(`${d.list} parsed to zero keys`);

  for (const k of canonical) {
    if (!specKeys.has(k)) problems.push(
      `${d.list} contains '${k}' but _APPLY_ALL_KEYS.${name} does not copy it.\n`
      + `    → the dialog can set it per device, so "Also apply to" must carry it too.`);
  }
  for (const k of specKeys) {
    if (!canonical.has(k)) problems.push(
      `_APPLY_ALL_KEYS.${name} copies '${k}', which is not in ${d.list}.\n`
      + `    → it would write a value the dialog never offered.`);
  }
  derivedChecked += canonical.size;
}

if (problems.length) {
  console.error('❌ check-apply-targets: "Also apply to" does not copy everything its dialog writes:\n');
  for (const p of problems) console.error(`  · ${p}\n`);
  process.exit(1);
}
const total = Object.values(declared).reduce((n, s) => n + s.size, 0);
console.log(`✅ check-apply-targets — every setting each dialog writes is fanned out `
  + `(${Object.keys(RENDERERS).length + Object.keys(DERIVED).length} dialogs, ${total + derivedChecked} keys)`);
// Print what is NOT covered, every run. An undeclared gap fails above; a DECLARED
// one must still be visible, or "we decided that" quietly becomes "we forgot that".
const unwired = Object.keys(UNWIRED);
if (unwired.length) console.log(`   not wired to "Also apply to": ${unwired.join(', ')}`);
for (const [k, why] of Object.entries(NO_FANOUT)) console.log(`   deliberately excluded: ${k} — ${why.split('.')[0]}.`);
