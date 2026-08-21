/* ============================================================
   Devices Rename + Conflict Resolution
   ------------------------------------------------------------
   Owns:
   - State: renamingId, renameSaving, conflictModal, resolvingId
   - HA name lookup from worker /api/ha/status payload
   - Conflict detection (Supabase device_name vs HA name_by_user || name)
   - Inline rename UX (pencil → input → Enter/Esc)
   - Conflict banner + modal render
   - Cross-system rename: Supabase first, HA best-effort

   Used by DevicesPage. State lives here; render fragments are returned
   as HTML strings and injected by the page. App.renderPage() is the
   re-render trigger.
   ============================================================ */

const DevicesRename = {
    renamingId: null,    // device_id with inline rename input open
    renameSaving: null,  // device_id whose rename is in flight
    conflictModal: false,
    resolvingId: null,   // device_id currently being resolved in the modal

    /** Per-device HA name map from the worker's last poll. */
    _haNames(haStatus) {
        const synced = haStatus?.lastRun?.upsertResult?.synced || [];
        const map = {};
        for (const s of synced) {
            if (s?.device_id && s?.ha_device_name) map[s.device_id] = s.ha_device_name;
        }
        return map;
    },

    /** HA name if it differs from this device's Supabase name; null otherwise. */
    conflictHaName(device, haStatus) {
        const haName = this._haNames(haStatus)[device.device_id];
        if (!haName) return null;
        if (haName === (device.device_name || '')) return null;
        return haName;
    },

    /** All non-archived devices that have a name conflict with HA. */
    conflictDevices(devices, isArchived, haStatus) {
        if (!devices) return [];
        return devices.filter(d => !isArchived(d) && this.conflictHaName(d, haStatus));
    },

    // ---- Banner + modal render ----

    renderBanner(conflicts) {
        if (conflicts.length === 0) return '';
        return `
            <div class="card" style="margin-bottom: 16px; border-left: 3px solid var(--accent);">
                <div class="card-body" style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
                    <div>
                        <strong>${conflicts.length} device${conflicts.length === 1 ? ' has' : 's have'} different names in Home Assistant and ${BRAND.productName}.</strong>
                        <div style="color: var(--text-muted); font-size: var(--font-size-sm); margin-top: 4px;">
                            Pick which name to use for each — both sides will be updated.
                        </div>
                    </div>
                    <button class="btn btn-primary btn-sm" onclick="DevicesRename.openModal()">Review</button>
                </div>
            </div>
        `;
    },

    renderModal(conflicts, getHaName) {
        if (conflicts.length === 0) {
            this.conflictModal = false;
            return '';
        }
        const escape = DevicesPage._escape.bind(DevicesPage);
        const rows = conflicts.map(d => {
            const haName = getHaName(d);
            const sbName = d.device_name || '(no name)';
            const busy = this.resolvingId === d.device_id;
            const idAttr = escape(d.device_id);
            const sbJson = JSON.stringify(sbName).replace(/"/g, '&quot;');
            const haJson = JSON.stringify(haName).replace(/"/g, '&quot;');
            return `
                <div style="padding: 12px 0; border-bottom: 1px solid var(--border);">
                    <div style="font-weight: 500; margin-bottom: 8px;">${escape(DevicesPage._typeLabel(d))}</div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                        <button class="btn btn-secondary btn-sm" ${busy ? 'disabled' : ''}
                            onclick="DevicesRename.resolve('${idAttr}', ${sbJson})">Keep "${escape(sbName)}"</button>
                        <button class="btn btn-secondary btn-sm" ${busy ? 'disabled' : ''}
                            onclick="DevicesRename.resolve('${idAttr}', ${haJson})">Use "${escape(haName)}"</button>
                    </div>
                </div>
            `;
        }).join('');
        return `
            <div onclick="DevicesRename.closeModal(event)" style="position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 24px;">
                <div onclick="event.stopPropagation()" class="card" style="max-width: 560px; width: 100%; max-height: 80vh; overflow-y: auto;">
                    <div class="card-body">
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
                            <strong style="font-size: var(--font-size-lg);">Resolve naming conflicts</strong>
                            <button class="btn btn-secondary btn-sm" onclick="DevicesRename.closeModal()">Close</button>
                        </div>
                        ${rows}
                    </div>
                </div>
            </div>
        `;
    },

    /** Render a name row (with pencil) for use in the card or detail view.
     *  `mode` is 'card' or 'detail' to tweak styling.
     *  `extras` is HTML appended right after the pencil button — used by
     *  the detail page to slot the lock + refresh icons inline with the
     *  edit affordance instead of trailing after the whole row. */
    renderNameRow(device, conflict, mode = 'card', extras = '') {
        const escape = DevicesPage._escape.bind(DevicesPage);
        const idAttr = escape(device.device_id);
        const isRenaming = this.renamingId === device.device_id;
        const isSaving = this.renameSaving === device.device_id;
        const baseFont = mode === 'detail' ? 'var(--font-size-xl)' : 'var(--font-size-base)';
        const baseWeight = mode === 'detail' ? '600' : '500';
        if (isRenaming) {
            const inputStyle = mode === 'detail'
                ? 'font-size: var(--font-size-xl); font-weight: 600; padding: 4px 10px; width: 100%; max-width: 360px;'
                : 'font-size: var(--font-size-base); padding: 4px 8px;';
            return `<input type="text" data-rename-input="${idAttr}" class="form-input"
                value="${escape(device.device_name || '')}" style="${inputStyle}"
                ${mode === 'card' ? 'onclick="event.stopPropagation()"' : ''}
                onblur="DevicesRename.commitInline('${idAttr}')"
                onkeydown="DevicesRename.onKeydown('${idAttr}', event)" />`;
        }
        const stop = mode === 'card' ? 'event.stopPropagation();' : '';
        const conflictChip = (mode === 'card' && conflict)
            ? `<span title="HA: ${escape(conflict)}" style="color: var(--accent); font-size: 11px;">⚠ HA: ${escape(conflict)}</span>`
            : '';
        return `
            <div class="${mode === 'card' ? 'device-card-name' : ''}" style="display: flex; align-items: center; gap: 6px; font-size: ${baseFont}; font-weight: ${baseWeight};">
                <span>${escape(device.device_name || (mode === 'detail' ? 'Device' : 'Unnamed Device'))}</span>
                ${isSaving ? '<span style="color: var(--text-muted); font-size: 11px; font-weight: 400;">saving…</span>' : ''}
                <button title="Rename" onclick="${stop} DevicesRename.startInline('${idAttr}')"
                    style="background: none; border: none; cursor: pointer; padding: 2px 4px; opacity: 0.6;">✏️</button>
                ${extras}
                ${conflictChip}
            </div>
        `;
    },

    // ---- State transitions / handlers ----

    openModal() { this.conflictModal = true; App.renderPage(); },
    closeModal(e) {
        if (e && e.target !== e.currentTarget) return;
        this.conflictModal = false;
        App.renderPage();
    },

    async resolve(deviceId, chosenName) {
        this.resolvingId = deviceId;
        App.renderPage();
        try {
            await this.rename(deviceId, chosenName, { silent: true });
            Toast.success(`Renamed to "${chosenName}"`);
        } catch (e) {
            Toast.error(Toast.friendly(e, 'rename device'));
        } finally {
            this.resolvingId = null;
            App.renderPage();
        }
    },

    startInline(deviceId) {
        this.renamingId = deviceId;
        App.renderPage();
        setTimeout(() => {
            const el = document.querySelector(`[data-rename-input="${deviceId}"]`);
            if (el) { el.focus(); el.select(); }
        }, 0);
    },

    cancel() { this.renamingId = null; App.renderPage(); },

    async commitInline(deviceId) {
        const input = document.querySelector(`[data-rename-input="${deviceId}"]`);
        const newName = input ? input.value : '';
        const device = DevicesPage._findDevice(deviceId);
        if (!newName.trim() || newName.trim() === (device?.device_name || '')) {
            this.renamingId = null;
            App.renderPage();
            return;
        }
        this.renameSaving = deviceId;
        this.renamingId = null;
        App.renderPage();
        try {
            await this.rename(deviceId, newName);
            Toast.success(`Renamed to "${newName.trim()}"`);
        } catch (e) {
            Toast.error(Toast.friendly(e, 'rename device'));
        } finally {
            this.renameSaving = null;
            App.renderPage();
        }
    },

    onKeydown(deviceId, ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); this.commitInline(deviceId); }
        else if (ev.key === 'Escape') { ev.preventDefault(); this.cancel(); }
    },

    /** Write the new name to BOTH Supabase (always) and HA (best-effort).
     *  HA failure is non-fatal — we surface a warning toast but keep the
     *  Supabase change so the user's intent is preserved. */
    async rename(deviceId, newName, { silent = false } = {}) {
        const trimmed = (newName || '').trim();
        if (!trimmed) throw new Error('Name cannot be empty');
        // 1. Supabase (source of truth for Console-driven changes)
        //
        // 🔴 …except where there is no account, and then it is not a source of
        // truth at all — it is an unreachable service this call AWAITS and throws
        // on, so step 2 never runs. Gating /api/ha/rename on ingress made the
        // server half reachable on an account-less box; this is the client half
        // of the same fix, and without it that gate is unreachable through the UI.
        //
        // With no account, Home Assistant's device registry IS the source of
        // truth — there is no second copy to reconcile, which is why skipping is
        // correct here rather than merely convenient.
        const localOnly = typeof DashieAuth !== 'undefined' && DashieAuth.isLocalMode === true;
        if (!localOnly) {
            await DashieAuth.dbRequest('update_device', { device_id: deviceId, device_name: trimmed });
        }
        const device = DevicesPage._findDevice(deviceId);
        if (device) device.device_name = trimmed;
        // 2. HA via add-on (best-effort, addon-mode only)
        if (DashieAuth.isAddonMode) {
            try {
                const resp = await fetch(DashieAuth._addonUrl('/api/ha/rename'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ device_id: deviceId, new_name: trimmed }),
                });
                if (!resp.ok) {
                    const body = await resp.text();
                    throw new Error(`HA rename HTTP ${resp.status}: ${body.slice(0, 200)}`);
                }
                // Optimistically patch the cached synced[] so the conflict banner
                // clears immediately. The worker's next poll (already triggered by
                // /api/ha/rename via triggerRefresh) will confirm.
                const synced = DevicesPage._haStatus?.lastRun?.upsertResult?.synced;
                if (Array.isArray(synced)) {
                    const entry = synced.find(s => s?.device_id === deviceId);
                    if (entry) {
                        entry.ha_device_name = trimmed;
                        entry.supabase_device_name = trimmed;
                    }
                }
                // And queue an actual refresh ~1.5s later so the worker has time
                // to complete its triggered poll before we read its state again.
                setTimeout(() => {
                    DevicesPage._haStatusFetchedAt = 0;
                    DevicesPage._fetchAddonStatus().then(() => App.renderPage());
                }, 1500);
            } catch (e) {
                console.warn('[DevicesRename] HA rename failed (Supabase succeeded):', e.message);
                if (!silent) Toast.error(`Saved in ${BRAND.productName}. HA rename failed: ${e.message}`);
            }
        }
    },
};
