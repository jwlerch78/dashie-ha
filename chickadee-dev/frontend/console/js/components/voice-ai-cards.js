/* ============================================================
   Voice & AI component cards
   ------------------------------------------------------------
   Renders one "component card" for a pipeline stage (AI Model /
   Speech-to-text / Text-to-speech / Web search source).

   Collapsed: shows only the selected option, with a ▾ — click the
   box to open. Expanded: shows every option (grouped by provider
   when options carry a `group`); click an option to select it,
   which collapses the card again.

   Each row: a colored Cloud/Local tag + a light row tint (orange =
   cloud, green = local, no icons), the option name, cost +
   description, and — when selected with configFields — inline
   inputs (Local-LLM endpoint, SearXNG URL, …).

   Pure render. State lives in VoiceAiPage; interactions call back:
     VoiceAiPage.toggleCard(stageKey)              (collapsed → open)
     VoiceAiPage.selectOption(stageKey, id)        (open → pick + close)
     VoiceAiPage.saveLocalField(dottedKey, value)
   ============================================================ */

const VoiceAiCards = {
    _esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },

    /** The BYO-key badge icon (Open Brain §5), sized to sit inline with row text. */
    _keyIcon() {
        return `<img src="assets/icons/icon-key.svg" alt="API key" title="Runs on your API key" style="width: 13px; height: 13px; opacity: 0.6; flex-shrink: 0;">`;
    },

    /** @param {object} o { title, stageKey, options[], selectedId, expanded, getConfig(key) } */
    render(o) {
        const opts = o.options || [];
        const sel = opts.find(x => x.id === o.selectedId) || opts[0];
        if (!sel) return '';

        // Single-option cards render exactly like the rest: a compact collapsed
        // row (no cost at this level) that expands to the option list, where
        // the cost + description live (John, 2026-07-12 — the selector opens
        // even when there's only one option).

        // Collapsed: one compact summary row — section title, the selected
        // option, a caret (2026-07-12 vertical-compression pass; the old
        // full selected-option card is only shown expanded). Expanding
        // reveals the option list directly.
        // WS-F (§13.1): optional stage icon (brain / ear / speaking head) before the
        // title, drawn from assets/icons/ to match the console set's line style.
        const icon = o.icon
            ? `<img src="assets/icons/${this._esc(o.icon)}.svg" alt="" style="width: 15px; height: 15px; opacity: 0.55; flex-shrink: 0;">`
            : '';
        if (!o.expanded) {
            const O = window.VoiceAiOptions;
            const color = O.COLOR[sel.locality] || 'var(--text-muted)';
            const tag = sel.locality
                ? `<span style="font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.4px; color:${color};">${O.LABEL[sel.locality] || ''}</span>`
                : '';
            // Key badge (Open Brain §5): the selected option runs on a BYO key → key
            // icon next to it, so the summary reads "Gemini 2.5 Flash CLOUD 🔑".
            const keyBadge = sel.keyed ? this._keyIcon() : '';
            const dimmed = o.anyExpanded;
            return `
                <div style="margin-bottom: 10px; transition: opacity 120ms ease; ${dimmed ? 'opacity: 0.45;' : ''}">
                    <div class="card"><div class="card-body" style="padding: 0;">
                        <div onclick="VoiceAiPage.toggleCard('${o.stageKey}')"
                            style="cursor: pointer; display: flex; align-items: center; gap: 10px; padding: 10px 14px;">
                            <span style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); min-width: 170px; display: inline-flex; align-items: center; gap: 7px;">${icon}${this._esc(o.title)}</span>
                            <span style="flex: 1; font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 8px;">${this._esc(sel.label)} ${tag} ${keyBadge}</span>
                            <span style="color: var(--text-muted); font-size: 13px;">▸</span>
                        </div>
                    </div></div>
                </div>`;
        }

        // Expanded: explicit "you're choosing" header with a ▴ close affordance,
        // then the full option list. Pops with an accent ring + shadow.
        const head = `
            <div onclick="VoiceAiPage.toggleCard('${o.stageKey}')"
                style="cursor: pointer; display:flex; justify-content:space-between; align-items:center; padding: 10px 14px; border-bottom: 1px solid var(--border, #e5e7eb); background: var(--surface-muted, #fafafa);">
                <span style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--accent); display: inline-flex; align-items: center; gap: 7px;">${icon}Choose ${this._esc(o.title)}</span>
                <span style="color: var(--text-muted); font-size: 13px;">▴</span>
            </div>`;
        let prevGroup = null;
        const rows = opts.map((x, i) => {
            const groupChanged = !!x.group && x.group !== prevGroup;
            let header = '';
            if (groupChanged) {
                header = `<div style="padding: 9px 14px 5px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); ${i === 0 ? '' : 'border-top: 1px solid var(--border, #e5e7eb);'}">${this._esc(x.group)}</div>`;
                prevGroup = x.group;
            }
            const firstInGroup = groupChanged || i === 0;
            return header + this._row(x, x.id === o.selectedId, o.stageKey, o.getConfig, firstInGroup, 'select');
        }).join('');
        // Optional footer inside the expanded card (e.g. the entity card's
        // "Edit exposed list ↗" deep-link) — only ever shown while expanded.
        const footer = o.footerHtml || '';
        return `
            <div style="margin-bottom: 10px;">
                <div class="card" style="box-shadow: 0 0 0 2px var(--accent), 0 6px 18px rgba(0,0,0,0.10); border-color: var(--accent);"><div class="card-body" style="padding: 0;">
                    ${head + rows + footer}
                </div></div>
            </div>`;
    },

    _row(x, selected, stageKey, getConfig, isFirst, mode) {
        const O = window.VoiceAiOptions;
        const color = O.COLOR[x.locality] || 'var(--text-muted)';
        const bg = (O.BG || {})[x.locality] || 'transparent';
        const localityTag = `<span style="font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.4px; color:${color};">${O.LABEL[x.locality] || ''}</span>`;
        const soon = x.comingSoon
            ? `<span style="font-size:10px; font-weight:600; color: var(--text-muted); background: var(--bg-card, #fff); border: 1px solid var(--border, #e5e7eb); padding: 1px 6px; border-radius: 9px;">coming soon</span>`
            : '';
        const isStatic = mode === 'static';
        // Install row: an uninstalled HA engine advertised with an "Install ↗" badge
        // that deep-links to the add-on store (the row is not selectable).
        const isInstall = !!x.install;
        const installBadge = isInstall
            ? `<span style="font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.4px; color:#fff; background: var(--accent); padding: 2px 8px; border-radius: 9px;">Install ↗</span>`
            : '';
        // Install-guide badge: same look as the install-row badge, but on a row
        // that STAYS selectable (self-hosted engine with no HA add-on to deep-link,
        // e.g. SearXNG). Anchor + stopPropagation so the row's select still works.
        const guide = x.installGuide
            ? `<a href="${this._esc(x.installGuide.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.4px; color:#fff; background: var(--accent); padding: 2px 8px; border-radius: 9px; text-decoration: none;">${this._esc(x.installGuide.label || 'Install ↗')}</a>`
            : '';
        // Collapsed (expand mode) always shows ▾ to click-to-open, even for a stale
        // install selection; the Install badge only shows in the expanded option list.
        const right = mode === 'expand'
            ? `<span style="color: var(--text-muted); font-size: 13px;">▾</span>`
            : (isInstall ? installBadge
                : (!isStatic && selected ? `<span style="color: var(--accent); font-weight: 700;">✓</span>` : ''));
        const config = (!isInstall && selected && x.configFields) ? this._config(x, getConfig) : '';
        // One-line note under a selected local engine (e.g. "local voices don't
        // change per personality"). Build plan §6.
        const note = (!isInstall && selected && x.note)
            ? `<div style="font-size: 11px; color: var(--text-muted); margin-top: 8px; line-height: 1.4;">${this._esc(x.note)}</div>`
            : '';
        const topBorder = isFirst ? '' : 'border-top: 1px solid var(--border, #e5e7eb);';
        const onclick = (isInstall && mode !== 'expand')
            ? `window.open('${x.install.url}', '_blank', 'noopener')`   // expanded list: deep-link to add-on store
            : (isStatic ? ''
                : (mode === 'expand'
                    ? `VoiceAiPage.toggleCard('${stageKey}')`           // collapsed: click to open the picker
                    : `VoiceAiPage.selectOption('${stageKey}', '${this._esc(x.id)}')`));
        const onclickAttr = onclick ? `onclick="${onclick}"` : '';

        return `
            <div ${onclickAttr}
                style="cursor: ${(isStatic && !isInstall) ? 'default' : 'pointer'}; padding: 12px 14px; ${topBorder} background: ${bg}; border-left: 3px solid ${(!isInstall && selected) ? color : 'transparent'};">
                <div style="display:flex; justify-content:space-between; align-items:baseline; gap: 10px;">
                    <div style="font-weight: 600; font-size: 14px; display:flex; align-items:center; gap: 8px; flex-wrap: wrap;">
                        ${this._esc(x.label)} ${localityTag} ${soon} ${guide}
                    </div>
                    <div style="display:flex; align-items:center; gap: 10px; flex-shrink: 0;">
                        ${x.keyed
                            ? `<span style="display:inline-flex; align-items:center; gap:5px; font-size: 11px; font-weight: 600; color: var(--text-muted);">${this._keyIcon()} API account</span>`
                            : `<span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--text-muted);">${this._esc(x.cost || '')}</span>`}
                        ${right}
                    </div>
                </div>
                ${x.description ? `<div style="font-size: 12px; color: var(--text-muted); margin-top: 3px;">${this._esc(x.description)}</div>` : ''}
                ${config}
                ${note}
            </div>`;
    },

    _config(x, getConfig) {
        const get = typeof getConfig === 'function' ? getConfig : () => '';
        const fields = x.configFields.map(f => {
            // URL fields with a `probe` kind get a Test button — server-side
            // reachability check via the add-on (browser can't hit LAN engines).
            const control = f.probe
                ? `<div style="display: flex; gap: 8px; align-items: center;">
                       ${this._field(f, get)}
                       <button class="btn btn-secondary btn-sm" style="flex-shrink: 0;"
                           onclick="event.stopPropagation(); VoiceAiPage.testLocalUrl('${f.key}', '${f.probe}', this)">Test</button>
                   </div>`
                : this._field(f, get);
            return `
            <label style="display:flex; flex-direction:column; gap: 3px; font-size: 11px; color: var(--text-muted);">
                ${this._esc(f.label)}
                ${control}
            </label>`;
        }).join('');
        // stopPropagation so editing a field doesn't trigger the row's select/collapse.
        return `<div onclick="event.stopPropagation()" style="margin-top: 10px; display: grid; gap: 8px;">${fields}</div>`;
    },

    /** A single config-field control. `type:'select'` (detection-populated voice
     *  dropdowns) renders a <select>; everything else is a free-text input. The
     *  current value is pre-selected; if it isn't among the options (stale/hand-
     *  entered), a leading "— pick —" keeps the field honest. */
    _field(f, get) {
        const cur = get(f.key) || '';
        const inputStyle = 'padding: 7px 9px; border: 1px solid var(--border, #d1d5db); border-radius: 5px; font-size: 13px;';
        if (f.type === 'select' && Array.isArray(f.options)) {
            const known = f.options.some(o => (o.value ?? o) === cur);
            const opts = [
                `<option value="" ${cur ? '' : 'selected'} disabled>— pick a voice —</option>`,
                ...f.options.map(o => {
                    const v = o.value ?? o, l = o.label ?? o;
                    return `<option value="${this._esc(v)}" ${v === cur ? 'selected' : ''}>${this._esc(l)}</option>`;
                }),
                (cur && !known) ? `<option value="${this._esc(cur)}" selected>${this._esc(cur)} (current)</option>` : '',
            ].join('');
            return `<select onchange="VoiceAiPage.saveLocalField('${f.key}', this.value)" style="${inputStyle}">${opts}</select>`;
        }
        // Credentials (API keys) render masked; everything else is plain text.
        // The id lets the Test button read a just-typed URL straight from the DOM.
        const inputType = f.type === 'password' ? 'password' : 'text';
        return `<input type="${inputType}" id="cfg-${this._esc(f.key)}" value="${this._esc(cur)}" placeholder="${this._esc(f.placeholder || '')}"
                    autocomplete="off" onchange="VoiceAiPage.saveLocalField('${f.key}', this.value)" style="${inputStyle} ${f.probe ? 'flex: 1;' : ''}">`;
    },
};

window.VoiceAiCards = VoiceAiCards;
