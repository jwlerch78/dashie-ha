/* ============================================================
   Usage Page — the box-local usage record, for an account-less box.
   ------------------------------------------------------------
   🔴 LOCAL MODE ONLY, and deliberately a SEPARATE page from Credits
   rather than a mode of it.

   Credits hosts the signed-in usage view (AccountUsage): balance,
   cost, expiry, per-call drill-down — all of it Supabase-shaped and
   all of it money. An account-less box has none of that: no account,
   no JWT, no `ai_interactions`, no cost. Bending that page to render
   without its own subject matter would mean either faking money or
   blanking most of it.

   What the box DOES have is `/data/usage.json`: day-bucketed,
   metadata-only, calls/errors/units per provider|model|billing. That
   is a smaller and different thing, and it gets a page that is honest
   about being smaller rather than a hollowed-out copy of a bigger one.

   ⚠️ `credits` stays ACCOUNT_LOCKED in local mode exactly as ruled
   (2026-08-01) — this page does not unlock it, replace it, or argue
   with it. It is additive.
   ============================================================ */

const UsagePage = {
    _rows: null,
    _loading: false,
    _error: null,
    _daysAvailable: 0,
    _retentionDays: 0,
    _daysServed: 0,
    _range: 30,

    topBarTitle() { return 'Usage'; },
    topBarSubtitle() { return 'Recorded on this box'; },

    onNavigateTo() { this._fetch(); },
    async refresh() { await this._fetch(); },

    async _fetch() {
        if (this._loading) return;
        this._loading = true;
        this._error = null;
        App.renderPage();
        const r = await UsageSource.fetchLocal(this._range);
        this._rows = r.rows;
        this._daysAvailable = r.daysAvailable;
        this._retentionDays = r.retentionDays;
        // Label from what the route SERVED, not from what we asked for — it caps at
        // retention, so the two diverge the moment a range button exceeds it.
        this._daysServed = r.daysServed;
        this._error = r.error;
        this._loading = false;
        App.renderPage();
    },

    setRange(days) {
        const n = Number(days);
        if (!Number.isFinite(n) || n === this._range) return;
        this._range = n;
        this._fetch();
    },

    render() {
        // Direct hash hit (#usage on load) skips navigate().
        if (this._rows === null && !this._loading && !this._error) this._fetch();

        return `
            <div style="max-width: 900px;">
                ${this._renderScopeNote()}
                ${this._renderRangeSelector()}
                ${this._renderBody()}
            </div>`;
    },

    /**
     * 🔴 The honesty note, and it is not decoration — it is the reason this page
     * can be trusted at all. Two things a reader would otherwise assume wrongly:
     * that these numbers reached Dashie (they did not, and cannot), and what they
     * cover.
     *
     * ⚠️ 2026-08-28: this block used to disclose that the AI-model leg was UNCOUNTED.
     * B2a (row 80) added the brain lane's capture point, so that sentence became false
     * and was replaced rather than left standing. A stale caveat is not a harmless
     * leftover — it understates the record, which is a lie in the direction a reader
     * is least likely to check.
     */
    _renderScopeNote() {
        return `
            <div class="card" style="margin-bottom: 16px;">
                <div class="card-body" style="font-size: var(--font-size-sm); color: var(--text-muted);">
                    <div style="margin-bottom: 6px;">
                        <strong>This record never leaves your box.</strong>
                        Without a ${BRAND.productName} account there is no path to our servers — nothing
                        here has been sent anywhere, and there is nothing to turn off.
                    </div>
                    <div>
                        It covers all three legs of a turn — <strong>speech-to-text, the AI model,
                        and text-to-speech</strong>. No prompt or response text, and no device or
                        user identifiers, are ever stored.
                    </div>
                </div>
            </div>`;
    },

    _renderRangeSelector() {
        // Never offer a window longer than the store keeps: the route caps at retention,
        // so a 90-day button against a 60-day store silently serves 60. Filtered rather
        // than hardcoded, because retention is the SERVER's constant — row 80 moved it
        // 400→60 and a hardcoded list here would have gone stale in the same commit.
        const cap = this._retentionDays || Infinity;
        const opts = [7, 30, 90, 400].filter((d, i, a) => d <= cap || a[i - 1] === undefined || a[i - 1] < cap);
        const btns = opts.map((d) => `
            <button class="btn ${d === this._range ? 'btn-primary' : 'btn-secondary'}"
                    onclick="UsagePage.setRange(${d})">${d} days</button>`).join('');
        const retention = this._retentionDays
            ? `<span style="color: var(--text-muted); font-size: var(--font-size-sm); margin-left: 12px;">
                 ${this._daysAvailable} day${this._daysAvailable === 1 ? '' : 's'} recorded · kept for ${this._retentionDays} days
               </span>`
            : '';
        return `<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 16px;">${btns}${retention}</div>`;
    },

    _renderBody() {
        if (this._loading && this._rows === null) {
            return `<div class="card"><div class="card-body">Loading…</div></div>`;
        }
        // An unreadable record and an empty one are DIFFERENT answers — a brand-new
        // box must not be shown the same screen as a broken console.
        if (this._error) {
            return `
                <div class="card"><div class="card-body">
                    <div style="font-weight: 500; margin-bottom: 4px;">Could not read this box's usage record.</div>
                    <div style="color: var(--text-muted); font-size: var(--font-size-sm);">
                        ${DevicesPage._escape(this._error)}
                    </div>
                </div></div>`;
        }
        if (!this._rows || this._rows.length === 0) {
            return `
                <div class="card"><div class="card-body">
                    <div style="font-weight: 500; margin-bottom: 4px;">No usage recorded yet.</div>
                    <div style="color: var(--text-muted); font-size: var(--font-size-sm);">
                        Speech calls made by this box will appear here.
                    </div>
                </div></div>`;
        }

        const t = UsageSource.totals(this._rows);
        const byDay = new Map();
        for (const r of this._rows) {
            if (!byDay.has(r.day)) byDay.set(r.day, []);
            byDay.get(r.day).push(r);
        }

        const days = [...byDay.entries()].map(([day, rows]) => `
            <div style="padding: 12px 16px; border-top: 1px solid var(--border-color, #e5e5e5);">
                <div style="font-weight: 600; font-size: var(--font-size-sm); margin-bottom: 6px;">${DevicesPage._escape(day)}</div>
                ${rows.map((r) => this._renderRow(r)).join('')}
            </div>`).join('');

        return `
            <div class="card"><div class="card-body" style="padding: 0;">
                <div style="padding: 12px 16px;">
                    <strong>${t.calls}</strong> call${t.calls === 1 ? '' : 's'}
                    ${t.errors > 0 ? ` · <span style="color: var(--status-error, #c00);">${t.errors} failed</span>` : ''}
                    <span style="color: var(--text-muted);"> in the last ${this._daysServed || this._range} days</span>
                </div>
                ${days}
            </div></div>`;
    },

    _renderRow(r) {
        // Units are passed through per lane rather than flattened: TTS counts
        // characters, STT counts seconds, and one "amount" column would silently
        // add them together.
        const units = Object.entries(r.units || {})
            .map(([k, v]) => `${DevicesPage._escape(k)} ${DevicesPage._escape(String(v))}`)
            .join(' · ');
        const name = r.model ? `${r.provider} · ${r.model}` : r.provider;
        return `
            <div style="display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; font-size: var(--font-size-sm);">
                <span>${DevicesPage._escape(name)}
                    <span style="color: var(--text-muted);">(${DevicesPage._escape(r.billing)})</span></span>
                <span style="color: var(--text-muted); text-align: right;">
                    ${r.calls} call${r.calls === 1 ? '' : 's'}${r.errors ? ` · ${r.errors} failed` : ''}${units ? ` · ${units}` : ''}
                </span>
            </div>`;
    },
};
