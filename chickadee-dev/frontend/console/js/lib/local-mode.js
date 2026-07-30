/* ============================================================
   LocalMode — the panel you get when you have no Chickadee account.
   ------------------------------------------------------------
   Chickadee runs fully on your own engines with no account, and PRIVACY.md and
   the README both say so. The panel used to contradict that: signed out, the
   only screen was "Sign in to Chickadee — connect your Home Assistant to your
   Chickadee account". Someone who never intends to buy hosted compute installed
   the add-on and the first thing it did was ask them to create an account with
   the vendor. Whatever the docs said, that screen was the product's answer.

   Home Assistant has ALREADY authenticated whoever is reading an ingress panel
   — which is exactly why the console API needs no bridge secret (see the route
   map in server/index.js). So a second login was never authentication here. It
   was identity for billing, demanded of people who aren't billing.

   This view is what ingress users see instead: what's configured, where to
   change it, and sign-in as an option rather than a gate. It is deliberately
   READ-ONLY — engine settings live in the add-on's Configuration tab, which is
   the canonical store, and a second writable copy would just raise "which one
   wins?". Account pages stay behind the auth guard in renderPage(); nothing
   here reaches cloud state.

   Precedent: Music Assistant auto-provisions an admin when reached over ingress
   and drops you straight on settings. Frigate and Immich both use LOCAL
   accounts. None of them gate the app behind a vendor account.

   Chickadee-build only — the Dashie build IS an account product, so it keeps
   its login. Gated on FeatureGate.isChickadeeBuild() by the caller in app.js.
   ============================================================ */

(function () {
    'use strict';

    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /** One engine row. `value` null → an honest "not configured" rather than a blank. */
    function row(label, value, hint) {
        const set = !!value;
        return `
            <div class="chickadee-local-row">
                <span class="chickadee-local-dot ${set ? 'on' : 'off'}" aria-hidden="true"></span>
                <span class="chickadee-local-label">${esc(label)}</span>
                <span class="chickadee-local-value ${set ? '' : 'muted'}">
                    ${set ? esc(value) : 'not configured'}
                </span>
                ${hint ? `<span class="chickadee-local-hint">${esc(hint)}</span>` : ''}
            </div>`;
    }

    const LocalMode = {
        /** Render into #content. `haUser` is runtime.ha_user (may be null, and its
         *  display_name may be null — X-Remote-User-Name is not guaranteed). */
        async show(haUser) {
            const el = document.getElementById('content');
            if (!el) return;

            const who = haUser && haUser.display_name ? `, ${haUser.display_name}` : '';
            el.innerHTML = `
                <div class="dashie-login-overlay">
                    <div class="dashie-login-card chickadee-local-card">
                        <img src="${esc(BRAND.logo)}" alt="${esc(BRAND.productName)}" class="dashie-login-logo">
                        <div class="dashie-login-title">Running in local mode</div>
                        <div class="dashie-login-subtitle">
                            You're signed in to Home Assistant${esc(who)} — that's all
                            ${esc(BRAND.productName)} needs. No account required.
                        </div>
                        <div class="chickadee-local-rows" id="chickadee-local-rows">
                            <div class="chickadee-local-loading">Checking your engines…</div>
                        </div>
                        <div class="chickadee-local-note">
                            Engines are configured in this add-on's
                            <strong>Configuration</strong> tab. Point them at your own
                            LLM, speech-to-text, and voices and everything works from
                            your box — no ${esc(BRAND.productName)} service involved.
                        </div>
                        <div class="dashie-login-buttons">
                            <button class="dashie-path-btn secondary" onclick="App._handleAddonSignIn()">
                                <span class="dashie-path-text">
                                    <span class="dashie-path-label">Sign in</span>
                                    <span class="dashie-path-desc">Optional — only for hosted engines and credits</span>
                                </span>
                            </button>
                        </div>
                        <div class="dashie-login-footer">
                            <div class="dashie-login-legal">
                                <a href="${esc(BRAND.urls.privacy)}" target="_blank" rel="noopener">Privacy Policy</a>
                                <span class="dashie-legal-sep">&bull;</span>
                                <a href="${esc(BRAND.urls.terms)}" target="_blank" rel="noopener">Terms of Service</a>
                            </div>
                            <div class="dashie-login-version" id="dashie-login-version"></div>
                        </div>
                    </div>
                </div>`;

            this._loadStatus();
        },

        /** /api/voice/local-status is ingress-trusted already and needs no account.
         *  Failure is non-fatal: the view still explains where to configure. */
        async _loadStatus() {
            const host = document.getElementById('chickadee-local-rows');
            if (!host) return;
            try {
                const r = await fetch('api/voice/local-status');
                if (!r.ok) throw new Error('HTTP ' + r.status);
                const s = await r.json();
                const llm = s.endpoint && s.model ? `${s.endpoint} · ${s.model}`
                    : s.endpoint ? s.endpoint
                    : null;
                host.innerHTML =
                    row('Brain', llm, s.endpoint && !s.model ? 'needs a model id' : '') +
                    row('Speech-to-text', s.stt) +
                    row('Voices', s.tts);
            } catch (_) {
                // Don't invent a status we couldn't read.
                host.innerHTML = `<div class="chickadee-local-loading">
                    Couldn't read engine status — check the add-on log.</div>`;
            }
        },
    };

    window.LocalMode = LocalMode;
})();
