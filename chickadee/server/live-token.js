// server/live-token.js
// Mint a short-lived, Live-only Gemini ephemeral token from a raw AI-Studio key, for a
// BYOK Live session (Option B: the box mints; the RAW KEY NEVER LEAVES THE BOX — only the
// token is handed to the device/relay). See
// .reference/build-plans/20260723_BYOK_LIVE_EPHEMERAL_TOKENS.md.
//
// Phase-0-verified shapes (2026-07-23):
//   mint : POST https://generativelanguage.googleapis.com/v1alpha/auth_tokens?key=KEY
//          body { uses, expireTime, newSessionExpireTime, bidiGenerateContentSetup? }
//          → { name: "auth_tokens/…" }   (the `name` IS the token the client uses)
//   use  : wss://…/v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=<name>
//
// The token is single-purpose (Live only) and expires quickly, so a leaked token is a
// bounded ~one-session, ~minutes exposure — NOT the raw key.

const MINT_URL = 'https://generativelanguage.googleapis.com/v1alpha/auth_tokens';

const DEFAULTS = {
    uses: 2,                       // initial connect + one relay-reconnect within the window
    startWindowMs: 2 * 60_000,     // newSessionExpireTime — window to START a session
    messageWindowMs: 15 * 60_000,  // expireTime — window to send messages (our sessions ≤ ~5 min)
};

/**
 * Mint a Live-only ephemeral token from a raw Gemini key.
 * @param {string} geminiKey  raw AI-Studio key — NEVER returned or logged by this module
 * @param {{model?: string, uses?: number, startWindowMs?: number, messageWindowMs?: number}} [opts]
 * @returns {Promise<{token: string, expireTime: string, newSessionExpireTime: string}>}
 * @throws {Error} 'no_gemini_key', or an Error with .status/.detail on a non-2xx mint
 *   (message/detail never contain the key)
 */
async function mintEphemeralToken(geminiKey, opts = {}) {
    const key = typeof geminiKey === 'string' ? geminiKey.trim() : '';
    if (!key) throw new Error('no_gemini_key');

    const { uses, startWindowMs, messageWindowMs } = { ...DEFAULTS, ...opts };
    const now = Date.now();
    const newSessionExpireTime = new Date(now + startWindowMs).toISOString();
    const expireTime = new Date(now + messageWindowMs).toISOString();

    const body = { uses, newSessionExpireTime, expireTime };
    if (opts.model) {
        // ⚠️ TODO: locking the model via bidiGenerateContentSetup makes the WS connect
        // return 1011 "Internal error" at setup time (the constrained-setup handshake needs
        // more work). Callers currently mint UNCONSTRAINED. Kept here for when we work out
        // the constrained-setup protocol; do NOT enable without re-verifying a session opens.
        const m = opts.model.startsWith('models/') ? opts.model : `models/${opts.model}`;
        body.bidiGenerateContentSetup = { model: m };
    }

    const r = await fetch(`${MINT_URL}?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!r.ok) {
        // Google's error text is safe to surface (no key in it); still cap its length.
        const detail = await r.text().catch(() => '');
        const e = new Error(`mint_failed_${r.status}`);
        e.status = r.status;
        e.detail = detail.slice(0, 200);
        throw e;
    }
    const j = await r.json().catch(() => ({}));
    if (!j.name) { const e = new Error('mint_no_name'); e.status = 502; throw e; }
    return { token: j.name, expireTime, newSessionExpireTime };
}

module.exports = { mintEphemeralToken };
