// js/lib/voice-samples.js
//
// Pre-recorded voice samples: the manifest, and the one function that decides HOW a
// given voice gets previewed.
//
// 🔴 WHY THIS EXISTS (John, 2026-10-15): *"we pre-record a TTS statement relevant to
// the personality in question so people can hear it … we probably should do that for
// our stock voices too that require tokens so users aren't paying to generate them
// everytime."* Previewing is browsing — a household auditions a dozen voices to pick
// one — and a browse that bills per press is a browse people stop doing.
//
// ⚠️ THIS SUPERSEDES A LIVE-SYNTH PATH ALREADY SHIPPED. The Gemini audition button in
// add-on 0.9.59 (`VoiceAiPage.previewGeminiVoice`) POSTs /api/voice/preview on EVERY
// press, so each click spends the household's Gemini key. That was built before the
// rule existed; it is not exempt from it. `playbackPlan()` is the seam that moves it
// onto recordings, with live synth kept only where no recording can exist.
//
// WHAT A RECORDING CAN AND CANNOT COVER — the distinction the plan function turns on:
//
//   Dashie's OWN voices (the built-in personalities, and the stock voice catalog) are
//   a FIXED, KNOWN set. We can render them once, ship the audio, and never bill
//   anyone again. These SHOULD have a sample, and a missing one is a gate failure,
//   not a runtime fallback.
//
//   A household's OWN pick — a custom personality on their own ElevenLabs voice id, a
//   Kokoro voice on their own box — cannot be pre-recorded by us. We have never heard
//   it and could not have. Live synth is the only possible answer there, and it is
//   also the honest one: it is their voice, their key, their box.
//
// So "no sample" is not one state. It is either a BUG (a Dashie voice we failed to
// record) or the EXPECTED state (a voice only the household can produce), and the
// caller says which by passing `allowLive`.
//
// Fails soft in every direction: no manifest, an unparseable manifest, or a missing
// entry all resolve to a plan the caller can render. Nothing here throws, because the
// only thing downstream of it is a ▶ button, and a page that will not paint because a
// sound file is missing is a worse failure than a button that says so.

const VoiceSamples = {

    /** Where the generator writes, and where express.static serves from
     *  (`server/index.js:256` mounts FRONTEND_DIR at '/'). Shipped IN the add-on, not
     *  fetched from a CDN: John 2026-10-15 ("ship with the add-on"). An HA box can be
     *  offline, and a preview that needs the internet is a preview that fails on the
     *  boxes most likely to be auditioning local engines. */
    DIR: 'assets/voices',

    _manifest: undefined,   // undefined = not loaded; null = load failed; object = loaded
    _loading: null,

    /** Providers whose synth costs the household money per press. A preview of one of
     *  these without a recording is refused rather than billed.
     *  🔴 `gemini` IS on this list. Its key is usually the household's own, which makes
     *  the charge small — not absent. "Small" is the argument that got the live button
     *  shipped in the first place, and it is the wrong unit: the cost of browsing is
     *  per press times the number of voices someone listens through. */
    METERED: ['elevenlabs', 'inworld', 'gemini', 'dashie_cloud'],

    /** Providers that run on the household's own hardware — free per press, forever. */
    LOCAL: ['kokoro', 'piper', 'android', 'local_url', 'va_default'],

    /** Load the manifest once. Safe to call repeatedly and concurrently. */
    async load() {
        if (this._manifest !== undefined) return this._manifest;
        if (this._loading) return this._loading;
        this._loading = (async () => {
            try {
                const r = await fetch(`${this.DIR}/manifest.json`, { cache: 'no-store' });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const j = await r.json();
                this._manifest = (j && typeof j.samples === 'object') ? j : null;
                if (!this._manifest) console.warn('DROP: voice-samples manifest has no samples map');
            } catch (e) {
                // Expected on any add-on built before the samples shipped. Loud, because
                // silently falling back to live synth is exactly the billing we are here
                // to stop, and nothing else would say it happened.
                console.warn(`DROP: voice-samples manifest unreadable — ${e?.message || e}`);
                this._manifest = null;
            }
            return this._manifest;
        })();
        return this._loading;
    },

    /** Lower-cased, whitespace-free key. Voice refs are `provider:voiceId` and arrive
     *  from three authorities (this repo's templates, the account, a user's typing), so
     *  they are normalised at the one place that looks them up. */
    _key(s) { return String(s || '').trim().toLowerCase(); },

    /** The sample recorded for a built-in personality, by template key (`butler`). */
    forPersonality(key) {
        const m = this._manifest;
        if (!m) return null;
        return m.samples[`personality:${this._key(key)}`] || null;
    },

    /** The sample recorded for a stock voice, by ref (`elevenlabs:butler`, `gemini:Charon`). */
    forVoice(ref) {
        const m = this._manifest;
        if (!m) return null;
        return m.samples[`voice:${this._key(ref)}`] || null;
    },

    /** Absolute-within-the-console URL for a manifest entry. */
    urlFor(entry) {
        if (!entry || !entry.file) return null;
        return `${this.DIR}/${entry.file}`;
    },

    /** The provider half of a `provider:voiceId` ref. */
    providerOf(ref) { return this._key(ref).split(':')[0] || ''; },

    /** Does pressing play on this ref spend the household's money? */
    isMetered(ref) { return this.METERED.includes(this.providerOf(ref)); },

    /**
     * 🔴 THE ONE DECIDER. Everything that offers a ▶ asks this; nothing decides for
     * itself. Modelled on `byok-tts.resolveProvider()` and `choosePictureSource()` —
     * one function holds the policy so the answer cannot differ between two buttons.
     *
     * @param {object}  opts
     * @param {string}  opts.personality  built-in template key, if previewing a personality
     * @param {string}  opts.ref          voice ref, if previewing a voice
     * @param {boolean} opts.allowLive    true when no recording COULD exist — a
     *                                    household's own voice pick. Never pass true to
     *                                    dodge a missing Dashie recording: that is the
     *                                    billing this module exists to prevent, and
     *                                    check-voice-samples fails on the missing file.
     * @returns {{mode:'sample',url,entry}|{mode:'live',ref}|{mode:'none',why}}
     */
    playbackPlan({ personality, ref, allowLive = false } = {}) {
        const entry = personality ? this.forPersonality(personality) : this.forVoice(ref);
        if (entry) {
            const url = this.urlFor(entry);
            if (url) return { mode: 'sample', url, entry };
        }
        if (allowLive) return { mode: 'live', ref: ref || null };
        if (this._manifest === null) {
            // Told apart from a missing entry on purpose: one is an old add-on, the
            // other is a voice we forgot to record, and they have different fixes.
            return { mode: 'none', why: 'Voice samples are not in this add-on version — update it to listen.' };
        }
        if (ref && !this.isMetered(ref)) {
            // A free local engine with no recording: playing it live costs nothing, so
            // refusing would be pure loss. (It still should not normally happen — the
            // generator records the stock set — so it is worth a marker.)
            console.warn(`DROP: voice-samples no recording for free ref '${ref}' — synthesising live`);
            return { mode: 'live', ref };
        }
        return { mode: 'none', why: 'No recorded sample for this voice yet.' };
    },
};

window.VoiceSamples = VoiceSamples;
