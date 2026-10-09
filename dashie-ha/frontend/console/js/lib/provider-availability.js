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
     * ── LOCAL-ENGINE DETECTION (2026-10-09) ─────────────────────────────────
     *
     * The second half of `available()` for a provider that has no credential.
     * "Do I hold a key" is the wrong question for Home Assistant's Piper or the
     * Kokoro add-on; the right one is "is this engine present on THIS BOX", and
     * only detection answers it.
     *
     * 🔴 EACH DETECTOR REUSES AN EXISTING PREDICATE RATHER THAN RE-DERIVING ONE.
     * That is the whole design, and it is the seam rule rather than tidiness: a
     * second `/piper/i` here would be a hand-mirror of the picker's, and the two
     * would disagree the first time Home Assistant renamed an engine — with the
     * visible symptom being a personality whose voice the picker offers and the
     * resolver refuses. So `ha-tts-engine` asks `HaEngines.haOption('tts')`,
     * which is non-null EXACTLY when `VoiceAiOptions._piperOption(detection)`
     * matched a Piper engine. One predicate, two readers.
     *
     * Every detector FAILS CLOSED. An unverifiable detection — no HA, a failed
     * probe, a cloud console with no add-on to ask — must read as unavailable,
     * never as available: claiming an engine we could not see is what would put
     * a voice on a personality this box cannot speak, and that failure is
     * invisible until someone listens to it.
     */
    const DETECTORS = {
        /** Home Assistant's own TTS engine (Piper in practice). */
        'ha-tts-engine': () => {
            const H = window.HaEngines;
            if (!H || !H.raw) return false;           // not loaded / no HA ⇒ closed
            return H.haOption('tts') !== null;
        },
        /** Our optional own-box Kokoro add-on, by Supervisor add-on list. */
        'kokoro-addon': () => {
            const H = window.HaEngines;
            return !!(H && H.raw && H.raw.kokoro && H.raw.kokoro.installed === true);
        },
    };

    /** Run a row's declared detector. Unknown or throwing ⇒ false, loudly. */
    function _detected(p) {
        const fn = DETECTORS[p && p.detect];
        if (!fn) {
            console.warn(`DROP: provider '${p && p.id}' declares auth 'local-engine' but `
                + `detect='${p && p.detect}' names no detector `
                + `(${Object.keys(DETECTORS).join(', ')}) — treating as unavailable.`);
            return false;
        }
        try {
            return fn() === true;
        } catch (e) {
            console.warn(`DROP: detector '${p.detect}' for provider '${p.id}' threw — `
                + `${e && e.message} — treating as unavailable.`);
            return false;
        }
    }

    /**
     * The second argument `ProviderManifest.isConfigured` expects, chosen by the
     * row's auth SHAPE rather than by its id. Adding a shape is adding a line
     * here and a READINESS rule there — never a branch inside an existing one.
     */
    function _statusFor(p) {
        const M = window.ProviderManifest;
        if (p.auth === M.AUTH.LOCAL_ENGINE) return _detected(p);
        if (p.auth === M.AUTH.API_KEY) return hasKey(p.id);
        return undefined;                             // AUTH.NONE reads nothing
    }

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
        // The engine half, from the SHARED loader — never a second fetcher of
        // /api/voice/engines (the Voice & AI and Devices pages already read it
        // through HaEngines, and a third caller is the hand-mirror the seam rule
        // forbids). Its own cache coalesces concurrent callers, so asking here
        // costs nothing when a page has already asked.
        try {
            if (window.HaEngines) await window.HaEngines.load();
        } catch (e) {
            console.warn(`DROP: provider-availability could not load engine detection — `
                + `${e && e.message} — local engines will read unavailable.`);
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
        // 🔴 DELEGATES to the manifest's READINESS registry (2026-10-09) instead
        // of branching on auth here. It used to read:
        //
        //     if (p.auth === M.AUTH.NONE) return true;
        //     return hasKey(id);
        //
        // which is two of the three shapes hardcoded, and the third — a local
        // engine — could only be expressed by misfiling it as NONE, whose rule
        // is `() => true`. That would have reported Kokoro available on a box
        // with no Kokoro: the reassuring direction, and undetectable from the
        // console. There are now two predicates in two places for two different
        // questions, joined by one call.
        //
        // The keyless note that was here still holds and now lives on
        // READINESS[AUTH.NONE]: such a provider has no credential to hold, and
        // demanding one is the bug that once made keyless providers
        // unconfigurable.
        return M.isConfigured(p, _statusFor(p)) === true;
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

    /** Test seam ONLY — the engine half, so a gate can drive a box with/without
     *  a local engine without an HA to ask. Writes HaEngines' cache directly
     *  rather than shadowing the detectors, so the leg exercises the REAL
     *  predicate (`haOption('tts')` → `_piperOption`) and not a stub of it. */
    function _setEnginesForTest(payload) {
        if (!window.HaEngines) { window.HaEngines = {}; }
        window.HaEngines._cache = payload || null;
        window.HaEngines._loaded = true;
    }

    window.ProviderAvailability = { refresh, hasKey, isAvailable, resolveVoice,
                                    _setKeyStatusForTest, _setEnginesForTest };
})();
