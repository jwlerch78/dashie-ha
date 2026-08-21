// SPDX-License-Identifier: AGPL-3.0-only
// js/lib/provider-availability.js
//
// ONE function for ONE question, asked by two different surfaces:
//
//     available(provider) = a key is PRESENT  AND  an adapter is SHIPPED
//
// ── WHY IT IS ITS OWN FILE ───────────────────────────────────────────────────
//
// Both facts already shipped and NOTHING JOINED THEM. `GET /api/keys/status`
// answers "do I hold a credential for X" — correctly, as a credential store
// should. `provider-manifest.js`'s `adapter` field answers "is there on-box code
// that spends it". Neither alone is an answer to "can this box actually do X",
// and the two surfaces that need that answer — the API Keys page's "this row
// needs a key" and the personality resolver's "walk the preference list" — are
// the same predicate asked twice.
//
// Two implementations of it is precisely the drift the #5 and personalities
// proposals were written together to avoid, so this exists before either has a
// second caller rather than after.
//
// 🔴 A key with no adapter is the dangerous half, because it fails in the
// reassuring direction: the credential store says yes, the console renders a
// stored key, and nothing on the box can spend it. That is the WS-I.8 shape
// (Claude/Bedrock keys validating green while turns kept billing credits), and
// it is why `adapter` is part of this predicate rather than a badge.

(function () {
    'use strict';

    /** Cached { provider: bool } from GET /api/keys/status. */
    let _keyStatus = null;

    /**
     * Refresh the key half. Best-effort: a failure leaves the previous answer
     * rather than asserting "no keys", because an unreadable status and an empty
     * store are different facts and only one of them means "add a key".
     */
    async function refresh() {
        try {
            if (typeof DashieAuth === 'undefined' || !DashieAuth.isAddonMode) { _keyStatus = {}; return _keyStatus; }
            const resp = await fetch(DashieAuth._addonUrl('/api/keys/status'), { cache: 'no-store' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            _keyStatus = data?.providers || {};
        } catch (e) {
            console.warn(`DROP: provider-availability could not read key status — ${e?.message || e}` +
                (_keyStatus ? ' (keeping the previous answer)' : ' (nothing cached yet)'));
        }
        return _keyStatus || {};
    }

    /** The raw key half, without the adapter join. Rarely what you want. */
    function hasKey(providerId) {
        return (_keyStatus || {})[String(providerId || '')] === true;
    }

    /**
     * THE predicate. `true` only when this box holds a credential for the
     * provider AND ships code that spends it.
     *
     * An unknown provider id is `false` — never an optimistic default. A typo
     * here would otherwise render a personality's premium voice as available on
     * a box that has never heard of the provider.
     */
    function isAvailable(providerId) {
        const id = String(providerId || '');
        if (!id) return false;
        const M = window.ProviderManifest;
        const p = M && M.byId(id);
        if (!p) return false;
        if (p.adapter !== M.ADAPTER.SHIPPED) return false;
        // A keyless provider (auth 'none') is available as soon as its adapter
        // ships — it has no credential to hold, and demanding one would make it
        // permanently unavailable, which is the bug that once made keyless
        // providers unconfigurable.
        if (p.auth === M.AUTH.NONE) return true;
        return hasKey(id);
    }

    /**
     * Walk a personality's PREFERENCE-ORDERED voice refs and return the first
     * this box can actually speak, or null.
     *
     * A ref is an opaque string, by design (the voice matrix has not settled).
     * The only structure assumed is an optional `provider:` prefix — anything
     * without one is treated as provider-less and therefore always speakable,
     * because a bare ref names a voice on whatever engine is already configured.
     *
     * 🔴 Returning null is NOT a failure of the personality. The caller shows
     * "(voice not available)" and speaks in the standard voice; the persona and
     * its prompt are untouched. Degrade the part that depended on the missing
     * thing, not the whole feature — and NEVER persist the unavailable state,
     * which is transient by definition (the key may arrive tomorrow).
     */
    function resolveVoice(voices) {
        const list = Array.isArray(voices) ? voices : [];
        for (const ref of list) {
            const s = String(ref || '');
            if (!s) continue;
            const i = s.indexOf(':');
            if (i < 0) return s;                 // no provider named → nothing to check
            if (isAvailable(s.slice(0, i))) return s;
        }
        return null;
    }

    /** Test seam ONLY — lets a control set the key half without a server.
     *  Never call this from a page; `refresh()` is the live path. */
    function _setKeyStatusForTest(status) { _keyStatus = status || {}; }

    window.ProviderAvailability = { refresh, hasKey, isAvailable, resolveVoice, _setKeyStatusForTest };
})();
