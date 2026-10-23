/* ============================================================
   Sign in with Apple — the web Console (browser mode only)
   ------------------------------------------------------------
   D-448 (John, 2026-10-23: "we need to implement the account sign in on the
   console for apple"). Until this, the web Console signed in with Google only,
   so an Apple-account user could not reach their account settings or deletion.

   THE ROUND TRIP — the dashboard's web Apple sign-in, landing on the Console:
     tap → mint an apple pairing (create_device_code, device_type 'web')
         → save its device_code in sessionStorage
         → apple-web-callback?code=<user code>&return=console → Apple
         → Apple form_posts to apple-web-callback, which verifies the identity
           and authorizes the pairing → 302 to /console/login/?apple_return=…
         → login/index.html polls the saved device_code ONCE → DashieAuth.setJWT.
   No Apple credential ever reaches the browser, and nothing here needs one.

   🔴 A DELIBERATE MIRROR, gated. This is the client half of the dashboard's
   js/data/auth/apple-redirect-leg.js (+ apple-web-callback-url.js), which this
   public repo cannot import: the Console also runs inside the HA add-on, where
   there is no /js/ at all. The four things that must agree — the storage key,
   the `apple_return` outcomes, clear-before-poll, and the callback URL shape —
   are pinned against that file by dashieapp_staging's
   scripts/check-console-apple-signin.mjs (JS_KOTLIN_CONTRACTS, Console Apple row).
   Change one side and that gate goes red; change both or neither.
   ============================================================ */

const ConsoleAppleSignIn = {
    /** sessionStorage, not localStorage: the pairing belongs to THIS tab's round trip only. Same name as the
     *  dashboard's, so the sign-out manifest's existing declaration covers it. */
    DEVICE_CODE_KEY: 'dashie-apple-redirect-device-code',
    RETURN_PARAM: 'apple_return',

    /** Shown after deleting an Apple account we could NOT revoke (appleDeletionGate: a web-console deletion never
     *  can — it has no fresh Apple re-authorization). Mirror of the dashboard's APPLE_MANUAL_REVOKE_NOTE
     *  (js/data/auth/apple-reauth.js), pinned word for word by the same gate. */
    MANUAL_REVOKE_NOTE: 'To finish removing Dashie from your Apple ID, open Settings → [your name] → Sign in with Apple ' +
        '(or appleid.apple.com → Sign in with Apple), choose Dashie, and tap Stop Using Apple ID.',

    /** The note for a delete reply, or '' — only 'skipped' and 'revoke_failed' mean "an Apple account not revoked". */
    notRevokedNote(reply) {
        return reply?.apple === 'skipped' || reply?.apple === 'revoke_failed' ? this.MANUAL_REVOKE_NOTE : '';
    },
    OUTCOMES: ['ok', 'cancelled', 'error'],

    /** apple-web-callback's GET leg for this pairing, asking to come back to the Console. */
    callbackUrl(edgeFunctionUrl, userCode) {
        const base = String(edgeFunctionUrl).replace(/\/jwt-auth$/, '');
        return `${base}/apple-web-callback?code=${encodeURIComponent(userCode)}&return=console`;
    },

    /**
     * Start the redirect. Throws (nothing saved, nothing navigated) if the pairing cannot be minted, so the caller
     * can show the error on the same screen.
     */
    async start({ edgeFunctionUrl, anonKey, navigate, fetchImpl = fetch, storage = globalThis.sessionStorage }) {
        const res = await fetchImpl(edgeFunctionUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
            body: JSON.stringify({
                operation: 'create_device_code',
                data: { device_type: 'web', provider: 'apple', base_url: globalThis.location?.origin || '' },
            }),
        });
        if (!res.ok) throw new Error(`Apple sign-in could not start (${res.status})`);
        const pairing = await res.json();
        if (!pairing?.device_code || !pairing?.user_code) throw new Error('Apple sign-in could not start (no pairing)');
        // Saved BEFORE navigating — once location changes, nothing after it is guaranteed to run.
        storage.setItem(this.DEVICE_CODE_KEY, pairing.device_code);
        navigate(this.callbackUrl(edgeFunctionUrl, pairing.user_code));
    },

    /** Is this page load the callback sending us back? An unrecognised value is still a return → 'error'. */
    readReturn(search) {
        const value = new URLSearchParams(search || '').get(this.RETURN_PARAM);
        if (value === null) return null;
        return this.OUTCOMES.includes(value) ? value : 'error';
    },

    /**
     * Turn the saved device_code into a session, exactly once. 🔴 THE SAVED CODE IS CLEARED FIRST, ON EVERY OUTCOME:
     * the server's poll is one-shot, and a code left behind would make a later load poll a row that no longer
     * exists — or, on a cancel, a pairing the user backed out of.
     * @returns {Promise<{status: 'signed_in'|'cancelled'|'error', reason?: string, user?: object|null}>}
     */
    async complete({ outcome, edgeFunctionUrl, anonKey, setJWT, fetchImpl = fetch, storage = globalThis.sessionStorage }) {
        const deviceCode = storage.getItem(this.DEVICE_CODE_KEY);
        storage.removeItem(this.DEVICE_CODE_KEY);
        if (outcome === 'cancelled') return { status: 'cancelled' };
        if (outcome !== 'ok') return { status: 'error', reason: 'callback_error' };
        if (!deviceCode) {
            console.warn('DROP: APPLE_RETURN ok but no saved device_code in this tab — cannot complete Apple sign-in');
            return { status: 'error', reason: 'no_saved_device_code' };
        }
        let answer = null;
        try {
            const res = await fetchImpl(edgeFunctionUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
                body: JSON.stringify({ operation: 'poll_device_code_status', data: { device_code: deviceCode } }),
            });
            answer = res.ok ? await res.json() : null;
        } catch (_) { answer = null; }
        if (!answer?.success || answer.status !== 'authorized' || !answer.jwtToken) {
            console.warn(`DROP: APPLE_RETURN ok but the pairing is not authorized (status ${answer?.status ?? 'no response'})`);
            return { status: 'error', reason: 'not_authorized' };
        }
        setJWT(answer.jwtToken);
        return { status: 'signed_in', user: answer.user ?? null };
    },
};
