// SPDX-License-Identifier: AGPL-3.0-only
// ha-registry.js — THE Home Assistant WebSocket client for this add-on.
//
// ⚠️ There must be exactly ONE of these in the process. It owns a single
// authenticated socket to HA core, with its own reconnect loop. Adding a second
// WS client (as existed until 2026-07-31, when `ha-ws.js` was a slimmed copy of
// this file) means two sockets, two auth handshakes and two independent
// reconnect storms every time core restarts. If you need a new WS command, add
// a wrapper HERE — do not start another client.
//
// Why WebSocket and not REST: several surfaces exist only on the WS API —
// `config/device_registry/{list,update}`, `config/entity_registry/list`,
// `tts/engine/{list,voices}`, `stt/engine/list`, `config_entries/flow/progress`.
// REST-only surfaces (states, history, service calls) live in ha-client.js;
// the Supervisor API (add-on self-config, core restart) lives in supervisor.js.
//
// Auto-detects supervisor vs local-LLAT mode (same env vars as ha-client.js).
//
// Public surface, by consumer:
//   voice-engines.js  listTtsEngines / getTtsVoices / listSttEngines / getHaConfig
//   lan-discovery.js  getHaConfig / getStates
//   supervisor.js     listConfigFlowsInProgress
//   (device mgmt)     getDeviceByDashieId / renameDevice / getEntitiesForHaDevice /
//                     getAllEntities / getCameraStreamUrl / getDefaultDashboardPath /
//                     subscribeStateChanged / callService / refresh
//
// Tolerant: throws on hard errors but callers should catch and log; the worker
// keeps polling regardless.

const WebSocket = require('ws');

const REQUEST_TIMEOUT_MS = 8000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

let ws = null;
let connectionPromise = null;       // resolves when authed; rejects on auth fail
let nextMsgId = 1;
const pending = new Map();          // id → { resolve, reject, timer }
const eventHandlers = new Map();    // subscription id → handler(eventBody)
const stateChangeListeners = new Set();
let stateChangedSubId = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let registryCache = null;           // { byDashieId: Map, byHaId: Map, fetchedAt }
let entityRegistryCache = null;     // { byHaDeviceId: Map<haDeviceId, entity[]>, all: entity[], fetchedAt }
let stopped = false;

function getWsConfig() {
    if (process.env.SUPERVISOR_TOKEN) {
        return {
            url: 'ws://supervisor/core/api/websocket',
            token: process.env.SUPERVISOR_TOKEN,
            mode: 'supervisor',
        };
    }
    if (process.env.DASHIE_HA_URL && process.env.DASHIE_HA_TOKEN) {
        const wsUrl = process.env.DASHIE_HA_URL
            .replace(/\/$/, '')
            .replace(/^https?:/, m => m === 'https:' ? 'wss:' : 'ws:')
            + '/api/websocket';
        return {
            url: wsUrl,
            token: process.env.DASHIE_HA_TOKEN,
            mode: 'dev-llat',
        };
    }
    return null;
}

function isAvailable() {
    return getWsConfig() !== null;
}

function _connect() {
    if (connectionPromise) return connectionPromise;
    const config = getWsConfig();
    if (!config) return Promise.reject(new Error('HA WS not configured'));

    connectionPromise = new Promise((resolve, reject) => {
        let authResolved = false;
        const sock = new WebSocket(config.url);
        ws = sock;

        sock.on('open', () => {
            // HA sends `auth_required` first; we'll respond on first message.
        });

        sock.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }

            if (msg.type === 'auth_required') {
                sock.send(JSON.stringify({ type: 'auth', access_token: config.token }));
                return;
            }
            if (msg.type === 'auth_ok') {
                authResolved = true;
                reconnectAttempts = 0;
                console.log(`[ha-registry] WebSocket authed (${config.mode})`);
                resolve();
                return;
            }
            if (msg.type === 'auth_invalid') {
                authResolved = true;
                reject(new Error('HA WS auth_invalid: ' + (msg.message || 'token rejected')));
                sock.close();
                return;
            }
            // Subscribed events arrive as type:'event' with the original subscribe id.
            if (msg.type === 'event' && msg.id != null && eventHandlers.has(msg.id)) {
                const handler = eventHandlers.get(msg.id);
                try { handler(msg.event); } catch (e) { console.warn('[ha-registry] event handler threw:', e.message); }
                return;
            }
            if (msg.id != null && pending.has(msg.id)) {
                const { resolve: r, reject: rj, timer } = pending.get(msg.id);
                clearTimeout(timer);
                pending.delete(msg.id);
                if (msg.type === 'result') {
                    if (msg.success) r(msg.result);
                    else rj(new Error(msg.error?.message || 'HA WS command failed'));
                } else {
                    // event/other types: shouldn't happen for our commands
                    r(msg);
                }
            }
        });

        sock.on('close', () => {
            ws = null;
            connectionPromise = null;
            // Reject any in-flight commands
            for (const [, { reject: rj, timer }] of pending) {
                clearTimeout(timer);
                rj(new Error('HA WS closed'));
            }
            pending.clear();
            // Drop the subscription id so listeners get re-subscribed on next connect.
            if (stateChangedSubId !== null) eventHandlers.delete(stateChangedSubId);
            stateChangedSubId = null;
            if (!authResolved) reject(new Error('HA WS closed before auth'));
            if (!stopped) {
                _scheduleReconnect();
                // After reconnect, re-establish state_changed subscription if anyone wants it.
                if (stateChangeListeners.size > 0) {
                    setTimeout(() => _ensureStateChangedSubscription().catch(() => {}), 3000);
                }
            }
        });

        sock.on('error', (err) => {
            console.warn('[ha-registry] WS error:', err.message);
            if (!authResolved) reject(err);
        });
    }).catch(e => {
        // Reset for retry. Caller sees the rejection.
        connectionPromise = null;
        throw e;
    });

    return connectionPromise;
}

function _scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
    reconnectAttempts++;
    console.log(`[ha-registry] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        _connect().catch(() => { /* will reschedule via close */ });
    }, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
}

function _send(payload) {
    return _connect().then(() => new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return reject(new Error('HA WS not open'));
        }
        const id = nextMsgId++;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`HA WS request ${id} timed out`));
        }, REQUEST_TIMEOUT_MS);
        if (timer.unref) timer.unref();
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, ...payload }));
    }));
}

async function _refreshRegistryCache() {
    const list = await _send({ type: 'config/device_registry/list' });
    const byDashieId = new Map();
    const byHaId = new Map();
    for (const entry of list) {
        byHaId.set(entry.id, entry);
        // identifiers is an array of [domain, id] tuples; the Dashie integration
        // uses domain "dashie" with the device_id as the second element.
        for (const ident of entry.identifiers || []) {
            if (Array.isArray(ident) && ident[0] === 'dashie' && ident[1]) {
                byDashieId.set(ident[1], entry);
            }
        }
    }
    registryCache = { byDashieId, byHaId, fetchedAt: Date.now() };
    return registryCache;
}

/** Returns the registry entry (with id, name, name_by_user, identifiers, ...) or null.
 *
 *  Two-path lookup:
 *    1. By `identifiers` tuple `("dashie", <id>)` — works when the Dashie
 *       integration's DeviceInfo identifier equals the id we're searching by.
 *    2. By the device-id sensor's STATE — the worker reports anchor.state as
 *       the dashie device_id, but the integration sets the device-registry
 *       identifier from `stableDeviceID` (preferred) while the sensor still
 *       returns `deviceID` (legacy). For installs where the two diverge,
 *       falling through to a state-based lookup keeps adopt working without
 *       requiring the integration to be patched and existing user_devices
 *       rows to be re-migrated. */
async function getDeviceByDashieId(dashieDeviceId, { force = false } = {}) {
    if (!dashieDeviceId) return null;
    if (force || !registryCache) await _refreshRegistryCache();
    let entry = registryCache.byDashieId.get(dashieDeviceId);
    if (!entry && !force) {
        // Stale cache (device was just added/migrated) — refresh once and retry
        await _refreshRegistryCache();
        entry = registryCache.byDashieId.get(dashieDeviceId);
    }
    if (entry) return entry;

    // Fallback: find the device-id sensor whose STATE matches dashieDeviceId,
    // then follow its `device_id` back to the registry. The sensor entity_id
    // ends in `_device_id` by convention (DashieDeviceIdSensor sets
    // _attr_unique_id = f"{device_id}_device_id"). We fetch /api/states once
    // and walk the small set of `sensor.*_device_id` entries — cheap.
    try {
        // Use the WS connection we already have rather than haClient (REST)
        // to avoid an extra dependency in this module.
        const states = await _send({ type: 'get_states' });
        const sensorMatch = (states || []).find(s =>
            typeof s?.entity_id === 'string'
            && s.entity_id.startsWith('sensor.')
            && s.entity_id.endsWith('_device_id')
            && s.state === dashieDeviceId
        );
        if (sensorMatch) {
            if (force || !entityRegistryCache) await _refreshEntityRegistryCache();
            // entityRegistryCache is indexed byHaDeviceId; walk it to find
            // the entity with this entity_id (its `device_id` is the HA id).
            for (const entities of entityRegistryCache.byHaDeviceId.values()) {
                for (const e of entities) {
                    if (e?.entity_id === sensorMatch.entity_id && e?.device_id) {
                        const reg = registryCache.byHaId.get(e.device_id);
                        if (reg) return reg;
                    }
                }
            }
        }
    } catch (e) {
        console.warn('[ha-registry] state-fallback lookup failed:', e.message);
    }
    return null;
}

/**
 * Set the user-facing name (`name_by_user`) for the device matching this Dashie
 * device_id. Returns the updated registry entry, or throws on failure.
 */
async function renameDevice(dashieDeviceId, newName) {
    const entry = await getDeviceByDashieId(dashieDeviceId);
    if (!entry) {
        throw new Error(`No HA device_registry entry found for Dashie device_id ${dashieDeviceId}`);
    }
    const updated = await _send({
        type: 'config/device_registry/update',
        device_id: entry.id,
        name_by_user: newName,
    });
    // Invalidate so subsequent reads see the new name.
    registryCache = null;
    return updated;
}

/**
 * Subscribe to HA's state_changed events. The first call sends the actual WS
 * subscribe message; subsequent callers piggyback on the same subscription.
 * Returns an unsubscribe function for the caller's slot.
 *
 * Re-establishes the subscription automatically after a WS reconnect, so
 * callers don't need to re-subscribe.
 */
async function subscribeStateChanged(callback) {
    stateChangeListeners.add(callback);
    await _ensureStateChangedSubscription();
    return () => stateChangeListeners.delete(callback);
}

async function _ensureStateChangedSubscription() {
    if (stateChangedSubId !== null) return;
    await _connect();
    const id = nextMsgId++;
    stateChangedSubId = id;
    eventHandlers.set(id, (event) => {
        for (const cb of stateChangeListeners) {
            try { cb(event); } catch (e) { console.warn('[ha-registry] listener threw:', e.message); }
        }
    });
    ws.send(JSON.stringify({ id, type: 'subscribe_events', event_type: 'state_changed' }));
}

/**
 * Get the HLS playlist URL for a camera entity. HA spins up its stream
 * pipeline (RTSP → HLS via the `stream` integration) and returns a
 * session URL like /api/hls/<token>/master_playlist.m3u8. This is the
 * same call HA's own more-info dialog makes for the camera player.
 */
async function getCameraStreamUrl(entityId, format = 'hls') {
    return _send({ type: 'camera/stream', entity_id: entityId, format });
}

/**
 * Resolve a URL path the user's HA frontend will accept WITHOUT issuing
 * a server-side redirect that strips the query string. Used by the
 * Console's camera modal to iframe HA's own more-info dialog at
 * `<path>?more-info-entity-id=<entity>`.
 *
 * Strategy:
 *   - Ask HA for its lovelace dashboard list (WS `lovelace/dashboards/list`).
 *   - If any dashboard has `url_path: null` (the lone "default" entry on
 *     storage-mode installs), '/lovelace' is the canonical URL.
 *   - Otherwise pick the first dashboard's url_path → `/<url_path>`.
 *   - Cache the result (dashboards rarely change at runtime).
 *
 * Falls back to '/' if HA returns nothing useful. The Console then relies
 * on HA's client-side router to preserve the query string through any
 * default-dashboard hop — which works in iframes even when it didn't in
 * the previous popup approach.
 */
let _defaultDashboardPath = null;
async function getDefaultDashboardPath() {
    if (_defaultDashboardPath) return _defaultDashboardPath;
    try {
        const list = await _send({ type: 'lovelace/dashboards/list' });
        if (Array.isArray(list) && list.length > 0) {
            // url_path === null on the default storage-mode dashboard.
            const def = list.find(d => d?.url_path == null) || list[0];
            if (def?.url_path == null) {
                _defaultDashboardPath = '/lovelace';
            } else if (typeof def.url_path === 'string' && def.url_path.length > 0) {
                _defaultDashboardPath = '/' + def.url_path.replace(/^\//, '');
            }
        }
    } catch (e) {
        console.warn('[ha-registry] dashboards/list failed:', e.message);
    }
    return _defaultDashboardPath || '/';
}

/**
 * Call an HA service (switch.turn_on, number.set_value, button.press, etc.)
 * targeting a specific entity. Returns whatever HA echoes back.
 */
async function callService(domain, service, entityId, serviceData = {}) {
    if (!domain || !service || !entityId) {
        throw new Error('callService requires domain, service, entity_id');
    }
    return _send({
        type: 'call_service',
        domain,
        service,
        target: { entity_id: entityId },
        service_data: serviceData,
    });
}

// ── Voice engine detection (STT/TTS engine-direct, no Assist pipeline) ──
// HA exposes STT/TTS *engines* over WS, independent of any configured Assist
// pipeline. These thin wrappers let the Console detect what the user's HA can
// do (see api/voice-engines.js). The exact command names + response shapes have
// drifted across HA releases — callers must tolerate a reject
// and the probe script (scripts/probe-voice-engines.js) captures raw shapes.

/** List TTS engines. → { providers: [{ engine_id, supported_languages }] } (HA shape). */
async function listTtsEngines() {
    return _send({ type: 'tts/engine/list' });
}

/** Voices for one TTS engine in a language. → { voices: [{ voice_id, name }] }.
 *  HA requires a language; Piper voices are language-specific (confirmed: 26 for
 *  en_US vs 11 for en_GB). Voice ids look like `en_US-amy-medium`. */
async function getTtsVoices(engineId, language) {
    return _send({ type: 'tts/engine/voices', engine_id: engineId, language });
}

/** List STT engines. → { providers: [{ engine_id, supported_languages }] } (HA shape).
 *  Note: stt/engine/get does NOT exist on current HA (unknown_command) — the list
 *  carries everything the Console needs, so there's no per-engine getter. */
async function listSttEngines() {
    return _send({ type: 'stt/engine/list' });
}

/** HA's own config → { language: 'en', country: 'US', … }. Used to narrow the local-TTS
 *  voice list when the account's Dashie language is 'system' (the default): a box's voice
 *  catalog spans ~30 languages, and HA already knows which one this household speaks. */
async function getHaConfig() {
    return _send({ type: 'get_config' });
}

/** Raw HA state list. Used by LAN discovery to read the `ip_address` attribute Dashie
 *  tablets publish on their `*_wifi_signal` sensor — the proxy-proof source of the local
 *  subnet (a device can't misreport its own NIC the way `internal_url` can). */
async function getStates() {
    return _send({ type: 'get_states' });
}

/** In-progress config-flow list — WS-only, no REST equivalent. supervisor.js uses
 *  it to detect a PARKED dashie_voice discovery card (core restarted, the user
 *  never clicked "Configure") so the console banner can absorb that click via
 *  /api/system/configure-integration instead of sending them menu-diving.
 *
 *  Ported from ha-ws.js on 2026-07-31 — it was the ONE command this file lacked,
 *  and the only reason a second WS client still existed. */
async function listConfigFlowsInProgress() {
    return _send({ type: 'config_entries/flow/progress' });
}

/** Force a re-pull of the device registry (e.g., after we know HA changed). */
function refresh() {
    registryCache = null;
    entityRegistryCache = null;
}

/** The indexing half of the entity-registry refresh, split out from the fetch so
 *  it can be DRIVEN without a WebSocket (check-service-targets leg 17). The
 *  device-less omission below survived because nothing could test the cache
 *  without a live HA; a defect whose only witness is production is a defect that
 *  gets re-introduced. Pure — takes a list, returns the cache shape. */
function _indexEntityRegistry(list) {
    const byHaDeviceId = new Map();
    for (const e of list || []) {
        if (!e || !e.device_id) continue;
        const arr = byHaDeviceId.get(e.device_id) || [];
        arr.push(e);
        byHaDeviceId.set(e.device_id, arr);
    }
    // 🔴 `all` is the COMPLETE list; `byHaDeviceId` deliberately is not.
    //
    // Until 2026-08-04 this cache kept only the by-device index, and
    // getAllEntities() rebuilt its answer by walking it — so every entity with no
    // device silently never existed: input_boolean, script, scene, automation,
    // group, template sensors. Those are helpers, which is to say exactly the
    // entities a household creates by hand and then names in a voice command.
    //
    // It was invisible because all three callers immediately filter on
    // `device_id` (and `_buildViaRegistry` re-applies the same filter itself), so
    // the omission changed no answer any of them produced. It stops being
    // invisible the moment something resolves an AREA or a LABEL to its entities
    // — a subset there does not read as an error, it reads as a smaller target
    // set, and every member of it passes whatever check comes next.
    return { byHaDeviceId, all: [...(list || [])] };
}

/** Fetch + cache HA's entity_registry. Used to find image/camera entities
 *  for a device whose entity_ids don't follow the slug_<role> convention
 *  (Fire Tablet, Mio, etc. have legacy entity names), and by the /service
 *  target resolver. */
async function _refreshEntityRegistryCache() {
    const list = await _send({ type: 'config/entity_registry/list' });
    entityRegistryCache = { ..._indexEntityRegistry(list), fetchedAt: Date.now() };
    return entityRegistryCache;
}

/** Returns all entity_registry entries for a HA device id. */
async function getEntitiesForHaDevice(haDeviceId, { force = false } = {}) {
    if (!haDeviceId) return [];
    if (force || !entityRegistryCache) await _refreshEntityRegistryCache();
    let entities = entityRegistryCache.byHaDeviceId.get(haDeviceId) || [];
    if (entities.length === 0 && !force) {
        await _refreshEntityRegistryCache();
        entities = entityRegistryCache.byHaDeviceId.get(haDeviceId) || [];
    }
    return entities;
}

/** Returns the full HA entity_registry as a flat array (cached) — INCLUDING
 *  entities with no device. Used by the worker for per-device metrics (which
 *  filters on device_id itself) and by the /service target resolver, which must
 *  not silently miss the device-less half. See the note in the refresh above. */
async function getAllEntities({ force = false } = {}) {
    if (force || !entityRegistryCache) await _refreshEntityRegistryCache();
    return entityRegistryCache.all || [];
}

/** The HA device_registry as a flat array (cached). The target resolver needs it
 *  for `area_id`: an entity inherits its device's area when it has none of its
 *  own, so resolving an area from the entity registry alone under-counts. */
async function getAllDevices({ force = false } = {}) {
    if (force || !registryCache) await _refreshRegistryCache();
    return [...registryCache.byHaId.values()];
}

function start() {
    if (!isAvailable()) {
        console.log('[ha-registry] Not configured (no SUPERVISOR_TOKEN or DASHIE_HA_URL+TOKEN); rename will be unavailable.');
        return;
    }
    stopped = false;
    _connect().catch(e => console.warn('[ha-registry] Initial connect failed:', e.message));
}

function stop() {
    stopped = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { try { ws.close(); } catch {} }
    ws = null;
    connectionPromise = null;
}

module.exports = {
    isAvailable,
    start,
    stop,
    getDeviceByDashieId,
    getEntitiesForHaDevice,
    getAllEntities,
    getAllDevices,
    _indexEntityRegistry,   // exported for check-service-targets leg 17 only
    getCameraStreamUrl,
    getDefaultDashboardPath,
    subscribeStateChanged,
    renameDevice,
    callService,
    listTtsEngines,
    getTtsVoices,
    listSttEngines,
    getHaConfig,
    getStates,
    listConfigFlowsInProgress,
    refresh,
};
