/* ============================================================
   Photos Upload Modal — Iteration 1.5a

   Drag-and-drop or picker → reads file → base64-encodes →
   calls `upload_photo` op (one call per photo). Edge fn decodes,
   uploads to bucket, creates DB record, updates quota.

   Multi-file: uploads serially with progress display. Stops on
   quota error and shows remaining-file count. Each successful
   upload bumps PhotosPage's stale state for next refresh.
   ============================================================ */

const PhotosUploadModal = {
    _state: null,
    // _state shape when open:
    //   { stage: 'picker', files: [], }
    //   { stage: 'uploading', queue: [File...], done: [{name, ok, err?}, ...], current: {name, progress} | null }
    //   { stage: 'done', done: [...] }

    MAX_FILE_BYTES: 50 * 1024 * 1024,  // 50MB raw input cap; PhotoFileProcessor compresses to ~1MB
    ACCEPT_TYPES: 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif',

    /** Lazily-instantiated PhotoFileProcessor (shared across this upload session). */
    _processor: null,
    _getProcessor() {
        if (!this._processor) {
            if (typeof PhotoFileProcessor === 'undefined') {
                throw new Error('PhotoFileProcessor not loaded — verify js/lib/photo-file-processor.js is in index.html');
            }
            this._processor = new PhotoFileProcessor();
        }
        return this._processor;
    },

    open() {
        this._state = { stage: 'picker', files: [] };
        App.renderPage();
    },

    close() {
        // Disallow close mid-upload; surface a warning if user tries.
        if (this._state?.stage === 'uploading') {
            Toast.info("Upload in progress — please wait.");
            return;
        }
        this._state = null;
        App.renderPage();
        if (typeof PhotosPage !== 'undefined' && PhotosPage._refresh) {
            // Refresh library after upload session ends so new photos appear.
            PhotosPage._refresh();
        }
    },

    // ── File selection ──────────────────────────────────────

    _onFileInputChange(input) {
        const files = Array.from(input.files || []);
        this._addFiles(files);
    },

    _onDrop(event) {
        event.preventDefault();
        event.stopPropagation();
        if (!this._state || this._state.stage !== 'picker') return;
        const files = Array.from(event.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
        this._addFiles(files);
    },

    _onDragOver(event) {
        event.preventDefault();
        event.stopPropagation();
    },

    _addFiles(files) {
        if (!this._state || this._state.stage !== 'picker') return;
        const valid = [];
        const rejected = [];
        for (const f of files) {
            if (f.size > this.MAX_FILE_BYTES) {
                rejected.push(`${f.name} (${this._formatBytes(f.size)} — over 50MB limit)`);
                continue;
            }
            valid.push(f);
        }
        this._state.files = [...this._state.files, ...valid];
        if (rejected.length) {
            Toast.info(`Skipped ${rejected.length}: ${rejected.slice(0, 2).join(', ')}${rejected.length > 2 ? '…' : ''}`);
        }
        App.renderPage();
    },

    _removeFile(idx) {
        if (!this._state || this._state.stage !== 'picker') return;
        this._state.files.splice(idx, 1);
        App.renderPage();
    },

    // ── Upload flow ─────────────────────────────────────────

    async startUpload() {
        if (!this._state || this._state.stage !== 'picker') return;
        if (!this._state.files.length) return;
        this._state = {
            stage: 'uploading',
            queue: [...this._state.files],
            done: [],
            current: null,
            totalFiles: this._state.files.length,
        };
        App.renderPage();
        await this._runQueue();
    },

    async _runQueue() {
        while (this._state && this._state.stage === 'uploading' && this._state.queue.length) {
            const file = this._state.queue.shift();
            this._state.current = { name: file.name, progress: 0 };
            App.renderPage();
            try {
                // Run through the shared PhotoFileProcessor (same logic as
                // mobile/dashboard): HEIC→JPEG conversion, compress+resize
                // to 1920px max, generate a 300×300 thumbnail. Returns
                // { original: File, thumbnail: Blob|null, metadata }.
                const processor = this._getProcessor();
                const processed = await processor.processFile(file);

                const fileBase64 = await this._blobToBase64(processed.original);
                const thumbBase64 = processed.thumbnail
                    ? await this._blobToBase64(processed.thumbnail)
                    : null;

                const folderName = (PhotosPage?._selectedAlbumId ? null : 'all-photos');  // albums add separately
                const result = await DashieAuth.dbRequest('upload_photo', {
                    file_base64: fileBase64,
                    thumbnail_base64: thumbBase64,
                    // Use processor's filename (HEIC inputs come out as .jpg)
                    filename: processed.original.name,
                    folder_name: folderName,
                    mime_type: processed.original.type || 'image/jpeg',
                });
                if (result?.error === 'QUOTA_EXCEEDED') {
                    this._state.done.push({ name: file.name, ok: false, err: 'Storage full' });
                    // Drain the rest as not-attempted
                    for (const remaining of this._state.queue) {
                        this._state.done.push({ name: remaining.name, ok: false, err: 'Skipped (storage full)' });
                    }
                    this._state.queue = [];
                    break;
                }
                this._state.done.push({ name: file.name, ok: true });
                // If the user is in an album view, also add the new photo to that album.
                if (PhotosPage?._selectedAlbumId && result?.photo?.id) {
                    try {
                        await DashieAuth.dbRequest('add_photos_to_album', {
                            album_id: PhotosPage._selectedAlbumId,
                            photo_ids: [result.photo.id],
                        });
                    } catch (e) {
                        console.warn('[PhotosUpload] add_to_album failed:', e.message);
                    }
                }
            } catch (e) {
                console.error('[PhotosUpload] upload failed:', e);
                this._state.done.push({ name: file.name, ok: false, err: e.message });
            }
            this._state.current = null;
            App.renderPage();
        }
        if (this._state) {
            this._state.stage = 'done';
            App.renderPage();
        }
    },

    /**
     * Read a Blob (or File — a subclass of Blob) as base64 and return the
     * body (no `data:` prefix), ready for the upload_photo edge fn which
     * expects raw base64 strings.
     */
    async _blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const s = String(reader.result || '');
                const idx = s.indexOf(',');
                resolve(idx >= 0 ? s.slice(idx + 1) : s);
            };
            reader.onerror = () => reject(reader.error || new Error('Blob read failed'));
            reader.readAsDataURL(blob);
        });
    },

    // ── Render ──────────────────────────────────────────────

    render() {
        if (!this._state) return '';
        let body = '';
        if (this._state.stage === 'picker') body = this._renderPicker();
        else if (this._state.stage === 'uploading') body = this._renderUploading();
        else if (this._state.stage === 'done') body = this._renderDone();
        return `
            <div onclick="if(event.target===this)PhotosUploadModal.close()"
                 style="position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 16px;">
                <div style="background: var(--bg-card, #fff); border-radius: 12px; max-width: 560px; width: 100%; max-height: 90vh; overflow: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3);">
                    ${body}
                </div>
            </div>
        `;
    },

    _renderPicker() {
        const fileCount = this._state.files.length;
        const fileList = fileCount > 0
            ? `<div style="margin-top: 12px; display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto;">
                   ${this._state.files.map((f, idx) => `
                       <div style="display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--bg-muted, #f9fafb); border-radius: 6px; font-size: 13px;">
                           <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${this._escape(f.name)}</span>
                           <span style="color: var(--text-muted); font-size: 12px;">${this._formatBytes(f.size)}</span>
                           <button onclick="PhotosUploadModal._removeFile(${idx})"
                                   style="background: none; border: none; cursor: pointer; color: var(--text-muted); font-size: 16px; line-height: 1; padding: 0 4px;"
                                   aria-label="Remove">×</button>
                       </div>
                   `).join('')}
               </div>`
            : '';

        return `
            <div style="padding: 24px;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
                    <h2 style="margin: 0; font-size: 18px;">Upload photos</h2>
                    <button class="btn btn-ghost btn-sm" onclick="PhotosUploadModal.close()" aria-label="Close">✕</button>
                </div>
                <div ondrop="PhotosUploadModal._onDrop(event)"
                     ondragover="PhotosUploadModal._onDragOver(event)"
                     ondragenter="PhotosUploadModal._onDragOver(event)"
                     onclick="document.getElementById('photos-upload-input').click()"
                     style="border: 2px dashed var(--border, #e5e7eb); border-radius: 8px; padding: 32px; text-align: center; cursor: pointer; transition: border-color 0.2s;">
                    <img src="assets/icons/icon-photos.svg" alt="" style="width: 36px; height: 36px; opacity: 0.5; margin-bottom: 8px;">
                    <div style="font-weight: 500; margin-bottom: 4px;">Drop photos here</div>
                    <div style="color: var(--text-muted); font-size: 13px;">
                        or click to browse · JPEG, PNG, WebP, HEIC · up to 50 MB each (auto-compressed)
                    </div>
                    <input type="file" id="photos-upload-input"
                           multiple accept="${this.ACCEPT_TYPES}"
                           onchange="PhotosUploadModal._onFileInputChange(this)"
                           style="display: none;">
                </div>
                ${fileList}
                <div style="display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end;">
                    <button class="btn btn-ghost" onclick="PhotosUploadModal.close()">Cancel</button>
                    <button class="btn btn-primary" onclick="PhotosUploadModal.startUpload()" ${fileCount === 0 ? 'disabled' : ''}>
                        Upload ${fileCount || ''}
                    </button>
                </div>
            </div>
        `;
    },

    _renderUploading() {
        const total = this._state.totalFiles;
        const done = this._state.done.length;
        const pct = total ? Math.round((done / total) * 100) : 0;
        const currentName = this._state.current?.name || '';
        return `
            <div style="padding: 24px;">
                <h2 style="margin: 0 0 16px; font-size: 18px;">Uploading…</h2>
                <div style="font-size: 13px; color: var(--text-muted); margin-bottom: 8px;">
                    ${done} of ${total} complete
                </div>
                <div style="width: 100%; height: 8px; background: var(--bg-muted, #f3f4f6); border-radius: 4px; overflow: hidden; margin-bottom: 16px;">
                    <div style="height: 100%; width: ${pct}%; background: var(--accent, #ff9500); transition: width 0.3s ease;"></div>
                </div>
                <div style="font-size: 13px; color: var(--text-secondary);">
                    Currently: ${this._escape(currentName) || '…'}
                </div>
                <div style="display: flex; gap: 8px; margin-top: 20px; justify-content: flex-end;">
                    <button class="btn btn-ghost" disabled>Cancel (in progress)</button>
                </div>
            </div>
        `;
    },

    _renderDone() {
        const ok = this._state.done.filter(d => d.ok).length;
        const failed = this._state.done.filter(d => !d.ok);
        return `
            <div style="padding: 24px;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
                    <h2 style="margin: 0; font-size: 18px;">Upload complete</h2>
                    <button class="btn btn-ghost btn-sm" onclick="PhotosUploadModal.close()" aria-label="Close">✕</button>
                </div>
                <div style="margin-bottom: 12px;">
                    <strong>${ok}</strong> uploaded
                    ${failed.length ? ` · <span style="color: var(--status-error, #c00);">${failed.length} failed</span>` : ''}
                </div>
                ${failed.length ? `
                    <div style="display: flex; flex-direction: column; gap: 6px; max-height: 200px; overflow-y: auto; margin-bottom: 16px;">
                        ${failed.map(d => `
                            <div style="padding: 6px 10px; background: var(--status-error-bg, #fee); border-radius: 6px; font-size: 13px;">
                                <strong>${this._escape(d.name)}</strong> — ${this._escape(d.err || 'failed')}
                            </div>
                        `).join('')}
                    </div>
                ` : ''}
                <div style="display: flex; gap: 8px; justify-content: flex-end;">
                    <button class="btn btn-primary" onclick="PhotosUploadModal.close()">Done</button>
                </div>
            </div>
        `;
    },

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
