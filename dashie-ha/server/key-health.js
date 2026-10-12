// SPDX-License-Identifier: AGPL-3.0-only
// server/key-health.js — tell the household's account that ITS OWN API key is failing (or works again),
// so every tablet in the house can show the "Voice key error" pill.
//
// Why on the account and not in the reply: the device that needs to know is often not the one that
// made the failing call (an HA speaker found it, or another tablet did), and HA's TTS path keeps only
// the audio bytes anyway (dashie_voice addon_bridge.py / tts.py). One row per account × provider; the
// account's database-operations ops report_key_failure / report_key_ok own the episode rules.
//
// Rules this file keeps:
//   - WRITE ON CHANGE, RE-ASSERT AT MOST ONCE A MINUTE. A broken key fails every turn; it is reported
//     once per episode, not per turn. But this box is NOT the only writer: the streaming-STT edge
//     writes the same row (a refused household token), so "what I last reported" goes stale. A memory
//     that skipped forever would leave an edge-raised pill up through every later successful turn here,
//     or swallow a new failure after the edge cleared it. So the same state is re-asserted after
//     REASSERT_MS (both server functions are idempotent; an ok on a non-failing row is a no-op update).
//     After a restart the memory is empty, so the first outcome of either kind is reported.
//   - Only the KEY's faults raise the pill (generated/key-health-vocab.js PILL_STATUSES). An outage or
//     our own malformed request falls back to credits silently.
//   - reportFailure is AWAITED before the tablet's 409, because the tablet force-refreshes its balance
//     read on that 409; writing after would race it. Bounded by WRITE_TIMEOUT_MS, so a slow account
//     server delays a fallback turn by at most that.
//   - Never throws, never blocks a fallback: bookkeeping failures log DROP and the turn goes on.
//   - Signed out → nothing to write (no account, no pill); that household's surface is HA's own.

'use strict';

const { PILL_STATUSES, isKeyFailureStatus } = require('./generated/key-health-vocab');

const WRITE_TIMEOUT_MS = 2500;
const REASSERT_MS = 60_000;
const lastReported = new Map();   // provider → { state: 'failing' | 'ok', at }  (absent = unknown)
const fresh = (provider, state) => {
    const l = lastReported.get(provider);
    return !!l && l.state === state && Date.now() - l.at < REASSERT_MS;
};

async function callOp(operation, data) {
    let jwt = '';
    try { jwt = (await require('./auth').getValidJwt()).jwt || ''; } catch { jwt = ''; }
    if (!jwt) return { ok: false, why: 'signed_out' };
    const CLOUD = require('./config').CLOUD;
    if (!CLOUD.url) return { ok: false, why: 'no_cloud' };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), WRITE_TIMEOUT_MS);
    try {
        const resp = await fetch(`${CLOUD.url}/functions/v1/database-operations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: CLOUD.anonKey, Authorization: `Bearer ${jwt}` },
            body: JSON.stringify({ operation, data }),
            signal: ctl.signal,
        });
        return resp.ok ? { ok: true } : { ok: false, why: `HTTP ${resp.status}` };
    } catch (e) {
        return { ok: false, why: e?.name === 'AbortError' ? `timeout ${WRITE_TIMEOUT_MS}ms` : (e?.message || 'fetch failed') };
    } finally { clearTimeout(timer); }
}

/** The household's `provider` key failed with `status` (vocabulary). Resolves when written or skipped. */
async function reportFailure(provider, status) {
    if (!isKeyFailureStatus(status)) { console.warn(`DROP: key-health bad status ${String(status).slice(0, 30)}`); return false; }
    if (!PILL_STATUSES.has(status)) { console.log(`KEY-HEALTH: ${provider} ${status}: not the key's fault, no pill`); return false; }
    if (fresh(provider, 'failing')) return false;   // reported within the last minute: episode open
    const r = await callOp('report_key_failure', { provider, status });
    if (!r.ok) {
        if (r.why !== 'signed_out') console.warn(`DROP: key-health report_key_failure ${provider} ${status}: ${r.why}`);
        return false;   // state stays unknown, so the next failure tries again
    }
    lastReported.set(provider, { state: 'failing', at: Date.now() });
    console.log(`KEY-HEALTH: ${provider} failing (${status}) reported`);
    return true;
}

/** The household's `provider` key just WORKED. Fire-and-forget; skipped if ok was asserted < a minute ago. */
function reportOk(provider) {
    if (fresh(provider, 'ok')) return;
    lastReported.set(provider, { state: 'ok', at: Date.now() });   // optimistic, so concurrent turns don't all write
    callOp('report_key_ok', { provider }).then((r) => {
        if (r.ok) console.log(`KEY-HEALTH: ${provider} ok reported`);
        else {
            lastReported.delete(provider);   // unknown again, so the next success retries
            if (r.why !== 'signed_out') console.warn(`DROP: key-health report_key_ok ${provider}: ${r.why}`);
        }
    });
}

/** Test seam. */
function __resetForTest() { lastReported.clear(); }
/** Test seam: make the last report for `provider` look `ms` older. */
function __ageForTest(provider, ms) { const l = lastReported.get(provider); if (l) l.at -= ms; }

module.exports = { reportFailure, reportOk, WRITE_TIMEOUT_MS, REASSERT_MS, __resetForTest, __ageForTest };
