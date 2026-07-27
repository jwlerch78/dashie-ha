/* ============================================================
   Photos Page — Iteration 1.5a (Dashie Cloud only)

   First-pass scope: Supabase-stored photo library only. Source
   picker for Google Drive / Immich / HA media / Unsplash / Local
   lands in 1.5b.

   Layout:
   - Top: storage quota bar + action buttons (Upload, New Album)
   - Album strip: horizontal pills (All Photos | <album1> | <album2> ...)
   - Thumbnail grid: signed-URL thumbs, click for detail
   - Multi-select mode: toggle to enable, then bulk delete

   State lives on PhotosPage; upload/edit modals live in
   photos-upload.js and photos-album-edit.js respectively.
   ============================================================ */

const PhotosPage = {
    // ── State ───────────────────────────────────────────────
    _photos: null,             // [{ id, storage_path, thumbnail_path, filename, file_size, uploaded_at, ... }]
    _albums: null,             // [{ id, name, photo_count, cover_url, ... }]
    _quota: null,              // { bytes_used, quota_bytes, photo_count, quota_found }
    _signedThumbUrls: null,    // Map<storage_path, signed_url>      (small/thumb)
    _signedFullUrls: null,     // Map<storage_path, signed_url>      (full-size; lazy-fetched on detail open)
    _selectedAlbumId: null,    // null = All Photos; or an album id
    _selectedPhotoIds: null,   // Set of photo ids for multi-select delete
    _multiSelectMode: false,
    _albumLoading: false,      // true while list_album_photos is in flight
    _searchQuery: '',          // free-text filter (filename / metadata / location / date)
    _searchDebounceTimer: null,
    _loading: false,
    _error: null,
    _detailPhotoId: null,      // when set, photo-detail modal is open

    THUMB_BATCH_SIZE: 60,      // how many photos to fetch signed urls for at once

    // ── Render entry ────────────────────────────────────────
    render() {
        const modalsHtml =
            ((typeof PhotosUploadModal !== 'undefined' && PhotosUploadModal._state) ? PhotosUploadModal.render() : '') +
            ((typeof PhotosAlbumEditModal !== 'undefined' && PhotosAlbumEditModal._state) ? PhotosAlbumEditModal.render() : '') +
            (this._detailPhotoId ? this._renderDetailModal() : '');

        if (!this._photos && !this._loading && !this._error) {
            this._fetchAll();
            return this._renderLoading() + modalsHtml;
        }
        if (this._loading && !this._photos) return this._renderLoading() + modalsHtml;
        if (this._error && !this._photos) return this._renderError() + modalsHtml;

        // Album row + search bar stay docked at the top of the scrollable
        // content area as the user scrolls through photos. The storage
        // quota bar above is allowed to scroll away (it's status info, not
        // navigation).
        //
        // Negative left/right margin + matching padding bleeds the white
        // background to the edges of #content's padding so photos can't
        // peek through the gutters. Box shadow at the bottom gives a clean
        // visual hand-off from the sticky band to the gallery.
        const stickyHead = `
            <div style="position: sticky; top: 0; z-index: 10;
                        background: var(--bg-primary, #ffffff);
                        margin: 0 calc(-1 * var(--content-padding, 24px));
                        padding: 12px var(--content-padding, 24px);
                        box-shadow: 0 4px 6px -4px rgba(0, 0, 0, 0.08);">
                ${this._renderAlbumStrip()}
                ${this._renderSearchBar()}
            </div>
        `;
        return this._renderHeader() + stickyHead + this._renderGallery() + modalsHtml;
    },

    topBarTitle() { return 'Photos'; },
    topBarSubtitle() {
        if (!this._quota) return '';
        const used = this._formatBytes(this._quota.bytes_used || 0);
        const total = this._formatBytes(this._quota.quota_bytes || 0);
        const pct = this._quota.quota_bytes ? Math.round((this._quota.bytes_used / this._quota.quota_bytes) * 100) : 0;
        const count = this._quota.photo_count || (this._photos?.length || 0);
        return `${count} photo${count === 1 ? '' : 's'} · ${used} of ${total} (${pct}%)`;
    },
    topBarActions() {
        // Select / select-mode actions live on the album-row right side
        // (directly above the thumbnails). + Album sits inline after the
        // album pills. Top bar keeps only the global upload action.
        return `
            <button class="btn btn-primary" onclick="PhotosUploadModal.open()">+ Upload</button>
        `;
    },

    // ── Data fetching ───────────────────────────────────────
    async refresh() { await this._fetchAll(); },

    async _fetchAll() {
        this._loading = true;
        this._error = null;
        try {
            const [photosRes, albumsRes, quotaRes] = await Promise.all([
                DashieAuth.dbRequest('list_photos', {}),
                DashieAuth.dbRequest('list_albums', {}),
                DashieAuth.dbRequest('get_storage_quota', {}).catch(() => null),
            ]);
            this._photos = photosRes.photos || photosRes.data || [];
            this._albums = albumsRes.albums || albumsRes.data || [];
            this._quota = (quotaRes && (quotaRes.data || quotaRes)) || null;
            // Signed URLs fetched lazily as thumbs render — see _resolveThumbs
            this._signedThumbUrls = this._signedThumbUrls || new Map();
            await this._resolveThumbs(this._currentPhotos());
        } catch (e) {
            console.error('[PhotosPage] Fetch failed:', e);
            this._error = e.message;
        } finally {
            this._loading = false;
            App.renderPage();
        }
    },

    /**
     * Batched signed-URL fetch for the photos currently in view. Uses
     * get_signed_urls in chunks of THUMB_BATCH_SIZE to avoid hitting
     * Supabase storage rate limits or building giant URLs.
     */
    async _resolveThumbs(photos) {
        if (!photos || !photos.length) return;
        if (!this._signedThumbUrls) this._signedThumbUrls = new Map();
        // Collect paths we haven't already resolved
        const need = [];
        for (const p of photos) {
            const path = p.thumbnail_path || p.storage_path;
            if (!path) continue;
            if (this._signedThumbUrls.has(path)) continue;
            need.push(path);
        }
        if (!need.length) return;
        // Chunk
        for (let i = 0; i < need.length; i += this.THUMB_BATCH_SIZE) {
            const chunk = need.slice(i, i + this.THUMB_BATCH_SIZE);
            try {
                const res = await DashieAuth.dbRequest('get_signed_urls', {
                    storage_paths: chunk,
                    expiry_seconds: 3600,
                });
                const urls = res.signed_urls || {};
                for (const [path, url] of Object.entries(urls)) {
                    if (url) this._signedThumbUrls.set(path, url);
                }
            } catch (e) {
                console.warn('[PhotosPage] get_signed_urls failed for chunk', e.message);
            }
        }
    },

    /** Refetch everything after a mutation (upload / delete / album change). */
    async _refresh() {
        this._photos = null;
        this._albums = null;
        this._quota = null;
        // Don't clear signedThumbUrls — they're still valid for an hour and re-using
        // them speeds up the re-render. New photos get resolved on the next pass.
        App.renderPage();
    },

    _retry() {
        this._error = null;
        this._photos = null;
        App.renderPage();
    },

    _currentPhotos() {
        if (!this._photos) return [];
        // Source list — All Photos vs. selected album.
        const source = !this._selectedAlbumId
            ? this._photos
            : (this._albumPhotos || []);
        // Apply free-text search filter (filename + location fields).
        const q = (this._searchQuery || '').trim().toLowerCase();
        if (!q) return source;
        return source.filter(p => this._photoMatchesQuery(p, q));
    },

    /**
     * Map of month names (long and short) → month index (0–11). Used by
     * _matchesDateQuery. Mirrors the mobile-app implementation
     * (mobile-dashboard photo-search-handler.js).
     */
    MONTH_NAMES: {
        'january': 0, 'jan': 0,
        'february': 1, 'feb': 1,
        'march': 2, 'mar': 2,
        'april': 3, 'apr': 3,
        'may': 4,
        'june': 5, 'jun': 5,
        'july': 6, 'jul': 6,
        'august': 7, 'aug': 7,
        'september': 8, 'sep': 8, 'sept': 8,
        'october': 9, 'oct': 9,
        'november': 10, 'nov': 10,
        'december': 11, 'dec': 11
    },

    /**
     * True if the photo matches the user's free-text search query. Mirrors
     * the mobile photo-search-handler pattern: case-insensitive substring
     * match across filename, AI-recognition labels (name + category), OCR
     * text, location (city/state/country/address), and parsed date (month
     * names, years, month+year).
     */
    _photoMatchesQuery(p, q) {
        if (!q) return true;
        const needle = q.toLowerCase();
        // 1. Filename
        if (p.filename && p.filename.toLowerCase().includes(needle)) return true;
        // 2. AI recognition labels (label.name + label.category)
        const labels = p.metadata?.labels;
        if (Array.isArray(labels)) {
            for (const label of labels) {
                if (label?.name && label.name.toLowerCase().includes(needle)) return true;
                if (label?.category && label.category.toLowerCase().includes(needle)) return true;
            }
        }
        // 3. OCR text (text.text)
        const texts = p.metadata?.text;
        if (Array.isArray(texts)) {
            for (const t of texts) {
                if (t?.text && t.text.toLowerCase().includes(needle)) return true;
            }
        }
        // 4. Location fields
        const loc = p.location;
        if (loc) {
            for (const f of ['city', 'state', 'country', 'address', 'locality', 'name']) {
                if (loc[f] && String(loc[f]).toLowerCase().includes(needle)) return true;
            }
        }
        // 5. Date (capture date preferred; falls back to uploaded_at since
        //    EXIF created_at is sparse in real-world data).
        if (this._matchesDateQuery(p.created_at || p.uploaded_at, needle)) return true;
        return false;
    },

    /**
     * Check whether a date string matches a free-text query for date.
     * Supports month names ("December" / "Dec"), years ("2024"), and
     * month+year combinations ("December 2024", "12/2024", "2024-12").
     * Browser-local timezone (good enough for v1; mobile uses an explicit
     * timezone helper for devices with bad system clocks).
     */
    _matchesDateQuery(dateString, query) {
        if (!dateString) return false;
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return false;

        const month = date.getMonth();
        const year = date.getFullYear();

        // Year match: bare year ("2024") matches if query is just the year.
        const yearMatch = query.match(/\b(20\d{2})\b/);
        if (yearMatch && parseInt(yearMatch[1], 10) === year && query.trim() === yearMatch[1]) {
            return true;
        }
        // Month-name match (with optional year qualifier).
        for (const [monthName, monthIndex] of Object.entries(this.MONTH_NAMES)) {
            if (query.includes(monthName) && month === monthIndex) {
                if (yearMatch) return parseInt(yearMatch[1], 10) === year;
                return true;
            }
        }
        // Numeric month/year: "12/2024" or "2024-12"
        const numericMonthYear = query.match(/(\d{1,2})[\/\-](\d{4})/);
        if (numericMonthYear) {
            const queryMonth = parseInt(numericMonthYear[1], 10) - 1;
            const queryYear = parseInt(numericMonthYear[2], 10);
            if (month === queryMonth && year === queryYear) return true;
        }
        return false;
    },

    // ── Render: states ──────────────────────────────────────
    _renderLoading() {
        return `
            <div style="display: flex; align-items: center; justify-content: center; padding: 60px;">
                <div style="text-align: center;">
                    <div style="width: 32px; height: 32px; border: 3px solid #e5e7eb; border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 12px;"></div>
                    <div style="color: var(--text-secondary); font-size: var(--font-size-sm);">Loading photos…</div>
                </div>
                <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
            </div>
        `;
    },

    _renderError() {
        return `
            <div class="card">
                <div class="card-body" style="color: var(--status-error);">
                    <strong>Failed to load photos:</strong> ${this._escape(this._error)}
                    <div style="margin-top: 12px;">
                        <button class="btn btn-secondary btn-sm" onclick="PhotosPage._retry()">Retry</button>
                    </div>
                </div>
            </div>
        `;
    },

    // ── Render: header (storage quota bar) ──────────────────
    _renderHeader() {
        const used = this._quota?.bytes_used || 0;
        const total = this._quota?.quota_bytes || 0;
        const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
        const barColor = pct >= 90 ? 'var(--status-error, #c00)'
                        : pct >= 80 ? 'var(--status-warn, #b45309)'
                        : 'var(--accent, #ff9500)';
        return `
            <div class="card" style="margin-bottom: 16px;">
                <div class="card-body">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                        <div style="font-weight: 500;">${BRAND.cloudName} Storage</div>
                        <div style="color: var(--text-muted); font-size: var(--font-size-sm);">
                            ${this._formatBytes(used)} / ${this._formatBytes(total)} (${pct}%)
                        </div>
                    </div>
                    <div style="width: 100%; height: 6px; background: var(--bg-muted, #f3f4f6); border-radius: 3px; overflow: hidden;">
                        <div style="height: 100%; width: ${pct}%; background: ${barColor}; transition: width 0.3s ease;"></div>
                    </div>
                    ${pct >= 80 ? `<div style="margin-top: 8px; color: ${barColor}; font-size: var(--font-size-sm);">${pct >= 90 ? 'Almost full — ' : ''}delete some photos to free up space.</div>` : ''}
                </div>
            </div>
        `;
    },

    // ── Render: album strip ─────────────────────────────────
    _renderAlbumStrip() {
        const albumCount = this._albums?.length || 0;
        const pill = (label, isActive, onclick) => `
            <button onclick="${onclick}"
                    style="flex-shrink: 0; padding: 6px 14px; border-radius: 16px;
                           background: ${isActive ? 'var(--accent, #ff9500)' : 'var(--bg-muted, #f3f4f6)'};
                           color: ${isActive ? 'white' : 'var(--text-primary)'};
                           border: none; cursor: pointer; font-size: 13px; font-weight: 500;">${label}</button>
        `;
        const pills = [];
        pills.push(pill(`All Photos${this._photos ? ` (${this._photos.length})` : ''}`, !this._selectedAlbumId, "PhotosPage._selectAllPhotos()"));
        for (const a of (this._albums || [])) {
            const cnt = a.photo_count != null ? ` (${a.photo_count})` : '';
            pills.push(pill(`${this._escape(a.name)}${cnt}`, this._selectedAlbumId === a.id, `PhotosPage._openAlbum('${this._escape(a.id)}')`));
        }
        // "+ Album" lives at the end of the pills row as a creation
        // affordance. Outlined to distinguish from filter pills.
        pills.push(`
            <button onclick="PhotosAlbumEditModal.openCreate()"
                    title="Create a new album"
                    style="flex-shrink: 0; padding: 6px 12px; border-radius: 16px;
                           background: transparent; color: var(--text-secondary);
                           border: 1px dashed var(--border, #d1d5db); cursor: pointer;
                           font-size: 13px; font-weight: 500;">+ Album</button>
        `);
        if (!albumCount) {
            pills.push(`<span style="flex-shrink: 0; color: var(--text-muted); font-size: 13px; align-self: center;">No albums yet</span>`);
        }

        // Right-side controls. Three modes:
        //   - Select mode: [Add to Album] [Delete N] [Cancel]  (no Edit album)
        //   - Normal mode + album selected: [Edit album] [Select]
        //   - Normal mode + All Photos: [Select]
        let rightControls = '';
        if (this._multiSelectMode) {
            const n = this._selectedPhotoIds?.size || 0;
            rightControls = `
                <button class="btn btn-secondary btn-sm" onclick="PhotosPage._addSelectionToAlbum()" ${n === 0 ? 'disabled' : ''}>
                    Add ${n || ''} to Album
                </button>
                <button class="btn btn-danger btn-sm" onclick="PhotosPage._bulkDelete()" ${n === 0 ? 'disabled' : ''}>
                    Delete ${n || ''}
                </button>
                <button class="btn btn-ghost btn-sm" onclick="PhotosPage._exitMultiSelect()">Cancel</button>
            `;
        } else {
            const editBtn = this._selectedAlbumId
                ? `<button class="btn btn-ghost btn-sm" onclick="PhotosAlbumEditModal.openEdit('${this._escape(this._selectedAlbumId)}')">Edit album</button>`
                : '';
            rightControls = `
                ${editBtn}
                <button class="btn btn-secondary btn-sm" onclick="PhotosPage._enterMultiSelect()">Select</button>
            `;
        }

        // Margin-bottom owned by the sticky container so we don't
        // double-up spacing between album row and search bar.
        return `
            <div style="display: flex; gap: 8px; padding: 0 0 8px; align-items: center;">
                <div style="display: flex; gap: 8px; overflow-x: auto; flex: 1; min-width: 0;">
                    ${pills.join('')}
                </div>
                <div style="display: flex; gap: 6px; flex-shrink: 0;">
                    ${rightControls}
                </div>
            </div>
        `;
    },

    // ── Render: search bar ──────────────────────────────────
    _renderSearchBar() {
        const q = this._escape(this._searchQuery || '');
        const active = !!q;
        const clearBtn = active
            ? `<button onclick="PhotosPage._clearSearch()"
                       aria-label="Clear search"
                       style="position: absolute; right: 8px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer; color: var(--text-muted); font-size: 16px; padding: 4px 8px;">×</button>`
            : '';

        // Result-count badge: mirrors mobile's "X photos found" line. Only
        // shown when there's an active query, so an empty search bar
        // doesn't claim a fake count.
        let countBadge = '';
        if (active) {
            const n = this._currentPhotos().length;
            const label = n === 0
                ? 'No photos found'
                : `${n} photo${n === 1 ? '' : 's'} found`;
            countBadge = `<span style="color: var(--text-muted); font-size: 13px; flex-shrink: 0;">${label}</span>`;
        }

        // No margin-bottom — the sticky container's padding-bottom owns
        // the gap to the gallery so we don't double up.
        return `
            <div style="display: flex; gap: 12px; align-items: center;">
                <div style="position: relative; flex: 1; min-width: 0;">
                    <input id="photos-search-input"
                           type="search"
                           autocomplete="off"
                           spellcheck="false"
                           placeholder="Search filename, location, dates (e.g. December 2024)…"
                           value="${q}"
                           oninput="PhotosPage._onSearchInput(this.value)"
                           style="width: 100%; padding: 10px 36px 10px 14px; border: 1px solid var(--border, #e5e7eb); border-radius: 8px; font: inherit; background: var(--bg-card, #fff); box-sizing: border-box;">
                    ${clearBtn}
                </div>
                ${countBadge}
            </div>
        `;
    },

    SEARCH_DEBOUNCE_MS: 300,

    /**
     * Update the search query with a 300ms debounce — matches the mobile
     * photo-search-handler cadence (handlers/photos/photo-search-handler.js
     * line 1164). Stores the value immediately so it survives the next
     * render, then schedules a single re-render after typing settles.
     * Restores focus + caret position after re-render so typing feels
     * continuous.
     */
    _onSearchInput(value) {
        this._searchQuery = value || '';
        if (this._searchDebounceTimer) clearTimeout(this._searchDebounceTimer);
        this._searchDebounceTimer = setTimeout(() => {
            this._searchDebounceTimer = null;
            const before = document.getElementById('photos-search-input');
            const caret = before?.selectionStart ?? null;
            App.renderPage();
            const after = document.getElementById('photos-search-input');
            if (after) {
                after.focus();
                if (caret !== null) {
                    try { after.setSelectionRange(caret, caret); } catch (_) {}
                }
            }
        }, this.SEARCH_DEBOUNCE_MS);
    },

    _clearSearch() {
        this._searchQuery = '';
        if (this._searchDebounceTimer) {
            clearTimeout(this._searchDebounceTimer);
            this._searchDebounceTimer = null;
        }
        App.renderPage();
    },

    // ── Render: thumbnail grid + date scrubber ──────────────
    _renderGallery() {
        // While list_album_photos is in flight, show a spinner instead of
        // the "empty album" message — otherwise the user briefly sees
        // "This album is empty" before the photos arrive, which reads as
        // a bug.
        if (this._albumLoading && this._selectedAlbumId) {
            return `
                <div style="display: flex; align-items: center; justify-content: center; padding: 60px;">
                    <div style="text-align: center;">
                        <div style="width: 32px; height: 32px; border: 3px solid #e5e7eb; border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 12px;"></div>
                        <div style="color: var(--text-secondary); font-size: var(--font-size-sm);">Loading album…</div>
                    </div>
                    <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
                </div>
            `;
        }

        const photos = this._currentPhotos();
        if (!photos.length) {
            const searching = !!this._searchQuery;
            const msg = searching
                ? `No photos match "${this._escape(this._searchQuery)}".`
                : (this._selectedAlbumId
                    ? 'This album is empty. Add photos from the gallery using the Select tool.'
                    : 'No photos yet. Click + Upload to add some.');
            return `
                <div class="empty-state">
                    <div class="empty-state-icon"><img src="assets/icons/icon-photos.svg" alt="" style="width: 48px; height: 48px;"></div>
                    <div class="empty-state-text">${msg}</div>
                </div>
            `;
        }

        // Group photos into year-month buckets. Photos from list_photos are
        // already uploaded_at DESC; created_at is sparse (only when EXIF
        // included a capture date), so we prefer it but fall back. The
        // groups end up newest-first since the source is sorted.
        const groups = this._groupPhotosByMonth(photos);

        const sections = groups.map(g => {
            const tiles = g.photos.map(p => this._renderTile(p)).join('');
            return `
                <div class="photos-month-section" id="photos-month-${this._escape(g.key)}" style="margin-bottom: 24px;">
                    <h3 style="font-size: 13px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 8px; padding: 4px 0; border-bottom: 1px solid var(--border, #e5e7eb);">
                        ${this._escape(g.label)}
                        <span style="font-weight: 500; text-transform: none; letter-spacing: 0; opacity: 0.7; margin-left: 6px;">· ${g.photos.length}</span>
                    </h3>
                    <div class="photos-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px;">
                        ${tiles}
                    </div>
                </div>
            `;
        }).join('');

        // Scrubber is hidden when there's only one bucket — no value in
        // navigation when there's only one place to jump.
        const scrubber = groups.length > 1 ? this._renderScrubber(groups) : '';

        return `
            <div style="display: flex; gap: 16px; align-items: flex-start;">
                <div style="flex: 1; min-width: 0;">${sections}</div>
                ${scrubber}
            </div>
        `;
    },

    /**
     * Bucket photos into Year-Month groups for the date scrubber and the
     * section-header layout. Groups returned newest-first (year DESC, then
     * month DESC) so the scrubber reads chronologically regardless of
     * upload-order quirks (e.g. a 2004 EXIF-dated photo uploaded yesterday
     * still groups into "Dec 2004", and that group sorts to the bottom).
     *
     * Photos within each group also sort newest-first by the same
     * (created_at || uploaded_at) date.
     */
    _groupPhotosByMonth(photos) {
        const map = new Map();  // key 'YYYY-MM' → { key, label, year, month, photos: [] }
        for (const p of photos) {
            const ds = p.created_at || p.uploaded_at;
            if (!ds) continue;
            const date = new Date(ds);
            if (isNaN(date.getTime())) continue;
            const y = date.getFullYear();
            const m = date.getMonth();
            const key = `${y}-${String(m + 1).padStart(2, '0')}`;
            if (!map.has(key)) {
                map.set(key, {
                    key,
                    label: date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
                    shortLabel: date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }),
                    year: y,
                    month: m,
                    photos: [],
                });
            }
            map.get(key).photos.push(p);
        }
        const groups = [...map.values()];
        // Newest year first, then newest month within that year.
        groups.sort((a, b) => {
            if (a.year !== b.year) return b.year - a.year;
            return b.month - a.month;
        });
        // Photos within a group: newest first by the same date used to bucket.
        const photoTime = p => {
            const t = new Date(p.created_at || p.uploaded_at).getTime();
            return isNaN(t) ? 0 : t;
        };
        for (const g of groups) g.photos.sort((a, b) => photoTime(b) - photoTime(a));
        return groups;
    },

    /**
     * Vertical sticky date-scrubber column rendered to the right of the
     * gallery — modeled on Google Photos' year/month index. Each entry
     * smooth-scrolls the content area to the corresponding month section.
     * Sticky positioning keeps the scrubber on-screen as the user scrolls
     * through the gallery.
     */
    _renderScrubber(groups) {
        // Show a year header only when the year changes between entries
        // (so the scrubber reads "2026 / May / Apr / Mar / 2025 / Dec / Nov...").
        let prevYear = null;
        const items = [];
        for (const g of groups) {
            if (g.year !== prevYear) {
                items.push(`
                    <div style="font-size: 11px; font-weight: 700; color: var(--text-secondary); padding: 8px 6px 4px; border-top: ${prevYear === null ? 'none' : '1px solid var(--border, #e5e7eb)'};">
                        ${g.year}
                    </div>
                `);
                prevYear = g.year;
            }
            // Month label only — year is already shown above.
            const monthOnly = new Date(g.year, g.month, 1).toLocaleDateString(undefined, { month: 'short' });
            items.push(`
                <button onclick="PhotosPage._scrollToMonth('${this._escape(g.key)}')"
                        style="display: block; width: 100%; padding: 4px 6px; background: none; border: none; cursor: pointer; text-align: left; font-size: 12px; color: var(--text-primary); border-radius: 4px;"
                        onmouseover="this.style.background='var(--bg-muted, #f3f4f6)'"
                        onmouseout="this.style.background='none'"
                        title="${this._escape(g.label)}">
                    ${monthOnly}
                </button>
            `);
        }
        return `
            <div class="photos-scrubber"
                 style="position: sticky; top: 4px; flex-shrink: 0; width: 80px; max-height: calc(100vh - 80px); overflow-y: auto;
                        background: var(--bg-card, #fff); border: 1px solid var(--border, #e5e7eb); border-radius: 6px; padding: 4px;">
                ${items.join('')}
            </div>
        `;
    },

    _scrollToMonth(key) {
        const section = document.getElementById(`photos-month-${key}`);
        if (!section) return;
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    _renderTile(p) {
        // Photo shape depends on source:
        //  - list_album_photos: thumbUrl + fullUrl already baked in by the
        //    server (pre-signed), so we use them directly.
        //  - list_photos (library): thumbnail_path / storage_path strings;
        //    we resolve via the _signedThumbUrls Map populated by
        //    get_signed_urls batches.
        let url = p.thumbUrl || null;
        if (!url) {
            const path = p.thumbnail_path || p.storage_path;
            url = path ? this._signedThumbUrls?.get(path) : null;
        }
        const selected = this._multiSelectMode && this._selectedPhotoIds?.has(p.id);
        const overlay = selected
            ? `<div style="position: absolute; inset: 0; background: rgba(255, 149, 0, 0.35); display: flex; align-items: flex-start; justify-content: flex-end; padding: 6px;">
                   <div style="width: 22px; height: 22px; border-radius: 50%; background: var(--accent, #ff9500); color: white; font-size: 13px; display: flex; align-items: center; justify-content: center; font-weight: 700; border: 2px solid white;">✓</div>
               </div>`
            : (this._multiSelectMode
                ? `<div style="position: absolute; inset: 0; display: flex; align-items: flex-start; justify-content: flex-end; padding: 6px;">
                       <div style="width: 22px; height: 22px; border-radius: 50%; background: rgba(255,255,255,0.8); border: 2px solid white;"></div>
                   </div>`
                : '');
        const img = url
            ? `<img src="${this._escape(url)}" loading="lazy" style="width: 100%; height: 100%; object-fit: cover; display: block;">`
            : `<div style="width: 100%; height: 100%; background: var(--bg-muted, #f3f4f6); display: flex; align-items: center; justify-content: center; color: var(--text-muted); font-size: 11px;">…</div>`;
        const onclick = this._multiSelectMode
            ? `PhotosPage._toggleSelect('${this._escape(p.id)}')`
            : `PhotosPage._openDetail('${this._escape(p.id)}')`;
        return `
            <div onclick="${onclick}"
                 style="position: relative; aspect-ratio: 1; border-radius: 6px; overflow: hidden; cursor: pointer; background: var(--bg-muted, #f3f4f6);"
                 title="${this._escape(p.filename || '')}">
                ${img}
                ${overlay}
            </div>
        `;
    },

    // ── Render: photo detail modal ──────────────────────────
    _renderDetailModal() {
        const photo = (this._photos || []).find(p => p.id === this._detailPhotoId)
            || (this._albumPhotos || []).find(p => p.id === this._detailPhotoId);
        if (!photo) return '';
        // Pick the best URL we have. Order of preference:
        //   1. fullUrl baked in by list_album_photos (album view)
        //   2. lazy-fetched full-size signed URL (library view)
        //   3. thumbnail signed URL (fallback while full-size loads, or if
        //      the storage_path signed URL fetch failed)
        const fullUrl = photo.fullUrl
            || (photo.storage_path ? this._signedFullUrls?.get(photo.storage_path) : null)
            || (photo.thumbnail_path ? this._signedThumbUrls?.get(photo.thumbnail_path) : null)
            || (photo.storage_path ? this._signedThumbUrls?.get(photo.storage_path) : null);

        const name = this._escape(photo.filename || 'Photo');
        const size = photo.file_size ? this._formatBytes(photo.file_size) : '';
        // Prefer the EXIF capture date if we have it; otherwise upload date.
        const captureDate = photo.created_at ? new Date(photo.created_at) : null;
        const uploadDate = photo.uploaded_at ? new Date(photo.uploaded_at) : null;
        const dateLine = this._formatDetailDate(captureDate, uploadDate);
        const locationLine = this._formatDetailLocation(photo.location);

        return `
            <div onclick="if(event.target===this)PhotosPage._closeDetail()"
                 style="position: fixed; inset: 0; background: rgba(0,0,0,0.92); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 16px; flex-direction: column;">
                <button onclick="PhotosPage._closeDetail()"
                        style="position: absolute; top: 16px; right: 16px; background: rgba(255,255,255,0.15); color: white; border: none; width: 40px; height: 40px; border-radius: 50%; cursor: pointer; font-size: 20px; z-index: 1;"
                        aria-label="Close">✕</button>
                ${fullUrl
                    ? `<img src="${this._escape(fullUrl)}"
                            style="max-width: 80vw; max-height: 72vh; width: auto; height: auto; object-fit: contain; box-shadow: 0 10px 40px rgba(0,0,0,0.5); border-radius: 4px;">`
                    : `<div style="color: white; padding: 60px;">Loading…</div>`}
                <div style="color: white; margin-top: 14px; text-align: center; max-width: 90vw;">
                    <div style="font-weight: 600; font-size: 15px; word-break: break-all;">${name}</div>
                    ${dateLine ? `<div style="font-size: 13px; opacity: 0.85; margin-top: 4px;">${dateLine}</div>` : ''}
                    ${locationLine ? `<div style="font-size: 13px; opacity: 0.75; margin-top: 2px;">📍 ${locationLine}</div>` : ''}
                    ${size ? `<div style="font-size: 12px; opacity: 0.6; margin-top: 4px;">${size}</div>` : ''}
                    <div style="margin-top: 14px; display: flex; gap: 8px; justify-content: center;">
                        <button class="btn btn-danger btn-sm" onclick="PhotosPage._deleteOne('${this._escape(photo.id)}')">Delete</button>
                    </div>
                </div>
            </div>
        `;
    },

    /**
     * Builds the date line shown under the filename in the detail modal.
     * Format:
     *   - capture date only      → "Taken Jan 15, 2024"
     *   - capture + upload same  → "Taken Jan 15, 2024"
     *   - capture + upload diff  → "Taken Jan 15, 2024 · Uploaded May 12, 2026"
     *   - upload only            → "Uploaded May 12, 2026"
     */
    _formatDetailDate(captureDate, uploadDate) {
        const fmt = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        if (captureDate && uploadDate) {
            const sameDay = captureDate.toDateString() === uploadDate.toDateString();
            return sameDay
                ? `Taken ${fmt(captureDate)}`
                : `Taken ${fmt(captureDate)} · Uploaded ${fmt(uploadDate)}`;
        }
        if (captureDate) return `Taken ${fmt(captureDate)}`;
        if (uploadDate) return `Uploaded ${fmt(uploadDate)}`;
        return '';
    },

    /**
     * Builds the location line. Photo records carry an EXIF-derived location
     * object (city / state / country / locality / name) when available; we
     * just concatenate whichever fields are populated, in increasing-scope
     * order. Returns null when nothing usable is there.
     */
    _formatDetailLocation(loc) {
        if (!loc || typeof loc !== 'object') return null;
        const parts = [];
        // Pick the most specific name we have for "city-ish"
        const cityish = loc.name || loc.locality || loc.city;
        if (cityish) parts.push(this._escape(cityish));
        if (loc.state && !parts.includes(this._escape(loc.state))) parts.push(this._escape(loc.state));
        if (loc.country && !parts.includes(this._escape(loc.country))) parts.push(this._escape(loc.country));
        if (!parts.length && (loc.latitude != null && loc.longitude != null)) {
            // No geocoded fields, but we have raw GPS — surface the coords.
            const lat = Number(loc.latitude).toFixed(3);
            const lng = Number(loc.longitude).toFixed(3);
            return `${lat}, ${lng}`;
        }
        return parts.length ? parts.join(', ') : null;
    },

    // ── Selection / detail ──────────────────────────────────
    _openDetail(photoId) {
        this._detailPhotoId = photoId;
        App.renderPage();
        // Lazy-fetch the full-size signed URL — until now we've only loaded
        // thumbnail URLs (which are cheap to batch for the grid). The full
        // signed URL is only needed when the user actually opens detail.
        // Fire-and-forget; re-render once it lands so the larger image
        // replaces the thumb-sized placeholder.
        this._resolveFullUrl(photoId).catch(e => {
            console.warn('[PhotosPage] full-size URL fetch failed:', e.message);
        });
    },

    async _resolveFullUrl(photoId) {
        const photo = (this._photos || []).find(p => p.id === photoId)
            || (this._albumPhotos || []).find(p => p.id === photoId);
        if (!photo || !photo.storage_path) return;
        // Album-view photos already carry `fullUrl` baked in by
        // list_album_photos — no need to re-fetch.
        if (photo.fullUrl) return;
        if (!this._signedFullUrls) this._signedFullUrls = new Map();
        if (this._signedFullUrls.has(photo.storage_path)) return;
        const res = await DashieAuth.dbRequest('get_signed_urls', {
            storage_paths: [photo.storage_path],
            expiry_seconds: 3600,
        });
        const url = res.signed_urls?.[photo.storage_path];
        if (url) {
            this._signedFullUrls.set(photo.storage_path, url);
            // Re-render only if detail modal is still showing this photo.
            if (this._detailPhotoId === photoId) App.renderPage();
        }
    },

    _closeDetail() {
        this._detailPhotoId = null;
        App.renderPage();
    },

    _enterMultiSelect() {
        this._multiSelectMode = true;
        this._selectedPhotoIds = new Set();
        App.renderPage();
    },

    _exitMultiSelect() {
        this._multiSelectMode = false;
        this._selectedPhotoIds = null;
        App.renderPage();
    },

    _toggleSelect(photoId) {
        if (!this._selectedPhotoIds) this._selectedPhotoIds = new Set();
        if (this._selectedPhotoIds.has(photoId)) this._selectedPhotoIds.delete(photoId);
        else this._selectedPhotoIds.add(photoId);
        App.renderPage();
    },

    // ── Album navigation ────────────────────────────────────

    async _openAlbum(albumId) {
        this._selectedAlbumId = albumId;
        this._albumPhotos = null;
        this._albumLoading = true;
        App.renderPage();
        try {
            const res = await DashieAuth.dbRequest('list_album_photos', { album_id: albumId });
            this._albumPhotos = res.photos || [];
        } catch (e) {
            console.error('[PhotosPage] list_album_photos failed:', e);
            this._albumPhotos = [];
            Toast.error(`Failed to load album: ${e.message}`);
        } finally {
            this._albumLoading = false;
            App.renderPage();
        }
    },

    /** Reset the album loading flag when we navigate back to All Photos. */
    _selectAllPhotos() {
        this._selectedAlbumId = null;
        this._albumPhotos = null;
        this._albumLoading = false;
        App.renderPage();
    },

    // ── Mutations ───────────────────────────────────────────
    async _deleteOne(photoId) {
        const ok = await ConfirmModal.confirm({
            title: 'Delete photo',
            message: 'This permanently removes the photo from your library and any album it belongs to.',
            confirmLabel: 'Delete',
            danger: true,
        });
        if (!ok) return;
        try {
            await DashieAuth.dbRequest('delete_photo', { photo_id: photoId });
            this._detailPhotoId = null;
            await this._refresh();
        } catch (e) {
            Toast.error(`Failed to delete: ${e.message}`);
        }
    },

    /**
     * Hand the current multi-selection over to PhotosAlbumEditModal's
     * pick-album stage. The modal shows the album list (plus an inline
     * "+ Create new album" affordance), and on pick adds the selected
     * photos to that album via add_photos_to_album. Selection survives
     * across the modal lifecycle so the user can keep it after Cancel.
     */
    _addSelectionToAlbum() {
        const ids = [...(this._selectedPhotoIds || [])];
        if (!ids.length) return;
        PhotosAlbumEditModal.openPickAlbumFor(ids);
    },

    async _bulkDelete() {
        const ids = [...(this._selectedPhotoIds || [])];
        if (!ids.length) return;
        const ok = await ConfirmModal.confirm({
            title: `Delete ${ids.length} photo${ids.length === 1 ? '' : 's'}`,
            message: 'This permanently removes the selected photos from your library and any album they belong to.',
            confirmLabel: 'Delete',
            danger: true,
        });
        if (!ok) return;
        try {
            // delete_photo is per-photo; fire in parallel chunks to avoid
            // overwhelming the edge fn while still keeping latency manageable.
            const CHUNK = 8;
            for (let i = 0; i < ids.length; i += CHUNK) {
                const slice = ids.slice(i, i + CHUNK);
                await Promise.all(slice.map(id =>
                    DashieAuth.dbRequest('delete_photo', { photo_id: id }).catch(e => {
                        console.warn('[PhotosPage] delete_photo failed for', id, e.message);
                    })
                ));
            }
            this._exitMultiSelect();
            await this._refresh();
        } catch (e) {
            Toast.error(`Bulk delete failed: ${e.message}`);
        }
    },

    // ── Helpers ─────────────────────────────────────────────
    _formatBytes(n) {
        if (!n || n < 0) return '0 B';
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
        return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
    },

    _escape(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
};
