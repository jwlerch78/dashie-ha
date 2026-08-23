// SPDX-License-Identifier: AGPL-3.0-only
// prune-orphan-options.js — clear stored add-on options whose schema key is gone.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// Removing an option from `config.yaml` removes it from the Configuration TAB.
// It does NOT remove it from the box's stored options, and the belief that it
// did was written into three places in this repo as justification for shipping
// removals.
//
// 🔴 MEASURED FALSE (T s44 cont.7, John's box, immediately after 0.9.20): of the
// five keys removed from the schema, the Supervisor stripped exactly ONE —
// `ai_auth_enforce`, which sat at its default — and KEPT four, including John's
// `log_level: 'debug'`, the value he had actually set. So the schema showed 11
// rows while `options` still carried 15.
//
// T's hypothesis from that split (one observation per class, untested): the
// Supervisor prunes only options the user never wrote. Whatever the rule, the
// observable is that user-set orphans persist indefinitely — which is the exact
// case that matters, because a value someone deliberately set is the one they
// will later believe is doing something.
//
// ── WHY THE SCHEMA COMES FROM THE SUPERVISOR ─────────────────────────────────
//
// `config.yaml` is not in the image (the Dockerfile copies server/, frontend/,
// integration/, run.sh — not the manifest), so the running add-on cannot read its
// own schema off disk. `GET /addons/self/info` is authoritative per box and works
// identically on both channels, which a generated key-list would not: the dev and
// prod channels have different schemas by design (`lease_ttl_seconds`).
//
// ── WHY IT IS SAFE ───────────────────────────────────────────────────────────
//
// This WRITES the user's stored configuration, so every branch fails toward doing
// nothing:
//   · no SUPERVISOR_TOKEN, unreachable, non-200, unparseable → return, silent.
//   · schema missing / not an object / EMPTY → return. An empty schema would make
//     every stored option look orphaned; that is the one input that could wipe a
//     box's configuration, so it is refused explicitly rather than handled.
//   · nothing orphaned → return without a write.
// It only ever REMOVES keys absent from a non-empty schema. It never adds a key,
// never changes a value, and never throws — startup must not depend on it.

'use strict';

const SUPERVISOR = 'http://supervisor';

/** Best-effort JSON call to the Supervisor. Null on any failure. */
async function supervisor(path, init) {
    const token = process.env.SUPERVISOR_TOKEN;
    if (!token) return null;
    try {
        const resp = await fetch(`${SUPERVISOR}${path}`, {
            ...init,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
        });
        if (!resp.ok) {
            console.warn(`DROP: option prune — supervisor ${path} returned HTTP ${resp.status}; leaving stored options untouched`);
            return null;
        }
        return await resp.json().catch(() => null);
    } catch (e) {
        console.warn(`DROP: option prune — supervisor ${path} unreachable (${e?.message || e}); leaving stored options untouched`);
        return null;
    }
}

/**
 * Remove stored options that the current schema no longer declares.
 * @returns {Promise<string[]>} the keys pruned (empty when nothing was done).
 */
async function pruneOrphanOptions() {
    try {
        const info = await supervisor('/addons/self/info');
        const data = info?.data;
        if (!data) return [];

        const schema = data.schema;
        const stored = data.options;
        if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
        // 🔴 The guard that matters: an empty schema makes EVERY stored option look
        // orphaned. Refuse rather than interpret — this is the branch that would
        // wipe a household's configuration.
        const allowed = Object.keys(schema);
        if (allowed.length === 0) {
            console.warn('DROP: option prune — supervisor reported an EMPTY schema; refusing to treat every stored option as orphaned');
            return [];
        }
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return [];

        const orphans = Object.keys(stored).filter((k) => !allowed.includes(k));
        if (orphans.length === 0) return [];

        const kept = {};
        for (const [k, v] of Object.entries(stored)) if (allowed.includes(k)) kept[k] = v;

        const wrote = await supervisor('/addons/self/options', {
            method: 'POST',
            body: JSON.stringify({ options: kept }),
        });
        if (!wrote) {
            console.warn(`DROP: option prune — could not write cleaned options; ${orphans.length} orphan(s) remain: ${orphans.join(', ')}`);
            return [];
        }
        // Loud on success too: this changed something the user can see in their own
        // Configuration tab, and a silent edit to someone's config is worse than
        // the orphan it removes.
        console.log(`🧹 Pruned ${orphans.length} orphaned add-on option(s) no longer in the schema: ${orphans.join(', ')}`);
        return orphans;
    } catch (e) {
        console.warn(`DROP: option prune failed (${e?.message || e}) — stored options left untouched`);
        return [];
    }
}

module.exports = { pruneOrphanOptions };
