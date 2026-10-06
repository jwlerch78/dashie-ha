/**
 * VoiceAiPromptSection — the body of "AI Prompt & Tools" (was "AI Tools &
 * Settings") on the Voice & AI Settings tab.
 *
 * ── WHY IT IS A SECTION AND NOT A PAGE ───────────────────────────────────────
 * John, 2026-10-04: the prompt surface belongs where the other AI settings
 * already are. Everything here is a summary with one way in; the long surfaces
 * (the Freeform box, the house rules) open from it rather than living in it, so
 * the collapsed section stays one line like its neighbours.
 *
 * ── THE MODE CHOICE USES THE PRESET-CARD SHAPE ON PURPOSE ────────────────────
 * Same markup grammar as VoiceAiPresetPicker's Cloud / Hybrid / Local cards —
 * grid of minmax(158px, 1fr), accent ring plus a tick on the selected one. A
 * second visual language for "pick one of these" on the same page would read as
 * a different KIND of choice, which it is not.
 *
 * Pure render. State and writes live on VoiceAiPage, like the other components
 * on this tab.
 */
const VoiceAiPromptSection = {

    /**
     * @param {object} o
     * @param {string} o.mode        'dynamic' | 'freeform'
     * @param {string} o.houseRules  raw text
     * @param {string} o.tools       comma-joined tool ids as stored
     * @param {string} o.pickers     the existing web-search / HA-entities cards,
     *                               passed through so this component owns the
     *                               ORDER of the section rather than guessing it
     *                               from where the caller happens to print them.
     */
    render(o) {
        const dynamic = o.mode !== 'freeform';
        return `
            ${this._modes(dynamic)}
            ${o.pickers || ''}
            ${this._toolsRow(o.tools, dynamic)}
            ${dynamic ? this._houseRulesRow(o.houseRules) : ''}`;
    },

    // ── the two mode cards ──────────────────────────────────────────────────

    _modes(dynamic) {
        return `
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(158px, 1fr)); gap: 10px; margin-bottom: 12px;">
                ${this._modeCard({
                    id: 'dynamic', selected: dynamic,
                    label: `${BRAND.productName} Dynamic Context`,
                    tag: 'Recommended', tagColor: 'var(--status-ok, #16a34a)',
                    desc: `${BRAND.productName} builds the prompt each turn — picks the tools your question needs and injects the data they return. You can still add your own house rules.`,
                })}
                ${this._modeCard({
                    id: 'freeform', selected: !dynamic,
                    label: 'Freeform',
                    tag: 'Advanced', tagColor: 'var(--accent)',
                    desc: `You write the prompt. ${BRAND.productName} adds only the tools you switch on, as functions the model can call. (Jinja, rendered by Home Assistant.)`,
                })}
            </div>`;
    },

    _modeCard(c) {
        const ring = c.selected ? 'box-shadow: 0 0 0 2px var(--accent); border-color: var(--accent);' : '';
        const tick = c.selected ? '<span style="color: var(--accent); font-weight: 700;">✓</span>' : '';
        return `
            <div onclick="VoiceAiPage.setPromptMode('${c.id}')" class="card"
                style="cursor: pointer; padding: 12px 14px; display: flex; flex-direction: column; ${ring}">
                <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 8px;">
                    <div style="font-weight: 700; font-size: 14px;">${this._esc(c.label)}</div>
                    ${tick}
                </div>
                <div style="font-size: 11px; font-weight: 600; margin-top: 2px; color: ${c.tagColor};">${this._esc(c.tag)}</div>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 6px; line-height: 1.45;">${this._esc(c.desc)}</div>
            </div>`;
    },

    // ── the two summary rows ────────────────────────────────────────────────

    /**
     * Tools, as a list rather than a column of switches. John, 2026-10-04 — the
     * section is a summary; thirteen toggle rows here would make it the longest
     * thing on the page and bury the two settings underneath it. The switches
     * live in the editor's sidebar, one click away.
     */
    _toolsRow(tools, dynamic) {
        const C = window.PromptToolCatalog;
        const on = C.enabled(tools);
        const label = dynamic ? 'Edit tools' : 'Edit prompt &amp; tools';
        // Zero enabled is a state worth saying in words. "Tools enabled — 0" with
        // an empty line underneath reads as a page that failed to load.
        const body = on.length
            ? this._esc(C.summary(tools))
            : `<span style="color: var(--text-muted);">None — ${BRAND.assistantName} will answer from the model alone.</span>`;
        return `
            <div class="card" style="margin-top: 10px; padding: 11px 13px; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;">
                <div style="min-width: 0;">
                    <div style="font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-muted); font-weight: 600;">Tools enabled — ${on.length}</div>
                    <div style="font-size: 13.5px; line-height: 1.6; margin-top: 4px;">${body}</div>
                </div>
                <button onclick="VoiceAiPage.openPromptEditor()" class="btn-secondary"
                    style="flex-shrink: 0; font-size: 12.5px; font-weight: 600; padding: 6px 13px; border-radius: 6px; cursor: pointer;">${label}</button>
            </div>`;
    },

    /**
     * House rules — the "add to prompt" slot for Dynamic mode (John, 2026-10-04).
     * Not shown in Freeform, where the rules have already been seeded into the
     * box and the box is the only text that matters; two editable copies of the
     * same lines is how they end up disagreeing.
     */
    _houseRulesRow(rules) {
        const text = String(rules || '').trim();
        const lines = text ? text.split('\n').filter((l) => l.trim()) : [];
        const body = lines.length
            ? lines.map((l) => this._esc(l)).join('<br>')
            : `<span style="color: var(--text-muted);">Nothing yet — a few standing lines ${BRAND.assistantName} should always obey.</span>`;
        return `
            <div class="card" style="margin-top: 10px; padding: 11px 13px; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;">
                <div style="min-width: 0;">
                    <div style="font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-muted); font-weight: 600;">Add to prompt — house rules</div>
                    <div style="font-size: 13.5px; line-height: 1.65; margin-top: 4px;">${body}</div>
                </div>
                <button onclick="VoiceAiPage.openHouseRules()" class="btn-secondary"
                    style="flex-shrink: 0; font-size: 12.5px; font-weight: 600; padding: 6px 13px; border-radius: 6px; cursor: pointer;">Edit</button>
            </div>`;
    },

    /** The one-line summary when the section is shut. Reads the SAME values the
     *  body renders from, so a collapsed section cannot disagree with an open one. */
    summary(o) {
        const C = window.PromptToolCatalog;
        const n = C.enabled(o.tools).length;
        const rules = String(o.houseRules || '').trim();
        const ruleCount = rules ? rules.split('\n').filter((l) => l.trim()).length : 0;
        return [
            o.mode === 'freeform' ? 'freeform' : 'dynamic context',
            `${n} tool${n === 1 ? '' : 's'}`,
            o.mode === 'freeform' || !ruleCount ? '' : `${ruleCount} house rule${ruleCount === 1 ? '' : 's'}`,
        ].filter(Boolean);
    },

    _esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
};

window.VoiceAiPromptSection = VoiceAiPromptSection;
