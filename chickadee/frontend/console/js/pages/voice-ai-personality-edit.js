/* ============================================================
   Personality editor modal — create/edit custom personalities
   and edit family-notes overrides on built-in templates.

   Three open modes:
   - openNew()           blank custom personality
   - openEdit(id)        edit an existing custom personality
   - openOverride(key)   edit only the family_notes override on a
                         built-in template (everything else read-only)

   Custom fields mirror the create_personality/update_personality
   handler shape (name, base_personality, personality_overview,
   similar_persona, adjectives[], topics[], example_phrases[],
   family_notes, voice_mode, voice). Voice catalog comes from
   list_voices, lazily fetched once.
   ============================================================ */

const VoiceAiPersonalityEdit = {
    /** null when closed; otherwise { mode, id|key, draft, busy, error } */
    _open: null,
    _voices: null,   // [{key, name, description}] — lazy

    VOICE_MODES: [
        ['preferred', 'Preferred — voice can be changed per device'],
        ['fixed', 'Fixed — this personality always uses its voice'],
    ],

    openNew() {
        this._open = {
            mode: 'create', id: null, busy: false, error: null,
            draft: this._blankDraft(),
        };
        this._ensureVoices();
        App.renderPage();
    },

    openEdit(id) {
        const p = VoiceAiPage.getCustom(id);
        if (!p) return;
        this._open = {
            mode: 'edit', id, busy: false, error: null,
            draft: {
                name: p.name || '',
                base_personality: p.base_personality || '',
                personality_overview: p.personality_overview || '',
                similar_persona: p.similar_persona || '',
                adjectives: (p.adjectives || []).join(', '),
                topics: (p.topics || []).join(', '),
                example_phrases: (p.example_phrases || []).join('\n'),
                family_notes: p.family_notes || '',
                voice_mode: p.voice_mode || 'preferred',
                voice: p.voice || '',
            },
        };
        this._ensureVoices();
        App.renderPage();
    },

    openOverride(key) {
        const t = VoiceAiPage.getTemplate(key);
        if (!t) return;
        this._open = {
            mode: 'override', key, busy: false, error: null,
            draft: { name: t.name, family_notes: VoiceAiPage.overrideNotes(key) },
        };
        App.renderPage();
    },

    close() {
        this._open = null;
        App.renderPage();
    },

    _maybeCloseBackdrop(e) {
        if (e.target === e.currentTarget) this.close();
    },

    _blankDraft() {
        return {
            name: '', base_personality: '', personality_overview: '',
            similar_persona: '', adjectives: '', topics: '',
            example_phrases: '', family_notes: '', voice_mode: 'preferred', voice: '',
        };
    },

    async _ensureVoices() {
        if (this._voices !== null) return;
        try {
            this._voices = await VoiceAiApi.listVoices();
        } catch (e) {
            console.warn('[VoiceAiPersonalityEdit] voices fetch failed:', e.message);
            this._voices = [];
        }
        if (this._open) App.renderPage();
    },

    set(field, value) {
        if (this._open) this._open.draft[field] = value;
    },
    setAndRender(field, value) {
        this.set(field, value);
        App.renderPage();
    },

    async save() {
        const m = this._open;
        if (!m || m.busy) return;
        const d = m.draft;

        if (m.mode === 'override') {
            m.busy = true; m.error = null; App.renderPage();
            try {
                await VoiceAiApi.saveOverride(m.key, d.family_notes.trim());
                Toast.info('Family notes saved');
                this._open = null;
                await VoiceAiPage._fetchPersonalities();
                App.renderPage();
            } catch (e) {
                m.busy = false; m.error = `Save failed: ${e.message}`; App.renderPage();
            }
            return;
        }

        if (!d.name.trim()) {
            m.error = 'Name is required.';
            return App.renderPage();
        }

        const payload = {
            name: d.name.trim(),
            base_personality: d.base_personality || null,
            personality_overview: d.personality_overview.trim() || null,
            similar_persona: d.similar_persona.trim() || null,
            adjectives: this._splitList(d.adjectives),
            topics: this._splitList(d.topics),
            example_phrases: this._splitLines(d.example_phrases),
            family_notes: d.family_notes.trim() || null,
            voice_mode: d.voice_mode,
            voice: d.voice || null,
        };

        m.busy = true; m.error = null; App.renderPage();
        try {
            if (m.mode === 'create') await VoiceAiApi.createPersonality(payload);
            else await VoiceAiApi.updatePersonality(m.id, payload);
            Toast.info(m.mode === 'create' ? `Created "${payload.name}"` : `Saved "${payload.name}"`);
            this._open = null;
            await VoiceAiPage._fetchPersonalities();
            App.renderPage();
        } catch (e) {
            console.error('[VoiceAiPersonalityEdit] save failed:', e);
            m.busy = false; m.error = `Save failed: ${e.message}`; App.renderPage();
        }
    },

    _splitList(s) {
        const arr = (s || '').split(',').map(x => x.trim()).filter(Boolean);
        return arr.length ? arr : null;
    },
    _splitLines(s) {
        const arr = (s || '').split('\n').map(x => x.trim()).filter(Boolean);
        return arr.length ? arr : null;
    },

    // ── Render ───────────────────────────────────────────────

    render() {
        const m = this._open;
        if (!m) return '';
        return m.mode === 'override' ? this._renderOverride(m) : this._renderCustom(m);
    },

    _renderOverride(m) {
        const esc = VoiceAiPage._escape.bind(VoiceAiPage);
        return this._frame(`Family notes — ${esc(m.draft.name)}`, m, `
            <p style="font-size: 13px; color: var(--text-muted); margin: 0 0 12px;">
                Add household-specific context for this built-in personality (names, preferences,
                inside jokes). The base personality is unchanged.
            </p>
            ${this._textarea('Family notes', 'family_notes', m.draft.family_notes, 5, 'e.g. We have two kids, Mia (8) and Theo (5). Dad works nights.')}
        `, m.busy ? 'Saving…' : 'Save Notes');
    },

    _renderCustom(m) {
        const esc = VoiceAiPage._escape.bind(VoiceAiPage);
        const d = m.draft;
        const title = m.mode === 'create' ? 'New Personality' : `Edit — ${esc(d.name)}`;
        const templates = VoiceAiPage._templates || [];
        const baseOptions = [['', 'None (from scratch)'], ...templates.map(t => [t.key || t.id, t.name])];
        const voiceOptions = [['', 'Default'], ...(this._voices || []).map(v => [v.key, v.name + (v.description ? ` — ${v.description}` : '')])];
        const voicesLoading = this._voices === null;

        return this._frame(title, m, `
            ${this._input('Name', 'name', d.name, 'e.g. Grandma Jo')}
            ${this._select('Based on', 'base_personality', baseOptions, d.base_personality)}
            ${this._textarea('Personality overview', 'personality_overview', d.personality_overview, 3, 'A warm, patient grandmother who loves to tell stories.')}
            ${this._input('Similar to (persona)', 'similar_persona', d.similar_persona, 'e.g. Mrs. Doubtfire')}
            ${this._input('Adjectives', 'adjectives', d.adjectives, 'comma-separated: warm, patient, witty')}
            ${this._input('Topics', 'topics', d.topics, 'comma-separated: cooking, gardening, family history')}
            ${this._textarea('Example phrases', 'example_phrases', d.example_phrases, 3, 'One per line')}
            ${this._textarea('Family notes', 'family_notes', d.family_notes, 2, 'Household-specific context')}
            ${this._select('Voice', 'voice', voiceOptions, d.voice)}
            ${voicesLoading ? '<div style="font-size: 12px; color: var(--text-muted); margin: -6px 0 12px;">Loading voices…</div>' : ''}
            ${this._select('Voice mode', 'voice_mode', this.VOICE_MODES, d.voice_mode)}
        `, m.busy ? 'Saving…' : (m.mode === 'create' ? 'Create' : 'Save'));
    },

    /** Shared modal frame. */
    _frame(title, m, bodyHtml, primaryLabel) {
        const esc = VoiceAiPage._escape.bind(VoiceAiPage);
        return `
            <div onclick="VoiceAiPersonalityEdit._maybeCloseBackdrop(event)"
                 style="position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 1050; display: flex; align-items: center; justify-content: center; padding: 16px;">
                <div onclick="event.stopPropagation()"
                     style="background: var(--bg-card, #fff); border-radius: 12px; max-width: 560px; width: 100%; max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3); padding: 20px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
                        <h2 style="margin: 0; font-size: 17px;">${esc(title)}</h2>
                        <button class="btn btn-ghost btn-sm" onclick="VoiceAiPersonalityEdit.close()" aria-label="Close">✕</button>
                    </div>
                    ${m.error ? `<div style="background: rgba(220,38,38,0.08); color: #dc2626; border-radius: 6px; padding: 8px 12px; font-size: 13px; margin-bottom: 12px;">${esc(m.error)}</div>` : ''}
                    ${bodyHtml}
                    <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px;">
                        <button class="btn btn-ghost" onclick="VoiceAiPersonalityEdit.close()" ${m.busy ? 'disabled' : ''}>Cancel</button>
                        <button class="btn btn-primary" onclick="VoiceAiPersonalityEdit.save()" ${m.busy ? 'disabled' : ''}>${esc(primaryLabel)}</button>
                    </div>
                </div>
            </div>
        `;
    },

    _input(label, field, value, placeholder) {
        const esc = VoiceAiPage._escape.bind(VoiceAiPage);
        return `
            <div class="form-group">
                <label class="form-label">${esc(label)}</label>
                <input class="form-input" type="text" value="${esc(value)}" placeholder="${esc(placeholder || '')}"
                    onchange="VoiceAiPersonalityEdit.set('${field}', this.value)">
            </div>
        `;
    },

    _textarea(label, field, value, rows, placeholder) {
        const esc = VoiceAiPage._escape.bind(VoiceAiPage);
        return `
            <div class="form-group">
                <label class="form-label">${esc(label)}</label>
                <textarea class="form-input" rows="${rows || 3}" placeholder="${esc(placeholder || '')}"
                    style="resize: vertical; font: inherit;"
                    onchange="VoiceAiPersonalityEdit.set('${field}', this.value)">${esc(value)}</textarea>
            </div>
        `;
    },

    _select(label, field, options, current) {
        const esc = VoiceAiPage._escape.bind(VoiceAiPage);
        const opts = options.map(([v, l]) =>
            `<option value="${esc(v)}" ${String(v) === String(current) ? 'selected' : ''}>${esc(l)}</option>`).join('');
        return `
            <div class="form-group">
                <label class="form-label">${esc(label)}</label>
                <select class="form-select" onchange="VoiceAiPersonalityEdit.set('${field}', this.value)">${opts}</select>
            </div>
        `;
    },
};
