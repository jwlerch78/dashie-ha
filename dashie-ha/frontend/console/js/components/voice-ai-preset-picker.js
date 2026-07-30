/* ============================================================
   Voice & AI preset picker
   ------------------------------------------------------------
   The top-level selector on the Voice & AI page (Open Brain plan
   §6): Cloud · Hybrid · Local (Dashie Intelligence) + HA Voice
   Assist, as a card grid. Replaces the old voice.controlMethod
   dropdown; the choice persists to voice.pipelinePreset (plus a
   synced controlMethod for runtime/back-compat — see
   VoiceAiPage.selectPreset).

   Availability gating: Cloud & Hybrid require credits OR a BYO AI
   key. When neither, the card renders disabled with an inline
   "Add credits or API keys →" prompt (links) — never a silent
   fall-through to metered usage.

   Pure render. State + writes live in VoiceAiPage:
     VoiceAiPage.selectPreset(id)
   ============================================================ */

const VoiceAiPresetPicker = {
    _esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },

    /** @param {object} o { presets[], selectedId, available(id)→bool, isAddonMode, localMode } */
    render(o) {
        const cards = (o.presets || [])
            .map(p => this._card(p, p.id === o.selectedId, o.available(p.id), o.isAddonMode, !!o.localMode))
            .join('');
        return `
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(158px, 1fr)); gap: 10px; margin-bottom: 16px;">
                ${cards}
            </div>`;
    },

    _card(p, selected, available, isAddonMode, localMode) {
        const O = window.VoiceAiOptions;
        const costColor = p.needsCreditsOrKey ? O.COLOR.cloud : O.COLOR.local;
        // Mixed presets color each tagline half by its locality (Hybrid:
        // "Cloud AI" orange · "local voice" green); others use one color.
        const tagline = Array.isArray(p.taglineParts)
            ? p.taglineParts.map(t => `<span style="color: ${O.COLOR[t.locality] || costColor};">${this._esc(t.text)}</span>`).join(' · ')
            : `<span style="color: ${costColor};">${this._esc(p.tagline)}</span>`;
        const ring = selected
            ? `box-shadow: 0 0 0 2px var(--accent); border-color: var(--accent);`
            : '';
        const disabledStyle = available ? '' : 'opacity: 0.55;';
        // An unavailable Cloud/Hybrid card is CLICKABLE, not inert: the click tries the
        // one-time starter grant, and only falls through to the Credits page if there is
        // no grant to give (2026-07-29 — mirrors the tablet's blocked-preset tap). It is
        // still not a silent no-op — every outcome either activates the preset with a
        // disclosure or navigates somewhere useful, which is the rule this picker has
        // always followed. The card keeps its dimmed styling: until the grant lands the
        // preset genuinely isn't usable, and pretending otherwise would be the lie.
        const onclick = available
            ? `onclick="VoiceAiPage.selectPreset('${p.id}')"`
            : `onclick="VoiceAiPage.tryStarterGrant('${p.id}')"`;
        const check = selected ? `<span style="color: var(--accent); font-weight: 700;">✓</span>` : '';
        // Unavailable Cloud/Hybrid: explicit prompt with working links — the
        // links stay clickable even though the card itself is inert. Both Cloud
        // and Hybrid can run on credits OR a BYO AI key, so we surface both
        // options on either card (not addon-gated). margin-top:auto bottom-
        // justifies the prompt so it aligns across the equal-height cards.
        //
        // Local mode swaps the credits half for sign-in: there is no account to
        // hold credits, and the Credits page is not even routable, so offering
        // it would be a dead link. The AI-keys half is unchanged — a BYO key
        // works on the box with no account at all, which is the point.
        const prompt = available ? '' : (localMode ? `
            <div style="font-size: 11px; color: var(--text-muted, #777); margin-top: auto; padding-top: 8px; line-height: 1.4; opacity: 1;">
                <a href="#" onclick="event.preventDefault(); event.stopPropagation(); App.startSignIn()" style="color: var(--accent); font-weight: 600;">Sign in</a> or add your own <a href="#" onclick="event.preventDefault(); event.stopPropagation(); App.navigate('api-keys')" style="color: var(--accent); font-weight: 600;">AI key</a> →
            </div>` : `
            <div style="font-size: 11px; color: var(--status-error, #c00); margin-top: auto; padding-top: 8px; line-height: 1.4; opacity: 1;">
                Add <a href="#" onclick="event.preventDefault(); event.stopPropagation(); App.navigate('credits')" style="color: var(--accent); font-weight: 600;">credits</a> or <a href="#" onclick="event.preventDefault(); event.stopPropagation(); App.navigate('api-keys')" style="color: var(--accent); font-weight: 600;">AI keys</a> →
            </div>`);
        return `
            <div ${onclick}
                class="card"
                style="cursor: pointer; padding: 12px 14px; display: flex; flex-direction: column; ${ring} ${disabledStyle}">
                <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 8px;">
                    <div style="font-weight: 700; font-size: 14px;">${this._esc(p.label)}</div>
                    ${check}
                </div>
                <div style="font-size: 11px; font-weight: 600; margin-top: 2px;">${tagline}</div>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 6px; line-height: 1.45;">${this._esc(p.description)}</div>
                <div style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; color: var(--text-muted); margin-top: 8px;">${this._esc(p.cost)}</div>
                ${prompt}
            </div>`;
    },

    // ── preset-adjacent renders (pure; handlers live on VoiceAiPage) ──

    /** Compact "Customize pipeline" toggle row under the preset picker. The
     *  toggle reveals the granular TTS / STT / search-source cards (filtered by
     *  preset). Hidden while a Live model is selected — Live owns the pipeline. */
    renderCustomizeRow(customPipeline, show) {
        if (!show) return '';
        return `
            <div style="display:flex; justify-content:flex-end; align-items:center; gap: 8px; margin: 0 0 8px; color: var(--text-secondary); font-size: 13px;">
                <span>Customize pipeline</span>
                <label class="toggle">
                    <input type="checkbox" ${customPipeline ? 'checked' : ''}
                        onchange="VoiceAiPage.saveDefault('voice.customizePipeline', this.checked)">
                    <span class="toggle-slider"></span>
                </label>
            </div>`;
    },

    /** HA Voice Assist preset: no Dashie pickers — link out to HA's own Voice
     *  assistants page, where the pipeline (STT/agent/TTS) is configured. */
    renderHaAssistCard() {
        return `
            <div class="card" style="margin-bottom: 16px;"><div class="card-body">
                <div style="font-weight: 500; margin-bottom: 6px;">Voice is handled by Home Assistant</div>
                <div style="color: var(--text-secondary); font-size: var(--font-size-sm); line-height: 1.5; margin-bottom: 12px;">
                    ${BRAND.productName} hands the wake word's audio to your Home Assistant Assist pipeline —
                    speech-to-text, conversation agent, and voice are all configured in HA.
                </div>
                <a href="https://my.home-assistant.io/redirect/voice_assistants/" target="_blank" rel="noopener"
                   class="btn btn-secondary btn-sm">Configure in Home Assistant ↗</a>
            </div></div>`;
    },

    // (The Dialog toggle moved into the AI Tools & Settings section —
    //  VoiceAiPage._renderDialogRows — 2026-07-12.)

    /** Beta note shown instead of the Dialog rows while a Live model is
     *  selected (Live's dialog behavior is built into the model). */
    renderLiveNote() {
        return `
            <div style="margin: -8px 0 16px; font-size: 12px; color: var(--text-secondary); line-height: 1.5;">
                ⚡ Live (beta): one Gemini Live model handles speech, language &amp; search end-to-end.
                Speaks in a Google voice for now; billed per audio token (see usage). Android only.
            </div>`;
    },
};

window.VoiceAiPresetPicker = VoiceAiPresetPicker;
