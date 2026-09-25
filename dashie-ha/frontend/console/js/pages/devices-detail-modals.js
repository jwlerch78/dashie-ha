/* ============================================================
   Devices Detail — Display section body + modals
   ------------------------------------------------------------
   Mirrors the Kotlin DisplayPageSchema: three sub-section cards
   (Dashboard / Screen Management / Display Preferences) each
   containing summary-rows. Click → modal in this file. Inline
   toggles (Animations) skip the modal layer.

   Modal taxonomy:
     - Sleep modal: composite (mode + schedule + inactivity + options)
     - Theme modal: theme family + dark mode
     - Screensaver modal: timeout + mode + per-mode options
     - Picker modal: generic single-setting picker, reused for
       Layout / Orientation / Animation Level / Wake Mode / Zooms /
       Sidebar Icon Size / Screen Off Behavior

   Persistence: every write goes through DevicesPage._onSettingChange,
   same broadcast path the inline form-grid used to use.
   ============================================================ */

const DevicesDetailModals = {

    // ── Option catalogs (mirror Kotlin DisplayPageSchema) ──────

    LAYOUT_MODES: [
        ['widgets', 'Widgets'],
        ['single_panel', 'Single Panel'],
        ['kiosk', 'Kiosk mode (HA-only)'],
    ],
    // Kiosk is NOT console-settable — the Kotlin bridge setLayoutMode rejects
    // anything but widgets/single_panel, so offering it made the write revert.
    // Full LAYOUT_MODES stays for label lookup; the picker uses this subset. When
    // a device is already in kiosk, the row renders read-only (see below).
    WRITABLE_LAYOUT_MODES: [
        ['widgets', 'Widgets'],
        ['single_panel', 'Single Panel'],
    ],

    ORIENTATION_MODES: [
        ['auto', 'Auto'],
        ['landscape', 'Landscape'],
        ['landscape_reverse', 'Landscape (reversed)'],
        ['portrait', 'Portrait'],
        ['portrait_reverse', 'Portrait (reversed)'],
    ],

    THEME_FAMILIES: [
        // BEGIN GENERATED theme-families — gen-console-theme-swatches.mjs
        ['default', 'Default'],
        ['marigold', 'Marigold'],
        ['fern', 'Fern'],
        ['orchid', 'Orchid'],
        ['blue', 'Blue'],
        ['halloween', 'Halloween'],
        ['christmas', 'Christmas'],
        // END GENERATED theme-families
    ],

    ANIMATION_LEVELS: [
        ['high', 'High'],
        ['low', 'Low'],
    ],

    WAKE_MODES: [
        ['disabled', 'Touch Only'],
        ['brightness', 'Brightness Sensor'],
        ['camera', 'Motion (Camera)'],
        ['face', 'Face Detection (Camera)'],
    ],

    ZOOM_LEVELS: [
        ['50', '50%'], ['75', '75%'], ['90', '90%'], ['100', '100%'],
        ['110', '110%'], ['125', '125%'], ['150', '150%'],
        ['175', '175%'], ['200', '200%'],
    ],

    // Mirror Kotlin DisplayPageSchema displaySizeSubScreen — scales
    // native chrome (sidebar, control center, music/video/voice cards).
    DISPLAY_SIZES: [
        ['100', '100%'], ['125', '125%'], ['150', '150%'],
        ['175', '175%'], ['200', '200%'],
    ],

    // Mirror Kotlin DisplayPageSchema font_size_picker — scales widget text.
    FONT_SIZES: [
        ['75', '75%'], ['100', '100%'], ['125', '125%'], ['150', '150%'],
    ],

    SIDEBAR_ICON_SIZES: [
        ['0.75', 'Very Small'],
        ['0.9', 'Small'],
        ['1', 'Medium'],
        ['1.15', 'Large'],
        ['1.3', 'Extra Large'],
    ],

    SCREEN_OFF_BEHAVIORS: [
        ['black_overlay', 'Black Overlay'],
        ['power_off', 'Power Off Screen'],
    ],

    SCREENSAVER_TIMEOUTS: [
        ['0', 'Off'], ['10', '10 sec'], ['30', '30 sec'],
        ['60', '1 min'], ['120', '2 min'], ['300', '5 min'],
        ['600', '10 min'], ['1800', '30 min'],
    ],

    SCREENSAVER_MODES: [
        ['dim', 'Dim'],
        ['black', 'Black Overlay'],
        ['off', 'Screen Off'],
        ['photos', 'Photos'],
        ['weather', 'Weather & Time'],
    ],

    // Wake words now come from VoiceAiOptions.WAKE_WORDS — ONE console copy, shared with
    // the Voice & AI page, whose ids are lint-gated against Kotlin's WakeWordModel
    // (npm run lint:voice-options). This used to be a second hand-copy here, carrying the
    // comment "Mirror Kotlin WakeWordModel.BUNDLED_MODEL_IDS" — i.e. a hand-mirror that
    // nothing checked. Don't reintroduce it.
    get WAKE_WORDS() {
        return window.VoiceAiOptions?.WAKE_WORDS || [];
    },

    // ── Account-settings cache (for ai.wakeWord and other account-wide
    //    fields we surface read/edit from the device detail page) ─────

    // 🔴 NOT a field any more — an accessor over AccountSettingsStore, so the CARD
    // and this MODAL read ONE cache. Two copies of the household on one page drift
    // the moment one refreshes, and the visible symptom is the card's diff dot
    // being wrong, which gets hunted in the renderer instead of the state.
    // The name is kept because ~10 call sites and the gate read it.
    get _accountSettings() { return window.AccountSettingsStore?.get() ?? null; },
    set _accountSettings(v) { window.AccountSettingsStore?.set(v); },

    /** Lazy-load user_settings the first time something on this page needs
     *  an account-level field. Re-render when the load resolves so the
     *  Voice section's Wake Word row swaps from "—" to the real value. */
    ensureAccountSettings() { window.AccountSettingsStore?.ensure(); },

    /**
     * The household's default wake word — what a device with no override follows.
     *
     * Reads `ai.defaultWakeWord` (ACCOUNT default, WS-G §13.2). It used to read
     * `ai.wakeWord`, which since D5 is the DEVICE-scoped key and does not live in
     * user_settings at all — so this returned '' for every household and the Devices
     * page's "Account default" always rendered blank. Nothing errored; it just showed
     * nothing, forever. (Kiosk-mirror audit #5, the second half.)
     */
    getAccountWakeWord(device) {
        // ⚠️ No callers today (the picker resolves its own inherit label). Routed
        // through the profile layer anyway so re-using it cannot reintroduce a read
        // of a layer the household may no longer be following.
        return this._inherited('aiVoice', 'wakeWord', this._accountSettings?.ai?.defaultWakeWord, device);
    },

    // ── Per-device voice pipeline (mixed-fleet, John ruled 2026-08-25) ───────
    //
    // The five LEAF keys a device may override. D2 as ruled: leaves only —
    // pipelinePreset / controlMethod / agentMode / conversationModel are NOT
    // per-device, because a stored per-device preset re-opens the
    // stale-controlMethod flip-flop class with more copies.
    //
    // 🔴 CROSS-REPO MIRROR of `OVERRIDE_SPECS.voice` in the staging webapp
    // (js/data/settings/override-resolution.js). The two repos cannot share a
    // module, so this list is gated instead: staging's `lint:overrides` reads
    // THIS array and fails when the two disagree. Registered as CONTRACTS #78.
    // If you add a key here, add it there — the gate will tell you if you don't.
    VOICE_LEAF_KEYS: ['sttProvider', 'ttsProvider', 'haSttEngineId', 'haTtsEngineId', 'haTtsVoiceId'],

    /**
     * What voice setup is THIS device actually running?
     *
     * ⭐ Derived by COMPARISON, never by inverting the preset→leaves table.
     * `selectPreset()` owns the forward map (preset ⇒ leaf values) and is one of
     * the three copies contract #43 governs; hand-writing the inverse here would
     * make a fourth copy that can silently disagree with all of them. Instead:
     *   · no leaf overridden, or every override equals the account's value
     *       → this device runs the household setup → show the account's preset
     *   · any override differing from the account
     *       → "Custom", which is the honest answer and needs no mapping at all
     *
     * That is also the question a mixed-fleet owner is actually asking — "is this
     * one following the house, or is it special?" — rather than a preset name we
     * would have to reverse-engineer.
     *
     * @returns {{label: string, custom: boolean, overriddenKeys: string[]}}
     */
    voiceSetupSummary(device) {
        this.ensureAccountSettings();
        const acct = this._accountSettings?.voice || {};
        const dev = device?.settings?.voice || {};

        // '' is the INHERIT sentinel, not a value — an inheriting device may carry
        // the empty string rather than an absent key, and treating it as an
        // override would render every reset device as "Custom".
        // 🔴 Compared against the INHERITED value, not the raw account one. Under a
        // profile those differ, and comparing to the account layer marks a device
        // "Custom" for matching a value it is not following — or, worse, clears the
        // badge on a device that genuinely differs from its profile.
        const overriddenKeys = this.VOICE_LEAF_KEYS.filter(
            (k) => typeof dev[k] === 'string' && dev[k] !== ''
                && dev[k] !== this._inherited('voice', k, acct[k], device)
        );

        if (overriddenKeys.length > 0) {
            return { label: 'Custom', custom: true, overriddenKeys };
        }
        const presetId = acct.pipelinePreset || '';
        const preset = (window.VoiceAiOptions?.PRESETS || []).find((p) => p.id === presetId);
        // No account preset yet (a household that has never opened Voice & AI) →
        // '—', matching how the Wake Word row renders an unsynced device. Do NOT
        // invent a default here: guessing "Cloud" would state a household setting
        // that does not exist.
        return { label: preset ? preset.label : (presetId || '—'), custom: false, overriddenKeys: [] };
    },

    // ── §4.4 capability gate (built 2026-08-28, now that a writer exists) ────
    //
    // The rule, John's ruling 2026-08-25: a device that publishes NO capabilities
    // gets its override affordance HIDDEN, not rendered-and-hoped. A wrong STT
    // choice does not degrade — it SILENCES the device — so offering an override
    // we cannot validate fails in the expensive direction, while hiding it fails
    // toward the account default, which is exactly today's working behaviour.
    //
    // 🔴 THIS RETURNS A STATE, NOT A BOOLEAN, AND THAT IS THE POINT. There are
    // three different ways a device can have nothing to offer, they mean
    // different things to the person reading the card, and collapsing them into
    // one `false` is the same mistake the device-side uploader exists to avoid:
    //
    //   'ok'          → a live stack with something to choose from. Editable.
    //   'no-record'   → nothing published. An APK too old to have the accessor,
    //                   or a device that has not checked in since. "Update this
    //                   device…" is actionable; "voice is off" would be a guess.
    //   'stack-down'  → `stackUp:false` — a REAL record from a device whose voice
    //                   stack has not started. NOT the same as no-record, and the
    //                   device-side publisher goes to some trouble to keep them
    //                   apart; throwing that away here would waste it.
    //   'nothing-registered' → the stack is up and this hardware registered nothing.
    //                   The honest terminal answer.
    //   'unofferable' → it registered something, but nothing this console OFFERS —
    //                   a device still running the RETIRED sherpa_moonshine_tiny
    //                   through the retirement bridge. Split out from the line above
    //                   because "no engines it can run" would be FALSE of it, and a
    //                   card that says a false thing about the user's own device is
    //                   worse than one that says a vaguer true thing.
    voiceCapabilityState(device) {
        // 🔴 Field names come from CAPABILITY_FIELDS (generated from the Kotlin
        // producer, CONTRACTS #79) — not from literals here. Before that, a Kotlin
        // rename left this file reading `undefined`, resolving every device to
        // `nothing-registered`, and silently removing the override affordance
        // fleet-wide with no error anywhere.
        const F = (typeof CAPABILITY_FIELDS !== 'undefined') ? CAPABILITY_FIELDS : null;
        // No generated shape loaded = we cannot know what to read. Report
        // no-record rather than guess at field names: the failure direction is
        // "affordance hidden", which is the account default, not a wrong offer.
        if (!F) return { state: 'no-record', record: null, offerable: [] };
        const rec = device?.settings?.aiVoice?.voiceCapabilities;
        // The device-side publisher never uploads the "" sentinel, so a non-object
        // here is a foreign/legacy write rather than "ask again" — same outcome
        // (no record), but do not read it as one.
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { state: 'no-record', record: null, offerable: [] };
        if (rec[F.stackUp] !== true) return { state: 'stack-down', record: rec, offerable: [] };

        // 🔴 RUNS and IS-OFFERED are different questions, and the picker answers the
        // second. The device's vocabulary is a SUPERSET of what this console offers:
        // `sherpa_moonshine_tiny` is RETIRED — "no picker offers it and no reseed
        // selects it" — yet a device with tiny installed and base not still RUNS it
        // through the retirement bridge and correctly reports it. Offering it here
        // would re-introduce a retired engine through the back door; refusing to NAME
        // it would blank the running line on exactly the devices the bridge protects.
        // So: offer registered ∩ offered-vocabulary, and label `running` from the
        // superset (see _sttLabel).
        const offeredIds = new Set((window.VoiceAiOptions?.STT || []).map((o) => o.id));
        const sttBlock = rec[F.stt._self] || {};
        const registered = Array.isArray(sttBlock[F.stt.registered]) ? sttBlock[F.stt.registered] : [];
        const offerable = registered.filter((id) => offeredIds.has(id));

        // Empty covers two cases and BOTH must hide the affordance: hardware that
        // registered nothing offerable, and a console whose option list failed to
        // load. The second is a config failure, not a device fact — but the ruling's
        // asymmetry points the same way (never offer an override we cannot validate),
        // so it fails toward the account default rather than toward a guess.
        if (offerable.length === 0) {
            // Two different empties, and the note has to be TRUE for both. A device
            // whose only registered engine is one this console no longer offers IS
            // running something — telling it "no engines it can run" would be a
            // false statement about the user's own device, which is how a card
            // teaches people to distrust it.
            const state = registered.length > 0 ? 'unofferable' : 'nothing-registered';
            return { state, record: rec, offerable: [] };
        }
        return { state: 'ok', record: rec, offerable };
    },

    /** The one-line explanation shown under a card whose override is hidden. */
    voiceCapabilityNote(state) {
        switch (state) {
            case 'no-record':   return 'Update this device to set its own voice engines.';
            // John, 2026-09-21, on the Fire TV Stick: *"it shows voice is disabled
            // (though it should just say it that plainly)"*. The old wording —
            // "hasn't started its voice stack yet ... after it runs voice once" —
            // described the mechanism and left the reader to infer the state. Lead
            // with what is true NOW; keep the second sentence, because it is the
            // only thing that says the dialog will become useful rather than being
            // permanently empty. Deliberately does NOT claim voice was turned off
            // deliberately: a record with a down stack cannot distinguish "disabled
            // on purpose" from "not started yet", and saying the wrong one sends
            // someone hunting a setting they never changed.
            case 'stack-down':  return 'Voice is not running on this device, so there are no engines to choose from. '
                + 'They appear here once it runs voice.';
            case 'nothing-registered': return 'This device has no speech engines it can run, so it follows the account setup.';
            case 'unofferable': return 'This device runs a speech engine this console no longer offers, so it follows the account setup.';
            default: return '';
        }
    },

    /**
     * What this device can SPEAK with — the TTS counterpart of voiceCapabilityState.
     *
     * 🔴 THE STATE THAT DOES NOT EXIST ON THE STT SIDE, AND THE REASON THIS IS A
     * SEPARATE FUNCTION RATHER THAN A PARAMETER: `tts.available` is NEWER THAN THE
     * FLEET. `stt.registered` has no equivalent era. Measured on staging the day it
     * landed (read-only count over `user_devices`, 39 rows): 23 publish no capability
     * record at all, 11 have not started their voice stack, 1 publishes a `tts` block
     * WITHOUT `available`, and 4 carry it. ⚠️ So only ONE device exercises the
     * absent-key branch TODAY — the thin one is the dangerous one. As those 11 start
     * their stacks on APKs that predate the field they land in it too, and every one
     * of them is a device whose picker would empty if absent collapsed into empty.
     *
     * So ABSENT and EMPTY are different facts and must not collapse:
     *   • the key is MISSING  → the device never had the chance to answer. Follow
     *     CONTRACTS #78 state A: pre-capability behavior, exactly as if there were
     *     no record at all.
     *   • the key is an EMPTY ARRAY → the device answered, and the answer is none.
     *
     * 📌 KEEP THIS SPLIT AFTER THE FLEET CATCHES UP, and this paragraph is why —
     * the "one of seven" fact above is the thing that will age out, and once every
     * device publishes the field a reader will find two near-identical functions
     * and be tempted to merge them behind a flag. The reason to refuse is not the
     * count, which is temporary, but the RELATIONSHIP, which is permanent: this
     * field and `stt.registered` do not stand in the same relation to the fleet, and
     * folding them into one function with a parameter asserts that they do. Any
     * field added to the capability record from here on gets its own era of partial
     * adoption, and the next one will be read through whatever this function taught
     * the next author. Merging costs nothing on the day it happens and reintroduces
     * the absent-vs-empty collapse the first time a new field lands.
     *
     * ⚠️ An empty array and a missing key are BOTH falsy, so a truthiness test
     * silently reads "your APK is old" as "this device can speak with nothing" —
     * and, because the devices carrying the field are the ones being tested on, that
     * bug renders perfectly in review and empties the picker on the majority of the
     * fleet that is still on an older APK. `check-voice-override-gating.mjs` pins both
     * halves with the absent leg paired against a present control.
     *
     * A non-array value lands in 'no-field' too, deliberately: like a missing key it
     * means the record does not TELL us what this device can speak with, which is a
     * different claim from the device reporting none.
     */
    ttsCapabilityState(device) {
        // Same reasoning as voiceCapabilityState: names come from the generated
        // shape, and no shape means we cannot know what to read — report no-record
        // rather than guess, so the failure direction is the account default.
        const F = (typeof CAPABILITY_FIELDS !== 'undefined') ? CAPABILITY_FIELDS : null;
        if (!F) return { state: 'no-record', record: null, offerable: [] };
        const rec = device?.settings?.aiVoice?.voiceCapabilities;
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { state: 'no-record', record: null, offerable: [] };
        if (rec[F.stackUp] !== true) return { state: 'stack-down', record: rec, offerable: [] };

        const ttsBlock = rec[F.tts._self];
        const block = (ttsBlock && typeof ttsBlock === 'object' && !Array.isArray(ttsBlock)) ? ttsBlock : {};
        const raw = block[F.tts.available];
        if (!Array.isArray(raw)) return { state: 'no-field', record: rec, offerable: [] };

        // The device answered "none" — a real negative, and NOT the same as silence.
        if (raw.length === 0) return { state: 'nothing-available', record: rec, offerable: [] };

        // Offered ∩ device-available, same superset discipline as the STT side: the
        // device's vocabulary may legitimately name engines this console no longer
        // offers, and naming one here would re-introduce it through the back door.
        const offeredIds = new Set((window.VoiceAiOptions?.TTS || []).map((o) => o.id));
        const offerable = raw.filter((id) => offeredIds.has(id));
        if (offerable.length === 0) return { state: 'unofferable', record: rec, offerable: [] };
        return { state: 'ok', record: rec, offerable };
    },

    /**
     * Can this ACCOUNT pay for a billed cloud voice? THREE states, not two.
     *
     * 🔴 UNKNOWN IS PERMISSIVE, and that is the ruling rather than a defensive
     * default (O, 2026-09-20). Intersect only when spend state is KNOWN; when it is
     * null, offer the device's list unmodified.
     *
     * Why: `devices` is in FeatureGate.LOCAL_MODE_PAGES, so this picker renders on an
     * ACCOUNT-LESS box, where tier and balance are null BY DESIGN and permanently —
     * not by a slow fetch. Treat absent as "cannot spend" and the add-on's local mode
     * (the free edition) hides the cloud voice on every device in the household,
     * WHILE THAT DEVICE'S OWN `tts.available` SAYS IT IS FINE — so it reads as a
     * device capability bug. That is precisely the misattribution that put
     * affordability on the console in the first place, just moved one layer up.
     *
     * ⚠️ Not only the local-mode path: CreditsService's boot seed gives up after a
     * bounded retry and logs `DROP: CreditsService gave up seeding the balance`, so an
     * account box reaches unknown too.
     */
    _ttsAffordability() {
        const svc = (typeof CreditsService !== 'undefined') ? CreditsService : window.CreditsService;
        const bal = (typeof svc?.balance === 'function') ? svc.balance() : null;
        if (!bal || typeof bal.balance !== 'number') return { known: false, canSpend: true };
        return { known: true, canSpend: bal.balance > 0 };
    },

    /**
     * The per-device text-to-speech row. Hidden unless the device has published a
     * usable `tts.available` — the same "never offer an override we cannot validate"
     * posture the STT picker takes.
     */
    _renderTtsProviderRow(device) {
        // §6c: per-device overrides do not apply under the ha_assist preset, where the
        // HA pipeline owns TTS and a Dashie-side choice has nothing to act on.
        if (!this.voiceOverridesApply(device)) return '';
        const { state, offerable } = this.ttsCapabilityState(device);
        if (state !== 'ok') {
            const note = this.ttsCapabilityNote(state);
            return note ? `<div class="form-group" style="font-size: var(--font-size-sm); color: var(--text-muted);">${this._escape(note)}</div>` : '';
        }

        // Billed-ness comes from the option list's own `locality`, not a hardcoded id
        // here — one less place for the cloud engine's name to be written down.
        const opts = new Map((window.VoiceAiOptions?.TTS || []).map((o) => [o.id, o]));
        const afford = this._ttsAffordability();
        const current = this._voiceSetupValue(device, 'ttsProvider');
        const acctTts = this._inherited('voice', 'ttsProvider', this._accountSettings?.voice?.ttsProvider, device);
        const inheritLabel = this._defaultLabel(opts.get(acctTts)?.label || acctTts, device);

        const rows = offerable.map((id) => {
            const opt = opts.get(id);
            const billed = opt?.locality === 'cloud';
            const blocked = billed && afford.known && !afford.canSpend;
            const label = opt?.label || id;
            return `<option value="${this._escape(id)}" ${id === current ? 'selected' : ''} ${blocked ? 'disabled' : ''}>` +
                `${this._escape(label)}${blocked ? ' — no credits on this account' : ''}</option>`;
        }).join('');

        return `
            <div class="form-group">
                <label class="form-label">Voice on this device</label>
                <select class="form-select" onchange="DevicesDetailModals._setVoiceSetupPending('ttsProvider', this.value)">
                    ${this._offListOption(current, offerable, 'voice.ttsProvider')}
                    <option value="" ${current === '' ? 'selected' : ''}>${this._escape(inheritLabel)}</option>
                    ${rows}
                </select>
            </div>`;
    },

    /**
     * The voice pickers each lead with an `Account default` option whose value
     * is the `''` inherit sentinel — so when the device holds a value that is
     * not in the offered list, NOTHING matches, no option is selected, and the
     * browser falls back to the first one. The picker then reads "Account
     * default" for a device that has explicitly overridden the account. That is
     * worse than showing a wrong value: it reports the wrong *relationship*.
     *
     * Same defect as DevicesDetail._optionsHtml (John, 2026-09-22 — the
     * Samsung's screensaver). Returns a selected option carrying the device's
     * own value, or '' when the value is represented (or is the sentinel).
     */
    _offListOption(current, values, key) {
        const cur = current == null ? '' : String(current);
        if (cur === '') return '';
        if (values.some((v) => String(v) === cur)) return '';
        console.warn(`DROP: ${key} is "${cur}" on this device, which this console does not offer `
            + `(${values.length} choices) — showing it as-is rather than as "Account default". `
            + `The database value is correct; the console's list is behind the device's.`);
        return `<option value="${this._escape(cur)}" selected>${this._escape(cur)} (set on the device)</option>`;
    },

    /** The one-line explanation shown under a device whose TTS override is hidden. */
    ttsCapabilityNote(state) {
        switch (state) {
            // ⚠️ Must NOT say the device has no voices — it has not reported on the
            // question. Saying a false thing about the user's own device is worse
            // than a vaguer true one (the STT note carries the same rule).
            case 'no-field':   return 'Update this device to choose its own voice.';
            case 'no-record':  return 'Update this device to choose its own voice.';
            case 'stack-down': return "This device hasn't started its voice stack yet — its voices will appear after it runs voice once.";
            case 'nothing-available': return 'This device has no voices it can use, so it follows the account setup.';
            case 'unofferable': return 'This device uses a voice this console no longer offers, so it follows the account setup.';
            default: return '';
        }
    },

    /**
     * Human label for an STT id, from the console's OWN option list.
     *
     * ⚠️ Falls back to the raw id rather than to "Unknown", and that is A's
     * documented discrepancy rather than sloppiness: the DEVICE's vocabulary is a
     * SUPERSET of what this picker offers. `sherpa_moonshine_tiny` is retired and
     * offered nowhere, but a device that has tiny installed and base not still RUNS
     * it through the retirement bridge — so a card that could not name it would
     * show a blank on precisely the devices the bridge exists to protect. Runs and
     * is-offered are different questions.
     */
    /**
     * The inherited option's label, in the tablet's words.
     *
     * John, 2026-09-22: *"We also want defaults to show here like they do on the
     * tablet Rachel (Default) - instead of just showing Account Default."* The
     * tablet resolves the inherited value to its NAME and appends " (Default)",
     * falling back to a bare "Default" only when the name will not resolve --
     * VoiceAiSettingsWiring.kt:358 (`if (inheriting) "$name (Default)" else name`),
     * PersonalityPickerFragment.kt:129, WakeWordPickerFragment.kt:206.
     *
     * The console said "Account default" instead, which names the MECHANISM and
     * withholds the answer: two surfaces describing one state in two vocabularies,
     * neither of which tells you what the device will actually do.
     *
     * 🔴 A missing name must NOT silently become "(Default)" with an empty prefix,
     * and must not read as a value either. Returns 'Default' alone, exactly as
     * Kotlin does.
     */
    _defaultLabel(name, device) {
        const n = String(name ?? '').trim();
        const d = this._defaultWord(device);
        return n ? `${n} (${d})` : d;
    },

    // ── WHICH default? (voice profiles, phase 3 condition 2) ────────────────
    //
    // `resolveOverride` reports source='account-default' for a profile-sourced
    // value too, so the source alone cannot tell the two layers apart. Before this,
    // a household running a profile saw "Rachel (Default)" on every inherit row
    // while the value on screen was read from the ACCOUNT path — the layer the
    // device is no longer using. The label was imprecise; the VALUE was wrong.
    //
    // Guarded on window.VoiceProfileKeys because these run from RENDER paths: in a
    // vendored tree missing the script tag, an unguarded read throws and takes the
    // whole Devices detail page down (the same failure AccountSettingsStore.ensure
    // documents). Absent lib → behave exactly as before profiles existed.

    /** Which layer answers THIS DEVICE's defaults. See VoiceProfileKeys.layer.
     *  🔴 Per-device now: the pointer is a synced device key (CONTRACTS #148), so two
     *  devices in one household can legitimately answer differently. Passing no device
     *  means Default, which is the account paths. */
    _profileLayer(device) {
        const L = window.VoiceProfileKeys?.layer?.(this._accountSettings, device);
        return L || { source: 'default', id: 'default', name: 'Default', profile: null };
    },

    /**
     * The word an inherit option wears. Plain "Default" when the household has no
     * profiles (the normal steady state, and the string the tablet renders —
     * VoiceAiSettingsWiring.kt:358). "Default · <profile>" once a profile is
     * authoritative, because then "Default" alone names a layer the device is not
     * reading and the user has somewhere to go and change it.
     *
     * A DANGLING household — profiles exist, none carries the seeded id — reads as
     * plain "Default", which is the truth: every device really is on the account
     * layer. The profiles page is where that state gets explained.
     */
    _defaultWord(device) {
        const L = this._profileLayer(device);
        return (L.source === 'profile' && L.name) ? `Default · ${L.name}` : 'Default';
    },

    /**
     * The value a device with no override of its own will actually run.
     *
     * 🔴 Pass what you read from the account layer; this decides whether it is used.
     * The fallback is per-HOUSEHOLD: a migrated household's profile answers for every
     * key it declares, including the ones it holds as '', and does NOT fall through.
     */
    _inherited(category, key, accountValue, device) {
        const r = window.VoiceProfileKeys?.inherited?.(this._accountSettings, device, category, key, accountValue);
        return r ? r.value : (accountValue == null ? '' : String(accountValue));
    },

    _sttLabel(id) {
        const opt = (window.VoiceAiOptions?.STT || []).find((o) => o.id === id);
        return opt ? opt.label : String(id);
    },

    // ── Which household profile does this device follow? (CONTRACTS #148) ───────
    //
    // 🔴 THIS IS THE ONLY SURFACE THAT ASSIGNS ONE. Without it the whole feature is
    // inert: the console can create profiles, devices receive them, the pointer syncs —
    // and nothing ever sets it, so every device stays on Default forever. Profiles that
    // cannot be pointed at are settings nobody can use.
    //
    // Deliberately NOT gated on voiceOverridesApply(): which profile a device follows is
    // a question independent of the pipeline preset, and hiding it under ha_assist would
    // strand any device that happened to be on that preset.

    _profileOpen: false,
    _profileDeviceId: null,

    /** The row, or '' when the household has only Default. §7's guardrail applied to the
     *  device page: one option is not a choice, it is noise on every household that will
     *  never make a second profile. */
    profileAssignmentRow(device, idAttr) {
        this.ensureAccountSettings();
        const named = window.VoiceProfileKeys?.named?.(this._accountSettings);
        if (!named || Object.keys(named).length === 0) return '';
        const L = this._profileLayer(device);
        // A dangling pointer is NAMED, not hidden: the profile was deleted while this
        // device was offline, so it is silently on Default and the only other place that
        // says so is a device log nobody reads.
        const label = L.source === 'dangling'
            ? `Default (the “${L.id}” profile was deleted)`
            : (L.source === 'profile' ? L.name : 'Default');
        return this._summaryRow('Voice profile', label, `DevicesDetailModals.openProfile('${idAttr}')`);
    },

    openProfile(deviceId) {
        this._resetAlso();
        this._profileOpen = true;
        this._profileDeviceId = deviceId;
        this.ensureAccountSettings();
        App.renderPage();
    },

    closeProfile() { this._profileOpen = false; App.renderPage(); },

    renderProfileModal() {
        if (!this._profileOpen) return '';
        const device = DevicesPage._findDevice(this._profileDeviceId);
        if (!device) return '';
        const named = window.VoiceProfileKeys?.named?.(this._accountSettings) || {};
        const DEFAULT = window.VoiceProfileKeys?.DEFAULT_PROFILE_ID || 'default';
        const current = String(device?.settings?.voice?.profileId || '') || DEFAULT;
        const opts = [[DEFAULT, 'Default'], ...Object.entries(named).map(([id, p]) => [id, p.name || id])];
        const options = opts.map(([v, label]) =>
            `<option value="${this._escape(v)}" ${v === current ? 'selected' : ''}>${this._escape(label)}</option>`).join('');

        const body = `
            <div class="form-group">
                <label class="form-label">Voice profile</label>
                <select class="form-select" onchange="DevicesDetailModals.setProfile(this.value)">
                    ${this._offListOption(current, opts.map(([v]) => v), 'voice.profileId')}
                    ${options}
                </select>
            </div>
            <div style="font-size: var(--font-size-sm); color: var(--text-muted);">
                A profile is a complete set of voice &amp; AI defaults, edited on the
                <a href="#voice-ai" onclick="event.preventDefault(); App.navigate('voice-ai')">Voice &amp; AI</a> page.
                <strong>Default</strong> is your household's own settings.
                This device's own overrides below still win over whichever profile it follows.
            </div>`;
        return this._modal('Voice profile', body, 'DevicesDetailModals.closeProfile()', this._alsoFooter(), device);
    },

    /**
     * The canonical list of what the Voice-profile dialog writes, for "Also apply to".
     *
     * 🔴 Exactly ONE key, and it must stay that way. The pointer is the only thing this
     * dialog sets; the profile's CONTENTS live in the household blob and are shared by
     * every device that follows it. Adding a pipeline leaf here would copy a value the
     * dialog never offered — the mirror of the bug check-apply-targets was built for.
     *
     * Pinned to the spec by `DERIVED.profile` in scripts/check-apply-targets.mjs.
     */
    PROFILE_FANOUT_KEYS: ['profileId'],

    /** "Evenings" / "Default" — what the footer says this device follows now. */
    _profileNow(device) {
        const id = String(device?.settings?.voice?.profileId || '');
        if (!id) return 'Default';
        const named = window.VoiceProfileKeys?.named?.(this._accountSettings) || {};
        // A dangling pointer is NAMED as dangling. Rendering a bare id would read as a
        // profile whose name happens to look like a slug, and falling back to 'Default'
        // would claim a state the device is not in.
        return named[id]?.name || `${id} (missing)`;
    },

    async setProfile(value) {
        const deviceId = this._profileDeviceId;
        const DEFAULT = window.VoiceProfileKeys?.DEFAULT_PROFILE_ID || 'default';
        // '' for Default rather than the literal id: absent is what every device that has
        // never chosen already stores, so the two states are ONE state rather than two
        // that resolve alike but compare differently.
        const stored = (value === DEFAULT) ? '' : String(value);
        await DevicesPage._onSettingChange(deviceId, 'voice', 'profileId', stored);
        this.closeProfile();
    },

    // ── Per-device voice setup modal (D2b: one selection leads) ──────────────

    _voiceSetupOpen: false,
    _voiceSetupDeviceId: null,
    _voiceSetupPending: null,
    _voiceSetupSaving: false,

    /**
     * Presets under which a per-device voice override means anything.
     *
     * 🔴 John, 2026-09-20: *"we don't need per device in HA mode. Only in local, cloud, and hybrid."*
     * Under `ha_assist` the HA Assist PIPELINE owns STT, agent and TTS, so a Dashie-side override
     * has nothing to act on — you would configure it in HA. And the one thing you WOULD vary per
     * device there, which Assist pipeline this device uses, is already per-device: `voice_pipeline_id`
     * is SYNC_EXEMPT `local-only (HA pipeline)` and never leaves the device.
     *
     * ⚠️ "HA mode" is the ha_assist PRESET, not the keys with `ha` in their name. `haTtsEngineId` /
     * `haSttEngineId` are what the LOCAL preset uses (`VoicePresetSeeder`: TTS_HA_ENGINE when an
     * engine id is known), so they belong to a preset that DOES get per-device overrides. Gating on
     * the key name instead of the preset would remove per-device engines from `local`.
     */
    VOICE_OVERRIDE_PRESETS: ['cloud', 'hybrid', 'local'],

    /** Is this household on a preset where per-device voice overrides apply at all? */
    voiceOverridesApply(device) {
        // Through the profile layer: a profile carries the preset it was seeded from
        // (§9), and reading the raw account path here would hide the per-device
        // override rows for a whole household whose PROFILE is on cloud/hybrid/local
        // while the stale account path still says ha_assist. The feature would not
        // misbehave — it would be absent, with nothing on screen to explain it.
        const preset = this._inherited('voice', 'pipelinePreset', this._accountSettings?.voice?.pipelinePreset, device);
        // Unknown preset (account settings not loaded yet) ⇒ do NOT offer. Same posture as an
        // empty capability list: fail toward the account default, never toward a guess.
        return this.VOICE_OVERRIDE_PRESETS.includes(String(preset || ''));
    },

    openVoiceSetup(deviceId) {
        this._resetAlso();
        this._voiceSetupOpen = true;
        this._voiceSetupDeviceId = deviceId;
        this._voiceSetupPending = {};
        this.ensureAccountSettings();
        // The HA engine / Piper voice lists come from the add-on, not from the device. Null in
        // account mode, which renders those rows away rather than empty.
        if (window.HaEngines && !HaEngines.loaded) HaEngines.load().then(() => App.renderPage());
        App.renderPage();
    },

    closeVoiceSetup() {
        this._voiceSetupOpen = false;
        this._voiceSetupDeviceId = null;
        this._voiceSetupPending = {};
        App.renderPage();
    },

    /**
     * Stage one leaf's pending value.
     *
     * ⚠️ Keyed, not a single slot: the modal now edits up to four leaves and a shared slot would
     * make the last picker touched the only one saved.
     */
    _setVoiceSetupPending(key, value) {
        if (!this._voiceSetupPending) this._voiceSetupPending = {};
        this._voiceSetupPending[key] = value;
    },

    /** The value a picker should show: the staged edit if any, else the device's stored override. */
    _voiceSetupValue(device, key) {
        const pending = this._voiceSetupPending || {};
        if (Object.prototype.hasOwnProperty.call(pending, key)) return pending[key];
        const v = device?.settings?.voice?.[key];
        return typeof v === 'string' ? v : '';
    },

    /**
     * What the Voice setup dialog is SHOWING for every leaf, including the ones the
     * device has not overridden.
     *
     * 🔴 '' is the INHERIT SENTINEL and is a real value here, not an absence. Without
     * this resolver the fan-out reads `src.settings.voice[key]`, gets `undefined` for
     * every leaf an inheriting device never wrote, skips them all, and applies NOTHING
     * — the user picks three devices, presses Apply, and the dialog closes having done
     * nothing at all. That is the exact defect already fixed once for sleep
     * (sleepEffective) and once more for the whole-dialog fan-out; this is the same
     * class arriving through a third door.
     *
     * Applying an inheriting source to a target is meaningful and is the point: it puts
     * the target back on the household setup, which is how a device gets RESET to match
     * one that was never customised.
     */
    voiceEffective(deviceVoice) {
        const v = deviceVoice || {};
        const out = {};
        for (const key of this.VOICE_LEAF_KEYS) {
            out[key] = typeof v[key] === 'string' ? v[key] : '';
        }
        return out;
    },

    async submitVoiceSetup() {
        if (this._voiceSetupSaving) return;
        const deviceId = this._voiceSetupDeviceId;
        const pending = this._voiceSetupPending || {};
        const keys = Object.keys(pending);
        // No key touched = the user opened and saved without changing anything. Note '' IS a value
        // here (the inherit sentinel), so this tests which KEYS were touched rather than whether
        // any value is truthy — a falsy test would silently turn "follow the account" into "no change".
        if (!deviceId || keys.length === 0) { this.closeVoiceSetup(); return; }
        this._voiceSetupSaving = true;
        App.renderPage();
        try {
            // Per-device overrides at user_devices.voice.<key>. '' is the INHERIT sentinel the patch
            // writers use because they cannot delete keys — the device clears its mirror and follows
            // the account again. Sequential, not Promise.all: each is its own update_device_settings
            // RPC on the same row, and concurrent jsonb_set merges on one row can drop a write.
            for (const key of keys) {
                await DevicesPage._onSettingChange(deviceId, 'voice', key, pending[key]);
            }
            const allInherit = keys.every((k) => pending[k] === '');
            Toast.success(allInherit
                ? 'This device now follows the account setup'
                : `Voice setup saved for this device (${keys.length} change${keys.length === 1 ? '' : 's'})`);
            this.closeVoiceSetup();
        } catch (e) {
            Toast.error(`Save failed: ${e?.message || e}`);
        } finally {
            this._voiceSetupSaving = false;
            App.renderPage();
        }
    },

    /**
     * §4.5's filter-vs-gray rule, applied:
     *   · REGISTERED but not available → rendered DISABLED with a reason. The user
     *     can do something about it (download the model, configure the HA engine),
     *     and the greyed row plus a reason is what teaches them the action.
     *   · not registered at all → not rendered. This hardware can never run it;
     *     a permanently-greyed impossible row is noise on every card forever.
     *   · registered but NOT OFFERED by this console (a retired id a device still
     *     runs through the retirement bridge) → not rendered either, for a different
     *     reason: it is not a choice anyone may make, though it is still NAMED in the
     *     running line so the card does not go blank on those devices.
     */
    /**
     * The three HA-sourced leaves: which Whisper, which Piper, and which Piper VOICE this device
     * uses. Rendered only when they can actually take effect.
     *
     * TWO GATES, and both matter:
     *
     * 1. **Preset** — `voiceOverridesApply()`. Nothing here is offered under `ha_assist`.
     *
     * 2. **Effective provider** — an engine id is only read when that stage's provider is
     *    `ha_engine` (`VoiceAiPage._selectProvider` pins the id alongside that selection). A device
     *    inheriting a cloud TTS provider would otherwise carry a Piper voice nothing reads, which is
     *    worse than not offering it: a setting that visibly saves and silently does nothing.
     *    The provider checked is the EFFECTIVE one — this device's override if it has one, else the
     *    account's — because that is what the device will actually run.
     *
     * Empty option list ⇒ the row is omitted, never rendered empty. In account (non-add-on) mode
     * there is no add-on to ask, so all three disappear. Same posture as an empty capability list:
     * fail toward the account default rather than toward a guess.
     */
    _renderHaEngineRows(device) {
        if (!this.voiceOverridesApply(device)) return '';
        // Bind once rather than reaching for the bare global per call: if ha-engines.js did not
        // load (a missing script tag in a vendored tree, a 404), this is undefined and every row
        // is omitted — instead of a ReferenceError mid-render that takes the whole modal down.
        const HE = window.HaEngines;
        if (!HE?.raw) return '';

        const acct = this._accountSettings?.voice || {};
        const effective = (key) => {
            const own = device?.settings?.voice?.[key];
            // '' is the inherit sentinel, not a value — an inheriting device carries it explicitly.
            return (typeof own === 'string' && own !== '') ? own : this._inherited('voice', key, acct[key], device);
        };
        const sttIsHa = effective('sttProvider') === 'ha_engine';
        const ttsIsHa = effective('ttsProvider') === 'ha_engine';

        const row = (key, label, options, hint) => {
            if (!options.length) return '';
            const current = this._voiceSetupValue(device, key);
            const inheritLabel = this._defaultLabel((() => {
                const a = this._inherited('voice', key, acct[key], device);
                if (!a) return '';
                const hit = options.find((o) => (typeof o === 'string' ? o : (o.value ?? o.id)) === a);
                return hit ? (typeof hit === 'string' ? hit : (hit.label ?? hit.name ?? a)) : a;
            })());
            const opts = options.map((o) => {
                const value = typeof o === 'string' ? o : (o.value ?? o.id ?? '');
                const text = typeof o === 'string' ? o : (o.label ?? o.name ?? value);
                return `<option value="${this._escape(value)}" ${value === current ? 'selected' : ''}>${this._escape(text)}</option>`;
            }).join('');
            return `
            <div class="form-group">
                <label class="form-label">${this._escape(label)}</label>
                <select class="form-select" onchange="DevicesDetailModals._setVoiceSetupPending('${this._escape(key)}', this.value)">
                    ${this._offListOption(current, options.map((o) => (typeof o === 'string' ? o : (o.value ?? o.id ?? ''))), `voice.${key}`)}
                    <option value="" ${current === '' ? 'selected' : ''}>${this._escape(inheritLabel)}</option>
                    ${opts}
                </select>
                ${hint ? `<div style="font-size: var(--font-size-sm); color: var(--text-muted); margin-top: 4px;">${this._escape(hint)}</div>` : ''}
            </div>`;
        };

        return [
            sttIsHa ? row('haSttEngineId', 'Speech-to-text engine (Home Assistant)',
                HE.configOptions('stt', 'voice.haSttEngineId'),
                '') : '',
            ttsIsHa ? row('haTtsEngineId', 'Text-to-speech engine (Home Assistant)',
                HE.configOptions('tts', 'voice.haTtsEngineId'),
                '') : '',
            ttsIsHa ? row('haTtsVoiceId', 'Voice',
                HE.configOptions('tts', 'voice.haTtsVoiceId'),
                'Give each room its own voice — the usual reason to set this per device.') : '',
        ].join('');
    },

    renderVoiceSetupModal() {
        if (!this._voiceSetupOpen) return '';
        const device = DevicesPage._findDevice(this._voiceSetupDeviceId);
        const { state, record } = this.voiceCapabilityState(device);
        if (state !== 'ok') {
            // The card should not have offered the affordance; if the device's
            // record changed under an open modal, say so rather than render a
            // picker with nothing safe in it.
            return this._modal('Voice setup', `
                <div style="font-size: var(--font-size-sm); color: var(--text-muted);">
                    ${this._escape(this.voiceCapabilityNote(state))}
                </div>
                <div style="display: flex; justify-content: flex-end; margin-top: 12px;">
                    <button class="btn btn-secondary" onclick="DevicesDetailModals.closeVoiceSetup()">Close</button>
                </div>
            `, 'DevicesDetailModals.closeVoiceSetup()', null, device);
        }

        const F = CAPABILITY_FIELDS;
        const { offerable } = this.voiceCapabilityState(device);
        const sttBlock = record[F.stt._self] || {};
        const available = new Set(Array.isArray(sttBlock[F.stt.available]) ? sttBlock[F.stt.available] : []);
        const current = this._voiceSetupValue(device, 'sttProvider');
        const acctStt = this._inherited('voice', 'sttProvider', this._accountSettings?.voice?.sttProvider, device);
        const inheritLabel = this._defaultLabel(acctStt ? this._sttLabel(acctStt) : '', device);

        const rows = offerable.map((id) => {
            const usable = available.has(id);
            const label = this._sttLabel(id);
            return `<option value="${this._escape(id)}" ${id === current ? 'selected' : ''} ${usable ? '' : 'disabled'}>` +
                `${this._escape(label)}${usable ? '' : ' — not ready on this device'}</option>`;
        }).join('');

        const running = sttBlock[F.stt.running];
        const body = `
            <div class="form-group">
                <label class="form-label">Speech-to-text on this device</label>
                <select class="form-select" onchange="DevicesDetailModals._setVoiceSetupPending('sttProvider', this.value)">
                    ${this._offListOption(current, offerable, 'voice.sttProvider')}
                    <option value="" ${current === '' ? 'selected' : ''}>${this._escape(inheritLabel)}</option>
                    ${rows}
                </select>
            </div>
            ${this._renderTtsProviderRow(device)}
            ${this._renderHaEngineRows(device)}
            <div style="font-size: var(--font-size-sm); color: var(--text-muted);">
                Only engines this device has actually registered are listed.
                ${running ? `It is running <strong>${this._escape(this._sttLabel(running))}</strong> right now.` : ''}
                Choosing the <strong>(Default)</strong> entry puts this device back on the household setup.
            </div>
            <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px;">
                <button class="btn btn-secondary" onclick="DevicesDetailModals.closeVoiceSetup()" ${this._voiceSetupSaving ? 'disabled' : ''}>Cancel</button>
                <button class="btn btn-primary" onclick="DevicesDetailModals.submitVoiceSetup()" ${this._voiceSetupSaving ? 'disabled' : ''}>${this._voiceSetupSaving ? 'Saving…' : 'Save'}</button>
            </div>
        `;
        return this._modal('Voice setup', body, 'DevicesDetailModals.closeVoiceSetup()',
            this._alsoFooter(), device);
    },

    // ── Section body ──────────────────────────────────────────

    renderDisplayBody(device, display, sleep) {
        const idAttr = DevicesPage._escape(device.device_id);
        const screensaver = device.settings?.screensaver || {};
        const sleepSummary = this.buildSleepSummary(sleep, display);
        const themeSummary = this.buildThemeSummary(display);
        const animationsOn = display.animationsEnabled === true || display['display.animationsEnabled'] === true;
        const themeFamily = display.themeFamily || 'default';
        const layoutMode = display.layoutMode || display['preferences.layoutMode'] || 'widgets';
        // 🔴 Console-audit #3, ruled by John 2026-08-04: Layout and Orientation
        // do not appear on an ACCOUNT-LESS box.
        //
        // Gated on `isLocalMode` rather than on `isPublishedBuild`, and the
        // distinction is the whole ruling. `FAMILY_ONLY_OPTIONS` already drops
        // the layoutMode VALUE 'widgets' in the published build while
        // deliberately KEEPING the row — "the HA edition uses
        // single_panel/kiosk" — and that decision still stands for a signed-in
        // Dashie-for-HA box. What changes is the account-less case: `widgets`
        // IS the family dashboard, which cannot run without an account, so
        // these two rows there configure something that cannot exist.
        //
        // ⚠️ `isLocalMode` is the ONLY seam that separates the two editions in
        // this console — both ship `BRAND.build: 'published'`, so
        // `isPublishedBuild()` is true for both and cannot express this. Same
        // seam, same reason, as the managed cloud row in voice-ai-options.js.
        const showLayout = !(typeof DashieAuth !== 'undefined' && DashieAuth.isLocalMode === true);
        const showOrientation = showLayout && layoutMode === 'widgets';
        const showAnimationRows = themeFamily !== 'default';

        return `
            ${this._subsectionCard('Dashboard', [
                !showLayout ? ''
                    : layoutMode === 'kiosk'
                    ? this._readonlyRow('Layout', this._labelFor(this.LAYOUT_MODES, 'kiosk'))
                    : this._summaryRow('Layout', this._labelFor(this.LAYOUT_MODES, layoutMode),
                        `DevicesDetailModals.openPicker('${idAttr}','display','layoutMode','Layout','WRITABLE_LAYOUT_MODES','widgets')`),
                showOrientation ? this._summaryRow('Orientation',
                    this._labelFor(this.ORIENTATION_MODES, display.orientationLock || 'auto'),
                    `DevicesDetailModals.openPicker('${idAttr}','display','orientationLock','Orientation','ORIENTATION_MODES','auto')`) : '',
                FeatureGate.optionAllowed('display.themeFamily')
                    ? this._summaryRow('Theme', themeSummary,
                        `DevicesDetailModals.openTheme('${idAttr}')`)
                    : '',
                showAnimationRows ? this._toggleRow(device, 'display', 'animationsEnabled',
                    'Animations', animationsOn) : '',
                showAnimationRows && animationsOn ? this._summaryRow('Animation Level',
                    this._labelFor(this.ANIMATION_LEVELS, display.animationLevel || display['preferences.animationLevel'] || 'high'),
                    `DevicesDetailModals.openPicker('${idAttr}','display','animationLevel','Animation Level','ANIMATION_LEVELS','high')`) : '',
            ].filter(Boolean).join(''))}
            ${this._subsectionCard('Screen Management', [
                this._summaryRow('Sleep Mode', sleepSummary,
                    `DevicesDetailModals.openSleep('${idAttr}')`),
                this._summaryRow('Screensaver', this.buildScreensaverSummary(display, screensaver),
                    `DevicesDetailModals.openScreensaver('${idAttr}')`),
                // Read-only: motionWakeMode is sync:'readback-only' (no cloud→Kotlin
                // setter), so a console write silently reverts on the next readback.
                this._readonlyRow('Wake Mode',
                    this._labelFor(this.WAKE_MODES, display.motionWakeMode || 'disabled')),
                // Granular Display Preferences (zooms, display/font size,
                // sidebar icon size, screen-off, auto brightness) collapse
                // into one row → modal. Summary text intentionally blank
                // — the modal has six+ values and surfacing any subset on
                // the row was just noise the user has to parse.
                this._summaryRow('Advanced Display Options', '',
                    `DevicesDetailModals.openAdvancedDisplay('${idAttr}')`),
            ].join(''))}
        `;
    },

    /** A titled card of rows — or NOTHING when there are no rows.
     *
     * 🔴 The empty case became reachable the moment #3 landed, and it is the
     * failure this whole family keeps producing. On an account-less published
     * box the "Dashboard" card can now lose EVERY row: Layout and Orientation
     * are gated off by #3, Theme by `FAMILY_ONLY_OPTIONS['display.themeFamily']`,
     * and the animation rows only exist for a non-default theme family. Without
     * this guard the user gets a card with a heading and nothing under it —
     * which reads as "this section failed to load", not as "there is nothing
     * here", and nothing logs either way. */
    _subsectionCard(title, rowsHtml) {
        if (!String(rowsHtml || '').trim()) return '';
        return `
            <div class="card" style="margin-bottom: 12px;">
                <div class="card-body" style="padding: 0;">
                    <div style="padding: 12px 16px 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted);">${this._escape(title)}</div>
                    ${rowsHtml}
                </div>
            </div>
        `;
    },

    _summaryRow(label, summary, onClick) {
        return `
            <div onclick="${onClick}" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; cursor: pointer; gap: 12px; border-top: 1px solid var(--border-subtle);"
                onmouseenter="this.style.background='var(--bg-subtle, #f3f4f6)'" onmouseleave="this.style.background='transparent'">
                <span style="font-size: var(--font-size-sm); font-weight: 500;">${this._escape(label)}</span>
                <span style="display: inline-flex; align-items: center; gap: 8px; color: var(--text-secondary); font-size: var(--font-size-sm); text-align: right;">
                    ${this._escape(summary)}
                    <span style="color: var(--text-muted); font-size: 14px;">›</span>
                </span>
            </div>
        `;
    },

    // Read-only display row (no chevron / click). Use for device settings the
    // console can SHOW but not CHANGE — e.g. readback-only keys that have no
    // cloud→Kotlin setter (motionWakeMode, sidebarIconSize) or values the bridge
    // rejects (layoutMode 'kiosk'). Rendering them as pickers made the write a
    // silent no-op that the device readback then reverted.
    _readonlyRow(label, summary) {
        return `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; gap: 12px; border-top: 1px solid var(--border-subtle);">
                <span style="font-size: var(--font-size-sm); font-weight: 500;">${this._escape(label)}</span>
                <span style="color: var(--text-muted); font-size: var(--font-size-sm); text-align: right;">${this._escape(summary)}</span>
            </div>
        `;
    },

    _toggleRow(device, category, key, label, checked) {
        return `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-top: 1px solid var(--border-subtle);">
                <span style="font-size: var(--font-size-sm); font-weight: 500;">${this._escape(label)}</span>
                <label class="toggle">
                    <input type="checkbox" ${checked ? 'checked' : ''}
                        onchange="DevicesPage._onSettingChange('${device.device_id}', '${category}', '${key}', this.checked)">
                    <span class="toggle-slider"></span>
                </label>
            </div>
        `;
    },

    /** External call kept for any leftover callers (kept stable across refactors). */
    renderSummaryRow(label, summary, onClick) { return this._summaryRow(label, summary, onClick); },

    // ── Summary builders (mirror Kotlin control center) ────────

    /**
     * THE one derivation of sleep mode from the device blob.
     *
     * 🔴 `enabled` ABSENT means ON — that is the app's default, and a falsy test
     * (`sleep.enabled && …`) reads a never-configured device as "Off". That is
     * exactly how the P4a card came to say "Off" for a device whose own Sleep
     * modal said "Schedule · 10:00 PM – 7:00 AM" (John, 2026-09-21). The same
     * class of bug was fixed in buildSleepSummary once before, for the
     * `sleep.`-prefixed keys; re-deriving the predicate is what let it return.
     *
     * Three call sites read this. None of them may re-derive it.
     */
    /**
     * The EFFECTIVE sleep settings — what the modal actually shows on screen,
     * with every default resolved.
     *
     * 🔴 WHY THIS EXISTS (John, 2026-09-21: "i did try apply to all and nothing
     * happened for sleep"). `_fanOutTo` copied `src.settings[cat][key]`
     * and skipped anything `undefined`. A device that has never had Sleep
     * configured has an EMPTY sleep blob — measured: `Dashie SM-X200` has no
     * sleep keys at all — so every key was skipped, the payload came out empty
     * and the fan-out wrote nothing, silently. Meanwhile the modal was showing
     * "Schedule · 10:00 PM – 7:00 AM", because it resolves those defaults for
     * display. The user applies what they can SEE, so the fan-out has to send
     * what is SHOWN, not the sparse blob behind it.
     *
     * ⚠️ Every default here must match the one the render path uses, which is
     * why they live together in this one function rather than being repeated at
     * each `|| '22:00'` site.
     */
    sleepEffective(sleep) {
        const s = sleep || {};
        const { enabled, method } = this.sleepModeOf(s);
        return {
            enabled,
            sleepMethod: method,
            sleepTime: s.sleepTime || '22:00',
            wakeTime: s.wakeTime || '07:00',
            resleepTimeout: s.resleepTimeout ?? 15,
            inactivityTimeout: s.inactivityTimeout ?? 120,
            // The three switches. `=== true` is the render path's own test, so an
            // absent key is FALSE — resolving them here means "apply this dialog"
            // copies the switch positions you can see, not only the ones that
            // happen to be stored.
            sleepShowClock: s.sleepShowClock === true,
            reduceBrightnessOnSleep: s.reduceBrightnessOnSleep === true,
            motionWakeForSleep: s.motionWakeForSleep === true,
        };
    },

    /** The Sleep dialog's "Options" row lives in DISPLAY, not sleep. Same default
     *  as buildSleepSummary uses, kept beside it so the two cannot drift. */
    screenOffEffective(display) {
        return (display && (display.screenOffBehavior || display['display.screenOffBehavior'])) || 'black_overlay';
    },

    sleepModeOf(sleep) {
        const s = sleep || {};
        const enabled = s.enabled !== false;
        const method = s.sleepMethod || 'schedule';
        return { enabled, method, mode: enabled ? method : 'off' };
    },

    /** "22:00 / 07:00 (Black Overlay)" / "2 min timeout (Black Overlay)" / "Inactive" */
    buildSleepSummary(sleep, display) {
        // Blob keys are UNPREFIXED (native-settings-listener.js writes enabled,
        // sleepMethod, sleepTime, wakeTime, inactivityTimeout). Mode is derived:
        // off when disabled, else the method. (Was reading sleep['sleep.enabled']
        // etc. — always undefined, so the summary rendered defaults forever.)
        const { enabled, method } = this.sleepModeOf(sleep);
        if (!enabled) return 'Inactive';
        let timeStr;
        if (method === 'inactivity') {
            const seconds = Number(sleep.inactivityTimeout ?? 120);
            timeStr = `${this._formatTimeout(seconds)} timeout`;
        } else {
            const start = sleep.sleepTime || '22:00';
            const end = sleep.wakeTime || '07:00';
            timeStr = `${this._formatTime(start)} / ${this._formatTime(end)}`;
        }
        const screenOff = (display && (display.screenOffBehavior || display['display.screenOffBehavior'])) || 'black_overlay';
        const offLabel = screenOff === 'power_off' ? 'Power Off' : 'Black Overlay';
        return `${timeStr} (${offLabel})`;
    },

    /** Just the theme family — dark/light is its own toggle inside the
     *  Theme modal, surfacing it here doubles up the same control. */
    buildThemeSummary(display) {
        const fam = display.themeFamily || 'default';
        return this._labelFor(this.THEME_FAMILIES, fam);
    },

    /** "Photos, 5 min" / "Off" / "{Mode} ({timeout})"
     *  Reads from user_devices.settings.screensaver.* (the canonical shape
     *  written by device-registration.js _buildScreensaverSettings), falling
     *  back to legacy display.screensaverX paths if the device hasn't yet
     *  written the new category. */
    buildScreensaverSummary(display, screensaver) {
        const s = screensaver || {};
        const timeout = Number(s.timeout ?? display?.screensaverTimeout ?? display?.['screensaver.timeout'] ?? 0);
        if (!timeout) return 'Off';
        const mode = s.mode || display?.screensaverMode || display?.['screensaver.mode'] || 'dim';
        const modeLabel = this._labelFor(this.SCREENSAVER_MODES, mode);
        return `${modeLabel}, ${this._formatTimeout(timeout)}`;
    },

    // ── Sleep modal ────────────────────────────────────────────

    _sleepOpen: false,
    _sleepDeviceId: null,

    /**
     * `compact` is the CARD's entry. John, 2026-09-21: *"From the cards, let's not have
     * sleep / wake open the full modal with all settings. Let's only show sleep mode,
     * sleep time, and wake time. Everything else below that should only be set from the
     * full settings menu."* The card is a glance-and-adjust surface; the full dialog
     * still lives on the device's own settings page, unchanged.
     */
    openSleep(deviceId, compact = false) {
        this._resetAlso();
        this._sleepOpen = true;
        this._sleepCompact = compact === true;
        this._sleepDeviceId = deviceId;
        App.renderPage();
    },
    _sleepCompact: false,
    closeSleep() { this._sleepOpen = false; this._sleepDeviceId = null; App.renderPage(); },

    renderSleepModal() {
        if (!this._sleepOpen) return '';
        const device = DevicesPage._findDevice(this._sleepDeviceId);
        if (!device) return '';
        const sleep = device.settings?.sleep || {};
        const display = device.settings?.display || {};

        // Keys MUST match the app's blob (SETTINGS_KEY_MAP.sleep): enabled,
        // sleepMethod, sleepTime, wakeTime, resleepTimeout, inactivityTimeout,
        // sleepShowClock, reduceBrightnessOnSleep, motionWakeForSleep. There is
        // NO `sleep.*`-prefixed key and NO stored sleepMode — the mode is derived
        // from enabled + sleepMethod (off / schedule / inactivity).
        const { enabled, method, mode: sleepMode } = this.sleepModeOf(sleep);
        // The card opens this dialog COMPACT: mode + the chosen mode's own times, and
        // nothing else. Every write below still exists in this function in both branches,
        // so check-apply-targets still sees the full set.
        //
        // ⚠️ "Also apply to" from the compact dialog still copies the device's WHOLE sleep
        // configuration, including the rows hidden here. That is deliberate and is what
        // John asked for on 2026-09-21 ("is it going to apply all of the sleep settings?"):
        // the fan-out means "make these devices sleep like this one", and copying three of
        // nine would leave targets in a state matching no device. Compact limits what you
        // may EDIT here, not what copying a device's sleep setup means.
        const compact = this._sleepCompact === true;
        const scheduleVisible = sleepMode === 'schedule';
        const inactivityVisible = sleepMode === 'inactivity';
        const optionsVisible = sleepMode !== 'off';
        const screenOff = display.screenOffBehavior || 'black_overlay';
        const notPowerOff = screenOff !== 'power_off';

        const D = DevicesDetail;
        const body = `
            <div style="display: flex; flex-direction: column; gap: 14px;">
                <div class="form-group">
                    <label class="form-label">Sleep Mode</label>
                    ${D._settingSelectRaw(device, 'sleep', 'sleepMode', sleepMode, [
                        ['off', 'Off'], ['schedule', 'Schedule'], ['inactivity', 'Timeout']
                    ], 'DevicesDetailModals._onSleepModeChange(this.value)')}
                </div>
                ${scheduleVisible ? `
                    ${this._divider('Schedule')}
                    ${D.settingSelect(device, 'sleep', 'sleepTime',
                        'Sleep Time', sleep.sleepTime || '22:00', OptionCatalog.sleepTimes())}
                    ${D.settingSelect(device, 'sleep', 'wakeTime',
                        'Wake Time', sleep.wakeTime || '07:00', OptionCatalog.wakeTimes())}
                    ${compact ? '' : D.settingSelect(device, 'sleep', 'resleepTimeout',
                        'Re-sleep Delay (min)', String(sleep.resleepTimeout ?? 15), OptionCatalog.resleepDelays())}
                ` : ''}
                ${inactivityVisible ? `
                    ${this._divider('Inactivity')}
                    ${D.settingSelect(device, 'sleep', 'inactivityTimeout',
                        'Sleep After (sec)', String(sleep.inactivityTimeout ?? 120), OptionCatalog.inactivityTimeouts())}
                ` : ''}
                ${optionsVisible && !compact ? `
                    ${this._divider('Options')}
                    ${D._settingSelectRaw(device, 'display', 'screenOffBehavior', screenOff, this.SCREEN_OFF_BEHAVIORS)}
                    ${notPowerOff ? `
                        ${D._settingToggleRow(device, 'sleep', 'sleepShowClock',
                            'Show Clock During Sleep', sleep.sleepShowClock === true)}
                        ${D._settingToggleRow(device, 'sleep', 'reduceBrightnessOnSleep',
                            'Reduce Brightness While Asleep', sleep.reduceBrightnessOnSleep === true)}
                    ` : ''}
                    ${D._settingToggleRow(device, 'sleep', 'motionWakeForSleep',
                        'Motion Wake', sleep.motionWakeForSleep === true)}
                ` : ''}
            </div>
            ${this._rawReadout(device, 'sleep')}
        `;
        return this._modal('Sleep / Wake', body, 'DevicesDetailModals.closeSleep()', this._alsoFooter(), device);
    },

    _onSleepModeChange(value) {
        const device = DevicesPage._findDevice(this._sleepDeviceId);
        if (!device) return;
        const enabled = value !== 'off';
        // Preserve the underlying schedule/inactivity method when turning sleep
        // off, so re-enabling restores the prior mode. Only enabled + sleepMethod
        // are persisted — sleepMode is a UI-only projection of those two.
        const method = value === 'off' ? (device.settings?.sleep?.sleepMethod || 'schedule') : value;
        DevicesPage._onSettingChange(device.device_id, 'sleep', 'enabled', enabled);
        DevicesPage._onSettingChange(device.device_id, 'sleep', 'sleepMethod', method);
    },

    // ── Theme modal (family + dark mode) ──────────────────────

    _themeOpen: false,
    _themeDeviceId: null,

    openTheme(deviceId) { this._resetAlso(); this._themeOpen = true; this._themeDeviceId = deviceId; App.renderPage(); },
    closeTheme() { this._themeOpen = false; this._themeDeviceId = null; App.renderPage(); },

    /**
     * 🔴 THIS IS THE ONLY GATE, and until 2026-09-21 the comment inside claimed
     * otherwise — "the row that opens this is already gated". It never was:
     * devices-card.js rendered the Theme row unconditionally, so the row opened
     * a modal that returned '' and the page simply did not react. John hit it
     * on a device holding `fern`. The card now asks FeatureGate before drawing
     * the swatch as a button, and this stays as the second half.
     *
     * ⚠️ The early return must stay within a few lines of the function head —
     * `check-family-only-options.test.ts` asserts it returns EARLY, not merely
     * that the call appears somewhere in the body. Explanations go here, above.
     */
    renderThemeModal() {
        if (!this._themeOpen) return '';
        // Gated on the ACCOUNT (see the note above renderThemeModal).
        if (!FeatureGate.optionAllowed('display.themeFamily')) return '';
        const device = DevicesPage._findDevice(this._themeDeviceId);
        if (!device) return '';
        const display = device.settings?.display || {};
        const D = DevicesDetail;
        // Dark/Light mode is a SEPARATE control (the Quick Controls row on the
        // device card), NOT part of the theme. Deliberately omitted here and
        // from buildThemeSummary — theme = family only (2026-07-06, per user).
        const body = `
            <div style="display: flex; flex-direction: column; gap: 14px;">
                <div class="form-group">
                    <label class="form-label">Theme</label>
                    ${D._settingSelectRaw(device, 'display', 'themeFamily',
                        display.themeFamily || 'default', this.THEME_FAMILIES)}
                </div>
                <div style="font-size: var(--font-size-sm); color: var(--text-muted);">
                    Seasonal themes (Halloween, Christmas) auto-activate during their respective months.
                </div>
            </div>
        `;
        return this._modal('Theme', body, 'DevicesDetailModals.closeTheme()', this._alsoFooter(), device);
    },

    // ── Generic single-picker modal ───────────────────────────

    _pickerOpen: false,
    _pickerCtx: null,  // {deviceId, category, key, label, optionsCatalogKey}

    openPicker(deviceId, category, key, label, optionsCatalogKey, defaultValue) {
        this._pickerOpen = true;
        this._pickerCtx = { deviceId, category, key, label, optionsCatalogKey, defaultValue };
        App.renderPage();
    },
    closePicker() { this._pickerOpen = false; this._pickerCtx = null; App.renderPage(); },

    renderPickerModal() {
        if (!this._pickerOpen) return '';
        const ctx = this._pickerCtx;
        const device = DevicesPage._findDevice(ctx.deviceId);
        if (!device) return '';
        // Edition filter, applied HERE so it covers every picker rather than
        // each caller remembering. ctx.category+key is exactly the key shape
        // FAMILY_ONLY_OPTIONS uses (e.g. 'display.layoutMode' → drops 'widgets',
        // the family dashboard, from the published build).
        const options = FeatureGate.filterOptions(
            `${ctx.category}.${ctx.key}`, this[ctx.optionsCatalogKey] || []);
        // Default chain: stored value → caller-supplied default → first
        // option. Falling all the way through to options[0] is what made
        // Widget Zoom show "50%" when the device hadn't yet broadcast
        // a value — callers should pass an explicit defaultValue.
        const stored = device.settings?.[ctx.category]?.[ctx.key];
        const current = (stored != null && stored !== '') ? stored
            : (ctx.defaultValue != null ? ctx.defaultValue
            : options[0]?.[0]);
        const body = `
            <div class="form-group">
                <label class="form-label">${this._escape(ctx.label)}</label>
                ${DevicesDetail._settingSelectRaw(device, ctx.category, ctx.key, String(current), options)}
            </div>
        `;
        return this._modal(ctx.label, body, 'DevicesDetailModals.closePicker()', null, device);
    },

    // ── Screensaver modal ─────────────────────────────────────

    /**
     * The raw stored values, ON SCREEN, beside the controls that claim to show them.
     *
     * 🔴 WHY THIS IS IN THE UI AND NOT A console.log (John, 2026-09-22):
     * two releases in a row shipped a diagnostic into the BROWSER console —
     * `_verifyWrite`'s VERIFY/MISMATCH lines in 0.9.36, the off-list DROP:
     * marker in 0.9.37 — and neither produced a reading. This console runs as
     * an iframe panel inside Home Assistant, so "open devtools and read the
     * console" means finding the right frame first. An instrument nobody can
     * reach measures nothing, and two rounds of "still wrong" with no data is
     * the instrument's fault, not the reporter's.
     *
     * Shows the exact JSON this page holds for the categories a dialog edits,
     * plus the device_id — and, when more than one row carries this device's
     * name, every one of them. That last part is the discriminator for the
     * case John raised himself ("we have removed/added devices here"): a
     * removed-and-re-added device mints a NEW device_id, so the console edits
     * one row while the tablet reads another. The page CANNOT show that today
     * because inactive rows are filtered into the Archived section, where they
     * are never seen beside the active one.
     *
     * Tech view only — a debugging surface, not a feature.
     */
    _rawReadout(device, ...categories) {
        if (!DevicesPage._techView) return '';
        const E = (v) => this._escape(String(v));
        const line = (k, v) => `<div style="margin-top:2px;"><span style="opacity:.6;">${E(k)}</span> ${E(v)}</div>`;
        // The estate FIRST — it is the thing that makes every value below it
        // meaningful or meaningless, and it was the one fact no surface showed.
        const url = (DashieAuth.config?.url || '').replace('https://', '').replace('.supabase.co', '');
        const env = DashieAuth._addonSupabaseEnv;
        const prod = ['prod', 'production', 'stable'].includes(env);
        let html = `<div style="margin-bottom:6px; font-weight:600; color:${prod ? '#2d7d46' : '#b06000'};">`
            + `reading ${prod ? 'PROD' : 'STAGING'} — cloud_env=${E(env || 'unknown')} · ${E(url)}`
            + ` · ${E(DashieAuth.jwtUserEmail || 'not signed in')}</div>`;
        html += line('device_id', device.device_id);
        for (const c of categories) {
            html += line(c, JSON.stringify(device.settings?.[c] ?? null));
        }
        const twins = (DevicesPage._devices || []).filter(
            (d) => d.device_name === device.device_name);
        if (twins.length > 1) {
            html += `<div style="margin-top:8px; color:#c0392b; font-weight:600;">`
                + `${twins.length} rows carry the name "${E(device.device_name)}" — the console edits `
                + `one of them and the device may be reading another:</div>`;
            for (const t of twins) {
                const cats = categories.map((c) => `${c}=${JSON.stringify(t.settings?.[c] ?? null)}`).join(' ');
                html += line(`${t.device_id}${t.is_active === false ? ' (inactive)' : ''}`, cats);
            }
        }
        return `<div style="margin-top:14px; padding-top:10px; border-top:1px solid var(--border);
            font-family: ui-monospace, monospace; font-size:11px; color: var(--text-muted); word-break:break-all;">
            <div style="opacity:.6; margin-bottom:4px;">stored in the database (tech view)</div>
            ${html}
        </div>`;
    },

    _screensaverOpen: false,
    _screensaverDeviceId: null,

    openScreensaver(deviceId) { this._screensaverOpen = true; this._screensaverDeviceId = deviceId; App.renderPage(); },
    closeScreensaver() { this._screensaverOpen = false; this._screensaverDeviceId = null; App.renderPage(); },

    renderScreensaverModal() {
        if (!this._screensaverOpen) return '';
        const device = DevicesPage._findDevice(this._screensaverDeviceId);
        if (!device) return '';
        const s = device.settings?.screensaver || {};
        const display = device.settings?.display || {};
        const timeout = String(s.timeout ?? display.screensaverTimeout ?? '0');
        const mode = s.mode || display.screensaverMode || 'dim';
        const D = DevicesDetail;
        const enabled = timeout !== '0';
        const showClock = s.showClock === true;
        const body = `
            <div style="display: flex; flex-direction: column; gap: 14px;">
                <div class="form-group">
                    <label class="form-label">Timeout</label>
                    ${D._settingSelectRaw(device, 'screensaver', 'timeout', timeout, this.SCREENSAVER_TIMEOUTS)}
                </div>
                ${enabled ? `
                    <div class="form-group">
                        <label class="form-label">Mode</label>
                        ${D._settingSelectRaw(device, 'screensaver', 'mode', mode, this.SCREENSAVER_MODES)}
                    </div>
                    ${(mode === 'dim' || mode === 'black' || mode === 'photos') ? `
                        ${D._settingToggleRow(device, 'screensaver', 'showClock', 'Show Clock', showClock)}
                        ${showClock ? D._settingToggleRow(device, 'screensaver', 'showDate',
                            'Show Date', s.showDate === true) : ''}
                    ` : ''}
                ` : ''}
            </div>
            ${this._rawReadout(device, 'screensaver', 'display')}
        `;
        return this._modal('Screensaver', body, 'DevicesDetailModals.closeScreensaver()', null, device);
    },

    // ── Advanced Display Options modal ────────────────────────

    _advancedDisplayOpen: false,
    _advancedDisplayDeviceId: null,

    openAdvancedDisplay(deviceId) {
        this._advancedDisplayOpen = true;
        this._advancedDisplayDeviceId = deviceId;
        App.renderPage();
    },
    closeAdvancedDisplay() {
        this._advancedDisplayOpen = false;
        this._advancedDisplayDeviceId = null;
        App.renderPage();
    },

    /** "100% / 100% · Medium" — most-glanceable values for the row. */
    _buildAdvancedDisplaySummary(display) {
        const ds = String(display.displaySize ?? '100');
        const fs = String(display.widgetFontSize ?? '100');
        const sis = this._labelFor(this.SIDEBAR_ICON_SIZES, String(display.sidebarIconSize ?? '1'));
        return `${ds}% / ${fs}% · ${sis}`;
    },

    renderAdvancedDisplayModal() {
        if (!this._advancedDisplayOpen) return '';
        const device = DevicesPage._findDevice(this._advancedDisplayDeviceId);
        if (!device) return '';
        const display = device.settings?.display || {};
        const D = DevicesDetail;
        const body = `
            <div style="display: flex; flex-direction: column; gap: 14px;">
                <div class="form-group">
                    <label class="form-label">Display Size</label>
                    ${D._settingSelectRaw(device, 'display', 'displaySize',
                        String(display.displaySize ?? '100'), this.DISPLAY_SIZES)}
                </div>
                <div class="form-group">
                    <label class="form-label">Font Size</label>
                    ${D._settingSelectRaw(device, 'display', 'widgetFontSize',
                        String(display.widgetFontSize ?? '100'), this.FONT_SIZES)}
                </div>
                <div class="form-group">
                    <label class="form-label">HA Dashboard Zoom</label>
                    ${D._settingSelectRaw(device, 'display', 'dashboardZoom',
                        String(display.dashboardZoom ?? '100'), this.ZOOM_LEVELS)}
                </div>
                <div class="form-group">
                    <label class="form-label">Widget Zoom</label>
                    ${D._settingSelectRaw(device, 'display', 'widgetZoom',
                        String(display.widgetZoom ?? '100'), this.ZOOM_LEVELS)}
                </div>
                <div class="form-group">
                    <label class="form-label">Sidebar Icon Size</label>
                    <!-- Read-only: sidebarIconSize is sync:'readback-only' (no cloud→Kotlin
                         setter), so a console write silently reverts on the next readback. -->
                    <div style="padding: 8px 0; color: var(--text-muted); font-size: var(--font-size-sm);">${this._escape(this._labelFor(this.SIDEBAR_ICON_SIZES, String(display.sidebarIconSize ?? '1')))}</div>
                </div>
                <div class="form-group">
                    <label class="form-label">Screen Off Behavior</label>
                    ${D._settingSelectRaw(device, 'display', 'screenOffBehavior',
                        display.screenOffBehavior || 'black_overlay', this.SCREEN_OFF_BEHAVIORS)}
                </div>
                ${D._settingToggleRow(device, 'display', 'autoBrightnessEnabled',
                    'Auto Brightness', display.autoBrightnessEnabled === true)}
            </div>
        `;
        return this._modal('Advanced Display Options', body, 'DevicesDetailModals.closeAdvancedDisplay()', null, device);
    },

    // ── Wake Word modal (DEVICE-level user_devices.aiVoice.wakeWord — D5) ──
    // Per-device, mirroring the Personality picker. The device's WakeWordModelManager
    // persists the selection and applies it on the NEXT restart, so the UI tells the user.

    _wakeWordOpen: false,
    _wakeWordDeviceId: null,
    _wakeWordSaving: false,
    _wakeWordPending: null,  // value chosen but not yet persisted

    openWakeWord(deviceId) {
        this._wakeWordOpen = true;
        this._wakeWordDeviceId = deviceId;
        this._wakeWordPending = null;
        App.renderPage();
    },

    closeWakeWord() {
        this._wakeWordOpen = false;
        this._wakeWordDeviceId = null;
        this._wakeWordPending = null;
        App.renderPage();
    },

    _setWakeWordPending(value) { this._wakeWordPending = value; },

    async submitWakeWord() {
        if (this._wakeWordSaving) return;
        const value = this._wakeWordPending;
        const deviceId = this._wakeWordDeviceId;
        // ⚠️ `value == null` — NOT `!value`. '' is the inherit sentinel, so a falsy
        // test read "put this device back on the account default" as "nothing was
        // chosen" and closed without saving. The dialog looked like it worked.
        if (value == null || !deviceId) { this.closeWakeWord(); return; }
        this._wakeWordSaving = true;
        App.renderPage();
        try {
            // Per-device write: user_devices.aiVoice.wakeWord (the path the app reads +
            // reports back). Same merge-per-key RPC the Personality/Theme pickers use.
            await DevicesPage._onSettingChange(deviceId, 'aiVoice', 'wakeWord', value);
            Toast.success(value === ''
                ? 'This device now follows the account wake word — restart it to apply'
                : 'Wake word saved — restart the device to apply');
            this.closeWakeWord();
        } catch (e) {
            Toast.error(`Save failed: ${e?.message || e}`);
        } finally {
            this._wakeWordSaving = false;
            App.renderPage();
        }
    },

    renderWakeWordModal() {
        if (!this._wakeWordOpen) return '';
        const device = DevicesPage._findDevice(this._wakeWordDeviceId);
        // 🔴 '' is INHERIT and must be offerable, not just arrivable-at.
        // Before this the picker listed only the six words, and an inheriting device
        // was shown the HOUSEHOLD's word preselected as though it were its own. Two
        // consequences, both John's report (2026-09-21): the card correctly said
        // "Hey Dashie (default)" while the picker gave no way back to the default,
        // and pressing Save on an untouched inheriting device silently converted it
        // into an explicit override of the same value — so the device stopped
        // following the household and nothing said so.
        const own = device?.settings?.aiVoice?.wakeWord;
        const current = this._wakeWordPending != null
            ? this._wakeWordPending
            : (typeof own === 'string' && own !== '' ? own : '');
        // The label lookup lives on VoiceAiOptions (the ONE console copy of the word
        // list), not on VoiceAiApi. Guarded because this renders on a page path:
        // an unknown id yields '' there, and the raw id is a better fallback than
        // an empty parenthesis — but "the account setting" is better than both when
        // the household has not chosen one at all.
        const houseId = this._inherited('aiVoice', 'wakeWord', VoiceAiApi.defaultWakeWord(), device);
        const houseLabel = (window.VoiceAiOptions?.wakeWordLabel?.(houseId) || houseId)
            || 'the account setting';
        const optionsHtml = [
            this._offListOption(current, this.WAKE_WORDS.map((w) => w.id), 'voice.wakeWord'),
            `<option value="" ${current === '' ? 'selected' : ''}>${this._escape(this._defaultLabel(houseLabel, device))}</option>`,
            ...this.WAKE_WORDS.map(({ id, label }) =>
                `<option value="${this._escape(id)}" ${id === current ? 'selected' : ''}>${this._escape(label)}</option>`),
        ].join('');
        const body = `
            <div class="form-group">
                <label class="form-label">Wake Word</label>
                <select class="form-select" onchange="DevicesDetailModals._setWakeWordPending(this.value)">
                    ${optionsHtml}
                </select>
            </div>
            <div style="font-size: var(--font-size-sm); color: var(--text-muted);">
                This device's wake word. <strong>Applies after the device restarts.</strong>
            </div>
            <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px;">
                <button class="btn btn-secondary" onclick="DevicesDetailModals.closeWakeWord()" ${this._wakeWordSaving ? 'disabled' : ''}>Cancel</button>
                <button class="btn btn-primary" onclick="DevicesDetailModals.submitWakeWord()" ${this._wakeWordSaving ? 'disabled' : ''}>${this._wakeWordSaving ? 'Saving…' : 'Save'}</button>
            </div>
            ${this._rawReadout(device, 'voice')}
        `;
        return this._modal('Wake Word', body, 'DevicesDetailModals.closeWakeWord()', null, device);
    },

    // ── Personality catalog (shared) ──────────────────────────────
    // A device stores aiVoice.personalityId — a built-in template KEY
    // ('dashie', 'pirate', …) or a custom personality UUID. The card/detail
    // summaries and the picker all need to turn that id into a human name, so
    // the catalog + resolver live here and are reused everywhere. Matches the
    // app's own scheme (personality-service.js: template id === key, custom by
    // uuid) and the Voice & AI page (_personalityRow: key for built-ins, id for
    // custom). Cached for the session; prefetched by DevicesPage on load.

    _personalityCatalog: null,  // [[id, name], …] templates (by key) + custom (by uuid)
    _personalityRecords: null,  // raw rows (voice_mode/voice) — for the voice-lock check (WS-G)

    async loadPersonalityCatalog() {
        if (this._personalityCatalog || typeof VoiceAiApi === 'undefined') return this._personalityCatalog;
        try {
            const [templates, custom] = await Promise.all([
                VoiceAiApi.listTemplates().catch(() => []),
                VoiceAiApi.listCustom().catch(() => []),
            ]);
            const opts = [];
            const records = new Map();
            for (const t of templates || []) {
                const key = t.key || t.id;
                if (!key) continue;
                opts.push([String(key), t.name || DevicesDetail._titleCase(key)]);
                records.set(String(key), t);
            }
            for (const c of custom || []) {
                if (!c.id) continue;
                opts.push([String(c.id), c.name || 'Custom personality']);
                records.set(String(c.id), c);
            }
            this._personalityCatalog = opts;
            this._personalityRecords = records;
        } catch { this._personalityCatalog = []; this._personalityRecords = new Map(); }
        return this._personalityCatalog;
    },

    personalityRecord(id) {
        return (this._personalityRecords || new Map()).get(String(id)) || null;
    },

    // ── Voice catalog + account defaults (shared by the WS-G modals) ──

    _voiceCatalog: null,          // tts_voices rows ({key, name, gender, …})
    _accountDefaults: null,       // { personalityId, voiceKey } — ai.default*

    async _loadVoiceCatalog() {
        if (this._voiceCatalog || typeof VoiceAiApi === 'undefined') return this._voiceCatalog;
        try { this._voiceCatalog = await VoiceAiApi.listVoices(); }
        catch { this._voiceCatalog = []; }
        return this._voiceCatalog;
    },

    async _loadAccountDefaults() {
        try {
            const d = await VoiceAiApi.loadAiDefaults();
            this._accountDefaults = {
                personalityId: String(d['ai.defaultPersonalityId'] || 'dashie'),
                voiceKey: String(d['ai.defaultVoiceKey'] || ''),
            };
        } catch { /* labels render without names */ }
        return this._accountDefaults;
    },

    /** Resolve a voice key → display name (falls back to a prettified key). */
    voiceName(key) {
        if (!key) return '';
        const v = (this._voiceCatalog || []).find(x => (x.key || x.voice_key) === key);
        return v?.name || (key.charAt(0) + key.slice(1).toLowerCase());
    },

    /** The personality a device EFFECTIVELY runs: its own override, else the
     *  account default (WS-G resolution rule — mirrored here for display/lock). */
    effectivePersonalityId(device) {
        return device.settings?.aiVoice?.personalityId
            || this._inherited('aiVoice', 'personalityId', this._accountDefaults?.personalityId, device)
            || 'dashie';
    },

    /** Resolve a stored personalityId → display name. Falls back to a prettified
     *  id when the catalog hasn't loaded yet or the id is unknown (e.g. a custom
     *  personality that was deleted). An empty id = the device follows the
     *  account default (WS-G unset-=-inherit). */
    personalityName(id, device) {
        // Inheriting reads as the RESOLVED default, matching the tablet
        // (VoiceAiSettingsWiring.kt:490 — `if (ai.personalityInheriting)
        // "$name (Default)" else name`). Falls through to a bare 'Default'
        // when the account's own id has not loaded yet.
        if (!id) {
            const acct = this._inherited('aiVoice', 'personalityId', this._accountDefaults?.personalityId, device);
            return this._defaultLabel(acct ? this.personalityName(acct, device) : '', device);
        }
        const hit = (this._personalityCatalog || []).find(([v]) => v === String(id));
        return hit ? hit[1] : DevicesDetail._titleCase(id);
    },

    // ── Personality picker (device-level aiVoice.personalityId) ───

    _personalityOpen: false,
    _personalityDeviceId: null,

    async openVoicePersonality(deviceId) {
        this._resetAlso();
        this._personalityOpen = true;
        this._personalityDeviceId = deviceId;
        App.renderPage();
        // Lazy-load the personality catalog + the account defaults (labels the
        // "Account default (<name>)" inherit option). Best-effort.
        await Promise.all([this.loadPersonalityCatalog(), this._loadAccountDefaults()]);
        App.renderPage();
    },

    closeVoicePersonality() { this._personalityOpen = false; App.renderPage(); },

    renderVoicePersonalityModal() {
        if (!this._personalityOpen) return '';
        const device = DevicesPage._findDevice(this._personalityDeviceId);
        if (!device) return '';
        // '' / unset = follow the account default (WS-G). Runtime resolution is
        // device ?? account default; until Round B ships it, an inheriting
        // device behaves as the app default (Dashie).
        const current = device.settings?.aiVoice?.personalityId || '';
        // The BARE name — _defaultLabel does the wrapping. It used to arrive
        // pre-wrapped as " (Rachel)" for string concatenation, which through the
        // helper reads " (Rachel) (Default)".
        const inheritedPersonality = this._inherited('aiVoice', 'personalityId', this._accountDefaults?.personalityId, device);
        const defaultName = inheritedPersonality ? this.personalityName(inheritedPersonality) : '';
        // Ensure the currently-stored personality is always selectable, even if
        // the catalog is still loading or the id is no longer in the catalog —
        // otherwise the <select> would silently snap to the first option and a
        // stray change-event could overwrite a valid value.
        const catalog = [['', this._defaultLabel(defaultName, device)], ...(this._personalityCatalog || [])];
        const options = catalog.some(([v]) => v === String(current))
            ? catalog
            : [[String(current), this.personalityName(current)], ...catalog];
        const body = `
            <div class="form-group">
                <label class="form-label">Personality</label>
                ${DevicesDetail._settingSelectRaw(device, 'aiVoice', 'personalityId', String(current), options)}
            </div>
            <div style="font-size: var(--font-size-sm); color: var(--text-muted);">
                The “(Default)” entry follows the personality set on the <a href="#voice-ai" onclick="event.preventDefault(); App.navigate('voice-ai')">Voice & AI</a> page; picking one here overrides it for this device only.
            </div>
        `;
        return this._modal('Personality', body, 'DevicesDetailModals.closeVoicePersonality()', this._alsoFooter(), device);
    },

    // ── Voice picker (device-level aiVoice.voiceKey — WS-G) ───────
    // Separate from personality: the device speaks the account default voice
    // unless overridden here. Voice lock wins — when the device's EFFECTIVE
    // personality (override ?? account default) fixes its voice, there is no
    // picker, just the locked explanation.

    _voiceOpen: false,
    _voiceDeviceId: null,

    async openVoiceVoice(deviceId) {
        this._resetAlso();
        this._voiceOpen = true;
        this._voiceDeviceId = deviceId;
        App.renderPage();
        await Promise.all([this.loadPersonalityCatalog(), this._loadVoiceCatalog(), this._loadAccountDefaults()]);
        App.renderPage();
    },

    closeVoiceVoice() { this._voiceOpen = false; App.renderPage(); },

    renderVoiceVoiceModal() {
        if (!this._voiceOpen) return '';
        const device = DevicesPage._findDevice(this._voiceDeviceId);
        if (!device) return '';
        const effectiveId = this.effectivePersonalityId(device);
        const p = this.personalityRecord(effectiveId);
        if (p && p.voice_mode === 'fixed') {
            const body = `
                <div style="font-size: 14px; margin-bottom: 8px;">
                    ${DevicesPage._escape(this.voiceName(p.voice))}
                    <span style="font-size: 11px; font-weight: 600; color: var(--text-muted); background: var(--bg-muted, #f4f4f5); border-radius: 999px; padding: 2px 8px; margin-left: 8px;">locked by ${DevicesPage._escape(p.name || 'personality')}</span>
                </div>
                <div style="font-size: var(--font-size-sm); color: var(--text-muted);">
                    ${DevicesPage._escape(p.name || 'This personality')} always speaks in this voice.
                    Choose a voice-flexible personality (here or on the Voice &amp; AI page) to pick a voice.
                </div>`;
            return this._modal('Voice', body, 'DevicesDetailModals.closeVoiceVoice()', null, device);
        }
        // '' / unset = follow the account default voice (itself '' = the
        // personality's preferred voice). Same inherit sentinel as personality.
        // Premium flag (John, 2026-07-12): ElevenLabs voices cost ~4× the
        // default Dashie voice (Inworld) per character — mark them explicitly.
        const current = device.settings?.aiVoice?.voiceKey || '';
        const inheritedVoiceKey = this._inherited('aiVoice', 'voiceKey', this._accountDefaults?.voiceKey, device);
        const accountVoice = inheritedVoiceKey
            ? this.voiceName(inheritedVoiceKey)
            : (p?.voice ? this.voiceName(p.voice) : '');
        const options = [
            ['', this._defaultLabel(accountVoice, device)],
            ...(this._voiceCatalog || []).map(v => {
                const key = v.key || v.voice_key;
                const tier = v.provider === 'elevenlabs' ? ' · premium'
                    : v.provider === 'inworld' ? ' · most economical' : '';
                return [key, `${v.name || key}${v.gender ? ` · ${v.gender}` : ''}${tier}`];
            }),
        ];
        const body = `
            <div class="form-group">
                <label class="form-label">Voice</label>
                ${DevicesDetail._settingSelectRaw(device, 'aiVoice', 'voiceKey', String(current), options)}
            </div>
            <div style="font-size: var(--font-size-sm); color: var(--text-muted);">
                The “(Default)” entry follows the voice set on the <a href="#voice-ai" onclick="event.preventDefault(); App.navigate('voice-ai')">Voice &amp; AI</a> page; picking one here overrides it for this device only.
                Premium voices cost about 4× the default ${BRAND.assistantName} voice per reply.
            </div>`;
        return this._modal('Voice', body, 'DevicesDetailModals.closeVoiceVoice()', this._alsoFooter(), device);
    },

    // ── Photos picker (device-level photos.sourceType + album) ────
    // Source type is device-specific; albums are listable only for the Dashie
    // Cloud (supabase) source via list_albums (account-level album catalog).
    // Writes photos.sourceType, and photos.albumId + photos.albumName when a
    // Dashie Cloud album is chosen — the keys applyDeviceSettings fans out to
    // the photo widget on each device.

    _photosOpen: false,
    _photosDeviceId: null,
    _photosSource: null,        // live source selection (drives album-picker visibility)
    _photosAlbums: null,        // cached list_albums result this session

    async openPhotos(deviceId) {
        this._resetAlso();
        this._photosOpen = true;
        this._photosDeviceId = deviceId;
        const device = DevicesPage._findDevice(deviceId);
        this._photosSource = device?.settings?.photos?.sourceType || 'unsplash';
        App.renderPage();
        if (this._photosSource === 'supabase') this._loadAlbums();
    },

    closePhotos() {
        this._photosOpen = false;
        this._photosDeviceId = null;
        this._photosSource = null;
        App.renderPage();
    },

    async _loadAlbums() {
        if (this._photosAlbums || typeof DashieAuth === 'undefined') return;
        try {
            const res = await DashieAuth.dbRequest('list_albums', {});
            this._photosAlbums = res.albums || res.data || [];
        } catch { this._photosAlbums = []; }
        App.renderPage();
    },

    // Source options mirror settings-photos-page.js. HA sources (Home Assistant,
    // Immich) only make sense when the device runs HA, so gate them on the
    // device's stored home_assistant.core.haEnabled. The console user is always
    // logged in, so the cloud/drive sources are always offered.
    _photoSourceOptions(device) {
        const haEnabled = device?.settings?.home_assistant?.core?.haEnabled === true;
        // The edition filter drops `supabase` (Dashie Cloud albums — family
        // product) and `google_drive` (needs the Google Drive OAuth scope, which
        // the HA edition deliberately does not request) from the published build.
        // HA Media / Immich / Unsplash stay — screensaver albums are core here.
        return FeatureGate.filterOptions('photos.sourceType', [
            ...(haEnabled ? [['ha_media', 'Home Assistant'], ['immich', 'Immich']] : []),
            ['google_drive', 'Google Drive'],
            ['supabase', BRAND.cloudName],
            ['unsplash', 'Unsplash'],
        ]);
    },

    renderPhotosModal() {
        if (!this._photosOpen) return '';
        const device = DevicesPage._findDevice(this._photosDeviceId);
        if (!device) return '';
        const photos = device.settings?.photos || {};
        const source = this._photosSource || photos.sourceType || 'unsplash';
        const D = DevicesDetail;

        let albumPicker = '';
        if (source === 'supabase') {
            if (this._photosAlbums === null) {
                albumPicker = `<div style="font-size: var(--font-size-sm); color: var(--text-muted);">Loading albums…</div>`;
            } else {
                const albumOpts = [['', 'All photos'],
                    ...this._photosAlbums.map(a => [String(a.id), a.name || 'Untitled album'])];
                albumPicker = `
                    <div class="form-group">
                        <label class="form-label">Album</label>
                        ${D._settingSelectRaw(device, 'photos', 'albumId', String(photos.albumId || ''),
                            albumOpts, 'DevicesDetailModals._onPhotoAlbumChange(this.value)')}
                    </div>`;
            }
        } else if (source === 'immich') {
            albumPicker = this._renderImmichAlbums(photos);
        }

        // Only sources with no album picker get the generic "configure on device" note.
        const noPicker = source !== 'supabase' && source !== 'immich';
        const body = `
            <div style="display: flex; flex-direction: column; gap: 14px;">
                <div class="form-group">
                    <label class="form-label">Photo Source</label>
                    ${D._settingSelectRaw(device, 'photos', 'sourceType', source,
                        this._photoSourceOptions(device), 'DevicesDetailModals._onPhotoSourceChange(this.value)')}
                </div>
                ${albumPicker}
                ${noPicker ? `
                    <div style="font-size: var(--font-size-sm); color: var(--text-muted);">
                        Album selection is available for the ${BRAND.cloudName} and Immich sources. Other
                        sources use their own configuration on the device.
                    </div>` : ''}
            </div>
        `;
        return this._modal('Photos', body, 'DevicesDetailModals.closePhotos()', this._alsoFooter(), device);
    },

    // ── Immich albums (multi-select) ──────────────────────────────
    // The device publishes its album catalog to photos.availableImmichAlbums
    // ([{id, name}]) on each Immich sync (report-only — the Console never fetches
    // Immich directly; it's self-hosted behind the user's HA/LAN). The selection
    // lives in photos.immichSelectedAlbums (array of album ids; empty = all/random,
    // matching Kotlin ScreensaverPreferences.immich_selected_albums). NOTE: the
    // WRITE only reaches the device once the settings-clobber fix + a Kotlin
    // setImmichSelectedAlbums adopt-path ship — see .reference/SETTINGS_CONSOLE_DEVICE_CLOBBER.md.

    /** Album ids the device has selected (empty = all). Filters the "*" sentinel. */
    _immichSelected(photos) {
        const sel = photos?.immichSelectedAlbums;
        return Array.isArray(sel) ? sel.map(String).filter(x => x && x !== '*') : [];
    },

    _renderImmichAlbums(photos) {
        const available = Array.isArray(photos.availableImmichAlbums) ? photos.availableImmichAlbums : null;
        if (!available || available.length === 0) {
            return `<div class="form-group"><label class="form-label">Albums</label>
                <div style="font-size: var(--font-size-sm); color: var(--text-muted);">
                    This device hasn't published its Immich albums yet. Once it next syncs with
                    Immich, its albums will appear here to choose from.
                </div></div>`;
        }
        const selected = this._immichSelected(photos);
        const allSelected = selected.length === 0;
        const row = (checked, onChange, label, bold) => `
            <label style="display: flex; align-items: center; gap: 8px; padding: 6px 0; cursor: pointer;">
                <input type="checkbox" ${checked ? 'checked' : ''} onchange="${onChange}">
                <span style="${bold ? 'font-weight: 500;' : ''}">${DevicesPage._escape(label)}</span>
            </label>`;
        const items = available.map(a => {
            const id = String(a.id);
            return row(selected.includes(id),
                `DevicesDetailModals._onImmichAlbumToggle('${id}', this.checked)`,
                a.name || 'Untitled album', false);
        }).join('');
        return `
            <div class="form-group">
                <label class="form-label">Albums</label>
                <div style="border-bottom: 1px solid var(--border, #e5e7eb);">
                    ${row(allSelected, 'DevicesDetailModals._onImmichAlbumAll(this.checked)', 'All albums', true)}
                </div>
                <div style="max-height: 220px; overflow-y: auto;">${items}</div>
            </div>`;
    },

    /** Card summary of the Immich album selection. */
    immichAlbumSummary(photos) {
        const sel = this._immichSelected(photos);
        if (!sel.length) return 'All albums';
        const available = Array.isArray(photos.availableImmichAlbums) ? photos.availableImmichAlbums : [];
        if (sel.length === 1) {
            const hit = available.find(a => String(a.id) === sel[0]);
            return hit ? (hit.name || '1 album') : '1 album';
        }
        return `${sel.length} albums`;
    },

    _onImmichAlbumAll(checked) {
        // Checking "All albums" clears the selection (empty = all/random on device).
        // Unchecking it is a no-op — pick a specific album to narrow instead.
        if (!checked) { App.renderPage(); return; }
        DevicesPage._onSettingChange(this._photosDeviceId, 'photos', 'immichSelectedAlbums', []);
        App.renderPage();
    },

    _onImmichAlbumToggle(albumId, checked) {
        const device = DevicesPage._findDevice(this._photosDeviceId);
        let sel = this._immichSelected(device?.settings?.photos);
        sel = checked ? [...new Set([...sel, albumId])] : sel.filter(id => id !== albumId);
        DevicesPage._onSettingChange(this._photosDeviceId, 'photos', 'immichSelectedAlbums', sel);
        App.renderPage();
    },

    _onPhotoSourceChange(value) {
        this._photosSource = value;
        DevicesPage._onSettingChange(this._photosDeviceId, 'photos', 'sourceType', value);
        if (value === 'supabase') this._loadAlbums();
        App.renderPage();
    },

    _onPhotoAlbumChange(albumId) {
        const album = (this._photosAlbums || []).find(a => String(a.id) === String(albumId));
        const albumName = album ? (album.name || '') : '';
        // albumId + albumName are written together — the widget keys off albumId
        // but the card/summary shows albumName.
        DevicesPage._onSettingChange(this._photosDeviceId, 'photos', 'albumId', albumId || '');
        DevicesPage._onSettingChange(this._photosDeviceId, 'photos', 'albumName', albumName);
    },

    // ── PIN modal (set / change / clear) ──────────────────────

    _pinOpen: false,
    _pinDeviceId: null,
    _pinHadPin: false,
    _pinForm: { value: '', confirm: '', busy: false, error: null },

    openPinModal(deviceId, hadPin) {
        this._pinOpen = true;
        this._pinDeviceId = deviceId;
        this._pinHadPin = !!hadPin;
        this._pinForm = { value: '', confirm: '', busy: false, error: null };
        App.renderPage();
    },

    closePinModal() {
        this._pinOpen = false;
        this._pinDeviceId = null;
        this._pinForm = { value: '', confirm: '', busy: false, error: null };
        App.renderPage();
    },

    _setPinField(field, value) { this._pinForm[field] = value; },

    async submitPin() {
        const f = this._pinForm;
        if (f.busy) return;
        if (!/^\d{4,8}$/.test(f.value)) {
            f.error = 'PIN must be 4–8 digits.';
            App.renderPage();
            return;
        }
        if (f.value !== f.confirm) {
            f.error = 'PINs don\'t match.';
            App.renderPage();
            return;
        }
        f.busy = true; f.error = null;
        App.renderPage();
        try {
            // No dedicated PIN write path exists yet — route through the
            // same settings broadcast pipeline; the device-side consumer
            // can read security.pin from user_devices.settings the same
            // way it reads sleep/display settings.
            DevicesPage._onSettingChange(this._pinDeviceId, 'security', 'pin', f.value);
            DevicesPage._onSettingChange(this._pinDeviceId, 'security', 'pinSet', true);
            Toast.success('PIN updated');
            this.closePinModal();
        } catch (e) {
            f.error = e?.message || String(e);
            f.busy = false;
            App.renderPage();
        }
    },

    async clearPin() {
        if (this._pinForm.busy) return;
        this._pinForm.busy = true; this._pinForm.error = null;
        App.renderPage();
        try {
            DevicesPage._onSettingChange(this._pinDeviceId, 'security', 'pin', '');
            DevicesPage._onSettingChange(this._pinDeviceId, 'security', 'pinSet', false);
            Toast.success('PIN cleared');
            this.closePinModal();
        } catch (e) {
            this._pinForm.error = e?.message || String(e);
            this._pinForm.busy = false;
            App.renderPage();
        }
    },

    renderPinModal() {
        if (!this._pinOpen) return '';
        const f = this._pinForm;
        const body = `
            <div style="display: flex; flex-direction: column; gap: 12px;">
                <div class="form-group">
                    <label class="form-label">New PIN (4–8 digits)</label>
                    <input class="form-input" type="password" inputmode="numeric" maxlength="8" value="${this._escape(f.value)}"
                        oninput="DevicesDetailModals._setPinField('value', this.value)">
                </div>
                <div class="form-group">
                    <label class="form-label">Confirm PIN</label>
                    <input class="form-input" type="password" inputmode="numeric" maxlength="8" value="${this._escape(f.confirm)}"
                        oninput="DevicesDetailModals._setPinField('confirm', this.value)">
                </div>
                ${f.error ? `<div style="color: var(--status-error, #c00); font-size: var(--font-size-sm);">${this._escape(f.error)}</div>` : ''}
                <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px;">
                    ${this._pinHadPin ? `<button class="btn btn-secondary" onclick="DevicesDetailModals.clearPin()" ${f.busy ? 'disabled' : ''}>Clear PIN</button>` : ''}
                    <button class="btn btn-secondary" onclick="DevicesDetailModals.closePinModal()" ${f.busy ? 'disabled' : ''}>Cancel</button>
                    <button class="btn btn-primary" onclick="DevicesDetailModals.submitPin()" ${f.busy ? 'disabled' : ''}>${this._pinHadPin ? 'Update PIN' : 'Set PIN'}</button>
                </div>
            </div>
        `;
        return this._modal(this._pinHadPin ? 'Change PIN' : 'Set PIN', body, 'DevicesDetailModals.closePinModal()', null, DevicesPage._findDevice(this._pinDeviceId));
    },

    // ── Modal shell + helpers ─────────────────────────────────

    /**
     * The shared device-modal shell.
     *
     * 🔴 `device` is not decoration. EVERY modal here edits ONE device, and the
     * header used to name only the SETTING — so "Sleep / Wake" looked identical
     * whichever card you opened it from. With N cards on a page that is a modal
     * you can confidently save into the wrong device (John, 2026-09-21). The
     * name is rendered from the same row the body is reading, so it cannot
     * disagree with what the controls are about to write.
     *
     * ⚠️ Passing no `device` renders no subtitle rather than a placeholder — an
     * empty line is honest, "Unknown device" would be an invented claim.
     */
    _modal(title, bodyHtml, onClose, footerHtml, device) {
        const deviceName = device?.device_name
            ? `<span class="modal-subtitle">${this._escape(device.device_name)}</span>` : '';
        return `
            <div class="modal-backdrop" onclick="DevicesDetailModals._onBackdrop(event, '${onClose}')">
                <div class="modal" style="max-width: 480px; width: 92vw;">
                    <div class="modal-header">
                        <span class="modal-title-group">
                            <span class="modal-title">${this._escape(title)}</span>
                            ${deviceName}
                        </span>
                        <button class="modal-close" onclick="${onClose}">✕</button>
                    </div>
                    <div class="modal-body">${bodyHtml}</div>
                    ${footerHtml || ''}
                </div>
            </div>
        `;
    },

    /**
     * "Apply to all devices" checkbox, rendered as a modal footer. When checked,
     * DevicesPage._onSettingChange reads this at write time (by stable id) and
     * fans the same (category, key, value) out to every active device instead of
     * just the one being edited. Stateless — the checkbox IS the state, so there
     * is nothing to reset on close (only one settings modal is open at a time).
     * Superseded 2026-09-21 by "Also apply to" (_alsoFooter) — kept as the
     * record of why the fan-out reads MODULE state rather than a DOM checkbox.
     */
    // Module-state, NOT the DOM checkbox (2026-07-06 fix): a background
    // re-render (the device_settings realtime consumer) rebuilt the modal and
    // reset a checkbox-only flag, so the fan-out silently wrote to only the
    // open device. Render the box from this flag; read the flag at write
    // time (DevicesPage._onSettingChange). Reset to false whenever an
    // apply-to-all modal opens so it never leaks across devices/dialogs.

    /**
     * "Also apply to" — the mock's multi-select, replacing the old
     * "Apply to all devices" checkbox (John, 2026-09-21: "we didn't want apply
     * to all - we wanted a multi select / apply to selected version").
     *
     * 🔴 "All" is not a separate mode, it is Select all. The old design had two
     * states (armed / not) and no way to express "these three"; this has one
     * state — a target set — of which all-devices and no-devices are just the
     * extremes. That is why _onSettingChange now reads the SET rather than a
     * boolean: one concept, not two that can disagree.
     *
     * Each row shows what that device is on RIGHT NOW, resolved (inherit vs
     * own), because the question a mixed fleet owner is actually asking before
     * ticking a box is "what am I about to overwrite?".
     */
    _alsoOpen: false,
    _alsoTargets: new Set(),

    /** Called by every modal opener. One place, so a new modal cannot forget. */
    _resetAlso() { this._alsoOpen = false; this._alsoTargets = new Set(); },

    /**
     * Is ANY settings dialog open right now?
     *
     * Used by the Devices page's background refreshes. App.renderPage() replaces
     * #content wholesale, which destroys and rebuilds an open dialog — the user
     * sees it FLASH, loses focus, and a half-typed value can be thrown away
     * (John, 2026-09-21: "The modals keep flashing when i have them open").
     * Only the camera modal was guarded, so every other dialog flashed on the
     * 30-second poll and again on the screenshot poll.
     *
     * 🔴 DERIVED FROM THE OBJECT, not from a list kept by hand. Thirteen `*Open`
     * flags exist and more will be added; a hand-written list is exactly the
     * shape that has silently omitted an entry three times in this file's
     * neighbourhood in one evening (the card's dead tiles, the fan-out RENDERERS
     * map, the fan-out spec table). A new dialog is covered the moment it
     * declares its flag, with nobody needing to remember this function.
     *
     * `_alsoOpen` is excluded deliberately: it is the "Also apply to" footer's
     * expansion state, not a dialog. It can only be true while some dialog is
     * open, so it never needs to block on its own.
     */
    anyOpen() {
        for (const k of Object.keys(this)) {
            if (k === '_alsoOpen') continue;
            if (k.endsWith('Open') && this[k] === true) return true;
        }
        return false;
    },

    /** The devices this dialog could also write to — everything active but the open one. */
    _alsoCandidates() {
        const spec = this._openApplyAllSpec();
        if (!spec) return [];
        const srcId = this[spec.idKey];
        return (DevicesPage._devices || []).filter(d => d.is_active !== false && d.device_id !== srcId);
    },

    _alsoFooter() {
        const spec = this._openApplyAllSpec();
        if (!spec) return '';
        const others = this._alsoCandidates();
        if (others.length === 0) return '';
        const n = this._alsoTargets.size;
        const rows = !this._alsoOpen ? '' : `
            <div class="also-actions">
                <button type="button" class="also-link" onclick="DevicesDetailModals._alsoAll(true)">Select all</button>
                <button type="button" class="also-link" onclick="DevicesDetailModals._alsoAll(false)">Clear all</button>
            </div>
            <div class="also-list">
                ${others.map((d) => {
                    const on = this._alsoTargets.has(d.device_id);
                    let now = '';
                    try { now = spec.now ? spec.now(d) : ''; } catch { now = ''; }
                    return `
                    <button type="button" class="also-row" role="checkbox" aria-checked="${on}"
                            onclick="DevicesDetailModals._alsoToggle('${DevicesPage._escape(d.device_id)}')">
                        <span class="also-box${on ? ' is-on' : ''}" aria-hidden="true">${on ? '✓' : ''}</span>
                        <span class="also-name">${DevicesPage._escape(d.device_name || 'Unnamed Device')}</span>
                        ${now ? `<span class="also-now">now: ${DevicesPage._escape(now)}</span>` : ''}
                    </button>`;
                }).join('')}
            </div>`;
        return `
            <div class="modal-footer also-foot">
                <button type="button" class="also-head" onclick="DevicesDetailModals._alsoToggleOpen()"
                        aria-expanded="${this._alsoOpen}">
                    <span class="also-caret">${this._alsoOpen ? '▾' : '▸'}</span> Also apply to
                    <span class="also-count">${n ? `${n} selected` : `${others.length} available`}</span>
                </button>
                ${rows}
                ${n ? `<div class="also-save">
                    <button type="button" class="btn btn-primary btn-sm" ${this._alsoBusy ? 'disabled' : ''}
                            onclick="DevicesDetailModals._alsoApply()">
                        ${this._alsoBusy ? 'Applying…' : `Apply ${DevicesPage._escape(spec.label)} to ${n} device${n === 1 ? '' : 's'}`}
                    </button>
                </div>` : ''}
            </div>`;
    },

    _alsoToggleOpen() { this._alsoOpen = !this._alsoOpen; App.renderPage(); },
    _alsoToggle(id) {
        if (this._alsoTargets.has(id)) this._alsoTargets.delete(id);
        else this._alsoTargets.add(id);
        App.renderPage();
    },
    _alsoAll(on) {
        this._alsoTargets = on ? new Set(this._alsoCandidates().map(d => d.device_id)) : new Set();
        App.renderPage();
    },

    _alsoBusy: false,
    /** Copy the open device's CURRENT values for this dialog to the selected devices. */
    async _alsoApply() {
        if (this._alsoBusy || this._alsoTargets.size === 0) return;
        this._alsoBusy = true; App.renderPage();
        const spec = this._openApplyAllSpec();
        const n = this._alsoTargets.size;
        try {
            await this._fanOutTo([...this._alsoTargets]);
            Toast?.success?.(`Applied ${spec?.label || 'settings'} to ${n} device${n === 1 ? '' : 's'}`);
            this._alsoTargets = new Set();
        } finally {
            this._alsoBusy = false; App.renderPage();
        }
    },

    // The keys each dialog manages — used both to retro-apply the open device's
    // CURRENT values to the devices you tick, and to say what each of those is
    // on right now so you can see what you are about to overwrite.
    _APPLY_ALL_KEYS: {
        theme:       { idKey: '_themeDeviceId',       label: 'theme',
                       keys: [['display', 'themeFamily'], ['display', 'darkMode']],
                       now: (d) => DevicesDetailModals.buildThemeSummary(d?.settings?.display || {}) },
        sleep:       { idKey: '_sleepDeviceId',       label: 'sleep schedule',
                       keys: [['sleep', 'enabled'], ['sleep', 'sleepMethod'], ['sleep', 'sleepTime'], ['sleep', 'wakeTime'],
                              ['sleep', 'resleepTimeout'], ['sleep', 'inactivityTimeout'],
                              ['sleep', 'sleepShowClock'], ['sleep', 'reduceBrightnessOnSleep'], ['sleep', 'motionWakeForSleep'],
                              ['display', 'screenOffBehavior']],
                       now: (d) => DevicesDetailModals._sleepNow(d) },
        personality: { idKey: '_personalityDeviceId', label: 'personality',
                       keys: [['aiVoice', 'personalityId'], ['aiVoice', 'voiceKey']],
                       now: (d) => DevicesDetailModals._inheritNow(d?.settings?.aiVoice?.personalityId,
                                       (v) => DevicesDetailModals.personalityName(v, d),
                                       DevicesDetailModals._inherited('aiVoice', 'personalityId', DevicesDetailModals._accountSettings?.ai?.defaultPersonalityId, d)) },
        voice:       { idKey: '_voiceDeviceId',       label: 'voice',
                       keys: [['aiVoice', 'voiceKey']],
                       now: (d) => { const v = DevicesDetailModals.voiceSetupSummary(d);
                                     return v.custom ? 'Custom (own)' : `Household (${v.label})`; } },
        // The per-device voice PIPELINE. The five leaves John can set per device --
        // the thing the whole mixed-fleet ruling exists for -- and until now the one
        // dialog with no way to apply itself to a second device.
        voiceSetup:  { idKey: '_voiceSetupDeviceId',  label: 'voice setup',
                       keys: [['voice', 'sttProvider'], ['voice', 'ttsProvider'],
                              ['voice', 'haSttEngineId'], ['voice', 'haTtsEngineId'],
                              ['voice', 'haTtsVoiceId']],
                       now: (d) => DevicesDetailModals.voiceSetupSummary(d).label },
        // The pointer alone (PROFILE_FANOUT_KEYS). Fanning this out is how a fleet gets
        // put on one profile in a single action -- the point of profiles for a household
        // with more than one screen.
        profile:     { idKey: '_profileDeviceId',     label: 'voice profile',
                       keys: [['voice', 'profileId']],
                       now: (d) => DevicesDetailModals._profileNow(d) },
        photos:      { idKey: '_photosDeviceId',      label: 'photo album',
                       keys: [['photos', 'sourceType'], ['photos', 'albumId'], ['photos', 'albumName'], ['photos', 'slideshowInterval']],
                       now: (d) => DevicesDetailModals._photosNow(d) },
    },

    /** "10pm–6am" / "No sleep" — the same resolver the card and the modal use. */
    _sleepNow(device) {
        const eff = this.sleepEffective(device?.settings?.sleep);
        if (!eff.enabled) return 'No sleep';
        if (eff.sleepMethod === 'inactivity') return `${this._formatTimeout(Number(eff.inactivityTimeout))} idle`;
        const t = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number);
            return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${h >= 12 ? 'pm' : 'am'}`; };
        return `${t(eff.sleepTime)}–${t(eff.wakeTime)}`;
    },

    _photosNow(device) {
        const ph = device?.settings?.photos || {};
        if (ph.sourceType === 'immich') return this.immichAlbumSummary(ph);
        return ph.albumName || ph.sourceType || 'Default';
    },

    /**
     * "Okay Nabu (own)" vs "Household (Hey Dashie)" — for a leaf a device may
     * OVERRIDE. `''` is the inherit sentinel, not a value, so it reads as
     * following the household exactly like an absent key.
     */
    _inheritNow(deviceValue, label, householdValue) {
        if (deviceValue) return `${label(deviceValue)} (own)`;
        return householdValue ? `Household (${label(householdValue)})` : 'Household';
    },

    /** Which apply-to-all modal is currently open → its key spec. */
    _openApplyAllSpec() {
        if (this._themeOpen)       return this._APPLY_ALL_KEYS.theme;
        if (this._sleepOpen)       return this._APPLY_ALL_KEYS.sleep;
        if (this._personalityOpen) return this._APPLY_ALL_KEYS.personality;
        if (this._voiceOpen)       return this._APPLY_ALL_KEYS.voice;
        if (this._photosOpen)      return this._APPLY_ALL_KEYS.photos;
        if (this._voiceSetupOpen)  return this._APPLY_ALL_KEYS.voiceSetup;
        if (this._profileOpen)     return this._APPLY_ALL_KEYS.profile;
        return null;
    },

    /** Fan the open device's CURRENT values for the modal's managed keys out
     *  to every other active device. Called on arm so the setting the user
     *  already picked propagates immediately, not only on the next change. */
    async _fanOutTo(targetIds) {
        const spec = this._openApplyAllSpec();
        if (!spec) return;
        const src = DevicesPage._findDevice(this[spec.idKey]);
        if (!src) return;
        const wanted = new Set(targetIds || []);
        const others = (DevicesPage._devices || [])
            .filter(d => d.is_active !== false && d.device_id !== src.device_id && wanted.has(d.device_id));
        // Group by category so we write each category once per device.
        // 🔴 Resolve the SHOWN values, not the stored ones. A sparse blob (a
        // device never configured for sleep) used to skip every key and fan out
        // an empty payload — the user checked the box and nothing happened,
        // with no error. See sleepEffective().
        const resolved = {
            sleep: this.sleepEffective(src.settings?.sleep),
            display: { screenOffBehavior: this.screenOffEffective(src.settings?.display) },
            // voiceEffective resolves VOICE_LEAF_KEYS and deliberately does NOT carry
            // profileId (that list is pinned to the voiceSetup spec). Resolved here so a
            // source device that has never chosen a profile fans out '' = Default rather
            // than `undefined`, which the loop below skips -- leaving byCat empty and the
            // whole action a no-op with a "nothing to apply" toast.
            voice: {
                ...this.voiceEffective(src.settings?.voice),
                profileId: typeof src.settings?.voice?.profileId === 'string'
                    ? src.settings.voice.profileId : '',
            },
        };
        const byCat = {};
        for (const [cat, key] of spec.keys) {
            // Prefer the RESOLVED value, but only where the resolver actually has
            // one — `display` is resolved for screenOffBehavior alone, and the
            // Theme dialog writes display.themeFamily through the same category.
            const r = resolved[cat];
            const val = (r && Object.prototype.hasOwnProperty.call(r, key))
                ? r[key] : src.settings?.[cat]?.[key];
            if (val === undefined) continue;
            (byCat[cat] = byCat[cat] || {})[key] = val;
        }
        // A fan-out that writes nothing is a silent no-op; say so rather than
        // returning quietly (CLAUDE.md: no silent drops).
        if (Object.keys(byCat).length === 0) {
            console.warn(`DROP: apply-to-all found no values to copy for ${JSON.stringify(spec.keys)} on ${src.device_id}`);
            Toast?.error?.('Nothing to apply — this device has no values set for that dialog.');
            return;
        }
        for (const device of others) {
            for (const [cat, vals] of Object.entries(byCat)) {
                try {
                    await DashieAuth.dbRequest('update_device_settings', {
                        device_id: device.device_id, settings_path: cat, settings_value: vals,
                    });
                    device.settings = device.settings || {};
                    device.settings[cat] = { ...(device.settings[cat] || {}), ...vals };
                    DashieAuth._broadcastDeviceSettingsChanged(
                        device.device_id, cat, device.settings[cat]).catch((err) => {
                        // Loud, for the same reason as the edit path in devices.js: the DB
                        // write above succeeded, so this is a DELAY not a lost setting — but
                        // a swallowed push is why "I applied it to four devices and one did
                        // not change" had nothing to look at.
                        console.warn(`DROP: live settings push failed for ${device.device_id} `
                            + `(${cat}) during fan-out; the value IS saved and will apply on `
                            + `that device's next sync.`, err?.message || err);
                    });
                } catch (e) {
                    console.warn('[DevicesDetailModals] apply-to-all arm fan-out failed:', e.message);
                }
            }
        }
    },

    /** Guard on the "apply to all" toggle: while armed, every change in this
     *  dialog fans out to all active devices. Confirm intent before arming;
     *  on confirm we ALSO retro-apply the current values (so the change the
     *  user just made propagates). Unchecking never needs confirmation. */

    _onBackdrop(event, onClose) {
        if (event.target.classList.contains('modal-backdrop')) {
            // eslint-disable-next-line no-new-func
            new Function(onClose)();
        }
    },

    _divider(label) {
        return `<div style="margin: 4px 0 -4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted);">${this._escape(label)}</div>`;
    },

    _labelFor(options, value) {
        const v = String(value);
        const found = options.find(([val]) => String(val) === v);
        return found ? found[1] : v;
    },

    _formatTimeout(seconds) {
        if (!isFinite(seconds) || seconds <= 0) return '0 sec';
        if (seconds < 60) return `${seconds} sec`;
        if (seconds < 3600) {
            const m = Math.round(seconds / 60);
            return m === 1 ? '1 min' : `${m} min`;
        }
        const h = Math.round(seconds / 3600 * 10) / 10;
        return h === 1 ? '1 hour' : `${h} hours`;
    },

    /** "22:00" → "10:00pm" (lowercased am/pm to match Kotlin look). */
    _formatTime(hhmm) {
        if (!hhmm || typeof hhmm !== 'string') return hhmm || '—';
        const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
        if (!m) return hhmm;
        let h = parseInt(m[1], 10);
        const mm = m[2];
        const period = h < 12 ? 'am' : 'pm';
        if (h === 0) h = 12;
        else if (h > 12) h -= 12;
        return `${h}:${mm}${period}`;
    },

    _escape(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
};

window.DevicesDetailModals = DevicesDetailModals;
