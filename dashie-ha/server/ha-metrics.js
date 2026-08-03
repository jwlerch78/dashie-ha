// SPDX-License-Identifier: AGPL-3.0-only
// server/ha-metrics.js
// Pure functions for turning raw HA /api/states output into per-Dashie-device
// metrics JSONB blobs. No I/O — the worker and the test script both import this.
//
// Strategy:
//   1. Find "anchors": every entity matching /_device_id$/ with friendly_name ending
//      " Device ID". Each anchor IS one Dashie device in the HA integration.
//   2. For each anchor derive the slug (e.g. `sensor.fire_tv_device_id` → `fire_tv`).
//   3. Collect all entities across HA domains (sensor, binary_sensor, button, switch,
//      number, select, text, media_player, image, camera) whose name matches
//      `<slug>_<role>` where role is the entity_id suffix (battery, ram_usage, ...).
//   4. Route each matched entity through METRIC_MAP (keyed by role) to build JSONB.
//   5. Sanitize "unavailable"/"unknown" to null.
//
// Why anchor on _device_id instead of friendly_name: the Dashie HA integration does
// NOT put "Dashie" in every device's friendly_name — only some of them do (e.g.,
// "Mio 15\" Dashie"). But every device has a `sensor.<slug>_device_id` — that's the
// reliable integration fingerprint.

// Map entity_id role suffix → JSONB fragment. Deep-merged per device.
// Roles are derived from the entity_id, e.g. `sensor.fire_tv_battery` → "battery".
const METRIC_MAP = {
    'battery':            s => ({ battery: { level: toNum(s.state), plugged: !!s.attributes.plugged } }),
    'plugged_in':         s => ({ battery: {
        charging:    s.state === 'on',
        plug_source: s.attributes.plug_source ?? null,
    }}),
    'ram_usage':          s => ({ system: {
        ram_used_percent: toNum(s.state),
        ram_total_mb:     s.attributes.total_mb ?? null,
        ram_available_mb: s.attributes.available_mb ?? null,
        app_pss_mb:       s.attributes.app_pss_mb ?? null,
    }}),
    'wifi_signal':        s => ({ network: {
        wifi_signal_percent: toNum(s.state),
        wifi_ssid:           s.attributes.ssid ?? null,
        ip_address:          s.attributes.ip_address ?? null,
        mac_address:         s.attributes.mac_address ?? null,
    }}),
    'storage_free':       s => ({ storage: {
        free_gb:  toNum(s.state),
        total_gb: s.attributes.total_gb ?? null,
    }}),
    'android_version':    s => ({ app: {
        android_version:     s.state,
        device_model:        s.attributes.device_model ?? null,
        device_manufacturer: s.attributes.device_manufacturer ?? null,
    }}),
    'app_version':        s => ({ app: {
        app_version:  s.state,
        version_code: s.attributes.version_code ?? null,
    }}),
    'current_page':       s => ({ app: { current_page: s.state } }),
    'screensaver_active': s => ({ screensaver: { active: s.state === 'on' } }),
    // motion / face binary sensors. The *_active flag tracks whether detection
    // is actually running on the device — driven by whether HA reports the
    // sensor as unavailable (= toggle off, no scanning) vs on/off (= scanning,
    // currently triggered or clear). Today both paths (integration poll +
    // MQTT push) always report on/off, so *_active is always true. When the
    // Android app starts emitting unavailable when the detection toggle is
    // off, the Console will pick it up automatically and show the slash.
    'motion_detected':    s => ({ presence: {
        motion: s.state === 'on',
        motion_active: s.state !== 'unavailable' && s.state !== 'unknown' && s.state != null,
    }}),
    'face_detected':      s => ({ presence: {
        face: s.state === 'on',
        face_active: s.state !== 'unavailable' && s.state !== 'unknown' && s.state != null,
    }}),
    'ambient_light':      s => ({ environment: { ambient_light: toNum(s.state) } }),
    // Toggleable controls (state mirrored so the Console can render their current value)
    'lock':               s => ({ controls: { lock: s.state === 'on' } }),
    'screen':             s => ({ controls: { screen: s.state === 'on' } }),
    'screensaver':        s => ({ controls: { screensaver: s.state === 'on' } }),
    'dark_mode':          s => ({ controls: { dark_mode: s.state === 'on' } }),
    'keep_screen_on':     s => ({ controls: { keep_screen_on: s.state === 'on' } }),
    'auto_brightness':    s => ({ controls: { auto_brightness: s.state === 'on' } }),
    // camera_stream_url state is the rtsp://… URL when streaming, null when
    // not currently streaming. NOT a reliable hardware-presence signal —
    // turning the camera off zeroes it out. Use camera_resolution for that.
    'camera_stream_url':  s => ({ controls: {
        camera_stream_url: (s.state && s.state !== 'unavailable' && s.state !== 'unknown') ? s.state : null,
    }}),
    // camera_resolution / camera_frame_rate come from the device's
    // getRtspConfig API and reflect hardware capability — they're populated
    // for devices with a real camera regardless of streaming state, and stay
    // null/unavailable for devices without one. This is what the Console
    // gates the camera column on.
    'camera_resolution':  s => ({ controls: {
        camera_resolution: (s.state && s.state !== 'unavailable' && s.state !== 'unknown') ? s.state : null,
    }}),
    'camera_frame_rate':  s => ({ controls: {
        camera_frame_rate: (s.state && s.state !== 'unavailable' && s.state !== 'unknown') ? Number(s.state) : null,
    }}),
    // The camera entity itself — state is 'streaming' / 'idle' / 'unavailable'.
    // Authoritative signal for "is the camera currently producing frames"
    // (more reliable than reading the switch state — which has unique_id
    // 'rtsp_stream' on some devices and 'camera_stream_enabled' on others).
    'camera':             s => ({ controls: { camera_streaming: s.state === 'streaming' } }),
    // Legacy unique_id alias: the integration uses 'rtsp_stream' as the
    // unique_id role for the camera-on/off switch on some devices.
    'rtsp_stream':        s => ({ controls: { camera_stream_enabled: s.state === 'on' } }),
    'volume':             s => ({ controls: {
        volume:     toNum(s.state),
        volume_max: toNum(s.attributes?.max),
    }}),
    'brightness':         s => ({ controls: {
        brightness:     toNum(s.state),
        brightness_max: toNum(s.attributes?.max),
    }}),
    // The Dashie HA integration registers the brightness number entity with
    // unique_id "<device_id>_brightness_control" (see custom_components/
    // dashie/number.py DashieBrightnessNumber._attr_unique_id). Alias the
    // role so the brightness chip lights up on cards again — without this
    // the unique_id prefix matched but the role string didn't, so HA was
    // exposing the entity yet the Console card was empty.
    'brightness_control': s => ({ controls: {
        brightness:     toNum(s.state),
        brightness_max: toNum(s.attributes?.max),
    }}),
    // media_player.<slug>_speaker — only matches when integration uses a slug-aligned name
    // (Fire TV, Samsung); legacy devices may have orphan media_players that don't match.
    'speaker':            s => ({ media: {
        state:  s.state,
        title:  s.attributes?.media_title || null,
        artist: s.attributes?.media_artist || null,
        album:  s.attributes?.media_album_name || null,
    }}),
};

/** Convert HA state string to number; coerce unavailable/unknown/NaN to null. */
function toNum(v) {
    if (v === 'unavailable' || v === 'unknown' || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** Recursively merge source into target (in place). Arrays are replaced, not merged. */
function deepMerge(target, source) {
    for (const [k, v] of Object.entries(source)) {
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            target[k] = deepMerge(target[k] || {}, v);
        } else {
            target[k] = v;
        }
    }
    return target;
}

/** Walk a metrics object and coerce "unavailable"/"unknown" strings to null. */
function sanitizeMetrics(m) {
    if (m == null) return m;
    if (typeof m === 'string') {
        return (m === 'unavailable' || m === 'unknown') ? null : m;
    }
    if (Array.isArray(m)) return m.map(sanitizeMetrics);
    if (typeof m === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(m)) out[k] = sanitizeMetrics(v);
        return out;
    }
    return m;
}

function hasAnyLiveData(metrics) {
    return metrics.battery?.level != null
        || metrics.system?.ram_used_percent != null
        || metrics.network?.wifi_signal_percent != null
        || metrics.app?.app_version != null;
}

/** Parse "<domain>.<name>" → { domain, name }. Returns null on malformed input. */
function splitEntityId(entityId) {
    const dot = entityId.indexOf('.');
    if (dot < 0) return null;
    return { domain: entityId.slice(0, dot), name: entityId.slice(dot + 1) };
}

/** Every state that has `entity_id.endsWith('_device_id')` AND friendly_name ends
 *  in " Device ID" is a Dashie-integration device anchor. */
function findAnchors(states) {
    return states.filter(s => {
        if (!s.entity_id.endsWith('_device_id')) return false;
        const fn = s.attributes?.friendly_name || '';
        return fn.endsWith(' Device ID') || fn === 'Device ID';
    });
}

/**
 * Turn raw HA /api/states output into an array of per-device records.
 *   [{ deviceName, slug, dashieDeviceId, metrics, entityCount, hasLiveData }, ...]
 *
 * If `entityRegistry` (a flat array of HA entity_registry entries with
 * { entity_id, device_id, unique_id }) is provided, group entities by HA's
 * device_id (the integration's source of truth) and parse roles from
 * unique_id (`{dashieDeviceId}_{role}`). This handles tablets whose
 * entity_ids span multiple slug prefixes due to renames or re-registration.
 *
 * Without entityRegistry, falls back to slug-based grouping (legacy path).
 */
function buildDeviceMetrics(states, entityRegistry = null) {
    if (Array.isArray(entityRegistry) && entityRegistry.length > 0) {
        return _buildViaRegistry(states, entityRegistry);
    }
    return _buildViaSlug(states);
}

function _buildViaRegistry(states, entityRegistry) {
    const anchors = findAnchors(states);
    if (anchors.length === 0) return [];

    const stateById = {};
    for (const s of states) stateById[s.entity_id] = s;

    const regByEntityId = {};
    for (const e of entityRegistry) regByEntityId[e.entity_id] = e;

    const entitiesByHaDevice = new Map();
    for (const e of entityRegistry) {
        if (!e.device_id) continue;
        if (!entitiesByHaDevice.has(e.device_id)) entitiesByHaDevice.set(e.device_id, []);
        entitiesByHaDevice.get(e.device_id).push(e);
    }

    const results = [];
    for (const anchor of anchors) {
        const anchorEntry = regByEntityId[anchor.entity_id];
        if (!anchorEntry?.device_id) continue;
        const haDeviceId = anchorEntry.device_id;

        // 🔴 An OFFLINE device must keep its IDENTITY, or it cannot be rendered.
        //
        // The anchor is a sensor whose STATE is the device id, so a powered-off
        // device reports `unavailable` and this used to resolve to null. The
        // device was still pushed into the results — it did not drop out — it
        // just went ANONYMOUS, and every offline device came back keyed `null`:
        // indistinguishable from each other and unusable to any UI that keys by
        // device_id. That is worse than dropping out, because it looks like data.
        //
        // The id is recoverable one field away, and from a source that does not
        // depend on the device being awake: the entity REGISTRY is persistent,
        // and the integration stamps `unique_id = f"{device_id}_device_id"` on
        // this very anchor (dashie/sensor.py). So state answers "is it alive",
        // registry answers "who is it" — and only the first should go away when
        // the device sleeps.
        const liveId = (anchor.state === 'unavailable' || anchor.state === 'unknown' || !anchor.state)
            ? null
            : anchor.state;
        const registryId = typeof anchorEntry.unique_id === 'string' && anchorEntry.unique_id.endsWith('_device_id')
            ? anchorEntry.unique_id.slice(0, -'_device_id'.length)
            : null;
        // Live state wins when present: it is the value this code has always
        // used, so nothing changes for an online device. The registry is a
        // FALLBACK for exactly the offline case, not a new source of truth.
        const dashieDeviceId = liveId || registryId;

        // Slug from anchor entity_id — still useful for the api/ha/control flow
        // (which constructs entity_ids like switch.<slug>_lock).
        const parsed = splitEntityId(anchor.entity_id);
        const slug = parsed ? parsed.name.replace(/_device_id$/, '') : null;

        // All entities belonging to this HA device. Bucket by role parsed
        // from unique_id (`{dashieDeviceId}_{role}`) — robust to entity_id
        // slug variation across rename/re-register.
        const deviceEntities = entitiesByHaDevice.get(haDeviceId) || [];
        const byRole = {};
        const knownRoles = Object.keys(METRIC_MAP);
        for (const entity of deviceEntities) {
            if (entity.entity_id === anchor.entity_id) continue;
            let role = _roleFromUniqueId(entity.unique_id, dashieDeviceId)
                || (parsed && entity.entity_id.startsWith(parsed.domain + '.' + slug + '_')
                    ? entity.entity_id.slice(parsed.domain.length + slug.length + 2)
                    : null);
            // Third fallback for partial migrations: if both the unique_id
            // prefix and the entity_id slug failed (typically because the
            // integration's async_migrate_to_stable_id only ran for SOME
            // entities, leaving siblings with a legacy device_id prefix
            // that doesn't match the anchor's current STATE), match by
            // known role suffix. The entity's HA device_id already binds
            // it to this Dashie device, so there's no cross-device leakage
            // risk — we just need to figure out which METRIC_MAP entry to
            // dispatch through. We prefer the longest matching role so
            // `ram_usage` wins over `ram` if both were ever defined.
            if (!role && entity.entity_id) {
                const tail = entity.entity_id.split('.').slice(1).join('.');
                let best = null;
                for (const r of knownRoles) {
                    if (tail.endsWith('_' + r) || tail === r) {
                        if (!best || r.length > best.length) best = r;
                    }
                }
                role = best;
            }
            if (!role) continue;
            const state = stateById[entity.entity_id];
            if (!state) continue;
            const existing = byRole[role];
            byRole[role] = existing ? pickBetter(existing, state) : state;
        }

        let metrics = {};
        for (const [role, extractor] of Object.entries(METRIC_MAP)) {
            const s = byRole[role];
            if (!s) continue;
            metrics = deepMerge(metrics, extractor(s));
        }
        metrics = sanitizeMetrics(metrics);

        // Real entity_id per role from byRole — what the worker actually
        // resolved via unique_id / slug / role-suffix matching. Surfaces
        // the *resolved* entity_id so Console history charts and the
        // /api/ha/control endpoint can address the entity directly,
        // instead of reconstructing `<domain>.<anchor_slug>_<role>` (which
        // breaks for partial-migration devices whose sibling entities
        // kept their pre-rename entity_id slug). Includes ALL matched
        // roles, not just ones METRIC_MAP knows about — so control
        // switches (lock/screen/etc.) and number entities (brightness/
        // volume) all get an entry too.
        const entityIdsByRole = {};
        for (const [role, s] of Object.entries(byRole)) {
            if (s?.entity_id) entityIdsByRole[role] = s.entity_id;
        }

        const friendlyName = anchor.attributes?.friendly_name || '';
        const deviceName = friendlyName.replace(/ Device ID$/, '').trim() || slug || haDeviceId;

        results.push({
            deviceName,
            slug,
            dashieDeviceId,
            metrics,
            entityIdsByRole,
            entityCount: deviceEntities.length,
            hasLiveData: hasAnyLiveData(metrics),
        });
    }
    results.sort((a, b) => a.deviceName.localeCompare(b.deviceName));
    return results;
}

/** Extract role from unique_id of the form `{dashieDeviceId}_{role}`. */
function _roleFromUniqueId(uniqueId, dashieDeviceId) {
    if (!uniqueId || !dashieDeviceId) return null;
    if (!uniqueId.startsWith(dashieDeviceId + '_')) return null;
    return uniqueId.slice(dashieDeviceId.length + 1);
}

/** Legacy slug-based grouping (kept as fallback when entity_registry isn't available). */
function _buildViaSlug(states) {
    const anchors = findAnchors(states);
    if (anchors.length === 0) return [];

    const anchorSlugs = anchors.map(a => {
        const parsed = splitEntityId(a.entity_id);
        const slug = parsed ? parsed.name.replace(/_device_id$/, '') : null;
        return { anchor: a, slug };
    }).filter(x => x.slug);

    const allSlugs = anchorSlugs.map(x => x.slug);

    const results = [];
    for (const { anchor, slug } of anchorSlugs) {
        const longerSlugs = allSlugs.filter(other => other !== slug && other.startsWith(slug + '_'));
        const siblings = states.filter(s => {
            if (s === anchor) return false;
            const parsed = splitEntityId(s.entity_id);
            if (!parsed) return false;
            if (!parsed.name.startsWith(slug + '_')) return false;
            for (const longer of longerSlugs) {
                if (parsed.name.startsWith(longer + '_') || parsed.name === longer) return false;
            }
            return true;
        });

        const byRole = {};
        for (const s of siblings) {
            const parsed = splitEntityId(s.entity_id);
            const role = parsed.name.slice(slug.length + 1);
            const existing = byRole[role];
            byRole[role] = existing ? pickBetter(existing, s) : s;
        }

        let metrics = {};
        for (const [role, extractor] of Object.entries(METRIC_MAP)) {
            const s = byRole[role];
            if (!s) continue;
            metrics = deepMerge(metrics, extractor(s));
        }
        metrics = sanitizeMetrics(metrics);

        // Parallel structure to the entity-registry path's output —
        // role → resolved entity_id, for control + history-chart use.
        const entityIdsByRole = {};
        for (const [role, s] of Object.entries(byRole)) {
            if (s?.entity_id) entityIdsByRole[role] = s.entity_id;
        }

        const friendlyName = anchor.attributes?.friendly_name || '';
        const deviceName = friendlyName.replace(/ Device ID$/, '').trim() || slug;
        const rawDeviceId = anchor.state;
        const dashieDeviceId = (rawDeviceId === 'unavailable' || rawDeviceId === 'unknown' || !rawDeviceId)
            ? null
            : rawDeviceId;

        results.push({
            deviceName,
            slug,
            dashieDeviceId,
            metrics,
            entityIdsByRole,
            entityCount: siblings.length,
            hasLiveData: hasAnyLiveData(metrics),
        });
    }
    results.sort((a, b) => a.deviceName.localeCompare(b.deviceName));
    return results;
}

/** Prefer a non-unavailable state; tie-break on attribute count. */
function pickBetter(a, b) {
    const aAvail = a.state !== 'unavailable' && a.state !== 'unknown';
    const bAvail = b.state !== 'unavailable' && b.state !== 'unknown';
    if (aAvail !== bAvail) return aAvail ? a : b;
    return Object.keys(a.attributes || {}).length >= Object.keys(b.attributes || {}).length ? a : b;
}

module.exports = {
    METRIC_MAP,
    findAnchors,
    buildDeviceMetrics,
    pickBetter,
    sanitizeMetrics,
    hasAnyLiveData,
    deepMerge,
};
