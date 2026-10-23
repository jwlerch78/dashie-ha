/* ============================================================
   Open Intent — a deep link that survives the Google sign-in
   ------------------------------------------------------------
   `/console/?open=delete-account` is the account-deletion link the app stores
   point reviewers and users at (D11, 2026-10-23).

   Why not `/console/#account`: MEASURED 2026-10-23 (headless Chrome, signed
   out, staging and prod) — the fragment is DROPPED across sign-in. Nothing
   stashes it, Google's redirect_uri is a fixed /console/login, and
   login/index.html returns to '../'. A query param read BEFORE auth and kept in
   sessionStorage survives the round trip, the same way `?next=` does.

   What an intent may do: pick the page to land on and ask that page to REVEAL
   something. It never presses a button, opens a confirm, or pre-selects a
   choice. Only the names in ALLOWED are honoured; anything else is ignored
   (and says so in the console log).
   ============================================================ */

const OpenIntent = {
    KEY: 'dashie-post-login-open',

    /** intent name → the page it lands on */
    ALLOWED: { 'delete-account': 'account' },

    /** Read `?open=` from a search string and stash it. Returns the intent or null. */
    capture(search, storage) {
        let v = null;
        try { v = new URLSearchParams(search || '').get('open'); } catch (_) { return null; }
        if (!v) return null;
        if (!Object.prototype.hasOwnProperty.call(this.ALLOWED, v)) {
            console.warn(`DROP: OPEN_INTENT unknown ?open=${String(v).slice(0, 40)} ignored`);
            return null;
        }
        try { storage.setItem(this.KEY, v); } catch (_) { /* private mode: the link still works when signed in */ }
        return v;
    },

    /** Take the stashed intent, once. Returns { intent, page } or null. */
    consume(storage) {
        let v = null;
        try {
            v = storage.getItem(this.KEY);
            if (v) storage.removeItem(this.KEY);
        } catch (_) { return null; }
        if (!v || !Object.prototype.hasOwnProperty.call(this.ALLOWED, v)) return null;
        return { intent: v, page: this.ALLOWED[v] };
    },

    /** The same search string without `open`, for history.replaceState — a refresh must not replay it. */
    stripFrom(search) {
        const p = new URLSearchParams(search || '');
        p.delete('open');
        const s = p.toString();
        return s ? `?${s}` : '';
    },
};
