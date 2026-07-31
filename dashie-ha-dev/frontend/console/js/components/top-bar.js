/* ============================================================
   Top Bar Component
   ============================================================ */

const TopBar = {
    _menuOpen: false,

    render(pageTitle, subtitle, showRefresh) {
        const user = MockData.user;
        // Per-page data refresh: re-fetches the current page's data in place
        // (no navigation / no full reload). Shown only for pages that expose a
        // refresh() method. Spins while a refresh is in flight (App._refreshing).
        const refreshing = (typeof App !== 'undefined' && App._refreshing);
        const refreshBtn = showRefresh ? `
                <button class="top-bar-refresh" title="Refresh data" aria-label="Refresh data"
                        onclick="App.refreshCurrentPage()" ${refreshing ? 'disabled' : ''}>
                    <img src="assets/icons/icon-reload.svg" alt=""
                         class="top-bar-refresh-icon${refreshing ? ' spinning' : ''}">
                </button>` : '';
        // Google profile photo when available (stored at sign-in), initials
        // fallback otherwise — or when the photo URL fails to load (expired
        // googleusercontent link). referrerpolicy avoids Google's 403 on
        // referred image requests.
        const avatar = user.picture
            ? `<img class="top-bar-avatar" src="${user.picture}" alt="" referrerpolicy="no-referrer"
                    style="object-fit: cover;"
                    onerror="this.outerHTML = TopBar._initialsAvatarHtml()">`
            : this._initialsAvatarHtml();
        // Local mode: no Dashie account, so this slot becomes the sign-in door
        // instead of an account menu. It shows the HA identity the add-on reports
        // over ingress — that IS who is signed in here — and the label states the
        // account is optional, because it is.
        const localMode = (typeof DashieAuth !== 'undefined') && DashieAuth.isLocalMode;
        const label = localMode ? (user.name || 'Not signed in') : user.email;
        // Avatar group is clickable — opens an account menu (Account
        // Settings, Sign Out), or the sign-in menu in local mode. Click outside
        // closes via _onDocumentClick.
        return `
            <div class="top-bar-left">
                <button class="hamburger-btn" onclick="App.toggleSidebar()">☰</button>
                <span class="top-bar-title">${pageTitle}</span>
                ${refreshBtn}
                ${subtitle ? `<span class="top-bar-subtitle">${subtitle}</span>` : ''}
            </div>
            <div class="top-bar-right">
                <div class="top-bar-user-wrapper" style="position: relative;">
                    <div class="top-bar-user" id="top-bar-user-trigger"
                         onclick="event.stopPropagation(); TopBar.toggleMenu()"
                         style="cursor: pointer; user-select: none;">
                        ${avatar}
                        <span class="top-bar-username">${label}</span>
                        <span class="top-bar-chevron" style="font-size: 10px; opacity: 0.6; margin-left: 2px;">▾</span>
                    </div>
                    ${this._menuOpen ? this._renderMenu() : ''}
                </div>
            </div>
        `;
    },

    _initialsAvatarHtml() {
        return `<div class="top-bar-avatar">${MockData.user.initials}</div>`;
    },

    _renderMenu() {
        // Local mode: the only account action available is acquiring one. No
        // Account Settings / Sign Out / Delete — there is nothing to manage,
        // sign out of, or delete.
        if ((typeof DashieAuth !== 'undefined') && DashieAuth.isLocalMode) return this._renderSignInMenu();
        // Subscribe entry for confirmed-expired users (delta — Dashie builds
        // only; open-core ships without SubscribeGate and this stays '').
        const subscribeRow = window.SubscribeGate?.renderMenuSubscribeRow?.() ?? '';
        return `
            <div class="top-bar-user-menu" id="top-bar-user-menu"
                 onclick="event.stopPropagation()"
                 style="position: absolute; top: calc(100% + 6px); right: 0; min-width: 220px;
                        background: var(--bg-card, #fff); border: 1px solid var(--border, #e5e7eb);
                        border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.08);
                        z-index: 1050; overflow: hidden;">
                ${subscribeRow}
                <button onclick="TopBar.closeMenu(); App.navigate('account')"
                        style="width: 100%; text-align: left; padding: 10px 14px; background: none;
                               border: none; cursor: pointer; font-size: 14px; color: var(--text-primary);">
                    Account Settings
                </button>
                <div style="height: 1px; background: var(--border, #e5e7eb);"></div>
                <button onclick="TopBar.closeMenu(); AccountPage.signOut()"
                        style="width: 100%; text-align: left; padding: 10px 14px; background: none;
                               border: none; cursor: pointer; font-size: 14px; color: var(--text-primary);">
                    Sign Out
                </button>
                <div style="height: 1px; background: var(--border, #e5e7eb);"></div>
                <button onclick="TopBar.closeMenu(); App.navigate('account'); setTimeout(() => AccountPage.handleDeleteAccount && AccountPage.handleDeleteAccount(), 100);"
                        style="width: 100%; text-align: left; padding: 10px 14px; background: none;
                               border: none; cursor: pointer; font-size: 14px; color: var(--status-error, #c00);">
                    Delete account…
                </button>
            </div>
        `;
    },

    /** Local-mode account menu: one door, and nothing else. It used to carry a
     *  "running on your own engines — no account needed" line; removed 2026-07-30
     *  (John) — the console already demonstrates that, and a menu is for actions. */
    _renderSignInMenu() {
        return `
            <div class="top-bar-user-menu" id="top-bar-user-menu"
                 onclick="event.stopPropagation()"
                 style="position: absolute; top: calc(100% + 6px); right: 0; min-width: 260px;
                        background: var(--bg-card, #fff); border: 1px solid var(--border, #e5e7eb);
                        border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.08);
                        z-index: 1050; overflow: hidden;">
                <button onclick="TopBar.closeMenu(); App.startSignIn()"
                        style="width: 100%; text-align: left; padding: 10px 14px; background: none;
                               border: none; cursor: pointer; font-size: 14px; color: var(--text-primary);">
                    Sign in or create an account
                    <div style="font-size: 12px; color: var(--text-muted, #777); margin-top: 2px;">
                        For hosted engines and credits
                    </div>
                </button>
            </div>
        `;
    },

    toggleMenu() {
        this._menuOpen = !this._menuOpen;
        if (this._menuOpen) {
            // One-shot outside-click handler — re-bind on each open so we
            // don't leak listeners across re-renders.
            setTimeout(() => document.addEventListener('click', this._onDocumentClick), 0);
        } else {
            document.removeEventListener('click', this._onDocumentClick);
        }
        App.renderPage();
    },

    closeMenu() {
        if (!this._menuOpen) return;
        this._menuOpen = false;
        document.removeEventListener('click', this._onDocumentClick);
        // No render here — caller typically navigates or fires another action
        // that triggers a render of its own.
    },

    _onDocumentClick(e) {
        if (e.target.closest('#top-bar-user-menu, #top-bar-user-trigger')) return;
        TopBar._menuOpen = false;
        document.removeEventListener('click', TopBar._onDocumentClick);
        App.renderPage();
    },
};
