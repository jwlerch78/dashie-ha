/* ============================================================
   Voice & AI — Test Chat subpage
   ------------------------------------------------------------
   Full-page subpage (not a modal). VoiceAiPage.render() defers
   to this module's render() when _open is truthy.

   Layout:
       [← Back to Voice & AI]
       [Personality ▾]  [Model ▾]
       [textarea                                ] [Send]
       ───── history (newest first) ─────────────────────
         User: …
         AI:   <voice in 18px>
               <text in 13px, muted>
               [action: 2 commands executed ✓]
               model · provider · 642 ms · 412 in / 38 out tokens

   State is per-session — history clears when the user navigates
   away or closes the page. Last-used personality + model persist
   to ConsoleState so reopening the chat keeps your selections.
   ============================================================ */

const VoiceAiChat = {
    /** null when closed; object when open. Shape:
     *  { personalityId, modelId, draft, busy, history, lastError } */
    _open: null,

    /** localStorage / ConsoleState keys for "remember last selection". */
    _STATE_KEY: 'voiceAiChat',

    /** TTS ("play voice out loud"): the list_voices catalog (lazy — [{key, id, provider}])
     *  and the current playback element so a new turn (or toggle-off) can stop the last one. */
    _voices: null,
    _audio: null,

    open() {
        const remembered = (typeof ConsoleState !== 'undefined' && ConsoleState._state?.[this._STATE_KEY]) || {};
        const defaults = VoiceAiPage._defaults || {};
        // Personality is per-device on the tablet, not per-account — there's
        // no account default. Fall back to "dashie" (the canonical built-in).
        const personalityId = remembered.personalityId || 'dashie';
        // Model: prefer remembered, then account default (ai.model on
        // user_settings), then the catalog's DEFAULT_AI_MODEL. Drop the
        // remembered value if it's not in the current catalog — happens
        // when a model gets renamed/removed upstream (e.g. the recent
        // ai-models-catalog refresh dropped 2.5-flash from the default
        // tier in favor of 3.1-flash-lite).
        const catalog = window.AiModelCatalog?.AI_MODEL_CATALOG || [];
        const known = id => catalog.some(m => m.id === id);
        const candidates = [
            remembered.modelId,
            defaults['ai.model'],
            window.AiModelCatalog?.DEFAULT_AI_MODEL,
            'gemini-3.1-flash-lite',
        ];
        const modelId = candidates.find(c => c && known(c)) || candidates.find(Boolean) || 'gemini-3.1-flash-lite';
        this._open = {
            personalityId,
            modelId,
            draft: '',
            busy: false,
            history: [],   // [{ role: 'user'|'ai', ...payload }]
            lastError: null,
            // "Play voice out loud" — off until the user opts in (credit-cost modal).
            speak: remembered.speak === true,
        };
        App.renderPage();
    },

    close() {
        this._stopAudio();
        this._open = null;
        App.renderPage();
    },

    setPersonality(id) {
        if (!this._open) return;
        this._open.personalityId = id;
        this._remember();
        App.renderPage();
    },

    setModel(id) {
        if (!this._open) return;
        this._open.modelId = id;
        this._remember();
        App.renderPage();
    },

    setDraft(value) {
        if (!this._open) return;
        // Don't re-render on keystroke; just capture the value for the
        // next send. The textarea's defaultValue keeps what the user typed.
        this._open.draft = value;
    },

    _remember() {
        if (!this._open) return;
        if (typeof ConsoleState === 'undefined') return;
        ConsoleState._normalize?.();
        ConsoleState._state[this._STATE_KEY] = {
            personalityId: this._open.personalityId || null,
            modelId: this._open.modelId || null,
            speak: this._open.speak === true,
        };
        ConsoleState._save?.({ [this._STATE_KEY]: ConsoleState._state[this._STATE_KEY] });
    },

    onKeyDown(e) {
        // Cmd/Ctrl+Enter sends.
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            this.send();
        }
    },

    async send() {
        if (!this._open || this._open.busy) return;
        const ta = document.getElementById('voice-ai-chat-input');
        const text = (ta?.value || this._open.draft || '').trim();
        if (!text) return;

        const turnId = Date.now();
        const pendingId = turnId + 1;
        this._open.busy = true;
        this._open.lastError = null;
        this._open.history.unshift({ id: turnId, role: 'user', text });
        this._open.history.unshift({ id: pendingId, role: 'pending', stage: 'Calling AI…', stages: [] });
        this._open.draft = '';
        if (ta) ta.value = '';
        App.renderPage();
        setTimeout(() => document.getElementById('voice-ai-chat-input')?.focus(), 0);

        const onStage = (name, detail) => {
            if (!this._open) return;
            const pending = this._open.history.find(h => h.id === pendingId);
            if (!pending) return;
            // Mirror the tablet's voice-overlay__thinking-text — always
            // "Thinking…" while we work. We still record the stage names
            // internally so the final turn can break down the timings.
            pending.stage = 'Thinking…';
            pending.stages.push({ name, t: Date.now(), detail });
            App.renderPage();
        };

        let result;
        try {
            const prior = this._open.history
                .filter(h => h.role === 'user' || h.role === 'ai')
                .slice()
                .reverse()
                .map(h => h.role === 'user'
                    ? { role: 'user', content: h.text }
                    : { role: 'ai', content: h.voice || h.text || '' });
            result = await ConsoleAiClient.sendQuery(text, {
                personalityId: this._open.personalityId,
                modelId: this._open.modelId,
                history: prior,
                onStage,
            });
        } catch (e) {
            result = { ok: false, error: e?.message || String(e) };
        }

        if (!this._open) return;
        this._open.history = this._open.history.filter(h => h.id !== pendingId);
        if (result?.ok) {
            this._open.history.unshift({ id: pendingId, role: 'ai', ...result });
            // Speak it if the user turned voice on (they consented to the credit cost).
            if (this._open.speak && result.voice) this._speak(result.voice);
        } else {
            this._open.history.unshift({ id: pendingId, role: 'ai-error', error: result?.error || 'Unknown error', latency_ms: result?.latency_ms, stages: result?.stages });
            this._open.lastError = result?.error || null;
        }
        this._open.busy = false;
        App.renderPage();
    },

    async clearHistory() {
        if (!this._open) return;
        const ok = await ConfirmModal.confirm({
            title: 'Clear chat history?',
            message: 'This removes the conversation from this session. The Settings tab is unaffected.',
            confirmLabel: 'Clear history',
            danger: true,
        });
        if (!ok) return;
        this._open.history = [];
        App.renderPage();
    },

    // ── Play voice out loud (TTS) ─────────────────────────────

    /** Header toggle. Turning ON asks for confirmation (TTS is billed per response);
     *  turning OFF just stops any playback. Persisted per-browser via _remember. */
    async toggleSpeak() {
        if (!this._open) return;
        if (!this._open.speak) {
            const ok = await ConfirmModal.confirm({
                title: 'Play voice out loud?',
                message: `Each reply will be spoken in the selected personality’s voice using ${BRAND.cloudName} text-to-speech — which uses your credits (billed per character, same as the tablet). Turn it off any time.`,
                confirmLabel: 'Turn on voice',
                cancelLabel: 'Cancel',
            });
            if (!ok) return;
            this._open.speak = true;
        } else {
            this._stopAudio();
            this._open.speak = false;
        }
        this._remember();
        App.renderPage();
    },

    /** Replay a past AI turn's voice (only offered while speak is on — the user already
     *  consented to the credit cost). */
    replay(id) {
        const h = this._open?.history.find(x => String(x.id) === String(id));
        if (h?.voice) this._speak(h.voice);
    },

    _stopAudio() {
        if (this._audio) {
            try { this._audio.pause(); } catch { /* ignore */ }
            this._audio = null;
        }
    },

    /** Resolve which Dashie Cloud TTS endpoint + voice to use for the current personality —
     *  mirrors the brain's resolveVoice priority (fixed personality voice → account
     *  defaultVoiceKey → personality's preferred voice), then maps the voice KEY to its
     *  provider + provider_voice_id via the list_voices catalog. voice_id '' → the edge
     *  function's own default voice. */
    async _resolveTtsTarget() {
        if (this._voices === null) {
            try { this._voices = await VoiceAiApi.listVoices(); } catch { this._voices = []; }
        }
        const voices = this._voices || [];
        const pid = this._open.personalityId;
        const p = (VoiceAiPage._custom || []).find(x => x.id === pid)
            || (VoiceAiPage._templates || []).find(t => (t.key || t.id) === pid);
        const acctDefault = VoiceAiPage._defaults?.['ai.defaultVoiceKey'] || '';
        const key = (p?.voice_mode === 'fixed' && p.voice) ? p.voice : (acctDefault || p?.voice || '');
        const row = voices.find(v => v.key === key) || null;
        const provider = row?.provider || 'elevenlabs';
        const fn = provider === 'inworld' ? 'inworld-tts' : 'elevenlabs-tts';
        return { url: `${DashieAuth.config.url}/functions/v1/${fn}`, voiceId: row?.id || '' };
    },

    /** Synthesize `text` via Dashie Cloud TTS and play it in the browser. Best-effort:
     *  a failure warns to the console and leaves the chat unchanged (never blocks). */
    async _speak(text) {
        if (!text || !this._open) return;
        this._stopAudio();
        try {
            const { url, voiceId } = await this._resolveTtsTarget();
            const resp = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': DashieAuth.anonKey,
                    'Authorization': `Bearer ${DashieAuth.jwt || DashieAuth.anonKey}`,
                },
                body: JSON.stringify(voiceId ? { text, voice_id: voiceId } : { text }),
            });
            if (!resp.ok) { console.warn('[VoiceAiChat] TTS failed:', resp.status); return; }
            const buf = await resp.arrayBuffer();
            const blob = new Blob([buf], { type: resp.headers.get('Content-Type') || 'audio/mpeg' });
            const audioUrl = URL.createObjectURL(blob);
            this._audio = new Audio(audioUrl);
            this._audio.onended = () => URL.revokeObjectURL(audioUrl);
            await this._audio.play();
            // TTS decremented the balance — refresh the sidebar credits widget.
            window.CreditsService?.fetch?.({ force: true });
        } catch (e) {
            console.warn('[VoiceAiChat] speak failed:', e?.message || e);
        }
    },

    /** Format a millisecond duration as seconds at hundredths — e.g. 3777 → "3.78 s". */
    _fmtSeconds(ms) {
        if (ms == null || !isFinite(ms)) return '—';
        return (ms / 1000).toFixed(2) + ' s';
    },

    // ── Render ───────────────────────────────────────────────

    render() {
        const m = this._open;
        if (!m) return '';
        const esc = VoiceAiPage._escape.bind(VoiceAiPage);
        const selectStyle = `padding: 6px 10px; border: 1px solid var(--border, #d1d5db); border-radius: 4px; background: var(--bg-card, #fff); font-size: 13px;`;

        // Personalities: use the same source the parent page renders.
        // Custom rows (UUID) come first, then built-in templates by key.
        const customPersonalities = VoiceAiPage._custom || [];
        const templatePersonalities = VoiceAiPage._templates || [];
        const personalityHtml = (() => {
            const opt = (val, label) => `<option value="${esc(val)}" ${m.personalityId === val ? 'selected' : ''}>${esc(label)}</option>`;
            const groups = [];
            if (customPersonalities.length) {
                groups.push(`<optgroup label="Custom">${customPersonalities.map(p => opt(p.id, p.name)).join('')}</optgroup>`);
            }
            if (templatePersonalities.length) {
                groups.push(`<optgroup label="Built-in">${templatePersonalities.map(t => opt(t.key || t.id, t.name)).join('')}</optgroup>`);
            }
            if (!groups.length) groups.push(opt('dashie', `${BRAND.assistantName} (default)`));
            return `<select id="voice-ai-chat-personality" onchange="VoiceAiChat.setPersonality(this.value)" style="${selectStyle}">${groups.join('')}</select>`;
        })();

        // Models: the same provider-grouped catalog the AI Defaults section
        // uses. Falls back to a single safe default if VoiceAiPage hasn't
        // initialised yet.
        const modelGroups = VoiceAiPage.MODEL_GROUPS || [['Claude', [['claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5']]]];
        // "My Local LLM" routes to the on-prem add-on brain (/api/voice/converse-local),
        // which can reach the LAN model — the cloud brain can't. So only offer it when the
        // console is running inside the HA add-on.
        const allGroups = (typeof DashieAuth !== 'undefined' && DashieAuth.isAddonMode)
            ? [...modelGroups, ['Local', [['local', 'My Local LLM']]]]
            : modelGroups;
        const modelHtml = (() => {
            const opt = (val, label) => `<option value="${esc(val)}" ${m.modelId === val ? 'selected' : ''}>${esc(label)}</option>`;
            const groups = allGroups.map(([groupLabel, items]) =>
                `<optgroup label="${esc(groupLabel)}">${items.map(([v, l]) => opt(v, l)).join('')}</optgroup>`);
            return `<select id="voice-ai-chat-model" onchange="VoiceAiChat.setModel(this.value)" style="${selectStyle}">${groups.join('')}</select>`;
        })();

        const sendBusy = m.busy;
        const sendLabel = sendBusy ? 'Thinking…' : 'Send (⌘⏎)';

        return `
            <style>
                @keyframes voiceAiChatPulse {
                    0%, 100% { opacity: 0.3; transform: scale(0.8); }
                    50%      { opacity: 1;   transform: scale(1.2); }
                }
            </style>
            <div style="max-width: 760px;">
                ${m.history.length ? `
                    <div style="display: flex; justify-content: flex-end; margin-bottom: 8px;">
                        <button class="btn btn-ghost btn-sm" onclick="VoiceAiChat.clearHistory()">Clear history</button>
                    </div>` : ''}

                <div style="display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-bottom: 12px;">
                    <label style="display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-muted);">
                        Personality
                        ${personalityHtml}
                    </label>
                    <label style="display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-muted);">
                        Model
                        ${modelHtml}
                    </label>
                    <button class="btn ${m.speak ? 'btn-primary' : 'btn-secondary'} btn-sm"
                        onclick="VoiceAiChat.toggleSpeak()"
                        title="Speak each reply in the personality's voice (${BRAND.cloudName} TTS — uses credits)">
                        ${m.speak ? '🔊 Voice on' : '🔈 Play voice out loud'}
                    </button>
                </div>

                <div style="display: flex; gap: 8px; align-items: flex-end; margin-bottom: 24px;">
                    <textarea id="voice-ai-chat-input"
                        placeholder="Type command here…"
                        oninput="VoiceAiChat.setDraft(this.value)"
                        onkeydown="VoiceAiChat.onKeyDown(event)"
                        ${sendBusy ? 'disabled' : ''}
                        rows="3"
                        style="flex: 1; padding: 10px 12px; border: 1px solid var(--border, #d1d5db); border-radius: 6px; font-family: inherit; font-size: 14px; resize: vertical; min-height: 60px;">${esc(m.draft || '')}</textarea>
                    <button class="btn btn-primary"
                        onclick="VoiceAiChat.send()"
                        ${sendBusy ? 'disabled' : ''}
                        style="padding: 10px 18px; min-width: 110px;">
                        ${sendLabel}
                    </button>
                </div>

                ${m.lastError ? `
                    <div style="margin-bottom: 16px; padding: 8px 12px; border-left: 3px solid var(--status-error, #c00); background: #fff5f5; color: #831818; font-size: 13px;">
                        ${esc(m.lastError)}
                    </div>` : ''}

                <div>
                    ${m.history.length === 0
                        ? `<p style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 40px 0;">
                               No turns yet. Type a query above to start. ⌘⏎ to send.
                           </p>`
                        : this._renderPairedHistory(m.history)}
                </div>
            </div>
        `;
    },

    /** Walk reverse-chrono history and pair each AI entry with its preceding
     *  user message into a single dark card (the same way the tablet's
     *  sidebar voice-overlay groups one turn together). History layout:
     *      [ ai_response(turn=N+1), user_msg(turn=N), ai_response(turn=N-1), … ]
     *  We pair (history[i], history[i+1]) when ids align (ai.id === user.id+1).
     */
    _renderPairedHistory(history) {
        const out = [];
        let i = 0;
        while (i < history.length) {
            const cur = history[i];
            const nxt = history[i + 1];
            const pairedUser = (nxt?.role === 'user' && nxt.id === cur.id - 1) ? nxt : null;
            if (cur.role === 'ai' || cur.role === 'pending' || cur.role === 'ai-error') {
                out.push(this._renderTurn(cur, pairedUser));
                i += pairedUser ? 2 : 1;
            } else if (cur.role === 'user') {
                // user with no AI yet — shouldn't happen since send() always
                // inserts the pending marker before yielding, but render anyway.
                out.push(this._renderTurn(null, cur));
                i += 1;
            } else {
                i += 1;
            }
        }
        return out.join('');
    },

    _renderUserPill(user) {
        if (!user) return '';
        const esc = VoiceAiPage._escape.bind(VoiceAiPage);
        return `
            <div style="background: rgba(255, 255, 255, 0.95); color: #000; border-radius: 6px; padding: 10px 14px; font-size: 15px; line-height: 1.35; margin-bottom: 14px;">
                ${esc(user.text)}
            </div>`;
    },

    /** Render a single turn (AI + paired user message in the same dark card). */
    _renderTurn(h, user) {
        const esc = VoiceAiPage._escape.bind(VoiceAiPage);

        if (!h && user) {
            // User-only (no reply yet) — shouldn't normally show.
            return `
                <div style="margin-bottom: 24px; padding: 18px 22px; background: #0f0f10; border-radius: 10px; color: #fff;">
                    ${this._renderUserPill(user)}
                </div>`;
        }

        if (h.role === 'pending') {
            return `
                <div style="margin-bottom: 24px; padding: 18px 22px; background: #0f0f10; border-radius: 10px;">
                    ${this._renderUserPill(user)}
                    <div style="display: flex; align-items: center; gap: 14px; min-height: 40px;">
                        <span style="display: inline-flex; gap: 6px;">
                            <span class="voice-ai-chat-dot" style="width: 9px; height: 9px; border-radius: 50%; background: #ff6b1a; animation: voiceAiChatPulse 1.4s ease-in-out infinite;"></span>
                            <span class="voice-ai-chat-dot" style="width: 9px; height: 9px; border-radius: 50%; background: #ff6b1a; animation: voiceAiChatPulse 1.4s ease-in-out 0.2s infinite;"></span>
                            <span class="voice-ai-chat-dot" style="width: 9px; height: 9px; border-radius: 50%; background: #ff6b1a; animation: voiceAiChatPulse 1.4s ease-in-out 0.4s infinite;"></span>
                        </span>
                        <span style="font-size: 14px; color: rgba(220, 220, 220, 0.9);">${esc(h.stage || 'Thinking…')}</span>
                    </div>
                </div>`;
        }

        if (h.role === 'ai-error') {
            return `
                <div style="margin-bottom: 24px; padding: 18px 22px; background: #0f0f10; border-left: 3px solid #f87171; border-radius: 0 10px 10px 0;">
                    ${this._renderUserPill(user)}
                    <div style="font-size: 11px; font-weight: 600; color: #f87171; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">Error</div>
                    <div style="font-size: 14px; color: #fca5a5;">${esc(h.error || 'Unknown error')}</div>
                    ${h.latency_ms ? `<div style="font-size: 11px; color: rgba(255,255,255,0.5); margin-top: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;">${this._fmtSeconds(h.latency_ms)} before failure</div>` : ''}
                </div>`;
        }

        // ai turn
        const usage = h.usage || {};

        // Model + provider line — top of the metadata, no tokens here.
        const headerBits = [];
        if (h.model === 'nlp') {
            headerBits.push('NLP');
            headerBits.push(h.nlp_confidence ? (h.nlp_confidence * 100).toFixed(0) + '%' : 'matched');
        } else {
            if (h.model) headerBits.push(esc(h.model));
            if (h.provider && h.provider !== h.model) headerBits.push(esc(h.provider));
        }

        // Timing line: "<total> - pass(1) X · sports Y · pass(2) Z · overhead W".
        // Map EVERY brain stage (unknown names fall through to a generic label so
        // new tools — sports/weather/places/calendar — never silently vanish the
        // way fetch_sports used to), then add an "overhead" remainder for the time
        // not inside any reported stage (network round-trip to the edge fn + the
        // entity prefetch) so the parts add up to the end-to-end total.
        const STAGE_LABEL = {
            pass1: 'pass(1)', pass2: 'pass(2)', fetch_search: 'search',
            fetch_sports: 'sports', fetch_weather: 'weather', fetch_entities: 'entities',
            nlp_intercept: 'HA Assist', noise_shortcircuit: 'noise',
        };
        const stageBits = [];
        let stageSum = 0;
        for (const s of (h.stages || [])) {
            if (typeof s.latency_ms === 'number') stageSum += s.latency_ms;
            const label = STAGE_LABEL[s.name] || s.name;
            const extra = s.entity_count != null ? ` (${s.entity_count})`
                : s.result_count != null ? ` (${s.result_count})` : '';
            stageBits.push(`${label} ${this._fmtSeconds(s.latency_ms)}${extra}`);
        }
        // Everything that took time but isn't a reported stage (network + prefetch).
        // Show only when meaningful so the breakdown reconciles to the total.
        if (h.total_latency_ms != null && stageBits.length > 0) {
            const overhead = h.total_latency_ms - stageSum;
            if (overhead > 50) stageBits.push(`overhead ${this._fmtSeconds(overhead)}`);
        }
        const total = h.total_latency_ms != null ? this._fmtSeconds(h.total_latency_ms) : null;
        const timingLine = (total || stageBits.length > 0)
            ? `${total || ''}${total && stageBits.length ? ' - ' : ''}${stageBits.join(' · ')}`
            : '';

        // Cost line: "$total - X in ($input) / Y out ($output)"
        const cost = h.model && window.ConsoleAiClient
            ? ConsoleAiClient.estimateCost(h.model, usage.input_tokens, usage.output_tokens)
            : null;
        const costLine = (cost?.known && (usage.input_tokens || usage.output_tokens))
            ? `${this._fmtCost(cost.total)} - ${usage.input_tokens || 0} in (${this._fmtCost(cost.input)}) / ${usage.output_tokens || 0} out (${this._fmtCost(cost.output)})`
            : '';

        const parsedWarning = h.parsed_ok === false
            ? `<div style="font-size: 12px; color: #fbbf24; margin-top: 8px;">⚠ Model didn't return valid JSON — showing raw output</div>`
            : '';

        const action = h.action ? this._renderAction(h) : '';

        const monoStyle = 'font-size: 11px; color: rgba(255, 255, 255, 0.55); font-family: ui-monospace, SFMono-Regular, Menlo, monospace;';

        return `
            <div style="margin-bottom: 24px; padding: 18px 22px; background: #0f0f10; border-radius: 10px; color: #fff;">
                ${this._renderUserPill(user)}
                <div style="font-size: 28px; line-height: 1.3; font-weight: 700; color: #fff; white-space: pre-wrap; margin-bottom: ${h.text ? '14px' : '0'};">${esc(h.voice || '')}</div>
                ${this._open?.speak && h.voice ? `<button class="btn btn-sm" onclick="VoiceAiChat.replay('${h.id}')" title="Replay in the personality's voice (uses credits)" style="margin-bottom: 12px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: #fff;">🔊 Replay</button>` : ''}
                ${h.text ? `<div style="font-size: 14px; line-height: 1.5; color: rgba(255, 255, 255, 0.72); white-space: pre-wrap;">${esc(h.text)}</div>` : ''}
                ${action}
                ${parsedWarning}
                <div style="margin-top: 14px; padding-top: 10px; border-top: 1px solid rgba(255, 255, 255, 0.1); display: flex; flex-direction: column; gap: 3px;">
                    ${headerBits.length ? `<div style="${monoStyle}">${headerBits.join('  ·  ')}</div>` : ''}
                    ${timingLine ? `<div style="${monoStyle}">${timingLine}</div>` : ''}
                    ${costLine ? `<div style="${monoStyle}">${costLine}</div>` : ''}
                </div>
            </div>
        `;
    },

    /** Format a USD amount. Uses 4 decimals when small, 2 when not (so we
     *  always show meaningful precision per turn). */
    _fmtCost(amount) {
        if (amount == null || !isFinite(amount)) return '$0.00';
        if (amount === 0) return '$0.00';
        if (amount < 0.01) return '$' + amount.toFixed(4);
        return '$' + amount.toFixed(2);
    },

    _renderAction(h) {
        const esc = VoiceAiPage._escape.bind(VoiceAiPage);
        const a = h.action;
        const r = h.action_result;
        const lines = [];
        lines.push(`<div style="font-size: 11px; font-weight: 600; color: rgba(255, 255, 255, 0.5); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 16px;">Action</div>`);

        if (a.command === 'execute_commands') {
            const cmds = Array.isArray(a.parameters?.commands) ? a.parameters.commands : [];
            const rows = cmds.map((c, i) => {
                const result = r?.results?.[i];
                const status = !r || !r.dispatched ? '·'
                    : result?.ok ? '✓'
                    : '✗';
                const color = result?.ok ? '#34d399' : (result === undefined ? 'rgba(255,255,255,0.5)' : '#f87171');
                const errLine = result?.error
                    ? `<div style="font-size: 11px; color: #f87171; margin-left: 18px;">${esc(result.error)}</div>` : '';
                return `
                    <div style="font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin-top: 6px; color: rgba(255, 255, 255, 0.85);">
                        <span style="color: ${color}; font-weight: 700; display: inline-block; width: 14px;">${status}</span>
                        ${esc(`${c.domain || ''}.${c.service || ''}`)}
                        ${c.data?.entity_id ? `<span style="color: rgba(255, 255, 255, 0.45);"> → ${esc(c.data.entity_id)}</span>` : ''}
                        ${errLine}
                    </div>`;
            }).join('');
            lines.push(`<div style="margin-top: 4px;">${rows}</div>`);
        } else if (a.command === 'forward_to_assist') {
            const speech = r?.response?.response?.speech?.plain?.speech || '';
            lines.push(`<div style="font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin-top: 6px; color: rgba(255, 255, 255, 0.7);">→ HA Assist: ${esc(a.parameters?.transcript || '')}</div>`);
            if (speech) lines.push(`<div style="font-size: 12px; margin-top: 4px; color: rgba(255, 255, 255, 0.7);">↩ ${esc(speech)}</div>`);
            if (r?.error) lines.push(`<div style="font-size: 11px; color: #f87171; margin-top: 4px;">${esc(r.error)}</div>`);
        } else {
            lines.push(`<pre style="font-size: 11px; background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.85); padding: 8px; border-radius: 4px; overflow-x: auto; margin: 6px 0 0;">${esc(JSON.stringify(a, null, 2))}</pre>`);
            if (r?.reason) lines.push(`<div style="font-size: 11px; color: rgba(255,255,255,0.5); margin-top: 4px;">${esc(r.reason)}</div>`);
        }

        return lines.join('');
    },
};

window.VoiceAiChat = VoiceAiChat;
