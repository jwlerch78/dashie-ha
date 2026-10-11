// SPDX-License-Identifier: AGPL-3.0-only
// server/voice-routes.js — WHICH ENGINE serves each voice lane on this box, decided ONCE.
//
// Two readers, one answer (HV + B, 2026-10-11): engines.handleTts / handleStt ROUTE
// on these functions, and GET /api/voice/lanes REPORTS them, so the console's picker
// can never re-spell the lane's precedence. check-voice-lanes.mjs drives both on the
// same box states and fails if they name different engines.
//
// ── Two questions, and this file answers only ONE of them ────────────────────
//   can_serve  = "would a spend on this row succeed NOW, on facts this server holds"
//   offering   = "may the household be OFFERED this row at all" — the console's
//                cohort gate (feature-gate.js: credits are alpha-only). NOT here.
// Wiring offer-iff-can_serve is the hasManagedCloud() defect inverted. Don't.
//
// ── Rows: keyed by the STORED wire value (voice.sttProvider / voice.ttsProvider) ─
// Three states, never collapsed (the same discipline as the usage lane):
//   absent            — not this server's question (va_default, android_voice,
//                       sherpa_*: device-side engines). Absent is NOT "unavailable".
//   can_serve: true   — would succeed now.
//   can_serve: false  — would fail if chosen, on facts held here; `why` says which.
//   can_serve: null   — configured but NOT probed (a household box URL). The server
//                       never claims reachability it did not measure; the console's
//                       probe path answers it. A sleeping box must not read as "no".
// Point-in-time: credits are a ≤60 s cached ledger read (credit-balance.js). Do not
// cache an answer across a credits change.

'use strict';

const { readOptions } = require('./options');
const { signedIn } = require('./capability');
const { boxCredits } = require('./credit-balance');
const { resolveSatelliteBase, householdVoice } = require('./satellite-engines');
const byokTts = require('./byok-tts');
const geminiStt = require('./gemini-stt');

/** Host only — a URL can carry a key in its query string, so it is never echoed. */
function hostOf(url) {
    try { return new URL(String(url || '').trim()).host || null; } catch { return null; }
}

/** The credits answer, read only when it can matter (signed in). */
async function creditsNow(isSignedIn) {
    if (!isSignedIn) return { state: 'unknown', balance: null };
    return boxCredits();
}

/** The dashie_cloud row, the same for both lanes. */
function cloudRow(isSignedIn, credits) {
    if (!isSignedIn) return { can_serve: false, why: 'signed_out' };
    if (credits.state === 'spendable') return { can_serve: true, why: 'ok' };
    return { can_serve: false, why: credits.state === 'empty' ? 'no_credits' : 'credits_unreadable' };
}

/** A household box-URL row: configured → null (unprobed), empty → false. */
function boxUrlRow(url) {
    const host = hostOf(url);
    return String(url || '').trim()
        ? { can_serve: null, why: 'configured_unprobed', url_host: host }
        : { can_serve: false, why: 'not_configured' };
}

/**
 * TTS. Precedence (engines.handleTts, which routes on `serves`):
 *   1. a base URL — the add-on option tts_url (operator), else the household's
 *      local_url box;  2. BYOK (byok-tts resolveProvider: ElevenLabs, or Gemini under
 *   John's 10-10 rule);  3. Dashie Cloud when signed in;  4. null → 503.
 */
async function ttsRoute() {
    const isSignedIn = signedIn();
    const resolved = await resolveSatelliteBase('tts');
    const byok = await byokTts.resolveProvider();
    const credits = await creditsNow(isSignedIn);
    const voice = (await householdVoice()) || {};
    const opts = readOptions();

    let serves = null;
    if (resolved) serves = resolved.source === 'addon-option' ? 'operator_url' : 'local_url';
    else if (byok) serves = byok;
    else if (isSignedIn) serves = 'dashie_cloud';

    let geminiRow;
    if (resolved?.source === 'addon-option') geminiRow = { can_serve: false, why: 'operator_url_overrides' };
    else if (byok === 'gemini') geminiRow = { can_serve: true, why: 'ok' };
    else if (byok === 'elevenlabs') geminiRow = { can_serve: false, why: 'speech_key_present' };
    else {
        const ks = (() => { try { return require('./key-store').status(); } catch { return {}; } })();
        if (ks.gemini !== true) geminiRow = { can_serve: false, why: 'no_key' };
        else if (byokTts.SPEECH_KEYS.some(p => ks[p] === true)) geminiRow = { can_serve: false, why: 'speech_key_present' };
        else geminiRow = { can_serve: false, why: 'account_pays' };   // signed in with spendable credits (10-10 rule)
    }

    return {
        serves,
        base: resolved?.base || '',
        source: resolved?.source || null,
        byok_engine: byok,
        operator_engine: opts.tts_url ? { url_host: hostOf(opts.tts_url), overrides_household: true } : null,
        credits,
        rows: {
            dashie_cloud: cloudRow(isSignedIn, credits),
            gemini: geminiRow,
            local_url: boxUrlRow(voice.localTtsUrl),
        },
    };
}

/**
 * STT, the household default (an explicit `?engine=` on a request is handled in
 * handleStt before this, because it is a per-request fact, not a lane fact).
 * Precedence: 1. the household chose `gemini` (ahead of stt_url — O's D5 ruling);
 *   2. a base URL (operator stt_url, else the household's local_stt_url box);
 *   3. Dashie Cloud when signed in;  4. null → 503.
 */
async function sttRoute() {
    const isSignedIn = signedIn();
    const voice = (await householdVoice()) || {};
    const chose = String(voice.sttProvider || '');
    const resolved = chose === 'gemini' ? null : await resolveSatelliteBase('stt');
    const credits = await creditsNow(isSignedIn);
    const opts = readOptions();

    let serves = null;
    if (chose === 'gemini') serves = 'gemini';
    else if (resolved) serves = resolved.source === 'addon-option' ? 'operator_url' : 'local_stt_url';
    else if (isSignedIn) serves = 'dashie_cloud';

    return {
        serves,
        base: resolved?.base || '',
        source: resolved?.source || null,
        operator_engine: opts.stt_url ? { url_host: hostOf(opts.stt_url), overrides_household: chose !== 'gemini' } : null,
        credits,
        rows: {
            dashie_cloud: cloudRow(isSignedIn, credits),
            gemini: geminiStt.available() ? { can_serve: true, why: 'ok' } : { can_serve: false, why: 'no_key' },
            local_stt_url: boxUrlRow(voice.localSttUrl),
        },
    };
}

module.exports = { ttsRoute, sttRoute, hostOf };
