// SPDX-License-Identifier: AGPL-3.0-only
// server/api/ha.js
// HA-side API endpoints used by the Console — namely renaming devices in
// HA's device_registry from the Console's pencil-edit UI.
//
// Auth: MIXED, per route, and the split is deliberate — see the long rationale
// block above `requireSignedIn` below.
//   - Routes that read or write DASHIE ACCOUNT state (/adopt, and the device-
//     management surfaces the Console's Devices page drives) keep
//     `requireSignedIn`: they use the JWT we minted via device-flow, stored in
//     /data/dashie_ha_auth.json.
//   - Routes that are pure HA operations over the ADD-ON'S OWN HA credential
//     (/status, /history, /refresh, /debug-device-metrics, /entities, /service,
//     /conversation) are open. Their gate is Ingress: HA has already
//     authenticated whoever can reach this panel, and the add-on publishes no
//     host port.

const express = require('express');
const crypto = require('crypto');
const auth = require('../auth');
const haRegistry = require('../ha-registry');
const haWorker = require('../ha-worker');
const haClient = require('../ha-client');
const config = require('../config');

const router = express.Router();

/** GET /api/ha/status — worker poll state. Open (no auth) since the Console
 *  needs it on every render and the frontend is already past Ingress. */
router.get('/status', (req, res) => {
    res.json(haWorker.getStatus());
});

/** GET /api/ha/debug-device-metrics?device_id=<hex>
 *  Diagnostic endpoint — dumps how the worker's metric-matching saw a
 *  specific device on the most recent poll. Returns:
 *    - anchor: the _device_id sensor entity_id + state we keyed on
 *    - haDeviceId: HA's device_registry device_id (the join key)
 *    - entities: [{entity_id, unique_id, parsedRole, hasState}, ...]
 *      — every entity HA's registry says belongs to this device, plus
 *      whether the worker successfully derived a role for it. A role
 *      of null means the entity was skipped (unique_id prefix mismatch
 *      AND entity_id slug mismatch). Common cause: migration to
 *      stable device id left some entities with the legacy prefix.
 *    - matchedRoles: roles that resolved to a METRIC_MAP entry
 *    - skippedRoles: roles the matcher derived but METRIC_MAP doesn't
 *      handle (informational — these don't end up in metrics either)
 *  Used to diagnose "device shows X but not Y in the Console card"
 *  reports — compare matchedRoles against METRIC_MAP keys to find what
 *  HA isn't exposing. */
// No requireSignedIn — diagnostic endpoint that only exposes entity
// registry shape (no secrets), and the user hits it from inside Ingress
// where HA already gatekept access. Keeping it open also avoids the
// silent-401-blank-page failure mode when the Ingress JWT is stale.
router.get('/debug-device-metrics', async (req, res) => {
    const deviceId = req.query.device_id;
    if (!deviceId) return res.status(400).json({ error: 'device_id required' });
    try {
        const result = await haWorker.debugDeviceMetrics(String(deviceId));
        if (!result) return res.status(404).json({ error: 'device_not_found_in_ha' });
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: 'debug_failed', message: e.message });
    }
});

/** POST /api/ha/refresh — kick an on-demand poll. */
router.post('/refresh', (req, res) => {
    haWorker.triggerRefresh('http-trigger');
    res.json({ triggered: true, status: haWorker.getStatus() });
});

/** Quick in-process auth check. The frontend always calls these from inside the
 *  Ingress page, where Supabase JWT is held by the add-on (`/data/dashie_auth.json`).
 *  We don't need per-request JWT verification — just confirm an authed session
 *  exists. Anyone hitting Ingress is already past HA's authentication. */
function requireSignedIn(req, res, next) {
    const stored = auth.readStoredJwt();
    if (!stored) {
        return res.status(401).json({ error: 'add_on_not_signed_in' });
    }
    next();
}

// NO requireSignedIn on /entities, /service or /conversation, deliberately (2026-07-31,
// Step 7). Same finding as api/feeds.js, same reasoning:
//
// Those three are HA-only operations over the add-on's OWN HA credential — getStates()
// (REST), haRegistry.callService() (WS), and a proxy to HA's /api/conversation/process.
// `auth.readStoredJwt()` appears in this file exactly twice: inside the guard itself, and
// inside POST /adopt/:deviceId, which genuinely reads the account (it posts to Dashie's
// database-operations under the stored JWT). /adopt KEEPS its guard. The other three read
// no account state at all.
//
// The page that calls them — Voice & AI's chat — is in FeatureGate.LOCAL_MODE_PAGES, so a
// box with no Dashie account rendered a chat that could not see one entity (the
// providedContext fetch 401'd and was swallowed), could not act (`/service` 401'd), and
// could not hand off to Assist (`/conversation` 401'd). The model said "I turned on the
// kitchen light" and nothing happened.
//
// The gate is INGRESS, and it always was: `requireSignedIn` asks "does this BOX hold a
// Dashie JWT?", a property of the box, not of the caller — two HA users on one box are
// indistinguishable to it. Anyone who can reach this panel is an authenticated HA admin
// who can already call any service from Developer Tools → Actions, read every state, and
// type at Assist. The add-on publishes no host port (config.yaml `ports: {}`).
//
// ⚠️ /service is a GENERIC passthrough (any domain, any service, incl. lock.open and
// alarm_control_panel.disarm) and always was — the guard never constrained it. Narrowing
// it belongs to a domain allowlist (CONTROLLABLE_DOMAINS, ten lines below, already does
// this for /entities), tracked as open hygiene in 20260731_BETA_ORCHESTRATION.md §2b.
//
// If a route here ever needs the ACCOUNT, it must bring its own guard — do not re-blanket.

/**
 * GET /api/ha/history?entity_id=<id>&hours=<n>
 *   — OR —
 * GET /api/ha/history?entity_id=<id>&start_iso=<iso>&end_iso=<iso>
 *
 * Returns a single entity's history as [{state, last_changed}, ...].
 * Default window is 24h. Capped at MAX_HOURS (~3 months) — anything
 * longer is heavy and the chart isn't designed for it.
 *
 * Also returns the current state (with attributes) so the chart derives
 * unit_of_measurement and the current-value badge in one round-trip.
 *
 * Open (no requireSignedIn) — matches /status. Caller is past Ingress.
 */
const HISTORY_MAX_HOURS = 24 * 90; // 90 days
router.get('/history', async (req, res) => {
    const entityId = req.query.entity_id;
    if (!entityId || typeof entityId !== 'string') {
        return res.status(400).json({ error: 'entity_id required' });
    }

    let start, end, hours;
    const startIso = typeof req.query.start_iso === 'string' ? req.query.start_iso : null;
    const endIso = typeof req.query.end_iso === 'string' ? req.query.end_iso : null;
    if (startIso && endIso) {
        const s = Date.parse(startIso);
        const e = Date.parse(endIso);
        if (!Number.isFinite(s) || !Number.isFinite(e) || s >= e) {
            return res.status(400).json({ error: 'invalid start_iso/end_iso' });
        }
        const spanHours = (e - s) / 3600 / 1000;
        if (spanHours > HISTORY_MAX_HOURS) {
            return res.status(400).json({ error: 'range_too_large', max_hours: HISTORY_MAX_HOURS });
        }
        start = new Date(s);
        end = new Date(e);
        hours = spanHours;
    } else {
        const hoursRaw = parseFloat(req.query.hours);
        hours = Number.isFinite(hoursRaw) && hoursRaw > 0
            ? Math.min(hoursRaw, HISTORY_MAX_HOURS)
            : 24;
        end = new Date();
        start = new Date(end.getTime() - hours * 3600 * 1000);
    }

    try {
        const [samples, current] = await Promise.all([
            haClient.getHistory(entityId, start.toISOString(), end.toISOString()),
            haClient.getState(entityId).catch(() => null),
        ]);
        return res.json({
            entity_id: entityId,
            hours,
            start_iso: start.toISOString(),
            end_iso: end.toISOString(),
            unit: current?.attributes?.unit_of_measurement || null,
            friendly_name: current?.attributes?.friendly_name || null,
            current_state: current?.state ?? null,
            samples,
        });
    } catch (e) {
        console.warn(`[api/ha/history] ${entityId} failed:`, e.message);
        return res.status(500).json({ error: 'history_failed', message: e.message });
    }
});

/**
 * POST /api/ha/rename
 * Body: { device_id: '<dashie hex>', new_name: 'Living Room Tablet' }
 * Renames the device in HA's device_registry (sets `name_by_user`).
 * Console is responsible for calling update_device first/separately to
 * also update Supabase — this endpoint only handles the HA side.
 */
router.post('/rename', requireSignedIn, express.json(), async (req, res) => {
    const { device_id, new_name } = req.body || {};
    if (!device_id || typeof device_id !== 'string') {
        return res.status(400).json({ error: 'device_id required' });
    }
    if (typeof new_name !== 'string' || !new_name.trim()) {
        return res.status(400).json({ error: 'new_name required' });
    }
    if (!haRegistry.isAvailable()) {
        return res.status(503).json({ error: 'ha_not_configured' });
    }

    try {
        const updated = await haRegistry.renameDevice(device_id, new_name.trim());
        // Trigger an immediate metrics poll so user_devices.metrics + ha_device_name
        // refresh without waiting for the next 30s tick.
        haWorker.triggerRefresh('post-rename');
        res.json({
            success: true,
            device_id,
            new_name: new_name.trim(),
            ha_entry_id: updated?.id || null,
        });
    } catch (e) {
        console.warn(`[api/ha] Rename failed for ${device_id}: ${e.message}`);
        res.status(500).json({ error: 'ha_rename_failed', message: e.message });
    }
});

/**
 * Map of Console-side "role" names to (entity_id suffix, domain, on/off services).
 * The Console doesn't need to know HA's entity_id naming or service names — it
 * just sends `{ device_id, role, value }` and the add-on resolves to a
 * `<domain>.<slug>_<entitySuffix>` entity_id and the appropriate service.
 *
 * For numeric entities (volume, brightness), we use number.set_value with `value` as service_data.
 * For switches, value is boolean → switch.turn_on / switch.turn_off.
 * For buttons (reload, refresh), value is ignored → button.press.
 */
const CONTROL_MAP = {
    lock:                    { suffix: 'lock', domain: 'switch', kind: 'switch' },
    screen:                  { suffix: 'screen', domain: 'switch', kind: 'switch' },
    screensaver:             { suffix: 'screensaver', domain: 'switch', kind: 'switch' },
    dark_mode:               { suffix: 'dark_mode', domain: 'switch', kind: 'switch' },
    keep_screen_on:          { suffix: 'keep_screen_on', domain: 'switch', kind: 'switch' },
    auto_brightness:         { suffix: 'auto_brightness', domain: 'switch', kind: 'switch' },
    hide_sidebar:            { suffix: 'hide_sidebar', domain: 'switch', kind: 'switch' },
    hide_tabs:               { suffix: 'hide_tabs', domain: 'switch', kind: 'switch' },
    start_on_boot:           { suffix: 'start_on_boot', domain: 'switch', kind: 'switch' },
    camera_stream_enabled:   { suffix: 'camera_stream_enabled', domain: 'switch', kind: 'switch' },
    camera_software_encoding:{ suffix: 'camera_software_encoding', domain: 'switch', kind: 'switch' },
    volume:                  { suffix: 'volume', domain: 'number', kind: 'number' },
    brightness:              { suffix: 'brightness', domain: 'number', kind: 'number' },
    zoom:                    { suffix: 'zoom', domain: 'number', kind: 'number' },
    reload:                  { suffix: 'reload_dashboard', domain: 'button', kind: 'button' },
    relaunch:                { suffix: 'restart_app', domain: 'button', kind: 'button' },
    refresh:                 { suffix: 'refresh_webview', domain: 'button', kind: 'button' },
    bring_to_foreground:     { suffix: 'bring_to_foreground', domain: 'button', kind: 'button' },
    reboot:                  { suffix: 'reboot_device', domain: 'button', kind: 'button' },
    clear_cache:             { suffix: 'clear_cache', domain: 'button', kind: 'button' },
    clear_storage:           { suffix: 'clear_storage', domain: 'button', kind: 'button' },
};

/**
 * POST /api/ha/control
 * Body: { device_id: '<dashie hex>', role: 'lock'|'volume'|..., value: bool|number }
 * Translates to a HA service call. Console doesn't need to know HA naming.
 */
router.post('/control', requireSignedIn, express.json(), async (req, res) => {
    const { device_id, role, value } = req.body || {};
    if (!device_id) return res.status(400).json({ error: 'device_id required' });
    if (!role) return res.status(400).json({ error: 'role required' });
    const map = CONTROL_MAP[role];
    if (!map) return res.status(400).json({ error: `unknown role: ${role}` });

    const slug = haWorker.getSlugForDevice(device_id);
    if (!slug) return res.status(404).json({ error: 'device_not_found_or_offline' });
    // Prefer the worker-resolved entity_id (correct even for
    // partial-migration devices where slug+suffix construction yields
    // a non-existent entity_id). Fall back to construction for control
    // roles the metrics matcher didn't bucket — that path keeps working
    // for the common case where the slug+suffix lines up.
    const resolvedEntityId = haWorker.getEntityIdForRole(device_id, map.suffix);
    const entityId = resolvedEntityId || `${map.domain}.${slug}_${map.suffix}`;

    try {
        let serviceName, serviceData = {};
        if (map.kind === 'switch') {
            serviceName = value ? 'turn_on' : 'turn_off';
        } else if (map.kind === 'number') {
            const num = Number(value);
            if (!Number.isFinite(num)) return res.status(400).json({ error: 'value must be numeric' });
            serviceName = 'set_value';
            serviceData.value = num;
        } else if (map.kind === 'button') {
            serviceName = 'press';
        } else {
            return res.status(500).json({ error: 'unsupported control kind' });
        }

        await haRegistry.callService(map.domain, serviceName, entityId, serviceData);
        // Trigger a poll so the next /api/ha/status reflects the new state.
        haWorker.triggerRefresh(`post-${role}`);
        res.json({ success: true, entity_id: entityId, service: `${map.domain}.${serviceName}` });
    } catch (e) {
        console.warn(`[api/ha] Control ${role}=${value} failed for ${device_id}: ${e.message}`);
        res.status(500).json({ error: 'ha_control_failed', message: e.message });
    }
});

/**
 * GET /api/ha/entities
 * Returns the user's controllable HA entities formatted for AI consumption.
 * Mirrors webapp ai-info-gatherer.fetchHomeAssistantData(): filters to the
 * same controllable domains, includes friendly_name, state, and a small
 * set of domain-specific attributes (brightness, temperature, position),
 * and groups by domain for easier prompt parsing.
 *
 * Cached for 60s on the worker side via haClient.getStates() — no extra
 * cache here. Callers (Console test-chat) cache on their own.
 */
const CONTROLLABLE_DOMAINS = [
    'light', 'switch', 'cover', 'climate', 'fan', 'scene', 'script',
    'input_boolean', 'automation', 'lock', 'media_player',
];

// Open — see the rationale block above requireSignedIn. HA state read on the add-on's
// own credential; no account is consulted.
router.get('/entities', async (req, res) => {
    try {
        const all = await haClient.getStates();
        if (!Array.isArray(all)) {
            return res.status(502).json({ error: 'unexpected /api/states response shape' });
        }
        const controllable = all.filter(e => {
            const domain = (e.entity_id || '').split('.')[0];
            return CONTROLLABLE_DOMAINS.includes(domain);
        });

        const formatted = controllable.map(entity => {
            const domain = entity.entity_id.split('.')[0];
            const row = {
                entity_id: entity.entity_id,
                domain,
                friendly_name: entity.attributes?.friendly_name || entity.entity_id,
                state: entity.state,
            };
            if (domain === 'light') {
                if (entity.attributes?.brightness != null) row.brightness = entity.attributes.brightness;
                if (entity.attributes?.color_mode) row.color_mode = entity.attributes.color_mode;
            } else if (domain === 'climate') {
                if (entity.attributes?.current_temperature != null) row.current_temperature = entity.attributes.current_temperature;
                if (entity.attributes?.temperature != null) row.temperature = entity.attributes.temperature;
                if (entity.attributes?.hvac_modes) row.hvac_modes = entity.attributes.hvac_modes;
            } else if (domain === 'cover') {
                if (entity.attributes?.current_position != null) row.current_position = entity.attributes.current_position;
            }
            return row;
        });

        const byDomain = {};
        for (const e of formatted) {
            if (!byDomain[e.domain]) byDomain[e.domain] = [];
            byDomain[e.domain].push(e);
        }

        return res.json({
            success: true,
            total_entities: formatted.length,
            entities_by_domain: byDomain,
            entities: formatted,
        });
    } catch (e) {
        console.warn('[api/ha/entities] failed:', e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * POST /api/ha/service
 * Generic HA service-call passthrough. Body: { domain, service, data }.
 * Used by the Console's test-chat to dispatch AI-emitted actions
 * (e.g. {domain:'light', service:'turn_on', data:{entity_id:'light.kitchen'}}).
 *
 * Trust model: INGRESS (see the rationale block above requireSignedIn). The
 * add-on holds the supervisor / long-lived HA token, so we never expose it to
 * the frontend, and the caller is an authenticated HA admin who can already
 * make this exact call from Developer Tools → Actions.
 *
 * Returns { success: true, result } on HA success; { success: false, error }
 * with an HTTP 500 on HA failure. (We return 200/success:false instead of
 * a hard 500 for normal HA-rejection cases like "entity not found" so the
 * Console chat can show the rejection inline rather than blowing up.)
 */
router.post('/service', express.json(), async (req, res) => {
    const { domain, service, data } = req.body || {};
    if (!domain || !service || typeof domain !== 'string' || typeof service !== 'string') {
        return res.status(400).json({ success: false, error: 'domain and service are required' });
    }
    // Light entity-id presence check — every HA service call we'd normally
    // issue from chat targets at least one entity. Allow data-less calls
    // through anyway (e.g. script.execute with no args) but require object.
    const payload = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
    try {
        const entityId = payload.entity_id;
        // haRegistry.callService signature is (domain, service, entityId, serviceData)
        // — peel entity_id out of `data` for the target field.
        const serviceData = { ...payload };
        delete serviceData.entity_id;
        const result = await haRegistry.callService(domain, service, entityId, serviceData);
        return res.json({ success: true, result });
    } catch (e) {
        console.warn(`[api/ha/service] ${domain}.${service} failed:`, e.message);
        return res.json({ success: false, error: e.message || 'ha_service_failed' });
    }
});

/**
 * POST /api/ha/conversation
 * Forwards a transcript to HA's Assist pipeline (/api/conversation/process).
 * Used when the AI emits action.command === 'forward_to_assist'. Mirrors
 * the mobile-app path haService.sendConversation() takes.
 *
 * Open — see the rationale block above requireSignedIn. A proxy to HA's own
 * Assist, which the same caller can reach from the HA sidebar.
 */
router.post('/conversation', express.json(), async (req, res) => {
    const { text, conversation_id, language } = req.body || {};
    if (!text || typeof text !== 'string') {
        return res.status(400).json({ success: false, error: 'text is required' });
    }
    try {
        const config = haClient.getConfig();
        if (!config) return res.status(503).json({ success: false, error: 'ha_not_configured' });
        const body = { text, language: language || 'en' };
        if (conversation_id) body.conversation_id = conversation_id;
        const resp = await fetch(`${config.baseUrl}/api/conversation/process`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        const respBody = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            return res.json({ success: false, error: respBody?.message || `HTTP ${resp.status}`, response: respBody });
        }
        return res.json({ success: true, response: respBody });
    } catch (e) {
        console.warn('[api/ha/conversation] failed:', e.message);
        return res.json({ success: false, error: e.message });
    }
});

/**
 * POST /api/ha/adopt/:deviceId
 *
 * Adopts a kiosk-mode device that's pushing state to HA but doesn't have a
 * device_installs row in Supabase (because nobody signed into Dashie on it).
 * Console calls this from the "Adopt" button on a Discovered card. The
 * tablet keeps running in pure-kiosk mode — no sign-in required on it.
 *
 * Trust model: we already know
 *   1. The caller is signed-in to the add-on (`requireSignedIn`), AND
 *   2. The device exists in *this* HA's device_registry (we look it up).
 * That's sufficient — running inside the user's own HA proves authorization.
 *
 * Network_id: synthetic per-HA hash (so adoptions across multiple HAs
 * stay distinct in device_installs even if a tablet roams).
 */
router.post('/adopt/:deviceId', requireSignedIn, async (req, res) => {
    const deviceId = req.params.deviceId;
    if (!deviceId) return res.status(400).json({ error: 'device_id required' });
    if (!haRegistry.isAvailable()) {
        return res.status(503).json({ error: 'ha_not_configured' });
    }

    try {
        // Look up the HA registry entry so we send Supabase real device info,
        // not whatever the Console claims. Validates the device is in *this*
        // HA — caller can't adopt arbitrary android_ids.
        const entry = await haRegistry.getDeviceByDashieId(deviceId, { force: true });
        if (!entry) {
            return res.status(404).json({ error: 'device_not_found_in_ha', device_id: deviceId });
        }

        const haBase = haClient.getConfig().baseUrl || 'unknown-ha';
        const networkId = 'ha-' + crypto.createHash('sha256').update(haBase).digest('hex').slice(0, 16);

        const adoptPayload = {
            android_id: deviceId,
            device_name: entry.name_by_user || entry.name || `Device ${deviceId.slice(0, 8)}`,
            device_brand: entry.manufacturer || null,
            device_model: entry.model || null,
            // HA registry doesn't categorize "tablet vs TV" — pass null and let
            // handleAdoptDeviceFromHa default to a safe user_devices.device_type.
            device_type: null,
            network_id: networkId,
        };

        const stored = auth.readStoredJwt();
        const dbOpsUrl = config.CLOUD.url + '/functions/v1/database-operations';
        const resp = await fetch(dbOpsUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${stored.jwt}`,
                'apikey': config.CLOUD.anonKey,
            },
            body: JSON.stringify({ operation: 'adopt_device_from_ha', data: adoptPayload }),
        });
        const body = await resp.text();
        if (!resp.ok) {
            console.warn(`[api/ha/adopt] ${deviceId} failed: HTTP ${resp.status} ${body.slice(0, 200)}`);
            // Pass through user-friendly error messages from the edge fn (e.g.
            // "already claimed by another account") rather than wrapping them.
            let parsed = null; try { parsed = JSON.parse(body); } catch { /* not JSON */ }
            // database-operations wraps thrown business errors as
            // { error: 'Internal server error', details: '<the real message>' } —
            // e.g. adopt's "already claimed by another Dashie account". Prefer
            // `details` so the user sees the actionable reason instead of the
            // generic wrapper; fall back to message/error/body for other shapes.
            return res.status(resp.status).json({
                error: 'adopt_failed',
                message: parsed?.details || parsed?.message || parsed?.error || body.slice(0, 200),
            });
        }
        const parsed = JSON.parse(body);

        // Trigger a worker refresh so the device leaves the Discovered section
        // promptly (next /api/ha/status no longer reports it as unmatched).
        haWorker.triggerRefresh('post-adopt');

        res.json(parsed);
    } catch (e) {
        console.warn(`[api/ha/adopt] ${deviceId} failed: ${e.message}`);
        res.status(500).json({ error: 'adopt_failed', message: e.message });
    }
});

/**
 * GET /api/ha/image/:deviceId/:role
 * Proxies HA's image_proxy / camera_proxy so the Console can render the latest
 * screenshot or camera snapshot via a same-origin <img>. role = 'screenshot' | 'camera'.
 *
 * Uses the entity_registry to find the right entity for this device, since
 * legacy installs (Fire Tablet → image.dashie_fire_tablet, Mio → image.mio_15_dashie)
 * don't follow the modern <slug>_<role> entity-id convention.
 */
async function findMediaEntity(dashieDeviceId, role) {
    const entry = await haRegistry.getDeviceByDashieId(dashieDeviceId);
    if (!entry) return null;
    const allEntities = await haRegistry.getEntitiesForHaDevice(entry.id);
    const targetDomain = role === 'screenshot' ? 'image' : 'camera';
    const candidates = allEntities.filter(e => (e.entity_id || '').startsWith(targetDomain + '.'));
    for (const c of candidates) {
        const state = await haClient.getState(c.entity_id);
        if (state?.attributes?.entity_picture) return state;
    }
    // Fallback: state without entity_picture (e.g. recently-added entity); return first
    if (candidates.length > 0) {
        return await haClient.getState(candidates[0].entity_id);
    }
    return null;
}

/**
 * GET /api/ha/mjpeg/:deviceId/:role
 * Multipart MJPEG stream — same upstream as /api/ha/image/:role but in a loop
 * with a multipart/x-mixed-replace envelope. Browsers play this natively
 * inside an <img> tag (no Hls.js, no <video>, no iframe, no signed URL games).
 *
 * Targets ~10 fps. Each frame is a fresh fetch of the HA-signed
 * entity_picture URL, which HA serves by calling the integration's
 * async_camera_image() — i.e. a fresh getCamshot from the device. No
 * frame_interval throttle on the single-image path, unlike HA's own
 * /api/camera_proxy_stream/.
 *
 * Closes cleanly when the client disconnects (e.g. user closes the modal).
 */
router.get('/mjpeg/:deviceId/:role', requireSignedIn, async (req, res) => {
    const { deviceId, role } = req.params;
    if (role !== 'screenshot' && role !== 'camera') {
        return res.status(400).json({ error: 'unknown role (screenshot|camera)' });
    }

    let state;
    try {
        state = await findMediaEntity(deviceId, role);
    } catch (e) {
        return res.status(500).json({ error: 'lookup_failed', message: e.message });
    }
    if (!state) return res.status(404).json({ error: `no ${role} entity found for device` });
    const entityPicture = state.attributes?.entity_picture;
    if (!entityPicture) return res.status(404).json({ error: 'entity has no entity_picture yet' });

    const config = haClient.getConfig();
    const fullUrl = entityPicture.startsWith('http')
        ? entityPicture
        : config.baseUrl + entityPicture;

    res.set({
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Connection': 'close',
    });
    res.flushHeaders?.();

    let closed = false;
    req.on('close', () => { closed = true; });
    req.on('aborted', () => { closed = true; });

    const FRAME_INTERVAL_MS = 100;  // ~10 fps
    const FRAME_TIMEOUT_MS = 1500;  // give up on a single frame

    try {
        while (!closed) {
            const tickStart = Date.now();
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), FRAME_TIMEOUT_MS);
                const upstream = await fetch(fullUrl, {
                    headers: { Authorization: `Bearer ${config.token}` },
                    signal: ctrl.signal,
                });
                clearTimeout(t);
                if (closed) break;
                if (upstream.ok) {
                    const buf = Buffer.from(await upstream.arrayBuffer());
                    if (closed) break;
                    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
                    res.write(buf);
                    res.write('\r\n');
                }
            } catch (e) {
                // Swallow single-frame failures (timeout, transient device error) —
                // next tick will retry. Bail only if the client disconnected.
                if (closed) break;
            }
            const elapsed = Date.now() - tickStart;
            const sleep = Math.max(0, FRAME_INTERVAL_MS - elapsed);
            if (sleep > 0) await new Promise(r => setTimeout(r, sleep));
        }
    } finally {
        try { res.end(); } catch (e) { /* ignore */ }
    }
});

/** GET /api/ha/image/:deviceId/:role/updated — the capture timestamp only, so the
 *  Console can show "Nm ago" on a (possibly stale) screenshot. An HA image entity's
 *  STATE is its image_last_updated ISO string. Reads entity state only — never
 *  fetches the picture, so it does NOT trigger a device capture. */
router.get('/image/:deviceId/:role/updated', requireSignedIn, async (req, res) => {
    const { deviceId, role } = req.params;
    if (role !== 'screenshot' && role !== 'camera') {
        return res.status(400).json({ error: 'unknown role (screenshot|camera)' });
    }
    try {
        const state = await findMediaEntity(deviceId, role);
        res.json({ updated: state?.state || state?.last_updated || null });
    } catch (e) {
        res.json({ updated: null });
    }
});

router.get('/image/:deviceId/:role', requireSignedIn, async (req, res) => {
    const { deviceId, role } = req.params;
    if (role !== 'screenshot' && role !== 'camera') {
        return res.status(400).json({ error: 'unknown role (screenshot|camera)' });
    }
    try {
        const state = await findMediaEntity(deviceId, role);
        if (!state) return res.status(404).json({ error: `no ${role} entity found for device` });
        const entityPicture = state.attributes?.entity_picture;
        if (!entityPicture) return res.status(404).json({ error: 'entity has no entity_picture yet' });

        const config = haClient.getConfig();
        const fullUrl = entityPicture.startsWith('http')
            ? entityPicture
            : config.baseUrl + entityPicture;
        const upstream = await fetch(fullUrl, {
            headers: { Authorization: `Bearer ${config.token}` },
        });
        if (!upstream.ok) {
            // "The device has no current frame" is a NORMAL state, not a gateway failure.
            // A tablet that is asleep, or awake but between captures, leaves HA serving a
            // 404 for the entity_picture it just advertised — so the Console's polling was
            // logging a steady stream of 502s for devices that were working perfectly.
            // (It read as a 404 before 0.9.9 mounted this router, which is why it only
            // became visible then; the underlying condition is not new.)
            //
            // 204 says exactly that: nothing to render right now, ask again later. The
            // client is an <img src>, which fails to paint on 204 and 502 alike, so this
            // is a pure signal-quality change — the card behaves as it already did.
            //
            // 5xx is kept as 502 deliberately: that one IS an upstream fault and should
            // stay loud. Collapsing everything to 204 would hide a genuinely broken HA.
            if (upstream.status < 500) return res.status(204).end();
            console.warn(`[api/ha/image] ${deviceId}/${role}: HA returned ${upstream.status}`);
            return res.status(502).json({ error: `HA returned ${upstream.status}` });
        }
        const ctype = upstream.headers.get('content-type') || 'image/jpeg';
        res.set('Content-Type', ctype);
        // Cacheable for a few seconds (NOT no-cache) so the Console can preload a
        // new-cache-bust frame off-screen and then swap the visible <img> to the
        // same URL without a second device capture or a blank flash. Each logical
        // refresh uses a new ?t=, so this never serves a stale frame across refreshes.
        res.set('Cache-Control', 'private, max-age=5');
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.send(buf);
    } catch (e) {
        console.warn(`[api/ha/image] ${deviceId}/${role} failed: ${e.message}`);
        res.status(500).json({ error: 'proxy_failed', message: e.message });
    }
});

/**
 * GET /api/ha/stream/:deviceId
 * Returns the HLS playlist URL for the device's camera entity. HA's `camera/stream`
 * WS request kicks off the stream pipeline (RTSP → HLS via the stream component);
 * Console then plays it via hls.js / native HLS in a <video> element.
 *
 * Same source HA's more-info dialog uses, so what we render matches what HA shows.
 */
router.get('/stream/:deviceId', requireSignedIn, async (req, res) => {
    const { deviceId } = req.params;
    try {
        const state = await findMediaEntity(deviceId, 'camera');
        if (!state) return res.status(404).json({ error: 'no camera entity for device' });
        // hls_url remains for any direct-player fallback; the Console now
        // iframes HA's more-info dialog (which already wraps the entity in
        // <ha-hls-player>), so dashboard_path is the field it actually uses.
        const result = await haRegistry.getCameraStreamUrl(state.entity_id).catch(() => null);
        const dashboardPath = await haRegistry.getDefaultDashboardPath().catch(() => '/');
        res.json({
            entity_id: state.entity_id,
            hls_url: result?.url || null,
            poster: state.attributes?.entity_picture || null,
            dashboard_path: dashboardPath,
        });
    } catch (e) {
        console.warn(`[api/ha/stream] ${deviceId} failed: ${e.message}`);
        res.status(500).json({ error: 'stream_resolve_failed', message: e.message });
    }
});

/**
 * GET /api/ha/hls?u=/api/hls/<token>/master_playlist.m3u8
 * Fetches an HA HLS resource (manifest or .ts segment) from the supervisor
 * URL and pipes the bytes back. Forces uncompressed transport so the browser
 * doesn't hit ERR_CONTENT_DECODING_FAILED (seen in some Ingress configs).
 *
 * Manifests reference relative paths (e.g. `playlist.m3u8`, `segment_5.ts`).
 * For nested fetches, hls.js resolves them relative to the manifest URL —
 * our proxy URL `/api/ha/hls?u=...` doesn't have a directory structure, so we
 * rewrite manifest contents to keep all references going through our proxy.
 */
router.get('/hls', requireSignedIn, async (req, res) => {
    const haPath = req.query.u;
    if (typeof haPath !== 'string' || !haPath.startsWith('/api/hls/')) {
        return res.status(400).json({ error: 'bad u param' });
    }
    const config = haClient.getConfig();
    try {
        const upstream = await fetch(config.baseUrl + haPath, {
            headers: { Authorization: `Bearer ${config.token}` },
        });
        if (!upstream.ok) {
            return res.status(upstream.status).json({ error: `HA returned ${upstream.status}` });
        }
        const ctype = upstream.headers.get('content-type') || 'application/octet-stream';
        res.removeHeader && res.removeHeader('Content-Encoding');
        res.set('Content-Type', ctype);
        res.set('Cache-Control', 'no-cache');

        if (ctype.includes('mpegurl') || ctype.includes('m3u8') || haPath.endsWith('.m3u8')) {
            // Rewrite playlist references so each .ts segment / nested .m3u8 / init.mp4
            // also routes through this proxy with the right `u=` path. Two cases:
            //   1) Bare relative URL line (segment_5.ts, playlist.m3u8)
            //   2) Directive lines with URI="..." (#EXT-X-MAP:URI="init.mp4",
            //      #EXT-X-KEY:URI="key.bin"). These start with '#' but still need
            //      their inner URIs rewritten.
            const txt = await upstream.text();
            const baseDir = haPath.replace(/[^/]+$/, '');  // /api/hls/<token>/
            const rewriteRef = ref => {
                if (!ref) return ref;
                const abs = ref.startsWith('/') ? ref : (baseDir + ref);
                return 'hls?u=' + encodeURIComponent(abs);
            };
            const rewritten = txt.split('\n').map(line => {
                const trim = line.trim();
                if (!trim) return line;
                if (trim.startsWith('#')) {
                    return line.replace(/URI="([^"]+)"/g, (_m, ref) => `URI="${rewriteRef(ref)}"`);
                }
                return rewriteRef(trim);
            }).join('\n');
            // Pin the manifest MIME type — Express's res.send(string) can default
            // to text/html, which makes Safari's native HLS reject the stream
            // with NotSupportedError. Also send as a Buffer so Express doesn't
            // re-infer the content-type from the string body.
            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            res.send(Buffer.from(rewritten, 'utf8'));
        } else {
            const buf = Buffer.from(await upstream.arrayBuffer());
            res.send(buf);
        }
    } catch (e) {
        console.warn(`[api/ha/hls] ${haPath} failed: ${e.message}`);
        res.status(500).json({ error: 'hls_proxy_failed', message: e.message });
    }
});

/**
 * GET /api/ha/events
 * Server-Sent Events stream of HA state_changed events filtered to Dashie-integration
 * entities. Each event is enriched with {device_id, role, state, attributes} so the
 * Console doesn't need entity_registry knowledge to react to a change.
 *
 * Same data HA's own UI gets via WebSocket — pushed in real time (~50–200ms latency).
 */
const sseClients = new Set();
let sseUnsubscribe = null;

async function _ensureStateChangedFanout() {
    if (sseUnsubscribe) return;
    sseUnsubscribe = await haRegistry.subscribeStateChanged(async (event) => {
        const data = event?.data;
        if (!data?.entity_id || !data?.new_state) return;
        // Resolve to a Dashie device + role using cached entity_registry.
        try {
            const entities = await haRegistry.getAllEntities();
            const entry = entities.find(e => e.entity_id === data.entity_id);
            if (!entry?.device_id) return;
            // Find the dashie device_id from the HA device's identifiers tuple.
            const allDashieIds = haWorker.getStatus().lastRun?.freshDevices?.map(d => d.device_id) || [];
            let dashieId = null;
            for (const id of allDashieIds) {
                const dev = await haRegistry.getDeviceByDashieId(id);
                if (dev?.id === entry.device_id) { dashieId = id; break; }
            }
            if (!dashieId) return;
            // Role from unique_id ({dashieId}_{role}) — falls back to entity_id suffix.
            let role = null;
            if (entry.unique_id?.startsWith(dashieId + '_')) role = entry.unique_id.slice(dashieId.length + 1);
            const payload = JSON.stringify({
                type: 'state',
                device_id: dashieId,
                role,
                entity_id: data.entity_id,
                state: data.new_state.state,
                attributes: data.new_state.attributes,
            });
            for (const res of sseClients) {
                try { res.write(`data: ${payload}\n\n`); } catch {}
            }
        } catch (e) {
            console.warn('[api/ha/events] event enrich failed:', e.message);
        }
    });
}

router.get('/events', requireSignedIn, async (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.write(': connected\n\n');
    sseClients.add(res);
    try { await _ensureStateChangedFanout(); }
    catch (e) { console.warn('[api/ha/events] subscribe failed:', e.message); }

    const heartbeat = setInterval(() => {
        try { res.write(': hb\n\n'); } catch { clearInterval(heartbeat); }
    }, 25 * 1000);
    req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
});

/** GET /api/ha/devices — lookup helper for debugging. Returns the per-Dashie-id map
 *  the Console will use to compute name conflicts. Only readable when signed in. */
router.get('/devices', requireSignedIn, async (req, res) => {
    if (!haRegistry.isAvailable()) {
        return res.json({ available: false, devices: [] });
    }
    try {
        // Force a refresh so the response reflects HA's current state.
        const states = haWorker.getStatus().lastRun?.upsertResult?.updated_device_ids || [];
        const out = [];
        for (const dashieId of states) {
            const entry = await haRegistry.getDeviceByDashieId(dashieId);
            if (!entry) continue;
            out.push({
                dashie_device_id: dashieId,
                ha_device_id: entry.id,
                name: entry.name,
                name_by_user: entry.name_by_user,
            });
        }
        res.json({ available: true, devices: out });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
