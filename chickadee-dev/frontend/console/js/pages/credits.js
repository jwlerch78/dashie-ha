/* ============================================================
   Credits Page
   ------------------------------------------------------------
   Split out of the Account & Credits page (2026-07 Manage-nav
   restructure: Manage → Account · Credits · API Keys). Hosts the
   usage/balance view (AccountUsage — balance card, expiry, range
   selector, by-service summary, daily breakdown, admin grant) plus
   the transaction history that used to live on the Account tab.

   AccountUsage stays its own module (it predates this page and its
   inline onclick handlers reference it by name); this page owns
   navigation, the transactions fetch, and page chrome. Gated by
   FeatureGate 'credits' (beta cohort), same as the sidebar item.
   ============================================================ */

const CreditsPage = {
    _transactions: null,     // [{kind,label,amount,unit,note,ts}] — get_transactions
    _showAllTx: false,       // "Show transaction history" expand

    topBarTitle() { return 'Credits'; },
    topBarSubtitle() { return ''; },

    onNavigateTo() {
        AccountUsage.onNavigateTo();   // Stripe-return flash + full usage fetch
        this._fetchTransactions();
    },

    async refresh() {
        await Promise.all([
            // AccountUsage.refresh (not _fetchAll) also re-pulls any open day
            // drill-downs, so new interactions show without a full-site reload.
            AccountUsage.refresh(),
            this._fetchTransactions(),
        ]);
    },

    render() {
        // Direct hash hit (#credits on load) skips navigate() → kick the
        // fetches here; AccountUsage.render paints its own loading state.
        if (!AccountUsage._balance && !AccountUsage._loading && !AccountUsage._error) {
            AccountUsage._fetchAll();
        }
        if (!this._transactions) this._fetchTransactions();
        return `
            ${AccountUsage.render()}
            <div style="max-width: 800px;">
                ${this._renderTransactions()}
            </div>`;
    },

    // =========================================================

    async _fetchTransactions() {
        if (this._txLoading) return;
        this._txLoading = true;
        try {
            const r = await DashieAuth.dbRequest('get_transactions', { limit: 50 });
            // Only overwrite on a real array — a transient failure must not
            // wipe the displayed list.
            if (Array.isArray(r?.transactions)) this._transactions = r.transactions;
            App.renderPage();
        } catch (e) {
            console.error('[CreditsPage] get_transactions failed:', e);
        } finally {
            this._txLoading = false;
        }
    },

    /** Transaction history — credit purchases, auto-replenish, admin grants, and
     *  monthly/annual subscription charges (Stripe). Shows the 5 most recent with
     *  a "Show transaction history" expand. */
    _renderTransactions() {
        const tx = this._transactions || [];
        if (!tx.length) return '';
        const shown = this._showAllTx ? tx : tx.slice(0, 5);
        const rows = shown.map(t => this._txRow(t)).join('');
        const more = (!this._showAllTx && tx.length > 5)
            ? `<div style="padding: 12px 16px; border-top: 1px solid var(--border, #e5e7eb);">
                   <a href="#" onclick="event.preventDefault(); CreditsPage.showAllTransactions()" style="color: var(--accent); font-size: 13px;">Show transaction history (${tx.length})</a>
               </div>` : '';
        return `
            <div class="section-header" style="margin-top: 32px;">Transactions</div>
            <div class="card"><div class="card-body" style="padding: 0;">
                ${rows}${more}
            </div></div>`;
    },

    _txRow(t) {
        const date = (() => {
            try { return new Date(t.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
            catch { return t.ts; }
        })();
        // Subscription charges are payments ($); credit grants add credits (+$).
        const isCharge = t.kind === 'subscription_charge';
        const amt = `${isCharge ? '' : '+'}$${Number(t.amount || 0).toFixed(2)}`;
        const color = isCharge ? 'var(--text-primary)' : 'var(--status-success, #16a34a)';
        const sub = t.note ? ` · ${this._escape(t.note)}` : '';
        return `
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--border, #f0f0f0);">
                <div>
                    <div style="font-weight: 500; font-size: 13px;">${this._escape(t.label)}</div>
                    <div style="color: var(--text-muted); font-size: 11px; margin-top: 2px;">${this._escape(date)}${sub}</div>
                </div>
                <div style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; font-size: 13px; color: ${color};">${amt}</div>
            </div>`;
    },

    showAllTransactions() { this._showAllTx = true; App.renderPage(); },

    _escape(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
};

window.CreditsPage = CreditsPage;
