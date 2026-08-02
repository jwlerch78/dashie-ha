// SPDX-License-Identifier: AGPL-3.0-only
// lease-nudge.js — "renew NOW" (CONTRACTS #68, CAPABILITY_LEASE_WIRE.md §9).
//
// The lease already guarantees that a sharing flip takes effect: a satellite
// that cannot renew self-destructs at `expires_at`. What it does not guarantee
// is SPEED — up to one TTL, which is 30 minutes on a real box. John flips this
// switch constantly while testing, and "I turned it off and nothing happened"
// is the failure the whole lease exists to end; arriving half an hour late is
// the same failure with a stopwatch.
//
// 🔴 A TRIGGER, NEVER A COMMAND. This carries no authorization. The device
// renews and obeys the REAL response, so:
//   · authorization stays single-source (the renewal, already tested),
//   · a spoofed signal costs at most one extra renewal — which is why it needs
//     no signing,
//   · a LOST signal costs only time, because expiry still does the work.
// The lease is the guarantee; this is the fast path.
//
// ── 🔴 TRANSPORT REPLACED 2026-08-02: an ENTITY, not a custom event ──────────
//
// The first cut fired `POST /api/events/voice_lease_renew_now`. It was never
// delivered in the field: Home Assistant ALLOWLISTS which event types a
// NON-ADMIN user may subscribe to, and a wall tablet running as a non-admin
// user is the normal household topology. So the fast path silently degraded to
// TTL-only — up to 30 minutes — for most real installs. That is exactly the
// failure this exists to prevent, arriving through authorization, where
// re-subscribing cannot help. Observed on a real box, with the control beside
// it on the same connection: `state_changed` subscribed and delivered while the
// custom event was refused `unauthorized`.
//
// `state_changed` is the one event a non-admin user CAN subscribe to, so the
// integration owns an entity and we ask it to stamp a new instant. The device
// matches the entity_id SUFFIX `_lease_nudge` and treats any change as "renew
// now"; the state itself is a meaningless timestamp, deliberately — see the
// integration's sensor.py for why a readable state would be a durable second
// source of authorization truth.
//
// Still ruled out, unchanged: pushing to the device's own :2323 API (the add-on
// never learns a satellite's IP — renewals arrive through the integration, so
// it sees Home Assistant's address) and mDNS (needs a listener, unreliable
// across subnets and with WiFi client isolation).

'use strict';

const SUP = 'http://supervisor';
const TOKEN = process.env.SUPERVISOR_TOKEN;

// The voice integration's own domain — imported from the ONE place that already
// holds it (the discovery service name) rather than restated here, so a brand
// generation cannot rebrand one and miss the other.
const { SERVICE: VOICE_DOMAIN } = require('./discovery');
const NUDGE_SERVICE = 'lease_nudge';

/**
 * Fire the nudge. Best-effort by design — never throws, never blocks the caller,
 * and a failure is logged rather than surfaced, because the setting it follows
 * is already persisted and expiry is the real mechanism.
 *
 * @param {'sharing_changed'|'config_changed'|'manual'} reason  diagnostic only —
 *        the device must never branch on it, so a new reason never needs a
 *        device build.
 * @param {string[]} [endpointIds]  best-effort hint from the OBSERVATIONAL lease
 *        record. Absent or empty means everyone; being unlisted is not a denial.
 */
async function nudgeRenewNow(reason, endpointIds) {
    if (!TOKEN) {
        console.warn('DROP: lease nudge not sent — no SUPERVISOR_TOKEN (running outside the add-on?)');
        return false;
    }
    const body = { reason };
    if (Array.isArray(endpointIds) && endpointIds.length) body.endpoint_ids = endpointIds;
    try {
        const resp = await fetch(`${SUP}/core/api/services/${VOICE_DOMAIN}/${NUDGE_SERVICE}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            // A 400 here almost always means the integration predates the nudge
            // entity — the household still converges at expiry, which is why
            // this is a warning and not an error.
            console.warn(
                `DROP: lease nudge rejected (HTTP ${resp.status}) calling ${VOICE_DOMAIN}.${NUDGE_SERVICE} — ` +
                'satellites converge at expiry instead (is the voice integration current?)',
            );
            return false;
        }
        console.log(`LEASE: nudged reason=${reason} endpoints=${body.endpoint_ids?.join(',') || 'all'}`);
        return true;
    } catch (e) {
        console.warn(`DROP: lease nudge failed (${e.message}) — satellites converge at expiry instead`);
        return false;
    }
}

module.exports = { NUDGE_SERVICE, VOICE_DOMAIN, nudgeRenewNow };
