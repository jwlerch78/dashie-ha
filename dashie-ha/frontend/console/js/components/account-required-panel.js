/* ============================================================
   AccountRequiredPanel — the LOCKED view for a nav page that exists,
   works, and needs a (free) Dashie account.

   The third gating state (2026-08-01, John). See ACCOUNT_LOCKED_PAGES in
   js/lib/feature-gate.js for why "visible but locked" exists alongside the
   LOCAL_MODE_PAGES whitelist, and why the two sets must stay separate.

   THIS IS A STUB, deliberately. The router (App.renderPage's locked branch)
   renders it INSTEAD OF the page module, so the real page never executes:
   no fetch, no 401 storm, no half-populated account UI behind a scrim. That
   is the whole point of intercepting at the router rather than letting each
   page grow its own signed-out branch.

   COPY IS PLACEHOLDER — flagged for John to rewrite. The framing it is
   written to, and the thing to preserve if the words change: this is
   DISCOVERABILITY, NOT A PAYWALL. The Home Assistant edition is free and
   nothing here is gated on paying; Dashie Cloud credits are an optional
   hosted convenience (PROVENANCE.md). An account is what holds per-account
   settings and a credit balance — so say what the feature DOES and that it
   needs a free account. Never "upgrade to unlock".
   ============================================================ */

const AccountRequiredPanel = {
    /**
     * Per-page copy. Keys are console routes and must be a subset of
     * FeatureGate.ACCOUNT_LOCKED_PAGES — an entry here does not lock anything,
     * and a locked page with no entry falls back to _GENERIC below (loudly).
     *
     *   title  — the page's own nav label, so the locked view names the thing
     *            the user clicked rather than the state they landed in.
     *   what   — what the feature does. Written as if it already works, because
     *            it does; the account is the missing part, not the feature.
     *   why    — why an account, specifically. One honest sentence.
     *   also   — optional: what already works on this box WITHOUT an account,
     *            so the lock never reads as "the free edition is crippled".
     */
    COPY: {
        'credits': {
            title: 'Credits',
            what: `${BRAND.cloudName} is the optional hosted option for speech-to-text, the AI brain, and voices. It is metered credits, not a subscription — this page shows your balance, what each request cost, and lets you top it up.`,
            why: 'Credits are held against a Dashie account, so this page needs one. Creating an account is free.',
            also: 'Nothing on this box depends on it: your own engines (Local Engines) and your own provider keys (API Keys) run without an account and without credits.',
        },
        'scheduled-actions': {
            title: 'Scheduled Actions',
            what: 'Reminders and actions you set by voice — "remind me to take the bins out at seven" — that fire at the time you asked for.',
            why: 'Each one is stored on your Dashie account so it survives a restart and can reach your other Dashie devices. That storage is what needs a (free) account.',
            also: null,
        },
        'account': {
            title: 'Account',
            what: 'Your Dashie account: profile, sign-in details, and account deletion.',
            why: 'There is nothing to show here until you have one. An account is free, and it is what carries your settings and any credit balance between Dashie devices.',
            also: null,
        },
        'preferences': {
            title: 'Preferences',
            what: 'Dashie settings that follow your account rather than this box — so they apply to every Dashie device you sign in on.',
            why: 'They are stored against the account, which is why this page needs one. It is free to create.',
            also: 'Settings that belong to THIS box — voice engines, models, API keys — are under Voice & AI, Local Engines and API Keys, and need no account.',
        },
        'devices': {
            title: 'Dashboards',
            what: 'Dashie dashboard devices — tablets, TVs and displays — registered to your household: claim a new one, rename it, and see what each is doing.',
            why: 'A device is claimed BY an account; that pairing is what this page manages, so it needs a free account.',
            also: null,
        },
    },

    /** Fallback for a page added to ACCOUNT_LOCKED_PAGES without copy. Loud —
     *  a locked page with no explanation is a dead end, which is the failure
     *  this whole state exists to avoid. */
    _GENERIC: {
        title: 'Account required',
        what: 'This part of the console works against your Dashie account.',
        why: 'Sign in, or create a free account, to use it.',
        also: null,
    },

    _copy(page) {
        const c = this.COPY[page];
        if (c) return c;
        console.warn(`DROP: no AccountRequiredPanel copy for locked page '${page}' — ` +
                     `showing the generic panel. Add an entry to AccountRequiredPanel.COPY.`);
        return this._GENERIC;
    },

    /** Top-bar title for the locked view. */
    title(page) { return this._copy(page).title; },

    /**
     * The panel. `page` is a console route; the caller has already established
     * it is locked (FeatureGate.isLocked) — this renders, it does not decide.
     */
    render(page) {
        const c = this._copy(page);
        // Explicit create-account button on the Account page only: that page IS
        // the account, so "I don't have one yet" is the likeliest reason to be
        // standing here. It jumps straight into LoginEmail's signup mode
        // (POST /api/auth/email-signup) — the flow that already exists. Every
        // other panel routes to the login screen, which offers both paths.
        const createBtn = page === 'account' ? `
                    <button class="btn btn-secondary" onclick="App.startCreateAccount()">
                        Create a free account
                    </button>` : '';

        return `
            <div class="card" style="max-width: 640px; margin: 24px auto;">
                <div class="card-body" style="text-align: center; padding: 32px 28px;">
                    <img src="assets/icons/icon-lock.svg" alt="" aria-hidden="true"
                         style="width: 28px; height: 28px; opacity: 0.35; margin-bottom: 14px;">

                    <div style="font-size: var(--font-size-lg, 17px); font-weight: 700; margin-bottom: 10px;">
                        ${c.title}
                    </div>

                    <div style="color: var(--text-secondary); font-size: var(--font-size-sm); line-height: 1.55;">
                        ${c.what}
                    </div>

                    <div style="color: var(--text-secondary); font-size: var(--font-size-sm); line-height: 1.55; margin-top: 10px;">
                        ${c.why}
                    </div>

                    <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-top: 22px;">
                        <button class="btn btn-primary" onclick="App.startSignIn()">
                            Sign in or create an account
                        </button>${createBtn}
                    </div>

                    ${c.also ? `
                    <div style="color: var(--text-muted); font-size: var(--font-size-xs); line-height: 1.55;
                                margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--border-subtle);">
                        ${c.also}
                    </div>` : ''}
                </div>
            </div>
        `;
    },
};

window.AccountRequiredPanel = AccountRequiredPanel;
