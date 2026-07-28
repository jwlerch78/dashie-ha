/* ============================================================
   Buy Credits Modal
   ------------------------------------------------------------
   Amount picker for a one-time credit purchase ($5 / $10 / $25).
   Body-attached (modeled on ConfirmModal) so it survives an
   App.renderPage() and works opened from any page/tab.

   Checkout has two modes, decided here:
     - Standalone browser: navigate the page to Stripe (today's flow).
     - HA ingress iframe: Stripe refuses to be framed, so we render
       a user-clickable "Continue to checkout" anchor (target=_blank)
       — mirroring the device-flow login pop-out — and POLL the
       balance until the webhook grants, then show success in-place.

   Usage:
       BuyCreditsModal.open({
           packs: [{usd, price_id}, ...],
           getCheckoutUrl: async (priceId) => '<stripe url>',  // CreditsControls.buyCredits
           getQuote: async () => ({ fee_terms, packs:[{price_id,credits_usd,fee_usd,total_usd}] }),  // optional
       });
   ============================================================ */

const BuyCreditsModal = {
    _root: null,
    _onKeyDown: null,
    _pollTimer: null,
    _pollDeadline: 0,
    _getCheckoutUrl: null,
    _getQuote: null,
    _packs: null,

    open({ packs, getCheckoutUrl, getQuote }) {
        this._closeImmediate();   // collapse any prior instance
        this._getCheckoutUrl = getCheckoutUrl;
        this._getQuote = getQuote || null;
        this._packs = packs || [];
        this._render(packs || []);
        this._loadFeeNote();
    },

    _render(packs) {
        // Each pack is a column: the amount button + a per-pack fee caption filled
        // in by _loadFeeNote() from the server quote (empty when the fee is off).
        const cells = packs.map(p => `
            <div style="flex:1; min-width:80px; display:flex; flex-direction:column; gap:6px;">
                <button data-bc-price="${this._escape(p.price_id)}"
                    style="width:100%; display:flex; align-items:center; justify-content:center;
                           padding:20px 0; font-size:20px; font-weight:700; color:#fff; cursor:pointer;
                           background:var(--accent); border:1px solid var(--accent); border-radius:10px;
                           transition:background 0.15s;"
                    onmouseover="this.style.background='var(--accent-hover)'"
                    onmouseout="this.style.background='var(--accent)'">
                    $${p.usd}
                </button>
                <div data-bc-fee-for="${this._escape(p.price_id)}"
                     style="text-align:center; color:var(--text-muted); font-size:11px; min-height:14px;"></div>
            </div>`).join('');

        const root = document.createElement('div');
        root.className = 'modal-backdrop';
        root.innerHTML = `
            <div class="modal" role="dialog" aria-modal="true" aria-labelledby="bc-title" style="max-width: 440px;">
                <div class="modal-header">
                    <div class="modal-title" id="bc-title">Buy credits</div>
                    <button class="modal-close" data-bc="cancel" aria-label="Close">&times;</button>
                </div>
                <div class="modal-body" data-bc-body>
                    <div style="display:flex; gap:10px; align-items:flex-start;">${cells}</div>
                    <div style="color: var(--text-muted); font-size:11px; margin-top:10px;">1 credit = $1 USD · credits expire 1 year after purchase.</div>
                </div>
            </div>`;

        root.addEventListener('click', e => { if (e.target === root) this._cancel(); });
        root.querySelector('[data-bc="cancel"]').addEventListener('click', () => this._cancel());
        root.querySelectorAll('[data-bc-price]').forEach(btn => {
            btn.addEventListener('click', () => this._pick(btn.getAttribute('data-bc-price')));
        });

        this._onKeyDown = e => { if (e.key === 'Escape') { e.preventDefault(); this._cancel(); } };
        document.addEventListener('keydown', this._onKeyDown);

        document.body.appendChild(root);
        this._root = root;
    },

    /** Best-effort platform-fee disclosure. The server (quote mode) is the single
     *  source of truth for the fee, so we never compute it here. Fills a caption
     *  under each pack button — "(+$1.50 platform fee)" — from the quote's per-pack
     *  fee. Fee OFF (the default) → every fee is 0 → captions stay empty and the
     *  buttons keep meaning "credits received". Stripe itemises the fee regardless. */
    async _loadFeeNote() {
        if (!this._getQuote) return;
        let quote;
        try {
            quote = await this._getQuote();
        } catch (_) { return; }   // captions are optional
        if (!this._root || !quote || !Array.isArray(quote.packs)) return;

        for (const p of quote.packs) {
            if (!(Number(p.fee_usd) > 0)) continue;
            const el = this._root.querySelector(`[data-bc-fee-for="${p.price_id}"]`);
            if (el) el.textContent = `(+$${this._fmtUsd(p.fee_usd)} fee)`;
        }
    },

    /** $1 (not $1.00), $1.50, $2.25 — drop the decimals only for a whole dollar. */
    _fmtUsd(n) {
        const v = Number(n);
        return v % 1 === 0 ? String(v) : v.toFixed(2);
    },

    async _pick(priceId) {
        const body = this._root?.querySelector('[data-bc-body]');
        this._root?.querySelectorAll('[data-bc-price]').forEach(b => { b.disabled = true; });
        if (body) body.style.opacity = '0.6';

        let url;
        try {
            url = await this._getCheckoutUrl(priceId);
        } catch (e) {
            if (body) body.style.opacity = '';
            this._root?.querySelectorAll('[data-bc-price]').forEach(b => { b.disabled = false; });
            Toast.error('Checkout failed: ' + (e?.message || e));
            return;
        }

        // Standalone browser: full-page redirect to Stripe (return via ?credits=success).
        // DashieAuth is a bare global (not on window) — must reference it directly,
        // else isAddonMode reads undefined and ingress falls through to same-frame nav.
        if (!DashieAuth.isAddonMode) { window.location = url; return; }

        // HA ingress: pop out to a new tab + poll for the granted balance.
        const pack = (this._packs || []).find(p => String(p.price_id) === String(priceId));
        const cur = window.CreditsService?.balance?.();
        const startBal = (cur && typeof cur.balance === 'number') ? cur.balance : 0;
        this._renderWaiting(url, pack?.usd);
        this._startPolling(startBal);
    },

    _renderWaiting(url, usd) {
        const body = this._root?.querySelector('[data-bc-body]');
        if (!body) return;
        body.style.opacity = '';
        const amountLine = (usd != null && usd !== '')
            ? `<div style="font-size:15px; font-weight:600; text-align:center; margin-bottom:14px;">Purchasing $${this._escape(usd)} in credits</div>`
            : '';
        body.innerHTML = `
            ${amountLine}
            <a href="${this._escape(url)}" target="_blank" rel="noopener" class="btn btn-primary"
               style="display:flex; align-items:center; justify-content:center; text-decoration:none; padding:14px 0; font-weight:600;">
                Continue to secure checkout &rarr;
            </a>
            <div style="color: var(--text-muted); font-size:12px; margin-top:12px; line-height:1.5;">
                Opens Stripe in a new tab. Complete your payment there — this window updates automatically once your credits arrive.
            </div>
            <div style="display:flex; align-items:center; gap:10px; margin-top:16px; color: var(--text-muted); font-size:13px;">
                <div style="width:16px; height:16px; border:2px solid var(--border,#e5e7eb); border-top-color: var(--accent); border-radius:50%; animation: bcspin 0.8s linear infinite;"></div>
                Waiting for payment…
            </div>
            <div style="margin-top:16px;">
                <button class="btn btn-ghost btn-sm" data-bc="cancel">Cancel</button>
            </div>
            <style>@keyframes bcspin { to { transform: rotate(360deg); } }</style>`;
        body.querySelector('[data-bc="cancel"]')?.addEventListener('click', () => this._cancel());
    },

    _startPolling(startBal) {
        this._stopPolling();
        this._pollDeadline = Date.now() + 5 * 60 * 1000;   // give up after 5 min
        const tick = async () => {
            if (Date.now() > this._pollDeadline) { this._stopPolling(); return; }
            let bal = null;
            try {
                const r = await window.CreditsService?.fetch?.({ force: true });
                if (r && typeof r.balance === 'number') bal = r.balance;
            } catch (_) { /* keep polling */ }
            if (bal !== null && bal > startBal + 0.0001) { this._success(); return; }
            this._pollTimer = setTimeout(tick, 3000);
        };
        this._pollTimer = setTimeout(tick, 3000);
    },

    _stopPolling() {
        if (this._pollTimer) clearTimeout(this._pollTimer);
        this._pollTimer = null;
    },

    _success() {
        this._stopPolling();
        const body = this._root?.querySelector('[data-bc-body]');
        if (body) {
            body.innerHTML = `
                <div style="text-align:center; padding:8px 0;">
                    <div style="font-size:32px;">✅</div>
                    <div style="font-weight:600; margin-top:8px;">Credits added</div>
                    <div style="color: var(--text-muted); font-size:13px; margin-top:4px;">Your new balance is ready.</div>
                    <button class="btn btn-primary btn-sm" data-bc="done" style="margin-top:16px;">Done</button>
                </div>`;
            body.querySelector('[data-bc="done"]')?.addEventListener('click', () => {
                this._closeImmediate();
                App.renderPage();
            });
        }
        // Refresh the page behind the modal so its balance/stat cards update too.
        App.renderPage();
    },

    _cancel() { this._closeImmediate(); },

    _closeImmediate() {
        this._stopPolling();
        if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
        if (this._onKeyDown) document.removeEventListener('keydown', this._onKeyDown);
        this._root = null;
        this._onKeyDown = null;
        this._getCheckoutUrl = null;
        this._packs = null;
    },

    _escape(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
};

window.BuyCreditsModal = BuyCreditsModal;
