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
 *
 * 🔴 John 2026-10-12 (to HV, verbatim): "voice input is one Gemini option for the engine and key first then
 * credits". So `gemini` names the ENGINE; the PAYER is the household's Gemini key when one is stored, else the
 * account's credits (gemini-stt edge). `dashie_cloud` is retired from the offer and is read here as the cloud
 * DEFAULT, i.e. exactly like an unset value, NOT like an explicit `gemini`. Old consoles and APKs seed it as a
 * default, and an operator's stt_url has always beaten it; an alias to explicit `gemini` would silently move
 * every such box off its operator Whisper.
 *
 * Precedence: 1. the household chose `gemini` (ahead of stt_url — O's D5 ruling);
 *   2. a base URL (operator stt_url, else the household's local_stt_url box);
 *   3. Gemini when someone can pay (a stored key, or signed in → credits);  4. null → 503.
 */
const STT_RETIRED_CLOUD = 'dashie_cloud';

/** Who would pay for a Gemini STT turn right now: 'key' | 'credits' | null. */
function sttGeminiPayer(isSignedIn) {
    if (geminiStt.available()) return 'key';
    return isSignedIn ? 'credits' : null;
}

/**
 * The `gemini` row (D2, John 10-12: "always show, explain"). can_serve answers whether a turn would be
 * transcribed now; `why` names WHICH thing to fix, never a merged "unavailable". Offering is the console's.
 */
function geminiSttRow(isSignedIn, credits) {
    if (geminiStt.available()) return { can_serve: true, why: 'ok', payer: 'key' };
    if (!isSignedIn) return { can_serve: false, why: 'no_key_signed_out' };
    if (credits.state === 'spendable') return { can_serve: true, why: 'ok', payer: 'credits' };
    return { can_serve: false, why: credits.state === 'empty' ? 'no_key_no_credits' : 'no_key_credits_unreadable' };
}

async function sttRoute() {
    const isSignedIn = signedIn();
    const voice = (await householdVoice()) || {};
    const stored = String(voice.sttProvider || '');
    const chose = stored === STT_RETIRED_CLOUD ? '' : stored;   // retired → the cloud default (see above)
    const resolved = chose === 'gemini' ? null : await resolveSatelliteBase('stt');
    const credits = await creditsNow(isSignedIn);
    const opts = readOptions();
    // ROUTING asks "could anyone pay?" (a key, or an account the edge can bill); the edge decides 402 per turn.
    const routable = sttGeminiPayer(isSignedIn);

    let serves = null;
    if (chose === 'gemini') serves = 'gemini';
    else if (resolved) serves = resolved.source === 'addon-option' ? 'operator_url' : 'local_stt_url';
    else if (routable) serves = 'gemini';

    const gemini = geminiSttRow(isSignedIn, credits);
    return {
        serves,
        // `payer` answers "who IS paying for the served turn right now": the row's payer, and ONLY when the row
        // can serve. Never the routing guess above, which says 'credits' for an empty balance too (B, 10-12): a
        // disclosure keyed off it would tell an empty-balance household it is being served.
        payer: serves === 'gemini' && gemini.can_serve === true ? gemini.payer : null,
        base: resolved?.base || '',
        source: resolved?.source || null,
        operator_engine: opts.stt_url ? { url_host: hostOf(opts.stt_url), overrides_household: chose !== 'gemini' } : null,
        credits,
        rows: {
            gemini,
            // RETIRED (John 10-12). The SAME answer as `gemini`, PERMANENTLY: B's S0 still renders a stored
            // `dashie_cloud` as its own residual row and looks it up here by id, and the stored values are never
            // migrated (O 10-12: S6 skipped). Removing this leaves that row with no explanation.
            dashie_cloud: gemini,
            local_stt_url: boxUrlRow(voice.localSttUrl),
        },
    };
}

module.exports = { ttsRoute, sttRoute, hostOf };
