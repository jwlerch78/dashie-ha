/* ============================================================
   House rules — the "add to prompt" slot for Dashie Dynamic Context.

   A few standing lines the household wants obeyed, appended to whatever prompt
   Dashie assembles. John, 2026-10-04: dynamic prompting should still let the
   user put their own rules in the mix.

   ⚠️ ONE STORE, TWO MODES. These same lines seed the Freeform box on a switch
   (VoiceAiPage.setPromptMode → FreeformPrompt.seed). They are not copied into
   it and kept in sync afterwards — seeding happens once, into an empty box —
   because two editable copies of the same three sentences is how they end up
   disagreeing and nobody can tell which one the model saw.
   ============================================================ */

const VoiceAiHouseRules = {

    /** null when closed; otherwise { draft, busy } */
    _open: null,

    open() {
        this._open = { draft: String(VoiceAiPage._defaults['ai.houseRules'] || ''), busy: false };
        App.renderPage();
    },

    close() { this._open = null; App.renderPage(); },

    set(value) {
        // No re-render on input: re-rendering a textarea mid-typing throws the
        // caret to the end, which on a multi-line field is unusable.
        if (this._open) this._open.draft = value;
    },

    _maybeCloseBackdrop(event) {
        if (event.target === event.currentTarget) this.close();
    },

    async save() {
        if (!this._open) return;
        this._open.busy = true;
        App.renderPage();
        // Trailing blank lines are invisible in a textarea and would show up as
        // gaps in the prompt, so they go. Interior blank lines are the user's.
        const text = String(this._open.draft || '').replace(/\s+$/, '');
        await VoiceAiPage.saveDefault('ai.houseRules', text);
        this._open = null;
        App.renderPage();
    },

    render() {
        const m = this._open;
        if (!m) return '';
        const esc = VoiceAiPage._escape.bind(VoiceAiPage);
        const count = m.draft.split('\n').filter((l) => l.trim()).length;
        return `
            <div onclick="VoiceAiHouseRules._maybeCloseBackdrop(event)"
                 style="position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 1050; display: flex; align-items: center; justify-content: center; padding: 16px;">
                <div onclick="event.stopPropagation()"
                     style="background: var(--bg-card, #fff); border-radius: 12px; max-width: 560px; width: 100%; max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3); padding: 20px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;">
                        <h2 style="margin: 0; font-size: 17px;">House rules</h2>
                        <button class="btn btn-ghost btn-sm" onclick="VoiceAiHouseRules.close()" aria-label="Close">✕</button>
                    </div>
                    <p style="font-size: 13px; color: var(--text-muted); margin: 0 0 12px; line-height: 1.5;">
                        One rule per line. They are added to every prompt, whatever the question —
                        so keep them to things that are always true.
                    </p>
                    <textarea class="form-input" rows="7" spellcheck="true"
                        style="font-size: 13px; line-height: 1.6; resize: vertical;"
                        placeholder="Never change a thermostat setpoint by more than 2 degrees in one command.&#10;If a light name is ambiguous, ask which room rather than guessing.&#10;The kids' rooms are off-limits after 8pm — say so instead of acting."
                        oninput="VoiceAiHouseRules.set(this.value)">${esc(m.draft)}</textarea>
                    <div style="font-size: 12px; color: var(--text-muted); margin-top: 6px;">${count} rule${count === 1 ? '' : 's'}</div>
                    <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px;">
                        <button class="btn btn-ghost" onclick="VoiceAiHouseRules.close()" ${m.busy ? 'disabled' : ''}>Cancel</button>
                        <button class="btn btn-primary" onclick="VoiceAiHouseRules.save()" ${m.busy ? 'disabled' : ''}>${m.busy ? 'Saving…' : 'Save'}</button>
                    </div>
                </div>
            </div>`;
    },
};

window.VoiceAiHouseRules = VoiceAiHouseRules;
