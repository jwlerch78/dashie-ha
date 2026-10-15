/* ============================================================
   Voice sample player
   ------------------------------------------------------------
   The single ▶/■ control for hearing a voice, anywhere in the
   console: a personality row, a voice picker option, the Gemini
   audition control.

   🔴 ONE PLAYER, NOT ONE PER SURFACE. The Gemini audition button
   (add-on 0.9.59) carried its own <audio> element and its own
   play/stop state. A second surface with a second element gives
   two clips playing over each other and two buttons each certain
   it is the one that is stopped. This holds ONE element and one
   "what is playing" fact, so starting anything stops everything
   else by construction rather than by remembering to.

   WHAT IT DOES NOT DECIDE: whether a press costs money. That is
   `VoiceSamples.playbackPlan()`, and this renders whatever the
   plan says. Splitting it the other way — a player that works
   out for itself whether to synth — would put the billing policy
   in a UI component and give every caller its own copy of it.
   ============================================================ */

const VoiceSamplePlayer = {

    _audio: null,       // the one element
    _playingKey: null,  // which button owns it, or null

    /** Lazily made so a page that never previews never creates one. */
    _el() {
        if (!this._audio) {
            this._audio = new Audio();
            this._audio.addEventListener('ended', () => this._clear());
            this._audio.addEventListener('error', () => this._clear());
        }
        return this._audio;
    },

    /**
     * Markup for one control. `key` identifies this button to the player so a
     * re-render can restore the playing state instead of orphaning it.
     *
     * `onclick` is supplied by the caller and follows the page's existing inline
     * idiom (see `VoiceAiCards`), so the button works inside a re-rendered
     * innerHTML string with no re-binding step.
     */
    button({ key, onclick, title = 'Hear this voice', disabled = false, why = '' }) {
        const playing = this._playingKey === key;
        const label = playing ? '■' : '▶';
        const t = disabled ? (why || 'No sample available') : title;
        return `<button class="voice-sample-btn${playing ? ' is-playing' : ''}"
                        data-sample-key="${this._esc(key)}"
                        title="${this._esc(t)}"
                        aria-label="${this._esc(t)}"
                        ${disabled ? 'disabled' : ''}
                        onclick="${this._esc(onclick)}">${label}</button>`;
    },

    _esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    /** Stop whatever is playing and repaint every button to ▶. */
    stop() {
        if (this._audio) { try { this._audio.pause(); } catch (_) {} this._audio.currentTime = 0; }
        this._clear();
    },

    _clear() {
        this._playingKey = null;
        document.querySelectorAll('.voice-sample-btn.is-playing').forEach(b => {
            b.classList.remove('is-playing');
            b.textContent = '▶';
        });
    },

    _mark(key, btn) {
        this._playingKey = key;
        if (btn) { btn.classList.add('is-playing'); btn.textContent = '■'; }
    },

    /**
     * Play, or stop if this same button is already playing.
     *
     * @param {HTMLElement} btn       the clicked button
     * @param {object}      plan      from `VoiceSamples.playbackPlan()`
     * @param {function}    liveSynth async (ref) => Blob|ArrayBuffer|url, required only
     *                                when the plan says `live`. Injected rather than
     *                                called directly so this component knows nothing
     *                                about the add-on's preview endpoint.
     */
    async toggle(btn, plan, { liveSynth } = {}) {
        const key = btn?.dataset?.sampleKey || '';
        if (this._playingKey === key) { this.stop(); return; }
        this.stop();

        if (!plan || plan.mode === 'none') {
            this._say(btn, plan?.why || 'No sample available');
            return;
        }

        if (plan.mode === 'sample') {
            await this._play(btn, key, plan.url, 'This add-on is missing its voice samples — update it.');
            return;
        }

        if (plan.mode === 'live') {
            if (typeof liveSynth !== 'function') { this._say(btn, 'Live preview unavailable here'); return; }
            btn.textContent = '…';
            let url = null, revoke = false;
            try {
                const out = await liveSynth(plan.ref);
                if (typeof out === 'string') url = out;
                else if (out) { url = URL.createObjectURL(out instanceof Blob ? out : new Blob([out], { type: 'audio/mpeg' })); revoke = true; }
            } catch (e) {
                console.warn(`DROP: voice-sample live synth failed — ${e?.message || e}`);
                this._say(btn, 'Could not play that voice');
                return;
            }
            if (!url) { this._say(btn, 'Could not play that voice'); return; }
            await this._play(btn, key, url, 'Could not play that voice');
            if (revoke) this._el().addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
        }
    },

    async _play(btn, key, url, failMsg) {
        const a = this._el();
        a.src = url;
        try {
            await a.play();
            this._mark(key, btn);
        } catch (e) {
            console.warn(`DROP: voice-sample playback failed (${url}) — ${e?.message || e}`);
            this._say(btn, failMsg);
        }
    },

    /** Say why nothing happened, on the button itself and briefly — a press that
     *  silently does nothing reads as a broken page. */
    _say(btn, msg) {
        if (!btn) return;
        btn.textContent = '!';
        btn.title = msg;
        setTimeout(() => { btn.textContent = '▶'; }, 1600);
    },
};

window.VoiceSamplePlayer = VoiceSamplePlayer;
