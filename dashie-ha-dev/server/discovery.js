// SPDX-License-Identifier: AGPL-3.0-only
// discovery.js — hand the bridge secret to the integration via Supervisor discovery.
//
// The PROPER credential channel (the same one the MQTT broker/Wyoming add-ons
// use): POST http://supervisor/discovery {service, config} with SUPERVISOR_TOKEN;
// the Supervisor delivers it to HA Core, which fires the dashie_voice integration's
// async_step_hassio with the config. Replaces the interim world-readable
// <ha-config>/.dashie_voice/bridge_secret file as the primary channel (the file
// copies remain for older integrations — CONTRACTS.md).

'use strict';

const os = require('os');

const SUPERVISOR = 'http://supervisor';
const SERVICE = 'dashie_voice';
const RETRY_MS = [2000, 10000, 30000];

async function publish(secret, log = console.log) {
    const token = process.env.SUPERVISOR_TOKEN;
    if (!token) {
        log('[discovery] no SUPERVISOR_TOKEN — not running under the Supervisor; skipping discovery publish');
        return false;
    }
    const body = JSON.stringify({
        service: SERVICE,
        config: {
            // Our OWN container hostname on the hassio network — correct for
            // ANY channel (prod `62f754e2-dashie-ha`, dev `62f754e2-dashie-ha-dev`,
            // local `local-dashie-ha`). Was hardcoded 'local-dashie-ha', which
            // is unreachable from the dev slug → the integration reported
            // addon_unreachable and kiosks never picked up the shared account.
            // The integration still falls back to its Supervisor lookup / static
            // candidates if this is somehow unreachable.
            host: os.hostname(),
            port: 8099,
            secret,
        },
    });
    try {
        const resp = await fetch(`${SUPERVISOR}/discovery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body,
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            log(`[discovery] DROP: Supervisor rejected discovery (HTTP ${resp.status}): ${JSON.stringify(data).slice(0, 200)}`);
            return false;
        }
        log(`[discovery] bridge secret published via Supervisor discovery (uuid ${data?.data?.uuid || '?'})`);
        return true;
    } catch (e) {
        log(`[discovery] DROP: discovery publish failed: ${e.message}`);
        return false;
    }
}

/** Publish with a few retries (the Supervisor may not be ready at container start). */
function publishWithRetry(secret, log = console.log) {
    publish(secret, log).then((ok) => {
        if (ok) return;
        let attempt = 0;
        const next = () => {
            if (attempt >= RETRY_MS.length) return;
            setTimeout(async () => {
                if (!(await publish(secret, log))) { attempt += 1; next(); }
            }, RETRY_MS[attempt]);
        };
        next();
    });
}

module.exports = { publishWithRetry };
