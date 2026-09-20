// js/lib/ha-engines.js
//
// HA voice-engine detection, fetched once and SHARED.
//
// Why this exists: the Voice & AI page has always fetched `/api/voice/engines` from the add-on to
// populate its STT/TTS pickers. The Devices page now needs the same lists, to offer a per-device
// HA engine / Piper voice. Rather than a second fetcher of the same endpoint — a hand-mirror the
// seam rule forbids — both read this.
//
// 🔴 WHAT THIS IS AND IS NOT A LIST OF. These are the engines the HOUSEHOLD'S Home Assistant
// offers, not what a particular device can run. That is the whole reason a per-device HA engine
// choice needs no capability record: an HA engine is server-side, so any device talking to that HA
// can use it. Contrast `stt.registered` in the capability record, which IS a device fact and is
// what gates the per-device speech-to-text picker.
//
// ⚠️ ADD-ON MODE ONLY. `DashieAuth.isAddonMode` false ⇒ there is no add-on to ask, and this
// resolves to null. Callers must treat null as "no choice can be offered" and hide the affordance,
// never render an empty picker — the standing posture is to fail toward the account default rather
// than toward a guess.

const HaEngines = {
    _cache: null,
    _loaded: false,
    _inflight: null,

    /**
     * Load (and cache) the add-on's engine detection.
     * @param {boolean} force bypass both this cache and the server's 5-minute one (`?refresh=1`),
     *   for an explicit user-driven refresh.
     * @returns {Promise<object|null>} the raw detection payload, or null when unavailable.
     */
    async load(force = false) {
        if (!window.DashieAuth?.isAddonMode) { this._cache = null; this._loaded = true; return null; }
        if (this._loaded && !force) return this._cache;
        // Coalesce concurrent callers: the Devices page and the Voice & AI page can both ask
        // during one render pass, and two in-flight fetches would race to set _cache.
        if (this._inflight && !force) return this._inflight;

        this._inflight = (async () => {
            try {
                const url = window.DashieAuth._addonUrl('/api/voice/engines' + (force ? '?refresh=1' : ''));
                // cache:'no-store' stops the browser/ingress serving a stale response.
                const r = await fetch(url, { cache: 'no-store' });
                this._cache = r.ok ? await r.json() : null;
            } catch (e) {
                console.warn('[HaEngines] engine detection unavailable:', e?.message || e);
                this._cache = null;
            } finally {
                this._loaded = true;
                this._inflight = null;
            }
            return this._cache;
        })();
        return this._inflight;
    },

    /** The last-loaded payload without triggering a fetch. Null until `load()` has resolved. */
    get raw() { return this._cache; },

    /** True once `load()` has settled, whatever the outcome — so a caller can tell "not yet" from "none". */
    get loaded() { return this._loaded; },

    /**
     * The `ha_engine` option for a stage, as VoiceAiOptions builds it, or null.
     * Going through VoiceAiOptions rather than reading the payload directly keeps ONE
     * interpretation of the detection shape (contract #43's forward map owns it).
     * @param {'stt'|'tts'} stage
     */
    haOption(stage) {
        const O = window.VoiceAiOptions;
        if (!O || !this._cache) return null;
        const list = stage === 'tts' ? O.ttsOptions(this._cache) : O.sttOptions(this._cache);
        return (list || []).find((o) => o.id === 'ha_engine') || null;
    },

    /**
     * The option list for a config field hanging off the `ha_engine` option —
     * e.g. `configOptions('tts', 'voice.haTtsVoiceId')` for the Piper voices.
     * Returns [] when detection is unavailable, which callers must read as "hide the row".
     */
    configOptions(stage, fieldKey) {
        const eng = this.haOption(stage);
        return ((eng?.configFields || []).find((f) => f.key === fieldKey)?.options) || [];
    },
};

window.HaEngines = HaEngines;
