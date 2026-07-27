/* ============================================================
   OptionCatalog — central source of truth for dropdown option lists.

   Two kinds of entries:
     1. DYNAMIC catalogs — themeFamily, aiPersonality, aiVoice, aiModel.
        Fetched from the `get-options-catalog` Supabase edge fn (which
        reads the `option_catalog` table). Cached in localStorage with
        a 24h TTL. Bundled fallback values below are used when the
        fetch fails or before init() completes.
     2. STABLE enums — layoutModes, animationLevels, sleepMethods,
        themeModes, time pickers, on/off. Hardcoded below since these
        change ~never and don't justify a DB roundtrip.

   Pattern:
     OptionCatalog.init() is called from app.js after auth resolves.
     It hits the edge fn, populates _live, triggers a re-render. Until
     it completes, getters return the bundled fallback so the page
     renders immediately on load.

   To add a new dynamic entry:
     1. INSERT into option_catalog table (via a migration).
     2. Add a getter below sourcing from _live.<key>.
     3. Add a bundled fallback to _BUNDLED_FALLBACK below so the page
        still renders correctly on first load / fetch failure.

   See supabase/migrations/202605271500_create_option_catalog.sql and
   supabase/functions/get-options-catalog/index.ts.
   ============================================================ */

const OptionCatalog = {
    _CACHE_KEY: 'dashie_option_catalog_v1',
    _CACHE_TTL_MS: 24 * 60 * 60 * 1000, // 24h
    _initPromise: null,

    // Bundled fallback — used until init() completes, or if it fails.
    // Keep these in sync with the option_catalog seed rows in the
    // migration so a fresh load with no cache still looks right.
    _BUNDLED_FALLBACK: {
        themeFamily: [
            ['default',   'Default'],
            ['halloween', 'Halloween'],
            ['christmas', 'Christmas'],
            ['blue',      'Blue'],
        ],
        aiPersonality: [
            ['friendly',     'Friendly'],
            ['calm',         'Calm'],
            ['professional', 'Professional'],
            ['playful',      'Playful'],
        ],
        aiVoice: [
            ['rachel',  'Rachel'],
            ['adam',    'Adam'],
            ['aria',    'Aria'],
            ['thomas',  'Thomas'],
            ['jessica', 'Jessica'],
        ],
        aiModel: [
            ['claude-sonnet-4-5', 'Claude Sonnet 4.5'],
            ['claude-haiku-4-5',  'Claude Haiku 4.5'],
            ['gpt-4o',            'GPT-4o'],
            ['gpt-4o-mini',       'GPT-4o mini'],
        ],
    },

    _live: null,   // populated by init() — same shape as _BUNDLED_FALLBACK

    /**
     * Fetch the live catalog. Called from app.js after auth resolves.
     * Idempotent — safe to call multiple times.
     */
    async init() {
        if (this._initPromise) return this._initPromise;
        this._initPromise = this._doInit();
        return this._initPromise;
    },

    async _doInit() {
        // 1) Seed _live from localStorage if a fresh-enough cached
        //    version exists. Makes the second-and-later page-load instant.
        try {
            const raw = localStorage.getItem(this._CACHE_KEY);
            if (raw) {
                const { ts, catalog } = JSON.parse(raw);
                if (catalog && (Date.now() - ts) < this._CACHE_TTL_MS) {
                    this._live = catalog;
                }
            }
        } catch (e) { /* localStorage parse error — ignore, fall through */ }

        // 2) Fetch fresh in background. Updates _live + cache when it lands.
        //    Re-renders so dropdowns showing fallback values flip to fresh
        //    values once the network response arrives.
        try {
            // Use a direct fetch instead of DashieAuth.edgeFunctionRequest so
            // we don't depend on JWT availability (catalog is public-readable).
            const url = `${DashieAuth.config.url}/functions/v1/get-options-catalog`;
            const resp = await fetch(url, {
                headers: {
                    'apikey': DashieAuth.anonKey,
                    'Authorization': `Bearer ${DashieAuth.anonKey}`,
                },
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            if (data?.catalog) {
                this._live = data.catalog;
                try {
                    localStorage.setItem(this._CACHE_KEY, JSON.stringify({
                        ts: Date.now(),
                        catalog: data.catalog,
                    }));
                } catch (e) { /* localStorage full — ignore */ }
                if (typeof App !== 'undefined' && App.renderPage) App.renderPage();
            }
        } catch (e) {
            console.warn('[OptionCatalog] fetch failed, using bundled fallback:', e?.message || e);
            // _live stays null or whatever localStorage gave us — getters fall back.
        }
    },

    /** Pick a dynamic list from _live, then localStorage cache, then bundled. */
    _dynamic(key) {
        if (this._live?.[key]) return this._live[key];
        return this._BUNDLED_FALLBACK[key] || [];
    },

    // =========================================================
    //  Dynamic catalogs — sourced from option_catalog table
    // =========================================================

    themeFamilies()   { return this._dynamic('themeFamily'); },
    aiPersonalities() { return this._dynamic('aiPersonality'); },
    aiVoices()        { return this._dynamic('aiVoice'); },
    aiModels()        { return this._dynamic('aiModel'); },

    // =========================================================
    //  Stable enums — hardcoded (change ~never)
    // =========================================================

    /** True/false toggles. Universal. */
    onOff() {
        return [['true', 'On'], ['false', 'Off']];
    },

    /**
     * Theme mode. Source: theme-registry.js → each family exposes
     * variants.{light, dark}. There's no 'system' mode.
     */
    themeModes() {
        return [
            ['light', 'Light'],
            ['dark',  'Dark'],
        ];
    },

    /**
     * Layout modes. Source: js/modules/layout/layout-service.js:279
     *   `mode === 'widgets' || mode === 'single_panel' || mode === 'canvas'`
     */
    layoutModes() {
        return [
            ['widgets',      'Widgets'],
            ['single_panel', 'Single Panel'],
            ['canvas',       'Canvas'],
        ];
    },

    /**
     * Animation level. Source: settings-display-page.js:193 (high/low).
     */
    animationLevels() {
        return [
            ['high', 'High'],
            ['low',  'Low'],
        ];
    },

    /**
     * Sleep method. Source: sleep-timer-service.js:75
     *   `if (method === 'inactivity') { ... } else { schedule path }`
     */
    sleepMethods() {
        return [
            ['schedule',   'Schedule (time-based)'],
            ['inactivity', 'Inactivity (idle timeout)'],
        ];
    },

    /** Common sleep / wake time options — dropdown convenience values
     *  over a free HH:MM input. User wanting 3:17 AM edits on the device. */
    sleepTimes() {
        return [
            ['20:00', '8:00 PM'], ['20:30', '8:30 PM'],
            ['21:00', '9:00 PM'], ['21:30', '9:30 PM'],
            ['22:00', '10:00 PM'], ['22:30', '10:30 PM'],
            ['23:00', '11:00 PM'], ['23:30', '11:30 PM'],
            ['00:00', '12:00 AM'],
        ];
    },
    wakeTimes() {
        return [
            ['05:00', '5:00 AM'], ['05:30', '5:30 AM'],
            ['06:00', '6:00 AM'], ['06:30', '6:30 AM'],
            ['07:00', '7:00 AM'], ['07:30', '7:30 AM'],
            ['08:00', '8:00 AM'], ['08:30', '8:30 AM'],
            ['09:00', '9:00 AM'],
        ];
    },

    /** Numeric ranges — sample values for dropdown convenience. */
    resleepDelays() {
        return [['5', '5'], ['10', '10'], ['15', '15'], ['30', '30'], ['60', '60']];
    },
    inactivityTimeouts() {
        return [['30', '30'], ['60', '60'], ['120', '120'], ['300', '300'], ['600', '600']];
    },
};
