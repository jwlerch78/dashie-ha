// SPDX-License-Identifier: AGPL-3.0-only
// ha-target-resolver.js — WHICH ENTITIES does this service call actually touch?
//
// ── WHY THIS EXISTS, AND WHY IT COMES BEFORE THE EXPOSURE CHECK ──────────────
//
// D's `/service` ruling (D-status s49 §4, item 2) is "no `entity_id` ⇒ REFUSE by
// default, in three layers", and the FIRST of those layers is **resolve targets
// first**. The ordering is the whole point:
//
//   🔴 A per-entity check that runs before resolution is a check with a bypass.
//   `{area_id: 'kitchen'}` names no entity, so a naive reading sees zero targets,
//   finds nothing to object to, and passes the call through to every entity in
//   the kitchen. The looser the selector, the less there is to check — which is
//   the wrong way round.
//
// So: expand every selector HA accepts into concrete entity_ids, THEN judge. The
// exposure half (the other lane of this unit) hangs off `resolve()`'s output, and
// gets a complete target set or an explicit failure — never a quiet subset.
//
// ── THE SELECTORS HA ACCEPTS ────────────────────────────────────────────────
//
// A service call targets entities four ways, flat in `data` or nested under
// `data.target` — HA accepts both, so reading only one leaves a shape that
// bypasses everything downstream. Each may be a string, a comma-string, or a
// list.
//
//   entity_id   direct
//   device_id   every entity of that device
//   area_id     every entity IN that area — including entities that have no area
//               of their own and inherit their DEVICE's
//   label_id    every entity carrying that label
//
// ── AND THE FIFTH TARGET, WHICH IS NOT A SELECTOR AT ALL ────────────────────
//
// 🔴 `script.goodnight` targets `script.goodnight` and carries NO entity_id.
// Home Assistant registers a service per script, so for these the service NAME is
// the target. `ha-service-policy.js` already knows this shape — it canonicalises
// `script.<x>` → `script.turn_on` so the allow-list is not defeated by whatever
// the user named their script — and the same fact resolves the target here.
//
// Without this, every user-defined script would resolve to zero targets and be
// refused as `no_entity` the day enforcement flips: a whole feature amputated by
// a rule that was aimed at untargeted calls. It is also the reason the
// "targetless residue allow-list" D's item 2 anticipates is EMPTY today rather
// than unmeasured — the residue turned out to be derivable instead of listed.
//
// ── FAILURE DIRECTION ───────────────────────────────────────────────────────
//
// "Resolved to nothing" and "could not resolve" are DIFFERENT ANSWERS and are
// kept apart all the way to the caller. Both refuse, but only one of them is a
// defect, and collapsing them would hide a broken WebSocket behind a stream of
// markers that read like ordinary policy refusals.

'use strict';

/** Pull one selector out of both the flat and the `target:` shapes. */
function _selector(data, key) {
    const out = [];
    const sources = [data];
    if (data && typeof data.target === 'object' && data.target && !Array.isArray(data.target)) {
        sources.push(data.target);
    }
    for (const src of sources) {
        if (!src || typeof src !== 'object') continue;
        const val = src[key];
        if (typeof val === 'string') out.push(...val.split(','));
        else if (Array.isArray(val)) out.push(...val);
    }
    return [...new Set(out.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()))];
}

/** Every selector this payload carries, normalised. */
function selectors(data) {
    const d = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
    return {
        entity_id: _selector(d, 'entity_id'),
        device_id: _selector(d, 'device_id'),
        area_id: _selector(d, 'area_id'),
        label_id: _selector(d, 'label_id'),
    };
}

/**
 * The entity a call targets by NAMING it as the service. `script.goodnight` →
 * `script.goodnight`. Mirrors `ha-service-policy.canonicalise`'s domain set on
 * purpose: both answer questions about the same HA fact, and the policy module
 * is the holder.
 */
function entityNamedTarget(domain, service, policy) {
    if (!policy || typeof policy.canonicalise !== 'function') return null;
    // If canonicalise rewrote the service name, the original name WAS an entity.
    return policy.canonicalise(domain, service) !== service ? `${domain}.${service}` : null;
}

/**
 * Expand a service call's selectors into concrete entity_ids.
 *
 * `registry` is injected rather than required, so this is drivable without a
 * WebSocket — the same test-seam reasoning as `DASHIE_CAPABILITY_ROOT` in
 * check-wire-values. It needs `getAllEntities()` and `getAllDevices()`.
 *
 * Returns `{ entities, failed, failure, sources }`:
 *   entities  sorted, de-duplicated entity_ids
 *   failed    true when a registry read threw — NOT the same as "resolved to none"
 *   sources   which selector kinds contributed, for the marker
 */
async function resolve(domain, service, data, registry, policy) {
    const sel = selectors(data);
    const found = new Set(sel.entity_id);
    const sources = new Set(sel.entity_id.length ? ['entity_id'] : []);

    const named = entityNamedTarget(domain, service, policy);
    if (named) { found.add(named); sources.add('service_name'); }

    const needsRegistry = sel.device_id.length || sel.area_id.length || sel.label_id.length;
    if (!needsRegistry) {
        return { entities: [...found].sort(), failed: false, failure: null, sources: [...sources] };
    }

    let entities;
    let devices;
    try {
        entities = await registry.getAllEntities();
        devices = await registry.getAllDevices();
    } catch (e) {
        // 🔴 Report the PARTIAL set alongside the failure, and never let a caller
        // read it as complete. A resolver that returns "the entity_ids I managed
        // to find" with no flag is how a broken registry becomes a permissive
        // one: the direct entity_ids resolve fine, the area expands to nothing,
        // and the call sails through a per-target check with fewer targets than
        // it has.
        return {
            entities: [...found].sort(),
            failed: true,
            failure: e.message || 'registry read failed',
            sources: [...sources],
        };
    }

    const deviceArea = new Map();
    for (const d of devices || []) if (d && d.id) deviceArea.set(d.id, d.area_id || null);

    for (const e of entities || []) {
        if (!e || !e.entity_id) continue;
        if (sel.device_id.includes(e.device_id)) { found.add(e.entity_id); sources.add('device_id'); }
        // An entity's own area_id wins; absent, it inherits its device's. Reading
        // only the entity's own field under-counts every entity that has never
        // been individually assigned — which is most of them.
        const area = e.area_id || (e.device_id ? deviceArea.get(e.device_id) : null);
        if (area && sel.area_id.includes(area)) { found.add(e.entity_id); sources.add('area_id'); }
        if (Array.isArray(e.labels) && e.labels.some((l) => sel.label_id.includes(l))) {
            found.add(e.entity_id);
            sources.add('label_id');
        }
    }

    return { entities: [...found].sort(), failed: false, failure: null, sources: [...sources] };
}

module.exports = { selectors, entityNamedTarget, resolve };
