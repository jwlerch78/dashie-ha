/* ============================================================
   Local Engines Page (add-on console only)
   ------------------------------------------------------------
   Manage the "own box" engines the user runs themselves — AI models (Ollama /
   llama.cpp), text-to-speech (Kokoro / Piper) and speech-to-text (whisper.cpp /
   faster-whisper). Each saved engine is a NAMED PRESET (see EnginesStore); they
   appear by name in the Voice & AI pickers, so switching between "Qwen 7B on the
   Mac" and "Kokoro" is one click instead of re-typing an IP.

   Storage: EnginesStore (JSON array in user_settings). Selecting an engine over
   in Voice & AI resolves it into the flat keys the tablets already read — the
   device never learns this registry exists.

   PROBE-ON-ENTRY: leaving (or pressing Enter in) the URL field probes the box
   through the add-on — the browser can't reach a LAN http:// engine from an
   https:// page — and the answer populates the Voice/Model dropdown. That's why
   this page is add-on-gated (FeatureGate 'localEngines' → 'addon').

   No secrets live here: an endpoint needing a key uses the API Keys page.
   ============================================================ */

const LocalEnginesPage = {
    _engines: null,       // [] once loaded
    _loading: false,
    _error: null,
    _editing: null,       // the engine draft being added/edited: {id?, name, kind, url, model}
    _probe: null,         // { state: 'idle'|'probing'|'ok'|'fail', detail, options[] } for the draft URL
    _busy: false,         // save/delete in flight
    _scanning: false,     // a network scan is in flight
    _scan: null,          // last scan result: { subnet, source, engines[], sources[] } | { error }

    topBarTitle() { return 'Local Engines'; },
    topBarSubtitle() { return ''; },

    onNavigateTo() { this._fetch(); },
    async refresh() { await this._fetch(); },

    async _fetch() {
        this._loading = true;
        this._error = null;
        App.renderPage();
        try {
            this._engines = await EnginesStore.list();
        } catch (e) {
            console.error('[LocalEnginesPage] fetch failed:', e);
            this._error = e?.message || String(e);
        }
        this._loading = false;
        App.renderPage();
    },

    // ── editing ──────────────────────────────────────────────

    add(kind = 'llm') {
        this._editing = { id: null, name: '', kind, url: '', model: '' };
        this._probe = null;
        App.renderPage();
    },

    // ── network scan ─────────────────────────────────────────

    /** Scan the household LAN for known engines (Ollama, Kokoro, Piper, whisper.cpp, …).
     *  USER-INITIATED — the add-on derives the subnet from HA/tablet IPs (never the browser,
     *  which can't see the LAN) and sweeps it. Best-effort: a failure shows a message + the
     *  manual-subnet fallback, never a dead end. */
    async scan(subnetOverride) {
        if (this._scanning) return;
        this._scanning = true;
        this._scan = null;
        App.renderPage();
        try {
            const r = await fetch(DashieAuth._addonUrl('/api/voice/discover'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(subnetOverride ? { subnet: subnetOverride } : {}),
            });
            if (r.status === 404) { this._scan = { error: `Update the ${BRAND.productName} add-on to scan for engines.` }; }
            else {
                const data = await r.json();
                this._scan = data?.ok ? data : { error: data?.reason === 'no_subnet'
                    ? "Couldn't work out your network automatically — enter it below."
                    : (data?.reason || 'scan failed'), needSubnet: data?.reason === 'no_subnet' };
            }
        } catch (e) {
            this._scan = { error: e?.message || String(e) };
        }
        this._scanning = false;
        App.renderPage();
    },

    /** Manual-subnet fallback: read the field and rescan that /24. */
    scanManual() {
        const v = String(document.getElementById('scan-subnet')?.value || '').trim();
        // Accept "192.168.1" or "192.168.1.0" or a full host IP — reduce to the /24 prefix.
        const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
        if (!m) { Toast.error('Enter a network like 192.168.1'); return; }
        this.scan(`${m[1]}.${m[2]}.${m[3]}`);
    },

    dismissScan() { this._scan = null; App.renderPage(); },

    /** Manual /24 entry + rescan button. Shown when auto-derive failed (no_subnet) AND in the
     *  "no engines found" case (the box may be on a different subnet than HA/the tablet). */
    _manualSubnetField() {
        return `<div style="display: flex; gap: 8px; margin-top: 10px; align-items: center;">
                    <input type="text" id="scan-subnet" placeholder="192.168.1" autocomplete="off"
                        style="${this._inputStyle()} max-width: 200px;">
                    <button class="btn btn-secondary btn-sm" onclick="LocalEnginesPage.scanManual()">Scan this network</button>
                </div>`;
    },

    /** Add a discovered engine → prefill the editor (name from the engine + host, kind + URL
     *  already known). The user confirms/renames and saves — we never write silently. */
    addFound(idx) {
        const found = (this._scan?.engines || [])[idx];
        if (!found) return;
        const label = found.engine.replace(/\s*\(.*\)$/, '');   // "Whisper (whisper.cpp)" → "Whisper"
        this._editing = {
            id: null,
            name: `${label} (${found.host})`,
            kind: found.kind,
            url: found.url,
            model: found.kind === 'llm' ? (found.models?.[0] || '') : '',
        };
        this._probe = null;
        this._scan = null;
        App.renderPage();
        if (found.url) this.probeDraft();   // fills the model/voice dropdown from the box
    },

    /** Engine type is a dropdown in the editor (one "Add engine" button, not three) —
     *  switching it resets the probe, since the new kind hits a different path.
     *  Editable on an EXISTING engine too (John, 2026-07-16): mis-typing the kind on a saved
     *  box shouldn't force a delete-and-re-add. Safe — a selection is matched by URL, not by
     *  engine id (EnginesStore.matchSelected), so a re-kinded engine simply stops matching its
     *  old stage's card instead of corrupting the stored provider keys. */
    setKind(kind) {
        if (!this._editing || !EnginesStore.kind(kind)) return;
        this._editing.kind = kind;
        this._editing.model = '';
        this._probe = null;
        App.renderPage();
        if (String(this._editing.url || '').trim()) this.probeDraft();
    },

    edit(id) {
        const e = (this._engines || []).find(x => x.id === id);
        if (!e) return;
        this._editing = { ...e };
        this._probe = null;
        App.renderPage();
        // Re-probe the saved URL so the Voice/Model dropdown is populated on open.
        if (e.url) this.probeDraft();
    },

    cancelEdit() {
        this._editing = null;
        this._probe = null;
        App.renderPage();
    },

    /** Field edits keep the draft in memory (no re-render — that would blur the input
     *  mid-type). The URL field re-renders only via probeDraft on Enter/blur. */
    setField(field, value) {
        if (!this._editing) return;
        this._editing[field] = value;
    },

    /** Probe-on-entry: ask the box what it offers, and turn Voice/Model into a
     *  dropdown. Fired on blur/Enter of the URL field. */
    async probeDraft() {
        const d = this._editing;
        if (!d) return;
        const url = String(d.url || '').trim();
        if (!url) { this._probe = null; App.renderPage(); return; }
        if (!/^https?:\/\//i.test(url)) {
            this._probe = { state: 'fail', detail: 'enter a full http:// URL (with port)', options: [] };
            App.renderPage();
            return;
        }
        const kind = EnginesStore.kind(d.kind);
        this._probe = { state: 'probing', detail: '', options: [] };
        App.renderPage();
        let result = null;
        try {
            const r = await fetch(DashieAuth._addonUrl('/api/voice/probe'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, kind: kind?.probe || 'llm' }),
            });
            result = r.ok ? await r.json() : { ok: false, detail: `HTTP ${r.status}` };
        } catch (e) {
            result = { ok: false, detail: e?.message || String(e) };
        }
        // Guard: the user may have switched drafts while the probe was in flight.
        if (this._editing !== d) return;
        this._probe = {
            state: result?.ok ? 'ok' : 'fail',
            detail: result?.detail || (result?.ok ? 'reachable' : 'no response'),
            options: result?.options || [],
        };
        // Blank model + a known list → preselect the first (AI engines only; a TTS engine
        // has no model/voice of its own — the voice is chosen on the Voice & AI card).
        if (result?.ok && d.kind === 'llm' && !String(d.model || '').trim() && this._probe.options.length) {
            d.model = this._probe.options[0].value;
        }
        App.renderPage();
    },

    async saveDraft() {
        const d = this._editing;
        if (!d || this._busy) return;
        if (!String(d.name || '').trim()) { Toast.error('Give the engine a name.'); return; }
        if (!/^https?:\/\//i.test(String(d.url || '').trim())) { Toast.error('Enter a full http:// URL (with port).'); return; }
        this._busy = true;
        App.renderPage();
        try {
            const saved = await EnginesStore.save(d);
            this._engines = await EnginesStore.list();
            // If this engine is the one currently in use, rewrite the resolved keys —
            // otherwise a changed URL/voice would never reach the tablets.
            await this._reResolveIfSelected(saved);
            this._editing = null;
            this._probe = null;
            Toast.success(`Saved “${saved.name}”.`);
        } catch (e) {
            console.error('[LocalEnginesPage] save failed:', e);
            Toast.error(`Couldn't save: ${e?.message || e}`);
        }
        this._busy = false;
        App.renderPage();
    },

    /** An edit to the ACTIVE engine must re-push its resolved values (the tablets read
     *  voice.localTtsUrl etc., not the engine record). */
    async _reResolveIfSelected(engine) {
        let defaults = null;
        try { defaults = await VoiceAiApi.loadAiDefaults(); } catch { return; }
        const active = EnginesStore.matchSelected(engine.kind, defaults);
        if (!active || active.id !== engine.id) return;
        for (const [key, value] of EnginesStore.resolveToSettings(engine)) {
            await DashieAuth.patchUserSetting(key, value);
        }
    },

    async duplicate(id) {
        try {
            await EnginesStore.duplicate(id);
            this._engines = await EnginesStore.list();
            App.renderPage();
        } catch (e) { Toast.error(`Couldn't duplicate: ${e?.message || e}`); }
    },

    async remove(id) {
        const e = (this._engines || []).find(x => x.id === id);
        const ok = await ConfirmModal.confirm({
            title: 'Remove engine',
            message: `“${e?.name || 'This engine'}” will be removed from your saved engines. Any device currently using it keeps working until you pick something else.`,
            confirmLabel: 'Remove',
            danger: true,
        });
        if (!ok) return;
        try {
            await EnginesStore.remove(id);
            this._engines = await EnginesStore.list();
            App.renderPage();
        } catch (err) { Toast.error(`Couldn't remove: ${err?.message || err}`); }
    },

    // ── render ───────────────────────────────────────────────

    render() {
        if (typeof DashieAuth === 'undefined' || !DashieAuth.isAddonMode) {
            return `
                <div class="card" style="max-width: 800px;"><div class="card-body" style="color: var(--text-secondary);">
                    Local engines run on your own network, so they're managed from the ${BRAND.consoleName}
                    add-on on your Home Assistant box.
                </div></div>`;
        }
        if (!this._engines && !this._loading && !this._error) {
            this._fetch();
            return `<div style="max-width: 800px; color: var(--text-muted); padding: 20px 0;">Loading…</div>`;
        }
        if (this._loading && !this._engines) {
            return `<div style="max-width: 800px; color: var(--text-muted); padding: 20px 0;">Loading…</div>`;
        }
        if (this._error && !this._engines) {
            return `
                <div class="card" style="max-width: 800px;"><div class="card-body" style="color: var(--status-error, #c00);">
                    Couldn't load engines: ${this._escape(this._error)}
                    <button class="btn btn-secondary btn-sm" style="margin-left: 12px;" onclick="LocalEnginesPage._fetch()">Retry</button>
                </div></div>`;
        }
        return `
            <div style="max-width: 800px;">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 20px;">
                    <div style="color: var(--text-secondary); font-size: var(--font-size-sm); line-height: 1.5;">
                        Engines you run yourself — an AI model, a voice, or speech-to-text on your own
                        hardware. Saved engines appear by name in <strong>Voice &amp; AI</strong>, so you
                        can switch between them without re-typing an address. They're free to run and
                        nothing leaves your network.
                    </div>
                    <div style="display: flex; gap: 8px; flex-shrink: 0;">
                        <button class="btn btn-secondary btn-sm"
                            onclick="LocalEnginesPage.scan()"${this._editing || this._scanning ? ' disabled' : ''}>${this._scanning ? 'Scanning…' : 'Scan network'}</button>
                        <button class="btn btn-primary btn-sm"
                            onclick="LocalEnginesPage.add()"${this._editing ? ' disabled' : ''}>+ Add engine</button>
                    </div>
                </div>
                ${this._renderScanResults()}
                ${this._editing ? this._renderEditor() : ''}
                ${EnginesStore.KINDS.map(k => this._renderKindSection(k)).join('')}
            </div>`;
    },

    /** Results of the last "Scan network". Each discovered engine gets an Add button that
     *  prefills the editor; anything already saved (same url+port) is shown as "Added". A
     *  Wyoming hit isn't OpenAI-compatible → shown with its "configure via HA" note, no Add. */
    _renderScanResults() {
        if (this._scanning) {
            return `<div class="card" style="margin-bottom: 16px;"><div class="card-body" style="color: var(--text-muted); font-size: 13px;">
                Scanning your network for engines… this takes a few seconds.
            </div></div>`;
        }
        const s = this._scan;
        if (!s) return '';
        if (s.error) {
            const manual = s.needSubnet ? this._manualSubnetField() : '';
            return `<div class="card" style="margin-bottom: 16px; border-left: 3px solid var(--status-error, #c00);"><div class="card-body">
                <div style="font-size: 13px;">${this._escape(s.error)}</div>${manual}
                <button class="btn btn-secondary btn-sm" style="margin-top: 10px;" onclick="LocalEnginesPage.dismissScan()">Dismiss</button>
            </div></div>`;
        }
        const saved = new Set((this._engines || []).map(e => String(e.url || '').replace(/\/+$/, '')));
        const rows = (s.engines || []).map((f, i) => this._renderFoundRow(f, i, saved)).join('');
        // No engines on the scanned /24 — the box may be on a DIFFERENT subnet than HA/the tablet,
        // so offer a manual rescan here too (not just when auto-derive failed), alongside "add by URL".
        const body = s.engines?.length
            ? rows
            : `<div style="color: var(--text-muted); font-size: 13px;">No engines found on <code>${this._escape(s.subnet)}.0/24</code>. If your box is on a different network, scan it below — or add it by URL with “+ Add”.</div>
               ${this._manualSubnetField()}`;
        // How we picked the network — reassures the user we scanned the right one, and is the
        // honest disclosure that we read HA/tablet IPs to find it.
        const src = s.source === 'manual' ? `network <code>${this._escape(s.subnet)}.0/24</code> (entered)`
            : `network <code>${this._escape(s.subnet)}.0/24</code>, from ${s.votes || 0} device${s.votes === 1 ? '' : 's'} on it`;
        return `
            <div class="card" style="margin-bottom: 16px; box-shadow: 0 0 0 2px var(--accent);"><div class="card-body">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                    <span style="font-weight: 600;">Scan results</span>
                    <button class="btn btn-secondary btn-sm" onclick="LocalEnginesPage.dismissScan()">Dismiss</button>
                </div>
                ${body}
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 10px;">Scanned ${src}. Nothing left your network.</div>
            </div></div>`;
    },

    _renderFoundRow(f, i, saved) {
        const O = window.VoiceAiOptions || {};
        const green = (O.COLOR || {}).local || '#16a34a';
        const already = saved.has(String(f.url || '').replace(/\/+$/, ''));
        const detail = f.tcpOnly ? (f.note || '')
            : (f.models?.length ? `${f.models.length} ${f.kind === 'llm' ? 'model' : 'voice'}${f.models.length === 1 ? '' : 's'}` : '');
        const action = f.tcpOnly
            ? `<span style="font-size: 11px; color: var(--text-muted); flex-shrink: 0;">via Home Assistant</span>`
            : already
                ? `<span style="font-size: 12px; color: ${green}; flex-shrink: 0;">✓ Added</span>`
                : `<button class="btn btn-secondary btn-sm" style="flex-shrink: 0;" onclick="LocalEnginesPage.addFound(${i})">Add</button>`;
        return `
            <div style="display: flex; align-items: center; gap: 12px; padding: 10px 0; border-top: 1px solid var(--border, #eee);">
                <div style="flex: 1; min-width: 0;">
                    <div style="font-weight: 600; font-size: 14px;">${this._escape(f.engine)}
                        <span style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: ${green}; margin-left: 4px;">${this._escape(f.kind)}</span>
                    </div>
                    <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px; font-family: ui-monospace, Menlo, monospace;">${this._escape(f.url)}${detail ? ` · ${this._escape(detail)}` : ''}</div>
                </div>
                ${action}
            </div>`;
    },

    /** Engines stay GROUPED by kind below — one section per kind, but the section headers
     *  no longer carry their own Add button (the type is a dropdown in the one editor). */
    _renderKindSection(kind) {
        const list = (this._engines || []).filter(e => e.kind === kind.id);
        const rows = list.length
            ? list.map(e => this._renderEngineRow(e)).join('')
            : `<div class="card"><div class="card-body" style="color: var(--text-muted); font-size: 13px;">
                   None yet — ${this._escape(kind.hint)}.
               </div></div>`;
        return `
            <div class="section-header" style="margin-top: 24px;">${this._escape(kind.label)}</div>
            ${rows}`;
    },

    /** Local-green row treatment, matching how local engines read on the Voice & AI page
     *  (tint + LOCAL tag + left accent bar) so the two pages tell the same colour story. */
    _renderEngineRow(e) {
        const O = window.VoiceAiOptions || {};
        const green = (O.COLOR || {}).local || '#16a34a';
        const tint = (O.BG || {}).local || 'rgba(22, 163, 74, 0.10)';
        const sub = [e.url, e.model].filter(Boolean).join(' · ');
        return `
            <div class="card" style="margin-bottom: 8px;"><div class="card-body"
                style="display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: ${tint}; border-left: 3px solid ${green};">
                <div style="flex: 1; min-width: 0;">
                    <div style="font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 8px;">
                        ${this._escape(e.name)}
                        <span style="font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; color: ${green};">Local</span>
                    </div>
                    <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis;">${this._escape(sub)}</div>
                </div>
                <button class="btn btn-secondary btn-sm" onclick="LocalEnginesPage.edit('${e.id}')">Edit</button>
                <button class="btn btn-secondary btn-sm" onclick="LocalEnginesPage.duplicate('${e.id}')" title="Add another model on this same box">Duplicate</button>
                <button class="btn btn-secondary btn-sm" onclick="LocalEnginesPage.remove('${e.id}')">Remove</button>
            </div></div>`;
    },

    _renderEditor() {
        const d = this._editing;
        const kind = EnginesStore.kind(d.kind) || EnginesStore.KINDS[0];
        const p = this._probe;
        const status = !p ? ''
            : p.state === 'probing' ? `<span style="color: var(--text-muted);">checking…</span>`
            : p.state === 'ok' ? `<span style="color: var(--status-success, #16a34a);">✓ ${this._escape(p.detail)}</span>`
            : `<span style="color: var(--status-error, #c00);">✗ ${this._escape(p.detail)}</span>
               <a href="#" onclick="event.preventDefault(); LocalEnginesPage.probeDraft()" style="margin-left: 8px; font-size: 12px;">Re-check</a>`;

        // Model field: AI engines only (kind.modelLabel present). A TTS engine is just a
        // box — its VOICE is picked on the Voice & AI card, so offering a voice here too
        // would be a second source of truth. STT servers expose no model list.
        const opts = p?.options || [];
        const modelRow = !kind.modelLabel ? '' : `
                    <label style="display: grid; gap: 4px; font-size: 12px; color: var(--text-muted);">
                        ${this._escape(kind.modelLabel)}
                        ${opts.length
                            ? `<select onchange="LocalEnginesPage.setField('model', this.value)" style="${this._inputStyle()}">
                                   ${opts.map(o => `<option value="${this._escape(o.value)}" ${o.value === d.model ? 'selected' : ''}>${this._escape(o.label)}</option>`).join('')}
                                   ${d.model && !opts.some(o => o.value === d.model) ? `<option value="${this._escape(d.model)}" selected>${this._escape(d.model)} (current)</option>` : ''}
                               </select>`
                            : `<input type="text" value="${this._escape(d.model || '')}" placeholder="${this._escape(kind.modelPlaceholder || '')}"
                                   autocomplete="off" oninput="LocalEnginesPage.setField('model', this.value)" style="${this._inputStyle()}">`}
                    </label>`;
        const voiceNote = d.kind === 'tts'
            ? `<div style="font-size: 12px; color: var(--text-muted); line-height: 1.5;">
                   Pick the voice under <strong>Voice &amp; AI</strong> once this engine is selected — its
                   voices are read from the box itself.
               </div>`
            : '';

        return `
            <div class="card" style="margin-bottom: 20px; box-shadow: 0 0 0 2px var(--accent);"><div class="card-body">
                <div style="font-weight: 600; margin-bottom: 14px;">${d.id ? 'Edit engine' : 'New engine'}</div>
                <div style="display: grid; gap: 12px;">
                    <label style="display: grid; gap: 4px; font-size: 12px; color: var(--text-muted);">
                        Type
                        <select onchange="LocalEnginesPage.setKind(this.value)" style="${this._inputStyle()}">
                            ${EnginesStore.KINDS.map(k =>
                                `<option value="${k.id}" ${k.id === d.kind ? 'selected' : ''}>${this._escape(k.label)}</option>`).join('')}
                        </select>
                        <span style="font-size: 11px; color: var(--text-muted);">${this._escape(kind.hint)}</span>
                    </label>
                    <label style="display: grid; gap: 4px; font-size: 12px; color: var(--text-muted);">
                        Name
                        <input type="text" value="${this._escape(d.name || '')}" placeholder="${this._escape(kind.namePlaceholder || '')}"
                            autocomplete="off" oninput="LocalEnginesPage.setField('name', this.value)" style="${this._inputStyle()}">
                    </label>
                    <label style="display: grid; gap: 4px; font-size: 12px; color: var(--text-muted);">
                        Address
                        <input type="text" id="engine-url" value="${this._escape(d.url || '')}" placeholder="${this._escape(kind.urlPlaceholder)}"
                            autocomplete="off" spellcheck="false"
                            oninput="LocalEnginesPage.setField('url', this.value)"
                            onblur="LocalEnginesPage.probeDraft()"
                            onkeydown="if (event.key === 'Enter') { event.preventDefault(); this.blur(); }"
                            style="${this._inputStyle()}">
                        <span style="min-height: 16px; font-size: 12px;">${status}</span>
                    </label>
                    ${modelRow}
                    ${voiceNote}
                </div>
                <div style="display: flex; gap: 8px; margin-top: 16px;">
                    <button class="btn btn-primary btn-sm" onclick="LocalEnginesPage.saveDraft()"${this._busy ? ' disabled' : ''}>${this._busy ? 'Saving…' : 'Save'}</button>
                    <button class="btn btn-secondary btn-sm" onclick="LocalEnginesPage.cancelEdit()">Cancel</button>
                </div>
            </div></div>`;
    },

    _inputStyle() {
        return 'padding: 8px 10px; border: 1px solid var(--border, #d1d5db); border-radius: 5px; font-size: 13px; width: 100%; box-sizing: border-box;';
    },

    _escape(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
};

window.LocalEnginesPage = LocalEnginesPage;
