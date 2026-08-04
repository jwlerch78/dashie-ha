#!/usr/bin/env node
/**
 * check-service-targets — layer 1 of D's "no entity_id ⇒ REFUSE" (s49 §4 item 2):
 * does `/service` resolve what a call actually TOUCHES before judging it?
 *
 * ── WHY THIS IS A CONTROL AND NOT A READING ─────────────────────────────────
 *
 * Same meta-finding as check-service-policy: in observe mode every call returns
 * HTTP 200, because `allowed` is `!enforcing`. The verdict lives in `reason`, so
 * a status-code harness reads all-green against a resolver that silently misses
 * half the entities in an area. The verdict has to be read from the functions.
 *
 * ── THE CASE THAT MATTERS MOST ──────────────────────────────────────────────
 *
 * 🔴 `{area_id: 'kitchen'}` names no entity. A per-entity check that runs BEFORE
 * resolution therefore finds nothing to object to and passes the call to every
 * light in the kitchen — the looser the selector, the less there is to check.
 * Legs 4-7 pin the expansion; leg 12 pins the ordering that makes it matter.
 *
 * 🔴 And the quietest one: the entity registry used to omit every DEVICE-LESS
 * entity (input_boolean, script, scene, automation, template sensors — i.e. the
 * helpers a household creates by hand and then names out loud). An area that
 * expands to a subset does not read as an error; it reads as a smaller target
 * set, and every member of it passes whatever check comes next. Leg 6.
 *
 * Exit 0 = every case holds, 1 = a violation, 2 = cannot check.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'dashie-ha', 'server');
const require_ = createRequire(import.meta.url);

const load = (name) => {
    const p = join(SERVER, name);
    if (!existsSync(p)) {
        console.error(`check-service-targets: cannot check — ${p} not found`);
        process.exit(2);
    }
    try {
        return require_(p);
    } catch (e) {
        console.error(`check-service-targets: cannot check — ${name} did not load: ${e.message}`);
        process.exit(2);
    }
};

const policy = load('ha-service-policy.js');
const targets = load('ha-target-resolver.js');
for (const [mod, fn] of [[policy, 'evaluateTargets'], [targets, 'resolve'], [targets, 'selectors']]) {
    if (typeof mod[fn] !== 'function') {
        console.error(`check-service-targets: cannot check — ${fn} is not exported`);
        process.exit(2);
    }
}

// ── The scratch registry. Deliberately includes entities with NO device, an
//    entity with its own area, and an entity that INHERITS its device's area —
//    the three shapes a naive resolver gets wrong in three different ways.
const ENTITIES = [
    { entity_id: 'light.kitchen_main', device_id: 'dev-kitchen', area_id: null, labels: ['downstairs'] },
    { entity_id: 'light.kitchen_under', device_id: 'dev-kitchen', area_id: null, labels: [] },
    // Own area, no device — the device-less shape the registry cache used to drop.
    { entity_id: 'input_boolean.kitchen_party_mode', device_id: null, area_id: 'kitchen', labels: [] },
    { entity_id: 'script.goodnight', device_id: null, area_id: null, labels: [] },
    // Elsewhere — must never be swept in.
    { entity_id: 'light.bedroom', device_id: 'dev-bedroom', area_id: null, labels: ['upstairs'] },
];
const DEVICES = [
    { id: 'dev-kitchen', area_id: 'kitchen' },
    { id: 'dev-bedroom', area_id: 'bedroom' },
];
const REGISTRY = {
    getAllEntities: async () => ENTITIES,
    getAllDevices: async () => DEVICES,
};
const BROKEN_REGISTRY = {
    getAllEntities: async () => { throw new Error('websocket closed'); },
    getAllDevices: async () => DEVICES,
};

const ENFORCE = { service_policy_enforce: true };

let failed = 0;
function check(name, ok, detail, why) {
    if (ok) { console.log(`✅ ${name}`); return; }
    failed++;
    console.error(`❌ ${name}\n     ${detail}\n     why it matters: ${why}`);
}

const resolveWith = (registry, domain, service, data) =>
    targets.resolve(domain, service, data, registry, policy);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── 1-3 — the flat and nested entity_id shapes ──────────────────────────────
{
    const r = await resolveWith(REGISTRY, 'light', 'turn_on', { entity_id: 'light.kitchen_main' });
    check('leg 1 — a flat entity_id resolves to itself',
        same(r.entities, ['light.kitchen_main']), `got ${JSON.stringify(r.entities)}`,
        'the ordinary case; if this is wrong nothing else here is meaningful');

    const nested = await resolveWith(REGISTRY, 'light', 'turn_on', { target: { entity_id: 'light.bedroom' } });
    check('leg 2 — target.entity_id is read as well as the flat shape',
        same(nested.entities, ['light.bedroom']), `got ${JSON.stringify(nested.entities)}`,
        'HA accepts both shapes, so reading only the flat one leaves a payload shape that resolves to zero targets and bypasses every per-target check downstream');

    const csv = await resolveWith(REGISTRY, 'light', 'turn_on', { entity_id: 'light.kitchen_main, light.bedroom' });
    check('leg 3 — a comma-string is split, not treated as one id',
        same(csv.entities, ['light.bedroom', 'light.kitchen_main']), `got ${JSON.stringify(csv.entities)}`,
        'HA accepts comma-separated entity_ids; treating the string as a single id yields one target that matches nothing, so a multi-entity call checks nothing that exists');
}

// ── 4-7 — the selectors that name no entity ─────────────────────────────────
{
    const dev = await resolveWith(REGISTRY, 'light', 'turn_on', { device_id: 'dev-kitchen' });
    check('leg 4 — device_id expands to that device\'s entities',
        same(dev.entities, ['light.kitchen_main', 'light.kitchen_under']), `got ${JSON.stringify(dev.entities)}`,
        'a device target names no entity; unexpanded it is a call with zero targets to check and full effect');

    const area = await resolveWith(REGISTRY, 'light', 'turn_on', { area_id: 'kitchen' });
    check('leg 5 — area_id includes entities that INHERIT the area from their device',
        area.entities.includes('light.kitchen_main') && area.entities.includes('light.kitchen_under'),
        `got ${JSON.stringify(area.entities)}`,
        "reading only the entity's own area_id under-counts every entity never individually assigned — which is most of them — and an under-counted target set passes the exposure check with fewer targets than the call has");

    check('leg 6 — area_id ALSO includes the DEVICE-LESS entity in that area',
        area.entities.includes('input_boolean.kitchen_party_mode'),
        `got ${JSON.stringify(area.entities)}`,
        'the entity_registry cache dropped every entity with no device — helpers, scripts, scenes, automations. A subset does not read as an error, it reads as a smaller target set, and every member of it passes whatever check comes next');

    check('leg 7 — and nothing from another area is swept in',
        !area.entities.includes('light.bedroom'), `got ${JSON.stringify(area.entities)}`,
        'over-expansion is the opposite failure and would refuse legitimate calls once the exposure check lands, teaching everyone to switch enforcement off');

    const label = await resolveWith(REGISTRY, 'light', 'turn_on', { label_id: 'upstairs' });
    check('leg 8 — label_id expands to the labelled entities',
        same(label.entities, ['light.bedroom']), `got ${JSON.stringify(label.entities)}`,
        'the fourth selector HA accepts; an unhandled one is a bypass, not a missing feature');
}

// ── 9 — the fifth target, which is not a selector ──────────────────────────
{
    const script = await resolveWith(REGISTRY, 'script', 'goodnight', {});
    check('leg 9 — script.<name> resolves to the entity the SERVICE NAME names',
        same(script.entities, ['script.goodnight']), `got ${JSON.stringify(script.entities)}`,
        'HA registers a service per script, so these carry no entity_id. Without this every user-defined script resolves to zero targets and is refused as no_entity the day enforcement flips — a whole feature amputated by a rule aimed at untargeted calls');

    const plain = await resolveWith(REGISTRY, 'script', 'turn_on', { entity_id: 'script.goodnight' });
    check('leg 10 — the canonical script.turn_on form is NOT double-counted',
        same(plain.entities, ['script.goodnight']), `got ${JSON.stringify(plain.entities)}`,
        'canonicalise leaves turn_on alone, so the service name is not a target here — inventing script.turn_on as an entity would put a non-existent id into the exposure check and refuse a legitimate call');
}

// ── 11-13 — the verdicts ───────────────────────────────────────────────────
{
    const none = await resolveWith(REGISTRY, 'light', 'turn_on', {});
    const v = policy.evaluateTargets('light', 'turn_on', none, ENFORCE);
    check('leg 11 — a call with no target at all is REFUSED as no_entity',
        v.reason === 'no_entity' && v.allowed === false, `reason=${v.reason} allowed=${v.allowed}`,
        "D's ruling: no entity_id ⇒ refuse by default. An untargeted call is either a new emitter shape or an injection — both want a look, not a service call against everything");

    const ok = policy.evaluateTargets('light', 'turn_on',
        await resolveWith(REGISTRY, 'light', 'turn_on', { area_id: 'kitchen' }), ENFORCE);
    check('leg 12 — POSITIVE CONTROL: an area-targeted call is ALLOWED once resolved',
        ok.reason === 'ok' && ok.allowed === true, `reason=${ok.reason} allowed=${ok.allowed}`,
        'this is the ordering property. Judge the raw payload and an area target looks targetless and gets refused; resolve first and it is an ordinary call with four targets to check. Half the ruling — the other half is leg 11');

    const broken = await resolveWith(BROKEN_REGISTRY, 'light', 'turn_on', { area_id: 'kitchen' });
    const bv = policy.evaluateTargets('light', 'turn_on', broken, ENFORCE);
    check('leg 13 — a registry FAILURE refuses, and under its OWN reason',
        broken.failed === true && bv.reason === 'target_unresolved' && bv.allowed === false,
        `failed=${broken.failed} reason=${bv.reason} allowed=${bv.allowed}`,
        'an unanswerable question is not a yes, so it fails closed. But collapsing it into no_entity would hide a broken WebSocket behind a stream of markers that read like ordinary policy refusals — only one of the two is a defect');

    check('leg 14 — a failed resolution never reports its partial set as complete',
        broken.entities.length === 0 || broken.failed === true,
        `entities=${JSON.stringify(broken.entities)} failed=${broken.failed}`,
        'the direct entity_ids resolve fine while the area expands to nothing, so an unflagged partial set is how a broken registry becomes a permissive one');
}

// ── 15 — the observe ladder, unchanged ─────────────────────────────────────
{
    const none = await resolveWith(REGISTRY, 'light', 'turn_on', {});
    const obs = policy.evaluateTargets('light', 'turn_on', none, { service_policy_enforce: false });
    check('leg 15 — observe mode PERMITS while recording the verdict',
        obs.allowed === true && obs.reason === 'no_entity', `allowed=${obs.allowed} reason=${obs.reason}`,
        'this half ships on the same harvest-then-flip ladder as ALLOWED_SERVICES. If it refused on arrival it would amputate a working assistant on evidence nobody has gathered yet');
}

// ── 16 — the empty allow-list is empty ON PURPOSE ──────────────────────────
{
    check('leg 16 — TARGETLESS_SERVICES is empty, and that is a measurement',
        policy.TARGETLESS_SERVICES instanceof Set && policy.TARGETLESS_SERVICES.size === 0,
        `size=${policy.TARGETLESS_SERVICES?.size}`,
        "D anticipated a residue allow-list; the residue turned out to be one derivable shape (leg 9), so this stays empty until the field says otherwise. Pinned because an empty collection is this project's most repeated false signal — \"residue 0\" meant not-looked, five times");
}

// ── 17 — THE ACTUAL DEFECT, driven at the cache rather than around it ──────
//
// 🔴 Legs 1-16 inject their own registry, so every one of them would still pass
// with the real cache silently dropping half the entity registry. That is the
// component/outcome trap in miniature: the resolver is correct AND the thing it
// resolves from was incomplete. This leg drives `_indexEntityRegistry` — the
// pure half of the real refresh — because the defect lives THERE.
{
    const registry = load('ha-registry.js');
    if (typeof registry._indexEntityRegistry !== 'function') {
        console.error('❌ leg 17 — ha-registry._indexEntityRegistry is not exported; the cache is untestable again');
        failed++;
    } else {
        const indexed = registry._indexEntityRegistry([
            { entity_id: 'light.kitchen_main', device_id: 'dev-kitchen' },
            { entity_id: 'input_boolean.kitchen_party_mode', device_id: null },
            { entity_id: 'script.goodnight' },
        ]);
        const all = (indexed.all || []).map((e) => e.entity_id);
        check('leg 17 — the entity_registry cache KEEPS device-less entities',
            all.includes('input_boolean.kitchen_party_mode') && all.includes('script.goodnight'),
            `all=${JSON.stringify(all)}`,
            'this is the real defect the resolver sits on: the cache indexed only by device_id and getAllEntities() rebuilt its answer from that index, so helpers, scripts, scenes and automations did not exist. Every leg above passes with this broken, because they inject their own registry');

        check('leg 18 — and the by-device index still excludes them',
            !(indexed.byHaDeviceId.get(undefined) || indexed.byHaDeviceId.get(null)),
            `keys=${JSON.stringify([...indexed.byHaDeviceId.keys()])}`,
            'the two views are deliberately different — getEntitiesForHaDevice must not start returning device-less entities under a null key, which is what a careless "just include everything" fix would do');
    }
}

console.log('');
if (failed) {
    console.error(`❌ ${failed} case(s) failed`);
    process.exit(1);
}
console.log('✅ 18 cases pass — targets resolve before they are judged, the cache keeps the device-less half, and a broken registry refuses under its own name');
