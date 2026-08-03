// SPDX-License-Identifier: AGPL-3.0-only
// server/ha-worker.js
// Polls HA /api/states every POLL_INTERVAL_MS, builds per-device metrics, and upserts
// to Supabase via the `update_device_metrics` edge-fn op. Also exposes triggerRefresh()
// so the HTTP layer can do an on-demand poll when a Console refresh broadcast fires.
//
// Design notes:
//  - Non-fatal. If HA is unreachable, the user isn't signed in, or the edge-fn isn't
//    deployed yet, we log and keep looping. The worker never crashes the add-on.
//  - Single-flight: overlapping polls coalesce (if a poll is already in flight when a
//    new tick or on-demand trigger arrives, we note it and run one more poll after).

const haClient = require('./ha-client');
const haMetrics = require('./ha-metrics');
const haRegistry = require('./ha-registry');
const auth = require('./auth');
const { CLOUD } = require('./config');

// Worker polls HA every POLL_INTERVAL_MS but only upserts to Supabase every
// CLOUD_UPSERT_INTERVAL_MS. The faster local poll keeps lastRun fresh so
// the Console (which reads /api/ha/status frequently) sees near-live presence
// values without hammering Supabase.
const POLL_INTERVAL_MS = 5 * 1000;
const CLOUD_UPSERT_INTERVAL_MS = 30 * 1000;
let lastUpsertAt = 0;
// Metrics upserts go to the database-operations edge fn (where the device handlers live);
// auth.js still talks to jwt-auth for login/refresh.
const DB_OPS_URL = CLOUD.url + '/functions/v1/database-operations';

let timer = null;
let inFlight = false;
let queued = false;
let lastRun = null;       // { at, devices, ok, error? }
let started = false;
let lastSkipReason = null;  // de-dupes noisy skip-log spam
let lastSummaryKey = null;   // de-dupes the per-tick "Poll ok" heartbeat (5s spam)
let lastUnmatchedNames = null;  // de-dupes the per-tick "Unmatched devices" line
let slugByDashieId = {};    // dashie_device_id → HA entity slug (e.g. 'fire_tv', 'rk3576_u')
// dashie_device_id → { role: actual entity_id }. Set on every poll so
// /api/ha/control and the Console history chart can use the real
// entity_id instead of reconstructing <domain>.<slug>_<role>, which
// breaks for partial-migration devices whose sibling entity_ids stuck
// at the pre-rename slug (e.g. Kitchen 15" / Mio 15", where the worker
// can still bucket sensors via role-suffix fallback but the
// reconstructed entity_id 404s in HA).
let entityIdsByDashieId = {};

function logSkip(reason) {
    if (reason === lastSkipReason) return;
    lastSkipReason = reason;
    console.log(`[ha-worker] Skipping poll: ${reason}`);
}

/** Call a database-operations op with the user's JWT. Throws on HTTP error. */
async function callDbOp(operation, data, jwt) {
    const resp = await fetch(DB_OPS_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${jwt}`,
            'apikey': CLOUD.anonKey,
        },
        body: JSON.stringify({ operation, data }),
    });
    const body = await resp.text();
    if (!resp.ok) {
        throw new Error(`${operation} HTTP ${resp.status}: ${body.slice(0, 400)}`);
    }
    try { return JSON.parse(body); } catch { return { raw: body }; }
}

/** Run one poll cycle: fetch states → build metrics → upsert. */
async function runPoll(reason = 'tick') {
    if (inFlight) {
        queued = true;
        console.log(`[ha-worker] Poll already in flight (${reason}); queued follow-up.`);
        return;
    }
    inFlight = true;
    const startedAt = Date.now();
    try {
        if (!haClient.isAvailable()) {
            lastRun = { at: new Date().toISOString(), ok: false, skipped: 'ha_not_configured' };
            logSkip('HA not configured (no SUPERVISOR_TOKEN and no DASHIE_HA_URL+TOKEN)');
            return;
        }

        // 🔴 THE ACCOUNT IS NEEDED FOR THE UPSERT, NOT FOR THE POLL.
        //
        // This used to bail here, before getStates(), the registry read and
        // buildDeviceMetrics — so on a box with no Dashie account the worker
        // produced NOTHING, `freshDevices` was never populated, and the Console's
        // Devices page had no local data at all. On the account-less edition that
        // is the DEFAULT page, so the product's first screen was permanently
        // "No devices registered yet."
        //
        // Everything below except the upsert reads Home Assistant and needs no
        // account: `jwtStored` is used at exactly ONE site (the callDbOp below).
        // So the JWT is fetched, but a failure only disables the CLOUD half.
        //
        // Deliberately NOT restructured beyond moving the bail: the authenticated
        // path runs the same code in the same order it always has, because a
        // subtle change here would fail QUIET — a Dashie box would keep polling
        // and silently stop upserting, and nothing on the box would say so.
        let jwtStored = null;
        let authError = null;
        try {
            jwtStored = await auth.getValidJwt();
        } catch (e) {
            authError = e;
            logSkip('Not authenticated — local device data still built; cloud upsert skipped until sign-in');
        }

        const states = await haClient.getStates();
        // Pull HA's entity_registry so we group entities by HA device_id (the
        // integration's source of truth) instead of slug-matching. Falls back
        // to slug-based grouping if the WS isn't available.
        let entityRegistry = null;
        if (haRegistry.isAvailable()) {
            try {
                entityRegistry = await haRegistry.getAllEntities();
            } catch (e) {
                console.warn(`[ha-worker] entity_registry fetch failed; falling back to slug grouping: ${e.message}`);
            }
        }
        const devices = haMetrics.buildDeviceMetrics(states, entityRegistry);
        // Refresh slug + entity-id maps so /api/ha/control can resolve
        // entity_ids by Dashie device_id. entity_ids is the authoritative
        // source — slug stays around as a fallback for devices the
        // current poll didn't yet bucket.
        const newSlugMap = {};
        const newEntityIdMap = {};
        for (const d of devices) {
            if (d.dashieDeviceId && d.slug) newSlugMap[d.dashieDeviceId] = d.slug;
            if (d.dashieDeviceId && d.entityIdsByRole) {
                newEntityIdMap[d.dashieDeviceId] = d.entityIdsByRole;
            }
        }
        slugByDashieId = newSlugMap;
        entityIdsByDashieId = newEntityIdMap;

        if (devices.length === 0) {
            lastRun = {
                at: new Date().toISOString(),
                ok: true,
                devices: 0,
                note: 'no_dashie_entities',
                durationMs: Date.now() - startedAt,
            };
            console.log('[ha-worker] No Dashie entities found in HA.');
            return;
        }

        // Always update freshDevices (in-memory only) so Console can pull
        // near-live presence/state via /api/ha/status without waiting for the
        // next Supabase upsert.
        const freshDevices = devices.map(d => ({
            device_id: d.dashieDeviceId,
            device_name: d.deviceName,
            slug: d.slug,
            metrics: d.metrics,
            // role → resolved entity_id. Console reads from here for
            // history-chart deep links so partial-migration devices
            // (whose entity_id slug doesn't match the anchor slug)
            // still address the right HA entity.
            entity_ids: d.entityIdsByRole || {},
            has_live_data: d.hasLiveData,
        }));

        // Throttle Supabase upserts to avoid hammering the DB. The fast in-memory
        // poll runs every POLL_INTERVAL_MS (5s); upserts run every CLOUD_UPSERT_INTERVAL_MS (30s).
        const now = Date.now();
        // No account ⇒ nothing to upsert TO. Report it as its own state rather
        // than as an error: on the account-less edition this is the steady,
        // correct condition, and a box that logged a failure every poll would
        // train its owner to ignore the log. `freshDevices` is populated above,
        // which is the whole point — the local surface works, the cloud one is
        // simply absent.
        if (!jwtStored) {
            lastRun = {
                at: new Date().toISOString(),
                ok: true,
                devices: devices.length,
                live: devices.filter(d => d.hasLiveData).length,
                durationMs: Date.now() - startedAt,
                freshDevices,
                upsertSkipped: 'no_account',
                ...(authError ? { authNote: authError.message } : {}),
            };
            return;
        }
        const shouldUpsert = (now - lastUpsertAt) >= CLOUD_UPSERT_INTERVAL_MS || reason === 'startup';
        if (!shouldUpsert) {
            lastRun = {
                at: new Date().toISOString(),
                ok: true,
                devices: devices.length,
                live: devices.filter(d => d.hasLiveData).length,
                durationMs: Date.now() - startedAt,
                upsertResult: lastRun?.upsertResult,
                freshDevices,
                upsertSkipped: 'throttled',
            };
            return;
        }
        lastUpsertAt = now;

        // Upsert metrics via database-operations edge fn. Tolerant of the op not being
        // deployed yet (logs once, keeps looping).
        let upsertResult = null;
        try {
            upsertResult = await callDbOp('update_device_metrics', {
                devices: devices.map(d => ({
                    device_id: d.dashieDeviceId,
                    device_name: d.deviceName,        // anchor friendly_name minus " Device ID"
                    ha_device_name: d.deviceName,     // same source; sent so the edge fn / Console can detect collisions
                    ha_slug: d.slug,                  // entity_id slug (e.g. 'fire_tv') so Console can deep-link to HA
                    metrics: d.metrics,
                    has_live_data: d.hasLiveData,
                })),
            }, jwtStored.jwt);
        } catch (e) {
            lastRun = {
                at: new Date().toISOString(),
                ok: false,
                devices: devices.length,
                error: e.message,
                durationMs: Date.now() - startedAt,
            };
            if (e.message.includes('HTTP 404') || e.message.toLowerCase().includes('unknown operation')) {
                console.warn(`[ha-worker] Edge-fn update_device_metrics not deployed yet — built ${devices.length} device record(s) but skipped upsert.`);
            } else {
                console.warn(`[ha-worker] Upsert failed: ${e.message}`);
            }
            return;
        }

        const updated = upsertResult?.updated ?? 0;
        const unmatched = upsertResult?.unmatched?.length ?? 0;
        const skippedNoId = upsertResult?.skipped?.length ?? 0;
        lastRun = {
            at: new Date().toISOString(),
            ok: true,
            devices: devices.length,
            live: devices.filter(d => d.hasLiveData).length,
            updated,
            unmatched,
            skippedNoId,
            durationMs: Date.now() - startedAt,
            upsertResult,
            freshDevices,
        };
        // Heartbeat de-spam: a 5s tick loop logged this every poll. Log only when something
        // notable happens — a real upsert, a non-tick (on-demand) poll, or a change in the
        // steady-state counts — so the log stays useful without a per-tick flood.
        const summaryKey = `${devices.length}/${lastRun.live}/${updated}/${unmatched}/${skippedNoId}`;
        if (updated > 0 || reason !== 'tick' || summaryKey !== lastSummaryKey) {
            console.log(`[ha-worker] Poll ok (${reason}): ${devices.length} device(s), ${lastRun.live} live → ${updated} upserted, ${unmatched} unmatched, ${skippedNoId} no-id, ${lastRun.durationMs}ms`);
            lastSummaryKey = summaryKey;
        }
        if (unmatched > 0) {
            const names = upsertResult.unmatched.map(u => u.device_name).join(', ');
            if (names !== lastUnmatchedNames) {
                console.log(`[ha-worker] Unmatched devices (not claimed into this account): ${names}`);
                lastUnmatchedNames = names;
            }
        } else {
            lastUnmatchedNames = null;  // reset so a later unmatched re-logs
        }
        lastSkipReason = null;  // reset so next skip (if any) re-logs
    } catch (e) {
        lastRun = {
            at: new Date().toISOString(),
            ok: false,
            error: e.message,
            durationMs: Date.now() - startedAt,
        };
        console.warn(`[ha-worker] Poll failed: ${e.message}`);
    } finally {
        inFlight = false;
        if (queued) {
            queued = false;
            // Defer one tick so a rapid burst of triggers doesn't hammer the loop.
            setImmediate(() => runPoll('queued'));
        }
    }
}

function start() {
    if (started) return;
    started = true;
    console.log(`[ha-worker] Starting — interval ${POLL_INTERVAL_MS / 1000}s, HA ${haClient.isAvailable() ? 'configured' : 'NOT configured (worker will idle)'}.`);
    // Kick off one poll soon after start so we don't wait a full interval for first data.
    setTimeout(() => runPoll('startup'), 3000);
    timer = setInterval(() => runPoll('tick'), POLL_INTERVAL_MS);
    if (timer.unref) timer.unref();
}

function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    started = false;
}

/** On-demand poll. Safe to call concurrently — coalesces. */
function triggerRefresh(reason = 'on-demand') {
    return runPoll(reason);
}

function getStatus() {
    return {
        started,
        inFlight,
        queued,
        intervalMs: POLL_INTERVAL_MS,
        lastRun,
        haAvailable: haClient.isAvailable(),
    };
}

function getSlugForDevice(dashieDeviceId) {
    return slugByDashieId[dashieDeviceId] || null;
}

/** Resolved entity_id for a device's role (battery/ram_usage/screen/lock/...).
 *  Returns null when the worker hasn't seen the device yet OR the device's
 *  HA entity for that role doesn't exist. Callers should fall back to the
 *  legacy <domain>.<slug>_<role> reconstruction when null, to stay
 *  compatible during the period before a poll has populated the map. */
function getEntityIdForRole(dashieDeviceId, role) {
    return entityIdsByDashieId[dashieDeviceId]?.[role] || null;
}

/** Dump what the worker saw for one device on a fresh poll. See
 *  api/ha.js GET /debug-device-metrics for the response shape. */
async function debugDeviceMetrics(dashieDeviceId) {
    const states = await haClient.getStates();
    let entityRegistry = null;
    if (haRegistry.isAvailable()) {
        try { entityRegistry = await haRegistry.getAllEntities(); } catch (e) { /* fall through */ }
    }
    if (!entityRegistry || entityRegistry.length === 0) {
        return { error: 'entity_registry unavailable — cannot debug' };
    }

    // Find anchor for this dashieDeviceId by walking states for a _device_id
    // sensor whose STATE equals the requested id (mirrors the worker's lookup).
    const anchor = states.find(s =>
        s.entity_id.endsWith('_device_id')
        && (s.attributes?.friendly_name || '').endsWith(' Device ID')
        && s.state === dashieDeviceId
    );
    if (!anchor) return null;

    const regByEntityId = {};
    for (const e of entityRegistry) regByEntityId[e.entity_id] = e;
    const anchorEntry = regByEntityId[anchor.entity_id];
    if (!anchorEntry?.device_id) return { error: 'anchor entity has no device_id in registry' };
    const haDeviceId = anchorEntry.device_id;

    const deviceEntities = entityRegistry.filter(e => e.device_id === haDeviceId);
    const stateById = {};
    for (const s of states) stateById[s.entity_id] = s;
    const slug = (anchor.entity_id.split('.')[1] || '').replace(/_device_id$/, '');

    const entities = deviceEntities.map(e => {
        const prefix = `${dashieDeviceId}_`;
        const roleByUid = (e.unique_id && e.unique_id.startsWith(prefix))
            ? e.unique_id.slice(prefix.length) : null;
        const roleBySlug = (e.entity_id.includes('.' + slug + '_'))
            ? e.entity_id.split('.' + slug + '_').slice(1).join('.' + slug + '_') : null;
        return {
            entity_id: e.entity_id,
            unique_id: e.unique_id,
            parsedRole: roleByUid || roleBySlug,
            roleSource: roleByUid ? 'unique_id' : (roleBySlug ? 'entity_id_slug' : null),
            hasState: !!stateById[e.entity_id],
            state: stateById[e.entity_id]?.state ?? null,
        };
    });

    const haMetrics = require('./ha-metrics');
    const metricRoles = Object.keys(haMetrics.METRIC_MAP || {});
    const allRoles = new Set(entities.map(e => e.parsedRole).filter(Boolean));
    const matchedRoles = [...allRoles].filter(r => metricRoles.includes(r)).sort();
    const skippedRoles = [...allRoles].filter(r => !metricRoles.includes(r)).sort();
    const noRoleEntities = entities.filter(e => !e.parsedRole).map(e => e.entity_id);

    return {
        dashieDeviceId,
        haDeviceId,
        anchor: { entity_id: anchor.entity_id, state: anchor.state },
        slug,
        entityCount: entities.length,
        matchedRoles,           // roles METRIC_MAP knows about → end up in metrics
        skippedRoles,           // roles parsed but METRIC_MAP doesn't handle
        noRoleEntities,         // unique_id + entity_id slug both failed to yield a role
        entities,
    };
}

module.exports = { start, stop, triggerRefresh, getStatus, getSlugForDevice, getEntityIdForRole, debugDeviceMetrics };
