/* ============================================================
   Feedback Modal — voice response thumbs-down follow-up

   A styled popup for capturing WHY a voice response was wrong:
   a required reason (mapped to the eval assertion taxonomy) plus an
   optional free-text detail box for the specifics.

   Usage:
       const res = await FeedbackModal.open({
           prompt: 'what was the score…',      // optional, shown for context
           response: 'Mexico beat South Korea 1–0.',
       });
       if (!res) return;                        // cancelled
       // res = { reason: 'response_inaccurate', detail: 'wrong team won' }

   Renders into <body> (independent of App.renderPage). Esc key and
   backdrop click resolve to null (cancel). Modeled on ConfirmModal.
   ============================================================ */

const FeedbackModal = {
    _resolve: null,
    _root: null,
    _onKeyDown: null,

    REASONS: [
        ['transcription_inaccurate', "Didn't transcribe what I said accurately"],
        ['response_inaccurate', 'Inaccurate response'],
        ['other', 'Other'],
    ],

    /**
     * @param {Object} opts
     * @param {string} [opts.prompt]   - what the user said (shown as context)
     * @param {string} [opts.response] - Dashie's response (shown as context)
     * @returns {Promise<{reason:string, detail:string|null}|null>} null on cancel
     */
    open(opts = {}) {
        if (this._resolve) { this._resolve(null); this._cleanup(); }
        return new Promise(resolve => {
            this._resolve = resolve;
            this._render(opts);
        });
    },

    _render({ prompt = '', response = '' } = {}) {
        const taId = 'fb-detail-' + Math.random().toString(36).slice(2, 8);
        const context = (prompt || response) ? `
            <div style="background: var(--surface-muted, #f7f7f8); border-radius: 8px; padding: 10px 12px; margin: 0 0 16px; font-size: 13px; line-height: 1.4;">
                ${prompt ? `<div style="margin: 0 0 4px;"><span style="color: var(--text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;">You said</span><div>${this._escape(prompt)}</div></div>` : ''}
                ${response ? `<div><span style="color: var(--text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;">${BRAND.assistantName} said</span><div>${this._escape(response)}</div></div>` : ''}
            </div>` : '';

        const chips = this.REASONS.map(([r, label]) =>
            `<button type="button" data-reason="${r}"
                style="background: var(--surface-muted, #f3f4f6); border: 1px solid var(--border, #e5e7eb); color: var(--text-secondary); font-size: 13px; padding: 6px 12px; border-radius: 16px; cursor: pointer;">${this._escape(label)}</button>`
        ).join('');

        const root = document.createElement('div');
        root.className = 'feedback-modal-root';
        root.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 1100; display: flex; align-items: center; justify-content: center; padding: 16px;';
        root.innerHTML = `
            <div role="dialog" aria-modal="true" aria-labelledby="fb-title" style="background: var(--bg-card, #fff); border-radius: 12px; max-width: 480px; width: 100%; box-shadow: 0 20px 60px rgba(0,0,0,0.3); padding: 20px;">
                <h2 id="fb-title" style="margin: 0 0 12px 0; font-size: 17px;">What was wrong with this response?</h2>
                ${context}
                <div style="display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 16px;">${chips}</div>
                <label for="${taId}" style="display: block; font-size: 13px; color: var(--text-secondary); margin: 0 0 6px;">Add more detail (optional)</label>
                <textarea id="${taId}" rows="3" placeholder="What did you expect instead?"
                    style="width: 100%; padding: 8px 10px; border: 1px solid var(--border, #e5e7eb); border-radius: 6px; font: inherit; font-size: 14px; box-sizing: border-box; resize: vertical; background: var(--bg-input, #fff); color: inherit;"></textarea>
                <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px;">
                    <button class="btn btn-ghost" data-fb-action="cancel">Cancel</button>
                    <button class="btn btn-primary" data-fb-action="send" disabled>Send feedback</button>
                </div>
            </div>
        `;

        root.addEventListener('click', e => { if (e.target === root) this._answer(null); });

        let selectedReason = null;
        const sendBtn = root.querySelector('[data-fb-action="send"]');
        const chipBtns = Array.from(root.querySelectorAll('[data-reason]'));
        chipBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                selectedReason = btn.getAttribute('data-reason');
                // Highlight the selected chip, reset the others.
                chipBtns.forEach(b => {
                    const on = b === btn;
                    b.style.background = on ? 'var(--accent, #4f46e5)' : 'var(--surface-muted, #f3f4f6)';
                    b.style.color = on ? '#fff' : 'var(--text-secondary)';
                    b.style.borderColor = on ? 'var(--accent, #4f46e5)' : 'var(--border, #e5e7eb)';
                });
                sendBtn.disabled = false;
            });
        });

        root.querySelector('[data-fb-action="cancel"]').addEventListener('click', () => this._answer(null));
        sendBtn.addEventListener('click', () => {
            if (!selectedReason) return;
            const detail = (root.querySelector('#' + taId)?.value || '').trim() || null;
            this._answer({ reason: selectedReason, detail });
        });

        this._onKeyDown = e => {
            if (e.key === 'Escape') { e.preventDefault(); this._answer(null); }
        };
        document.addEventListener('keydown', this._onKeyDown);

        document.body.appendChild(root);
        this._root = root;
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
