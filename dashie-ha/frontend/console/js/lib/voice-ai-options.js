/* ============================================================
   Voice & AI option descriptors
   ------------------------------------------------------------
   Single source for the component-card options on the Voice & AI
   settings page. Each option is { id, label, description, locality,
   cost, group?, comingSoon?, configFields? }.

   - locality: 'cloud' | 'local' — drives color: cloud rows shade
     light-orange, local rows light-green (COLOR = the strong swatch,
     BG = the row background tint). No icons; color only.
   - cost: a short human string (per-token + per-turn for models,
     per-unit for STT/TTS/Search; 'Free' for local/native).
   - group: optional section header within a card (model card groups
     by provider; STT/TTS/Search have none).
   - comingSoon: engines not yet wired to the runtime (Local LLM,
     SearXNG, bundled Whisper/Piper) — configurable now (storage-
     first), active once the L3 add-on brain ships.
   - configFields: revealed when the option is selected; each
     persists to its own account-level user_settings key.
   - installGuide: { url, label? } — renders an "Install ↗" badge-link
     on a still-selectable row. Used when there's no HA add-on to
     deep-link via _installRow (e.g. SearXNG — self-hosted anywhere).

   Model list + cost come live from window.AiModelCatalog so they
   never drift; STT/TTS/Search are small static tables here.
   ============================================================ */

const VoiceAiOptions = {
    // Strong swatch (tags, legend) + light row-background tint. One build-
    // independent palette: cloud locality is Dashie orange everywhere. (Until
    // 2026-07-30 the published build swapped in Chickadee's wing-blue — both
    // builds are Dashie now, so there is nothing to branch on.)
    COLOR: { cloud: '#f97316', local: '#16a34a' },
    BG: { cloud: 'rgba(249, 115, 22, 0.08)', local: 'rgba(22, 163, 74, 0.10)' },
    LABEL: { cloud: 'Cloud', local: 'Local' },

    // Who actually runs the hosted engines. Stated ONCE, here, and rendered as a
    // note on the Voice & AI page — deliberately not baked into the option labels,
    // where a supplier we later switch away from becomes a lie nobody notices
    // (TTS has already changed once). Same facts in the repo README.
    // Both builds show this: "which vendor hears my audio" is not a brand
    // question, and a self-hosting reader checking the cloud claim should be
    // able to find the answer without leaving the console.
    CLOUD_SUPPLIERS: [
        { stage: 'Speech-to-text', vendors: 'Deepgram' },
        { stage: 'Text-to-speech', vendors: 'Inworld, ElevenLabs for personality voices' },
    ],

    // ── pipeline presets (Open Brain plan §6) ─────────────────
    // The top-level Voice & AI selector: three Dashie Intelligence presets
    // (Cloud / Hybrid / Local) + HA Voice Assist. Stored in
    // voice.pipelinePreset; granular providers are seeded from the preset
    // and Customize lets them diverge. Cloud & Hybrid need credits OR a
    // BYO AI key (add-on API Keys page) — gated by the page, never a
    // silent charge.
    PRESETS: [
        { id: 'cloud', label: 'Cloud', locality: 'cloud', cost: 'Uses credits', needsCreditsOrKey: true,
          tagline: 'Best quality, zero setup',
          description: 'Anonymized cloud AI and voices, ready out of the box.' },
        { id: 'hybrid', label: 'Hybrid', locality: 'mixed', cost: 'Credits or your AI key', needsCreditsOrKey: true,
          tagline: 'Cloud AI · local voice',
          // Two-tone tagline: the cloud half renders in the cloud swatch, the
          // local half in the local swatch (picker falls back to `tagline`).
          taglineParts: [{ text: 'Cloud AI', locality: 'cloud' }, { text: 'local voice', locality: 'local' }],
          description: 'Cloud-quality AI with free, private voice engines on your own hardware.' },
        { id: 'local', label: 'Local', locality: 'local', cost: 'Free',
          tagline: 'Free & private',
          description: 'Your own AI model and voice engines. Nothing leaves your network.' },
        { id: 'ha_assist', label: 'HA Voice Assist', locality: 'local', cost: 'Free', haOnly: true,
          tagline: 'Home Assistant’s pipeline',
          description: 'Hand voice off to Home Assistant’s Assist pipeline, configured in HA.' },
    ],

    /** Filter a picker option list by the active preset (§6): Local hides
     *  cloud rows, Cloud hides local rows, Hybrid shows both minus the HA
     *  Assist pipeline row (va_default). HA Assist keeps the local rows
     *  (va_default = the Assist pipeline itself, plus Android/engine-direct
     *  overrides — e.g. speak HA's reply in the local Android voice) but no
     *  Dashie-cloud metered rows (John, 2026-07-12). */
    presetFilter(presetId, options) {
        if (presetId === 'local')  return options.filter(o => o.locality === 'local');
        if (presetId === 'cloud')  return options.filter(o => o.locality === 'cloud');
        if (presetId === 'hybrid') return options.filter(o => o.id !== 'va_default');
        if (presetId === 'ha_assist') return options.filter(o => o.locality === 'local');
        return options;
    },

    /**
     * Wake-word models (account default `ai.defaultWakeWord`; devices may override via
     * `aiVoice.wakeWord`, '' = follow the account — WS-G §13.2 two-slot).
     *
     * THE ONE console copy. The Devices page reads this too — do NOT re-declare it there.
     * (It used to have its own hand-copy in devices-detail-modals.js; a third copy is
     * exactly what JS_KOTLIN_CONTRACTS' tier rule exists to prevent.)
     *
     * The **ids** are the cross-boundary contract and are gated: `npm run lint:voice-options`
     * asserts they equal Kotlin's `WakeWordModel.availableModelIds()` (ALL_MODELS ∘
     * BUNDLED_MODEL_IDS) — the same catalog the `getAvailableWakeWords` bridge reports. So
     * this picker can never offer a word no APK bundles, nor hide one that every APK does.
     * Labels are ours; only ids must match.
     *
     * `ei_hey_dashie` is absent on purpose — internal Edge-Impulse model, not user-facing.
     */
    WAKE_WORDS: [
        { id: 'hey_dashie',      label: 'Hey Dashie' },
        // Standalone keyword, real in-house microWakeWord model (v0 dual-engine).
        // Predates the 2026-07-30 brand consolidation and is no longer any build's
        // default — kept because the weights ship and the id is a persisted wire
        // value (Kotlin WakeWordModel + wake_models/chickadee.*): removing it would
        // silently unset the wake word for anyone who chose it.
        { id: 'chickadee',       label: 'Chickadee' },
        { id: 'mww_okay_nabu',   label: 'Okay Nabu' },
        { id: 'mww_hey_jarvis',  label: 'Hey Jarvis' },
        { id: 'mww_hey_mycroft', label: 'Hey Mycroft' },
        { id: 'mww_alexa',       label: 'Alexa' },
    ],

    /** Display label for a persisted wake-word id ('' / unknown → ''). */
    wakeWordLabel(id) {
        return this.WAKE_WORDS.find(w => w.id === String(id || ''))?.label || '';
    },

    // Provider section order + display labels for the AI Model card.
    _PROVIDER_ORDER: ['gemini', 'claude', 'openai', 'bedrock'],
    _PROVIDER_LABEL: { claude: 'Claude', openai: 'OpenAI', gemini: 'Google Gemini', bedrock: 'Amazon Bedrock' },

    /** Model options: every cloud catalog model (grouped by provider) plus the
     *  local-LLM route. Cost prefers the live margined rate card (applyLiveRates)
     *  — what the user actually pays — falling back to the bundled raw catalog
     *  (AiModelCatalog.pricingFor) when the card hasn't loaded. */
    // Hermes add-on install/store deep-link (into the user's OWN HA — repository_url
    // makes it resolve even before the Dashie repo is added). Slug hash =
    // sha1('https://github.com/jwlerch78/dashie-ha-app')[:8] (supervisor store/utils.py).
    _HERMES_ADDON_URL: 'https://my.home-assistant.io/redirect/supervisor_addon/?addon=01f10a62_dashie_hermes&repository_url=https%3A%2F%2Fgithub.com%2Fjwlerch78%2Fdashie-ha-app',
    _HERMES_DOCS_URL: 'https://hermes-agent.nousresearch.com/docs/getting-started/quickstart',

    /** State-driven extras for the Hermes row (WS-I.3). `detection.hermes` comes from
     *  GET /api/voice/engines ({ installed, running, reachable, authed, url }); null in
     *  the website console (no add-on to probe). Returns { installGuide?, note? } that
     *  models() spreads onto the row so the badge + selected-row note track reality:
     *    not installed  → Install badge (add-on link for HA users, docs otherwise)
     *    installed/off  → "Open add-on ↗" (start it there) + note
     *    running/unreach→ "starting…" note (Re-scan)
     *    reachable/401  → "add API key" note (the bearer lives on the API Keys page)
     *    authed         → "✓ Ready" note (+ detected url). */
    _hermesRowExtras(detection) {
        const h = detection?.hermes;
        if (h?.installed) {
            if (!h.running) {
                return {
                    installGuide: { url: this._HERMES_ADDON_URL, label: 'Open add-on ↗' },
                    note: 'Add-on installed — open it, press Start, then add your Hermes API key under API Keys.',
                };
            }
            if (!h.reachable) return { note: 'Add-on starting… give it a moment, then Re-scan.' };
            if (!h.authed)   return { note: 'Add-on running — add your Hermes API key under API Keys to connect.' };
            return { note: `✓ Detected and ready${h.url ? ` at ${h.url}` : ''}.` };
        }
        // Not installed (add-on mode, detection ran) OR website console (no detection):
        // HA users get the add-on deep-link, everyone else the upstream install docs.
        if (DashieAuth?.isAddonMode || DashieAuth?.isHaUser) {
            return { installGuide: { url: this._HERMES_ADDON_URL, label: 'Install add-on ↗' } };
        }
        return { installGuide: { url: this._HERMES_DOCS_URL } };
    },

    /** @param {object} [detection] GET /api/voice/engines result — drives the Hermes
     *  row's install/setup state (add-on mode). Absent on the website console. */
    models(detection) {
        const C = window.AiModelCatalog;
        const all = C?.AI_MODEL_CATALOG || [];
        // "My Local LLM" leads the list — the privacy/local-first option (build plan §16.4).
        // Selecting it stores ai.model='local' (the route signal) + the endpoint/model config
        // fields; the integration + add-on read these to run the on-prem brain (§13.17).
        const out = [{
            id: 'local',
            label: 'My own AI (local / self-hosted)',
            group: 'Local',
            // BYO-model (Voice Master Plan WS-I): keep Dashie's cards/tools/dialog,
            // swap the model behind the brain — local Ollama/llama.cpp or any
            // OpenAI-compatible endpoint (remote URLs OK; add a key for remote).
            // Unlisted models bill $0 (managed STT/TTS still metered).
            description: `Point the brain at your own model — local Ollama / llama.cpp or any OpenAI-compatible endpoint. ${BRAND.productName} keeps its cards, tools & dialog; only the model changes.`,
            locality: 'local',
            cost: 'Free',
            // `required` fields keep the picker open on select until filled
            // (VoiceAiPage._needsConfig) — no reopen-to-configure dance.
            // `probe` + `fills`: Test (or an auto-probe on load) asks the box for its
            // model list and turns the named sibling field into a dropdown.
            configFields: [
                { key: 'voice.localLlmUrl', label: 'Endpoint URL', placeholder: 'http://192.168.1.50:11434', required: true,
                  probe: 'llm', fills: 'voice.localLlmModel' },
                { key: 'voice.localLlmModel', label: 'Model', placeholder: 'qwen3:8b', required: true },
                { key: 'voice.localLlmKey', label: 'API key (optional)', type: 'password', placeholder: 'for remote endpoints' },
            ],
        }];
        /* ── Hermes Agent row — SOFT-REMOVED 2026-07-17 ──────────────────────────────
         * Hermes is no longer offered as an AI ENGINE (we may revisit it for its MEMORY, not
         * as a brain). Hiding the picker row is the only user-facing change; the plumbing is
         * left DORMANT and intact: the ai.model='hermes' sentinels in voice-ai.js, the
         * voice.hermesUrl setting, _hermesRowExtras / _HERMES_ADDON_URL / _HERMES_DOCS_URL below,
         * and the account-config brain routing all remain. To RESTORE, push this object back
         * into `out` above.
        {
            id: 'hermes',
            label: 'Hermes Agent (self-hosted)',
            group: 'Local',
            description: `Nous Research’s open-source personal agent behind ${BRAND.productName}’s brain — persistent memory and self-built skills, running on your own hardware. Add its API key under API Keys.`,
            locality: 'local',
            cost: 'Free',
            ...this._hermesRowExtras(detection),
            configFields: [
                { key: 'voice.hermesUrl', label: 'Hermes endpoint URL', placeholder: 'http://homeassistant.local:8642', required: true },
            ],
        },
        ──────────────────────────────────────────────────────────────────────────── */
        // Saved own-AI engines replace the generic "My own AI" inline-URL row.
        const withEngines = this.withSavedEngines('llm', out, 'local');
        out.length = 0;
        out.push(...withEngines);
        for (const prov of this._PROVIDER_ORDER) {
            for (const m of all.filter(x => x.provider === prov)) {
                const live = this._liveModelRates?.[m.id];   // margined, from rate card
                const p = live ? [live.input, live.output] : C.pricingFor(m.id);   // [inPer1M, outPer1M] | null
                out.push({
                    id: m.id,
                    label: m.name,
                    description: m.description || '',
                    locality: 'cloud',
                    cost: p ? this._modelCost(p) : '',
                    group: this._PROVIDER_LABEL[prov] || prov,
                    // BYO-key provider (gemini|claude|openai|bedrock) — the page marks the
                    // row `keyed` when a key for this provider is stored (Open Brain §5), so
                    // it shows the key icon + "API account" instead of a per-turn cost.
                    provider: prov,
                });
            }
        }
        return out;
    },

    // Engine domain (matches Kotlin VoicePreferences + the runtime voice providers):
    // dashie_cloud = fixed cloud vendor; va_default = the device's Home Assistant
    // voice pipeline; android_voice = on-device. `haOnly` options are hidden for
    // non-HA accounts (gated on DashieAuth.isHaUser by the page).
    // Base STT rows that always exist regardless of detection. The detected
    // engine-direct row (ha_engine, labeled "Whisper (Home Assistant)") is
    // injected by sttOptions() when /api/voice/engines finds a Whisper engine.
    STT: [
        // Supplier names deliberately NOT in the label — suppliers change (TTS
        // already has once) and a stale vendor name in a picker is worse than no
        // vendor name. Who currently processes cloud audio is disclosed in the
        // repo README and on the Voice & AI page's suppliers note.
        { id: 'dashie_cloud',
          label: `${BRAND.cloudName} STT`,
          locality: 'cloud', cost: '$0.036/min · ~0.3¢/command',
          description: 'Streaming, premium accuracy.' },
        { id: 'local_stt_url', label: 'Local Whisper (your box)', locality: 'local', cost: 'Free',
          description: 'Whisper server on your own box (OpenAI-compatible, LAN, direct).',
          configFields: [
            { key: 'voice.localSttUrl', label: 'Whisper box URL', placeholder: 'http://192.168.1.50:8000', probe: 'stt', required: true },
          ] },
        { id: 'va_default', label: 'Home Assistant', locality: 'local', cost: 'Free', haOnly: true,
          description: "Your Home Assistant voice pipeline's speech-to-text." },
        // "On-Device" family (grouped in the picker). Native = the OS SpeechRecognizer
        // (Google-services devices only, plays a chime); Fast/Accurate = bundled sherpa-onnx,
        // fully offline, no chime, works on Amazon Fire / Echo / de-Googled devices too.
        { id: 'android_voice', label: 'On-Device (Native)', locality: 'local', cost: 'Free',
          description: 'Built-in device speech recognizer.' },
        { id: 'sherpa_moonshine_tiny', label: 'On-Device (Fast)', locality: 'local', cost: 'Free',
          description: 'Bundled offline STT — faster & lighter.' },
        { id: 'sherpa_moonshine_base', label: 'On-Device (Accurate)', locality: 'local', cost: 'Free',
          description: 'Bundled offline STT — higher accuracy.' },
    ],

    // Base TTS rows that always exist. The detected engine-direct row (ha_engine,
    // labeled "Piper (Home Assistant)") is injected by ttsOptions() when
    // detection finds a Piper engine on HA.
    TTS: [
        // cost is a fallback estimate — applyLiveRates() overwrites the rate from
        // the server's margined rate card. Two engines behind one row: the
        // default Dashie voice runs on Inworld (~4× cheaper per character);
        // personality voices are premium ElevenLabs.
        // Supplier names deliberately NOT in the label — see the STT row above.
        { id: 'dashie_cloud',
          label: `${BRAND.cloudName} TTS`,
          locality: 'cloud', cost: '$0.09–0.33/1k chars · ~0.5–1.9¢/reply',
          description: `The default ${BRAND.assistantName} voice is the most economical; personality voices are premium.` },
        { id: 'local_url', label: 'Local TTS (your box)', locality: 'local', cost: 'Free',
          description: 'Kokoro / OpenAI-compatible TTS on your own box (LAN, direct).',
          configFields: [
            { key: 'voice.localTtsUrl', label: 'TTS box URL', placeholder: 'http://192.168.1.50:8880', probe: 'tts', required: true,
              fills: 'voice.localTtsVoiceId' },
            { key: 'voice.localTtsVoiceId', label: 'Voice', placeholder: 'af_heart' },
          ] },
        { id: 'va_default', label: 'Home Assistant', locality: 'local', cost: 'Free', haOnly: true,
          description: "Your Home Assistant voice pipeline's text-to-speech." },
        { id: 'android_voice', label: 'On-Device (Native)', locality: 'local', cost: 'Free',
          description: 'Built-in device text-to-speech.' },
    ],

    // ── detection-gated option builders ──────────────────────
    // Turn the static base rows into the live option set for the picker, adding
    // the engine-direct HA row (provider id `ha_engine`, transport-named — NOT
    // engine-named; the engine itself is carried in haTtsEngineId/haSttEngineId)
    // ONLY when detection found a matching engine, and upgrading free-text voice
    // fields to dropdowns when detection returned a voice list. `detection` =
    // GET /api/voice/engines ({ available, tts, stt, kokoro }) or null (no HA /
    // cloud mode). See build plan 20260708 §5.2. Decision §11.1: a single
    // canonical "…(Home Assistant)" row bound to the first matching engine; the
    // label names the common engine (Piper/Whisper) for humans, the id is the
    // transport so one native client serves any HA engine.

    _matchEngine(list, re) {
        if (!Array.isArray(list)) return null;
        return list.find(e => re.test(String(e.engine_id || '')) || re.test(String(e.name || ''))) || null;
    },

    // ── saved local engines (Local Engines page) ─────────────
    // A saved engine renders as a NAMED row (id `engine:<uuid>`) in the picker;
    // choosing it resolves to the flat account keys the tablets read
    // (EnginesStore.resolveToSettings) — the device never sees the registry.
    // When the user has saved engines of a kind, they REPLACE that kind's inline
    // URL row (own-box TTS/STT, "My own AI") — the address now lives on the
    // Local Engines page, so the picker stays uncluttered. With none saved (or
    // off-add-on, where engines can't be probed) the inline row stays exactly as
    // it is today, so nobody loses the ability to just type a URL.

    ENGINE_ROW_PREFIX: 'engine:',

    /** Saved engines of a kind, as picker rows. */
    savedEngineRows(kind) {
        const S = window.EnginesStore;
        if (!S || !DashieAuth?.isAddonMode) return [];
        return S.cached(kind).map(e => ({
            id: `${this.ENGINE_ROW_PREFIX}${e.id}`,
            label: e.name,
            locality: 'local',
            cost: 'Free',
            group: kind === 'llm' ? 'Local' : undefined,
            description: [e.url, e.model].filter(Boolean).join(' · '),
            engineRecord: e,
        }));
    },

    /** The "no engines saved yet" row: a pointer to the Local Engines page rather
     *  than a dead end. Not selectable (like an install row). */
    _addEngineRow(kind, label) {
        return {
            id: `${this.ENGINE_ROW_PREFIX}add`,
            label,
            locality: 'local',
            cost: 'Free',
            group: kind === 'llm' ? 'Local' : undefined,
            description: 'Run your own AI, voice, or speech-to-text — add it once and it shows up here by name.',
            navigateTo: 'local-engines',
        };
    },

    /** Splice saved engines into a picker list, replacing the inline-URL row for that
     *  kind. Off-add-on (or when EnginesStore is absent) the list is returned as-is. */
    withSavedEngines(kind, options, inlineRowId) {
        if (!DashieAuth?.isAddonMode || !window.EnginesStore) return options;
        const saved = this.savedEngineRows(kind);
        const rows = saved.length ? saved : [this._addEngineRow(kind, this._ADD_LABEL[kind])];
        const out = [];
        for (const o of options) {
            if (o && o.id === inlineRowId) out.push(...rows);   // inline URL row → engine rows
            else out.push(o);
        }
        return out;
    },

    _ADD_LABEL: {
        tts: '+ Add a local voice',
        stt: '+ Add local speech-to-text',
        llm: '+ Add my own AI',
    },

    /** TTS option list in the §3 order: cloud, Piper (if detected), your-box, HA
     *  pipeline, Android. */
    ttsOptions(detection) {
        const base = Object.fromEntries(this.TTS.map(o => [o.id, o]));
        // Order mirrors STT: cloud → On-Device → HA → +Add local voice (bottom). local_url is
        // the inline "+ Add a local voice" row, so putting it last lands the Add row at the bottom.
        const out = [base.dashie_cloud, base.android_voice, this._piperOption(detection),
                     base.va_default, this._localUrlOption(base.local_url, detection)];
        return this.withSavedEngines('tts', out.filter(Boolean), 'local_url');
    },

    /** STT option list in the §3 order: cloud, Whisper (if detected), your-box,
     *  HA pipeline, Android. */
    sttOptions(detection) {
        const base = Object.fromEntries(this.STT.map(o => [o.id, o]));
        // Order: cloud → On-Device family (Fast/Accurate/Native) → HA → +Add local (bottom).
        // local_stt_url is the inline "+ Add local speech-to-text" row (withSavedEngines swaps
        // it in place), so putting it last lands the Add row at the bottom.
        const out = [base.dashie_cloud,
                     base.sherpa_moonshine_tiny, base.sherpa_moonshine_base, base.android_voice,
                     this._whisperOption(detection), base.va_default, base.local_stt_url];
        return this.withSavedEngines('stt', out.filter(Boolean), 'local_stt_url');
    },

    /** Piper (Home Assistant) engine-direct TTS row — only when a Piper TTS engine
     *  is detected. Provider id is the transport (`ha_engine`), engine carried in
     *  engineId → voice.haTtsEngineId. Voice field is a dropdown from the engine's
     *  voices, else free-text. */
    // Piper quality suffix → friendly label (John, 2026-07-13). Piper names its
    // voices <speaker>-<low|medium|high> by synthesis speed/quality; relabel to
    // what the user cares about.
    _PIPER_QUALITY: { low: 'fast', med: 'balanced', medium: 'balanced', high: 'high quality' },

    /** Prettify a Piper voice for display: capitalize the speaker and relabel the
     *  quality suffix (low→fast, medium→balanced, high→high quality). Handles both
     *  HA's "amy (low)" name form and the raw "en_US-amy-low" voice id. Leaves a
     *  non-Piper-shaped name alone apart from a leading capital. Display-only — the
     *  stored value stays the real voice_id. */
    _piperVoiceLabel(name, voiceId) {
        const src = String(name || voiceId || '');
        let speaker = null, quality = null;
        const paren = src.match(/^(.*?)\s*\((low|med|medium|high)\)\s*$/i);
        if (paren) { speaker = paren[1].trim(); quality = paren[2].toLowerCase(); }
        else {
            const parts = String(voiceId || '').split('-');
            const q = parts[parts.length - 1]?.toLowerCase();
            if (parts.length >= 2 && this._PIPER_QUALITY[q]) { quality = q; speaker = parts.slice(1, -1).join('-') || parts[0]; }
        }
        if (!speaker || !quality) return src ? src.charAt(0).toUpperCase() + src.slice(1) : src;
        return `${speaker.charAt(0).toUpperCase()}${speaker.slice(1)} (${this._PIPER_QUALITY[quality] || quality})`;
    },

    // ── voice-language narrowing ─────────────────────────────
    // A local TTS box offers every language it knows (Piper ships 163 voices across ~30
    // languages), which is unusable as a dropdown. Narrow to the account's language
    // (general.language, BCP-47 e.g. 'en-US') — but NEVER to an empty list: Piper has no
    // Japanese or Korean voices at all, and no exact es-US, so the ladder degrades
    // exact locale → language family → everything (with a note), rather than stranding
    // the user with nothing to pick.

    /** Kokoro encodes language in the voice id's first letter (af_heart = American
     *  female; jf_alpha = Japanese female) — a different scheme from Piper's `en_US-…`.
     *  Map it to a language family so one filter serves both engines. */
    _KOKORO_LANG: { a: 'en', b: 'en', e: 'es', f: 'fr', h: 'hi', i: 'it', j: 'ja', p: 'pt', z: 'zh' },

    // …and to a human accent, so the picker can say "Nicole (American female)" instead of
    // dumping the raw id `af_nicole` on the user.
    _KOKORO_ACCENT: { a: 'American', b: 'British', e: 'Spanish', f: 'French', h: 'Hindi',
                      i: 'Italian', j: 'Japanese', p: 'Portuguese', z: 'Mandarin' },

    /** Human label for a local-engine voice id. Both engines encode everything the user
     *  cares about IN the id, so decode it rather than showing `af_nicole` / `en_US-amy-low`:
     *    Kokoro `af_nicole`      → "Nicole (American female)"
     *    Piper  `en_US-amy-low`  → "Amy (fast)"      (see _piperVoiceLabel)
     *  Anything unrecognized keeps whatever label the engine gave us. */
    localVoiceLabel(value, fallback) {
        const id = String(value || '');
        const kokoro = id.match(/^([abefhijpz])([fm])_(.+)$/);
        if (kokoro) {
            const [, lang, gender, name] = kokoro;
            const accent = this._KOKORO_ACCENT[lang] || '';
            const who = [accent, gender === 'm' ? 'male' : 'female'].filter(Boolean).join(' ');
            const pretty = name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ');
            return who ? `${pretty} (${who})` : pretty;
        }
        if (/^[a-z]{2}_[A-Z]{2}-/.test(id)) return this._piperVoiceLabel(fallback, id);
        return fallback || id;
    },

    /** The language of a voice option: its `language` field (piper shim → 'en_US'),
     *  else parsed from the id — 'en_US-amy-low' → 'en_US', 'af_heart' → 'en'. Null when
     *  the shape is unrecognized (an option we must never filter away). */
    voiceLanguage(opt) {
        const explicit = String(opt?.language || '').replace('-', '_');
        if (explicit) return explicit;
        const id = String(opt?.value || '');
        const piper = id.match(/^([a-z]{2}_[A-Z]{2})-/);
        if (piper) return piper[1];
        const kokoro = id.match(/^([abefhijpz])[fm]_/);
        if (kokoro) return this._KOKORO_LANG[kokoro[1]] || null;
        return null;
    },

    /** Narrow a probed voice list to `locale` (e.g. 'en-US') and give every entry a human
     *  label. Returns { options }. The ladder — exact locale → language family → everything
     *  — can never yield an empty picker (Piper has no Japanese voices at all; Kokoro's ids
     *  only carry a language family, never a region, so `en-US` lands on the family rung for
     *  every Kokoro user). It does so SILENTLY: an explanatory note fired on the common path
     *  and just read as clutter (John, 2026-07-14). Options with no detectable language are
     *  always kept — a list we can't parse must not vanish. */
    filterVoicesByLanguage(options, locale) {
        const all = (Array.isArray(options) ? options : [])
            .map(o => ({ ...o, label: this.localVoiceLabel(o.value, o.label) }));
        const loc = String(locale || '').trim();
        if (!all.length || !loc || loc === 'system') return { options: all };
        const want = loc.replace('-', '_');            // en-US → en_US
        const family = want.split('_')[0];             // en
        const langOf = o => this.voiceLanguage(o);
        const unknown = all.filter(o => !langOf(o));   // never filtered away

        const exact = all.filter(o => langOf(o) === want);
        if (exact.length) return { options: [...exact, ...unknown] };

        // No exact locale (Piper has es_MX/es_AR but no es_US; Kokoro only ever says "en") →
        // same language, any region.
        const fam = all.filter(o => String(langOf(o) || '').split('_')[0] === family);
        if (fam.length) return { options: [...fam, ...unknown] };

        // The engine has nothing in this language at all → show everything rather than an
        // empty picker.
        return { options: all };
    },

    _piperOption(detection) {
        const eng = this._matchEngine(detection?.tts, /piper/i);
        if (eng) {
            const voices = (eng.voices || []).map(v => ({ value: v.voice_id, label: this._piperVoiceLabel(v.name, v.voice_id) }));
            const voiceField = voices.length
                ? { key: 'voice.haTtsVoiceId', label: 'Voice', type: 'select', options: voices }
                : { key: 'voice.haTtsVoiceId', label: 'Voice', placeholder: 'en_US-lessac-medium' };
            return {
                id: 'ha_engine', label: 'Piper (Home Assistant)', locality: 'local', cost: 'Free', haOnly: true,
                engineId: eng.engine_id,
                description: 'Your Home Assistant Piper voice — direct, no Assist pipeline.',
                note: "Local voices don't change per personality — pick one voice here.",
                configFields: [voiceField],
            };
        }
        // Probed HA but no Piper → advertise it as installable (guided deep-link).
        // Detection absent (cloud mode) → hide; haOnly hides it for non-HA accounts.
        if (detection?.available !== true) return null;
        return this._installRow('ha_engine', 'Piper (Home Assistant)', 'core_piper',
            'Free, natural local voices via Home Assistant. Install the Piper add-on to enable.');
    },

    /** Whisper (Home Assistant) engine-direct STT row — selectable when a Whisper STT
     *  engine is detected, else an install row (deep-link) when HA was probed. Provider
     *  id is the transport (`ha_engine`), engine carried in engineId → voice.haSttEngineId. */
    _whisperOption(detection) {
        const eng = this._matchEngine(detection?.stt, /whisper/i);
        if (eng) {
            return {
                id: 'ha_engine', label: 'Whisper (Home Assistant)', locality: 'local', cost: 'Free', haOnly: true,
                engineId: eng.engine_id,
                description: 'Your Home Assistant Whisper speech-to-text — direct, no Assist pipeline.',
            };
        }
        if (detection?.available !== true) return null;
        return this._installRow('ha_engine', 'Whisper (Home Assistant)', 'core_whisper',
            'Free local speech-to-text via Home Assistant. Install the Whisper add-on to enable.');
    },

    /** A not-yet-installed engine row: shown for HA users when detection probed HA but
     *  the engine is absent. Renders an "Install" badge that deep-links to the official
     *  add-on (my.home-assistant.io redirect → the add-on page in the user's OWN HA,
     *  regardless of their URL). Not selectable — click opens install; Re-scan after. */
    _installRow(id, label, addonSlug, description) {
        return {
            id, label, locality: 'local', cost: 'Free', haOnly: true, description,
            install: { addon: addonSlug, url: `https://my.home-assistant.io/redirect/supervisor_addon/?addon=${addonSlug}` },
        };
    },

    /** Local TTS (your box): upgrade the free-text Voice field to a dropdown when
     *  our Kokoro add-on was detected and exposed a voice list; else unchanged. */
    _localUrlOption(base, detection) {
        if (!base) return null;
        const raw = detection?.kokoro?.voices || [];
        const voices = raw.map(v => (typeof v === 'string' ? { value: v, label: v } : { value: v.voice_id, label: v.name || v.voice_id }));
        if (!voices.length) return base;
        const fields = base.configFields.map(f =>
            f.key === 'voice.localTtsVoiceId' ? { ...f, type: 'select', options: voices } : f);
        return { ...base, configFields: fields };
    },

    SEARCH: [
        { id: 'dashie', label: `${BRAND.cloudName} Search`, locality: 'cloud', cost: '$0.0096/search',
          description: 'Managed web search — no setup.' },
        // SearXNG hidden for MVP (John, 2026-07-12): it's a "your box"-style
        // self-hosted install (no HA add-on to deep-link, no detection) and isn't
        // wired to the runtime yet (search is Tavily-only until the L3 add-on
        // brain). Re-enable by uncommenting — the cards' installGuide support
        // (Install ↗ docs badge on a selectable row) stays in place.
        // { id: 'searxng', label: 'SearXNG (self-hosted)', locality: 'local', cost: 'Free', comingSoon: true,
        //   description: 'Your own metasearch instance — private, no per-search cost.',
        //   installGuide: { url: 'https://docs.searxng.org/admin/installation.html' },
        //   note: 'Enable the JSON API on your instance — add "json" to search.formats in settings.yml — so Dashie can query it.',
        //   configFields: [{ key: 'voice.searxngUrl', label: 'SearXNG instance URL', placeholder: 'http://192.168.1.50:8080' }] },
    ],

    // Sports has a single source today (free ESPN). Listing it makes clear that
    // sports questions don't run through paid web search.
    SPORTS: [
        { id: 'espn', label: 'ESPN', locality: 'cloud', cost: 'Free — not billed',
          description: 'Live scores & schedules. Sports questions use ESPN, not web search.' },
    ],

    // Image-search (Serper / Google Images) per-search cost string for the
    // "Retrieve pictures" toggle. Fallback from the raw catalog ($1/1000,
    // pre-margin); applyLiveRates overwrites with the margined rate card.
    imageSearchCost: '$0.009',

    // ── live rate card ───────────────────────────────────────

    /** Overwrite the paid-provider rate strings with the server's rate card
     *  (get_credit_rates), which returns amounts ALREADY MARGINED — what the
     *  user actually pays. The hardcoded strings above are offline fallbacks
     *  and the per-reply "~0.5–1¢" estimate is intentionally static. Best-effort:
     *  rendering never blocks on failure, and repeat calls are no-ops. */
    _liveRatesApplied: false,
    _liveModelRates: null,   // { modelId: {input, output} } margined per 1M — read by models()
    async applyLiveRates() {
        if (this._liveRatesApplied) return;
        try {
            // BARE DashieAuth (top-level const, not on window) — window.DashieAuth
            // is undefined, which silently no-op'd the live rate card (fell back to
            // the hardcoded estimate strings). Same root cause as the installGuide gate.
            const res = await DashieAuth?.dbRequest('get_credit_rates', {});
            if (res?.models && typeof res.models === 'object') {
                this._liveModelRates = res.models;
            }
            const rates = res?.rates;
            const amt = (svc) => {
                if (!Array.isArray(rates)) return null;
                const r = rates.find(x => x.service === svc)?.rates?.[0]?.amount;
                return (typeof r === 'number' && r > 0) ? r : null;
            };
            // Value-based charge rates (server `charge_rates`) are the price we
            // actually bill — the single source of truth. Format them into the
            // per-reply / per-command estimates the option rows show, so a rate
            // hot-edit flows straight through here (no more hardcoded drift).
            // Reference lengths for the estimate: a typical spoken reply/command.
            const REPLY_CHARS = 57, CMD_SEC = 5;
            const cr = res?.charge_rates;
            const t = cr?.tts;
            if (t && typeof t.inworld_per_1k === 'number' && typeof t.character_per_1k === 'number') {
                // Basic (Inworld) → character (surcharged ElevenLabs) span. Per-reply
                // from a typical reply length; the /1k rate is the exact billed unit.
                const lo = this._cents(t.inworld_per_1k * REPLY_CHARS / 1000);
                const hi = this._cents(t.character_per_1k * REPLY_CHARS / 1000);
                this.TTS.find(o => o.id === 'dashie_cloud').cost =
                    `$${t.inworld_per_1k.toFixed(2)}–$${t.character_per_1k.toFixed(2)}/1k chars · ${lo}–${hi}/reply`;
            } else {
                const tts = amt('tts');
                if (tts) this.TTS.find(o => o.id === 'dashie_cloud').cost = `up to $${tts.toFixed(2)}/1k chars · ~0.1–1¢/reply`;
            }
            if (typeof cr?.stt?.per_min === 'number') {
                const perCmd = this._cents(cr.stt.per_min * CMD_SEC / 60);
                const stt = this.STT.find(o => o.id === 'dashie_cloud');
                if (stt) stt.cost = `$${cr.stt.per_min.toFixed(3)}/min · ${perCmd}/command`;
            }
            if (typeof cr?.image_search?.per_unit === 'number') {
                this.imageSearchCost = this._usd(cr.image_search.per_unit);
            } else {
                const image = amt('image_search');
                if (image) this.imageSearchCost = this._usd(image);
            }
            const search = amt('web_search');   // web search stays cost-plus (not in charge_rates)
            if (search) this.SEARCH.find(o => o.id === 'dashie').cost = `${this._usd(search)}/search`;
            this._liveRatesApplied = true;
        } catch (e) {
            console.warn('[VoiceAiOptions] rate card unavailable, keeping fallback estimates:', e?.message || e);
        }
    },

    // ── cost formatting ──────────────────────────────────────

    _modelCost(p) {
        const [inR, outR] = p;   // per 1M tokens
        return `$${inR}/$${outR} per 1M`;
    },
    /** USD, trimmed of trailing zeros ($0.009, $0.0096) — for the value-based
     *  per-unit rates the user wants shown as dollars, not cents. */
    _usd(n) { return '$' + parseFloat(Number(n).toFixed(4)); },
    _cents(usd) {
        if (!usd) return 'free';
        const c = usd * 100;
        return c < 1 ? `~${c.toFixed(2)}¢` : `~${c.toFixed(1)}¢`;
    },
};

window.VoiceAiOptions = VoiceAiOptions;
