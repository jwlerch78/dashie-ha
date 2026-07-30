/* ============================================================
   Confirm Modal

   Replacement for native confirm() — proper styled dialog instead
   of "dev.dashieapp.com says: ..."

   Usage:
       const ok = await ConfirmModal.confirm({
           title: 'Remove account',
           message: 'Calendars from this account will stop appearing.',
           confirmLabel: 'Remove',
           danger: true,            // styles confirm as red
       });
       if (!ok) return;

   The modal renders into <body> (independent of App.renderPage so it
   works from any page) and resolves the Promise on user choice. Esc
   key and backdrop click both resolve to false.
   ============================================================ */

const ConfirmModal = {
    _resolve: null,
    _root: null,
    _onKeyDown: null,

    /**
     * @param {Object} opts
     * @param {string} opts.title         - Header text
     * @param {string} opts.message       - Body text (rendered as text, not HTML)
     * @param {string} [opts.messageHtml]  - TRUSTED body markup (links, lists). Takes
     *        precedence over message. Never pass user-generated content here.
     * @param {string} [opts.confirmLabel='Confirm']
     * @param {string} [opts.cancelLabel='Cancel']
     * @param {boolean} [opts.danger=false] - styles the confirm button as destructive
     * @param {string} [opts.requireTypedConfirmation] - if set, user must type
     *        this exact string to enable Confirm (GitHub-style defense in depth
     *        for destructive actions). Confirm button stays disabled and the
     *        input is focused on open. Enter on the input fires confirm only
     *        when the value matches.
     * @param {string} [opts.typedConfirmationLabel] - hint shown above the input
     *        when requireTypedConfirmation is set. Defaults to "Type <value> to confirm".
     * @returns {Promise<boolean>}
     */
    confirm(opts = {}) {
        // If already open, immediately resolve previous as cancelled — happens
        // if a page calls confirm twice without awaiting; second call wins.
        if (this._resolve) {
            this._resolve(false);
            this._cleanup();
        }
        return new Promise(resolve => {
            this._resolve = resolve;
            this._render(opts);
        });
    },

    _render({
        title = 'Confirm',
        message = '',
        messageHtml = null,
        confirmLabel = 'Confirm',
        cancelLabel = 'Cancel',
        danger = false,
        requireTypedConfirmation = null,
        typedConfirmationLabel = null,
        hideCancel = false,   // single-button informational dialog (e.g. a result notice)
    }) {
        const confirmClass = danger ? 'btn btn-danger' : 'btn btn-primary';
        const hasTypedGate = !!requireTypedConfirmation;
        const inputId = 'confirm-typed-' + Math.random().toString(36).slice(2, 8);
        const hintLabel = typedConfirmationLabel
            || `Type ${requireTypedConfirmation} to confirm`;
        const typedSection = hasTypedGate
            ? `<div style="margin-bottom: 16px;">
                   <label for="${inputId}" style="display: block; font-size: 13px; color: var(--text-secondary); margin-bottom: 6px;">${this._escape(hintLabel)}</label>
                   <input id="${inputId}" type="text" autocomplete="off" autocapitalize="off"
                          spellcheck="false"
                          style="width: 100%; padding: 8px 10px; border: 1px solid var(--border, #e5e7eb); border-radius: 6px; font: inherit; box-sizing: border-box;">
               </div>`
            : '';
        const root = document.createElement('div');
        root.className = 'confirm-modal-root';
        root.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 1100; display: flex; align-items: center; justify-content: center; padding: 16px;';
        root.innerHTML = `
            <div role="dialog" aria-modal="true" aria-labelledby="confirm-title" style="background: var(--bg-card, #fff); border-radius: 12px; max-width: 460px; width: 100%; box-shadow: 0 20px 60px rgba(0,0,0,0.3); padding: 20px;">
                <h2 id="confirm-title" style="margin: 0 0 8px 0; font-size: 17px;">${this._escape(title)}</h2>
                <div style="color: var(--text-secondary); font-size: 14px; line-height: 1.5; margin-bottom: 20px; white-space: ${messageHtml != null ? 'normal' : 'pre-line'};">${messageHtml != null ? messageHtml : this._escape(message)}</div>
                ${typedSection}
                <div style="display: flex; gap: 8px; justify-content: flex-end;">
                    ${hideCancel ? '' : `<button class="btn btn-ghost" data-confirm-action="cancel">${this._escape(cancelLabel)}</button>`}
                    <button class="${confirmClass}" data-confirm-action="confirm" ${hasTypedGate ? 'disabled' : ''}>${this._escape(confirmLabel)}</button>
                </div>
            </div>
        `;
        // Backdrop click cancels (only on the root, not when clicking inside the dialog)
        root.addEventListener('click', e => {
            if (e.target === root) this._answer(false);
        });
        const cancelBtn = root.querySelector('[data-confirm-action="cancel"]');
        const confirmBtn = root.querySelector('[data-confirm-action="confirm"]');
        cancelBtn.addEventListener('click', () => this._answer(false));
        confirmBtn.addEventListener('click', () => {
            // Defensive: if there's a typed gate and somehow Confirm is enabled
            // without a match, double-check the value here too.
            if (hasTypedGate) {
                const input = root.querySelector('#' + inputId);
                if (!input || input.value !== requireTypedConfirmation) return;
            }
            this._answer(true);
        });

        let typedMatches = !hasTypedGate;  // true when no gate; false until matched
        if (hasTypedGate) {
            const input = root.querySelector('#' + inputId);
            input.addEventListener('input', () => {
                typedMatches = input.value === requireTypedConfirmation;
                confirmBtn.disabled = !typedMatches;
            });
        }

        // Esc to cancel; Enter behavior depends on whether the typed gate matches.
        // If no gate, Enter is the same as clicking Confirm. With a gate, Enter
        // only fires Confirm when the value matches — otherwise it does nothing
        // (don't accidentally cancel; the user is mid-type).
        this._onKeyDown = e => {
            if (e.key === 'Escape') { e.preventDefault(); this._answer(false); }
            else if (e.key === 'Enter') {
                e.preventDefault();
                if (typedMatches) this._answer(true);
            }
        };
        document.addEventListener('keydown', this._onKeyDown);

        document.body.appendChild(root);
        this._root = root;

        // With a typed gate, focus the input so the user can start typing
        // immediately. Without one, focus the confirm button so Enter is enough.
        setTimeout(() => {
            if (hasTypedGate) root.querySelector('#' + inputId)?.focus();
            else confirmBtn.focus();
        }, 30);
    },

    _answer(value) {
        const r = this._resolve;
        this._cleanup();
        if (r) r(value);
    },

    _cleanup() {
        if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
        if (this._onKeyDown) document.removeEventListener('keydown', this._onKeyDown);
        this._root = null;
        this._onKeyDown = null;
        this._resolve = null;
    },

    _escape(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
};
