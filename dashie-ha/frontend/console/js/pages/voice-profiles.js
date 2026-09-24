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

    /** Which layer the household's defaults come from right now. Guarded: this runs
     *  from a render path, and an absent lib must degrade rather than take the
     *  console shell down with it. */
    _layer() {
        return window.VoiceProfileKeys?.layer?.(this._settings)
            || { source: 'account', id: null, name: '', profile: null, has: [] };
    },

    /**
     * The devices following one profile — or null when that is not knowable.
     *
     * 🔴 THIS IS NOT READ FROM THE DEVICE ROW, and the first version of this page
     * got that wrong: it read `device.settings.voice.profileId`, a key NOTHING in
     * the webapp writes and that is not in SETTINGS_KEY_MAP, so it never reaches
     * user_devices. Every device came back unassigned — which is exactly what a
     * household with no assignments looks like. The delete warning was therefore
     * empty for every profile in every household, including the ones devices were
     * really following, and the emptiness was indistinguishable from the truth.
     *
     * What is actually true today: the webapp resolves the active profile from
     * localStorage['dashie-device-profile-id'], and nothing writes that key until
     * phase 2b ships a picker. So activeProfileId() is the seeded DEFAULT_PROFILE_ID
     * on every device, and the household follows exactly ONE profile — the one whose
     * id is that constant. Every other stored profile is inert.
     *
     * @returns {string[]|null} names, or null when the device list did not load —
     *   which must NOT render as "no devices", the mistake this comment exists for.
     */
    _followers(id) {
        const L = this._layer();
        if (L.source !== 'profile' || L.id !== id) return [];
        if (!Array.isArray(this._devices)) return null;
        return this._devices.map((d) => d.device_name || d.name || d.device_id || 'a device');
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
        // 🔴 The FIRST profile takes the seeded id, exactly as migrateToProfiles does
        // (`writeProfiles({ default: profile })`). Slugging the name instead would
        // create a profile no device points at — profiles would exist, every device
        // would dangle and fall back to the account layer, and the household would
        // have a "profile" that does nothing while the page said it was created.
        // Seeding from the account defaults means the resolved values are unchanged,
        // so becoming authoritative is a no-op on every screen. That is the point.
        const first = Object.keys(this._profiles()).length === 0;
        const id = first ? window.VoiceProfileKeys.DEFAULT_PROFILE_ID : this._slug(name);
        await this._patch(id, profile, 'create the profile');
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
        const users = this._followers(id);
        const warn = users === null
            ? `\n\nThe device list didn't load, so this can't say which devices follow it.`
            : users.length
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

    /**
     * The one line that says whether this profile is doing anything.
     *
     * ⚠️ Three states, not two. "Unknown" must never collapse into "none": the
     * device list can fail to load, and rendering that as "no devices follow this"
     * puts a confident wrong answer under a Delete button.
     */
    _who(id, users) {
        const L = this._layer();
        if (L.source === 'profile' && L.id === id) {
            if (users === null) return 'Active — device list unavailable';
            return users.length
                ? `Active · every device follows it (${this._esc(users.join(', '))})`
                : 'Active · no devices are claimed on this household yet';
        }
        // Stored, but nothing reads it: devices resolve their profile from a local
        // pointer no surface writes until the native picker (phase 2b) ships.
        return 'Not in use — devices can’t be pointed at this one yet';
    },

    _card(id, p, users) {
        const who = this._who(id, users);
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
        const layer = this._layer();
        const ids = Object.keys(profiles);
        const err = this._error
            ? `<div class="card" style="margin-bottom:12px;"><div class="card-body" style="color: var(--status-error,#c00);">${this._esc(this._error)}</div></div>`
            : '';

        const body = ids.length
            ? ids.map((id) => this._card(id, profiles[id], this._followers(id))).join('')
            : `<div class="card" style="margin-bottom:12px;"><div class="card-body" style="color: var(--text-secondary);">
                 <strong>No profiles yet — and that's fine.</strong><br>
                 Every device is following your household's voice &amp; AI defaults, exactly as it does today.
                 Create a profile when you want a named set you can point some devices at while others keep
                 the defaults.
               </div></div>`;

        // Profiles exist, but none carries the id every device points at — so every
        // device falls back to the account layer and logs a DROP, forever. Resolution
        // is correct; the profiles are simply doing nothing. Surfaced here because
        // the only other place it is visible is a device log nobody reads, and from
        // this page the household looks configured.
        const danglingCard = layer.source === 'dangling'
            ? `<div class="card" style="margin-bottom:12px;"><div class="card-body" style="color: var(--status-warn,#a60);">
                 <strong>None of these profiles is in use.</strong><br>
                 Your devices follow the profile named <code>${this._esc(layer.id)}</code>, and this household
                 doesn’t have one. Every device is using your household voice &amp; AI defaults instead —
                 nothing is broken, but nothing here is being applied either.
                 Duplicating a profile won’t help; this is fixed when devices can pick a profile themselves.
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
