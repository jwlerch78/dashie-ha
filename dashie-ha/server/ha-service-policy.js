// SPDX-License-Identifier: AGPL-3.0-only
// ha-service-policy.js — may the console assistant call THIS service?
//
// ── WHY SERVICE-LEVEL AND NOT DOMAIN-LEVEL ───────────────────────────────────
//
// 🔴 This is the whole point, and a domain allowlist looks like it solves the
// problem while leaving it open. `CONTROLLABLE_DOMAINS` (api/ha.js) already
// contains `lock` — so a domain check permits **`lock.open`** and
// **`lock.unlock`**. The dangerous services live INSIDE the allowed domains, and
// nothing at domain granularity can see them.
//
// So the unit is `<domain>.<service>`: `lock.lock` yes, `lock.open` no.
//
// ── WHY THIS SHIPS IN OBSERVE MODE ───────────────────────────────────────────
//
// `/api/ha/service` is an LLM-driven passthrough — the model names the service,
// so the set it uses in the field is not knowable from the code. Any list I write
// today is a guess, and a wrong guess silently amputates a working assistant.
//
// So enforcement is OFF by default: every decision is logged, none is applied.
// Harvest real traffic, widen until the markers name only what we mean to refuse,
// then flip `service_policy_enforce`. Same rollout as `ai_auth_enforce`,
// `device_revocation_enforce` and `scope_enforce`: **ship the claim early, flip
// late.** (Thread D's ruling, D-status s49 §4.)
//
// ⚠️ Deliberately STRICT to begin with. In observe mode strictness costs nothing
// and buys evidence — a list that starts permissive teaches you nothing, because
// every call it would have allowed produces no marker.
//
// ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
//
// Not the exposure check. That half asks the integration whether the TARGET
// entity is Assist-exposed and needs an integration release; this half needs
// none, which is why it lands first — it closes the `lock.open` case now rather
// than waiting on a vendor cycle (D-status s49 §5).

'use strict';

const { readOptions } = require('./options');

/**
 * Services the console assistant may call, by `<domain>.<service>`.
 *
 * Grouped by the domain they sit in so the ABSENCES are visible: the value of
 * this list is as much what is missing from each line as what is on it.
 */
const ALLOWED_SERVICES = new Set([
    // Straightforward on/off surfaces.
    'light.turn_on', 'light.turn_off', 'light.toggle',
    'switch.turn_on', 'switch.turn_off', 'switch.toggle',
    'input_boolean.turn_on', 'input_boolean.turn_off', 'input_boolean.toggle',
    'fan.turn_on', 'fan.turn_off', 'fan.toggle', 'fan.set_percentage',

    'cover.open_cover', 'cover.close_cover', 'cover.stop_cover', 'cover.set_cover_position',
    'climate.set_temperature', 'climate.set_hvac_mode', 'climate.set_fan_mode',
    'climate.turn_on', 'climate.turn_off',

    'media_player.turn_on', 'media_player.turn_off',
    'media_player.media_play', 'media_player.media_pause', 'media_player.media_stop',
    'media_player.media_next_track', 'media_player.media_previous_track',
    'media_player.volume_set', 'media_player.volume_mute',

    'scene.turn_on',
    'script.turn_on',
    'automation.turn_on', 'automation.turn_off', 'automation.trigger',

    // 🔴 LOCK: locking only. `lock.unlock` and `lock.open` are deliberately
    // ABSENT — `lock.open` physically opens a door latch, and both are reachable
    // today through the domain allowlist this replaces. If the household wants
    // voice-unlock it should be a deliberate widening with its own decision, not
    // something inherited from `lock` being a "controllable domain".
    'lock.lock',
]);

/** Is enforcement on, or are we only observing? Default OBSERVE. */
function isEnforcing(opts = null) {
    const o = opts || readOptions();
    return o.service_policy_enforce === true;
}

/**
 * Decide, and say why. Returns `{ allowed, reason, enforcing }`.
 *
 * `allowed` is the ENFORCED answer — in observe mode it is always true, and
 * `reason` still carries what the decision would have been. Callers log the
 * reason regardless; that log IS the deliverable until the flag flips.
 */
function evaluate(domain, service, opts = null) {
    const key = `${domain}.${service}`;
    const enforcing = isEnforcing(opts);
    if (ALLOWED_SERVICES.has(key)) return { allowed: true, reason: 'ok', enforcing };
    // `not_allowed` is the only reason this half can produce. `no_entity` and
    // `not_exposed` belong to the exposure half and are named here so the marker
    // vocabulary is fixed before a second author invents a synonym.
    return { allowed: !enforcing, reason: 'not_allowed', enforcing };
}

module.exports = { ALLOWED_SERVICES, evaluate, isEnforcing };
