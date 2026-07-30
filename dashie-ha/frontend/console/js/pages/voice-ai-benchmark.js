/*
   Voice & AI → Benchmark sub-view.

   Characterizes the voice pipeline so you can see WHERE time goes and compare the
   segmented "cascade" path (STT → brain → TTS) against the all-in-one Gemini Live
   turnaround.

   Source: get_voice_turn_timing (database-operations). Cascade stages come from the
   voice_turn_timing table (one row per turn); Live's finish-speaking → first-audio
   number comes from ai_interactions (request_type='realtime'). The cascade `ttfa`
   and Live `ttfa` are the apples-to-apples pair — both are "user stopped talking →
   audio starts." See 20260628_VOICE_PIPELINE_BENCHMARKING.md.
*/

const VoiceAiBenchmark = {
    _days: 7,
    _loading: false,
    _loaded: false,
    _error: null,
    _data: null,

    onNavigateTo() { this._load(); },

    setDays(d) {
        const n = Number(d) || 7;
        if (n === this._days) return;
        this._days = n;
        this._loaded = false;
        this._load();
    },

    async refresh() {
        this._loaded = false;
        await this._load();
    },

    async _load() {
        if (this._loading) return;
        this._loading = true;
        this._error = null;
        try {
            this._data = await DashieAuth.dbRequest('get_voice_turn_timing', { days: this._days });
            this._loaded = true;
        } catch (e) {
            console.error('[VoiceAiBenchmark] load failed', e);
            this._error = e?.message || 'Failed to load benchmark data';
        } finally {
            this._loading = false;
            App.renderPage();
        }
    },

    // ── render ───────────────────────────────────────────────
    render() {
        if (!this._loaded && !this._loading && !this._error) {
            this._load();
            return this._wrap(this._renderLoading());
        }
        if (this._loading && !this._loaded) return this._wrap(this._renderLoading());
        if (this._error && !this._loaded) return this._wrap(this._renderError());
        return this._wrap(this._renderMain());
    },

    _wrap(inner) {
        return `<div style="max-width: 760px;">${this._renderHeader()}${inner}</div>`;
    },

    _renderHeader() {
        const opt = (d, label) => `<option value="${d}" ${this._days === d ? 'selected' : ''}>${label}</option>`;
        return `
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px;">
                <p style="color: var(--text-muted); font-size: 13px; margin: 0;">
                    Where time goes per voice turn, and how the segmented pipeline compares to Gemini Live.
                    All values are <strong>p50 · p95</strong> in milliseconds.
                </p>
                <select onchange="VoiceAiBenchmark.setDays(this.value)"
                    style="padding: 6px 8px; border: 1px solid var(--border, #d1d5db); border-radius: 6px; background: var(--bg, #fff); color: var(--text-primary); font-size: 13px;">
                    ${opt(1, 'Last 24h')}${opt(7, 'Last 7 days')}${opt(30, 'Last 30 days')}
                </select>
            </div>`;
    },

    _renderMain() {
        const d = this._data || {};
        const live = d.live;
        const cascade = Array.isArray(d.cascade) ? d.cascade : [];

        if (!live && !cascade.length) {
            return `<div style="color: var(--text-muted); padding: 40px 0; text-align: center;">
                No voice turns recorded in this window yet.
            </div>`;
        }

        return `
            ${this._renderHeadline(live, cascade)}
            ${this._renderStageTable(cascade)}
            ${this._renderLegend()}`;
    },

    /** The headline comparison: cascade time-to-first-audio vs Live. */
    _renderHeadline(live, cascade) {
        const card = (title, sub, stat, accent) => `
            <div style="flex: 1; min-width: 180px; border: 1px solid var(--border, #d1d5db); border-radius: 10px; padding: 14px 16px;">
                <div style="font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em;">${title}</div>
                <div style="font-size: 26px; font-weight: 700; color: ${accent}; margin-top: 4px;">${this._p50(stat)}<span style="font-size: 14px; font-weight: 500; color: var(--text-muted);"> ms</span></div>
                <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">${sub} · p95 ${this._p95(stat)} · n=${stat?.n ?? 0}</div>
            </div>`;

        // Best cascade group = the one with the most turns (representative).
        const top = cascade[0];
        const cards = [];
        if (live) cards.push(card('Gemini Live', 'finish → first audio', live.ttfa, 'var(--accent, #2563eb)'));
        if (top) cards.push(card('Cascade (this path)', `${top.path || 'cascade'} · ${top.model || ''}`, top.ttfa, 'var(--text-primary)'));

        if (!cards.length) return '';
        return `
            <div style="margin: 6px 0 18px;">
                <div style="font-size: 13px; font-weight: 600; margin-bottom: 8px;">Time to first audio (the number you feel)</div>
                <div style="display: flex; gap: 12px; flex-wrap: wrap;">${cards.join('')}</div>
            </div>`;
    },

    /** Per-path stage breakdown — where the cascade's time actually goes. */
    _renderStageTable(cascade) {
        if (!cascade.length) return '';
        const th = (t, right) => `<th style="text-align: ${right ? 'right' : 'left'}; padding: 6px 8px; font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; border-bottom: 1px solid var(--border, #d1d5db); white-space: nowrap;">${t}</th>`;
        const td = (v, right, strong) => `<td style="text-align: ${right ? 'right' : 'left'}; padding: 8px; font-size: 13px; ${strong ? 'font-weight: 600;' : ''} border-bottom: 1px solid var(--border-subtle, #eee); white-space: nowrap;">${v}</td>`;

        const rows = cascade.map(g => `
            <tr>
                ${td(`${g.path || '—'}<div style="font-size: 11px; color: var(--text-muted);">${g.model || ''}</div>`, false)}
                ${td(g.turns, true)}
                ${td(this._cell(g.ttfa), true, true)}
                ${td(this._cell(g.stt), true)}
                ${td(this._cell(g.brain), true)}
                ${td(this._cell(g.network), true)}
                ${td(this._cell(g.tts), true)}
            </tr>`).join('');

        return `
            <div style="font-size: 13px; font-weight: 600; margin: 8px 0;">Cascade stage breakdown</div>
            <div style="overflow-x: auto; border: 1px solid var(--border, #d1d5db); border-radius: 10px;">
                <table style="width: 100%; border-collapse: collapse;">
                    <thead><tr>
                        ${th('Path / model')}${th('Turns', true)}${th('TTFA', true)}${th('STT', true)}${th('Brain', true)}${th('Network', true)}${th('TTS', true)}
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    },

    _renderLegend() {
        const item = (k, v) => `<div><strong>${k}</strong> — ${v}</div>`;
        return `
            <div style="margin-top: 14px; font-size: 12px; color: var(--text-muted); display: grid; gap: 4px;">
                ${item('TTFA', 'transcript-final → first audio (compare to Live)')}
                ${item('STT', 'speech → transcript (best-effort; blank on Android streaming STT)')}
                ${item('Brain', 'model generation, server-side (excludes network)')}
                ${item('Network', 'transport + edge cold start (client wall-clock − brain)')}
                ${item('TTS', 'brain-done → first audio (synth window)')}
            </div>`;
    },

    // ── stat formatting ──────────────────────────────────────
    _cell(stat) {
        if (!stat || !stat.n) return '<span style="color: var(--text-muted);">—</span>';
        return `${this._p50(stat)} · <span style="color: var(--text-muted);">${this._p95(stat)}</span>`;
    },
    _p50(stat) { return stat && stat.p50 != null ? stat.p50 : '—'; },
    _p95(stat) { return stat && stat.p95 != null ? stat.p95 : '—'; },

    _renderLoading() {
        return `<div style="color: var(--text-muted); padding: 40px 0; text-align: center;">Loading benchmark…</div>`;
    },
    _renderError() {
        return `<div style="color: var(--status-error, #c00); padding: 40px 0; text-align: center;">${this._error}</div>`;
    },
};

window.VoiceAiBenchmark = VoiceAiBenchmark;
