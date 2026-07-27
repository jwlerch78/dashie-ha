/* ============================================================
   External Link Modal
   ------------------------------------------------------------
   Opens an external URL in a NEW TAB via a user-clickable anchor.
   In the HA ingress iframe a same-frame `window.location = url`
   (or a programmatic window.open) is unreliable — Stripe portal /
   checkout pages refuse to be framed and just hang. A real tap on
   an <a target="_blank"> is allowed to open a top-level tab, so we
   present one (same pattern as the device-flow login pop-out).

   Usage:
       ExternalLinkModal.open({
           url: 'https://…',
           title: 'Manage subscription',
           cta: 'Open billing portal →',
           note: 'Opens Stripe in a new tab.',
       });
   ============================================================ */

const ExternalLinkModal = {
    _root: null,
    _onKeyDown: null,

    open({ url, title = 'Continue', cta = 'Continue →', note = '' }) {
        this._close();
        const root = document.createElement('div');
        root.className = 'modal-backdrop';
        root.innerHTML = `
            <div class="modal" role="dialog" aria-modal="true" style="max-width: 420px;">
                <div class="modal-header">
                    <div class="modal-title">${this._escape(title)}</div>
                    <button class="modal-close" data-x aria-label="Close">&times;</button>
                </div>
                <div class="modal-body">
                    ${note ? `<div style="color: var(--text-muted); font-size: 13px; margin-bottom: 14px; line-height: 1.5;">${this._escape(note)}</div>` : ''}
                    <a href="${this._escape(url)}" target="_blank" rel="noopener" class="btn btn-primary"
                       style="display:flex; align-items:center; justify-content:center; text-decoration:none; padding:14px 0; font-weight:600;">
                        ${this._escape(cta)}
                    </a>
                </div>
            </div>`;
        root.addEventListener('click', e => { if (e.target === root) this._close(); });
        root.querySelector('[data-x]').addEventListener('click', () => this._close());
        // Dismiss shortly after the user taps the link (its new tab is opening).
        root.querySelector('a').addEventListener('click', () => setTimeout(() => this._close(), 150));
        this._onKeyDown = e => { if (e.key === 'Escape') { e.preventDefault(); this._close(); } };
        document.addEventListener('keydown', this._onKeyDown);
        document.body.appendChild(root);
        this._root = root;
    },

    _close() {
        if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
        if (this._onKeyDown) document.removeEventListener('keydown', this._onKeyDown);
        this._root = null;
        this._onKeyDown = null;
    },

    _escape(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
};

window.ExternalLinkModal = ExternalLinkModal;
