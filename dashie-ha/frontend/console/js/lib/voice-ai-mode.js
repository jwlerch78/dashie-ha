/**
 * VoiceAiMode — Simple / Advanced on the Voice & AI Settings tab (D8).
 *
 * ── WHY, AND WHY THE SECTIONS WERE NOT ENOUGH ────────────────────────────────
 *
 * John, 2026-10-08, opening the HA release scope: the Voice & AI section is
 * overwhelming, and he asked for *"show/hide advanced"* with *"the simple setup
 * for self-hosted and for BYOK"*.
 *
 * VoiceAiSections already collapses the page to two summary lines, and that is a
 * real improvement — but collapsing is not reducing. Open either section and all
 * fifteen elements are still there, eleven of them conditional on preset ×
 * agent mode × whether HA is reachable. A household that just wants Dashie to
 * talk has to walk past Engine detection and a Live STT footnote to find the
 * personality. Simple mode WITHHOLDS controls; the sections only fold them.
 *
 * ── THE PARTITION, AND THE ONE RULE IT MUST OBEY ─────────────────────────────
 *
 * Simple shows three things: the PRESET (which decides everything downstream),
 * the AI MODEL (the one thing a BYOK household must point at its own key) and
 * the PERSONALITY (what they came for). Speech-to-text and text-to-speech are
 * DERIVED from the preset — Hybrid and Local each imply their own voice engine —
 * so asking again makes the user re-answer a question the preset just answered.
 *
 * 🔴 SIMPLE MAY HIDE A CONTROL. IT MUST NEVER HIDE A VALUE.
 *
 * That is the whole safety property, and it is not automatic. If a household has
 * pointed speech-to-text at their own Whisper box and Simple neither shows the
 * card nor mentions the choice, the page is no longer describing their system —
 * it is describing a default they are not running, which is worse than a busy
 * page. The section SUMMARY line is what keeps this honest: it names the live
 * STT and TTS labels in both modes, read from the same ids the cards render
 * from, so a withheld control still has its value on screen.
 *
 * check-voice-simple-mode asserts exactly that, and asserts it against a
 * NON-DEFAULT world — a leg that only ever sees preset-implied values would pass
 * on a Simple mode that hid everything and said nothing.
 *
 * ── WHY localStorage, DEPARTING FROM VoiceAiSections ─────────────────────────
 *
 * The open/closed state next door is deliberately sessionStorage, because *"a
 * persisted 'I collapsed this once' silently becomes the permanent shape of the
 * page, and the next person cannot tell a collapsed section from a missing
 * one."* That reasoning applies with MORE force here — Simple removes controls
 * outright — and the answer is to remove the premise rather than the
 * persistence: the Simple body always NAMES what Advanced holds and links to it,
 * so there is no state in which a control reads as missing rather than withheld.
 *
 * Given that, per-session is the wrong trade: it taxes the self-hosting user who
 * lives in Advanced, charging them a mode switch on every single page load, to
 * protect a confusion the copy already prevents.
 *
 * Per-VIEWER, not per-household: this is a view preference, so it is the one
 * thing on this page that must NOT sync. Two people administering one household
 * can want different amounts of detail, and an account-level key would make the
 * quieter one's choice reach the other's screen.
 */
const VoiceAiMode = {

    _KEY: 'dashie-console-voiceai-mode',

    /** 🔴 Simple is the DEFAULT (John's D8). A household that never touches this
     *  control gets the three-control page, which is the point of the decision. */
    DEFAULT: 'simple',
    MODES: ['simple', 'advanced'],

    /**
     * The component cards Simple shows, by the stageKey the page renders them
     * under. ⚠️ `personality` and `wakeword` are NOT stage keys in
     * `_expandedCards` (VoiceAiDefaultsCards owns those two and takes no
     * stageKey) — they are named here because this map is the declaration of the
     * PARTITION, not of the page's expand/collapse bookkeeping.
     */
    SIMPLE_CARDS: ['model', 'personality'],

    /**
     * What Simple withholds. This is not documentation — the gate reads it to
     * prove the partition is a partition (nothing in both lists, nothing
     * rendered in Simple that is named here), and the Simple body reads its
     * length to say how much is behind Advanced without hand-counting.
     *
     * Named by the page element, not by the setting key: several of these are
     * one control over two keys (Voice; the local-engine URL rows).
     */
    ADVANCED_ONLY: [
        'wakeword', 'stt', 'tts', 'voice', 'engine-detection', 'live-voice',
        'live-stt-note', 'prompt-mode', 'house-rules', 'tools-enabled',
        'search', 'entities', 'conversation-mode', 'household-sharing',
        'profile-switcher',
    ],

    _mode: null,

    get() {
        if (this._mode) return this._mode;
        this._mode = this.DEFAULT;
        try {
            const raw = localStorage.getItem(this._KEY);
            // Only adopt a declared mode. A stale or hand-edited entry naming a
            // mode that no longer exists must not render a page with no partition.
            if (this.MODES.includes(raw)) this._mode = raw;
        } catch { /* private window, blocked storage — the default stands */ }
        return this._mode;
    },

    isSimple() { return this.get() === 'simple'; },

    /** Does Simple show this card? Advanced shows everything, so the answer is
     *  only ever interesting in Simple. */
    showsCard(key) {
        return !this.isSimple() || this.SIMPLE_CARDS.includes(String(key));
    },

    set(mode) {
        if (!this.MODES.includes(mode)) {
            // A mode the partition does not declare would render a page with no
            // rule about what it shows. Loud, not silent — the DROP convention.
            console.warn(`DROP: VoiceAiMode.set('${mode}') — not a declared mode `
                + `(${this.MODES.join(', ')}).`);
            return;
        }
        this._mode = mode;
        try { localStorage.setItem(this._KEY, mode); } catch { /* fine */ }
        App.renderPage();
    },

    /** The segmented Simple|Advanced control. Right-aligned on its own row, beside
     *  the locality legend — it governs the whole tab, so it sits above the
     *  sections rather than inside either one. */
    render() {
        const simple = this.isSimple();
        const btn = (mode, label, on) => `
            <button type="button" onclick="VoiceAiMode.set('${mode}')"
                aria-pressed="${on ? 'true' : 'false'}"
                style="font-family: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer;
                       padding: 4px 11px; border: 0; background: ${on ? 'var(--accent)' : 'transparent'};
                       color: ${on ? '#fff' : 'var(--text-muted)'};">${label}</button>`;
        return `
            <span style="display: inline-flex; border: 1px solid var(--border, #e5e7eb);
                         border-radius: 6px; overflow: hidden;">
                ${btn('simple', 'Simple', simple)}${btn('advanced', 'Advanced', !simple)}
            </span>`;
    },

    /**
     * The line that keeps Simple honest about being a view and not a feature set.
     * Says what the preset decides, and offers the way through — so a withheld
     * control never reads as a missing one.
     */
    renderFooter() {
        if (!this.isSimple()) return '';
        return `<div style="font-size: 11.5px; color: var(--text-muted); margin-top: 11px; line-height: 1.45;">
            Speech-to-text and text-to-speech follow the preset.
            <a href="#" onclick="event.preventDefault(); VoiceAiMode.set('advanced')"
               style="color: var(--accent); font-weight: 600; text-decoration: none;">Advanced…</a>
        </div>`;
    },
};

window.VoiceAiMode = VoiceAiMode;
