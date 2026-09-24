/* ============================================================
   Voice Profiles (add-on console)
   ------------------------------------------------------------
   A PROFILE is a COMPLETE named set of the household's voice/AI defaults. A
   device follows exactly one and may still carry its own per-key overrides on
   top. Resolution is two levels: profile → device override.

   🔴 THIS PAGE IS THE ONLY WAY A HOUSEHOLD EVER GETS A PROFILE.
   Decision C (John, 2026-09-23) removed automatic migration: nothing on a device
   creates a profile at boot, because the account layer may not have loaded yet
   and seeding from an unhydrated store would write a household profile built
   from fallbacks — invisible, because every device still gets *a* value. A human
   on this page has already SEEN the real values rendered, which is observed
   evidence rather than a promise. So creating here is the product path, not a
   convenience.

   ⚠️ A household with NO profiles is the normal, supported steady state — every
   device simply follows the account defaults exactly as it always has. That is
   not a pending migration and there is nothing to fix about it.

   Storage: `user_settings.voiceProfiles` (account scope), written through
   DashieAuth.patchUserSetting. 🔴 A patch CANNOT delete a key — deleting writes
   null (D-121), which is why the reader filters null entries rather than counting
   them as profiles.
   ============================================================ */

const VoiceProfilesPage = {
    _settings: null,
    _devices: null,
    _loading: false,
    _error: null,
    _busy: false,

    topBarTitle() { return 'Voice Profiles'; },
    topBarSubtitle() { return ''; },

    onNavigateTo() { this._fetch(); },
    async refresh() { await this._fetch(); },

    async _fetch() {
        this._loading = true;
        this._error = null;
        try {
            const [settings, devices] = await Promise.all([
                DashieAuth.loadUserSettings(),
                (typeof DevicesSource !== 'undefined' ? DevicesSource.fetch() : Promise.resolve(null)),
            ]);
            this._settings = settings || {};
            this._devices = Array.isArray(devices) ? devices : (devices?.devices || null);
        } catch (e) {
            this._error = e?.message || String(e);
        } finally {
            this._loading = false;
            if (typeof App !== 'undefined') App.renderPage();
        }
    },

    /** Live profiles only — a deleted one is stored as null, never removed (D-121). */
    _profiles() {
        const raw = this._settings?.voiceProfiles;
        if (!raw || typeof raw !== 'object') return {};
        const live = {};
        for (const [id, p] of Object.entries(raw)) if (p && typeof p === 'object') live[id] = p;
        return live;
    },

    /** id -> [device name, …]. Devices naming a profile that no longer exists are
     *  counted under that id on purpose, so a dangling assignment is VISIBLE here
     *  rather than only as a DROP in a device log nobody reads. */
    _assignments() {
        const out = {};
        for (const d of (this._devices || [])) {
            const id = d?.settings?.voice?.profileId;
            if (!id) continue;
            (out[id] = out[id] || []).push(d.device_name || d.name || d.device_id || 'a device');
        }
        return out;
    },

    _esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },

    _slug(name) {
        const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const taken = Object.keys(this._profiles());
        let id = base || 'profile';
        let n = 2;
        while (taken.includes(id)) id = `${base}-${n++}`;
        return id;
    },

    // ── Writes ───────────────────────────────────────────────────────────────

    async _patch(id, value, what) {
        if (this._busy) return;
        this._busy = true;
        try {
            await DashieAuth.patchUserSetting(`voiceProfiles.${id}`, value);
            await this._fetch();            // read back; a write not re-read is a hypothesis
        } catch (e) {
            this._error = `Couldn't ${what}: ${e?.message || e}`;
            this._busy = false;
            if (typeof App !== 'undefined') App.renderPage();
            return;
        }
        this._busy = false;
        if (typeof App !== 'undefined') App.renderPage();
    },

    async createFromDefaults() {
        const name = prompt('Name this profile', 'Default');
        if (!name) return;
        const read = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), this._settings);
        const profile = window.VoiceProfileKeys.build(name.trim(), read);
        const { complete, missing } = window.VoiceProfileKeys.isComplete(profile);
        if (!complete) {
            // Refuse rather than write a partial one: under the per-household fallback a
            // missing key resolves to NOTHING on every inheriting device, and a silent
            // device reads as broken hardware rather than as a bad profile.
            this._error = `Not created — the profile would be missing ${missing.join(', ')}. ` +
                `That would silence those settings on every device following it.`;
            if (typeof App !== 'undefined') App.renderPage();
            return;
        }
        await this._patch(this._slug(name), profile, 'create the profile');
    },

    async duplicate(id) {
        const src = this._profiles()[id];
        if (!src) return;
        const name = prompt('Name for the copy', `${src.name} copy`);
        if (!name) return;
        await this._patch(this._slug(name), { ...src, name: name.trim() }, 'duplicate the profile');
    },

    async rename(id) {
        const src = this._profiles()[id];
        if (!src) return;
        const name = prompt('Rename profile', src.name);
        if (!name || name.trim() === src.name) return;
        // The id is the stable handle devices point at, so renaming changes the LABEL
        // only. Re-slugging would orphan every device following it.
        await this._patch(id, { ...src, name: name.trim() }, 'rename the profile');
    },

    async remove(id) {
        const src = this._profiles()[id];
        if (!src) return;
        const users = this._assignments()[id] || [];
        const warn = users.length
            ? `\n\n${users.length} device${users.length > 1 ? 's' : ''} follow${users.length > 1 ? '' : 's'} it (${users.join(', ')}). ` +
              `They will fall back to the household defaults.`
            : '';
        if (!confirm(`Delete "${src.name}"?${warn}`)) return;
        // null, not absent: patchUserSetting cannot delete a key (D-121).
        await this._patch(id, null, 'delete the profile');
    },

    // ── Render ───────────────────────────────────────────────────────────────

    _summary(p) {
        const v = p.values?.voice || {};
        const a = p.values?.aiVoice || {};
        const bits = [
            v.pipelinePreset && `Preset: ${v.pipelinePreset}`,
            v.sttProvider && `STT: ${v.sttProvider}`,
            v.ttsProvider && `TTS: ${v.ttsProvider}`,
            a.personalityId && `Personality: ${a.personalityId}`,
            a.wakeWord && `Wake word: ${a.wakeWord}`,
        ].filter(Boolean);
        return bits.length ? bits.map((b) => this._esc(b)).join(' · ') : 'No values set';
    },

    _card(id, p, users) {
        const who = users.length
            ? `${users.length} device${users.length > 1 ? 's' : ''}: ${this._esc(users.join(', '))}`
            : 'No devices follow this profile yet';
        return `
            <div class="card" style="margin-bottom: 12px;">
              <div class="card-body">
                <div style="display:flex; align-items:baseline; gap:10px; flex-wrap:wrap;">
                  <strong style="font-size:1.05em;">${this._esc(p.name)}</strong>
                  <span style="color: var(--text-muted); font-size:.9em;">${who}</span>
                </div>
                <div style="color: var(--text-secondary); font-size:.9em; margin-top:6px;">${this._summary(p)}</div>
                <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;">
                  <button class="btn btn-secondary btn-sm" onclick="VoiceProfilesPage.rename('${this._esc(id)}')">Rename</button>
                  <button class="btn btn-secondary btn-sm" onclick="VoiceProfilesPage.duplicate('${this._esc(id)}')">Duplicate</button>
                  <button class="btn btn-secondary btn-sm" onclick="VoiceProfilesPage.remove('${this._esc(id)}')">Delete</button>
                </div>
              </div>
            </div>`;
    },

    render() {
        if (this._loading && !this._settings) {
            return `<div style="max-width:800px; color: var(--text-muted); padding:20px 0;">Loading…</div>`;
        }
        if (this._error && !this._settings) {
            return `<div class="card" style="max-width:800px;"><div class="card-body" style="color: var(--status-error,#c00);">
                Couldn't load profiles: ${this._esc(this._error)}
                <button class="btn btn-secondary btn-sm" style="margin-left:12px;" onclick="VoiceProfilesPage._fetch()">Retry</button>
            </div></div>`;
        }
        const profiles = this._profiles();
        const assignments = this._assignments();
        const ids = Object.keys(profiles);
        const err = this._error
            ? `<div class="card" style="margin-bottom:12px;"><div class="card-body" style="color: var(--status-error,#c00);">${this._esc(this._error)}</div></div>`
            : '';

        const body = ids.length
            ? ids.map((id) => this._card(id, profiles[id], assignments[id] || [])).join('')
            : `<div class="card" style="margin-bottom:12px;"><div class="card-body" style="color: var(--text-secondary);">
                 <strong>No profiles yet — and that's fine.</strong><br>
                 Every device is following your household's voice &amp; AI defaults, exactly as it does today.
                 Create a profile when you want a named set you can point some devices at while others keep
                 the defaults.
               </div></div>`;

        // A device pointing at a profile that no longer exists: surfaced here because the
        // device itself only says so in a log, and a setting that changed with nobody
        // touching it should never be silent.
        const dangling = Object.keys(assignments).filter((id) => !profiles[id]);
        const danglingCard = dangling.length
            ? `<div class="card" style="margin-bottom:12px;"><div class="card-body" style="color: var(--status-warn,#a60);">
                 ${dangling.map((id) => `${this._esc(assignments[id].join(', '))} follow${assignments[id].length > 1 ? '' : 's'}
                 a profile that no longer exists (<code>${this._esc(id)}</code>) — ${assignments[id].length > 1 ? 'they are' : 'it is'}
                 using the household defaults.`).join('<br>')}
               </div></div>`
            : '';

        return `
            <div style="max-width:800px;">
              ${err}${danglingCard}
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <div style="color: var(--text-secondary); font-size:.92em;">
                  A profile is a complete set of voice &amp; AI defaults. A device follows one, and can still
                  override individual settings.
                </div>
                <button class="btn btn-primary btn-sm" ${this._busy ? 'disabled' : ''}
                        onclick="VoiceProfilesPage.createFromDefaults()">Create profile</button>
              </div>
              ${body}
            </div>`;
    },
};
