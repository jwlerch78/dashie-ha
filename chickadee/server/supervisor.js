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

module.exports = { ensureSidebarPanel, isIntegrationLoaded, restartCore };
