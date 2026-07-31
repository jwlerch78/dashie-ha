// SPDX-License-Identifier: AGPL-3.0-only
// server/api/feeds.js
// Video feed registry proxy — the Console's window into the HA integration's
// household-level feed registry (custom_components/dashie/feed_registry.py,
// stored in HA's .storage/dashie.video_feeds).
//
// The Console never talks to HA directly; these routes forward to the
// integration's HTTP views using the supervisor token, the same trust model
// as the image/HLS proxies in ha.js. Tablets pick up registry changes via
// their existing pullFeedsFromHa() sync — no push needed from here.

const express = require('express');
const haClient = require('../ha-client');

const router = express.Router();

// NO requireSignedIn on these routes, deliberately (2026-07-31).
//
// Every route here proxies to the Dashie Voice integration's feed_registry using
// the add-on's OWN HA credential (haClient.getConfig()). Not one of them reads or
// writes a Dashie account: household camera feeds belong to the HA user.
//
// Gating them on a Dashie sign-in made Video Feeds unusable for exactly the user
// this edition is for — someone running HA who never made a Dashie account. The
// page is in FeatureGate.LOCAL_MODE_PAGES for that reason, and leaving the guard
// here would render it and then 401 all six calls.
//
// The gate is INGRESS: HA has already authenticated whoever can reach this panel
// (see ingress-identity.js — identity, never authorization), the same reasoning
// that leaves /api/ha/status open. The add-on publishes no host port.
//
// If a route here ever needs the ACCOUNT, it must bring its own guard back — do
// not re-blanket the router.

/** Fetch a Dashie-integration HTTP view path and relay status + JSON body. */
async function haFetchJson(path, opts = {}) {
    const config = haClient.getConfig();
    if (!config) {
        const err = new Error('ha_not_configured');
        err.status = 503;
        throw err;
    }
    const resp = await fetch(config.baseUrl + path, {
        method: opts.method || 'GET',
        headers: {
            Authorization: `Bearer ${config.token}`,
            ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const body = await resp.json().catch(() => null);
    return { status: resp.status, ok: resp.ok, body };
}

function relay(res, result, label) {
    if (!result.ok) {
        console.warn(`[api/feeds] ${label} → HA HTTP ${result.status}`);
    }
    res.status(result.status).json(result.body ?? { error: 'empty_response_from_ha' });
}

function handleError(res, e, label) {
    console.warn(`[api/feeds] ${label} failed: ${e.message}`);
    res.status(e.status || 500).json({ error: 'feeds_proxy_failed', message: e.message });
}

/** GET /api/feeds — all household feed definitions, annotated by the
 *  integration with availability, rtsp_url, and Frigate camera info. */
router.get('/', async (req, res) => {
    try {
        relay(res, await haFetchJson('/api/dashie/feeds'), 'list');
    } catch (e) { handleError(res, e, 'list'); }
});

/** POST /api/feeds — create or update a feed definition. Body is the feed
 *  object in the registry's canonical shape (same payload tablets send). */
router.post('/', express.json(), async (req, res) => {
    const feed = req.body;
    if (!feed || typeof feed !== 'object') {
        return res.status(400).json({ error: 'feed body required' });
    }
    try {
        relay(res, await haFetchJson('/api/dashie/feeds', { method: 'POST', body: feed }), 'save');
    } catch (e) { handleError(res, e, 'save'); }
});

/** DELETE /api/feeds/:feedId — delete a feed definition (the registry also
 *  removes it from every device's subscription). */
router.delete('/:feedId', async (req, res) => {
    const feedId = req.params.feedId;
    if (!feedId) return res.status(400).json({ error: 'feed_id required' });
    try {
        const path = `/api/dashie/feeds/${encodeURIComponent(feedId)}`;
        relay(res, await haFetchJson(path, { method: 'DELETE' }), 'delete');
    } catch (e) { handleError(res, e, 'delete'); }
});

/** GET /api/feeds/meta/frigate-cameras — Frigate camera names for the
 *  override picker. 502 from the integration means Frigate isn't reachable;
 *  soften to an empty list so the Console picker just shows auto/none. */
router.get('/meta/frigate-cameras', async (req, res) => {
    try {
        const result = await haFetchJson('/api/dashie/frigate/cameras');
        if (!result.ok) return res.json({ cameras: [] });
        res.json({ cameras: result.body?.cameras || [] });
    } catch (e) { handleError(res, e, 'frigate-cameras'); }
});

/** GET /api/feeds/meta/discover — addable camera candidates (HA + Frigate,
 *  minus existing feeds, minus cameras that can't stream right now). 502 from
 *  the integration softens to an empty list so the picker shows "nothing to
 *  add" rather than an error. */
router.get('/meta/discover', async (req, res) => {
    try {
        const result = await haFetchJson('/api/dashie/feeds/discover');
        if (!result.ok) return res.json({ cameras: [] });
        res.json({ cameras: result.body?.cameras || [] });
    } catch (e) { handleError(res, e, 'discover'); }
});

/** GET /api/feeds/meta/entities — camera + trigger entity catalogs for the
 *  feed editor pickers. Cameras feed the source picker; binary_sensor +
 *  input_boolean feed the trigger picker (mirrors the Kotlin editor's
 *  entity filters in VideoFeedEditorFragment). */
router.get('/meta/entities', async (req, res) => {
    try {
        const states = await haClient.getStates();
        const pick = (prefixes) => states
            .filter(s => prefixes.some(p => s.entity_id.startsWith(p)))
            .map(s => ({
                entity_id: s.entity_id,
                name: s.attributes?.friendly_name || s.entity_id,
                state: s.state,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
        res.json({
            cameras: pick(['camera.']),
            triggers: pick(['binary_sensor.', 'input_boolean.']),
        });
    } catch (e) { handleError(res, e, 'entities'); }
});

module.exports = router;
