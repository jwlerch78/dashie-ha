#!/usr/bin/env node
/**
 * check-model-availability — row 79's client half keeps the THREE-STATE that
 * makes it safe, and the disabled row is actually refused.
 *
 * The server half already returns `models: null` for "cannot verify" and says at
 * length why. This gate guards the CONSUMER, where the distinction is cheap to
 * lose: `!entry.models` and `!entry.models.length` read identically at a glance
 * and one of them greys out every model for OpenRouter and Bedrock — providers
 * whose keys are FINE and whose probes simply cannot enumerate. Disabling a
 * working setup is the expensive direction.
 *
 * Exit 0 = green, 1 = a real failure, 2 = cannot check.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const errors = [], pass = [];
const ok = (m) => pass.push(m);
const fail = (m) => errors.push(m);
function read(rel) {
    try { return readFileSync(resolve(ROOT, rel), 'utf8'); }
    catch (e) { console.error(`cannot read ${rel}: ${e.message}`); process.exit(2); }
}
/** Strip comments before asserting on CODE — see check-turn-log.mjs's `code()`
 *  for why (a gate that reads prose certifies the documentation, not the code). */
function code(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

const page  = read('dashie-ha/frontend/console/js/pages/voice-ai.js');
const cards = read('dashie-ha/frontend/console/js/components/voice-ai-cards.js');
const keys  = read('dashie-ha/server/api/keys.js');

const marker = code(page).match(/_markUnavailable\(options\)\s*\{[\s\S]*?\n    \},/)?.[0] || '';

// Leg 1: the marker exists and is APPLIED. A three-state helper nothing calls is
// the authored-but-unreached shape this ground has eight recorded instances of.
if (!marker) {
    fail('[1] _markUnavailable is missing from voice-ai.js — row 79 has no client half.');
} else if (/_markUnavailable\(/.test(code(page).replace(marker, ''))) {
    ok('1: _markUnavailable exists AND is applied to a card');
} else {
    fail('[1] _markUnavailable is defined but never called. A three-state helper nothing renders is authored-but-unreached.');
}

// Leg 2: an unverifiable answer disables NOTHING.
if (/Array\.isArray\(\s*entry\.models\s*\)/.test(marker)) {
    ok('2: only an actual ARRAY of models can disable anything (null = cannot verify)');
} else {
    fail(
        `[2] _markUnavailable does not require an Array before disabling. \`models: null\` means ` +
        `CANNOT VERIFY (openrouter probes /key; bedrock has no probe), not "no models" — a length ` +
        `or truthiness test greys out every model for those providers and sends users to fix a key ` +
        `that is fine.`
    );
}

// Leg 3: a provider that was never probed is untouched.
if (/!entry\s*\|\|/.test(marker) || /if\s*\(\s*!entry\b/.test(marker)) {
    ok('3: a provider with no probe result is left enabled');
} else {
    fail('[3] _markUnavailable does not skip providers with no cached probe. Never-probed must mean cannot-verify, not unavailable.');
}

// Leg 4: an option with no provider is untouched (search sources, the local row).
if (/if\s*\(\s*!o\.provider\s*\)\s*return o/.test(marker)) {
    ok('4: options with no provider (search sources, local rows) are untouched');
} else {
    fail('[4] _markUnavailable does not skip provider-less options. A local "My own AI" row has no key to check against.');
}

// Leg 5: a disabled row must not still SELECT.
{
    const c = code(cards);
    const dropsClick = /const onclick\s*=\s*unavailable\s*\?\s*''/.test(c);
    const showsReason = /unavailableReason/.test(c);
    if (dropsClick && showsReason) ok('5: an unavailable row drops its click handler AND shows the reason');
    else if (!dropsClick) fail('[5] The card still wires a click handler on an unavailable row. Greyed-but-clickable is worse than not greyed: it looks refused and behaves accepted, and the user learns which from a dead turn.');
    else fail('[5] The card never renders unavailableReason. Grey WITH the reason — the reason is what teaches the action.');
}

// Leg 6: only SUCCESSFUL probes deposit availability.
{
    const c = code(keys);
    if (/result\?\.ok === true/.test(c) && /_modelAvailability\.set\(/.test(c)) {
        ok('6: only a successful probe deposits availability (a rejected key records nothing)');
    } else {
        fail('[6] The validate route caches availability without gating on ok === true. A rejected or unreachable key tells us nothing about its model list.');
    }
}

// Leg 7: the cache is in-memory.
{
    const c = code(keys);
    if (/const _modelAvailability = new Map\(\)/.test(c) && !/writeFileSync[\s\S]{0,200}modelAvailability/i.test(c)) {
        ok('7: availability is cached in memory only (a restart forgets, and forgetting disables nothing)');
    } else {
        fail('[7] Model availability is persisted. It is a cache of a REMOTE fact — a stale on-disk copy outlives its truth and disables models that work.');
    }
}

if (errors.length) {
    console.error(`\nmodel-availability check FAILED (${errors.length} issue${errors.length > 1 ? 's' : ''}):\n`);
    for (const e of errors) console.error('  • ' + e + '\n');
    process.exit(1);
}
console.log(`✅ model-availability check passed — ${pass.length} assertions:`);
for (const p of pass) console.log(`   · ${p}`);
