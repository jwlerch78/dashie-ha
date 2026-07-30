/* ============================================================
   Credits Controls (shared)
   ------------------------------------------------------------
   The compact credit UI shared by BOTH the Credit Usage tab
   (AccountUsage) and the Account tab (AccountPage):
     - a "Buy more" affordance that opens BuyCreditsModal
     - an Auto-replenish checkbox (+ inline threshold/amount)
     - the < 60-day expiry notice

   Balance is read from CreditsService (the single cached source
   the sidebar also reads), so the two tabs never disagree.
   Auto-replenish state/handlers live HERE (moved out of
   account-usage.js) so both pages reuse one implementation.

   buyCredits() is the single choke point for checkout: it builds
   the env-correct return URLs and calls create-credit-checkout,
   returning the Stripe URL. BuyCreditsModal owns whether to
   redirect (standalone browser) or pop out + poll (HA ingress).
   ============================================================ */

const CreditsControls = {
    _autorefill: null,          // {enabled, threshold_usd, topup_usd, has_card, last_error}
    _autorefillError: null,     // last set_autorefill error
    _busy: false,               // a buy / auto-replenish action is in flight
    _inflightAutorefill: null,  // dedupe concurrent get_autorefill
    _feeByAmount: null,         // {usd: {fee_usd,total_usd}} from the server quote — never computed here

    // ── data ──────────────────────────────────────────────────

    /** Env-branched credit-pack price ids (staging uses Stripe test mode). */
    creditPacks() {
        const url = (DashieAuth.config?.url) || '';
        const isProd = url.includes('cseaywxcvnxcsypaqaid');
        return isProd ? [
            { usd: 5,  price_id: 'price_1Tk6cxDeFmFAr8Ip6Y1EtdbQ' },
            { usd: 10, price_id: 'price_1Tk6cxDeFmFAr8IpJAXuCuNS' },
            { usd: 25, price_id: 'price_1Tk6cxDeFmFAr8IpgMVJ5dkw' },
        ] : [
            { usd: 5,  price_id: 'price_1Tk6bID1HbVkqny7hS1Ey7sW' },
            { usd: 10, price_id: 'price_1Tk6bID1HbVkqny7LS4LB1tX' },
            { usd: 25, price_id: 'price_1Tk6bID1HbVkqny7tCp3ozbP' },
        ];
    },

    /** Standalone console base for Stripe return URLs when in HA ingress —
     *  the external checkout tab has no ingress session, so it must land on
     *  the public console, not the ingress URL. */
    _consoleBaseUrl() {
        const url = (DashieAuth.config?.url) || '';
        const isProd = url.includes('cseaywxcvnxcsypaqaid');
        return isProd ? 'https://app.dashieapp.com/console/' : 'https://dev.dashieapp.com/console/';
    },

    /** Fetch auto-replenish settings (deduped). Stores on _autorefill. */
    async fetchAutorefill(opts = {}) {
        if (this._inflightAutorefill && !opts.force) return this._inflightAutorefill;
        if (!DashieAuth.dbRequest) return null;
        this._inflightAutorefill = (async () => {
            try {
                const res = await DashieAuth.dbRequest('get_autorefill', {});
                if (res) this._autorefill = res;
                // The summary line states what gets CHARGED, which includes the platform
                // fee — so warm the per-amount fee from the server quote. Best-effort:
                // without it the line falls back to the bare top-up.
                if (res?.enabled) this._warmAutorefillFee(Number(res.topup_usd));
                return res;
            } catch (e) {
                console.warn('[CreditsControls] get_autorefill failed', e);
                return null;
            } finally {
                this._inflightAutorefill = null;
            }
        })();
        return this._inflightAutorefill;
    },

    // ── buy flow ──────────────────────────────────────────────

    openBuyModal() {
        if (this._busy) return;
        if (typeof BuyCreditsModal === 'undefined') return;
        BuyCreditsModal.open({
            packs: this.creditPacks(),
            getCheckoutUrl: (priceId) => this.buyCredits(priceId),
            getQuote: () => this.quoteCredits(),
        });
    },

    /** Cache the platform fee for the auto-replenish top-up so the summary line can state
     *  the real charge. One-shot per amount; re-renders when it lands (the line renders
     *  synchronously, so it shows the bare top-up until then). */
    async _warmAutorefillFee(amount) {
        if (!isFinite(amount) || amount <= 0) return;
        if (this._feeByAmount && this._feeByAmount[amount] !== undefined) return;
        const q = await this.quoteCredits({ amounts: [amount] });
        const row = q && Array.isArray(q.amounts) ? q.amounts.find(a => Number(a.amount_usd) === amount) : null;
        this._feeByAmount = { ...(this._feeByAmount || {}), [amount]: row || null };
        if (row && typeof App !== 'undefined' && App.renderPage) App.renderPage();
    },

    /** Ask create-credit-checkout to price packs and/or raw top-up amounts (quote
     *  mode) so the modals can disclose the platform fee. Returns
     *  { fee_terms, packs:[...], amounts:[...] } or null. The server owns the fee
     *  formula; nothing here mirrors it. */
    async quoteCredits({ amounts } = {}) {
        try {
            const payload = { quote: true, price_ids: this.creditPacks().map(p => p.price_id) };
            if (Array.isArray(amounts)) payload.amounts = amounts;
            const res = await DashieAuth.edgeFunctionRequest('create-credit-checkout', payload);
            return (res && (Array.isArray(res.packs) || Array.isArray(res.amounts))) ? res : null;
        } catch (e) {
            console.warn('[CreditsControls] credit quote failed', e);
            return null;
        }
    },

    /** Single checkout choke point. Builds env-correct return URLs, calls
     *  create-credit-checkout, returns the Stripe URL. Throws on failure.
     *  Redirect-vs-popout is decided by BuyCreditsModal (ingress-aware). */
    async buyCredits(priceId) {
        const addon = !!DashieAuth.isAddonMode;
        const base = addon
            ? this._consoleBaseUrl()
            : (window.location.origin + window.location.pathname);
        const sep = base.includes('?') ? '&' : '?';
        const res = await DashieAuth.edgeFunctionRequest('create-credit-checkout', {
            auth_user_id: DashieAuth.jwtUserId,
            email: DashieAuth.jwtUserEmail,
            price_id: priceId,
            success_url: base + sep + 'credits=success',
            cancel_url: base + sep + 'credits=cancel',
        });
        if (!res?.checkout_url) throw new Error(res?.error || 'No checkout URL returned');
        return res.checkout_url;
    },

    // ── auto-replenish handlers (moved from AccountUsage) ──────

    async _saveAutorefill(patch) {
        if (this._busy) return;
        this._busy = true; this._autorefillError = null; App.renderPage();
        try {
            const res = await DashieAuth.dbRequest('set_autorefill', patch);
            this._autorefill = res;   // handler returns the updated settings
        } catch (e) {
            this._autorefillError = (e?.message || String(e)).replace(/^DB operation error:\s*/, '');
        }
        this._busy = false; App.renderPage();
    },
    /** ASYMMETRIC BY DESIGN.
     *  Turning auto-replenish ON grants standing authority to charge a saved
     *  payment method off-session, so it goes through the consent modal (terms,
     *  instrument, 1/day guarantee) — an affirmative, informed act.
     *  Turning it OFF is instant and unguarded: never make someone jump a hurdle
     *  to STOP being charged. See build-plan 20260714_TABLET_AUTOREFILL_UX.md D2. */
    toggleAutorefill() {
        const on = !!this._autorefill?.enabled;
        if (on) { this._saveAutorefill({ enabled: false }); return; }   // kill switch: immediate
        this.openAutorefillModal('enable');
        // The browser already flipped the checkbox visually on click. Re-render so it
        // snaps back to the real (still-off) state — otherwise cancelling the consent
        // modal leaves a checked box over a disabled rule. The modal is body-attached,
        // so it survives the re-render.
        App.renderPage();
    },

    /** mode 'enable' → consent modal (also flips enabled:true on confirm).
     *  mode 'edit'   → plain rule editor for an already-on rule. */
    async openAutorefillModal(mode = 'edit') {
        if (typeof AutorefillModal === 'undefined') return;
        const ar = this._autorefill || {};
        const enabling = mode === 'enable';

        // Only the consent (enable) surface states the charge, so only it needs the
        // fee. Quote the selectable top-up amounts; a failure just falls back to the
        // bare top-up copy (the modal treats a null map as fee-off).
        let feeByAmount = null;
        if (enabling) {
            const q = await this.quoteCredits({ amounts: [5, 10, 25] });
            if (q && Array.isArray(q.amounts)) {
                feeByAmount = {};
                for (const a of q.amounts) feeByAmount[Number(a.amount_usd)] = a;
            }
        }

        AutorefillModal.open({
            mode,
            threshold: Number(ar.threshold_usd ?? 1),
            topup: Number(ar.topup_usd ?? 10),
            dailyCap: Number(ar.daily_cap ?? 1),
            card: ar.has_card ? { brand: ar.card_brand, last4: ar.card_last4 } : null,
            feeByAmount,
            onSave: (threshold, topup) => this._saveAutorefill(
                enabling
                    ? { enabled: true, threshold_usd: threshold, topup_usd: topup }
                    : { threshold_usd: threshold, topup_usd: topup }
            ),
        });
    },

    // ── render pieces ─────────────────────────────────────────

    /** The compact "Buy more" button. */
    _buyButton() {
        return `<button class="btn btn-primary btn-sm" ${this._busy ? 'disabled' : ''}
            onclick="CreditsControls.openBuyModal()" style="font-weight:600; flex-shrink:0;">Buy more</button>`;
    },

    /** Name the saved instrument. NOT always a card — Stripe Link is Checkout's
     *  default wallet, so card_brand may be a PM *type* ('link') with no last4.
     *  Never render "Visa ending 4242" for a Link user. */
    _describeCard(ar) {
        const brand = ar && ar.card_brand;
        if (!brand) return 'your saved payment method';
        if (brand === 'link') return 'your Link wallet';
        const pretty = brand.charAt(0).toUpperCase() + brand.slice(1);
        return ar.card_last4 ? `your ${pretty} ••${ar.card_last4}` : `your saved ${pretty}`;
    },

    /** Auto-replenish checkbox + a subtext summary of the rule. The rule itself
     *  (threshold + amount) is edited in AutorefillModal, not inline. Disabled
     *  until a card is saved (first purchase). */
    _autorefillBlock() {
        const ar = this._autorefill || {};
        const busy = this._busy;
        const enableDisabled = (!ar.has_card && !ar.enabled);
        const threshold = Number(ar.threshold_usd ?? 1);
        const topup = Number(ar.topup_usd ?? 10);
        const arError = this._autorefillError
            ? `<div style="color: var(--status-error,#c00); font-size:12px; margin-top:6px;">${this._escape(this._autorefillError)}</div>` : '';
        const lastErr = (ar.enabled && ar.last_error)
            ? `<div style="color: var(--status-error,#c00); font-size:12px; margin-top:6px;">Last auto-charge failed: ${this._escape(ar.last_error)}</div>` : '';

        // Status to the RIGHT of the checkbox: the rule (with an Edit link) when on,
        // or the save-a-card prompt when it can't be enabled yet.
        let inline = '';
        if (enableDisabled) {
            inline = `<span style="color: var(--text-muted); font-size:11px;">Buy a pack once to save a card, then enable.</span>`;
        } else if (ar.enabled) {
            // State the instrument and the cap, not just the rule — this is the only
            // place a user sees, at a glance, what standing authority they granted.
            const cap = Number(ar.daily_cap ?? 1);
            const per = cap === 1 ? 'max 1/day' : `max ${cap}/day`;
            const instrument = this._describeCard(ar);
            // State what actually gets CHARGED, including the platform fee. "add $5 to your
            // Link wallet" was wrong twice over: it omitted the fee (the card is billed
            // $5.95), and it described the direction backwards — the wallet is charged, not
            // credited. Falls back to the bare top-up until the fee quote lands.
            const fee = this._feeByAmount && this._feeByAmount[topup];
            const chargeTxt = (fee && Number(fee.fee_usd) > 0)
                ? `charge ${this._escape(instrument)} $${Number(fee.total_usd).toFixed(2)} for $${topup} in credits`
                : `charge ${this._escape(instrument)} $${topup}`;
            inline = `<span style="color: var(--text-muted); font-size:12px;">When below $${threshold.toFixed(2)}, ${chargeTxt} · ${per}<a href="#" onclick="event.preventDefault(); CreditsControls.openAutorefillModal('edit')" style="color: var(--accent); margin-left:6px;">Edit</a></span>`;
        }

        return `
            <div style="margin-top:12px;">
                <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
                    <label style="display:inline-flex; align-items:center; gap:8px; cursor:${enableDisabled ? 'not-allowed' : 'pointer'}; font-size:13px; font-weight:500;"
                        ${enableDisabled ? 'title="Buy a pack once to save a card"' : ''}>
                        <input type="checkbox" ${ar.enabled ? 'checked' : ''} ${(busy || enableDisabled) ? 'disabled' : ''}
                            onchange="CreditsControls.toggleAutorefill()" />
                        Auto-replenish
                    </label>
                    ${inline}
                </div>
                ${lastErr}${arError}
            </div>`;
    },

    /** Rich Balance card for the Credit Usage tab's stat strip: balance value,
     *  a "Buy more" button next to it, and the auto-replenish checkbox below. */
    renderBalanceCard(balanceObj) {
        const bal = balanceObj || (window.CreditsService?.balance?.()) || {};
        const balance = Number(bal.balance || 0);
        // height:100% + centered so when the grid stretches this card to match a
        // taller neighbor (e.g. the stacked Today/This month column), the content
        // sits vertically centered rather than top-aligned.
        return `
            <div class="card" style="height:100%;"><div class="card-body" style="padding: 14px 16px; height:100%; display:flex; flex-direction:column; justify-content:center; box-sizing:border-box;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
                    <div>
                        <div style="font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">Balance</div>
                        <div style="font-size: 22px; font-weight: 700; color: var(--text-primary); margin-top: 4px;">$${balance.toFixed(2)}</div>
                    </div>
                    ${this._buyButton()}
                </div>
                ${this._autorefillBlock()}
            </div></div>`;
    },

    /** Auto-refill FAILURE pill (WS-L.3) — prominent, top-of-page sibling of the expiry
     *  notice. Shown while a failure streak is live (last_error set, cleared by the next
     *  successful charge). The buried 12px line in _autorefillBlock stays as detail; this
     *  is the signal. Actions reuse the existing flows: buy-a-pack (saves the new card —
     *  how a card gets REPLACED) or the enabled kill switch. */
    renderFailureNotice() {
        const ar = this._autorefill || {};
        if (!ar.enabled || !ar.last_error) return '';
        const when = ar.last_error_at
            ? new Date(ar.last_error_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
            : null;
        const color = 'var(--status-error, #c00)';
        // Stripe decline messages usually already end in a period ("Your card was
        // declined.") — don't double it up.
        const reason = String(ar.last_error).trim().replace(/[.\s]+$/, '');
        return `
            <div class="card" style="margin-bottom: 12px; border-color: ${color};">
                <div class="card-body" style="padding: 12px 16px; font-size: 13px; display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
                    <span style="color: ${color};">
                        ⚠️ <strong>Auto-refill payment failed</strong>${when ? ` (${when})` : ''}: ${this._escape(reason)}.
                        Voice keeps working until your balance runs out. Buy a pack to save a new card, or turn auto-refill off.
                    </span>
                    <span style="display:inline-flex; gap:8px;">
                        <button class="btn btn-primary btn-sm" onclick="CreditsControls.openBuyModal()">Buy credits</button>
                        <button class="btn btn-secondary btn-sm" onclick="CreditsControls.toggleAutorefill()">Turn off</button>
                    </span>
                </div></div>`;
    },

    /** Credit-expiry banner — only shown when the soonest expiry is < 60 days
     *  away. Escalating styling: <=30d warns (border + ⚠️), <=7d errors. */
    renderExpiryNotice(expiryObj) {
        const next = expiryObj?.next_expiry;
        const amt = Number(next?.amount || 0);
        if (!next?.expires_at || amt <= 0) return '';
        const exp = new Date(next.expires_at);
        const days = Math.ceil((exp.getTime() - Date.now()) / 86400_000);
        if (days >= 60) return '';   // hide until it's actually close
        const dateStr = exp.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        let color = 'var(--text-muted)';
        if (days <= 7) color = 'var(--status-error, #c00)';
        else if (days <= 30) color = 'var(--status-warning, #b45309)';
        const within = days <= 30;
        return `
            <div class="card" style="margin-top: 12px; ${within ? `border-color: ${color};` : ''}">
                <div class="card-body" style="padding: 12px 16px; font-size: 13px; color: ${color};">
                    ${within ? '⚠️ ' : ''}<strong>$${amt.toFixed(2)}</strong> in credits expire on <strong>${dateStr}</strong>${days >= 0 ? ` (${days} day${days === 1 ? '' : 's'})` : ''}.
                </div></div>`;
    },

    _escape(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
};

window.CreditsControls = CreditsControls;
