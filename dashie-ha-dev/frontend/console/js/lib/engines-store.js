/* ============================================================
   Local Engines store
   ------------------------------------------------------------
   The user's saved "own box" engines — the LLM / TTS / STT servers they run
   themselves (Ollama, Kokoro, Piper-via-shim, whisper.cpp, …):

     { id, name, kind: 'llm'|'tts'|'stt', url, model? }

   An engine is a BOX, not a voice. `model` exists only for kind 'llm', where the
   model IS the thing you switch between on one box — "Qwen 7B on the Mac" and
   "Llama 3B on the Mac" are two entries pointing at one URL (duplicate() makes the
   second one cheap).

   The TTS **voice** deliberately does NOT live here: it stays on the Voice & AI
   card (populated by probing the selected engine's own /v1/audio/voices), so there
   is exactly one place to change it. STT servers expose no model list, so they're
   URL-only too.

   ── Why user_settings and not a table ──
   Storage is a JSON array at `voice.localEngines` in user_settings, written via
   the canonical serialized patch writer. The server's merge REPLACES arrays
   wholesale (console-auth patchUserSettings: "objects merge, arrays/scalars
   replace"), so a delete — a shorter array — persists correctly. Ids are stable
   UUIDs, so a later move to a real table (with per-device engine overrides, the
   way personalities work) is mechanical.

   ── Why the device never sees this ──
   Selecting an engine RESOLVES it into the flat account keys the native runtime
   already reads (voice.localTtsUrl / localTtsVoiceId / localSttUrl / localLlmUrl
   / localLlmModel — see ACCOUNT_VOICE_KEYS in js/data/settings/device-settings-
   writer.js). Kotlin never learns that an engine registry exists: no new synced
   key, no lint:settings change, old APKs unaffected. resolveToSettings() below is
   that mapping, and it is the ONLY thing the tablets ever see.

   NO SECRETS HERE: an endpoint needing a key uses the API Keys page (whose values
   live on the HA box's /data volume, never in Supabase).
   ============================================================ */

const EnginesStore = {
    KEY: 'voice.localEngines',

    // `modelLabel` present ⇒ the editor shows a model field for that kind. Only the AI
    // engine has one (the voice is chosen on the Voice & AI card; STT servers list no
    // models).
    KINDS: [
        { id: 'llm', label: 'AI model',      hint: 'Ollama / llama.cpp / any OpenAI-compatible chat endpoint', probe: 'llm',
          namePlaceholder: 'e.g. Qwen 7B on the Mac',
          urlPlaceholder: 'http://192.168.1.50:11434', modelLabel: 'Model', modelPlaceholder: 'qwen2.5:7b' },
        { id: 'tts', label: 'Text-to-speech', hint: 'Kokoro / Piper / any OpenAI-compatible speech endpoint',  probe: 'tts',
          namePlaceholder: 'e.g. Piper on the Mac',
          urlPlaceholder: 'http://192.168.1.50:8880' },
        { id: 'stt', label: 'Speech-to-text', hint: 'whisper.cpp / faster-whisper / speaches (OpenAI-compatible)', probe: 'stt',
          namePlaceholder: 'e.g. Whisper on the Mac',
          urlPlaceholder: 'http://192.168.1.50:8000' },
    ],

    kind(id) { return this.KINDS.find(k => k.id === id) || null; },

    _cache: null,   // last-loaded array (so the picker can render without refetching)

    /** All saved engines (optionally of one kind), newest last. */
    async list(kind = null) {
        const settings = await DashieAuth.loadUserSettings();
        const raw = settings?.voice?.localEngines;
        this._cache = Array.isArray(raw) ? raw.filter(e => e && e.id && e.kind) : [];
        return kind ? this._cache.filter(e => e.kind === kind) : this._cache;
    },

    /** Synchronous read of the last list() result — for render paths that can't await. */
    cached(kind = null) {
        const all = this._cache || [];
        return kind ? all.filter(e => e.kind === kind) : all;
    },

    get(id) { return (this._cache || []).find(e => e.id === id) || null; },

    async save(engine) {
        const all = await this.list();
        const clean = {
            id: engine.id || this._uuid(),
            name: String(engine.name || '').trim() || 'Untitled engine',
            kind: engine.kind,
            url: String(engine.url || '').trim().replace(/\/+$/, ''),
            model: String(engine.model || '').trim(),
        };
        const next = all.some(e => e.id === clean.id)
            ? all.map(e => (e.id === clean.id ? clean : e))
            : [...all, clean];
        await this._write(next);
        return clean;
    },

    async remove(id) {
        const next = (await this.list()).filter(e => e.id !== id);
        await this._write(next);
    },

    /** Copy an engine ("Qwen 7B on Mac" → "Qwen 7B on Mac (copy)") — the cheap way to
     *  add a second model on the same box. */
    async duplicate(id) {
        const src = (await this.list()).find(e => e.id === id);
        if (!src) return null;
        return this.save({ ...src, id: null, name: `${src.name} (copy)` });
    },

    async _write(list) {
        await DashieAuth.patchUserSetting(this.KEY, list);
        this._cache = list;
    },

    /** The flat account keys an engine selection resolves to — the ONLY shape the
     *  native runtime knows. Returns [dottedKey, value] pairs.
     *  NOTE: a TTS engine does NOT write voice.localTtsVoiceId — the voice is owned by
     *  the Voice & AI card. The caller re-seeds it after selection (the old voice may
     *  not exist on the newly-chosen box).
     *
     *  The mapping itself now lives in js/data/settings/engine-resolution.js and is
     *  GENERATED into engine-resolution.js (loaded before this file) and into Kotlin's
     *  EngineResolver.kt — the native picker performs the same resolution, so a second
     *  hand-written copy here would be exactly the drift surface JS_KOTLIN_CONTRACTS
     *  forbids. Contract #29. */
    resolveToSettings(engine) {
        return window.resolveEngineToSettings ? window.resolveEngineToSettings(engine) : [];
    },

    /** Which saved engine (if any) the current flat settings correspond to — the inverse
     *  of resolveToSettings, so the picker can show the engine's NAME as the selected row.
     *  Matched on url; for 'llm' also on model, since two Ollama presets can share one box.
     *  (TTS matches on url alone — the voice isn't part of the engine.) Null when the
     *  account is on cloud/HA/Android, or the URL matches no saved engine. */
    matchSelected(kind, defaults) {
        const d = defaults || {};
        // Keys come from the generated map (contract #29) rather than a second hand-written
        // copy of the same three kinds — Kotlin's selectedEngineName() is the mirror of THIS
        // function, so the two must not be able to disagree about which key holds the url.
        const spec = (window.ENGINE_RESOLUTION || {})[kind];
        if (!spec) return null;
        if (String(d[spec.providerKey] || '') !== spec.providerValue) return null;
        const url = String(d[spec.urlKey] || '').replace(/\/+$/, '');
        const of = this.cached(kind);
        if (!spec.modelKey) return of.find(e => e.url === url) || null;
        const model = String(d[spec.modelKey] || '');
        return of.find(e => e.url === url && (e.model || '') === model)
            || of.find(e => e.url === url)   // url matches, model drifted → still "this box"
            || null;
    },

    _uuid() {
        if (crypto?.randomUUID) return crypto.randomUUID();
        return 'eng-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    },
};

window.EnginesStore = EnginesStore;
