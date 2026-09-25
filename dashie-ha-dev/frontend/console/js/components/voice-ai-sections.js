/**
 * VoiceAiSections — the two collapsible groups on the Voice & AI Settings tab.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 *
 * That tab renders FIFTEEN elements in one 760px column, eleven of them
 * conditional on preset / Customize / agent mode / whether HA is reachable. John,
 * 2026-09-22: *"I think it's probably too busy as is."* He is right, and the
 * profile switcher that is coming would have added a sixteenth.
 *
 * So the page groups into two sections that collapse to one summary line each —
 * two lines at rest instead of fifteen cards. John approved this shape on
 * 2026-09-23 against the D1/D2 mockups:
 *
 *   • **Voice & LLM** — Mode, then AI Model / Wake Word / Personality /
 *     Speech-to-text / Text-to-speech, two across
 *   • **AI Tools & Settings** — Web search source + HA entities two across, then
 *     the behaviour toggles
 *
 * Household sharing deliberately sits OUTSIDE both: it is account-wide and must
 * not read as part of a per-profile set.
 *
 * ── WHY THE SUMMARY LINE IS A HOLDER AND NOT A STRING BUILT INLINE ───────────
 *
 * The same sentence is needed in three places — collapsed here, in the profile
 * list, and on a device page saying what that device follows. Three copies of
 * "Hybrid · Deepgram → Inworld · Gemini 2.5 Flash" drift, and the visible symptom
 * is two screens disagreeing about one profile, which is the exact failure the
 * profile work exists to remove. One holder, asked three times.
 *
 * ── OPEN STATE IS PER-SESSION, NOT PERSISTED ─────────────────────────────────
 *
 * Deliberately sessionStorage, for the same reason the Devices tech-view toggle
 * moved there (console 0.9.36): a persisted "I collapsed this once" silently
 * becomes the permanent shape of the page, and the next person to open it cannot
 * tell a collapsed section from a missing one. Within a session it sticks; a
 * fresh load starts from the declared default.
 */
const VoiceAiSections = {

    _KEY: 'dashie-console-voiceai-sections',

    /** Which sections start open on a fresh load. Voice & LLM is the one people
     *  come here to change; Tools is the one they set once. */
    _DEFAULT_OPEN: { voice: true, tools: false },

    _state: null,

    _load() {
        if (this._state) return this._state;
        this._state = { ...this._DEFAULT_OPEN };
        try {
            const raw = sessionStorage.getItem(this._KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                // Only adopt keys we declare. A stale or hand-edited entry naming a
                // section that no longer exists must not resurrect it.
                for (const k of Object.keys(this._DEFAULT_OPEN)) {
                    if (typeof parsed?.[k] === 'boolean') this._state[k] = parsed[k];
                }
            }
        } catch { /* private window, blocked storage — defaults stand */ }
        return this._state;
    },

    isOpen(id) { return this._load()[id] === true; },

    toggle(id) {
        const s = this._load();
        if (!(id in this._DEFAULT_OPEN)) {
            // 🔴 A toggle for a section that does not exist is a join failure between
            // this map and the page's render — the same class of bug that left four
            // device-card tiles dead (console 0.9.35). Loud, not silent.
            console.warn(`DROP: VoiceAiSections.toggle('${id}') — not a declared section `
                + `(${Object.keys(this._DEFAULT_OPEN).join(', ')}). The header and this map disagree.`);
            return;
        }
        s[id] = !s[id];
        try { sessionStorage.setItem(this._KEY, JSON.stringify(s)); } catch { /* fine */ }
        App.renderPage();
    },

    /**
     * One collapsible section.
     * @param {object} o { id, title, summary, body }
     */
    render(o) {
        const open = this.isOpen(o.id);
        const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        return `
            <div class="card" style="margin-bottom: 12px; overflow: hidden;">
                <button type="button" onclick="VoiceAiSections.toggle('${esc(o.id)}')"
                    aria-expanded="${open ? 'true' : 'false'}"
                    style="font-family: inherit; width: 100%; text-align: left; display: flex; align-items: center;
                           gap: 12px; padding: 13px 16px; border: 0; cursor: pointer; min-height: 56px;
                           background: ${open ? 'var(--surface-muted, #fafafa)' : 'transparent'};
                           ${open ? 'border-bottom: 1px solid var(--border, #e5e7eb);' : ''}">
                    <span style="flex: 1; min-width: 0;">
                        <span style="display: block; font-size: 14px; font-weight: 700; color: var(--text-primary);">${esc(o.title)}</span>
                        <span style="display: block; font-size: 12.5px; color: var(--text-muted); margin-top: 1px;
                                     white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${esc(o.summary)}</span>
                    </span>
                    <span aria-hidden="true" style="color: var(--text-muted); font-size: 13px;">${open ? '▾' : '▸'}</span>
                </button>
                ${open ? `<div style="padding: 14px 16px 16px;">${o.body}</div>` : ''}
            </div>`;
    },

    /**
     * The two-across grid the pickers sit in (John: *"Drop downs go 2 across
     * instead of 3 columns"*).
     *
     * 🔴 An EXPANDED card spans both columns. A card that opens inside one column
     * would grow that column and shove its neighbour down — and the option list is
     * the widest thing on the page, so it would also be the most cramped. The page
     * marks the expanded one; this only lays them out.
     */
    grid(items) {
        const cells = items.filter(Boolean);
        if (!cells.length) return '';
        return `<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; align-items: start;">${cells.join('')}</div>`;
    },

    /** A cell that must occupy the full row rather than one column. */
    full(html) {
        return html ? `<div style="grid-column: 1 / -1;">${html}</div>` : '';
    },
};

window.VoiceAiSections = VoiceAiSections;
