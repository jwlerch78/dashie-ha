/* ============================================================
   Voice & AI account-default cards (WS-G Round A)
   ------------------------------------------------------------
   Account-level defaults from Open Brain plan §13.2:

   - Default personality (brain section, under the AI Model card)
     → ai.defaultPersonalityId. Compact single-row card (label +
     inline dropdown — 2026-07-12 vertical-compression pass).

   The account default-VOICE picker was removed (John, 2026-07-12):
   the Dashie Cloud / ElevenLabs voice follows the personality —
   no independent account voice choice. ai.defaultVoiceKey still
   exists ('' = personality's preferred voice) and the per-device
   Voice override lives on the Devices page.

   Devices follow the defaults unless overridden on the Devices
   page (aiVoice.personalityId/voiceKey; '' / unset = follow
   account). Runtime resolution (device ?? account default) is
   Round B — this card stores settings only.

   Pure render. State + writes live on VoiceAiPage:
     VoiceAiPage.saveDefault('ai.defaultPersonalityId', v)
   ============================================================ */

const VoiceAiDefaultsCards = {
    _esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },

    // Borderless <select> styled as bold row text — reads like the collapsed pipeline rows
    // ("Claude Sonnet 4.6") but is a real native dropdown. Keep the NATIVE arrow (no
    // appearance:none): it's part of the select, so clicking the arrow opens the dropdown —
    // a hidden native arrow + a sibling ▾ span left the arrow un-clickable (the whole reason
    // for this row's earlier dead-zone). The native arrow also sits before the Voice row's
    // ▶ preview button, so no overlap.
    SELECT_STYLE: 'flex: 1; min-width: 0; border: none; background: transparent; font-weight: 600; font-size: 13px; color: var(--text-primary); cursor: pointer; padding: 0;',

    /**
     * Compact control row — caps label (aligned with the collapsed pipeline
     * cards) + an inline control + a ▾. Shared by the Default-personality and
     * Voice rows.
     * @param {object} o { label, saving, controlHtml, caret=true, icon }
     *   icon — optional assets/icons/<name> (WS-F §13.1), rendered before the
     *   title exactly like the pipeline stage cards so all six rows match.
     */
    renderControlRow(o) {
        const icon = o.icon
            ? `<img src="assets/icons/${this._esc(o.icon)}.svg" alt="" style="width: 15px; height: 15px; opacity: 0.55; flex-shrink: 0;">`
            : '';
        // No fake ▾ span — the select carries its own (clickable) native arrow now. `o.caret`
        // is accepted for back-compat but no longer renders anything.
        return `
            <div class="card" style="margin-bottom: 10px;"><div class="card-body" style="display: flex; align-items: center; gap: 10px; padding: 10px 14px;">
                <span style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); min-width: 170px; display: inline-flex; align-items: center; gap: 7px;">${icon}${this._esc(o.label)} ${o.saving ? '<span style="font-weight: 400; text-transform: none;">· saving…</span>' : ''}</span>
                ${o.controlHtml}
            </div></div>`;
    },

    /**
     * Default-personality row — bold borderless dropdown styled like the
     * collapsed pipeline rows.
     * @param {object} o { templates, custom, currentId, saving }
     */
    renderPersonalityCard(o) {
        const groups = [];
        const opt = (v, l) => `<option value="${this._esc(v)}" ${String(v) === String(o.currentId) ? 'selected' : ''}>${this._esc(l)}</option>`;
        const customOpts = (o.custom || []).map(c => opt(c.id, c.name || 'Custom personality')).join('');
        if (customOpts) groups.push(`<optgroup label="Custom">${customOpts}</optgroup>`);
        const templateOpts = (o.templates || []).map(t => opt(t.key || t.id, t.name || t.key)).join('');
        groups.push(`<optgroup label="Built-in">${templateOpts}</optgroup>`);
        return this.renderControlRow({
            label: 'Default personality',
            icon: 'icon-persona',
            saving: o.saving,
            controlHtml: `<select style="${this.SELECT_STYLE}" onchange="VoiceAiPage.saveDefault('ai.defaultPersonalityId', this.value)">${groups.join('')}</select>`,
        });
    },

    /**
     * Default wake-word row → ai.defaultWakeWord (WS-G §13.2 account default).
     *
     * Devices follow this unless overridden on the Devices page (aiVoice.wakeWord;
     * '' / unset = follow the account). A device whose APK doesn't bundle the chosen
     * model keeps its own word and reports aiVoice.defaultWakeWordUnavailable rather
     * than silently degrading — that badge isn't surfaced here yet.
     *
     * Options come from VoiceAiOptions.WAKE_WORDS — the single console copy, whose ids
     * are lint-gated against Kotlin's WakeWordModel (see lint:voice-options). Don't
     * inline a list here.
     *
     * @param {object} o { currentId, saving }
     */
    renderWakeWordCard(o) {
        const words = window.VoiceAiOptions?.WAKE_WORDS || [];
        const current = String(o.currentId || 'hey_dashie');
        const opts = words
            .map(w => `<option value="${this._esc(w.id)}" ${w.id === current ? 'selected' : ''}>${this._esc(w.label)}</option>`)
            .join('');
        return this.renderControlRow({
            // Dashie's microphone — the same icon the webapp's volume slider and Android's
            // ic_mic_on use. (icon-ear is the Speech-to-text stage icon; reusing it here
            // would read as "another STT card" rather than "the word that wakes the mic".)
            label: 'Wake word',
            icon: 'icon-microphone',
            saving: o.saving,
            controlHtml: `<select style="${this.SELECT_STYLE}" onchange="VoiceAiPage.saveDefault('ai.defaultWakeWord', this.value)">${opts}</select>`,
        });
    },
};

window.VoiceAiDefaultsCards = VoiceAiDefaultsCards;
