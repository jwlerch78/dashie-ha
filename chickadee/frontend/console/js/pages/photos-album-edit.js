/* ============================================================
   Photos Album Edit Modal — Iteration 1.5a

   Three stages:
   - create: name input for a new album
   - edit:   rename + change cover + delete an existing album
   - add-photos: multi-select photos from library to add to album
   ============================================================ */

const PhotosAlbumEditModal = {
    _state: null,
    // _state shape:
    //   { stage: 'create', name: '', saving }
    //   { stage: 'edit', albumId, name, coverPhotoId, saving, deleting }
    //   { stage: 'add-photos', albumId, selectedIds: Set, saving }

    // ── Lifecycle ───────────────────────────────────────────

    openCreate() {
        this._state = { stage: 'create', name: '', saving: false };
        App.renderPage();
        setTimeout(() => document.getElementById('album-create-name')?.focus(), 50);
    },

    openEdit(albumId) {
        const album = (PhotosPage?._albums || []).find(a => a.id === albumId);
        if (!album) return;
        this._state = {
            stage: 'edit',
            albumId,
            name: album.name || '',
            coverPhotoId: album.cover_photo_id || null,
            saving: false,
            deleting: false,
        };
        App.renderPage();
    },

    openAddPhotos(albumId) {
        this._state = {
            stage: 'add-photos',
            albumId,
            selectedIds: new Set(),
            saving: false,
        };
        App.renderPage();
    },

    /**
     * Reverse of openAddPhotos: the photo IDs are already known (came from
     * the gallery's multi-selection) and we just need the user to pick
     * which album to add them to. Used by PhotosPage._addSelectionToAlbum.
     */
    openPickAlbumFor(photoIds) {
        this._state = {
            stage: 'pick-album',
            photoIds: [...photoIds],
            saving: false,
            savingAlbumId: null,
        };
        App.renderPage();
    },

    close() {
        this._state = null;
        App.renderPage();
    },

    // ── Create ──────────────────────────────────────────────

    async submitCreate() {
        if (!this._state || this._state.stage !== 'create') return;
        const name = (document.getElementById('album-create-name')?.value || '').trim();
        if (!name) {
            Toast.error('Please enter an album name.');
            return;
        }
        this._state.saving = true;
        App.renderPage();
        try {
            await DashieAuth.dbRequest('create_album', { name });
            this.close();
            await PhotosPage._refresh();
            Toast.info(`Album "${name}" created.`);
        } catch (e) {
            this._state.saving = false;
            Toast.error(`Failed to create album: ${e.message}`);
            App.renderPage();
        }
    },

    // ── Edit ────────────────────────────────────────────────

    async submitEdit() {
        if (!this._state || this._state.stage !== 'edit') return;
        const name = (document.getElementById('album-edit-name')?.value || '').trim();
        if (!name) {
            Toast.error('Please enter an album name.');
            return;
        }
        this._state.saving = true;
        App.renderPage();
        try {
            await DashieAuth.dbRequest('update_album', {
                album_id: this._state.albumId,
                name,
            });
            this.close();
            await PhotosPage._refresh();
        } catch (e) {
            this._state.saving = false;
            Toast.error(`Failed to update album: ${e.message}`);
            App.renderPage();
        }
    },

    async deleteAlbum() {
        if (!this._state || this._state.stage !== 'edit') return;
        const ok = await ConfirmModal.confirm({
            title: `Delete album "${this._state.name}"?`,
            message: 'The album is removed but the photos in it stay in your library.',
            confirmLabel: 'Delete album',
            danger: true,
        });
        if (!ok) return;
        this._state.deleting = true;
        App.renderPage();
        try {
            await DashieAuth.dbRequest('delete_album', { album_id: this._state.albumId });
            // If user was viewing this album, snap back to All Photos.
            if (PhotosPage._selectedAlbumId === this._state.albumId) {
                PhotosPage._selectedAlbumId = null;
                PhotosPage._albumPhotos = null;
            }
            this.close();
            await PhotosPage._refresh();
        } catch (e) {
            this._state.deleting = false;
            Toast.error(`Failed to delete album: ${e.message}`);
            App.renderPage();
        }
    },

    // ── Add photos to album ─────────────────────────────────

    _toggleSelect(photoId) {
        if (!this._state || this._state.stage !== 'add-photos') return;
        if (this._state.selectedIds.has(photoId)) this._state.selectedIds.delete(photoId);
        else this._state.selectedIds.add(photoId);
        App.renderPage();
    },

    async submitAddPhotos() {
        if (!this._state || this._state.stage !== 'add-photos') return;
        const ids = [...this._state.selectedIds];
        if (!ids.length) {
            this.close();
            return;
        }
        this._state.saving = true;
        App.renderPage();
        try {
            await DashieAuth.dbRequest('add_photos_to_album', {
                album_id: this._state.albumId,
                photo_ids: ids,
            });
            this.close();
            // If user was viewing this album, refresh its contents too.
            if (PhotosPage._selectedAlbumId === this._state.albumId) {
                await PhotosPage._openAlbum(this._state.albumId);
            }
            await PhotosPage._refresh();
            Toast.info(`Added ${ids.length} photo${ids.length === 1 ? '' : 's'} to album.`);
        } catch (e) {
            this._state.saving = false;
            Toast.error(`Failed to add photos: ${e.message}`);
            App.renderPage();
        }
    },

    // ── Pick album for a known set of photos ────────────────

    async pickAlbum(albumId) {
        if (!this._state || this._state.stage !== 'pick-album') return;
        const ids = this._state.photoIds || [];
        if (!ids.length) {
            this.close();
            return;
        }
        this._state.saving = true;
        this._state.savingAlbumId = albumId;
        App.renderPage();
        try {
            await DashieAuth.dbRequest('add_photos_to_album', {
                album_id: albumId,
                photo_ids: ids,
            });
            const album = (PhotosPage?._albums || []).find(a => a.id === albumId);
            const name = album?.name || 'album';
            this.close();
            // Drop the selection — the user has acted on it.
            if (typeof PhotosPage !== 'undefined') {
                PhotosPage._exitMultiSelect();
                await PhotosPage._refresh();
            }
            Toast.info(`Added ${ids.length} photo${ids.length === 1 ? '' : 's'} to "${name}".`);
        } catch (e) {
            this._state.saving = false;
            this._state.savingAlbumId = null;
            Toast.error(`Failed to add photos: ${e.message}`);
            App.renderPage();
        }
    },

    /** Inline "+ Create new album" from the pick-album stage. */
    async createAndAdd() {
        if (!this._state || this._state.stage !== 'pick-album') return;
        const name = (document.getElementById('pick-album-new-name')?.value || '').trim();
        if (!name) {
            Toast.error('Please enter an album name.');
            return;
        }
        const ids = this._state.photoIds || [];
        this._state.saving = true;
        App.renderPage();
        try {
            const created = await DashieAuth.dbRequest('create_album', { name });
            const newAlbum = created?.album || created;
            if (!newAlbum?.id) throw new Error('Album creation did not return an id');
            await DashieAuth.dbRequest('add_photos_to_album', {
                album_id: newAlbum.id,
                photo_ids: ids,
            });
            this.close();
            if (typeof PhotosPage !== 'undefined') {
                PhotosPage._exitMultiSelect();
                await PhotosPage._refresh();
            }
            Toast.info(`Album "${name}" created with ${ids.length} photo${ids.length === 1 ? '' : 's'}.`);
        } catch (e) {
            this._state.saving = false;
            Toast.error(`Failed to create album: ${e.message}`);
            App.renderPage();
        }
    },

    // ── Render ──────────────────────────────────────────────

    render() {
        if (!this._state) return '';
        let body = '';
        if (this._state.stage === 'create') body = this._renderCreate();
        else if (this._state.stage === 'edit') body = this._renderEdit();
        else if (this._state.stage === 'add-photos') body = this._renderAddPhotos();
        else if (this._state.stage === 'pick-album') body = this._renderPickAlbum();
        const wide = this._state.stage === 'add-photos';
        return `
            <div onclick="if(event.target===this)PhotosAlbumEditModal.close()"
                 style="position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 16px;">
                <div style="background: var(--bg-card, #fff); border-radius: 12px; max-width: ${wide ? '720px' : '480px'}; width: 100%; max-height: 90vh; overflow: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3);">
                    ${body}
                </div>
            </div>
        `;
    },

    _renderCreate() {
        const saving = this._state.saving;
        return `
            <div style="padding: 24px;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
                    <h2 style="margin: 0; font-size: 18px;">Create album</h2>
                    <button class="btn btn-ghost btn-sm" onclick="PhotosAlbumEditModal.close()" aria-label="Close">✕</button>
                </div>
                <div class="form-group">
                    <label class="form-label">Album name</label>
                    <input type="text" class="form-input" id="album-create-name"
                           placeholder="e.g. Summer 2026"
                           ${saving ? 'disabled' : ''}
                           onkeydown="if(event.key==='Enter'){event.preventDefault();PhotosAlbumEditModal.submitCreate();}">
                </div>
                <div style="display: flex; gap: 8px; margin-top: 20px; justify-content: flex-end;">
                    <button class="btn btn-ghost" onclick="PhotosAlbumEditModal.close()" ${saving ? 'disabled' : ''}>Cancel</button>
                    <button class="btn btn-primary" onclick="PhotosAlbumEditModal.submitCreate()" ${saving ? 'disabled' : ''}>${saving ? 'Creating…' : 'Create album'}</button>
                </div>
            </div>
        `;
    },

    _renderEdit() {
        const { name, saving, deleting } = this._state;
        return `
            <div style="padding: 24px;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
                    <h2 style="margin: 0; font-size: 18px;">Edit album</h2>
                    <button class="btn btn-ghost btn-sm" onclick="PhotosAlbumEditModal.close()" aria-label="Close">✕</button>
                </div>
                <div class="form-group">
                    <label class="form-label">Album name</label>
                    <input type="text" class="form-input" id="album-edit-name"
                           value="${this._escape(name)}"
                           ${(saving || deleting) ? 'disabled' : ''}
                           onkeydown="if(event.key==='Enter'){event.preventDefault();PhotosAlbumEditModal.submitEdit();}">
                </div>
                <div style="display: flex; gap: 8px; margin-top: 16px;">
                    <button class="btn btn-secondary btn-sm" onclick="PhotosAlbumEditModal.openAddPhotos('${this._escape(this._state.albumId)}')" ${(saving || deleting) ? 'disabled' : ''}>
                        + Add photos to album
                    </button>
                </div>
                <div style="display: flex; gap: 8px; margin-top: 20px; justify-content: space-between; align-items: center;">
                    <button class="btn btn-danger btn-sm" onclick="PhotosAlbumEditModal.deleteAlbum()" ${(saving || deleting) ? 'disabled' : ''}>
                        ${deleting ? 'Deleting…' : 'Delete album'}
                    </button>
                    <div style="display: flex; gap: 8px;">
                        <button class="btn btn-ghost" onclick="PhotosAlbumEditModal.close()" ${saving ? 'disabled' : ''}>Cancel</button>
                        <button class="btn btn-primary" onclick="PhotosAlbumEditModal.submitEdit()" ${(saving || deleting) ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save'}</button>
                    </div>
                </div>
            </div>
        `;
    },

    _renderAddPhotos() {
        const photos = PhotosPage?._photos || [];
        const selected = this._state.selectedIds;
        const tiles = photos.map(p => {
            const path = p.thumbnail_path || p.storage_path;
            const url = path ? PhotosPage._signedThumbUrls?.get(path) : null;
            const sel = selected.has(p.id);
            const overlay = sel
                ? `<div style="position: absolute; inset: 0; background: rgba(255, 149, 0, 0.35); display: flex; align-items: flex-start; justify-content: flex-end; padding: 4px;"><div style="width: 18px; height: 18px; border-radius: 50%; background: var(--accent, #ff9500); color: white; font-size: 11px; display: flex; align-items: center; justify-content: center; font-weight: 700; border: 2px solid white;">✓</div></div>`
                : `<div style="position: absolute; inset: 0; display: flex; align-items: flex-start; justify-content: flex-end; padding: 4px;"><div style="width: 18px; height: 18px; border-radius: 50%; background: rgba(255,255,255,0.8); border: 2px solid white;"></div></div>`;
            return `
                <div onclick="PhotosAlbumEditModal._toggleSelect('${this._escape(p.id)}')"
                     style="position: relative; aspect-ratio: 1; border-radius: 4px; overflow: hidden; cursor: pointer; background: var(--bg-muted, #f3f4f6);">
                    ${url ? `<img src="${this._escape(url)}" loading="lazy" style="width: 100%; height: 100%; object-fit: cover;">` : ''}
                    ${overlay}
                </div>
            `;
        }).join('');

        const n = selected.size;
        return `
            <div style="padding: 24px;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
                    <h2 style="margin: 0; font-size: 18px;">Add photos to album</h2>
                    <button class="btn btn-ghost btn-sm" onclick="PhotosAlbumEditModal.close()" aria-label="Close">✕</button>
                </div>
                ${photos.length === 0
                    ? `<div style="padding: 32px; text-align: center; color: var(--text-muted);">Your library is empty — upload some photos first.</div>`
                    : `<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 6px; max-height: 60vh; overflow-y: auto;">${tiles}</div>`}
                <div style="display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end;">
                    <button class="btn btn-ghost" onclick="PhotosAlbumEditModal.close()" ${this._state.saving ? 'disabled' : ''}>Cancel</button>
                    <button class="btn btn-primary" onclick="PhotosAlbumEditModal.submitAddPhotos()" ${this._state.saving || n === 0 ? 'disabled' : ''}>
                        ${this._state.saving ? 'Adding…' : `Add ${n || ''} to album`}
                    </button>
                </div>
            </div>
        `;
    },

    _renderPickAlbum() {
        const { photoIds, saving, savingAlbumId } = this._state;
        const albums = PhotosPage?._albums || [];
        const count = photoIds?.length || 0;

        const albumRows = albums.length === 0
            ? `<div style="padding: 16px; text-align: center; color: var(--text-muted); font-size: 13px;">
                   No albums yet. Create one below.
               </div>`
            : albums.map(a => {
                const isSavingThis = saving && savingAlbumId === a.id;
                const cnt = a.photo_count != null ? ` · ${a.photo_count} photo${a.photo_count === 1 ? '' : 's'}` : '';
                return `
                    <button onclick="PhotosAlbumEditModal.pickAlbum('${this._escape(a.id)}')"
                            ${saving ? 'disabled' : ''}
                            style="display: flex; align-items: center; gap: 12px; padding: 10px 12px; background: var(--bg-card, #fff); border: 1px solid var(--border, #e5e7eb); border-radius: 8px; cursor: pointer; text-align: left; width: 100%;">
                        <div style="width: 32px; height: 32px; border-radius: 6px; background: var(--bg-muted, #f3f4f6); display: flex; align-items: center; justify-content: center; font-size: 14px;">📁</div>
                        <div style="flex: 1; min-width: 0;">
                            <div style="font-weight: 500;">${this._escape(a.name)}</div>
                            <div style="color: var(--text-muted); font-size: 12px;">${cnt.replace(/^ · /, '')}</div>
                        </div>
                        <span style="color: ${isSavingThis ? 'var(--accent, #ff9500)' : 'var(--text-muted)'};">
                            ${isSavingThis ? 'Adding…' : '›'}
                        </span>
                    </button>
                `;
            }).join('');

        return `
            <div style="padding: 24px;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
                    <h2 style="margin: 0; font-size: 18px;">Add ${count} photo${count === 1 ? '' : 's'} to album</h2>
                    <button class="btn btn-ghost btn-sm" onclick="PhotosAlbumEditModal.close()" aria-label="Close" ${saving ? 'disabled' : ''}>✕</button>
                </div>
                <div style="display: flex; flex-direction: column; gap: 6px; max-height: 320px; overflow-y: auto; margin-bottom: 16px;">
                    ${albumRows}
                </div>
                <div style="border-top: 1px solid var(--border, #e5e7eb); padding-top: 14px;">
                    <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 6px;">Or create a new album with these photos:</div>
                    <div style="display: flex; gap: 8px;">
                        <input id="pick-album-new-name" type="text"
                               class="form-input"
                               placeholder="New album name"
                               ${saving ? 'disabled' : ''}
                               style="flex: 1;"
                               onkeydown="if(event.key==='Enter'){event.preventDefault();PhotosAlbumEditModal.createAndAdd();}">
                        <button class="btn btn-primary btn-sm" onclick="PhotosAlbumEditModal.createAndAdd()" ${saving ? 'disabled' : ''}>
                            Create + Add
                        </button>
                    </div>
                </div>
                <div style="display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end;">
                    <button class="btn btn-ghost" onclick="PhotosAlbumEditModal.close()" ${saving ? 'disabled' : ''}>Cancel</button>
                </div>
            </div>
        `;
    },

    _escape(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
};
