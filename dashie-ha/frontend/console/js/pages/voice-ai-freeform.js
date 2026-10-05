/* ============================================================
   Freeform prompt editor.

   The whole system prompt, written by the user, rendered by Home Assistant.
   Shaped after HA's own Instructions box (core 2026.9.3): their text is first
   and nothing structural follows it, because tool schemas travel as function
   declarations rather than as prose. That is what makes the box safe to hand
   over — there is no contract inside it for a user to break.

   ── EDITABLE / RAW ──────────────────────────────────────────────────────────
   One panel, two views. Raw is not a preview of the box; it is everything that
   will be sent — the rendered template, the personality, the guidance lines and
   the tool signatures. John, 2026-10-04: the user should see all of it in one
   place rather than being told what we add.

   Rendering goes to HA (`/api/freeform/render`), never to a Jinja we wrote.
   ============================================================ */

const VoiceAiFreeform = {

    /** null when closed; otherwise { prompt, view, rendered, error, busy, dirty } */
    _open: null,

    open() {
        const d = VoiceAiPage._defaults;
        const prompt = String(d['ai.freeformPrompt'] || '')
            || window.FreeformPrompt.seed(d['ai.houseRules']);
        this._open = { prompt, view: 'edit', rendered: null, error: null, busy: false, dirty: false };
        App.renderPage();
    },

    close() { this._open = null; App.renderPage(); },

    _maybeCloseBackdrop(event) {
        if (event.target === event.currentTarget) this.close();
    },

    /** No re-render while typing — it would move the caret to the end. */
    set(value) {
        if (!this._open) return;
        this._open.prompt = value;
        this._open.dirty = true;
        // The rendered copy is now stale. Dropping it is the point: a Raw view
        // showing yesterday's render beside today's text is the confident wrong
        // answer this whole surface is trying not to give.
        this._open.rendered = null;
    },

    async setView(view) {
        if (!this._open) return;
        this._open.view = view;
        if (view === 'raw' && this._open.rendered === null) await this.render();
        else App.renderPage();
    },

    /** Ask HA to render the template. HA's error is shown as HA wrote it. */
    async render() {
        if (!this._open) return;
        this._open.busy = true;
        this._open.error = null;
        App.renderPage();
        try {
            const resp = await fetch(DashieAuth._addonUrl('/api/freeform/render'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ template: this._open.prompt }),
            });
            const body = await resp.json().catch(() => ({}));
            if (resp.ok) { this._open.rendered = body.rendered ?? ''; }
            else { this._open.error = body.error || `Render failed (HTTP ${resp.status})`; this._open.rendered = null; }
        } catch (e) {
            this._open.error = `Could not reach the add-on: ${e.message}`;
            this._open.rendered = null;
        }
        this._open.busy = false;
        App.renderPage();
    },

    async save() {
        if (!this._open) return;
        this._open.busy = true;
        App.renderPage();
        await VoiceAiPage.saveDefault('ai.freeformPrompt', this._open.prompt);
        this._open = null;
        App.renderPage();
    },

    /**
     * The personality text the prompt will carry, built through the SAME
     * builder the brain uses (personality-prompt-builder.js) rather than a
     * second copy of the field-to-prose rules. Returns '' when the mode is off,
     * or when the console has not loaded the templates yet — in which case the
     * Raw view says the block is pending instead of pretending there is none.
     */
    _personalityText() {
        const d = VoiceAiPage._defaults;
        if (d['ai.personalityMode'] === 'off') return '';
        const id = d['ai.defaultPersonalityId'];
        if (!id || id === 'dashie') return '';
        const row = (VoiceAiPage._templates || []).find((t) => (t.key || t.id) === id);
        if (!row) return null;   // not loaded — distinct from "none"
        try {
            const built = window.PersonalityPromptBuilder?.buildPersonalityPrompt?.(row);
            return built ? [built.responsePrefix, built.responseSuffix].filter(Boolean).join('\n\n').trim() : '';
        } catch { return null; }
    },

    _rawText() {
        const d = VoiceAiPage._defaults;
        const m = this._open;
        const pers = this._personalityText();
        const tools = d['ai.toolsEnabled'];
        // The clock tool means HA's own rule applies: a fact is either a tool or
        // a prompt line, never both.
        // ⚠️ `parse()` returns id STRINGS; `enabled()` returns the tool OBJECTS. This
        // read `.some((t) => t.id === 'schedule')` on strings, so `t.id` was undefined
        // and hasClock was ALWAYS false — the date line was appended even with the
        // clock tool on, which is the one thing HA's rule says must not happen (a fact
        // is a tool or a prompt line, never both).
        const hasClock = window.PromptToolCatalog.parse(tools).includes('schedule');
        return window.FreeformPrompt.raw({
            rendered: m.rendered === null ? m.prompt : m.rendered,
            pending: m.rendered === null,
            personalityText: pers === null ? '[personality — still loading]' : pers,
            toolsStored: tools,
            dateLine: hasClock ? '' : window.FreeformPrompt.dateLine(),
            // 🔴 INJECTED, not read from a global inside raw(): the same assembly now
            // runs on the add-on server where there is no `window`. See the note in
            // js/ai/prompts/freeform-prompt.js.
            catalog: window.PromptToolCatalog,
        });
    },

    // ── render ──────────────────────────────────────────────────────────────

    render() {
        const m = this._open;
        if (!m) return '';
        const esc = VoiceAiPage._escape.bind(VoiceAiPage);
        const d = VoiceAiPage._defaults;
        return `
            <div onclick="VoiceAiFreeform._maybeCloseBackdrop(event)"
                 style="position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 1050; display: flex; align-items: center; justify-content: center; padding: 16px;">
                <div onclick="event.stopPropagation()"
                     style="background: var(--bg-card, #fff); border-radius: 12px; max-width: 1080px; width: 100%; max-height: 92vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3); padding: 20px;">

                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px;">
                        <h2 style="margin: 0; font-size: 17px;">Freeform</h2>
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <button class="btn btn-primary" onclick="VoiceAiFreeform.save()" ${m.busy ? 'disabled' : ''}>${m.busy ? 'Saving…' : 'Save'}</button>
                            <button class="btn btn-ghost btn-sm" onclick="VoiceAiFreeform.close()" aria-label="Close">✕</button>
                        </div>
                    </div>

                    <div style="display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap;">
                        <div style="flex: 999 1 540px; min-width: 0; display: flex; flex-direction: column; gap: 12px;">
                            ${this._personalityRow(d)}
                            ${this._promptCard(m, esc)}
                        </div>
                        <div style="flex: 1 1 300px; min-width: 0;">${this._toolsCard(d, esc)}</div>
                    </div>
                </div>
            </div>`;
    },

    _personalityRow(d) {
        const mode = d['ai.personalityMode'] || 'automatic';
        const id = d['ai.defaultPersonalityId'];
        const row = (VoiceAiPage._templates || []).find((t) => (t.key || t.id) === id);
        const name = row?.name || (id && id !== 'dashie' ? id : 'None');
        return `
            <div class="card" style="padding: 13px 15px; display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;">
                <div>
                    <div style="font-size: 14px; font-weight: 500;">Personality</div>
                    <div style="font-size: 12.5px; color: var(--text-muted); margin-top: 2px;">${VoiceAiPage._escape(name)}</div>
                </div>
                ${this._seg('VoiceAiFreeform.setPersonalityMode', mode, [
                    ['automatic', 'Automatic'], ['custom', 'Custom'], ['off', 'Off'],
                ])}
            </div>`;
    },

    setPersonalityMode(mode) { VoiceAiPage.saveDefault('ai.personalityMode', mode); },

    _promptCard(m, esc) {
        const raw = m.view === 'raw';
        return `
            <div class="card" style="padding: 13px 15px;">
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;">
                    <div>
                        <div style="font-size: 14px; font-weight: 500;">Your prompt</div>
                        <div style="font-size: 12.5px; color: var(--text-muted); margin-top: 2px;">Jinja, rendered by Home Assistant</div>
                    </div>
                    <div style="display: flex; gap: 8px; align-items: center;">
                        ${m.busy ? '<span style="font-size: 12px; color: var(--text-muted);">Rendering…</span>' : ''}
                        ${this._seg('VoiceAiFreeform.setView', raw ? 'raw' : 'edit', [['edit', 'Editable'], ['raw', 'Raw']])}
                    </div>
                </div>
                ${m.error ? `<div style="background: rgba(220,38,38,0.08); color: #dc2626; border-radius: 6px; padding: 8px 12px; font-size: 12.5px; margin-top: 10px; white-space: pre-wrap;">${esc(m.error)}</div>` : ''}
                ${raw
                    ? `<pre style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.75; white-space: pre-wrap; background: var(--bg-subtle, #fafafa); border: 1px solid var(--border, #e5e7eb); border-radius: 7px; padding: 12px 14px; margin: 11px 0 0; max-height: 46vh; overflow: auto;">${esc(this._rawText())}</pre>`
                    : `<textarea class="form-input" rows="14" spellcheck="false"
                        style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.75; margin-top: 11px; resize: vertical;"
                        oninput="VoiceAiFreeform.set(this.value)">${esc(m.prompt)}</textarea>
                       <div style="margin-top: 9px;"><button class="btn btn-ghost btn-sm" onclick="VoiceAiFreeform.render()" ${m.busy ? 'disabled' : ''}>Render</button></div>`}
            </div>`;
    },

    _toolsCard(d, esc) {
        const C = window.PromptToolCatalog;
        const on = new Set(C.parse(d['ai.toolsEnabled']).map((t) => t.id));
        const rows = C.TOOLS.map((t) => `
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; border-top: 1px solid var(--border-subtle, #f1f2f4);">
                <div style="min-width: 0;">
                    <div style="font-size: 14px; font-weight: 500;">${esc(t.label)}</div>
                    <div style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; color: var(--text-muted);">${esc(t.fn)}</div>
                </div>
                <label class="toggle" style="flex-shrink: 0;">
                    <input type="checkbox" ${on.has(t.id) ? 'checked' : ''}
                        onchange="VoiceAiPage.toggleTool('${t.id}', this.checked)">
                    <span class="toggle-slider"></span>
                </label>
            </div>`).join('');
        return `
            <div class="card" style="padding: 13px 15px;">
                <div style="font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-muted); font-weight: 600;">Tools</div>
                ${rows}
            </div>`;
    },

    /** Segmented control, the shape the console already uses for small enums. */
    _seg(handler, selected, options) {
        const cells = options.map(([id, label]) => {
            const sel = id === selected;
            const style = sel
                ? 'background: var(--accent); color: #fff; font-weight: 600;'
                : 'background: var(--bg-card, #fff); color: var(--text-secondary, #4b5563);';
            return `<button onclick="${handler}('${id}')" style="font: inherit; font-size: 12.5px; padding: 6px 14px; border: none; cursor: pointer; ${style}">${label}</button>`;
        }).join('<span style="width:1px; background: var(--border, #d1d5db);"></span>');
        return `<span style="display: inline-flex; border: 1px solid var(--border, #d1d5db); border-radius: 7px; overflow: hidden; flex-shrink: 0;">${cells}</span>`;
    },
};

window.VoiceAiFreeform = VoiceAiFreeform;
