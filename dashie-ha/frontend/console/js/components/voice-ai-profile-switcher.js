/* ============================================================
   Voice & AI — the profile switcher
   ------------------------------------------------------------
   §6's approved design, and §7's guardrail: *"With a single profile the switcher is
   hidden entirely and the page is what it is today."* Most households have one
   profile forever; a mechanism that taxes the simple case to serve the testing case
   is a bad trade, so with only Default this renders NOTHING — not a disabled control,
   not a single-item dropdown.

   🔴 THE ACCOUNT IS THE DEFAULT PROFILE. Default always exists and cannot be deleted:
   it is the household's own voice settings, so "delete" would mean deleting the
   settings themselves. Rename and duplicate stay available.

   The CRUD here MOVED from the standalone Voice Profiles page rather than being
   rewritten — its sharp edges were expensive to get right and are all still live:
     · delete writes null, because patchUserSetting CANNOT delete a key (D-121)
     · rename changes the LABEL only; the id is what devices point at, so re-slugging
       would orphan every device following it
     · create refuses an incomplete profile: a missing key resolves to NOTHING on
       every device that follows it, and a silent device reads as broken hardware
   ============================================================ */

const VoiceAiProfileSwitcher = {
    _busy: false,
    _error: null,

    _esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },

    _settings() { return window.AccountSettingsStore?.get?.() || null; },
    _named() { return window.VoiceProfileKeys?.named?.(this._settings()) || {}; },
    _editingId() { return window.VoiceProfileScope?.editingId?.(this._settings()) || 'default'; },
    _isDefault(id) { return id === (window.VoiceProfileKeys?.DEFAULT_PROFILE_ID || 'default'); },

    /** Devices following one profile, by name. Null when the roster is not loaded —
     *  which must NOT render as "no devices": that emptiness would sit under a Delete
     *  button and read as a safe delete. */
    _followers(id) {
        const devices = window.DevicesPage?._devices;
        if (!Array.isArray(devices)) return null;
        const DEFAULT = window.VoiceProfileKeys?.DEFAULT_PROFILE_ID || 'default';
        return devices
            .filter((d) => (String(d?.settings?.voice?.profileId || '') || DEFAULT) === id)
            .map((d) => d.device_name || d.name || d.device_id || 'a device');
    },

    // ── Writes ───────────────────────────────────────────────────────────────

    async _patch(path, value, what) {
        if (this._busy) return false;
        this._busy = true;
        this._error = null;
        try {
            await DashieAuth.patchUserSetting(path, value);
            window.AccountSettingsStore?.reset?.();
            window.AccountSettingsStore?.ensure?.();
        } catch (e) {
            this._error = `Couldn't ${what}: ${e?.message || e}`;
            this._busy = false;
            App.renderPage();
            return false;
        }
        this._busy = false;
        App.renderPage();
        return true;
    },

    _slug(name) {
        const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const taken = Object.keys(this._named());
        let id = base || 'profile';
        let n = 2;
        // 'default' is reserved: it means the account paths, never a stored blob.
        while (taken.includes(id) || this._isDefault(id)) id = `${base}-${n++}`;
        return id;
    },

    /** Build a complete profile from what is on screen right now — the values the user
     *  has just been looking at, which is observed evidence rather than a promise.
     *  🔴 Reads the ACCOUNT paths (Default), never a device's resolved value: seeding a
     *  household profile from one tablet's choice promotes that tablet to the whole house. */
    _build(name, from) {
        const K = window.VoiceProfileKeys;
        const values = {};
        const missing = [];
        for (const [cat, key] of K.all()) {
            if (!values[cat]) values[cat] = {};
            const v = from[K.accountPath(cat, key)];
            values[cat][key] = (typeof v === 'string') ? v : '';
            if (typeof v !== 'string') missing.push(`${cat}.${key}`);
        }
        return { profile: { name, schemaVersion: 1, values }, missing };
    },

    async create(defaultsMap) {
        const name = await ConfirmModal.prompt({
            title: 'New voice profile',
            label: 'Name this profile',
            placeholder: 'Evenings',
            confirmLabel: 'Create',
        });
        if (!name || !name.trim()) return;
        const { profile, missing } = this._build(name.trim(), defaultsMap || {});
        if (missing.length) {
            // Refuse rather than write a partial one: a named profile does not fall
            // through to Default, so a missing key resolves to NOTHING on every device
            // following it — and a silent device reads as broken hardware.
            this._error = `Not created — ${missing.length} setting(s) have no value yet ` +
                `(${missing.join(', ')}). That would silence them on every device using this profile.`;
            App.renderPage();
            return;
        }
        const id = this._slug(name.trim());
        if (await this._patch(`voiceProfiles.${id}`, profile, 'create the profile')) {
            window.VoiceProfileScope?.setEditingId?.(id);
            App.renderPage();
        }
    },

    async rename() {
        const id = this._editingId();
        if (this._isDefault(id)) return;
        const src = this._named()[id];
        if (!src) return;
        const name = await ConfirmModal.prompt({
            title: 'Rename profile',
            label: 'Profile name',
            value: src.name,
            confirmLabel: 'Rename',
        });
        if (!name || !name.trim() || name.trim() === src.name) return;
        // Label only. The id is the handle devices point at; re-slugging orphans them.
        await this._patch(`voiceProfiles.${id}.name`, name.trim(), 'rename the profile');
    },

    async duplicate(defaultsMap) {
        const id = this._editingId();
        const src = this._isDefault(id) ? null : this._named()[id];
        const baseName = src ? `${src.name} copy` : 'Default copy';
        const name = await ConfirmModal.prompt({
            title: 'Duplicate profile',
            label: 'Name for the copy',
            value: baseName,
            confirmLabel: 'Duplicate',
        });
        if (!name || !name.trim()) return;
        const built = src
            ? { profile: { ...src, name: name.trim() }, missing: [] }
            : this._build(name.trim(), defaultsMap || {});
        if (built.missing.length) {
            this._error = `Not created — ${built.missing.length} setting(s) have no value yet.`;
            App.renderPage();
            return;
        }
        const newId = this._slug(name.trim());
        if (await this._patch(`voiceProfiles.${newId}`, built.profile, 'duplicate the profile')) {
            window.VoiceProfileScope?.setEditingId?.(newId);
            App.renderPage();
        }
    },

    async remove() {
        const id = this._editingId();
        // Default is the household's own settings. There is nothing coherent to delete.
        if (this._isDefault(id)) return;
        const src = this._named()[id];
        if (!src) return;

        // ⚠️ John, 2026-09-24: "a delete should caution and state that to the user."
        // Three outcomes, never silence — an empty follower list means different things
        // depending on WHY it is empty, and this is the last thing read before a
        // destructive click.
        const users = this._followers(id);
        const warn = users === null
            ? `The device list didn't load, so this can't say which devices are using it.`
            : users.length
                ? `⚠️ ${users.length} device${users.length > 1 ? 's are' : ' is'} using it ` +
                  `(${users.join(', ')}). ${users.length > 1 ? 'They' : 'It'} will fall back to Default, ` +
                  `so ${users.length > 1 ? 'their' : 'its'} voice setup will change.`
                : `No devices are using it, so nothing will change on any device.`;
        const ok = await ConfirmModal.confirm({
            title: `Delete "${src.name}"?`,
            message: `${warn}\n\nThis can't be undone.`,
            confirmLabel: 'Delete',
            danger: true,
        });
        if (!ok) return;

        // null, not absent: patchUserSetting cannot delete a key (D-121).
        if (await this._patch(`voiceProfiles.${id}`, null, 'delete the profile')) {
            window.VoiceProfileScope?.setEditingId?.('default');
            App.renderPage();
        }
    },

    select(id) {
        window.VoiceProfileScope?.setEditingId?.(id);
        App.renderPage();
    },

    // ── Render ───────────────────────────────────────────────────────────────

    render(defaultsMap) {
        const named = this._named();
        const ids = Object.keys(named);
        const editing = this._editingId();
        const err = this._error
            ? `<div class="card" style="margin-bottom:12px;"><div class="card-body" style="color: var(--status-error,#c00);">${this._esc(this._error)}</div></div>`
            : '';

        // §7: one profile ⇒ no switcher at all. Just the affordance to make a second.
        if (ids.length === 0) {
            return `${err}<div style="display:flex; justify-content:flex-end; margin-bottom:12px;">
                <button class="btn btn-secondary btn-sm" ${this._busy ? 'disabled' : ''}
                        onclick="VoiceAiProfileSwitcher.create(VoiceAiPage._defaults)">Create a profile</button>
            </div>`;
        }

        const opt = (id, label) =>
            `<option value="${this._esc(id)}" ${id === editing ? 'selected' : ''}>${this._esc(label)}</option>`;
        const options = [opt('default', 'Default'), ...ids.map((id) => opt(id, named[id].name || id))].join('');
        const onDefault = this._isDefault(editing);

        return `${err}
            <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:14px;">
              <label class="form-label" style="margin:0;">Editing</label>
              <select class="form-select" style="max-width:220px;" ${this._busy ? 'disabled' : ''}
                      onchange="VoiceAiProfileSwitcher.select(this.value)">${options}</select>
              <button class="btn btn-secondary btn-sm" ${this._busy ? 'disabled' : ''}
                      onclick="VoiceAiProfileSwitcher.create(VoiceAiPage._defaults)">New</button>
              <button class="btn btn-secondary btn-sm" ${this._busy ? 'disabled' : ''}
                      onclick="VoiceAiProfileSwitcher.duplicate(VoiceAiPage._defaults)">Duplicate</button>
              <button class="btn btn-secondary btn-sm" ${this._busy || onDefault ? 'disabled' : ''}
                      onclick="VoiceAiProfileSwitcher.rename()">Rename</button>
              <button class="btn btn-secondary btn-sm" ${this._busy || onDefault ? 'disabled' : ''}
                      onclick="VoiceAiProfileSwitcher.remove()">Delete</button>
            </div>
            <div style="color: var(--text-secondary); font-size:.88em; margin:-6px 0 14px;">
              ${onDefault
                ? 'These are your household defaults. Every device follows them unless you point it at another profile.'
                : `You're editing the <strong>${this._esc(named[editing]?.name || editing)}</strong> profile. Devices follow it only if you point them at it on the Devices page.`}
            </div>`;
    },
};

window.VoiceAiProfileSwitcher = VoiceAiProfileSwitcher;
