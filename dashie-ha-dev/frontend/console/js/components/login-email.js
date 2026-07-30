/* ============================================================
   LoginEmail — email/password sign-in on the add-on login screen.

   Only lights up when the add-on's runtime advertises `email_auth: true`
   in GET /api/runtime (the Dashie for HA add-on does; the Dashie Console add-on and
   the standalone web console don't yet — their button stays "Coming
   soon"). Server contract (see the Dashie for HA add-on's api/console-auth):
     POST api/auth/email-signin  { email, password }        → { ok } | { ok:false, error, message }
     POST api/auth/email-signup  { email, password, name }  → same
   On ok the JWT is already persisted server-side — we just reload so
   the normal add-on auth boot picks it up (same as device-flow).
   ============================================================ */

const LoginEmail = {
    _signupMode: false,

    /** True when the add-on runtime says email auth is available. */
    isAvailable() {
        return typeof DashieAuth !== 'undefined'
            && DashieAuth.isAddonMode
            && DashieAuth._addonRuntimeInfo?.email_auth === true;
    },

    show(signup) {
        this._signupMode = signup === true;
        const card = document.getElementById('login-card');
        if (!card) return;
        const s = this._signupMode;
        card.innerHTML = `
            <img src="${BRAND.logo}" alt="${BRAND.productName}" class="dashie-login-logo">
            <div class="dashie-login-title">${s ? `Create a ${BRAND.productName} account` : `Sign in to ${BRAND.productName}`}</div>
            <div class="dashie-login-subtitle">${s
                ? 'Your account powers the cloud brain, speech-to-text, and voices.'
                : 'Use the email and password for your account.'}</div>

            <div style="display: flex; flex-direction: column; gap: 10px; text-align: left; margin-top: 8px;">
                <label class="form-label" for="login-email">Email</label>
                <input class="form-input" id="login-email" type="email" autocomplete="email" placeholder="you@example.com">
                ${s ? `
                <label class="form-label" for="login-name">Name (optional)</label>
                <input class="form-input" id="login-name" type="text" autocomplete="name" placeholder="Your name">` : ''}
                <label class="form-label" for="login-password">Password${s ? ' (8+ characters)' : ''}</label>
                <input class="form-input" id="login-password" type="password" autocomplete="${s ? 'new-password' : 'current-password'}">
                <div id="login-email-error" style="color: var(--status-error, #c00); font-size: 13px; min-height: 16px;"></div>
                <button class="btn btn-primary" id="login-email-submit" onclick="LoginEmail.submit()">${s ? 'Create account' : 'Sign in'}</button>
            </div>

            <div style="margin-top: 14px; font-size: 13px; color: var(--text-muted);">
                ${s ? 'Already have an account?' : `New to ${BRAND.productName}?`}
                <a href="#" onclick="LoginEmail.show(${s ? 'false' : 'true'}); return false;">${s ? 'Sign in' : 'Create an account'}</a>
            </div>
            <div style="margin-top: 8px;">
                <button class="btn btn-ghost btn-sm" onclick="App._showLogin()">Back</button>
            </div>
        `;
        // Enter submits from either field.
        card.querySelectorAll('input').forEach(el => el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') LoginEmail.submit();
        }));
        document.getElementById('login-email').focus();
    },

    async submit() {
        const email = document.getElementById('login-email')?.value.trim() || '';
        const password = document.getElementById('login-password')?.value || '';
        const name = document.getElementById('login-name')?.value.trim() || '';
        const errEl = document.getElementById('login-email-error');
        const btn = document.getElementById('login-email-submit');
        errEl.textContent = '';
        if (!email || !password) { errEl.textContent = 'Enter your email and password.'; return; }
        btn.disabled = true;
        try {
            const path = this._signupMode ? '/api/auth/email-signup' : '/api/auth/email-signin';
            const resp = await fetch(DashieAuth._addonUrl(path), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password, ...(this._signupMode ? { name } : {}) }),
            });
            const r = await resp.json();
            if (r.ok) {
                // JWT persisted server-side — reload so the auth boot sees it.
                window.location.reload();
                return;
            }
            // Google-provisioned emails get pointed at the right button;
            // everything else shows the server's message verbatim.
            errEl.textContent = r.error === 'use_google_signin'
                ? 'This email signs in with Google — use "Sign in with Google" instead.'
                : (r.message || r.error || 'Sign-in failed.');
        } catch (e) {
            errEl.textContent = 'Could not reach the add-on: ' + e.message;
        }
        btn.disabled = false;
    },
};

window.LoginEmail = LoginEmail;
