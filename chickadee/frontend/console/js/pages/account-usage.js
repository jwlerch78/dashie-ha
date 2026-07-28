/* ============================================================
   Account → Token Usage tab
   ------------------------------------------------------------
   Phase 1 of the credits/billing build.

   What this view does today:
     - Stat strip: current balance, today's spend, this-month's spend
     - Range selector: Today / 7d / 30d / This month / Custom
     - "By service" table: aggregate across the selected range, grouped
       by service type (AI / TTS / STT / Web search) and itemised by
       provider+model. Costs computed client-side from window.AiModelCatalog
       (the bundle shared with the web + Android apps).
     - "Daily breakdown" rows: per-day totals with inline expand on click
       (per-call list with timestamp + model + cost).
     - Admin-only "Add credits" form (gated on is_admin flag returned by
       get_credit_balance).

   What it does NOT do yet (Phase 3+):
     - No deduction. Costs shown are pure spend estimates from log rows;
       the balance is a static number granted via admin tool.
     - Includes/purchased tranches, expiry, BYOK — all deferred.

   All reads go through DashieAuth.dbRequest('get_credit_balance' /
   'get_usage_summary' / 'get_usage_daily' / 'get_usage_calls').
   ============================================================ */

const AccountUsage = {
    _balance: null,            // {balance, lifetime_granted, is_admin}
    _summary: null,            // {range_start, range_end, by_service: [...]}
    _daily: null,              // {days: [...]} for the SELECTED range (breakdown card)
    _monthDaily: null,         // {days: [...]} always current month — powers the range-independent stat cards
    _expiry: null,             // {next_expiry:{amount,expires_at}, lots:[...]} — get_credit_expiry
    _flash: null,              // transient banner (e.g. after returning from Stripe)
    _activeRange: '30d',       // 'today' | '7d' | '30d' | 'month' | 'custom'
    _customStart: null,
    _customEnd: null,
    _loading: false,
    _error: null,

    /** Inline-expanded daily rows: Map<dateString, {loading, interactions?, error?}> */
    _expandedDays: new Map(),
    /** Inline-expanded voice-interaction rows, by interaction key. */
    _expandedInteractions: new Set(),
    /** Expanded service groups in the summary card (collapsed by default). */
    _expandedServices: new Set(),

    /** Breakdown card: view mode + (year-list) expanded month groups. */
    _breakdownView: 'list',       // 'list' | 'daily' | 'monthly'
    _expandedMonths: new Set(),
    DAILY_GRAPH_CAP: 90,          // Daily Graph caps at the most recent N days (year range)

    /** Admin form state. */
    _adminForm: { open: false, email: '', amount: '', note: '', busy: false, error: null },

    // ── lifecycle ─────────────────────────────────────────────

    onNavigateTo() { this._checkReturn(); this._fetchAll(); },

    /** After returning from Stripe Checkout (?credits=success), show a banner and
     *  strip the param. The grant lands via webhook (async), so the balance may
     *  take a moment — _fetchAll re-reads it. */
    _checkReturn() {
        try {
            const params = new URLSearchParams(window.location.search);
            const c = params.get('credits');
            if (c === 'success') this._flash = 'Payment received — your credits will appear in a moment.';
            else if (c === 'cancel') this._flash = 'Checkout canceled — no charge.';
            if (c) {
                params.delete('credits');
                const clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
                window.history.replaceState({}, '', clean);
            }
        } catch { /* ignore */ }
    },

    async _fetchAll() {
        this._loading = true;
        this._error = null;
        App.renderPage();
        try {
            const { start, end } = this._rangeBounds();
            const tz = this._tz();
            // Stat cards (Today / This month) must be range-INDEPENDENT, so fetch
            // the current month's daily separately from the selected-range data.
            const now = new Date();
            // Range-INDEPENDENT stat window: cover both "this week" and "this month".
            // Early in a month the calendar week reaches into the prior month, so start
            // at whichever is earlier (else "This week" undercounts across the boundary).
            const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
            const weekStart = this._weekStart();
            const statStart = (weekStart < monthStart ? weekStart : monthStart).toISOString();
            const nowIso = now.toISOString();
            // Auto-replenish state lives in CreditsControls now (shared with the
            // Account tab); fetch it alongside so the Balance card paints complete.
            const [bal, sum, daily, monthDaily, expiry] = await Promise.all([
                DashieAuth.dbRequest('get_credit_balance', {}),
                DashieAuth.dbRequest('get_usage_summary', { range_start: start, range_end: end, tz }),
                DashieAuth.dbRequest('get_usage_daily',   { range_start: start, range_end: end, tz }),
                DashieAuth.dbRequest('get_usage_daily',   { range_start: statStart, range_end: nowIso, tz }),
                DashieAuth.dbRequest('get_credit_expiry', {}).catch(() => null),
                CreditsControls.fetchAutorefill().catch(() => null),
            ]);
            this._balance = bal;
            this._summary = sum;
            this._daily = daily;
            this._monthDaily = monthDaily;
            this._expiry = expiry;
            // Share the freshly-fetched balance with the sidebar so its
            // bottom-left widget never disagrees with the stat strip on
            // this page. CreditsService re-renders the sidebar in-place.
            window.CreditsService?.note(bal);
            this._loading = false;
            App.renderPage();
        } catch (e) {
            console.error('[AccountUsage] fetch failed', e);
            this._error = e?.message || String(e);
            this._loading = false;
            App.renderPage();
        }
    },

    setRange(range) {
        if (range === this._activeRange) return;
        this._activeRange = range;
        if (range !== 'custom') {
            this._expandedDays.clear();
            this._expandedMonths.clear();
            this._fetchAll();
        } else {
            App.renderPage();
        }
    },

    applyCustomRange(start, end) {
        this._customStart = start;
        this._customEnd = end;
        this._activeRange = 'custom';
        this._expandedDays.clear();
        this._expandedMonths.clear();
        this._fetchAll();
    },

    /** Compute start + end ISO strings for the active range. */
    _rangeBounds() {
        const now = new Date();
        const endIso = now.toISOString();
        let start;
        switch (this._activeRange) {
            case 'today': {
                const s = new Date(now); s.setHours(0, 0, 0, 0); start = s.toISOString(); break;  // local midnight
            }
            case '7d':    start = new Date(now.getTime() - 7 * 86400_000).toISOString(); break;
            case 'month': {
                const s = new Date(now.getFullYear(), now.getMonth(), 1);  // local month start
                start = s.toISOString(); break;
            }
            case 'year': {
                const s = new Date(now.getFullYear(), 0, 1);  // local Jan 1
                start = s.toISOString(); break;
            }
            case 'custom':
                start = this._customStart || new Date(now.getTime() - 30 * 86400_000).toISOString();
                return { start, end: this._customEnd || endIso };
            case '30d':
            default:
                start = new Date(now.getTime() - 30 * 86400_000).toISOString();
        }
        return { start, end: endIso };
    },

    // ── cost helpers ──────────────────────────────────────────

    /** USD cost for a summary row.
     *
     *  Authoritative source: `row.actual_cost_usd` is what the server
     *  actually debited from user_credits.balance for this group (from
     *  credit_deductions). Use that when present.
     *
     *  Fallback: historical rows from before credit_deductions existed
     *  have actual_cost_usd === 0 but real token counts in ai_interactions
     *  / token_usage. For those we compute client-side from the catalog
     *  so the table doesn't suddenly drop the old spend to zero. TTS/STT
     *  has no token columns, so the fallback only produces a number for
     *  ai/web_search. */
    _costForRow(row) {
        // Cost = the ACTUAL margined charge (sum of credit_deductions.amount).
        // No token-compute fallback — mixing computed (pre-margin) with actual is
        // exactly what made the summary, daily, and stat-card totals disagree.
        // Now every total == the sum of credit_deductions for the range.
        return row ? (Number(row.actual_cost_usd) || 0) : 0;
    },

    _fmtCost(amount) {
        if (amount == null || !isFinite(amount) || amount === 0) return '$0.00';
        if (amount < 0.01) return '$' + amount.toFixed(4);
        return '$' + amount.toFixed(2);
    },

    // Like _fmtCost, but for roll-up totals (day/week/month/section). A tiny
    // positive total (>$0 and <$0.01) shows as "<$0.01" instead of a noisy
    // 4-decimal figure. Per-call line items and interaction rows keep _fmtCost
    // so the drill-down still shows the exact amount.
    _fmtCostTotal(amount) {
        // Nothing charged (all-BYOK, template, or included-in-plan) → "$-", not "$0.00"
        // or a phantom "<$0.01" (John, 2026-07-13). Distinct from null (unknown → handled
        // by callers as "—").
        if (amount === 0) return '$-';
        if (amount != null && isFinite(amount) && amount > 0 && amount < 0.01) return '<$0.01';
        return this._fmtCost(amount);
    },

    /** Lowest-level line items (per-call rows, realtime Voice/Text rollups):
     *  exact 3-decimal cost — never '<$0.01' (John, 2026-07-12). Sub-half-mill
     *  positives (e.g. a ~$0.0004 STT call) would render as a misleading
     *  '$0.000' — show '<$0.001' instead (John, 2026-07-12). */
    _fmtCost3(amount) {
        if (amount == null || !isFinite(amount)) return '$0.000';
        if (amount > 0 && amount < 0.0005) return '<$0.001';
        return '$' + amount.toFixed(3);
    },

    _fmtCount(n) {
        if (n == null) return '—';
        return n.toLocaleString();
    },

    _fmtDate(d) {
        try {
            const [y, m, day] = d.split('-').map(Number);
            const dt = new Date(Date.UTC(y, m - 1, day));
            return dt.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
        } catch { return d; }
    },

    /** Section key → header label ("speech" merges tts+stt; image search files
     *  under Tools). */
    _serviceLabel(svc) {
        return { ai: 'AI Models', speech: 'Speech', tts: 'Speech', stt: 'Speech', web_search: 'Tools', image_search: 'Tools' }[svc] || svc;
    },

    /** Display name for a summary line. Web/image-search rows read as the tool
     *  name; TTS/STT rows carry their direction so the merged Speech section
     *  stays legible ("elevenlabs (TTS)" / "nova-3-streaming (STT)"). BYOK rows
     *  (user's own provider key — recorded, never charged) get "(API key)". */
    _summaryItemName(r) {
        if (r.service === 'web_search' || r.service === 'image_search') {
            const p = r.provider ? r.provider.charAt(0).toUpperCase() + r.provider.slice(1) : (r.service === 'image_search' ? 'Image' : 'Web');
            return `${p} (${r.service === 'image_search' ? 'image' : 'web'} search)`;
        }
        if (r.service === 'tts' || r.service === 'stt') {
            return `${r.model || r.provider || '—'} (${r.service.toUpperCase()})`;
        }
        const name = r.model || r.provider || '—';
        return r.byok ? `${name} (API key)` : name;
    },

    // ── admin form ────────────────────────────────────────────

    openAdminForm()  { this._adminForm.open = true; App.renderPage(); },
    closeAdminForm() { this._adminForm = { open: false, email: '', amount: '', note: '', busy: false, error: null }; App.renderPage(); },
    setAdminField(field, value) { this._adminForm[field] = value; },

    async submitAdminForm() {
        const f = this._adminForm;
        if (f.busy) return;
        const amount = Number(f.amount);
        if (!f.email || !isFinite(amount) || amount <= 0) {
            f.error = 'Email and a positive amount are required.';
            App.renderPage();
            return;
        }
        f.busy = true; f.error = null;
        App.renderPage();
        try {
            const result = await DashieAuth.dbRequest('admin_add_credits', {
                target_email: f.email.trim(),
                amount,
                note: f.note?.trim() || null,
            });
            Toast.success(`Granted ${this._fmtCost(amount)} to ${result.target_email}. New balance: ${this._fmtCost(result.new_balance)}.`);
            this.closeAdminForm();
            this._fetchAll();  // refresh own balance if granted to self
        } catch (e) {
            f.error = e?.message || String(e);
            f.busy = false;
            App.renderPage();
        }
    },

    // ── daily-row expansion ───────────────────────────────────

    async toggleDay(date) {
        const cur = this._expandedDays.get(date);
        if (cur) {
            this._expandedDays.delete(date);
            App.renderPage();
            return;
        }
        this._expandedDays.set(date, { loading: true });
        App.renderPage();
        await this._loadDay(date);
        App.renderPage();
    },

    /** Fetch (or re-fetch) one day's interaction drill-down into _expandedDays.
     *  Shared by toggleDay and refresh() — so a title-bar Refresh re-pulls an
     *  already-open day's rows instead of leaving them stale. */
    async _loadDay(date) {
        try {
            const result = await DashieAuth.dbRequest('get_usage_calls', { date, tz: this._tz() });
            const interactions = result.interactions || [];
            await this._mergeLocalTranscripts(interactions);
            this._expandedDays.set(date, { loading: false, interactions });
        } catch (e) {
            this._expandedDays.set(date, { loading: false, error: e?.message || String(e) });
        }
    },

    /** Title-bar Refresh entry: re-fetch the aggregates AND every currently-open
     *  day drill-down, keeping them expanded. _fetchAll alone re-pulls only the
     *  daily/summary totals and never touches _expandedDays, so new interactions
     *  in an open day stayed stale until a full page reload cleared the Map — the
     *  "Refresh doesn't grab the latest, I have to reload the whole site" bug. */
    async refresh() {
        const openDays = [...this._expandedDays.keys()];
        await this._fetchAll();
        await Promise.all(openDays.map(date => this._loadDay(date)));
        App.renderPage();
    },

    /** In add-on mode, overlay HA-local transcript text onto interactions by
     *  session_id. Kiosk turns keep transcripts on the user's HA box (not
     *  Supabase), so the Supabase usage rows carry cost but no text — we fetch
     *  the text from the add-on and join it here. Best-effort. Build plan §17. */
    async _mergeLocalTranscripts(interactions) {
        if (typeof DashieAuth === 'undefined' || !DashieAuth.isAddonMode) return;
        if (!interactions.length) return;
        // Cloud-account rows already carry their text from Supabase — nothing to join.
        if (interactions.every(i => i.prompt || i.response)) return;
        try {
            const data = await fetch(DashieAuth._addonUrl('/api/transcripts?limit=500'))
                .then(r => r.ok ? r.json() : null);
            const rows = data?.transcripts || [];
            if (!rows.length) return;
            // Collect ALL transcripts per session, oldest-first. A dialog session has one
            // transcript PER TURN (open-dialog keeps the mic live), so a single session_id
            // maps to many turns — including "didn't catch that" misses. The old code did
            // bySession.set(id, t) which kept only the last, collapsing a 3-turn dialog to
            // one shown exchange while the call count still read 3 (the mismatch John saw).
            const bySession = new Map();
            for (const t of rows) {
                if (!t.session_id) continue;
                if (!bySession.has(t.session_id)) bySession.set(t.session_id, []);
                bySession.get(t.session_id).push(t);
            }
            for (const arr of bySession.values()) arr.sort((a, b) => (a.ts < b.ts ? -1 : 1));
            for (const intr of interactions) {
                if (intr.prompt || intr.response || (intr.turns && intr.turns.length)) continue;
                const arr = intr.session_id && bySession.get(intr.session_id);
                if (!arr || !arr.length) continue;
                if (arr.length === 1) {
                    // Single turn → the existing prompt/response transcript block.
                    intr.prompt = arr[0].text || null;
                    intr.response = arr[0].voice || null;
                } else {
                    // Multi-turn → thread every exchange (renders as "Conversation · N turns"
                    // via the dialogTurns path, same as realtime), so misses are visible.
                    intr.turns = arr.map(t => ({ prompt: t.text || null, response: t.voice || null, ts: t.ts }));
                }
            }
        } catch (e) {
            // Transcripts just won't show; never block the usage view.
        }
    },

    /** Expand/collapse a single voice interaction (its passes/items). */
    toggleInteraction(key) {
        if (this._expandedInteractions.has(key)) this._expandedInteractions.delete(key);
        else this._expandedInteractions.add(key);
        App.renderPage();
    },

    /** Expand/collapse a service group (AI / Speech / Tools) in the summary. */
    toggleService(svc) {
        if (this._expandedServices.has(svc)) this._expandedServices.delete(svc);
        else this._expandedServices.add(svc);
        App.renderPage();
    },

    // ── render ────────────────────────────────────────────────

    render() {
        if (this._error) {
            return `
                <div style="max-width: 800px;">
                    <div class="card"><div class="card-body" style="color: var(--status-error, #c00);">
                        Couldn't load usage data: ${this._escape(this._error)}
                        <button class="btn btn-secondary btn-sm" style="margin-left: 12px;" onclick="AccountUsage._fetchAll()">Retry</button>
                    </div></div>
                </div>`;
        }

        if (this._loading && !this._balance) {
            return `<div style="max-width: 800px; color: var(--text-muted); padding: 20px 0;">Loading usage…</div>`;
        }

        return `
            <div style="max-width: 800px;">
                ${this._renderFlash()}
                ${CreditsControls.renderFailureNotice()}
                ${this._renderStatStrip()}
                ${CreditsControls.renderExpiryNotice(this._expiry)}
                ${this._renderAdminSection()}
                ${this._renderRangeBar()}
                ${this._renderSummaryCard()}
                ${this._renderBreakdownCard()}
            </div>`;
    },

    _renderFlash() {
        if (!this._flash) return '';
        return `
            <div class="card" style="margin-bottom: 12px; border-color: var(--status-success, #16a34a);">
                <div class="card-body" style="padding: 12px 16px; font-size: 13px; display:flex; justify-content:space-between; align-items:center; gap:12px;">
                    <span>${this._escape(this._flash)}</span>
                    <button class="btn btn-secondary btn-sm" onclick="AccountUsage.dismissFlash()">Dismiss</button>
                </div></div>`;
    },
    dismissFlash() { this._flash = null; App.renderPage(); },

    _renderStatStrip() {
        // Balance card on the left; one combined period card (Today / This week /
        // This month) on the right. All three totals are range-INDEPENDENT (read
        // from the dedicated stat-window fetch, not the selected range).
        const todayCost = this._totalCostForDay(this._todayDate());
        const weekCost = this._totalCostForWeek();
        const monthCost = this._totalCostForMonth();
        return `
            <div class="credits-stat-grid" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 20px; align-items: stretch;">
                ${CreditsControls.renderBalanceCard(this._balance)}
                ${this._renderPeriodCard(todayCost, weekCost, monthCost)}
            </div>`;
    },

    /** Combined Today / This week / This month card. Fills its grid cell so its
     *  height matches the Balance card beside it (align-items: stretch). */
    _renderPeriodCard(today, week, month) {
        const row = (label, val) => `
            <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 12px;">
                <span style="font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">${label}</span>
                <span style="font-size: 20px; font-weight: 700; color: var(--text-primary);">${val == null ? '—' : this._escape(this._fmtCostTotal(val))}</span>
            </div>`;
        return `
            <div class="card" style="height: 100%;"><div class="card-body" style="height: 100%; box-sizing: border-box; display: flex; flex-direction: column; justify-content: space-between; gap: 10px; padding: 16px;">
                ${row('Today', today)}
                ${row('This week', week)}
                ${row('This month', month)}
            </div></div>`;
    },

    _renderAdminSection() {
        if (!this._balance?.is_admin) return '';
        const f = this._adminForm;
        if (!f.open) {
            return `
                <div style="display: flex; align-items: center; gap: 12px; padding: 8px 12px; background: var(--bg-muted, #f4f4f5); border-radius: 6px; margin-bottom: 16px; font-size: 13px;">
                    <span style="font-weight: 600;">⚙ Admin tools</span>
                    <button class="btn btn-secondary btn-sm" onclick="AccountUsage.openAdminForm()">Add credits…</button>
                </div>`;
        }
        return `
            <div class="card" style="margin-bottom: 16px; border-left: 3px solid var(--accent);">
                <div class="card-body">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
                        <strong>Add credits</strong>
                        <button class="btn btn-ghost btn-sm" onclick="AccountUsage.closeAdminForm()">Cancel</button>
                    </div>
                    <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 12px; margin-bottom: 8px;">
                        <label style="display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted);">
                            User email
                            <input type="email" value="${this._escape(f.email)}" placeholder="floridalerches@gmail.com"
                                oninput="AccountUsage.setAdminField('email', this.value)"
                                ${f.busy ? 'disabled' : ''}
                                style="padding: 8px 10px; border: 1px solid var(--border, #d1d5db); border-radius: 4px; font-size: 14px;">
                        </label>
                        <label style="display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted);">
                            Amount (USD)
                            <input type="number" min="0.01" max="1000" step="0.01" value="${this._escape(f.amount)}"
                                oninput="AccountUsage.setAdminField('amount', this.value)"
                                ${f.busy ? 'disabled' : ''}
                                style="padding: 8px 10px; border: 1px solid var(--border, #d1d5db); border-radius: 4px; font-size: 14px;">
                        </label>
                    </div>
                    <label style="display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">
                        Note (optional)
                        <input type="text" value="${this._escape(f.note)}" placeholder="Testing credit flow"
                            oninput="AccountUsage.setAdminField('note', this.value)"
                            ${f.busy ? 'disabled' : ''}
                            style="padding: 8px 10px; border: 1px solid var(--border, #d1d5db); border-radius: 4px; font-size: 14px;">
                    </label>
                    ${f.error ? `<div style="color: var(--status-error, #c00); font-size: 13px; margin-bottom: 8px;">${this._escape(f.error)}</div>` : ''}
                    <button class="btn btn-primary btn-sm" ${f.busy ? 'disabled' : ''}
                        onclick="AccountUsage.submitAdminForm()">
                        ${f.busy ? 'Granting…' : 'Grant credits'}
                    </button>
                </div>
            </div>`;
    },

    _renderRangeBar() {
        const ranges = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['month', 'This month'], ['year', 'This year']];
        return `
            <div style="display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap;">
                ${ranges.map(([id, label]) => `
                    <button class="btn ${this._activeRange === id ? 'btn-primary' : 'btn-secondary'} btn-sm"
                        onclick="AccountUsage.setRange('${id}')">${label}</button>`).join('')}
            </div>`;
    },

    _renderSummaryCard() {
        const rows = this._summary?.by_service || [];
        if (rows.length === 0) {
            return `
                <div class="card" style="margin-bottom: 20px;"><div class="card-body" style="color: var(--text-muted); text-align: center; padding: 32px 16px;">
                    No usage recorded in this range yet.
                </div></div>`;
        }

        // Group by SECTION: TTS + STT fold into one 'Speech' section (Deepgram
        // STT rows land beside ElevenLabs since the streaming-STT logging), and
        // image search files under Tools with web search (John, 2026-07-12).
        const sectionOf = (svc) => (svc === 'tts' || svc === 'stt') ? 'speech'
            : (svc === 'image_search' ? 'web_search' : svc);
        const groups = new Map();
        for (const r of this._mergeLiveTextRows(rows)) {
            const key = sectionOf(r.service);
            const g = groups.get(key) || [];
            g.push(r);
            groups.set(key, g);
        }
        const order = ['ai', 'speech', 'web_search'];
        const sections = order.filter(s => groups.has(s)).map(svc => {
            const items = groups.get(svc);
            const total = items.reduce((sum, r) => sum + this._costForRow(r), 0);
            const open = this._expandedServices.has(svc);
            const caret = open ? '▾' : '▸';
            const itemRows = open ? items.map(r => this._summaryItemRow(r)).join('') : '';
            return `
                <tr><td colspan="4" onclick="AccountUsage.toggleService('${svc}')"
                    style="padding: 14px 12px 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); cursor: pointer;">
                    <span style="display: inline-block; width: 12px; color: var(--text-muted);">${caret}</span>
                    ${this._escape(this._serviceLabel(svc))}
                    <span style="float: right; color: var(--text-primary); font-weight: 600;">${this._fmtCostTotal(total)}</span>
                </td></tr>
                ${itemRows}`;
        }).join('');

        const grand = rows.reduce((sum, r) => sum + this._costForRow(r), 0);
        return `
            <div class="card" style="margin-bottom: 20px;"><div class="card-body table-scroll" style="padding: 0;">
                <table style="width: 100%; border-collapse: collapse;">
                    <tbody>${sections}</tbody>
                    <tfoot>
                        <tr style="border-top: 1px solid var(--border, #e5e7eb);">
                            <td style="padding: 12px; font-weight: 600;">Total</td>
                            <td colspan="2"></td>
                            <td style="padding: 12px; text-align: right; font-weight: 700;">${this._fmtCostTotal(grand)}</td>
                        </tr>
                    </tfoot>
                </table>
            </div></div>`;
    },

    /** Fold each Live model's ':text' companion row into its base-model row
     *  for the by-model summary (John, 2026-07-12). Live billing logs audio
     *  and text tokens as separate rows (different rates); one turn produces
     *  both, so costs/tokens sum but call_count stays the base row's. The
     *  interaction drill-down keeps its Voice/Text detail. Display-only. */
    _mergeLiveTextRows(rows) {
        const out = [];
        const baseByModel = new Map();
        const textRows = [];
        // Key includes byok so a metered row and an API-key row of the same
        // model never merge (they're separate summary groups server-side too).
        const keyOf = (r) => `${r.model}|${r.byok ? 'byok' : ''}`;
        for (const r of rows) {
            if (r.service === 'ai' && typeof r.model === 'string' && r.model.endsWith(':text')) {
                textRows.push(r);
                continue;
            }
            if (r.service === 'ai' && r.model) baseByModel.set(keyOf(r), { ...r });
            out.push(r.service === 'ai' && r.model ? baseByModel.get(keyOf(r)) : r);
        }
        for (const t of textRows) {
            const base = baseByModel.get(keyOf({ ...t, model: t.model.slice(0, -':text'.length) }));
            if (!base) { out.push(t); continue; }   // orphan — show rather than hide
            base.actual_cost_usd = (Number(base.actual_cost_usd) || 0) + (Number(t.actual_cost_usd) || 0);
            base.input_tokens = (base.input_tokens || 0) + (t.input_tokens || 0);
            base.output_tokens = (base.output_tokens || 0) + (t.output_tokens || 0);
        }
        return out;
    },

    _summaryItemRow(r) {
        // BYOK rows never debit — show the marker, not a misleading $0.00.
        const costCell = r.byok ? 'API key' : this._fmtCost(this._costForRow(r));
        const subtitle = r.service === 'ai'
            ? `${this._fmtCount(r.input_tokens)} in / ${this._fmtCount(r.output_tokens)} out`
            : (r.service === 'web_search' || r.service === 'image_search')
                ? `${this._fmtCount(r.call_count)} searches`
                : `${this._fmtCount(r.call_count)} calls`;
        return `
            <tr style="border-top: 1px solid var(--border, #e5e7eb);">
                <td style="padding: 8px 12px 8px 36px; font-size: 13px; width: 35%;">${this._escape(this._summaryItemName(r))}</td>
                <td style="padding: 8px 12px; font-size: 12px; color: var(--text-muted);">${this._escape(r.provider || '')}</td>
                <td style="padding: 8px 12px; font-size: 12px; color: var(--text-muted); text-align: right;">${this._fmtCount(r.call_count)} · ${this._escape(subtitle)}</td>
                <td style="padding: 8px 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; text-align: right;">${this._escape(costCell)}</td>
            </tr>`;
    },

    /** Breakdown card: header + view selector (List / Daily Graph / Monthly Graph)
     *  over the body. List is the per-day drill-down (month-grouped in year range);
     *  the graphs are stacked AI/Speech/Tools bars from UsageChart. */
    _renderBreakdownCard() {
        const days = this._daily?.days || [];
        if (days.length === 0) return '';
        return `
            <div class="card"><div class="card-body table-scroll" style="padding: 0;">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; padding: 10px 16px; border-bottom: 1px solid var(--border, #e5e7eb);">
                    <span style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted);">Breakdown</span>
                    ${this._renderBreakdownSelector()}
                </div>
                ${this._renderBreakdownBody(days)}
            </div></div>`;
    },

    _renderBreakdownSelector() {
        const views = [['list', 'List'], ['daily', 'Daily Graph'], ['monthly', 'Monthly Graph']];
        return `<div style="display:inline-flex; gap:4px;">
            ${views.map(([id, label]) => `
                <button class="btn ${this._breakdownView === id ? 'btn-primary' : 'btn-secondary'} btn-sm"
                    onclick="AccountUsage.setBreakdownView('${id}')">${label}</button>`).join('')}
        </div>`;
    },

    setBreakdownView(v) {
        if (v === this._breakdownView) return;
        this._breakdownView = v;
        App.renderPage();
    },

    _renderBreakdownBody(days) {
        if (this._breakdownView === 'daily') {
            // Span the range ascending (earliest left) with missing days filled as
            // zero bars (gaps), then trim the empty run before the first / after
            // the last day with usage, then cap to the most recent N.
            const filled = this._filledDays();
            const all = UsageChart.trimEmptyEnds(UsageChart.dayBuckets(filled, this._chartBucketFn, this._chartCostFn));
            const cap = this.DAILY_GRAPH_CAP;
            const capped = all.length > cap ? all.slice(-cap) : all;
            const note = all.length > cap
                ? `Showing the most recent ${cap} days — switch to Monthly Graph for the full range.`
                : '';
            return UsageChart.render(capped, { note });
        }
        if (this._breakdownView === 'monthly') {
            return UsageChart.render(UsageChart.trimEmptyEnds(UsageChart.monthBuckets(this._filledDays(), this._chartBucketFn, this._chartCostFn)));
        }
        // List view — month-grouped in year range, flat day rows otherwise.
        return this._activeRange === 'year'
            ? this._renderYearList(days)
            : days.map(d => this._renderDayRow(d)).join('');
    },

    /** row → chart bucket key ('ai' | 'speech' | 'tools'). Reuses _svcGroup
     *  (tts/stt → speech) and folds web_search → tools. Bound for UsageChart. */
    _chartBucketFn(r) {
        const g = AccountUsage._svcGroup(r.service);
        return (g === 'web_search' || g === 'image_search') ? 'tools' : g;
    },
    _chartCostFn(r) { return AccountUsage._costForRow(r); },

    /** Complete ascending day list across the active range, merging the sparse
     *  server rows in and filling absent days with an empty bucket — so the
     *  graphs sort earliest-first and render gaps where there was no usage. */
    _filledDays() {
        const byDate = new Map((this._daily?.days || []).map(d => [d.date, d]));
        const { start, end } = this._rangeBounds();
        const out = [];
        const cur = this._localMidnight(new Date(start));
        const last = this._localMidnight(new Date(end));
        for (let i = 0; cur <= last && i < 800; i++) {        // 800 = safety cap for custom ranges
            const ds = cur.toLocaleDateString('en-CA');       // local 'YYYY-MM-DD'
            out.push(byDate.get(ds) || { date: ds, by_service: [] });
            cur.setDate(cur.getDate() + 1);
        }
        return out;
    },

    _localMidnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); },

    // ── year list: current month daily, prior months collapsed ──

    _renderYearList(days) {
        const sorted = [...days].sort((a, b) => (a.date < b.date ? 1 : -1));   // newest first
        const curPrefix = new Date().toLocaleDateString('en-CA').slice(0, 7);   // local 'YYYY-MM'
        const current = sorted.filter(d => d.date.startsWith(curPrefix));
        const prior = sorted.filter(d => !d.date.startsWith(curPrefix));
        // Preserve newest-first month order while grouping.
        const order = [], byMonth = new Map();
        for (const d of prior) {
            const ym = d.date.slice(0, 7);
            if (!byMonth.has(ym)) { byMonth.set(ym, []); order.push(ym); }
            byMonth.get(ym).push(d);
        }
        return current.map(d => this._renderDayRow(d)).join('')
            + order.map(ym => this._renderMonthGroup(ym, byMonth.get(ym))).join('');
    },

    _renderMonthGroup(ym, monthDays) {
        const open = this._expandedMonths.has(ym);
        const caret = open ? '▾' : '▸';
        const allRows = monthDays.flatMap(d => d.by_service || []);
        const total = allRows.reduce((s, r) => s + this._costForRow(r), 0);
        const pills = this._dayServicePills(allRows);
        const detail = open ? monthDays.map(d => this._renderDayRow(d)).join('') : '';
        return `
            <div style="border-bottom: 1px solid var(--border, #e5e7eb);">
                <div onclick="AccountUsage.toggleMonth('${ym}')"
                    style="display:flex; align-items:center; gap:12px; padding:10px 16px; cursor:pointer; background:var(--surface-muted,#fafafa);">
                    <span style="color:var(--text-muted); width:12px;">${caret}</span>
                    <span style="font-size:13px; font-weight:600; min-width:110px;">${this._escape(this._fmtMonthLong(ym))}</span>
                    <span style="flex:1; font-size:12px; color:var(--text-muted);">${pills}</span>
                    <span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:13px; font-weight:600;">${this._fmtCostTotal(total)}</span>
                </div>
                ${detail}
            </div>`;
    },

    toggleMonth(ym) {
        if (this._expandedMonths.has(ym)) this._expandedMonths.delete(ym);
        else this._expandedMonths.add(ym);
        App.renderPage();
    },

    _fmtMonthLong(ym) {
        try {
            const [y, m] = ym.split('-').map(Number);
            return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
        } catch { return ym; }
    },

    _renderDayRow(d) {
        const expanded = this._expandedDays.get(d.date);
        const total = (d.by_service || []).reduce((sum, r) => sum + this._costForRow(r), 0);
        const pills = this._dayServicePills(d.by_service || []);
        const count = d.interaction_count;
        const sparkline = (count != null)
            ? `${count} Voice Interaction${count === 1 ? '' : 's'}${pills ? ` (${pills})` : ''}`
            : pills;
        const caret = expanded ? '▾' : '▸';

        let detail = '';
        if (expanded) {
            if (expanded.loading) {
                detail = `<div style="padding: 12px 32px; color: var(--text-muted); font-size: 13px;">Loading calls…</div>`;
            } else if (expanded.error) {
                detail = `<div style="padding: 12px 32px; color: var(--status-error, #c00); font-size: 13px;">Error: ${this._escape(expanded.error)}</div>`;
            } else {
                const interactions = expanded.interactions || [];
                if (interactions.length === 0) {
                    detail = `<div style="padding: 12px 32px; color: var(--text-muted); font-size: 13px;">No calls recorded.</div>`;
                } else {
                    detail = `<div style="padding: 2px 16px 10px 40px;">
                        ${interactions.map(i => this._renderInteractionRow(i)).join('')}
                    </div>`;
                }
            }
        }

        return `
            <div style="border-bottom: 1px solid var(--border, #e5e7eb);">
                <div onclick="AccountUsage.toggleDay('${d.date}')"
                    style="display: flex; align-items: center; gap: 12px; padding: 10px 16px; cursor: pointer;">
                    <span style="color: var(--text-muted); width: 12px;">${caret}</span>
                    <span style="font-size: 13px; font-weight: 500; min-width: 110px;">${this._escape(this._fmtDate(d.date))}</span>
                    <span style="flex: 1; font-size: 12px; color: var(--text-muted);">${sparkline}</span>
                    <span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; font-weight: 600;">${this._fmtCostTotal(total)}</span>
                </div>
                ${detail}
            </div>`;
    },

    // TTS + STT are both "Speech"; group them so the breakdown reads naturally.
    _svcGroup(svc) { return (svc === 'tts' || svc === 'stt') ? 'speech' : svc; },
    _svcLabel(svc) { return { ai: 'AI', speech: 'Speech', tts: 'Speech', stt: 'Speech', web_search: 'Search', image_search: 'Images' }[svc] || svc; },
    _SVC_ORDER: { ai: 0, speech: 1, web_search: 2, image_search: 3 },

    _dayServicePills(rows) {
        const byService = new Map();
        for (const r of rows) {
            const cost = this._costForRow(r);
            const g = this._svcGroup(r.service);
            byService.set(g, (byService.get(g) || 0) + cost);
        }
        return Array.from(byService.entries())
            .filter(([_, c]) => c > 0)
            .sort((a, b) => (this._SVC_ORDER[a[0]] ?? 9) - (this._SVC_ORDER[b[0]] ?? 9))
            .map(([svc, c]) => `${this._svcLabel(svc)} ${this._fmtCostTotal(c)}`)
            .join(' · ');
    },

    /** USD cost of a single drill-down item. Prefers the ACTUAL margined charge
     *  debited for this call (joined server-side from credit_deductions) — it
     *  matches the day total and is the only way to cost TTS/STT, which have no
     *  token-based estimate (that's why those line items used to read $0.00).
     *  Falls back to a client-side catalog estimate for legacy rows that predate
     *  credit_deductions. */
    _itemCost(c) {
        // BYOK turns ran on the user's own key — Dashie charged nothing, so they
        // contribute $0 to an interaction total even though ai_interactions carries a
        // COMPUTED cost for reference. Without this the total showed a phantom "<$0.01"
        // on an all-API-key turn (John, 2026-07-13).
        if (c.byok) return 0;
        if (c.actual_cost_usd != null) return Number(c.actual_cost_usd) || 0;
        const C = window.AiModelCatalog;
        if (!C) return 0;
        if (c.service === 'ai') {
            const rates = c.model ? C.pricingFor(c.model) : null;
            if (!rates) return 0;
            return ((c.input_tokens || 0) * rates[0] + (c.output_tokens || 0) * rates[1]) / 1_000_000;
        }
        if (c.service === 'web_search' || c.service === 'image_search') {
            return C.searchCost({ provider: c.provider, count: 1 });
        }
        return 0;
    },

    /** One voice interaction (a turn): summary row, expandable to its items. */
    _renderInteractionRow(intr) {
        const items = intr.items || [];
        const total = items.reduce((s, c) => s + this._itemCost(c), 0);
        const open = this._expandedInteractions.has(intr.key);
        const caret = open ? '▾' : '▸';
        const time = (() => {
            try { return new Date(intr.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
            catch { return intr.ts; }
        })();
        if (intr.realtime || items.some(c => c.request_type === 'realtime')) {
            return this._renderRealtimeInteractionRow(intr, items, total, open, caret, time);
        }
        // A multi-turn cascade dialog reads as a conversation ("N turns"), not "AI
        // (complex)" — the multi-pass badge misfires when several turns share a session.
        // Thread the turns (like the realtime path) instead of collapsing to turn 1.
        const dialogTurns = (intr.turns && intr.turns.length > 1) ? intr.turns : null;
        const counts = {};
        for (const it of items) { const g = this._svcGroup(it.service); counts[g] = (counts[g] || 0) + 1; }
        const mix = Object.entries(counts)
            .sort((a, b) => (this._SVC_ORDER[a[0]] ?? 9) - (this._SVC_ORDER[b[0]] ?? 9))
            .map(([s, n]) => {
                // AI with 2+ passes = a two-pass (tool/complex) turn; 1 pass = simple.
                // Mirrors the COMPLEX/SIMPLE badge in the Recent Interactions tab.
                if (s === 'ai') return n >= 2 ? 'AI (complex)' : 'AI (simple)';
                return `${this._svcLabel(s)}${n > 1 ? ' ×' + n : ''}`;
            })
            .join(' · ');
        const label = dialogTurns
            ? `Conversation · ${dialogTurns.length} turns`
            : `${mix} · ${items.length} call${items.length === 1 ? '' : 's'}`;
        const grouped = this._groupCallItems(items);
        const meteredServices = new Set(grouped.map(g => g.service));
        const body = open
            ? `<div style="padding-left: 24px;">
                 ${dialogTurns ? this._renderRealtimeTranscript(dialogTurns) : this._renderTranscript(intr)}
                 <table style="width: 100%; border-collapse: collapse; font-size: 12px; margin: 0 0 6px;"><tbody>
                    ${grouped.map(g => this._renderGroupedCallRow(g)).join('')}
                    ${this._renderLocalTimingRows(intr.local_timing, meteredServices)}
                 </tbody></table>
               </div>`
            : '';
        return `
            <div style="border-bottom: 1px solid var(--border, #f0f0f0);">
                <div onclick="event.stopPropagation(); AccountUsage.toggleInteraction('${this._escape(intr.key)}')"
                    style="display: flex; align-items: center; gap: 10px; padding: 7px 0; cursor: pointer;">
                    <span style="color: var(--text-muted); width: 12px; font-size: 11px;">${caret}</span>
                    <span style="color: var(--text-muted); width: 76px; font-size: 12px;">${this._escape(time)}</span>
                    <span style="flex: 1; font-size: 12px;">${this._escape(label)}</span>
                    <span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; font-weight: 600;">${this._fmtCostTotal(total)}</span>
                </div>
                ${body}
            </div>`;
    },

    /** Realtime "conversation mode" interaction: collapse the per-modality
     *  token_usage rows (audio model + `:text` companion) into ONE "AI" billing
     *  line — the modality split is a billing detail, not something the user
     *  should have to decode (John, 2026-07-12) — and show the conversation
     *  transcript as turns. */
    _renderRealtimeInteractionRow(intr, items, total, open, caret, time) {
        const isText = (m) => typeof m === 'string' && m.endsWith(':text');
        const roll = (filterFn) => items.filter(filterFn).reduce((a, c) => ({
            cost: a.cost + this._itemCost(c),
            inTok: a.inTok + (c.input_tokens || 0),
            outTok: a.outTok + (c.output_tokens || 0),
        }), { cost: 0, inTok: 0, outTok: 0 });
        // One AI rollup over all the token rows. Tool calls (image/web search)
        // are discrete — render each as its own row, like a normal turn.
        const ai = roll(c => c.service === 'ai');
        const toolItems = items.filter(c => c.service !== 'ai');
        const turns = intr.turns || [];
        const turnCount = turns.length || items.filter(c => c.service === 'ai' && !isText(c.model)).length;
        const mix = `Conversation · ${turnCount} turn${turnCount === 1 ? '' : 's'}`;
        const rollupRow = (label, g) => `
            <tr>
                <td style="padding: 4px 0; color: var(--text-muted); width: 60px; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px;">${label}</td>
                <td style="padding: 4px 8px;">${this._fmtCount(g.inTok)} in / ${this._fmtCount(g.outTok)} out</td>
                <td style="padding: 4px 0; text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;">${this._fmtCost3(g.cost)}</td>
            </tr>`;
        const has = (g) => g.cost || g.inTok || g.outTok;
        const body = open
            ? `<div style="padding-left: 24px;">
                 ${this._renderRealtimeTranscript(turns)}
                 <table style="width: 100%; border-collapse: collapse; font-size: 12px; margin: 0 0 6px;"><tbody>
                    ${has(ai) ? rollupRow('AI', ai) : ''}
                    ${this._groupCallItems(toolItems).map(g => this._renderGroupedCallRow(g)).join('')}
                 </tbody></table>
               </div>`
            : '';
        return `
            <div style="border-bottom: 1px solid var(--border, #f0f0f0);">
                <div onclick="event.stopPropagation(); AccountUsage.toggleInteraction('${this._escape(intr.key)}')"
                    style="display: flex; align-items: center; gap: 10px; padding: 7px 0; cursor: pointer;">
                    <span style="color: var(--text-muted); width: 12px; font-size: 11px;">${caret}</span>
                    <span style="color: var(--text-muted); width: 76px; font-size: 12px;">${this._escape(time)}</span>
                    <span style="flex: 1; font-size: 12px;">${this._escape(mix)}</span>
                    <span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; font-weight: 600;">${this._fmtCostTotal(total)}</span>
                </div>
                ${body}
            </div>`;
    },

    /** Conversation transcript (realtime) as a You/Dashie thread. */
    _renderRealtimeTranscript(turns) {
        if (!turns || !turns.length || !turns.some(t => t.prompt || t.response)) return '';
        const line = (label, val) => `
            <div style="margin: 0 0 4px;">
                <span style="color: var(--text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;">${label}</span>
                <div style="font-size: 12px; line-height: 1.4;">${this._escape(val)}</div>
            </div>`;
        const turn = (t, last) => `
            <div style="margin: 0 0 ${last ? '0' : '8px'}; padding: 0 0 ${last ? '0' : '8px'}; ${last ? '' : 'border-bottom: 1px dashed var(--border, #e5e7eb);'}">
                ${t.prompt ? line('You said', t.prompt) : ''}
                ${t.response ? line(`${BRAND.assistantName} said`, t.response) : ''}
            </div>`;
        return `<div style="background: var(--surface-muted, #f7f7f8); border-radius: 8px; padding: 8px 10px; margin: 0 0 8px;">
            ${turns.map((t, i) => turn(t, i === turns.length - 1)).join('')}
        </div>`;
    },

    /** Retained transcript for one interaction (only present when the account
     *  opted into "Keep transcripts"). Build plan §17. */
    _renderTranscript(intr) {
        if (!intr || (!intr.prompt && !intr.response)) return '';
        const line = (label, val) => `
            <div style="margin: 0 0 4px;">
                <span style="color: var(--text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;">${label}</span>
                <div style="font-size: 12px; line-height: 1.4;">${this._escape(val)}</div>
            </div>`;
        return `
            <div style="background: var(--surface-muted, #f7f7f8); border-radius: 8px; padding: 8px 10px; margin: 0 0 8px;">
                ${intr.prompt ? line('You said', intr.prompt) : ''}
                ${intr.response ? line(`${BRAND.assistantName} replied`, intr.response) : ''}
            </div>`;
    },

    _renderCallRow(c) {
        const cost = this._itemCost(c);
        // Per-call time is redundant — the interaction header already shows it
        // (every pass of one turn lands within the same minute).
        const desc = c.service === 'ai'
            ? `${this._escape(c.model || '—')}${c.byok ? ' (API key)' : ''} (${this._fmtCount(c.input_tokens)} in / ${this._fmtCount(c.output_tokens)} out)`
            : c.service === 'web_search'
                ? `${this._escape(c.provider || '')} (${this._fmtCount(c.result_count || 0)} results)`
                : c.service === 'image_search'
                    ? `${this._escape(c.provider || '')} (${this._fmtCount(c.result_count || 0)} images)`
                    : (c.service === 'stt' || c.service === 'tts')
                        // Deepgram STT / ElevenLabs TTS lines inside a voice
                        // interaction, under the AI pass (anchor-attached
                        // server-side when the row predates the session id).
                        ? `${this._escape(c.model || c.provider || '—')} (${c.service === 'stt' ? 'speech-to-text' : 'text-to-speech'})`
                        : `${this._escape(c.provider || '')} ${c.service}`;
        return `
            <tr>
                <td style="padding: 4px 0; color: var(--text-muted); width: 60px; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px;">${this._escape(this._svcLabel(c.service))}</td>
                <td style="padding: 4px 8px;">${desc}</td>
                <td style="padding: 4px 0; text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;">${c.byok ? 'API key' : this._fmtCost3(cost)}</td>
            </tr>`;
    },

    /** Collapse an interaction's call items to one row per (service, model,
     *  provider, byok): repeated STT/TTS passes and multi-pass AI read as a
     *  single summed line (×N) instead of an interleaved list that rendered
     *  newest-first and so didn't track the transcript order (John, 2026-07-12).
     *  Ordered speak-first — AI, then STT (you), TTS (Dashie), then tools —
     *  so the rows follow the conversation. byok never merges with metered. */
    _CALL_ROW_ORDER: { ai: 0, stt: 1, tts: 2, web_search: 3, image_search: 4 },
    _groupCallItems(items) {
        const groups = new Map();
        for (const c of items) {
            // Key on the display_model (Dashie engine name) when present so the
            // premium and personality tiers group separately even though both are
            // ElevenLabs under the hood.
            const key = `${c.service}|${c.display_model || c.model || c.provider || ''}|${c.byok ? 'k' : ''}`;
            let g = groups.get(key);
            if (!g) {
                g = { service: c.service, model: c.model, provider: c.provider, display_model: c.display_model, byok: c.byok,
                      count: 0, cost: 0, input_tokens: 0, output_tokens: 0, result_count: 0 };
                groups.set(key, g);
            }
            g.count += 1;
            g.cost += this._itemCost(c);
            g.input_tokens += c.input_tokens || 0;
            g.output_tokens += c.output_tokens || 0;
            g.result_count += c.result_count || 0;
        }
        return Array.from(groups.values())
            .sort((a, b) => (this._CALL_ROW_ORDER[a.service] ?? 9) - (this._CALL_ROW_ORDER[b.service] ?? 9));
    },

    /** One grouped call row (see _groupCallItems). ×N shown when >1 pass. */
    _renderGroupedCallRow(g) {
        const times = g.count > 1 ? ` ×${g.count}` : '';
        // Prefer the Dashie engine name (display_model) — it's self-descriptive, so
        // the redundant "(speech-to-text)" suffix is dropped when it's present.
        const desc = g.service === 'ai'
            ? `${this._escape(g.model || '—')}${g.byok ? ' (API key)' : ''} (${this._fmtCount(g.input_tokens)} in / ${this._fmtCount(g.output_tokens)} out)${times}`
            : g.service === 'web_search'
                ? `${this._escape(g.display_model || g.provider || '')} (${this._fmtCount(g.result_count)} results)${times}`
                : g.service === 'image_search'
                    ? `${this._escape(g.display_model || g.provider || '')} (${this._fmtCount(g.result_count)} images)${times}`
                    : (g.service === 'stt' || g.service === 'tts')
                        ? (g.display_model
                            ? `${this._escape(g.display_model)}${times}`
                            : `${this._escape(g.model || g.provider || '—')} (${g.service === 'stt' ? 'speech-to-text' : 'text-to-speech'})${times}`)
                        : `${this._escape(g.provider || '')} ${g.service}${times}`;
        return `
            <tr>
                <td style="padding: 4px 0; color: var(--text-muted); width: 60px; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px;">${this._escape(this._svcLabel(g.service))}</td>
                <td style="padding: 4px 8px;">${desc}</td>
                <td style="padding: 4px 0; text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;">${g.byok ? 'API key' : this._fmtCost3(g.cost)}</td>
            </tr>`;
    },

    /** Friendly name for a local engine id (HA entity id like "stt.faster_whisper"
     *  or a bare id) → "Whisper (local)". These run on the user's HA box for free. */
    _localEngineLabel(engine) {
        if (!engine) return 'Local';
        const e = String(engine).replace(/^(stt|tts)\./, '').toLowerCase();
        const known = { faster_whisper: 'Whisper', whisper: 'Whisper', piper: 'Piper', local: 'Local TTS', kokoro: 'Kokoro' };   // 'kokoro' = legacy rows (pre-2026-07-13 the local transport misreported itself)
        const base = known[e] || (e.charAt(0).toUpperCase() + e.slice(1));
        return `${base} (local)`;
    },

    /** Free local STT/TTS step rows from voice_turn_timing (engine + avg latency, "$-").
     *  Local Whisper/Piper on the HA box have no billing row, so this is the only place
     *  they surface. Suppressed for a stage that already has a METERED (cloud) row in
     *  this interaction — a cloud turn also writes a timing row; don't double-show it. */
    _renderLocalTimingRows(timing, meteredServices) {
        if (!timing) return '';
        const row = (svc, t, dir) => {
            if (!t || !t.engine || meteredServices.has(svc)) return '';
            const n = t.count || 1;
            const ms = n ? Math.round((t.ms_total || 0) / n) : (t.ms_total || 0);
            const times = n > 1 ? ` ×${n}` : '';
            return `
                <tr>
                    <td style="padding: 4px 0; color: var(--text-muted); width: 60px; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px;">${this._escape(this._svcLabel(svc))}</td>
                    <td style="padding: 4px 8px;">${this._escape(this._localEngineLabel(t.engine))} · ${dir}${times} · ${this._fmtCount(ms)}ms</td>
                    <td style="padding: 4px 0; text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text-muted);">$-</td>
                </tr>`;
        };
        return row('stt', timing.stt, 'speech-to-text') + row('tts', timing.tts, 'text-to-speech');
    },

    // ── helpers used by stat strip ───────────────────────────

    /** The browser's IANA timezone, sent to the server for local-day bucketing. */
    _tz() {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; }
        catch { return null; }
    },

    _todayDate() {
        // Local calendar day ('YYYY-MM-DD'), matching the server's local bucketing.
        return new Date().toLocaleDateString('en-CA');
    },

    _totalCostForDay(dateStr) {
        // Range-independent: always read the current-month fetch, not the selected range.
        if (!this._monthDaily?.days) return null;
        const row = this._monthDaily.days.find(d => d.date === dateStr);
        if (!row) return 0;
        return (row.by_service || []).reduce((sum, r) => sum + this._costForRow(r), 0);
    },

    _totalCostForMonth() {
        // Range-independent: always read the current-month fetch.
        if (!this._monthDaily?.days) return null;
        const prefix = new Date().toLocaleDateString('en-CA').slice(0, 7) + '-';  // local 'YYYY-MM-'
        return this._monthDaily.days
            .filter(d => d.date.startsWith(prefix))
            .reduce((sum, d) => sum + (d.by_service || []).reduce((s, r) => s + this._costForRow(r), 0), 0);
    },

    /** Local calendar week start (Sunday 00:00). Drives the stat-window fetch and
     *  the "This week" total. For a Monday-start week, replace `- d.getDay()` with
     *  `- ((d.getDay() + 6) % 7)`. */
    _weekStart() {
        const now = new Date();
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        d.setDate(d.getDate() - d.getDay());  // back up to Sunday
        return d;
    },

    _totalCostForWeek() {
        // Range-independent: read the dedicated stat-window fetch (covers the week
        // even when it spans into the prior month).
        if (!this._monthDaily?.days) return null;
        const ws = this._weekStart().toLocaleDateString('en-CA');  // local 'YYYY-MM-DD'
        return this._monthDaily.days
            .filter(d => d.date >= ws)
            .reduce((sum, d) => sum + (d.by_service || []).reduce((s, r) => s + this._costForRow(r), 0), 0);
    },

    _escape(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
};

window.AccountUsage = AccountUsage;
