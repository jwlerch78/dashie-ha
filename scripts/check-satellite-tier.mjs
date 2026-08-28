#!/usr/bin/env node
/**
 * check-satellite-tier — the per-consumer-CLASS tier keeps the property that
 * made it buildable at all.
 *
 * The design question sat open in engines.js's header for five days with a
 * one-line reason: convergence is the intent, but a single flat value cannot
 * express it, because an on-device engine a tablet runs is meaningless to an
 * ESP32. The tier's whole content is the CLASS TEST — and the class test is one
 * `if` away from becoming a URL test, which would look like convergence and
 * behave like a stale value.
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
/** Assert on CODE, never on prose — see check-turn-log.mjs's `code()`. */
function code(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

const tier = read('dashie-ha/server/satellite-engines.js');
const eng  = read('dashie-ha/server/engines.js');
const T = code(tier), E = code(eng);

// Leg 1: the class test is an ALLOW-LIST of provider ids, not a URL-shape test.
// A URL test routes a satellite at whatever `localSttUrl` happens to be saved —
// including on a household that deliberately chose on-device and left a stale URL
// in the form. That looks like convergence and behaves like a stale value.
{
    const hasAllowList = /SERVER_REACHABLE\s*=\s*Object\.freeze\(\{/.test(T) &&
                         /stt:\s*new Set\(\[/.test(T) && /tts:\s*new Set\(\[/.test(T);
    const testsMembership = /SERVER_REACHABLE\[kind\]\.has\(provider\)/.test(T);
    if (hasAllowList && testsMembership) ok('1: consumability is an allow-list of provider ids, tested by membership');
    else if (!hasAllowList) fail('[1] SERVER_REACHABLE is not an explicit per-kind allow-list. A new on-device engine must not become satellite-usable just because it stores something in a URL field.');
    else fail('[1] The tier does not test provider membership in SERVER_REACHABLE — it is deciding on something other than the engine CLASS.');
}

// Leg 2: it must never decide from the URL's presence or shape.
if (!/https?:\/\//.test(T.replace(/SERVER_REACHABLE[\s\S]*?\}\);/, '')) || true) {
    const urlShapeTest = /\/\^https\?/.test(T) || /startsWith\(\s*['"]http/.test(T) ||
                         /if\s*\(\s*base\s*\)\s*return\s*\{\s*base/.test(T);
    if (!urlShapeTest) ok('2: no URL-shape or URL-presence shortcut stands in for the class test');
    else fail('[2] The tier decides from the URL rather than the chosen engine. A saved-but-abandoned URL would then route satellites on a household that chose on-device.');
}

// Leg 3: the add-on option outranks the household choice.
{
    const body = T.match(/async function resolveSatelliteBase\([\s\S]*?\n\}/)?.[0] || '';
    const optAt = body.indexOf('addon-option');
    const houseAt = body.indexOf('_householdVoice');
    if (optAt !== -1 && houseAt !== -1 && optAt < houseAt) ok('3: the add-on option is resolved and returned before the household is consulted');
    else fail('[3] The household choice is consulted before (or instead of) the add-on option. The option is the operator\'s direct statement about THIS lane and is the only knob they have when the household choice is wrong for their satellites.');
}

// Leg 4: handleVoices resolves through the SAME tier as handleTts. Otherwise the
// voice LIST comes from a different box than the speech is synthesised on, and the
// two agree only when tts_url is set — the case the tier exists to stop being the
// only working one.
{
    const voices = E.match(/async function handleVoices\([\s\S]*?\n\}/)?.[0] || '';
    if (/resolveSatelliteBase\(\s*'tts'\s*\)/.test(voices)) ok('4: handleVoices resolves its base through the same tier as handleTts');
    else fail('[4] handleVoices does not use the tier. It would fetch the voice list from a different endpoint than handleTts synthesises on, whenever the household tier answered.');
}

// Leg 5: every lane entry point goes through the tier — a missed one is a lane that
// silently keeps the old option-only behaviour, which looks exactly like "not configured".
{
    const missed = ['handleStt', 'handleTts', 'handleVoices'].filter((fn) => {
        const body = E.match(new RegExp(`async function ${fn}\\([\\s\\S]*?\\n\\}`))?.[0] || '';
        return !/resolveSatelliteBase\(/.test(body);
    });
    if (missed.length === 0) ok('5: all three lane entry points resolve through the tier');
    else fail(`[5] These lane handlers still read the add-on option directly: ${missed.join(', ')}. A missed one keeps the old behaviour and is indistinguishable from "not configured".`);
}

// Leg 6: the tier resolves a BASE and never a credential. Conflating them would
// send an add-on-configured API key to a LAN endpoint the household picked.
if (!/api_key|apiKey|authHeaders/.test(T)) ok('6: the tier resolves a base URL only — never a credential');
else fail('[6] satellite-engines.js touches a credential. It resolves WHICH endpoint, not what to authenticate to it with; conflating them sends an add-on-configured key to a household-chosen LAN box.');

if (errors.length) {
    console.error(`\nsatellite-tier check FAILED (${errors.length} issue${errors.length > 1 ? 's' : ''}):\n`);
    for (const e of errors) console.error('  • ' + e + '\n');
    process.exit(1);
}
console.log(`✅ satellite-tier check passed — ${pass.length} assertions:`);
for (const p of pass) console.log(`   · ${p}`);
