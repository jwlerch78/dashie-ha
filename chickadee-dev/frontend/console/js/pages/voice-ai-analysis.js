/* ============================================================
   Voice & AI — History subpage (recent voice interactions)
   ------------------------------------------------------------
   A transcript-forward view of recent voice interactions:

       [Save conversation details  (toggle)]   [Clear history]

       ── Recent interactions (newest first) ──
       ▸ 12:59 PM   COMPLEX · 1.4s · 12.7K tokens
            YOU SAID     what was the score…
            DASHIE SAID  Mexico beat South Korea 1–0.
            (subtext, if any)
            ── steps (expanded) ──
              PLAN/AI   gemini-2.5-flash · 1,060 in / 91 out · 0.3s
              SEARCH    tavily (9 results) · 0.8s
              AI        gemini-2.5-flash · 11,571 in / 86 out · 0.6s

   Source: get_intelligence_log (Supabase) + HA-local transcripts
   (add-on mode) merged by session_id. Toggle writes
   ai.retainTranscripts; Clear history nulls the stored text.
   Build plan §17.
   ============================================================ */

const VoiceAiAnalysis = {
    _loading: false,
    _loaded: false,
    _error: null,
    _interactions: [],
    _retain: false,
    // "Share to improve Dashie" consent (user_settings.share_for_improvement column,
    // beta cohort). Layers on _retain; enabling runs a ConfirmModal consent pop-up.
    _share: false,
    _shareBusy: false,
    _clearing: false,
    _expanded: new Set(),
    _expandedDays: new Set(),    // 'YYYY-MM-DD' day groups that are open
    _expandedMonths: new Set(),  // 'YYYY-MM' prior-month groups that are open
    // Voice feedback UI state, keyed by interaction key (cascade) or
    // `${key}::${turnIndex}` (realtime turn): { rating, submitting, done }.
    _feedback: {},

    render() {
        if (!this._loaded && !this._loading && !this._error) {
            this.load();
            return this._wrap(this._renderLoading());
        }
        if (this._loading && !this._loaded) return this._wrap(this._renderLoading());
        if (this._error && !this._loaded) return this._wrap(this._renderError());
        return this._wrap(this._renderMain());
    },

    async load() {
        this._loading = true;
        this._error = null;
        try {
            // retain comes from get_intelligence_log itself (the authoritative
            // user_settings.retain_transcripts column) — NOT the clobberable
            // settings blob, which the tablet resets. See _TECHNICAL_DEBT.md.
            const log = await DashieAuth.dbRequest('get_intelligence_log', { limit: 500, tz: this._tz() });
            const interactions = log?.interactions || [];
            await this._mergeLocalTranscripts(interactions);
            this._interactions = interactions;
            this._retain = log?.retain === true;
            this._share = log?.share_for_improvement === true;
            this._loaded = true;
            // Default: current-month day rows visible, newest day expanded so the
            // most recent interactions show without a click (interactions are
            // newest-first from the handler).
            const newest = interactions.length ? this._localDate(interactions[0].ts) : null;
            this._expandedDays = new Set(newest ? [newest] : []);
            this._expandedMonths = new Set();
        } catch (e) {
            console.error('[VoiceAiAnalysis] load failed', e);
            this._error = e?.message || String(e);
        } finally {
            this._loading = false;
            App.renderPage();
        }
    },

    refresh() { this._loaded = false; this._interactions = []; return this.load(); },

    // ── actions ──────────────────────────────────────────────

    async toggleRetain(enabled) {
        const prev = this._retain;
        this._retain = enabled;
        App.renderPage();
        try {
            // Write the authoritative column (not the blob) so a tablet full-blob
            // write can't reset it. See _TECHNICAL_DEBT.md (Option C).
            await DashieAuth.dbRequest('set_retain_transcripts', { enabled });
            // Sharing layers on keep-history: turning history OFF also revokes
            // improvement sharing (consent can't outlive the data it covers).
            if (!enabled && this._share) {
                this._share = false;
                DashieAuth.dbRequest('set_share_for_improvement', { enabled: false }).catch(() => {});
            }
            this.refresh();  // reload so the interaction list reflects the new state
        } catch (e) {
            this._retain = prev;
            Toast.error(`Couldn't update setting: ${e.message}`);
            App.renderPage();
        }
    },

    /** "Share to improve Dashie" (beta cohort). Enabling requires an explicit
     *  consent confirmation (pop-up with the full details + policy link);
     *  disabling is immediate — revoke = stop + remove past conversations
     *  from the improvement corpus (enforced server-side at query time). */
    async toggleShare(enabled) {
        if (this._shareBusy || !this._retain) { App.renderPage(); return; }
        if (enabled) {
            const ok = await ConfirmModal.confirm({
                title: `Share conversations to improve ${BRAND.productName}`,
                messageHtml: `
                    <p style="margin: 0 0 10px;">When on, your saved conversations — what you said, how
                    ${BRAND.assistantName} answered, and which tools it used — may be reviewed by ${BRAND.teamName} to
                    improve ${BRAND.productName}’s voice AI.</p>
                    <ul style="margin: 0 0 10px; padding-left: 18px;">
                        <li>Calendar conversations are never shared.</li>
                        <li>Turn this off any time to stop sharing and remove your past conversations
                        from the improvement program.</li>
                    </ul>
                    <p style="margin: 0;"><a href="${BRAND.urls.privacy}" target="_blank"
                    rel="noopener">Privacy Policy ↗</a></p>`,
                confirmLabel: 'Turn on sharing',
            });
            if (!ok) { App.renderPage(); return; }   // re-render resets the checkbox
        }
        const prev = this._share;
        this._share = enabled;
        this._shareBusy = true;
        App.renderPage();
        try {
            await DashieAuth.dbRequest('set_share_for_improvement', { enabled });
            if (!enabled) Toast.success('Sharing stopped — your conversations are out of the improvement program.');
        } catch (e) {
            this._share = prev;
            Toast.error(`Couldn't update setting: ${e.message}`);
        } finally {
            this._shareBusy = false;
            App.renderPage();
        }
    },

    async clearHistory() {
        const ok = await ConfirmModal.confirm({
            title: 'Clear conversation history',
            message: 'This permanently deletes the saved text of your past interactions (what you said and the replies). Usage and credit history are unaffected.',
            confirmLabel: 'Clear',
            danger: true,
        });
        if (!ok) return;
        this._clearing = true;
        App.renderPage();
        try {
            await DashieAuth.dbRequest('clear_transcript_history', {});
            // HA kiosks keep transcripts locally — clear those too in add-on mode.
            if (typeof DashieAuth !== 'undefined' && DashieAuth.isAddonMode) {
                try { await fetch(DashieAuth._addonUrl('/api/transcripts'), { method: 'DELETE' }); } catch (e) { /* best-effort */ }
            }
            Toast.info('Conversation history cleared');
            this._clearing = false;
            this.refresh();
        } catch (e) {
            this._clearing = false;
            Toast.error(`Clear failed: ${e.message}`);
            App.renderPage();
        }
    },

    toggleInteraction(key) {
        if (this._expanded.has(key)) this._expanded.delete(key);
        else this._expanded.add(key);
        App.renderPage();
    },

    /** In add-on mode, overlay HA-local transcript text (kiosk turns keep words
     *  on the HA box, not Supabase) onto interactions by session_id.
     *
     *  A DIALOG shares ONE session_id across every turn, so this must key a session to a LIST.
     *  It used to do `bySession.set(t.session_id, t)` — last-write-wins — which collapsed an
     *  N-turn conversation to a single exchange and then only ever populated the SESSION-level
     *  prompt/response, never `intr.turns[i]`. So a multi-turn dialog could never render its
     *  conversation from HA-local text even though every turn was on disk (John, 2026-07-16:
     *  138 stored transcripts, 17 sessions with >1 turn, all showing 1). */
    async _mergeLocalTranscripts(interactions) {
        if (typeof DashieAuth === 'undefined' || !DashieAuth.isAddonMode || !interactions.length) return;
        if (interactions.every(i => i.prompt || i.response)) return;
        try {
            const data = await fetch(DashieAuth._addonUrl('/api/transcripts?limit=500'))
                .then(r => r.ok ? r.json() : null);
            const rows = data?.transcripts || [];
            if (!rows.length) return;
            // session_id → every turn of that dialog. The store returns newest-first; reverse to
            // chronological so index i lines up with turn i.
            const bySession = new Map();
            for (const t of rows) {
                if (!t.session_id) continue;
                const list = bySession.get(t.session_id);
                if (list) list.push(t); else bySession.set(t.session_id, [t]);
            }
            for (const list of bySession.values()) list.reverse();
            for (const intr of interactions) {
                if (intr.realtime) continue;
                const list = intr.session_id && bySession.get(intr.session_id);
                if (!list || !list.length) continue;
                const turns = Array.isArray(intr.turns) ? intr.turns : null;
                if (turns && turns.length === list.length) {
                    // Per-turn overlay — ONLY when the counts line up. A mismatch would slide every
                    // later turn onto the wrong utterance, and a confidently mislabelled transcript
                    // is worse than an absent one.
                    turns.forEach((t, i) => {
                        if (t.prompt || t.response) return;
                        t.prompt = list[i].text || null;
                        t.response = list[i].voice || null;
                        t.subtext = list[i].subtext || null;
                    });
                } else if (list.length > 1 && (!turns || !turns.length)) {
                    // SYNTHESIZE the dialog from the HA-local transcripts.
                    // The server's turns[] (DLG-3, analysis.ts) is derived from TEXT-BEARING
                    // ai_interactions rows — and a caller-mode session has none BY DEFINITION
                    // (retain_mode='caller' ⇒ the brain persists no text; §17). So the server
                    // omits turns[] for exactly the sessions that need it most, and the console
                    // is the ONLY place that holds both halves: the Supabase row AND the HA-local
                    // text. Build the thread here so a local-model dialog renders in full.
                    // (Counts can't be compared here either: one user turn logs several rows —
                    // pass-1 + the sports template — so rows ≠ utterances. The transcripts are
                    // the authoritative per-utterance record.)
                    intr.turns = list.map((t) => ({
                        ts: t.ts,
                        prompt: t.text || null,
                        response: t.voice || null,
                        subtext: t.subtext || null,
                        latency_ms: 0,   // per-turn latency lives on the Supabase rows, not the store
                    }));
                }
                if (!intr.prompt && !intr.response) {
                    intr.prompt = list[0].text || null;
                    intr.response = list[0].voice || null;
                    intr.subtext = list[0].subtext || null;
                }
            }
        } catch (e) { /* best-effort */ }
    },

    // ── render ───────────────────────────────────────────────

    _wrap(inner) {
        return `<div style="max-width: 760px;">${this._renderHeader()}${inner}</div>`;
    },

    /** ⓘ hover/focus tooltip (css .info-tip). Details live here instead of subtext. */
    _infoTip(text) {
        return `<span class="info-tip" tabindex="0" data-tip="${this._escape(text)}">i</span>`;
    },

    _renderHeader() {
        const on = this._retain;
        const retainTip = `When on, ${BRAND.assistantName} keeps what you said and how it answered so you can review them here. `
            + 'Cloud accounts store this securely; Home Assistant kiosks keep it on your own HA box.';
        const shareTip = `Off by default. When on, your saved conversations — what you said, how ${BRAND.assistantName} answered, `
            + `and which tools it used — may be reviewed by ${BRAND.teamName} to improve ${BRAND.productName}’s voice AI. `
            + 'Calendar conversations are never shared. Turn this off any time to stop sharing and remove your '
            + 'past conversations from the improvement program. Requires “Save conversation details”.';
        // Beta cohort only (FeatureGate ladder) — the hand-selected group that already has Voice & AI.
        const shareVisible = typeof FeatureGate !== 'undefined' && FeatureGate.isBetaUser();
        const shareRow = shareVisible ? `
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border, #e5e7eb);">
                    <div style="font-weight: 600;">Share conversations to improve ${BRAND.productName}${this._infoTip(shareTip)}</div>
                    <label class="toggle" style="flex-shrink: 0;${on ? '' : ' opacity: 0.45;'}">
                        <input type="checkbox" ${this._share ? 'checked' : ''} ${(!on || this._shareBusy) ? 'disabled' : ''}
                            onchange="VoiceAiAnalysis.toggleShare(this.checked)">
                        <span class="toggle-slider"></span>
                    </label>
                </div>` : '';
        return `
            <div class="card" style="margin-bottom: 16px;"><div class="card-body">
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 16px;">
                    <div style="font-weight: 600;">Save conversation details${this._infoTip(retainTip)}</div>
                    <label class="toggle" style="flex-shrink: 0;">
                        <input type="checkbox" ${on ? 'checked' : ''} onchange="VoiceAiAnalysis.toggleRetain(this.checked)">
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                ${shareRow}
                <div style="margin-top: 12px; display: flex; justify-content: flex-end;">
                    <button class="btn btn-secondary btn-sm" ${this._clearing ? 'disabled' : ''}
                        onclick="VoiceAiAnalysis.clearHistory()">
                        ${this._clearing ? 'Clearing…' : 'Clear history'}
                    </button>
                </div>
            </div></div>`;
    },

    _renderMain() {
        const items = this._interactions;
        if (!items.length) {
            return `
                <div class="card"><div class="card-body" style="color: var(--text-muted); text-align: center; padding: 32px 16px;">
                    ${this._retain
                        ? `No saved interactions yet. Ask ${BRAND.assistantName} something and it’ll show up here.`
                        : 'Turn on “Save conversation details” above to start keeping a record of your interactions.'}
                </div></div>`;
        }
        return `
            <div class="card"><div class="card-body" style="padding: 0;">
                ${this._renderGroupedList(items)}
            </div></div>`;
    },

    /** Group interactions by local day → month, the way the Usage breakdown does:
     *  current-month days render as day rows directly; prior months collapse into
     *  month groups that expand to their day rows. Each day row expands to its
     *  interactions (already in memory — no extra fetch). */
    _renderGroupedList(items) {
        const byDay = new Map(), dayOrder = [];
        for (const it of items) {
            const ds = this._localDate(it.ts);
            if (!byDay.has(ds)) { byDay.set(ds, []); dayOrder.push(ds); }
            byDay.get(ds).push(it);
        }
        dayOrder.sort((a, b) => (a < b ? 1 : -1));  // newest day first
        const curPrefix = this._localDate(Date.now()).slice(0, 7);  // local 'YYYY-MM'
        const current = dayOrder.filter(ds => ds.startsWith(curPrefix));
        const prior = dayOrder.filter(ds => !ds.startsWith(curPrefix));
        const monthOrder = [], byMonth = new Map();
        for (const ds of prior) {
            const ym = ds.slice(0, 7);
            if (!byMonth.has(ym)) { byMonth.set(ym, []); monthOrder.push(ym); }
            byMonth.get(ym).push(ds);
        }
        return current.map(ds => this._renderDayGroup(ds, byDay.get(ds))).join('')
            + monthOrder.map(ym => this._renderMonthGroup(ym, byMonth.get(ym), byDay)).join('');
    },

    _renderDayGroup(ds, dayItems) {
        const open = this._expandedDays.has(ds);
        const caret = open ? '▾' : '▸';
        const n = dayItems.length;
        const cost = dayItems.reduce((s, it) => s + (it.total_cost || 0), 0);
        const detail = open ? dayItems.map(i => this._renderInteraction(i)).join('') : '';
        return `
            <div style="border-bottom: 1px solid var(--border, #e5e7eb);">
                <div onclick="VoiceAiAnalysis.toggleDay('${ds}')"
                    style="display:flex; align-items:center; gap:12px; padding:10px 16px; cursor:pointer;">
                    <span style="color:var(--text-muted); width:12px;">${caret}</span>
                    <span style="font-size:13px; font-weight:600; min-width:150px;">${this._escape(this._fmtDay(ds))}</span>
                    <span style="flex:1; font-size:12px; color:var(--text-muted);">${n} interaction${n === 1 ? '' : 's'} (${this._fmtCost(cost)})</span>
                </div>
                ${detail}
            </div>`;
    },

    _renderMonthGroup(ym, monthDays, byDay) {
        const open = this._expandedMonths.has(ym);
        const caret = open ? '▾' : '▸';
        const n = monthDays.reduce((s, ds) => s + (byDay.get(ds)?.length || 0), 0);
        const cost = monthDays.reduce((s, ds) => s + (byDay.get(ds) || []).reduce((a, it) => a + (it.total_cost || 0), 0), 0);
        const detail = open ? monthDays.map(ds => this._renderDayGroup(ds, byDay.get(ds))).join('') : '';
        return `
            <div style="border-bottom: 1px solid var(--border, #e5e7eb);">
                <div onclick="VoiceAiAnalysis.toggleMonth('${ym}')"
                    style="display:flex; align-items:center; gap:12px; padding:10px 16px; cursor:pointer; background:var(--surface-muted,#fafafa);">
                    <span style="color:var(--text-muted); width:12px;">${caret}</span>
                    <span style="font-size:13px; font-weight:600; min-width:150px;">${this._escape(this._fmtMonthLong(ym))}</span>
                    <span style="flex:1; font-size:12px; color:var(--text-muted);">${n} interaction${n === 1 ? '' : 's'} (${this._fmtCost(cost)})</span>
                </div>
                ${detail}
            </div>`;
    },

    toggleDay(ds) {
        if (this._expandedDays.has(ds)) this._expandedDays.delete(ds);
        else this._expandedDays.add(ds);
        App.renderPage();
    },
    toggleMonth(ym) {
        if (this._expandedMonths.has(ym)) this._expandedMonths.delete(ym);
        else this._expandedMonths.add(ym);
        App.renderPage();
    },

    _localDate(ts) {
        try { return new Date(ts).toLocaleDateString('en-CA'); }  // local 'YYYY-MM-DD'
        catch { return String(ts).slice(0, 10); }
    },
    _fmtDay(ds) {
        try {
            if (ds === this._localDate(Date.now())) return 'Today';
            const [y, m, d] = ds.split('-').map(Number);
            return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric' });
        } catch { return ds; }
    },
    _fmtMonthLong(ym) {
        try {
            const [y, m] = ym.split('-').map(Number);
            return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        } catch { return ym; }
    },

    _renderInteraction(intr) {
        const open = this._expanded.has(intr.key);
        const caret = open ? '▾' : '▸';
        const time = (() => {
            try { return new Date(intr.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
            catch { return intr.ts; }
        })();
        if (intr.realtime) return this._renderRealtimeInteraction(intr, open, time);
        const badge = intr.complexity === 'complex'
            ? `<span style="background: var(--accent-soft, #eef2ff); color: var(--accent, #4f46e5); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; padding: 2px 6px; border-radius: 4px;">Complex</span>`
            : `<span style="background: var(--surface-muted, #f3f4f6); color: var(--text-muted); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; padding: 2px 6px; border-radius: 4px;">Simple</span>`;
        const meta = `${this._fmtMs(intr.total_latency_ms)} · ${this._fmtTokens(intr.total_tokens)} tokens`;
        // Model on the COLLAPSED row (it used to appear only once expanded). A model swap is the
        // single most confusing thing that can happen here — the same prompt suddenly behaves
        // differently and nothing in the code changed. Seen 2026-07-13: an account switched to a
        // local qwen2.5:7b, which stopped calling tools entirely, and it read as a regression until
        // someone thought to check `model`. In a fixed column it's a glance instead of a query.
        const modelCell = this._modelCell(this._modelOf(intr));

        // DLG-3: a cascade DIALOG (multi-turn) threads every turn like a realtime
        // conversation — but keeps the cascade complexity badge + steps table. When
        // collapsed, show the first turn + a "show full conversation" toggle.
        const dialogTurns = (!intr.realtime && intr.turns && intr.turns.length > 1) ? intr.turns : null;
        let transcript;
        if (dialogTurns) {
            // One thumbs pair rates the WHOLE dialog (top-right of the conversation
            // bubble); a down-vote captures every turn's transcript.
            const fbThumbs = this._renderFeedbackThumbs(intr.key);
            const shown = open ? dialogTurns : dialogTurns.slice(0, 1);
            const thread = shown.map((t, i) => this._renderTurn(t, i === shown.length - 1)).join('');
            const more = `<button onclick="event.stopPropagation(); VoiceAiAnalysis.toggleInteraction('${this._escape(intr.key)}')"
                    style="background: none; border: none; color: var(--accent, #4f46e5); font-size: 12px; font-weight: 600; cursor: pointer; padding: 8px 0 0;">
                    ${open ? 'Show less ▴' : `Show full conversation (${dialogTurns.length - 1} more) ▾`}
                </button>`;
            transcript = `
            <div style="position: relative; background: var(--surface-muted, #f7f7f8); border-radius: 8px; padding: 10px 12px;${fbThumbs ? ' padding-right: 64px;' : ''} margin: 0 0 8px;">
                ${fbThumbs ? `<div style="position: absolute; top: 8px; right: 10px;">${fbThumbs}</div>` : ''}
                ${thread}
            </div>${more}`;
        } else {
            // Feedback thumbs sit in the UPPER-RIGHT of the transcript bubble; a
            // down-vote's reason chips appear just below the bubble.
            const hasTranscript = !!(intr.prompt || intr.response);
            const fbThumbs = hasTranscript ? this._renderFeedbackThumbs(intr.key) : '';
            transcript = (intr.prompt || intr.response || intr.subtext) ? `
            <div style="position: relative; background: var(--surface-muted, #f7f7f8); border-radius: 8px; padding: 10px 12px;${fbThumbs ? ' padding-right: 64px;' : ''} margin: 0 0 8px;">
                ${fbThumbs ? `<div style="position: absolute; top: 8px; right: 10px;">${fbThumbs}</div>` : ''}
                ${intr.prompt ? this._line('You said', intr.prompt, 13) : ''}
                ${intr.response ? this._line(`${BRAND.assistantName} said`, intr.response, 13) : ''}
                ${intr.subtext ? this._line('On-screen', intr.subtext, 12, true) : ''}
            </div>` : `<div style="color: var(--text-muted); font-size: 12px; margin: 0 0 8px;">(transcript not saved for this turn)</div>`;
        }

        const steps = open ? `
            <table style="width: 100%; border-collapse: collapse; font-size: 12px;"><tbody>
                ${intr.steps.map(s => this._renderStep(s)).join('')}
            </tbody></table>` : '';

        return `
            <div style="border-top: 1px solid var(--border, #f0f0f0);">
                <div onclick="VoiceAiAnalysis.toggleInteraction('${this._escape(intr.key)}')"
                    style="display: flex; align-items: center; gap: 10px; padding: 10px 16px; cursor: pointer;">
                    <span style="color: var(--text-muted); width: 12px; font-size: 11px;">${caret}</span>
                    <span style="color: var(--text-muted); width: 72px; font-size: 12px;">${this._escape(time)}</span>
                    <span style="flex-shrink: 0;">${badge}</span>
                    ${modelCell}
                    <span style="flex: 1; text-align: right; color: var(--text-muted); font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;">${this._escape(meta)}</span>
                </div>
                <div style="padding: 0 16px 12px 38px;">
                    ${transcript}
                    ${steps}
                </div>
            </div>`;
    },

    /** Realtime "conversation mode" interaction — a multi-turn thread, not a
     *  cascade turn. Shows the opening turn with a "Show more" toggle to reveal
     *  the full conversation; each turn carries its own timestamp. */
    _renderRealtimeInteraction(intr, open, time) {
        const turns = intr.turns || [];
        const badge = `<span style="background: var(--surface-muted, #f3f4f6); color: var(--text-secondary); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; padding: 2px 6px; border-radius: 4px;">Conversation</span>`;
        const cost = (intr.total_cost > 0) ? ` · ${this._fmtCost(intr.total_cost)}` : '';
        const meta = `${turns.length} turn${turns.length === 1 ? '' : 's'} · ${this._fmtTokens(intr.total_tokens)} tokens${cost}`;
        // One thumbs pair rates the WHOLE conversation (top-right of the bubble);
        // a down-vote captures every turn's transcript.
        const fbThumbs = this._renderFeedbackThumbs(intr.key);
        const shown = open ? turns : turns.slice(0, 1);
        const thread = shown.map((t, i) => this._renderTurn(t, i === shown.length - 1)).join('');
        const more = turns.length > 1
            ? `<button onclick="event.stopPropagation(); VoiceAiAnalysis.toggleInteraction('${this._escape(intr.key)}')"
                    style="background: none; border: none; color: var(--accent, #4f46e5); font-size: 12px; font-weight: 600; cursor: pointer; padding: 8px 0 0;">
                    ${open ? 'Show less ▴' : `Show full conversation (${turns.length - 1} more) ▾`}
                </button>`
            : '';
        return `
            <div style="border-top: 1px solid var(--border, #f0f0f0);">
                <div style="display: flex; align-items: center; gap: 10px; padding: 10px 16px;">
                    <span style="width: 12px;"></span>
                    <span style="color: var(--text-muted); width: 72px; font-size: 12px;">${this._escape(time)}</span>
                    <span style="flex-shrink: 0;">${badge}</span>
                    ${this._modelCell(this._modelOf(intr))}
                    <span style="flex: 1; text-align: right; color: var(--text-muted); font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;">${this._escape(meta)}</span>
                </div>
                <div style="padding: 0 16px 12px 38px;">
                    <div style="position: relative; background: var(--surface-muted, #f7f7f8); border-radius: 8px; padding: 10px 12px;${fbThumbs ? ' padding-right: 64px;' : ''}">
                        ${fbThumbs ? `<div style="position: absolute; top: 8px; right: 10px;">${fbThumbs}</div>` : ''}
                        ${thread}
                    </div>
                    ${more}
                </div>
            </div>`;
    },

    /** One conversation turn: You/Dashie lines, with the AI response latency
     *  (end-of-user-speech → response) shown on "Dashie said" when captured.
     *  `last` drops the divider so the thread doesn't end with a dangling rule.
     *  Feedback is per-DIALOG (one thumbs pair on the whole conversation), not
     *  per-turn — so turns render as plain transcript lines. */
    _renderTurn(t, last) {
        const lat = (t.latency_ms > 0)
            ? `<span style="color: var(--text-muted); font-size: 10px; margin-left: 6px; letter-spacing: 0;">(${this._escape(this._fmtMs(t.latency_ms))})</span>`
            : '';
        const dashie = t.response ? `
            <div style="margin: 0 0 4px;">
                <span style="color: var(--text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;">${BRAND.assistantName} said</span>${lat}
                <div style="font-size: 13px; line-height: 1.4;">${this._escape(t.response)}</div>
            </div>` : '';
        // On-screen (written) elaboration — cascade turns carry it; realtime turns don't.
        const subtext = t.subtext ? this._line('On-screen', t.subtext, 12, true) : '';
        return `
            <div style="margin: 0 0 ${last ? '0' : '10px'}; padding-bottom: ${last ? '0' : '10px'}; ${last ? '' : 'border-bottom: 1px dashed var(--border, #e5e7eb);'}">
                ${t.prompt ? this._line('You said', t.prompt, 13) : ''}
                ${dashie}
                ${subtext}
            </div>`;
    },

    // ── Voice response feedback (thumbs up/down) ─────────────────
    // Alpha-gated (this page is already alpha-only via FeatureGate; the check
    // is belt-and-suspenders against the 'voice_feedback' feature_id). Shown
    // only on rows with a retained transcript. A down-vote opens a reason
    // picker and ships the transcript snapshot (per-submission consent).

    /** Feather thumbs-up/down icon, matching the console's inline-SVG style.
     *  `filled` paints it solid (used to show the chosen rating after submit). */
    _thumbIcon(dir, filled) {
        const path = dir === 'up'
            ? '<path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>'
            : '<path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/>';
        return `<svg width="16" height="16" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
    },

    /** Upper-right thumbs cluster inside the transcript bubble. Thumbs stay
     *  visible after submit — the chosen one fills/highlights and the pair locks
     *  (feedback is accepted exactly once). A thumbs-down opens the follow-up modal. */
    _renderFeedbackThumbs(fbKey) {
        // Defensive gate — the page itself is beta-only (voice/AI moved alpha→beta
        // 2026-07-03), but never offer feedback to a non-beta context if that changes.
        if (typeof FeatureGate !== 'undefined' && FeatureGate.isBetaUser && !FeatureGate.isBetaUser()) return '';
        const st = this._feedback[fbKey] || {};
        const esc = this._escape(fbKey);
        const done = !!st.done;
        const locked = done || !!st.submitting;      // accept once; also lock during the write
        const active = done || !!st.submitting;      // show the chosen rating while writing + after
        const upChosen = active && st.rating === 'up';
        const downChosen = active && st.rating === 'down';
        const btn = (dir, chosen, handler) => `
            <button title="${dir === 'up' ? 'Good response' : 'Bad response'}" aria-label="${dir === 'up' ? 'Thumbs up' : 'Thumbs down'}"
                ${locked ? 'disabled' : `onclick="${handler}"`}
                style="background: none; border: none; cursor: ${locked ? 'default' : 'pointer'}; color: ${chosen ? 'var(--accent, #4f46e5)' : 'var(--text-muted)'}; padding: 3px; display: inline-flex; align-items: center; border-radius: 4px;">${this._thumbIcon(dir, chosen)}</button>`;
        return `<span style="display: inline-flex; align-items: center; gap: 2px;" ${done ? 'title="Feedback sent"' : ''}>
            ${btn('up', upChosen, `VoiceAiAnalysis.rateUp('${esc}')`)}
            ${btn('down', downChosen, `VoiceAiAnalysis.rateDown('${esc}')`)}
        </span>`;
    },

    /** Resolve a feedback key back to its interaction (+ turn for realtime). */
    _resolveFb(fbKey) {
        const [key, turnStr] = String(fbKey).split('::');
        const intr = this._interactions.find(i => i.key === key);
        if (!intr) return { intr: null, turn: null, turnIndex: null };
        if (turnStr !== undefined) {
            const idx = parseInt(turnStr, 10);
            return { intr, turn: (intr.turns || [])[idx] || null, turnIndex: idx };
        }
        return { intr, turn: null, turnIndex: null };
    },

    /** Best-effort model label for a row (cascade: the AI step; realtime: row.model). */
    _modelOf(intr) {
        if (intr.model) return intr.model;
        const ai = (intr.steps || []).find(s => s.kind === 'ai');
        return ai ? ai.label : null;
    },

    /** The model column on a collapsed row — fixed width so it reads as a COLUMN when you scan
     *  the list. That's the whole point: a swap (gemini-2.5-flash → qwen2.5:7b) should jump out
     *  as the column changing, not require expanding a row or querying ai_interactions. */
    _modelCell(model) {
        if (!model) return '';
        return `<span title="${this._escape(model)}" style="flex-shrink: 0; width: 128px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;">${this._escape(model)}</span>`;
    },

    /** Primary route of a cascade turn (the tool it used), else 'direct'. Realtime
     *  is fused S2S with no cascade route. */
    _routeOf(intr) {
        if (intr.realtime) return 'realtime';
        const TOOL_KINDS = ['web_search', 'image_search', 'sports'];
        const step = (intr.steps || []).find(s => TOOL_KINDS.includes(s.kind));
        return step ? step.kind : 'direct';
    },

    /** The turns of a dialog (realtime, or a multi-turn cascade dialog), else []. */
    _dialogTurns(intr) {
        return (intr.turns && intr.turns.length) ? intr.turns : [];
    },

    /** Concatenated readable transcript for the columns: all user utterances and all
     *  Dashie responses of a (possibly multi-turn) interaction. Falls back to the flat
     *  single-turn prompt/response. Returns { promptText, responseText }. */
    _transcriptText(intr) {
        const turns = this._dialogTurns(intr);
        if (turns.length) {
            const join = (arr) => arr.map(x => x).filter(Boolean).join('\n');
            return {
                promptText: join(turns.map(t => t.prompt)) || null,
                responseText: join(turns.map(t => t.response)) || null,
            };
        }
        return { promptText: intr.prompt || null, responseText: intr.response || null };
    },

    /** Self-contained pipeline trace for a down-vote, built from data the row
     *  already carries (no extra query): mode (cascade|realtime), route, model,
     *  the cascade per-stage steps, totals, and — for a dialog — the full turn-by-turn
     *  transcript. Shaped so the voice-eval harness can reconstruct the (multi-)turn. */
    _toolTraceOf(intr) {
        const trace = {
            mode: intr.realtime ? 'realtime' : 'cascade',
            route: this._routeOf(intr),
            model: this._modelOf(intr),
            total_tokens: intr.total_tokens ?? null,
            total_latency_ms: intr.total_latency_ms ?? null,
        };
        if (intr.total_cost != null) trace.total_cost = intr.total_cost;
        const turns = this._dialogTurns(intr);
        if (turns.length) {
            // Whole dialog: structured turn-by-turn transcript (maps to the eval
            // harness's multi-turn case shape).
            trace.turn_count = turns.length;
            trace.transcript = turns.map(t => ({
                prompt: t.prompt ?? null,
                response: t.response ?? null,
                latency_ms: t.latency_ms ?? null,
            }));
        }
        if (!intr.realtime) {
            trace.steps = (intr.steps || []).map(s => ({
                kind: s.kind,
                label: s.label ?? null,
                input_tokens: s.input_tokens ?? null,
                output_tokens: s.output_tokens ?? null,
                result_count: s.result_count ?? null,
                latency_ms: s.latency_ms ?? null,
            }));
        }
        return trace;
    },

    /** Accept feedback exactly once — ignore clicks once submitted or in-flight. */
    _fbLocked(fbKey) {
        const st = this._feedback[fbKey];
        return !!(st && (st.done || st.submitting));
    },

    async rateUp(fbKey) {
        if (this._fbLocked(fbKey)) return;
        const { intr } = this._resolveFb(fbKey);
        if (!intr) return;
        this._feedback[fbKey] = { rating: 'up', submitting: true };
        App.renderPage();
        try {
            await VoiceAiApi.submitFeedback({ sessionId: intr.session_id, rating: 'up', model: this._modelOf(intr) });
            this._feedback[fbKey] = { rating: 'up', done: true };
        } catch (e) {
            delete this._feedback[fbKey];   // let them retry
            Toast.error(`Couldn't send feedback: ${e.message}`);
        }
        App.renderPage();
    },

    async rateDown(fbKey) {
        if (this._fbLocked(fbKey)) return;
        const { intr } = this._resolveFb(fbKey);
        if (!intr) return;
        // Whole-interaction feedback: for a dialog (realtime or multi-turn cascade)
        // this is the ENTIRE conversation transcript, not a single exchange.
        const { promptText, responseText } = this._transcriptText(intr);
        // Follow-up modal: required reason + optional free-text detail.
        const res = await FeedbackModal.open({ prompt: promptText, response: responseText });
        if (!res) return;   // cancelled — leave unrated, thumbs stay active
        this._feedback[fbKey] = { rating: 'down', submitting: true };
        App.renderPage();
        try {
            await VoiceAiApi.submitFeedback({
                sessionId: intr.session_id,
                rating: 'down',
                reason: res.reason,
                detail: res.detail,
                promptText,
                responseText,
                turnIndex: null,   // whole dialog, not a single turn
                model: this._modelOf(intr),
                toolTrace: this._toolTraceOf(intr),   // includes the full turn-by-turn transcript
            });
            this._feedback[fbKey] = { rating: 'down', done: true };
        } catch (e) {
            delete this._feedback[fbKey];   // let them retry
            Toast.error(`Couldn't send feedback: ${e.message}`);
        }
        App.renderPage();
    },

    _renderStep(s) {
        const KIND_LABELS = { ai: 'AI', web_search: 'SEARCH', image_search: 'IMAGES', sports: 'SPORTS', tts: 'SPEECH', stt: 'SPEECH' };
        const kind = KIND_LABELS[s.kind] || (s.kind || '').toUpperCase();
        let desc;
        if (s.kind === 'ai') {
            desc = `${this._escape(s.label)} <span style="color: var(--text-muted);">(${this._fmtTokens(s.input_tokens)} in / ${this._fmtTokens(s.output_tokens)} out)</span>`;
        } else if (s.kind === 'web_search') {
            desc = `${this._escape(s.label)} <span style="color: var(--text-muted);">(${this._fmtTokens(s.result_count || 0)} results)</span>`;
        } else if (s.kind === 'image_search') {
            desc = `${this._escape(s.label)} <span style="color: var(--text-muted);">(${this._fmtTokens(s.result_count || 0)} images)</span>`;
        } else if (s.kind === 'sports') {
            desc = `${this._escape(s.label)} <span style="color: var(--text-muted);">(${this._fmtTokens(s.result_count || 0)} games)</span>`;
        } else if (s.free) {
            // Local (free) STT/TTS from voice_turn_timing — Whisper/Piper on the HA box.
            // Friendly engine name + a "local" hint (the ms column carries the latency).
            const e = String(s.label || '').replace(/^(stt|tts)\./, '').toLowerCase();
            const known = { faster_whisper: 'Whisper', whisper: 'Whisper', piper: 'Piper', local: 'Local TTS', kokoro: 'Kokoro' };   // 'kokoro' = legacy rows (pre-2026-07-13 the local transport misreported itself)
            const base = known[e] || (e ? e.charAt(0).toUpperCase() + e.slice(1) : kind.toLowerCase());
            const times = s.count > 1 ? ` ×${s.count}` : '';
            desc = `${this._escape(base)} <span style="color: var(--text-muted);">(local)${times}</span>`;
        } else {
            // tts / stt — just the provider/model label (no tokens/results)
            desc = this._escape(s.label || kind.toLowerCase());
        }
        return `
            <tr>
                <td style="padding: 4px 0; color: var(--text-muted); width: 64px; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px;">${kind}</td>
                <td style="padding: 4px 8px;">${desc}</td>
                <td style="padding: 4px 0; text-align: right; color: var(--text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace;">${this._fmtMs(s.latency_ms)}</td>
            </tr>`;
    },

    _line(label, val, size, muted) {
        return `
            <div style="margin: 0 0 4px;">
                <span style="color: var(--text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;">${label}</span>
                <div style="font-size: ${size}px; line-height: 1.4; ${muted ? 'color: var(--text-secondary);' : ''}">${this._escape(val)}</div>
            </div>`;
    },

    _renderLoading() {
        return `<div style="color: var(--text-muted); padding: 24px 4px;">Loading interactions…</div>`;
    },
    _renderError() {
        return `<div class="card"><div class="card-body" style="color: var(--status-error);">
            Failed to load: ${this._escape(this._error)}
            <div style="margin-top: 12px;"><button class="btn btn-secondary btn-sm" onclick="VoiceAiAnalysis.refresh()">Retry</button></div>
        </div></div>`;
    },

    // ── helpers ──────────────────────────────────────────────

    _tz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } },
    _fmtMs(ms) {
        const n = Number(ms) || 0;
        return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)} ms`;
    },
    _fmtTokens(n) {
        const v = Number(n) || 0;
        if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
        return String(v);
    },
    _fmtCost(amount) {
        const n = Number(amount);
        if (!isFinite(n) || n <= 0) return '$0.00';
        if (n < 0.01) return '<$0.01';
        return '$' + n.toFixed(2);
    },
    _escape(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
};
