// SPDX-License-Identifier: AGPL-3.0-only
// server/ha-client.js
// Thin wrapper around Home Assistant's REST API.
//
// Two modes, auto-detected by env:
//   Production (HAOS add-on): SUPERVISOR_TOKEN → base URL http://supervisor/core
//   Local dev:                DASHIE_HA_URL + DASHIE_HA_TOKEN (long-lived token)

function getConfig() {
    if (process.env.SUPERVISOR_TOKEN) {
        return {
            baseUrl: 'http://supervisor/core',
            token: process.env.SUPERVISOR_TOKEN,
            mode: 'supervisor',
        };
    }
    if (process.env.DASHIE_HA_URL && process.env.DASHIE_HA_TOKEN) {
        return {
            baseUrl: process.env.DASHIE_HA_URL.replace(/\/$/, ''),
            token: process.env.DASHIE_HA_TOKEN,
            mode: 'dev-llat',
        };
    }
    return null;
}

function isAvailable() {
    return getConfig() !== null;
}

async function checkConnection() {
    const config = getConfig();
    if (!config) return { ok: false, reason: 'not_configured' };
    try {
        const resp = await fetch(`${config.baseUrl}/api/`, {
            headers: { Authorization: `Bearer ${config.token}` },
        });
        const data = await resp.json().catch(() => null);
        return {
            ok: resp.ok,
            status: resp.status,
            mode: config.mode,
            baseUrl: config.baseUrl,
            message: data?.message || null,
        };
    } catch (e) {
        return { ok: false, error: e.message, mode: config.mode, baseUrl: config.baseUrl };
    }
}

/** Returns an array of state objects: { entity_id, state, attributes, last_changed, last_updated } */
async function getStates() {
    const config = getConfig();
    if (!config) throw new Error('HA client not configured');
    const resp = await fetch(`${config.baseUrl}/api/states`, {
        headers: { Authorization: `Bearer ${config.token}` },
    });
    if (!resp.ok) throw new Error(`/api/states: HTTP ${resp.status}`);
    return resp.json();
}

/** Get a single entity's state. */
async function getState(entityId) {
    const config = getConfig();
    if (!config) throw new Error('HA client not configured');
    const resp = await fetch(`${config.baseUrl}/api/states/${encodeURIComponent(entityId)}`, {
        headers: { Authorization: `Bearer ${config.token}` },
    });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`/api/states/${entityId}: HTTP ${resp.status}`);
    return resp.json();
}

/**
 * Render a Jinja template through HA's own template engine.
 *
 * 🔴 WE DO NOT RENDER JINJA OURSELVES, ON PURPOSE. The Freeform prompt box is
 * the same box HA users already fill in on their own conversation agent, so it
 * has to behave identically — `now()`, `states()`, `areas()`, every filter and
 * every extension. Re-implementing a subset in Node would be a second Jinja
 * that is subtly wrong, and the failures would look like our bugs.
 *
 * ⚠️ VARIABLE NAMES MUST BE NAMESPACED. HA already defines `device_name()` and
 * `device_area()` as template FUNCTIONS (DeviceExtension). Passing variables
 * under those names shadows them, so a user's `{{ device_name('switch.x') }}`
 * silently stops working. Measured 2026-10-03: with no variables passed,
 * `{{ device_name }}` renders as "<function DeviceExtension.device_name at
 * 0x...>". Hence dashie_* for everything we inject.
 *
 * Returns { ok: true, rendered } or { ok: false, error } — HA's own message,
 * passed through verbatim, because HA's wording about a Jinja error is better
 * than anything we would write and matches what the user sees elsewhere in HA.
 */
let _haNameCache = { value: null, at: 0 };

/** HA's location_name, which `{{ ha_name }}` must resolve to. Cached briefly:
 *  the editor renders on every press of Render, and the house does not move. */
async function _haName(config) {
    if (_haNameCache.value !== null && Date.now() - _haNameCache.at < 60000) return _haNameCache.value;
    try {
        const resp = await fetch(`${config.baseUrl}/api/config`, {
            headers: { Authorization: `Bearer ${config.token}` },
        });
        if (!resp.ok) return _haNameCache.value || '';
        const name = (await resp.json())?.location_name || '';
        _haNameCache = { value: name, at: Date.now() };
        return name;
    } catch { return _haNameCache.value || ''; }
}

async function renderTemplate(template, variables = {}) {
    const config = getConfig();
    if (!config) throw new Error('HA client not configured');
    // 🔴 ha_name and user_name are VARIABLES HA's conversation layer passes in
    // (core 2026.9.3 chat_log.py _async_expand_prompt_template), NOT template
    // globals. Rendering `{{ ha_name }}` through /api/template without them
    // yields an EMPTY STRING, so the default prompt reads "You are the voice
    // assistant for ." — correct-looking output, silently missing the house.
    // Measured 2026-10-04. Ours are injected here, under HA's names, so the box
    // behaves exactly like the Instructions box in the user's own agent.
    const withContext = { ha_name: await _haName(config), user_name: '', ...variables };
    const resp = await fetch(`${config.baseUrl}/api/template`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ template, variables: withContext }),
    });
    const body = await resp.text();
    if (resp.ok) return { ok: true, rendered: body };
    // HA answers a bad template with 400 and {"message":"Error rendering
    // template: UndefinedError: ..."}. Keep the message; drop the envelope.
    let message = body;
    try { message = JSON.parse(body).message || body; } catch { /* not JSON — show it raw */ }
    return { ok: false, error: message, status: resp.status };
}

/**
 * Get history for a single entity between two ISO timestamps.
 * Uses `minimal_response` + `no_attributes` so HA only returns
 * {state, last_changed} per sample — the chart doesn't need the
 * full attribute payload, and large windows on chatty sensors
 * (RAM, brightness) can be 10x smaller on the wire.
 *
 * HA returns `[[sample, sample, ...]]` — a single-element array
 * whose only entry is the list of samples for the requested entity.
 * We flatten that one level for callers.
 */
async function getHistory(entityId, startISO, endISO) {
    const config = getConfig();
    if (!config) throw new Error('HA client not configured');
    const qs = new URLSearchParams({
        filter_entity_id: entityId,
        end_time: endISO,
        minimal_response: '',
        no_attributes: '',
    });
    const url = `${config.baseUrl}/api/history/period/${encodeURIComponent(startISO)}?${qs}`;
    const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${config.token}` },
    });
    if (!resp.ok) throw new Error(`/api/history: HTTP ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) return [];
    return Array.isArray(data[0]) ? data[0] : [];
}

/** GET the HA-local voice transcripts the Dashie integration stores
 *  (.storage/dashie.voice_transcripts). Used by the Console to show kiosk
 *  voice history. Returns the parsed { transcripts: [...] } body. */
async function getTranscripts(limit = 100) {
    const config = getConfig();
    if (!config) throw new Error('HA client not configured');
    const url = `${config.baseUrl}/api/dashie/voice/transcripts?limit=${encodeURIComponent(limit)}`;
    const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${config.token}` },
    });
    if (!resp.ok) throw new Error(`/api/dashie/voice/transcripts: HTTP ${resp.status}`);
    return resp.json();
}

/**
 * Call an HA service — POST /api/services/<domain>/<service> with a JSON body.
 * Used to push device commands via the Dashie integration (e.g.
 * dashie.refresh_voice_config on a household-sharing toggle). Throws on HTTP error.
 */
async function callService(domain, service, data = {}) {
    const config = getConfig();
    if (!config) throw new Error('HA client not configured');
    const url = `${config.baseUrl}/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data || {}),
    });
    if (!resp.ok) throw new Error(`/api/services/${domain}/${service}: HTTP ${resp.status}`);
    return resp.json().catch(() => ({}));
}

/** DELETE all HA-local voice transcripts. Returns { cleared: <count> }. */
async function clearTranscripts() {
    const config = getConfig();
    if (!config) throw new Error('HA client not configured');
    const url = `${config.baseUrl}/api/dashie/voice/transcripts`;
    const resp = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${config.token}` },
    });
    if (!resp.ok) throw new Error(`/api/dashie/voice/transcripts DELETE: HTTP ${resp.status}`);
    return resp.json();
}

module.exports = {
    renderTemplate,
    getConfig,
    isAvailable,
    checkConnection,
    getStates,
    getState,
    getHistory,
    callService,
    getTranscripts,
    clearTranscripts,
};
