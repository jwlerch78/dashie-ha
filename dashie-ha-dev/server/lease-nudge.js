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
// 🔴 A TRIGGER, NEVER A COMMAND. This packet carries no authorization. The
// device renews and obeys the REAL response, so:
//   · authorization stays single-source (the renewal, already tested),
//   · a spoofed packet costs at most one extra renewal — which is why it needs
//     no signing,
//   · a LOST packet costs only time, because expiry still does the work.
// The lease is the guarantee; this is the fast path.
//
// Transport chosen on a hard constraint rather than a preference: the add-on
// never learns a satellite's IP — renewals arrive through the integration, so
// it sees Home Assistant's address — which rules out pushing to the device's
// own :2323 API. An HA event needs no addressing, no inbound port, crosses NAT,
// and any satellite that can reach HA can subscribe.

'use strict';

const SUP = 'http://supervisor';
const TOKEN = process.env.SUPERVISOR_TOKEN;

// Brand-NEUTRAL and identical in both editions, deliberately. Naming it per
// brand would force an edition-keyed constant onto the device for no benefit:
// this is a protocol event, not a product surface.
const EVENT_TYPE = 'voice_lease_renew_now';

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
        const resp = await fetch(`${SUP}/core/api/events/${EVENT_TYPE}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            console.warn(`DROP: lease nudge rejected (HTTP ${resp.status}) — satellites converge at expiry instead`);
            return false;
        }
        console.log(`LEASE: nudged reason=${reason} endpoints=${body.endpoint_ids?.join(',') || 'all'}`);
        return true;
    } catch (e) {
        console.warn(`DROP: lease nudge failed (${e.message}) — satellites converge at expiry instead`);
        return false;
    }
}

module.exports = { EVENT_TYPE, nudgeRenewNow };
