/* ============================================================
   Video Feed Editor — add/edit modal for household feed
   definitions. Field-for-field parity with the tablet's native
   editor (VideoFeedEditorFragment.kt), writing the registry's
   canonical shape via FeedsApi.save():

     label, stream_source_type (entity|rtsp|go2rtc),
     camera_entity_id, stream_source_url, triggers[{entity_id,
     state}], alert_sound ('' = silent), fps, quality, resolution,
     auto_dismiss_seconds, continue_while_active, default_mode,
     frigate_camera_override ('' auto | '__none__' | <camera>)

   Rendered from VideoFeedsPage.render(); state lives here.
   Entity catalogs come from the add-on's /api/feeds/meta/*
   routes and are fetched once per open.
   ============================================================ */

const VideoFeedsEdit = {
    /** null when closed; otherwise { feedId, draft, busy, error } */
    _open: null,
    _entities: null,        // {cameras: [{entity_id,name,state}], triggers: [...]}
    _frigateCameras: null,  // [names] — [] when Frigate unreachable

    SOUNDS: [
        ['notify_bell_tap', 'Bell Tap'],
        ['notify_chord_wash', 'Chord Wash'],
        ['notify_pulse_alert', 'Pulse Alert'],
        ['notify_soft_double', 'Soft Double'],
        ['notify_tri_fall', 'Tri Fall'],
        ['notify_tri_rise', 'Tri Rise'],
        ['extra_bubble', 'Bubble'],
        ['extra_celesta', 'Celesta'],
        ['extra_deep_bell', 'Deep Bell'],
        ['extra_duo_chirp', 'Duo Chirp'],
        ['extra_wood_knock', 'Wood Knock'],
        ['extra_xylophone_pair', 'Xylophone Pair'],
    ],
    FPS_OPTIONS: [[0, 'Native'], [5, '5 fps'], [10, '10 fps'], [15, '15 fps'], [20, '20 fps']],
    RESOLUTION_OPTIONS: [[0, 'Native'], [320, '320p'], [480, '480p'], [640, '640p'], [720, '720p']],
    DISMISS_OPTIONS: [[0, 'Never'], [5, '5s'], [10, '10s'], [15, '15s'], [20, '20s'], [30, '30s'], [45, '45s'], [60, '1 min'], [120, '2 min'], [300, '5 min']],
    MODE_OPTIONS: [
        ['subscribed', 'On-demand — available when a device asks for it'],
        ['trigger', 'Trigger — auto-show on trigger, silent'],
        ['trigger_alert', 'Trigger + Alert — auto-show and play the alert sound'],
        ['ignored', 'Ignored — hidden unless a device opts in'],
    ],

    open(feedId) {
        const feed = feedId ? VideoFeedsPage.getFeed(feedId) : null;
        const trigger = (feed?.triggers || [])[0] || null;
        this._open = {
            feedId: feedId || null,
            busy: false,
            error: null,
            draft: {
                label: feed?.label || '',
                stream_source_type: feed?.stream_source_type || 'entity',
                camera_entity_id: feed?.camera_entity_id || '',
                stream_source_url: feed?.stream_source_url || '',
                trigger_entity_id: trigger?.entity_id || '',
                trigger_state: trigger?.state || 'on',
                alert_sound: feed?.alert_sound || '',
                fps: feed?.fps ?? 10,
                quality: feed?.quality ?? 8,
                resolution: feed?.resolution ?? 480,
                auto_dismiss_seconds: feed?.auto_dismiss_seconds ?? 30,
                continue_while_active: feed?.continue_while_active !== false,
                default_mode: feed?.default_mode || 'subscribed',
                frigate_camera_override: feed?.frigate_camera_override || '',
            },
        };
        this._fetchCatalogs();
        App.renderPage();
    },

    close() {
        this._open = null;
        App.renderPage();
    },

    _maybeCloseBackdrop(e) {
        if (e.target === e.currentTarget) this.close();
    },

    async _fetchCatalogs() {
        // Entity/Frigate catalogs change rarely — fetch once per console session,
        // refresh in the background on subsequent opens.
        try {
            const [entities, frigate] = await Promise.all([
                FeedsApi.entities(),
                FeedsApi.frigateCameras().catch(() => ({ cameras: [] })),
            ]);
            this._entities = entities;
            this._frigateCameras = frigate.cameras || [];
            if (this._open) App.renderPage();
        } catch (e) {
            console.warn('[VideoFeedsEdit] catalog fetch failed:', e.message);
            if (this._entities === null) this._entities = { cameras: [], triggers: [] };
            if (this._frigateCameras === null) this._frigateCameras = [];
            if (this._open) App.renderPage();
        }
    },

    /** Update a draft field without re-rendering (text inputs keep focus). */
    set(field, value) {
        if (!this._open) return;
        this._open.draft[field] = value;
    },

    /** Update a draft field and re-render (selects that change the form shape). */
    setAndRender(field, value) {
        this.set(field, value);
        App.renderPage();
    },

    async save() {
        const m = this._open;
        if (!m || m.busy) return;
        const d = m.draft;

        // Same validation as the tablet editor: a stream source is required.
        if (d.stream_source_type === 'entity' && !d.camera_entity_id.trim()) {
            m.error = 'Select a camera entity.';
            return App.renderPage();
        }
        if (d.stream_source_type !== 'entity' && !d.stream_source_url.trim()) {
            m.error = 'Enter a stream URL.';
            return App.renderPage();
        }

        // Auto-derive a label from the camera's friendly name (Kotlin parity).
        let label = d.label.trim();
        if (!label) {
            const cam = (this._entities?.cameras || []).find(c => c.entity_id === d.camera_entity_id);
            label = cam?.name || d.camera_entity_id || d.stream_source_url || 'Feed';
        }

        const payload = {
            label,
            stream_source_type: d.stream_source_type,
            camera_entity_id: d.stream_source_type === 'entity' ? d.camera_entity_id.trim() : '',
            stream_source_url: d.stream_source_type === 'entity' ? '' : d.stream_source_url.trim(),
            triggers: d.trigger_entity_id.trim()
                ? [{ entity_id: d.trigger_entity_id.trim(), state: d.trigger_state || 'on' }]
                : [],
            alert_sound: d.alert_sound,
            fps: Number(d.fps) || 0,
            quality: Number(d.quality) || 8,
            resolution: Number(d.resolution) || 0,
            auto_dismiss_seconds: Number(d.auto_dismiss_seconds) || 0,
            continue_while_active: !!d.continue_while_active,
            default_mode: d.default_mode,
            frigate_camera_override: d.frigate_camera_override,
        };
        if (m.feedId) payload.id = m.feedId;

        m.busy = true;
        m.error = null;
        App.renderPage();
        try {
            await FeedsApi.save(payload);
            Toast.info(m.feedId ? `Saved "${label}"` : `Added "${label}"`);
            this._open = null;
            await VideoFeedsPage._fetch();
        } catch (e) {
            console.error('[VideoFeedsEdit] save failed:', e);
            m.busy = false;
            m.error = `Save failed: ${e.message}`;
            App.renderPage();
        }
    },

    // ── Render ───────────────────────────────────────────────

    render() {
        const m = this._open;
        if (!m) return '';
        const d = m.draft;
        const esc = VideoFeedsPage._escape.bind(VideoFeedsPage);
        const title = m.feedId ? 'Edit Feed' : 'Add Feed';
        const loadingCatalogs = this._entities === null;

        return `
            <div onclick="VideoFeedsEdit._maybeCloseBackdrop(event)"
                 style="position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 1050; display: flex; align-items: center; justify-content: center; padding: 16px;">
                <div onclick="event.stopPropagation()"
                     style="background: var(--bg-card, #fff); border-radius: 12px; max-width: 560px; width: 100%; max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3); padding: 20px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
                        <h2 style="margin: 0; font-size: 17px;">${title}</h2>
                        <button class="btn btn-ghost btn-sm" onclick="VideoFeedsEdit.close()" aria-label="Close">✕</button>
                    </div>

                    ${m.error ? `<div style="background: rgba(220,38,38,0.08); color: #dc2626; border-radius: 6px; padding: 8px 12px; font-size: 13px; margin-bottom: 12px;">${esc(m.error)}</div>` : ''}
                    ${loadingCatalogs ? `<div style="color: var(--text-muted); font-size: 13px; margin-bottom: 12px;">Loading entities from Home Assistant…</div>` : ''}

                    ${this._sectionLabel('Stream')}
                    ${this._selectRow('Source type', 'stream_source_type', [
                        ['entity', 'Home Assistant camera'],
                        ['rtsp', 'Direct RTSP URL'],
                        ['go2rtc', 'go2rtc stream'],
                    ], d.stream_source_type, true)}
                    ${d.stream_source_type === 'entity'
                        ? this._entityRow('Camera entity', 'camera_entity_id', d.camera_entity_id, this._entities?.cameras || [], 'camera.front_door')
                        : this._inputRow(d.stream_source_type === 'go2rtc' ? 'go2rtc stream name / URL' : 'RTSP URL', 'stream_source_url', d.stream_source_url, 'rtsp://user:pass@192.168.1.50:554/stream')}
                    ${this._inputRow('Feed name', 'label', d.label, 'Auto-filled from camera name')}
                    <div style="display: flex; gap: 12px;">
                        <div style="flex: 1;">${this._selectRow('Resolution', 'resolution', this.RESOLUTION_OPTIONS, d.resolution)}</div>
                        <div style="flex: 1;">${this._selectRow('Frame rate', 'fps', this.FPS_OPTIONS, d.fps)}</div>
                        <div style="flex: 1;">${this._selectRow('Quality (1–10)', 'quality', Array.from({ length: 10 }, (_, i) => [i + 1, String(i + 1)]), d.quality)}</div>
                    </div>
                    ${this._renderFrigateRow(d)}

                    ${this._sectionLabel('Trigger')}
                    ${this._entityRow('Trigger entity (optional)', 'trigger_entity_id', d.trigger_entity_id, this._entities?.triggers || [], 'binary_sensor.front_door_motion')}
                    ${d.trigger_entity_id ? this._inputRow('Trigger state', 'trigger_state', d.trigger_state, 'on') : ''}
                    ${this._selectRow('Alert sound', 'alert_sound', [['', 'None (silent)'], ...this.SOUNDS], d.alert_sound)}

                    ${this._sectionLabel('Behavior')}
                    ${this._selectRow('Default mode for devices', 'default_mode', this.MODE_OPTIONS, d.default_mode)}
                    ${this._selectRow('Auto-dismiss after', 'auto_dismiss_seconds', this.DISMISS_OPTIONS, d.auto_dismiss_seconds)}
                    <div class="setting-row" style="padding: 8px 0;">
                        <span class="setting-row-label">Keep showing while trigger is active</span>
                        <label class="toggle">
                            <input type="checkbox" ${d.continue_while_active ? 'checked' : ''}
                                onchange="VideoFeedsEdit.set('continue_while_active', this.checked)">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>

                    <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px;">
                        <button class="btn btn-ghost" onclick="VideoFeedsEdit.close()" ${m.busy ? 'disabled' : ''}>Cancel</button>
                        <button class="btn btn-primary" onclick="VideoFeedsEdit.save()" ${m.busy ? 'disabled' : ''}>
                            ${m.busy ? 'Saving…' : (m.feedId ? 'Save Feed' : 'Add Feed')}
                        </button>
                    </div>
                </div>
            </div>
        `;
    },

    _sectionLabel(text) {
        return `<div style="font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin: 16px 0 8px;">${text}</div>`;
    },

    _inputRow(label, field, value, placeholder) {
        const esc = VideoFeedsPage._escape.bind(VideoFeedsPage);
        return `
            <div class="form-group">
                <label class="form-label">${esc(label)}</label>
                <input class="form-input" type="text" value="${esc(value)}" placeholder="${esc(placeholder || '')}"
                    onchange="VideoFeedsEdit.set('${field}', this.value)">
            </div>
        `;
    },

    /** options: [[value, label], ...]. rerender=true for fields that change the form shape. */
    _selectRow(label, field, options, current, rerender = false) {
        const esc = VideoFeedsPage._escape.bind(VideoFeedsPage);
        const handler = rerender ? 'setAndRender' : 'set';
        const optionsHtml = options.map(([v, l]) =>
            `<option value="${esc(v)}" ${String(v) === String(current) ? 'selected' : ''}>${esc(l)}</option>`
        ).join('');
        return `
            <div class="form-group">
                <label class="form-label">${esc(label)}</label>
                <select class="form-select" onchange="VideoFeedsEdit.${handler}('${field}', this.value)">${optionsHtml}</select>
            </div>
        `;
    },

    /** Type-to-filter entity picker: text input backed by a <datalist> of
     *  entity_ids with friendly-name labels. */
    _entityRow(label, field, value, entities, placeholder) {
        const esc = VideoFeedsPage._escape.bind(VideoFeedsPage);
        const listId = `vf-datalist-${field}`;
        const trigger = field === 'trigger_entity_id';
        const optionsHtml = entities.map(e =>
            `<option value="${esc(e.entity_id)}">${esc(e.name)}</option>`
        ).join('');
        return `
            <div class="form-group">
                <label class="form-label">${esc(label)}</label>
                <input class="form-input" type="text" list="${listId}" value="${esc(value)}"
                    placeholder="${esc(placeholder || '')}"
                    onchange="VideoFeedsEdit.${trigger ? 'setAndRender' : 'set'}('${field}', this.value)">
                <datalist id="${listId}">${optionsHtml}</datalist>
            </div>
        `;
    },

    _renderFrigateRow(d) {
        const cams = this._frigateCameras || [];
        // Hide unless Frigate is reachable or this feed already has an override.
        if (!cams.length && !d.frigate_camera_override) return '';
        const options = [
            ['', 'Auto-detect'],
            ['__none__', 'Not a Frigate camera'],
            ...cams.map(c => [c, c]),
        ];
        // Preserve an override pointing at a camera Frigate no longer lists.
        if (d.frigate_camera_override && d.frigate_camera_override !== '__none__'
            && !cams.includes(d.frigate_camera_override)) {
            options.push([d.frigate_camera_override, `${d.frigate_camera_override} (not in Frigate)`]);
        }
        return this._selectRow('Frigate camera', 'frigate_camera_override', options, d.frigate_camera_override);
    },
};
