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
