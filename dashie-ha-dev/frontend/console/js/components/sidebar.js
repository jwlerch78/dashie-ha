/* ============================================================
   Sidebar Component
   ============================================================ */

const Sidebar = {
    render(activePage) {
        // Real balance from CreditsService — fetched once at boot and
        // refreshed after every Token Usage view (and, eventually, after
        // each call that decrements it). Falls back to '—' before the
        // first fetch returns so we don't flash a wrong number.
        const cached = window.CreditsService?.balance();
        const bal = (cached && typeof cached.balance === 'number') ? cached.balance : null;
        const balanceLabel = bal !== null ? `$${bal.toFixed(2)}` : '$—';
        // Low-balance deep-link: when the balance runs low, the credits widget
        // turns into a "Buy credits" prompt (still navigates to the Account page
        // where the Buy Credits packs live). $1 matches the auto-replenish default.
        const lowBalance = bal !== null && bal < 1.00;
        // Beta visibility — see js/lib/feature-gate.js. HA-only items are
        // hidden when the console is served from the public website; the
        // credits widget is dev-only; locations is hidden everywhere until
        // the feature is ready.
        // Gate on the PAGE, not the feature: the widget is a deep link to
        // 'credits', so it must not render when that page is unreachable — which
        // is the case in local mode, where there is no account to hold a balance.
        const showCredits = FeatureGate.isPageEnabled('credits');
        // Dashie Cloud dashboard section — built first so we can drop the whole
        // section (label + divider) when it has no visible items. For an ha_only
        // (voice-only) account every item here is gated off, so the section
        // collapses entirely rather than leaving an orphaned "Dashie Cloud" label.
        const dashieCloudItems = [
            this._startTrialNavItem(),
            this._purchaseNavItem(),
            this._gatedNavItem('family', 'Family', 'icon-profile-round', activePage),
            this._gatedNavItem('calendar', 'Calendar', 'icon-calendar', activePage),
            this._gatedNavItem('chores', 'Chores', 'icon-tasks', activePage),
            this._gatedNavItem('rewards', 'Rewards', 'icon-star', activePage),
            this._gatedNavItem('locations', 'Locations', 'icon-location-pin', activePage),
            this._gatedNavItem('photos', 'Photos', 'icon-photos', activePage),
        ].join('');
        const dashieCloudSection = dashieCloudItems.trim() ? `
            <div class="sidebar-divider"></div>

            <div class="sidebar-section">
                <div class="sidebar-section-label">${BRAND.cloudName}</div>
                ${dashieCloudItems}
            </div>
        ` : '';
        return `
            <div class="sidebar-logo">
                <img src="${BRAND.logo}" alt="${BRAND.productName}" class="sidebar-logo-full">
                <img src="${BRAND.icon}" alt="${BRAND.productName}" class="sidebar-logo-icon">
            </div>

            <div class="sidebar-section">
                ${this._gatedNavItem('devices', 'Dashboards', 'icon-tv', activePage)}
                ${this._gatedNavItem('voice-ai', 'Voice & AI', 'icon-ai-chat', activePage)}
                ${this._gatedNavItem('video-feeds', 'Video Feeds', 'icon-video-camera', activePage)}
                ${this._gatedNavItem('scheduled-actions', 'Scheduled Actions', 'icon-clock', activePage)}
                ${this._gatedNavItem('preferences', 'Preferences', 'icon-sliders', activePage)}
            </div>

            ${dashieCloudSection}

            <div class="sidebar-divider"></div>

            <div class="sidebar-section">
                <div class="sidebar-section-label">Manage</div>
                ${this._gatedNavItem('account', 'Account', 'icon-account-settings', activePage)}
                ${this._gatedNavItem('credits', 'Credits', 'icon-credits', activePage)}
                ${this._gatedNavItem('api-keys', 'API Keys', 'icon-key', activePage)}
                ${this._gatedNavItem('local-engines', 'Local Engines', 'icon-server', activePage)}
            </div>

            <div class="sidebar-footer">
                ${this._renderTrialPill()}
                ${showCredits ? `
                    <div class="sidebar-credits" onclick="App.navigate('credits')"${lowBalance ? ' style="color: var(--status-error, #c00);" title="Low balance — buy credits"' : ''}>
                        <span class="sidebar-credits-amount">${balanceLabel}</span>
                        <span class="sidebar-credits-label">${lowBalance ? 'Buy credits →' : 'credits'}</span>
                    </div>
                ` : ''}
                <div class="sidebar-version">${this._versionLabel()}</div>
            </div>
        `;
    },

    /**
     * The REAL version, not a hardcoded string (this read "v1.0.0" forever).
     * In add-on mode show the add-on's version — the one HA actually updates —
     * cached from GET /api/runtime by DashieAuth._probeAddonMode. On the website
     * fall back to the console build version. Renders nothing rather than lying
     * when neither is known (e.g. the probe hasn't landed yet).
     */
    _versionLabel() {
        // BARE DashieAuth — it's a top-level const, NOT on window (window.DashieAuth is
        // undefined; that exact mistake silently no-op'd the live rate card once).
        const addon = (typeof DashieAuth !== 'undefined') ? DashieAuth?._addonRuntimeInfo?.version : null;
        if (addon) return `v${addon}`;
        const consoleVersion = window.DASHIE_CONSOLE_VERSION;
        return consoleVersion ? `v${consoleVersion}` : '';
    },

    /**
     * Trial/subscription status pill in the sidebar footer (above credits +
     * version). Trial countdown + Subscribe while trialing; grace/past-due
     * nudge otherwise; nothing for active/complimentary or before state loads.
     * Re-renders with the sidebar whenever FeatureGate.setSubscriptionState
     * fires App.renderPage().
     */
    /** Trial/subscription pill (delta — Dashie builds only; open-core no-ops). */
    _renderTrialPill() {
        return window.SubscriptionStatus?.renderSidebarPill?.() ?? '';
    },

    /** Trial-start CTA nav entry (delta — Dashie builds only; open-core no-ops). */
    _startTrialNavItem() {
        return window.DashboardTrial?.renderStartTrialNavItem?.() ?? '';
    },

    /** Post-expiry purchase nav entry (delta — Dashie builds only; open-core no-ops). */
    _purchaseNavItem() {
        return window.SubscribeGate?.renderPurchaseNavItem?.() ?? '';
    },

    /** Renders a nav item only when FeatureGate allows the page. */
    _gatedNavItem(page, label, iconName, activePage) {
        if (!FeatureGate.isPageEnabled(page)) return '';
        return this._navItem(page, label, iconName, activePage);
    },

    _navItem(page, label, iconName, activePage) {
        const isActive = page === activePage ? 'active' : '';
        return `
            <div class="sidebar-nav-item ${isActive}" onclick="App.navigate('${page}')">
                <span class="nav-icon"><img src="assets/icons/${iconName}.svg" alt="${label}"></span>
                <span class="nav-label">${label}</span>
            </div>
        `;
    },
};
