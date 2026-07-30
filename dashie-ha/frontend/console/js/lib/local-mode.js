/* ============================================================
   LocalMode — the panel you get when you have no Dashie account.
   ------------------------------------------------------------
   Dashie for Home Assistant runs fully on your own engines with no account, and PRIVACY.md and
   the README both say so. The panel used to contradict that: signed out, the
   only screen was "Sign in — connect your Home Assistant to your
   account". Someone who never intends to buy hosted compute installed
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

   Published-build only — the full build IS an account product, so it keeps
   its login. Gated on FeatureGate.isPublishedBuild() by the caller in app.js.
   ============================================================ */

(function () {
    'use strict';

    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /** One engine row. `value` null → an honest "not configured" rather than a blank. */
    function row(label, value, hint) {
        const set = !!value;
        return `
            <div class="dashie-local-row">
                <span class="dashie-local-dot ${set ? 'on' : 'off'}" aria-hidden="true"></span>
                <span class="dashie-local-label">${esc(label)}</span>
                <span class="dashie-local-value ${set ? '' : 'muted'}">
                    ${set ? esc(value) : 'not configured'}
                </span>
                ${hint ? `<span class="dashie-local-hint">${esc(hint)}</span>` : ''}
            </div>`;
    }

    const LocalMode = {
        /** Render into #content. `haUser` is runtime.ha_user (may be null, and its
         *  display_name may be null — X-Remote-User-Name is not guaranteed). */
        async show(haUser) {
            const el = document.getElementById('content');
            if (!el) return;

            const who = haUser && haUser.display_name ? `, ${haUser.display_name}` : '';

            // Where engine settings ACTUALLY live. Not "the Configuration tab" —
            // this panel is HA's sidebar ingress view and has no tabs; the tab is on
            // the add-on's own page. Field report 2026-07-30: "There's no
            // configuration tab though."
            //
            // NO DEEP LINK. The obvious one, /hassio/addon/<slug>/config, is DEAD:
            // HA moved the supervisor panel and /hassio/* now 404s at the HTTP level
            // (verified on HA 2026-07: /hassio/dashboard and /hassio/store both 404
            // while /config/addons is 200). A hardcoded frontend route has already
            // broken once, so don't ship a second guess — the written path below is
            // stable, and HA's own /_my_redirect/supervisor_addon is the version-proof
            // mechanism if a link is ever wanted back.
            el.innerHTML = `
                <div class="dashie-login-overlay">
                    <div class="dashie-login-card dashie-local-card">
                        <img src="${esc(BRAND.logo)}" alt="${esc(BRAND.productName)}" class="dashie-login-logo">
                        <div class="dashie-login-title">Running in local mode</div>
                        <div class="dashie-login-subtitle">
                            You're signed in to Home Assistant${esc(who)} — that's all
                            ${esc(BRAND.productName)} needs. No account required.
                        </div>
                        <div class="dashie-local-rows" id="dashie-local-rows">
                            <div class="dashie-local-loading">Checking your engines…</div>
                        </div>
                        <div class="dashie-local-note">
                            Engine settings aren't on this page. They live on the add-on's
                            own page — <strong>Settings → Add-ons →
                            ${esc(BRAND.productName)} → Configuration</strong>. Point
                            <code>llm_url</code>, <code>stt_url</code> and
                            <code>tts_url</code> at your own servers and everything runs
                            from your box, with no ${esc(BRAND.productName)} service
                            involved.
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
            const host = document.getElementById('dashie-local-rows');
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
                host.innerHTML = `<div class="dashie-local-loading">
                    Couldn't read engine status — check the add-on log.</div>`;
            }
        },
    };

    window.LocalMode = LocalMode;
})();
