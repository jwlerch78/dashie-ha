#!/usr/bin/env node
/**
 * check-service-policy — replays T's 2026-08-03 field probe against the REAL
 * exported `evaluate`, plus the class-A refusals that must survive every
 * widening.
 *
 * ── WHY A CONTROL AND NOT A READING ─────────────────────────────────────────
 *
 * 📌 T's meta-finding is the reason this file exists: all 17 field calls
 * returned **HTTP 200**, because observe mode answers `allowed: !enforcing`. The
 * log MARKERS were the entire signal. So a status-code harness — the obvious way
 * to test this — reads all-green against a policy that would refuse music,
 * scripts and scenes the moment it is enforced. The verdict has to be read from
 * the decision function, not from the wire.
 *
 * ── WHAT IT PINS ────────────────────────────────────────────────────────────
 *
 * 🔴 CLASS A must stay refused. `lock.open` physically opens a door latch. These
 * three are the entire point of the policy being service-level rather than
 * domain-level (`CONTROLLABLE_DOMAINS` contains `lock`), and a careless widening
 * that re-admits them silently undoes the whole unit.
 *
 * CLASS B must now pass. Each was a real feature the policy would have broken —
 * `media_player.play_media` is voice music playback, the highest-impact one.
 *
 * 🔴 CLASS C is the structural case and needs its own reasoning: HA invokes a
 * script as `script.<entity_name>`, so the service name IS the user's script
 * name. `script.turn_on` alone refuses EVERY user-defined script, forever. The
 * fix canonicalises `script.<x>` → `script.turn_on`. It widens nothing —
 * `script.turn_on` was already allowed — it only stops the verdict depending on
 * what the user named their script, which was never a security property.
 *
 * Exit 0 = every case holds, 1 = a violation, 2 = cannot check.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, '..', 'dashie-ha', 'server', 'ha-service-policy.js');

if (!existsSync(MODULE)) {
    console.error(`check-service-policy: cannot check — ${MODULE} not found`);
    process.exit(2);
}

const require_ = createRequire(import.meta.url);
let policy;
try {
    policy = require_(MODULE);
} catch (e) {
    console.error(`check-service-policy: cannot check — module did not load: ${e.message}`);
    process.exit(2);
}
if (typeof policy.evaluate !== 'function') {
    console.error('check-service-policy: cannot check — evaluate is not exported');
    process.exit(2);
}

// Force ENFORCING, or every case passes trivially: in observe mode `allowed` is
// always true and the verdict lives only in `reason`. Reading `reason` is what
// makes this test the thing T's HTTP harness could not be.
const ENFORCE = { service_policy_enforce: true };
const verdict = (d, s) => policy.evaluate(d, s, ENFORCE);

const CASES = [
    // ── CLASS A — must stay REFUSED, forever ────────────────────────────────
    ['lock', 'open', false, 'physically opens a door latch — the reason this policy is service-level, not domain-level'],
    ['lock', 'unlock', false, 'same axis as lock.open; voice-unlock must be a deliberate widening with its own decision'],
    ['alarm_control_panel', 'alarm_disarm', false, 'disarming an alarm by voice is not an ordinary control'],

    // ── POSITIVE CONTROL — ordinary control still works ─────────────────────
    ['light', 'turn_on', true, 'if this ever fails the list is useless and everything else here is moot'],
    ['lock', 'lock', true, 'same domain as class A, opposite verdict — proves the unit is the SERVICE, not the domain'],

    // ── CLASS B — widened 2026-08-04 from T's field evidence ────────────────
    ['media_player', 'play_media', true, 'VOICE MUSIC PLAYBACK — the highest-impact entry the probe surfaced'],
    ['media_player', 'volume_up', true, 'volume_set was listed and the stepwise pair was not — an enumeration gap'],
    ['media_player', 'volume_down', true, 'as volume_up'],
    ['climate', 'set_preset_mode', true, 'eco/away/comfort — same class as set_hvac_mode, which was listed'],
    ['cover', 'toggle', true, 'open/close/stop were listed and toggle was not'],
    ['select', 'select_option', true, 'ordinary entity control a voice command reaches constantly'],
    ['number', 'set_value', true, 'as select_option'],
    ['vacuum', 'start', true, 'as select_option'],

    // ── CLASS C — the structural fix ────────────────────────────────────────
    ['script', 'goodnight', true, "T's actual field failure: HA invokes scripts as script.<entity_name>"],
    ['script', 'movie_night', true, 'any user-defined script name — the namespace is the USER\'S, unbounded by construction'],
    ['scene', 'evening', true, 'scene.<name> has the same shape as script.<name>'],
    ['script', 'turn_on', true, 'the canonical form still works — canonicalise must not break the entry it maps onto'],

    // 🔴 Canonicalisation must not leak into a domain that does not have the
    // problem. `automation` invokes as `automation.trigger` with the entity in
    // the payload, so its service name is already bounded — mapping arbitrary
    // automation.* to turn_on would be a real widening, not a fix.
    ['automation', 'some_automation', false, 'automation names are NOT service names — canonicalisation must not leak here'],
];

let failed = 0;
for (const [domain, service, expectAllowed, why] of CASES) {
    let v;
    try {
        v = verdict(domain, service);
    } catch (e) {
        console.error(`❌ ${domain}.${service} — threw: ${e.message}`);
        failed++;
        continue;
    }
    if (v.allowed === expectAllowed) {
        console.log(`✅ ${domain}.${service} → ${v.allowed ? 'allowed' : v.reason}`);
    } else {
        console.error(
            `❌ ${domain}.${service} — expected ${expectAllowed ? 'ALLOWED' : 'REFUSED'}, ` +
            `got ${v.allowed ? 'allowed' : v.reason}\n     why it matters: ${why}`,
        );
        failed++;
    }
}

// Observe mode must still permit everything, or the ladder is not a ladder.
const observed = policy.evaluate('lock', 'open', { service_policy_enforce: false });
if (observed.allowed === true && observed.reason === 'not_allowed') {
    console.log('✅ observe mode — lock.open is permitted but REASONED (allowed:true, reason:not_allowed)');
} else {
    console.error(
        `❌ observe mode broken — allowed=${observed.allowed} reason=${observed.reason}\n` +
        '     Observe must permit while recording the verdict; that log is the entire deliverable until the flag flips.',
    );
    failed++;
}

console.log('');
if (failed) {
    console.error(`❌ ${failed} case(s) failed`);
    process.exit(1);
}
console.log(`✅ ${CASES.length} cases + observe-mode control pass — class A held out, B widened, C structural`);
