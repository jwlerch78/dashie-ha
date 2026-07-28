/* ============================================================
   Toast notifications (replaces alert())
   ============================================================ */

const Toast = {
    _container: null,
    _counter: 0,

    _ensureContainer() {
        if (this._container && document.body.contains(this._container)) return;
        this._container = document.createElement('div');
        this._container.className = 'toast-container';
        document.body.appendChild(this._container);
    },

    /**
     * Show a toast. kind: 'success' | 'error' | 'info'
     */
    show(message, kind = 'info', duration = 4500) {
        this._ensureContainer();
        const id = `toast-${++this._counter}`;
        const toast = document.createElement('div');
        toast.className = `toast toast-${kind}`;
        toast.id = id;

        const icon = kind === 'success' ? '✓'
            : kind === 'error' ? '✕'
            : 'ℹ';

        toast.innerHTML = `
            <span class="toast-icon">${icon}</span>
            <span class="toast-message">${this._escape(message)}</span>
            <button class="toast-close" aria-label="Close">✕</button>
        `;

        // Close on button click
        toast.querySelector('.toast-close').addEventListener('click', () => this._dismiss(toast));

        this._container.appendChild(toast);

        // Trigger enter animation
        requestAnimationFrame(() => toast.classList.add('visible'));

        // Auto-dismiss
        if (duration > 0) {
            setTimeout(() => this._dismiss(toast), duration);
        }

        return id;
    },

    success(message, duration = 3000) { return this.show(message, 'success', duration); },
    error(message, duration = 6000) { return this.show(message, 'error', duration); },
    info(message, duration = 4000) { return this.show(message, 'info', duration); },
    // Partial-failure heads-up (e.g. "2 devices couldn't be added"). Was CALLED by
    // devices-claim.js but never defined → "Toast.warning is not a function" crashed the
    // handler and hid the real error. Styled like info if no .toast-warning CSS exists.
    warning(message, duration = 6000) { return this.show(message, 'warning', duration); },

    _dismiss(toast) {
        if (!toast || !toast.parentNode) return;
        toast.classList.remove('visible');
        toast.classList.add('dismissing');
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 200);
    },

    /**
     * Translate a raw error message into a friendlier one.
     * Falls back to a generic retry-able message for 500s.
     */
    friendly(err, action = 'complete that') {
        const msg = err instanceof Error ? err.message : String(err || '');
        const lower = msg.toLowerCase();

        if (lower.includes('not authenticated') || lower.includes('jwt') || lower.includes('401')) {
            return "You've been signed out. Refresh to sign back in.";
        }
        if (lower.includes('subscription') || lower.includes('403')) {
            return `An active ${BRAND.productName} subscription is required for this action.`;
        }
        if (lower.includes('402') || lower.includes('insufficient_credits')) {
            return "You're out of credits. Add more from the Account page.";
        }
        if (lower.includes('500') || lower.includes('internal server error')) {
            return `Something went wrong on our end while trying to ${action}. Please try again in a moment.`;
        }
        if (lower.includes('timeout') || lower.includes('network') || lower.includes('fetch')) {
            return `Couldn't reach the server. Check your connection and try again.`;
        }
        if (lower.includes('404') || lower.includes('not found')) {
            return `That item couldn't be found. It may have been deleted elsewhere.`;
        }
        if (lower.includes('409') || lower.includes('conflict')) {
            return `Someone else just updated this. Refresh to see the latest version.`;
        }
        // Fallback
        return `Couldn't ${action}. ${msg || 'Please try again.'}`;
    },

    _escape(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
};
