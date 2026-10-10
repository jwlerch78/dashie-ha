// SPDX-License-Identifier: AGPL-3.0-only
// server/credit-balance.js — THE account credit-balance read on this box.
//
// One read, two consumers:
//   - brain/addon-io.js checkSpendable: the BYOK tool gate (where this was born);
//   - byok-tts.js resolveProvider: a signed-in box with no credits speaks on the
//     household's Gemini key (John 2026-10-10: "Even if the account is signed in
//     Gemini key should be used when entered with no credits … fall back for sure").
//
// 🔴 THREE-VALUED, and each caller decides what UNKNOWN means. The read used to
// collapse "could not read" into `spendable: true` — generous for the tool gate
// (a tool runs rather than being blocked by an unreachable ledger) but the OPPOSITE
// for speech, where `spendable: true` withholds the household's own key and yields
// silence. Same failure, opposite meaning (O, 10-10). So:
//   'spendable' — a balance > 0
//   'empty'     — a balance <= 0
//   'unknown'   — unreachable, non-2xx, or no finite balance in the body
// The tool gate maps unknown → allow (unchanged); speech maps unknown → the Gemini key.

'use strict';

const CACHE_MS = 60_000;   // TTS is per sentence; one ledger read a minute is plenty

/** { state: 'spendable'|'empty'|'unknown', balance: number|null } for `token`. Never throws. */
async function readCredits(token) {
    if (!token) return { state: 'unknown', balance: null };
    try {
        const CLOUD = require('./config').CLOUD;
        const resp = await fetch(`${CLOUD.url}/functions/v1/database-operations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: CLOUD.anonKey, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ operation: 'get_credit_balance', data: {} }),
        });
        const body = await resp.json().catch(() => ({}));
        const balance = Number(body?.data?.balance ?? body?.balance);
        if (!resp.ok || !isFinite(balance)) return { state: 'unknown', balance: null };
        return { state: balance > 0 ? 'spendable' : 'empty', balance };
    } catch { return { state: 'unknown', balance: null }; }
}

let cache = null;   // { at, token, value } — DEFINITE answers only
/** readCredits for the box's OWN account, cached CACHE_MS. 'unknown' is never cached,
 *  so a ledger that comes back is read again on the very next turn. */
async function boxCredits() {
    let token = '';
    try { token = (await require('./auth').getValidJwt()).jwt; } catch { return { state: 'unknown', balance: null }; }
    if (cache && cache.token === token && Date.now() - cache.at < CACHE_MS) return cache.value;
    const value = await readCredits(token);
    cache = value.state === 'unknown' ? null : { at: Date.now(), token, value };
    return value;
}
/** Test seam: forget the cached answer. */
function __resetCacheForTest() { cache = null; }

module.exports = { readCredits, boxCredits, CACHE_MS, __resetCacheForTest };
