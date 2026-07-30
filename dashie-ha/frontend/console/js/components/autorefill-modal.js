/* ============================================================
   Auto-replenish Modal
   ------------------------------------------------------------
   Two modes:

   - mode 'enable'  → the CONSENT surface. This is the moment the user grants
     standing authority to charge a saved payment method off-session, so the
     terms must be stated HERE, not buried in a settings subtext. Shows what
     gets charged, to which instrument, the one-refill-per-day guarantee, the
     email promise, and how to cancel.
   - mode 'edit'    → plain rule editor (threshold + amount) for an already-on
     rule. No consent copy; they've already agreed.

   Disabling never opens this modal — turning OFF is instant and unguarded.
   (Asymmetric authority: never make someone jump a hurdle to STOP being
   charged. See build-plan 20260714_TABLET_AUTOREFILL_UX.md D2.)

   Body-attached (ConfirmModal pattern) so it works from any page/tab and
   survives App.renderPage().

   Usage:
       AutorefillModal.open({
           mode: 'enable',                       // or 'edit'
           threshold: 1, topup: 10, dailyCap: 1,
           card: { brand: 'visa', last4: '4242' },   // or { brand: 'link' }, or null
           onSave: (threshold, topup) => { ... },
       });
   ============================================================ */

const AutorefillModal = {
    _root: null,
    _onKeyDown: null,
    _onSave: null,
    _feeByAmount: null,

    // feeByAmount: optional { [usd]: { fee_usd, total_usd } } from the server's
    // quote mode, so the consent sentence states the amount ACTUALLY charged
    // (topup + platform fee). Absent / fee-off → consent shows the bare top-up,
    // identical to the pre-fee copy.
    open({ mode = 'edit', threshold, topup, dailyCap = 1, card = null, onSave, feeByAmount = null }) {
        this._close();
        this._onSave = onSave;
        this._feeByAmount = feeByAmount;
        this._render(mode, threshold, topup, dailyCap, card);
    },

    /** Name the actual instrument. NOT always a card: Stripe Link is Checkout's
     *  default wallet, so `brand` may be a PaymentMethod *type* ('link') with no
     *  last4. Never invent "Visa ending 4242" for a Link user. */
    _describeCard(card) {
        const brand = card && card.brand;
        if (!brand) return 'your saved payment method';
        if (brand === 'link') return 'your Stripe Link wallet';
        const pretty = brand.charAt(0).toUpperCase() + brand.slice(1);
        return card.last4 ? `your ${pretty} ending ${card.last4}` : `your saved ${pretty}`;
    },

    _consentBlock(threshold, topup, dailyCap, card) {
        const per = dailyCap === 1 ? 'one refill per day' : `${dailyCap} refills per day`;
        // When a platform fee applies, the card is charged topup + fee. State the
        // TOTAL — the mandate they're agreeing to must equal what actually hits the
        // card. Fee off / unknown → the bare top-up, as before.
        const fee = this._feeByAmount && this._feeByAmount[Number(topup)];
        const chargeLine = (fee && fee.fee_usd > 0)
            ? `<strong>$${Number(fee.total_usd).toFixed(2)}</strong> ($${Number(topup)} credits + $${Number(fee.fee_usd).toFixed(2)} platform fee)`
            : `<strong>$${Number(topup)}</strong>`;
        return `
            <div style="border:1px solid var(--border,#e5e7eb); border-left:3px solid var(--accent,#ffaa00);
                        border-radius:6px; padding:12px 14px; margin-bottom:18px; font-size:13px; line-height:1.6;">
                <div style="margin-bottom:8px;">
                    ${BRAND.productName} will charge <strong>${this._escape(this._describeCard(card))}</strong>
                    ${chargeLine} automatically whenever your credit balance
                    falls below <strong>$${Number(threshold).toFixed(2)}</strong>.
                </div>
                <ul style="margin:0; padding-left:18px; color: var(--text-muted);">
                    <li>At most <strong>${per}</strong> — so it can't run away.</li>
                    <li>We'll email you every time it charges.</li>
                    <li>Cancel anytime — here, or on any ${BRAND.productName} under Settings → Account.</li>
                </ul>
            </div>`;
    },

    _render(mode, threshold, topup, dailyCap, card) {
        const enabling = mode === 'enable';
        const amtOptions = [5, 10, 25].map(a =>
            `<option value="${a}" ${Number(topup) === a ? 'selected' : ''}>$${a}</option>`).join('');

        const title = enabling ? 'Turn on auto-replenish' : 'Auto-replenish';
        const cta = enabling ? 'Turn it on' : 'Save';
        const intro = enabling
            ? this._consentBlock(threshold, topup, dailyCap, card)
            : `<div style="color: var(--text-muted); font-size:13px; margin-bottom:18px; line-height:1.5;">
                   Automatically buy more credits when your balance runs low, charged to
                   ${this._escape(this._describeCard(card))}.
               </div>`;

        const root = document.createElement('div');
        root.className = 'modal-backdrop';
        root.innerHTML = `
            <div class="modal" role="dialog" aria-modal="true" aria-labelledby="ar-title" style="max-width: 460px;">
                <div class="modal-header">
                    <div class="modal-title" id="ar-title">${title}</div>
                    <button class="modal-close" data-ar="cancel" aria-label="Close">&times;</button>
                </div>
                <div class="modal-body">
                    ${intro}
                    <div style="display:flex; gap:18px; align-items:center; flex-wrap:wrap; font-size:14px;">
                        <label style="display:inline-flex; align-items:center; gap:6px;">When balance falls below
                            $<input id="ar-threshold" type="number" min="0" max="50" step="1" value="${Number(threshold)}"
                                style="width:60px; padding:6px 8px; border:1px solid var(--border,#e5e7eb); border-radius:6px;" /></label>
                        <label style="display:inline-flex; align-items:center; gap:6px;">add
                            <select id="ar-topup" style="padding:6px 8px; border:1px solid var(--border,#e5e7eb); border-radius:6px;">${amtOptions}</select>
                        </label>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-ghost" data-ar="cancel">Cancel</button>
                    <button class="btn btn-primary" data-ar="save">${cta}</button>
                </div>
            </div>`;

        root.addEventListener('click', e => { if (e.target === root) this._close(); });
        root.querySelectorAll('[data-ar="cancel"]').forEach(b => b.addEventListener('click', () => this._close()));
        root.querySelector('[data-ar="save"]').addEventListener('click', () => this._save());

        // Keep the consent sentence in sync with the inputs — the terms must
        // describe what they're ACTUALLY agreeing to, not the defaults.
        if (enabling) {
            const resync = () => {
                const t = Number(root.querySelector('#ar-threshold')?.value);
                const u = Number(root.querySelector('#ar-topup')?.value);
                if (!isFinite(t) || !isFinite(u)) return;
                const box = root.querySelector('.modal-body > div:first-child');
                if (box) box.outerHTML = this._consentBlock(t, u, dailyCap, card);
                // outerHTML replaced the node — rebind.
                root.querySelector('#ar-threshold')?.addEventListener('change', resync);
                root.querySelector('#ar-topup')?.addEventListener('change', resync);
            };
            root.querySelector('#ar-threshold')?.addEventListener('change', resync);
            root.querySelector('#ar-topup')?.addEventListener('change', resync);
        }

        this._onKeyDown = e => { if (e.key === 'Escape') { e.preventDefault(); this._close(); } };
        document.addEventListener('keydown', this._onKeyDown);

        document.body.appendChild(root);
        this._root = root;
        setTimeout(() => this._root?.querySelector('#ar-threshold')?.focus(), 30);
    },

    _escape(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    _save() {
        const t = Number(this._root?.querySelector('#ar-threshold')?.value);
        const u = Number(this._root?.querySelector('#ar-topup')?.value);
        const cb = this._onSave;
        this._close();
        if (cb && isFinite(t) && isFinite(u)) cb(t, u);
    },

    _close() {
        if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
        if (this._onKeyDown) document.removeEventListener('keydown', this._onKeyDown);
        this._root = null;
        this._onKeyDown = null;
        this._onSave = null;
    },
};

window.AutorefillModal = AutorefillModal;
