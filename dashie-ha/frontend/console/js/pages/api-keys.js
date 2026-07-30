/* ============================================================
   API Keys Page (add-on console only)
   ------------------------------------------------------------
   BYO model-provider keys for the AI/brain (Open Brain plan
   20260710_OPEN_BRAIN_BYOK_PRESETS_UI.md §4). Keys are stored on
   the HA box's add-on /data volume via GET/PUT /api/keys — never
   in Supabase, never synced. The server returns masked values
   (last 4) and set-flags; full keys never round-trip back here.

   Gated on add-on mode (FeatureGate 'apiKeys' → 'addon'); in the
   cloud/website console the page and its nav item don't exist.

   Phase 1 = storage + UI only. Brain routing (device picks the
   add-on brain when a key exists) is Phase 2.
   ============================================================ */

const ApiKeysPage = {
    _providers: null,     // { gemini: {set, fields}, ... } — masked view from GET /api/keys
    _loading: false,
    _error: null,
    _busy: null,          // provider id currently saving/removing
    _testing: null,       // provider id currently being validated
    _testResult: {},      // { providerId: { ok: true|false|null, detail } } — last validation

    /** AI/brain providers (v1). `fields` drive the form; single-key providers
     *  use one masked input, Bedrock is multi-field. `group` buckets the cards on
     *  the page (see GROUPS): OpenRouter leads as the one-key-covers-everything
     *  option, individual vendor keys are the "I already have one" path.  */
    PROVIDERS: [
        {
            id: 'openrouter', name: 'OpenRouter', group: 'universal',
            // One key → every model in the picker. OpenRouter proxies the whole catalog over an
            // OpenAI-compatible endpoint, so it also covers Claude and Nova, which direct-key
            // BYOK can't serve yet (they'd need the deferred Anthropic/SigV4 adapters).
            fields: [{ id: 'key', label: 'API key', placeholder: 'sk-or-v1-…', secret: true }],
        },
        {
            id: 'gemini', name: 'Google Gemini', group: 'direct',
            fields: [{ id: 'key', label: 'API key', placeholder: 'AIza…', secret: true }],
        },
        {
            id: 'claude', name: 'Anthropic Claude', group: 'direct',
            fields: [{ id: 'key', label: 'API key', placeholder: 'sk-ant-…', secret: true }],
        },
        {
            id: 'openai', name: 'OpenAI', group: 'direct',
            fields: [{ id: 'key', label: 'API key', placeholder: 'sk-…', secret: true }],
        },
        {
            // Bedrock is NOT in the server's `routable` list (SigV4 signing, no OpenAI-compat
            // endpoint), so this card is filtered out — its Nova models are covered by
            // OpenRouter instead. Kept in the array only so an ALREADY-STORED bedrock key
            // still renders (with a warning) and can be removed. See _visibleProviders().
            id: 'bedrock', name: 'Amazon Bedrock', group: 'direct',
            fields: [
                { id: 'accessKeyId', label: 'Access key ID', placeholder: 'AKIA…', secret: true },
                { id: 'secretAccessKey', label: 'Secret access key', placeholder: '', secret: true },
                { id: 'region', label: 'Region', placeholder: 'us-east-1', secret: false },
            ],
        },
    ],

    /** Page sections, in render order. Direct provider keys lead (preferred — no markup);
     *  OpenRouter is the single-key catch-all (and the only path to Amazon Nova). */
    GROUPS: [
        { id: 'direct', title: 'Provider keys',
          blurb: `Add a key for the models you use — ${BRAND.productName} runs its brain directly on it, no markup.` },
        { id: 'universal', title: 'One key for everything',
          blurb: 'A single OpenRouter key unlocks every model, including Amazon Nova. Direct keys above skip OpenRouter’s markup.' },
    ],

    topBarTitle() { return 'API Keys'; },
    topBarSubtitle() { return ''; },

    onNavigateTo() { this._fetch(); },
    async refresh() { await this._fetch(); },

    async _fetch() {
        if (typeof DashieAuth === 'undefined' || !DashieAuth.isAddonMode) return;
        this._loading = true;
        this._error = null;
        App.renderPage();
        try {
            const resp = await fetch(DashieAuth._addonUrl('/api/keys'));
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            this._providers = data?.providers || {};
            // Providers whose key actually flips routing. null on an older add-on that doesn't
            // report it → render everything (previous behaviour), rather than hiding cards.
            this._routable = Array.isArray(data?.routable) ? data.routable : null;
        } catch (e) {
            console.error('[ApiKeysPage] fetch failed:', e);
            this._error = e?.message || String(e);
        }
        this._loading = false;
        App.renderPage();
    },

    render() {
        if (typeof DashieAuth === 'undefined' || !DashieAuth.isAddonMode) {
            return `
                <div class="card" style="max-width: 800px;"><div class="card-body" style="color: var(--text-secondary);">
                    API keys are stored on your Home Assistant box and managed from the ${BRAND.consoleName} add-on there.
                </div></div>`;
        }
        if (!this._providers && !this._loading && !this._error) {
            this._fetch();
            return `<div style="max-width: 800px; color: var(--text-muted); padding: 20px 0;">Loading…</div>`;
        }
        if (this._loading && !this._providers) {
            return `<div style="max-width: 800px; color: var(--text-muted); padding: 20px 0;">Loading…</div>`;
        }
        if (this._error && !this._providers) {
            return `
                <div class="card" style="max-width: 800px;"><div class="card-body" style="color: var(--status-error, #c00);">
                    Couldn't load API keys: ${this._escape(this._error)}
                    <button class="btn btn-secondary btn-sm" style="margin-left: 12px;" onclick="ApiKeysPage._fetch()">Retry</button>
                </div></div>`;
        }
        return `
            <div style="max-width: 800px;">
                <div style="margin-bottom: 20px; color: var(--text-secondary); font-size: var(--font-size-sm); line-height: 1.5;">
                    Bring your own AI: add a model-provider key and ${BRAND.productName} can run its brain on your
                    account instead of ${BRAND.productName} credits. Keys are stored <strong>only on this Home
                    Assistant box</strong> — they never leave it and are never synced to ${BRAND.cloudName}.
                </div>
                ${this.GROUPS.map((g, i) => {
                    const cards = this._visibleProviders().filter(p => p.group === g.id);
                    if (!cards.length) return '';
                    return `
                        <div class="section-header" ${i ? 'style="margin-top: 28px;"' : ''}>${this._escape(g.title)}</div>
                        ${g.blurb ? `<div style="margin: -4px 0 12px; color: var(--text-muted); font-size: 13px; line-height: 1.5;">${g.blurb}</div>` : ''}
                        ${cards.map(p => this._renderProviderCard(p)).join('')}`;
                }).join('')}
            </div>`;
    },

    /** Only offer a key field the brain can actually USE. A provider the server doesn't list
     *  as routable is hidden — UNLESS a key is already stored for it, in which case we still
     *  show the card (flagged `orphaned`) so the user can see it's inert and remove it.
     *  Guards against the class of bug where Claude/Bedrock keys saved, validated green, and
     *  then silently did nothing while turns kept billing Dashie credits. */
    _visibleProviders() {
        const routable = this._routable;
        if (!routable) return this.PROVIDERS;   // old add-on → previous behaviour
        return this.PROVIDERS
            .filter(p => routable.includes(p.id) || this._providers?.[p.id]?.set)
            .map(p => (routable.includes(p.id) ? p : { ...p, orphaned: true }));
    },

    _renderProviderCard(p) {
        const state = this._providers?.[p.id] || { set: false, fields: {} };
        const busy = this._busy === p.id;
        const testing = this._testing === p.id;
        const result = this._renderTestResult(p.id);
        const pill = state.set
            ? `<span style="font-size: 11px; font-weight: 700; color: var(--status-success, #16a34a); background: rgba(22,163,74,0.10); border-radius: 999px; padding: 3px 10px;">Key saved</span>`
            : `<span style="font-size: 11px; font-weight: 600; color: var(--text-muted); background: var(--bg-muted, #f4f4f5); border-radius: 999px; padding: 3px 10px;">Not set</span>`;
        const inputs = p.fields.map(f => {
            const saved = state.fields?.[f.id] || '';
            const placeholder = saved || f.placeholder || '';
            return `
                <label style="display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); flex: 1; min-width: 160px;">
                    ${this._escape(f.label)}
                    <input type="${f.secret ? 'password' : 'text'}" id="apikey-${p.id}-${f.id}"
                        placeholder="${this._escape(placeholder)}" autocomplete="off" ${busy ? 'disabled' : ''}
                        style="padding: 8px 10px; border: 1px solid var(--border, #d1d5db); border-radius: 4px; font-size: 14px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;">
                </label>`;
        }).join('');
        return `
            <div class="card" style="margin-bottom: 12px;"><div class="card-body">
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 6px;">
                    <div style="font-weight: 600; display: flex; align-items: center; gap: 8px;">
                        ${this._escape(p.name)}
                        ${p.orphaned ? `<span style="font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; color: var(--status-warn, #b45309); background: rgba(180,83,9,0.10); border-radius: 9px; padding: 2px 8px;">Not used</span>` : ''}
                    </div>
                    ${p.orphaned ? '' : pill}
                </div>
                ${p.orphaned ? `<div style="color: var(--text-secondary); font-size: 13px; line-height: 1.5; margin-bottom: 12px;">
                    ${BRAND.productName} can’t run its brain on this key yet, so it currently does <strong>nothing</strong> — your turns still use ${BRAND.productName} credits. Use an <strong>OpenRouter</strong> key to run these models on your own account, and remove this one.
                </div>` : ''}
                <div style="display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end;">
                    ${inputs}
                    <div style="display: flex; gap: 8px;">
                        <button class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''}
                            onclick="ApiKeysPage.save('${p.id}')">${busy ? 'Saving…' : 'Save'}</button>
                        ${state.set ? `<button class="btn btn-secondary btn-sm" ${busy || testing ? 'disabled' : ''}
                            onclick="ApiKeysPage.test('${p.id}')">${testing ? 'Testing…' : 'Test'}</button>` : ''}
                        ${state.set ? `<button class="btn btn-secondary btn-sm" ${busy ? 'disabled' : ''}
                            onclick="ApiKeysPage.remove('${p.id}')">Remove</button>` : ''}
                    </div>
                </div>
                ${result}
            </div></div>`;
    },

    /** Inline result of the last no-charge validation for this provider. */
    _renderTestResult(providerId) {
        const r = this._testResult[providerId];
        if (!r) return '';
        // ok:true green · ok:false red · ok:null muted (no test for this provider)
        const color = r.ok === true ? 'var(--status-success, #16a34a)'
            : r.ok === false ? 'var(--status-error, #c00)'
            : 'var(--text-muted)';
        const mark = r.ok === true ? '✓ ' : r.ok === false ? '✗ ' : '';
        return `<div style="margin-top: 10px; font-size: 12px; color: ${color};">${mark}${this._escape(r.detail || '')}</div>`;
    },

    async save(providerId) {
        const p = this.PROVIDERS.find(x => x.id === providerId);
        if (!p || this._busy) return;
        const value = {};
        let anyInput = false;
        for (const f of p.fields) {
            const el = document.getElementById(`apikey-${providerId}-${f.id}`);
            const v = (el?.value || '').trim();
            if (v) { value[f.id] = v; anyInput = true; }
        }
        if (!anyInput) {
            Toast.info('Enter a key first.');
            return;
        }
        // Multi-field providers must be saved whole — the store replaces the
        // provider entry, so a partial form would drop the missing fields.
        if (p.fields.length > 1 && p.fields.some(f => !value[f.id])) {
            Toast.error(`${p.name} needs all ${p.fields.length} fields.`);
            return;
        }
        const ok = await this._put(providerId, value, 'Key saved.');
        // Auto-validate right after a successful save + show the verdict in a modal
        // (the Test button stays for on-demand re-checks). Free /models probe.
        if (ok) await this._autoTest(providerId);
    },

    async remove(providerId) {
        if (this._busy) return;
        const p = this.PROVIDERS.find(x => x.id === providerId);
        const confirmed = await ConfirmModal.confirm({
            title: `Remove ${p?.name || providerId} key?`,
            message: `${BRAND.productName} will stop using this key. You can add it again any time.`,
            confirmLabel: 'Remove',
            cancelLabel: 'Cancel',
            danger: true,
        });
        if (!confirmed) return;
        await this._put(providerId, null, 'Key removed.');
    },

    /** No-charge validity check — asks the add-on to hit the provider's /models
     *  endpoint (a free GET, nothing billed). Sets _testResult (inline badge) and
     *  returns { ok, detail }. Shared by the Test button and auto-test-on-save. */
    async _runValidation(providerId) {
        this._testing = providerId;
        delete this._testResult[providerId];
        App.renderPage();
        let result;
        try {
            const resp = await fetch(DashieAuth._addonUrl('/api/keys/validate'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: providerId }),
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            result = { ok: data?.ok ?? null, detail: data?.detail || '' };
        } catch (e) {
            console.error('[ApiKeysPage] validate failed:', e);
            result = { ok: false, detail: `Couldn't run the test: ${e?.message || e}` };
        }
        this._testResult[providerId] = result;
        this._testing = null;
        App.renderPage();
        return result;
    },

    /** Test button: validate + show the result inline. */
    async test(providerId) {
        if (this._busy || this._testing) return;
        await this._runValidation(providerId);
    },

    /** Auto-test after a save: validate, then surface the verdict in a modal so a
     *  bad key is impossible to miss (John, 2026-07-13). The inline badge updates too. */
    async _autoTest(providerId) {
        const p = this.PROVIDERS.find(x => x.id === providerId);
        const name = p?.name || providerId;
        const r = await this._runValidation(providerId);
        if (r.ok === null) return;  // no test for this provider (bedrock/hermes) — silent
        if (typeof ConfirmModal === 'undefined') return;
        await ConfirmModal.confirm({
            title: r.ok ? `✓ ${name} key is valid` : `✗ ${name} key was rejected`,
            message: r.detail || (r.ok ? 'Your key works.' : 'The provider rejected this key.'),
            confirmLabel: 'OK',
            danger: !r.ok,
            hideCancel: true,
        });
    },

    /** @returns {Promise<boolean>} true when the write succeeded. */
    async _put(providerId, value, successMsg) {
        this._busy = providerId;
        // A saved/removed key invalidates the prior test result.
        delete this._testResult[providerId];
        App.renderPage();
        let ok = false;
        try {
            const resp = await fetch(DashieAuth._addonUrl('/api/keys'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: providerId, value }),
            });
            if (resp.status === 401) throw new Error(`Sign the add-on into a ${BRAND.productName} account first.`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            this._providers = data?.providers || this._providers;
            Toast.success(successMsg);
            ok = true;
        } catch (e) {
            console.error('[ApiKeysPage] save failed:', e);
            Toast.error(`Couldn't save: ${e?.message || e}`);
        }
        this._busy = null;
        App.renderPage();
        return ok;
    },

    _escape(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
};

window.ApiKeysPage = ApiKeysPage;
