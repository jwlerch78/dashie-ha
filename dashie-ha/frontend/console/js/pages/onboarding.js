// SPDX-License-Identifier: AGPL-3.0-only
// js/pages/onboarding.js
//
// First run: from nothing to a working assistant.
//
// The target is "paste a key → pick engines → working, in under a minute", and
// the shape of the flow follows from one fact: exactly ONE thing is required —
// a brain. Everything else has a fallback that already works (Home Assistant's
// own Whisper and Piper for speech, ESPN for sports, Wikimedia for images), so
// the honest story is "bring your brain key, optionally a search key", not a
// form with six fields.
//
// Every option is read from provider-manifest.js. This page holds NO list of
// its own — see the manifest's header for why.
//
// 🔴 What this page must never do
//
// Quote a price, show a balance, count down a quota, or take money. It reports
// connection state and links out to a provider's own signup page. That is a
// product rule, not a styling preference: this build has no payment surface and
// must not grow one.
//
// 🔴 And what it must never claim
//
// That a capability WORKS because a key is stored. Until a provider's on-box
// adapter ships (`adapter: 'pending'` in the manifest), a pasted key is stored
// and nothing more. Saying otherwise is how a tester ends up filing "search is
// broken" against a console that told them search was configured.

const OnboardingPage = {
    _step: 0,                 // 0 brain · 1 tools · 2 done
    _providers: {},           // masked view from GET /api/keys
    _saving: null,            // provider id in flight
    _error: null,
    _chosenBrain: null,

    topBarTitle() { return 'Set up'; },
    topBarSubtitle() { return ''; },

    onNavigateTo() { this._step = 0; this._error = null; this._fetch(); },
    async refresh() { await this._fetch(); },

    // ── data ─────────────────────────────────────────────────────────────────

    async _fetch() {
        if (typeof DashieAuth === 'undefined' || !DashieAuth.isAddonMode) return;
        try {
            const resp = await fetch(DashieAuth._addonUrl('/api/keys'));
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            this._providers = data?.providers || {};
        } catch (e) {
            console.error('[OnboardingPage] fetch failed:', e);
            this._error = e?.message || String(e);
        }
        App.renderPage();
    },

    /** Server truth for one provider, or undefined when it tracks no credential. */
    _serverStatus(provider) {
        const entry = this._providers[provider.id];
        return entry ? entry.set === true : undefined;
    },

    _isConfigured(provider) {
        return window.ProviderManifest.isConfigured(provider, this._serverStatus(provider));
    },

    _anyBrainConfigured() {
        return window.ProviderManifest
            .bySurface('onboarding', 'brain')
            .some(p => this._isConfigured(p));
    },

    async _save(providerId) {
        const provider = window.ProviderManifest.byId(providerId);
        if (!provider) return;

        const value = {};
        for (const f of provider.fields || []) {
            const el = document.getElementById(`pm-${providerId}-${f.id}`);
            if (el && el.value.trim()) value[f.id] = el.value.trim();
        }
        if (!Object.keys(value).length) return;

        this._saving = providerId;
        this._error = null;
        App.renderPage();
        try {
            const resp = await fetch(DashieAuth._addonUrl('/api/keys'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: providerId, value }),
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            this._providers = data?.providers || this._providers;
            if (provider.kind === 'brain') this._chosenBrain = providerId;
        } catch (e) {
            console.error('[OnboardingPage] save failed:', e);
            this._error = `Couldn’t save that key: ${e?.message || e}`;
        }
        this._saving = null;
        App.renderPage();
    },

    // ── steps ────────────────────────────────────────────────────────────────

    _next() {
        // Only the brain gates progress. A tool step the user skips entirely is a
        // completed step — that is what "optional" has to mean, or the flow is
        // six required fields wearing a disguise.
        if (this._step === 0 && !this._anyBrainConfigured()) {
            this._error = 'Add one AI provider key to continue — that is the only key this needs.';
            App.renderPage();
            return;
        }
        this._error = null;
        this._step = Math.min(2, this._step + 1);
        App.renderPage();
    },

    _back() { this._error = null; this._step = Math.max(0, this._step - 1); App.renderPage(); },

    // ── render ───────────────────────────────────────────────────────────────

    _card(provider) {
        const R = window.ProviderAuthRenderers;
        const configured = this._isConfigured(provider);
        const busy = this._saving === provider.id;
        const showSave = (provider.fields || []).length > 0;

        return `
            <section class="pm-card${provider.deprioritised ? ' pm-card--muted' : ''}"
                     data-provider="${R.esc(provider.id)}">
                <header class="pm-head">
                    <h3>${R.esc(provider.name)}</h3>
                    ${R.statusLine(provider, configured)}
                </header>
                ${provider.unlocks ? `<p class="pm-unlocks">${R.esc(provider.unlocks)}</p>` : ''}
                ${R.render(provider, {})}
                ${provider.note ? `<p class="pm-note">${R.esc(provider.note)}</p>` : ''}
                ${showSave ? `
                    <button class="pm-save" data-save="${R.esc(provider.id)}" ${busy ? 'disabled' : ''}>
                        ${busy ? 'Saving…' : (configured ? 'Replace key' : 'Save key')}
                    </button>` : ''}
            </section>`;
    },

    _stepBrain() {
        const M = window.ProviderManifest;
        const options = M.bySurface('onboarding', 'brain');
        return `
            <h2>Choose an AI provider</h2>
            <p class="pm-lead">
                ${BRAND.productName} runs on a provider key you supply — it goes on this box and
                stays here. This is the one key setup needs.
            </p>
            <div class="pm-grid">${options.map(p => this._card(p)).join('')}</div>`;
    },

    _stepTools() {
        const M = window.ProviderManifest;
        const R = window.ProviderAuthRenderers;
        const groups = {
            search: 'Web search',
            speech: 'Speech',
            images: 'Images',
            sports: 'Sports',
        };
        const tools = M.bySurface('onboarding', 'tool');
        const sections = Object.entries(groups).map(([g, title]) => {
            const inGroup = tools.filter(p => p.group === g);
            if (!inGroup.length) return '';
            return `<h3 class="pm-group">${R.esc(title)}</h3>
                    <div class="pm-grid">${inGroup.map(p => this._card(p)).join('')}</div>`;
        }).join('');

        return `
            <h2>Optional extras</h2>
            <p class="pm-lead">
                Every one of these is optional and everything below already works without a key —
                speech uses Home Assistant’s own engines, sports and images need no account at
                all. Web search is the one worth adding if you want it.
            </p>
            ${sections}`;
    },

    _stepDone() {
        return `
            <h2>You’re set up</h2>
            <p class="pm-lead">
                Your keys are stored on this box. You can change them any time under
                <strong>API Keys</strong>, and pick engines and voices under
                <strong>Voice &amp; AI</strong>.
            </p>
            <button class="pm-save" data-goto="voice-ai">Choose engines</button>`;
    },

    render() {
        if (typeof DashieAuth === 'undefined' || !DashieAuth.isAddonMode) {
            return '<div class="pm-page"><p>Setup runs inside the Home Assistant add-on.</p></div>';
        }
        const steps = ['AI provider', 'Extras', 'Done'];
        const body = [this._stepBrain(), this._stepTools(), this._stepDone()][this._step];

        return `
            <div class="pm-page">
                <ol class="pm-steps">
                    ${steps.map((s, i) => `<li class="${i === this._step ? 'is-current' : ''}${i < this._step ? ' is-done' : ''}">${s}</li>`).join('')}
                </ol>
                ${this._error ? `<p class="pm-error">${window.ProviderAuthRenderers.esc(this._error)}</p>` : ''}
                ${body}
                <nav class="pm-nav">
                    ${this._step > 0 ? '<button data-back="1">Back</button>' : ''}
                    ${this._step < 2 ? `<button data-next="1">${this._step === 1 ? 'Skip for now' : 'Continue'}</button>` : ''}
                </nav>
            </div>`;
    },

    onRendered(root) {
        const el = root || document;
        el.querySelectorAll('[data-save]').forEach(b =>
            b.addEventListener('click', () => this._save(b.getAttribute('data-save'))));
        el.querySelectorAll('[data-next]').forEach(b => b.addEventListener('click', () => this._next()));
        el.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', () => this._back()));
        el.querySelectorAll('[data-goto]').forEach(b =>
            b.addEventListener('click', () => App.navigateTo(b.getAttribute('data-goto'))));
    },
};
