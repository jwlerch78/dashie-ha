// SPDX-License-Identifier: AGPL-3.0-only
// supervisor.js — small Supervisor-API helpers for funnel UX.
//
//   ensureSidebarPanel(): flip our own "Show in sidebar" on (ingress_panel) so
//     the Chickadee panel appears without the user finding the toggle.
//   isIntegrationLoaded(): does the running HA have the chickadee component
//     loaded? Drives the "restart to activate" banner — the installer's status
//     alone goes stale (the add-on doesn't restart when core does).
//   restartCore(): POST /core/restart (needs hassio_role: manager) — behind
//     the console banner's "Restart Home Assistant" button.

'use strict';

const haWs = require('./ha-ws');

const SUP = 'http://supervisor';
const TOKEN = process.env.SUPERVISOR_TOKEN;

function headers() {
    return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
}

/** Best-effort: enable our own sidebar panel once. Never throws. */
async function ensureSidebarPanel() {
    if (!TOKEN) return;
    try {
        const info = await fetch(`${SUP}/addons/self/info`, { headers: headers() })
            .then(r => r.json()).catch(() => null);
        if (info?.data?.ingress_panel === true) return;
        const resp = await fetch(`${SUP}/addons/self/options`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ ingress_panel: true }),
        });
        if (resp.ok) console.log('[supervisor] sidebar panel enabled (ingress_panel=true)');
        else console.warn(`[supervisor] could not enable sidebar panel: HTTP ${resp.status}`);
    } catch (e) {
        console.warn('[supervisor] sidebar-panel enable failed:', e.message);
    }
}

let _loadedCache = { at: 0, val: null };

/** Is the chickadee integration loaded in the RUNNING core? 15s cache; null = unknown. */
async function isIntegrationLoaded() {
    if (!TOKEN) return null;
    const now = Date.now();
    if (_loadedCache.val !== null && now - _loadedCache.at < 15000) return _loadedCache.val;
    try {
        const cfg = await fetch(`${SUP}/core/api/config`, { headers: headers() })
            .then(r => (r.ok ? r.json() : null));
        const comps = Array.isArray(cfg?.components) ? cfg.components : null;
        if (!comps) return null;
        const val = comps.some(c => c === 'chickadee' || String(c).startsWith('chickadee.'));
        _loadedCache = { at: now, val };
        return val;
    } catch (e) {
        return null;
    }
}

let _flowCache = { at: 0, val: null };

/**
 * flow_id of an in-progress `chickadee` config flow, or null. This is the
 * discovery "Configure" card, parked at hassio_confirm after a core restart —
 * core creates it but the user must complete it for the integration to load.
 * Listing in-progress flows is WS-only (REST 405s), so this uses the core WS.
 * 10s cache; best-effort (null on unavailable/error — never throws).
 */
async function getPendingIntegrationFlowId() {
    const now = Date.now();
    if (now - _flowCache.at < 10000) return _flowCache.val;
    let val = null;
    try {
        if (haWs.isAvailable()) {
            const flows = await haWs.listConfigFlowsInProgress();
            const f = Array.isArray(flows) ? flows.find(x => x && x.handler === 'chickadee') : null;
            val = f ? f.flow_id : null;
        }
    } catch (e) {
        val = null;
    }
    _flowCache = { at: now, val };
    return val;
}

/**
 * Complete the parked discovery flow (POST {} — the hassio_confirm/user step
 * only checks that user_input is present), creating + loading the entry. This
 * is the "absorb the discovery click" the restart banner promises. Returns
 * { ok, type }. Never throws.
 */
async function completeIntegrationFlow(flowId) {
    if (!TOKEN || !flowId) return { ok: false };
    try {
        const resp = await fetch(`${SUP}/core/api/config/config_entries/flow/${flowId}`, {
            method: 'POST', headers: headers(), body: JSON.stringify({}),
        });
        const body = await resp.json().catch(() => ({}));
        // create_entry = configured + loaded. A show_form/abort means the step
        // wanted input we don't have (shouldn't happen for hassio_confirm).
        const ok = resp.ok && body.type === 'create_entry';
        _flowCache = { at: 0, val: null };   // invalidate both caches so the
        _loadedCache = { at: 0, val: null };  // banner re-checks immediately.
        if (!ok) console.warn(`[supervisor] configure-integration: unexpected flow result ${JSON.stringify(body).slice(0, 160)}`);
        return { ok, type: body.type, title: body.title };
    } catch (e) {
        console.warn('[supervisor] configure-integration failed:', e.message);
        return { ok: false };
    }
}

/** Restart HA core (manager role). Returns true when accepted. */
async function restartCore() {
    if (!TOKEN) return false;
    try {
        const resp = await fetch(`${SUP}/core/restart`, { method: 'POST', headers: headers() });
        if (!resp.ok) console.warn(`[supervisor] core restart refused: HTTP ${resp.status}`);
        return resp.ok;
    } catch (e) {
        // The restart often kills the connection mid-request — treat as accepted.
        console.log('[supervisor] core restart issued (connection dropped, expected)');
        return true;
    }
}

module.exports = {
    ensureSidebarPanel,
    isIntegrationLoaded,
    getPendingIntegrationFlowId,
    completeIntegrationFlow,
    restartCore,
};
