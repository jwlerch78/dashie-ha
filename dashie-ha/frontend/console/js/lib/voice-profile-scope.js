/* ============================================================
   Voice-profile SCOPE — which layer does a Voice & AI key write to?
   ------------------------------------------------------------
   🔴 THE ACCOUNT IS THE DEFAULT PROFILE (John, 2026-09-24): *"the account becomes
   the default profile"*, *"there should no longer be the concept of writing the
   account"* — for voice. Household sharing stays distinct and account-level.

   So `user_settings.voice.*` / `ai.default*` is not a layer the page can choose to
   write instead of a profile. It IS Default's storage. Editing Default therefore
   writes exactly the paths this page has always written, which is why a household
   with one profile behaves byte-for-byte as it did before profiles existed (§7).

   Editing a NAMED profile writes `voiceProfiles.<id>.values.<cat>.<key>`.

   ⚠️ TWO DIFFERENT "ACTIVE PROFILES", and conflating them would be a real bug:
     · which profile a DEVICE follows — `user_devices.settings.voice.profileId`,
       read by the Devices page (CONTRACTS #148).
     · which profile this BROWSER is currently editing — the switcher's selection,
       held here. It is a view state and must never be written to a device.
   ============================================================ */

const VoiceProfileScope = {
    /** Per-browser, so a refresh cannot silently move you to a different layer
     *  mid-edit. Session-scoped rather than durable: coming back tomorrow should
     *  land on Default, not on whatever you were last poking at. */
    _LS: 'dashie-console-editing-profile',

    _keys() { return window.VoiceProfileKeys; },

    /** The id this page is editing. Falls back to Default whenever the stored id no
     *  longer names a live profile — deleting the profile you were editing must not
     *  leave the page writing into a tombstone. */
    editingId(settings) {
        const K = this._keys();
        const DEFAULT = K?.DEFAULT_PROFILE_ID || 'default';
        let id = DEFAULT;
        try { id = sessionStorage.getItem(this._LS) || DEFAULT; } catch (_) { /* private mode */ }
        if (id === DEFAULT) return DEFAULT;
        return (K?.named?.(settings) || {})[id] ? id : DEFAULT;
    },

    setEditingId(id) {
        try { sessionStorage.setItem(this._LS, String(id || '')); } catch (_) { /* private mode */ }
    },

    /** True when the page is editing Default, i.e. the account paths. The common case. */
    onDefault(settings) {
        return this.editingId(settings) === (this._keys()?.DEFAULT_PROFILE_ID || 'default');
    },

    /**
     * The dotted account keys a profile owns — derived from VoiceProfileKeys, never
     * relisted. `lint:profile-keys` gates that holder, so this list cannot drift from
     * the webapp's OVERRIDE_SPECS.
     *
     * @returns {Map<string, {category: string, key: string}>} 'voice.sttProvider' → …
     */
    profileKeys() {
        const K = this._keys();
        if (!K) return new Map();
        if (this._cache) return this._cache;
        this._cache = new Map(K.all().map(([category, key]) => [K.accountPath(category, key), { category, key }]));
        return this._cache;
    },
    _cache: null,

    /**
     * Where does a write to `dottedKey` go?
     *
     * 🔴 A key the profile does NOT own always goes to the account, even while a named
     * profile is being edited. Household sharing is account-wide by §7, and `ai.model`,
     * web search and HA entities are not in the profile shape. A router that swept every
     * key into the profile would split a household's settings across two layers
     * invisibly, and deleting the profile would resurrect whatever the account still held.
     *
     * @returns {{layer: 'account'} | {layer: 'profile', id, path}}
     */
    route(dottedKey, settings) {
        const owned = this.profileKeys().get(dottedKey);
        if (!owned) return { layer: 'account' };
        const id = this.editingId(settings);
        if (id === (this._keys()?.DEFAULT_PROFILE_ID || 'default')) return { layer: 'account' };
        return { layer: 'profile', id, path: `voiceProfiles.${id}.values.${owned.category}.${owned.key}` };
    },

    /**
     * Overlay the edited profile's values onto the account-shaped defaults map the page
     * renders from, so every existing read site keeps working unchanged.
     *
     * ⚠️ Overlays ONLY the keys the profile owns. Everything else must keep showing the
     * account value, because that is where it still lives and where a write still goes —
     * the page would otherwise display a profile-shaped blank for a key it is about to
     * write account-wide.
     *
     * 🔴 ALWAYS RETURNS A NEW OBJECT, including on every early return. Handing the
     * caller's own `defaults` back aliases the page's `_defaults` to its `_accountRaw`,
     * and the page writes optimistic edits into `_defaults` — so editing a NAMED profile
     * silently rewrote DEFAULT's in-memory copy, and switching back to Default showed
     * the profile's values as though they were the household's. Reported by John on
     * 2026-09-25: *"switching back to default did not bring back the default settings"*.
     *
     * The aliasing window was wider than "editing Default": `settings` is null for the
     * whole refetch after any save, which sends BOTH remaining early returns down the
     * by-reference path while the user is still clicking.
     */
    overlay(defaults, settings) {
        const id = this.editingId(settings);
        const K = this._keys();
        if (!K || id === (K.DEFAULT_PROFILE_ID || 'default')) return { ...defaults };
        const profile = (K.named(settings) || {})[id];
        if (!profile) return { ...defaults };
        const out = { ...defaults };
        for (const [dotted, { category, key }] of this.profileKeys()) {
            const v = profile.values?.[category]?.[key];
            if (typeof v === 'string') out[dotted] = v;
        }
        return out;
    },

    /**
     * A COPY of `settings` with `dottedPath` set to `value`, cloning only the objects
     * along the path.
     *
     * 🔴 This exists so a profile save can update the ONE household cache in place
     * instead of `reset()`-ing it. A reset makes `get()` return null until the refetch
     * lands, and during that window the page renders the profile's rows from the
     * ACCOUNT values -- the dropdowns visibly jump to Default and back on every save
     * (John, 2026-09-25: *"it keeps bouncing around with the models showing in the
     * drop downs"*). Toggling presets fires three saves at once, which is why that
     * transition bounced hardest.
     *
     * Returns `settings` untouched when the path is unusable, so a caller can always
     * hand the result straight back to the store.
     */
    withValue(settings, dottedPath, value) {
        const parts = String(dottedPath || '').split('.').filter(Boolean);
        if (!parts.length || !settings || typeof settings !== 'object') return settings;
        const root = { ...settings };
        let node = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const seg = parts[i];
            const child = node[seg];
            // A non-object (or absent) link is replaced rather than merged: the profile
            // blob is created by the same patch that is in flight, so the local copy has
            // to be able to grow the same shape.
            node[seg] = (child && typeof child === 'object' && !Array.isArray(child)) ? { ...child } : {};
            node = node[seg];
        }
        node[parts[parts.length - 1]] = value;
        return root;
    },
};

window.VoiceProfileScope = VoiceProfileScope;
