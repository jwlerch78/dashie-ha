/* ============================================================
   Devices — Unified "Available to Add" Banner
   ------------------------------------------------------------
   Surfaces every device the user can add to their account, regardless
   of how the backend knows about it:

   - **install** kind — `device_installs` rows on the same network as
     a device the user already claimed (from list_claimable_devices).
     Claimed via the bulk `claim_devices` edge fn.
   - **discovered** kind — devices HA reports state for but which never
     called register_device (kiosk-mode tablets — no install row, no
     sign-in). Added via the add-on's POST /api/ha/adopt/:deviceId,
     which calls adopt_device_from_ha on the backend.

   The UI is identical for both — same row, same Add button, same
   Dismiss ✕. Routing happens inside claimSelected() based on each
   row's `kind`. Users don't need to know the difference.

   Dismissals are persisted server-side via ConsoleState (per-user,
   cross-browser). install rows dismiss by install_id; discovered rows
   dismiss by HA device_id; both surface in the unified Dismissed
   section rendered by DevicesPage.
   ============================================================ */

const DevicesClaim = {
    _claimable: null,              // raw list_claimable_devices result
    _claiming: false,              // request in flight (claim or adopt)
    _selected: new Set(),          // uids currently checked

    /**
     * Refresh the claimable installs list. Discovered devices come from
     * DevicesPage._discoveredDevices() (which reads the worker's status
     * — no separate fetch needed). Non-critical — swallows errors so a
     * failure here doesn't block the devices page.
     */
    async fetch() {
        // Hydrate dismissals before computing visibility. ConsoleState.load()
        // is idempotent — multiple callers await the same promise.
        if (typeof ConsoleState !== 'undefined') {
            try { await ConsoleState.load(); } catch (_) { /* non-critical */ }
        }
        try {
            const result = await DashieAuth.dbRequest('list_claimable_devices', {});
            this._claimable = result.devices || [];
            const uids = new Set(this._addable().map(a => a.uid));
            // Drop selections that are no longer addable.
            this._selected = new Set([...this._selected].filter(uid => uids.has(uid)));
        } catch (e) {
            console.warn('[DevicesClaim] list_claimable_devices failed:', e.message);
            this._claimable = this._claimable || [];
        }
    },

    /**
     * Merge installs + discovered into a single unified shape. Both kinds
     * render through the same banner row markup.
     *
     * Unified row:
     *   { uid, kind, name, deviceType, lastSeen, installId?, haDeviceId? }
     */
    _addable() {
        const list = [];
        // install rows from list_claimable_devices
        for (const d of (this._claimable || [])) {
            let name = `${d.device_brand || ''} ${d.device_model || ''}`.trim() || d.android_id || 'Unknown device';
            // Tag non-prod debug builds so a dev's fleet (same physical
            // tablet running multiple flavors) is visually distinguishable.
            // Real end users only ever install one flavor, so they see no tag.
            if (d.build_flavor === 'staging') name += ' -dev';
            else if (d.build_flavor === 'local') name += ' -loc';
            list.push({
                uid: d.id,                // install_id UUID
                kind: 'install',
                name,
                deviceType: d.device_type || 'device',
                lastSeen: d.last_checkin_at || d.installed_at,
                installId: d.id,
                haDeviceId: null,
            });
        }
        // discovered devices from the add-on worker's unmatched array.
        // Dedup against BOTH unclaimed installs (android_id == device_id
        // means the same hardware is also surfaced as an install row) AND
        // already-claimed devices (so HA-reported state for a device the
        // user already owns doesn't reappear as a "new" addable).
        const discovered = (typeof DevicesPage !== 'undefined' && DevicesPage._discoveredDevices)
            ? DevicesPage._discoveredDevices() : [];
        const claimedDevices = (typeof DevicesPage !== 'undefined' && DevicesPage._devices) ? DevicesPage._devices : [];
        const claimedIds = new Set(claimedDevices.map(d => d.device_id).filter(Boolean));
        // Name-based fallback: same physical device can land in user_devices
        // under one identifier path and in HA's registry under another (e.g.
        // user_devices.device_id from Dashie sign-in vs HA's device entry
        // created during a separate registration flow). When the IDs don't
        // match, fall back to a normalized device_name comparison — BUT
        // only against LIVE claimed devices. A stale offline same-name row
        // (e.g. an old sign-in under a previous android_id) shouldn't block
        // the user from adopting the freshly-reachable device under its new
        // identifier; that's the only path back to "Online" when the install
        // signing key changes (flavor swap, reinstall, factory reset, etc.).
        const norm = s => (typeof s === 'string' ? s.trim().toLowerCase() : '');
        const claimedNames = new Set(
            claimedDevices
                .filter(d => typeof DevicesPage._isLive === 'function' && DevicesPage._isLive(d))
                .map(d => norm(d.device_name))
                .filter(Boolean)
        );
        for (const d of discovered) {
            if (!d.device_id) continue;   // need device_id to call /api/ha/adopt
            if (claimedIds.has(d.device_id)) continue;  // already in user's account (by id)
            if (claimedNames.has(norm(d.device_name))) continue;  // ...or by name
            const installRow = (this._claimable || []).find(c => c.android_id === d.device_id);
            if (installRow) continue;     // already represented by the install entry
            // Tag with -dev / -loc when the worker's freshDevices entry tells
            // us this device is running a non-prod build. Same convention as
            // install rows — keeps a multi-flavor dev fleet legible.
            let discoveredName = d.device_name || `Device ${d.device_id.slice(0, 8)}`;
            const fresh = (typeof DevicesPage._freshDeviceFor === 'function')
                ? DevicesPage._freshDeviceFor(d.device_id) : null;
            const appVersion = fresh?.metrics?.app?.app_version || '';
            if (appVersion.endsWith('-staging'))    discoveredName += ' -dev';
            else if (appVersion.endsWith('-local')) discoveredName += ' -loc';
            list.push({
                uid: 'ha:' + d.device_id,
                kind: 'discovered',
                name: discoveredName,
                deviceType: 'device',     // discovered payload doesn't have type
                lastSeen: null,           // worker doesn't surface a last-seen for unmatched
                installId: null,
                haDeviceId: d.device_id,
            });
        }
        return list;
    },

    /** Is this addable row currently dismissed in ConsoleState? */
    _isAddableDismissed(a) {
        if (typeof ConsoleState === 'undefined') return false;
        const kind = a.kind === 'install' ? 'installs' : 'discovered';
        const id = a.kind === 'install' ? a.installId : a.haDeviceId;
        return ConsoleState.isDismissed(kind, id);
    },

    /** Addables not yet dismissed. */
    _visible() {
        return this._addable().filter(a => !this._isAddableDismissed(a));
    },

    /** Addables the user dismissed. */
    _hidden() {
        return this._addable().filter(a => this._isAddableDismissed(a));
    },

    /** Stable signature — devices.js uses it to skip silent-refresh repaints. */
    signature() {
        const vis = this._visible().map(a => a.uid).sort().join(',');
        const hid = this._hidden().map(a => a.uid).sort().join(',');
        return `${vis}|${hid}`;
    },

    renderBanner() {
        const items = this._visible();
        if (items.length === 0) return '';
        const escape = DevicesPage._escape.bind(DevicesPage);

        const rows = items.map(a => {
            const uid = escape(a.uid);
            const checked = this._selected.has(a.uid) ? 'checked' : '';
            const seenText = a.lastSeen
                ? `seen ${DevicesPage._formatTime(a.lastSeen)}`
                : 'reported by Home Assistant';
            return `
                <div style="display: flex; align-items: center; gap: 8px;">
                    <label style="display: flex; align-items: center; gap: 10px; padding: 8px 0; cursor: pointer; flex: 1; min-width: 0;">
                        <input type="checkbox" ${checked} onchange="DevicesClaim.toggleSelect('${uid}')">
                        <span style="font-size: 18px;">${DevicesPage._deviceIcon(a.deviceType)}</span>
                        <span style="min-width: 0;">
                            <span style="font-weight: 500;">${escape(a.name)}</span>
                            <span style="color: var(--text-muted); font-size: var(--font-size-sm); display: block;">
                                ${escape(a.deviceType)} · ${seenText}
                            </span>
                        </span>
                    </label>
                    <button title="Dismiss — hide this device from the banner"
                        onclick="DevicesClaim.dismiss('${uid}')"
                        style="background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 16px; padding: 4px 8px; line-height: 1; flex-shrink: 0;">✕</button>
                </div>
            `;
        }).join('');

        const n = this._selected.size;
        const allChecked = n === items.length && n > 0;
        const addLabel = this._claiming
            ? 'Adding…'
            : (n === 0 ? 'Add devices' : `Add ${n} device${n === 1 ? '' : 's'}`);

        return `
            <div class="card" style="margin-bottom: 16px; border-left: 3px solid var(--accent);">
                <div class="card-body">
                    <strong>${items.length} device${items.length === 1 ? '' : 's'} can be added to your account.</strong>
                    <div style="display: flex; justify-content: flex-end; padding: 4px 0 6px;">
                        <button class="btn btn-secondary btn-sm" onclick="DevicesClaim.toggleSelectAll()">
                            ${allChecked ? 'Clear all' : 'Select all'}
                        </button>
                    </div>
                    <div style="border-top: 1px solid var(--border, #d1d5db);">
                        ${rows}
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap;">
                        <button class="btn btn-primary btn-sm" ${n === 0 || this._claiming ? 'disabled' : ''}
                            onclick="DevicesClaim.claimSelected()">
                            ${addLabel}
                        </button>
                        <button class="btn btn-secondary btn-sm" title="Hide every device in this banner — they'll move to the Dismissed section at the bottom of the page"
                            onclick="DevicesClaim.dismissAll()">
                            Dismiss all
                        </button>
                    </div>
                </div>
            </div>
        `;
    },

    toggleSelect(uid) {
        if (this._selected.has(uid)) this._selected.delete(uid);
        else this._selected.add(uid);
        App.renderPage();
    },

    toggleSelectAll() {
        const items = this._visible();
        if (this._selected.size === items.length) this._selected.clear();
        else this._selected = new Set(items.map(a => a.uid));
        App.renderPage();
    },

    /** Decode a banner uid into the (kind, id) shape ConsoleState stores. */
    _uidToDismissedRef(uid) {
        if (typeof uid !== 'string') return null;
        if (uid.startsWith('ha:')) return { kind: 'discovered', id: uid.slice(3) };
        return { kind: 'installs', id: uid };
    },

    /** Hide a row from the banner — persisted via ConsoleState (cross-browser). */
    dismiss(uid) {
        const ref = this._uidToDismissedRef(uid);
        if (ref && typeof ConsoleState !== 'undefined') ConsoleState.dismiss(ref.kind, ref.id);
        this._selected.delete(uid);
        App.renderPage();
    },

    /** Bulk-dismiss everything currently visible. */
    dismissAll() {
        const visible = this._visible();
        if (visible.length === 0) return;
        if (typeof ConsoleState !== 'undefined') {
            const installIds = visible.filter(a => a.kind === 'install').map(a => a.installId);
            const discoveredIds = visible.filter(a => a.kind === 'discovered').map(a => a.haDeviceId);
            if (installIds.length) ConsoleState.dismiss('installs', installIds);
            if (discoveredIds.length) ConsoleState.dismiss('discovered', discoveredIds);
        }
        this._selected.clear();
        if (typeof Toast !== 'undefined') {
            Toast.success(`Dismissed ${visible.length} device${visible.length === 1 ? '' : 's'} — restore from the Dismissed section at the bottom.`);
        }
        App.renderPage();
    },

    /** Un-dismiss a row — moves back into the banner. */
    restore(uid) {
        const ref = this._uidToDismissedRef(uid);
        if (ref && typeof ConsoleState !== 'undefined') ConsoleState.restore(ref.kind, ref.id);
        App.renderPage();
    },

    /** Render a single dismissed-row card for use inside the page-level
     *  Dismissed section. Returns "" if not in the hidden set. */
    renderHiddenCard(a) {
        const escape = DevicesPage._escape.bind(DevicesPage);
        const uid = escape(a.uid);
        const seenText = a.lastSeen
            ? `seen ${DevicesPage._formatTime(a.lastSeen)}`
            : 'reported by Home Assistant';
        return `
            <div class="card" style="margin-bottom: 8px;">
                <div class="card-body" style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
                    <div style="display: flex; align-items: center; gap: 12px; min-width: 0;">
                        <div class="device-card-icon">${DevicesPage._deviceIcon(a.deviceType)}</div>
                        <div style="min-width: 0;">
                            <div style="font-weight: 500;">${escape(a.name)}</div>
                            <div style="color: var(--text-muted); font-size: var(--font-size-sm);">
                                ${escape(a.deviceType)} · ${seenText}
                            </div>
                        </div>
                    </div>
                    <div style="flex-shrink: 0; display: flex; gap: 6px;">
                        <button class="btn btn-secondary btn-sm" onclick="DevicesClaim.restore('${uid}')">Restore</button>
                        ${a.kind === 'install'
                            ? `<button class="btn btn-secondary btn-sm" title="Delete this install row from the database — it won't reappear in the Add banner unless the device re-registers."
                                    onclick="DevicesClaim.deleteInstall('${uid}', ${JSON.stringify(a.name)})">Delete</button>`
                            : ''}
                    </div>
                </div>
            </div>
        `;
    },

    /** Permanently archive an install row (device_installs.is_active = false).
     *  Removes the dismissal entry too so it doesn't linger after the row
     *  is gone. Discovered rows have no DB row to delete — only Restore. */
    async deleteInstall(uid, name) {
        const ref = this._uidToDismissedRef(uid);
        if (!ref || ref.kind !== 'installs') return;
        const label = name || 'this install';
        if (!confirm(`Delete "${label}" from your account?\n\nThe install row will be archived. If the device re-registers (sign-in or fresh install), it'll come back as a new addable.`)) return;
        try {
            await DashieAuth.dbRequest('archive_install', { install_id: ref.id });
            // Drop the local claimable + dismissal entry so the row disappears.
            this._claimable = (this._claimable || []).filter(c => c.id !== ref.id);
            if (typeof ConsoleState !== 'undefined') ConsoleState.restore('installs', ref.id);
            if (typeof Toast !== 'undefined') Toast.success(`Deleted "${label}"`);
        } catch (e) {
            console.error('[DevicesClaim] archive_install failed:', e);
            if (typeof Toast !== 'undefined') Toast.error(Toast.friendly(e, 'delete this install'));
        }
        App.renderPage();
    },

    /**
     * Add the selected rows. Groups by kind and dispatches:
     *   - install rows → bulk claim_devices(install_ids)
     *   - discovered rows → parallel POST /api/ha/adopt/:deviceId per row
     * Aggregates success/failure counts into a single toast.
     */
    async claimSelected() {
        if (this._selected.size === 0 || this._claiming) return;
        this._claiming = true;
        App.renderPage();

        const items = this._addable().filter(a => this._selected.has(a.uid));
        const installs   = items.filter(a => a.kind === 'install');
        const discovered = items.filter(a => a.kind === 'discovered');

        let added = 0;
        const failures = [];

        try {
            // Bulk claim path
            if (installs.length > 0) {
                try {
                    const result = await DashieAuth.dbRequest('claim_devices', {
                        install_ids: installs.map(a => a.installId),
                    });
                    added += (result.claimed || []).length;
                    for (const r of (result.rejected || [])) {
                        const item = installs.find(a => a.installId === r.id);
                        failures.push({ name: item?.name || '(unknown)', reason: r.reason });
                    }
                } catch (e) {
                    console.error('[DevicesClaim] claim_devices failed:', e);
                    for (const a of installs) failures.push({ name: a.name, reason: e.message || 'claim failed' });
                }
            }

            // Per-device adopt path (parallel — typically only 1-3 kiosk devices)
            if (discovered.length > 0) {
                const results = await Promise.all(discovered.map(async a => {
                    try {
                        const url = DashieAuth._addonUrl(`/api/ha/adopt/${encodeURIComponent(a.haDeviceId)}`);
                        const resp = await fetch(url, { method: 'POST' });
                        const body = await resp.json().catch(() => ({}));
                        if (!resp.ok) throw new Error(body?.message || body?.error || `HTTP ${resp.status}`);
                        return { item: a, ok: true };
                    } catch (e) {
                        return { item: a, ok: false, err: e?.message || String(e) };
                    }
                }));
                for (const r of results) {
                    if (r.ok) added++;
                    else failures.push({ name: r.item.name, reason: r.err });
                }
            }

            // Toasts
            if (added > 0) {
                Toast.success(`Added ${added} device${added === 1 ? '' : 's'}`);
            }
            if (failures.length > 0) {
                // Surface the per-device reason (e.g. "already claimed by another
                // Dashie account") — Toast has no .warning; that typo crashed here
                // and swallowed the reason entirely.
                const detail = failures.map(f => `${f.name}: ${f.reason}`).join(' · ');
                Toast.error(`${failures.length} device${failures.length === 1 ? "" : 's'} couldn't be added — ${detail}`, 9000);
                console.warn('[DevicesClaim] add failures:', failures);
            }

            this._selected.clear();
            // Refresh the addable list + the main devices list so newly-linked
            // devices show up in Online/Offline. The add-on /api/ha/adopt route
            // triggers a worker refresh so discovered rows drop on next poll.
            await this.fetch();
            DevicesPage._lastListDevicesAt = 0;
            await DevicesPage._refreshSilent();
        } finally {
            this._claiming = false;
            App.renderPage();
        }
    },
};
