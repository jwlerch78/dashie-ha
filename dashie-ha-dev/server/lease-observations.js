// SPDX-License-Identifier: AGPL-3.0-only
// lease-observations.js — who the box has recently leased capability to.
//
// ── OBSERVATIONAL ONLY — this is NOT the lease table, and there isn't one ─────
//
// Grant decisions stay stateless: a renewal is a fresh read of grant state, which
// is what makes a lease survive an add-on restart without persistence and stops a
// stored lease outliving a revocation. Nothing here is ever consulted to decide
// whether to grant.
//
// It exists because leases are deliberately not in Supabase (D7), so without it
// NOTHING can answer "who currently holds capability" — which makes the setup
// state of most lease tests unverifiable (the lease test suite). Losing it on
// restart is therefore fine, and is itself a useful signal that it is not
// authoritative.
//
// ── WHY IT IS ITS OWN MODULE (2026-08-03) ────────────────────────────────────
//
// It was module-local to `api/internal.js`, which meant the ONLY way to read it
// was the internal debug route. The console's per-device sharing indicator needs
// the same data behind the console's own auth, and the alternatives were both
// worse: a second map (two sources of one truth, drifting), or attaching a
// reader onto the exported Express router (legal, and a trap for the next
// reader).
//
// 🔴 EXTRACTION ONLY — no behaviour changed, no storage added. Same Map, same
// bound, same eviction, same restart-lossiness. O's ruling was "extend, don't
// move"; moving the BOOKKEEPING while leaving the grant decision untouched is
// what that means in practice — `internal.js` still owns the lease path, this
// owns only the record of what it did.
//
// ⚠️ CONSUMERS MUST TREAT ABSENCE AS UNKNOWN, NEVER AS DENIAL. The map is empty
// after every restart and records only SUCCESSFUL grants — a refusal leaves no
// row. So "no entry for this device" means *nothing has been observed*, which is
// not the same as *nothing is shared*. CONTRACTS #72 pins the consequence: a
// per-device indicator renders NOTHING for an absent device. Rendering a
// "not shared" line off this map would be a confident falsehood on every boot.

'use strict';

const OBSERVED = new Map();
const OBSERVED_MAX = 50;

/**
 * Record an issued or renewed lease.
 * @returns {boolean} true if this endpoint was not previously observed.
 */
function record(endpointId, expiresAt, capabilities) {
    const prior = OBSERVED.get(endpointId);
    const now = new Date().toISOString();
    OBSERVED.set(endpointId, {
        endpoint_id: endpointId,
        issued_at: prior?.issued_at ?? now,
        last_renewal: now,
        renewals: (prior?.renewals ?? 0) + (prior ? 1 : 0),
        expires_at: expiresAt,
        capabilities,
    });
    // Bounded: evict the oldest by last renewal. A debug surface must not be a
    // way to grow the add-on's memory without limit.
    if (OBSERVED.size > OBSERVED_MAX) {
        const oldest = [...OBSERVED.values()].sort((a, b) => a.last_renewal < b.last_renewal ? -1 : 1)[0];
        if (oldest) OBSERVED.delete(oldest.endpoint_id);
    }
    return !prior;
}

/** Every observed lease. A COPY — callers must not be able to mutate the map. */
function list() {
    return [...OBSERVED.values()];
}

/**
 * One endpoint's observation, or `null` if none.
 *
 * 🔴 `null` means UNKNOWN, not "not shared" — see the header. The per-device
 * indicator's whole correctness rests on the caller honouring that.
 */
function get(endpointId) {
    return OBSERVED.get(endpointId) ?? null;
}

module.exports = { record, list, get, OBSERVED_MAX };
