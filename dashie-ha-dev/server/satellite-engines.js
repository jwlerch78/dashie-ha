// SPDX-License-Identifier: AGPL-3.0-only
// server/satellite-engines.js — the per-consumer-CLASS tier engines.js has been
// missing, recorded as an open design question in its header since 2026-08-23
// and scheduled by John on 2026-08-28.
//
// ── THE QUESTION IT ANSWERS ─────────────────────────────────────────────────
//
// Convergence is the product intent: ONE household voice configuration, set in
// the console, that a Dashie voice pipeline and an ESP32 / Voice-PE style
// satellite both consume. `engines.js` could not have it, and the reason was
// never plumbing — it was that **a single flat value cannot express it.**
//
//   `/api/voice/stt|tts`  → the SATELLITE lane. HA Assist pipelines and Wyoming
//                           satellites. **No Dashie runtime, no APK, no bridge.**
//   console `voice.local*`→ the DEVICE-DIRECT lane. A Dashie tablet calls its own
//                           configured server itself; engines.js is not involved.
//
// A tablet may run on-device Moonshine STT. An ESP32 cannot: it has no CPU for it
// and no way to reach it. So `sherpa_moonshine_base` is a perfectly good household
// answer that is MEANINGLESS to this lane, and pushing it here would either 503 or
// silently do nothing.
//
// ── 🔴 THE RULE, AND IT IS A CLASS TEST, NOT A URL TEST ─────────────────────
//
// The satellite class can consume exactly one thing: an engine reachable over the
// network from the add-on. So the tier does not ask *"is a URL configured"* — it
// asks **"is the household's CHOSEN engine one this class can consume at all"**,
// and only then uses the URL that goes with it.
//
// That distinction is the whole design. Asking the URL question instead would
// route a satellite at `localSttUrl` whenever one happened to be saved — including
// on a household that deliberately chose on-device STT and left an old URL behind
// in the form. It would look like convergence and behave like a stale value.
//
// ── PRECEDENCE, AND WHY THE ADD-ON OPTION STAYS ON TOP ─────────────────────
//
//   1. add-on option `stt_url` / `tts_url`  — the operator's DIRECT statement about
//      THIS lane, typed into add-on config. It outranks the household default
//      because it is the more specific instruction, and because it is the only
//      knob an operator has if the household choice is wrong for their satellites.
//   2. the household choice, IF its provider is server-reachable (see above).
//   3. nothing — engines.js keeps its existing fallbacks unchanged (hosted cloud
//      when signed in, else the 503 that says literally what to do).
//
// ⚠️ Step 2 is ADDITIVE. Every box that works today keeps working: a box with
// `stt_url` set never reaches it, and a box whose household choice is on-device
// gets `null`, which is exactly the state engines.js already handles. The only
// behaviour that changes is the one the header called a known limitation — a
// signed-out box configuring local STT/TTS in the console and having it "written
// and never read BY THESE ENTITIES".

'use strict';

const { readOptions } = require('./options');

/**
 * Provider ids whose configured value is a URL this add-on can reach.
 *
 * 🔴 An explicit allow-list, not a "does it look like a URL" test. A new
 * on-device engine added to the picker must NOT silently become satellite-usable
 * because it happens to store something in the URL field; it has to be added
 * here deliberately, by someone who has decided a satellite can reach it.
 * Failure direction: an unknown provider is treated as NOT reachable, so a new
 * engine degrades to today's behaviour rather than to a wrong route.
 */
const SERVER_REACHABLE = Object.freeze({
    // Own-box OpenAI-compatible Whisper / TTS — a LAN URL, reachable from here.
    stt: new Set(['local_stt_url']),
    tts: new Set(['local_url']),
});

/** The household's voice config, from whichever backend this box actually has.
 *  Signed in → the account; account-less → the panel blob the console writes.
 *  Never throws: any failure resolves to "no household answer", which falls
 *  through to engines.js's existing behaviour. */
async function _householdVoice() {
    try {
        const acct = await require('./account-config').getAccountVoiceConfig();
        // getAccountVoiceConfig returns SAFE_DEFAULT (all-empty) when there is no
        // account, so an empty provider here is the signal to try the panel blob
        // rather than evidence that the household chose nothing.
        if (acct && (acct.sttProvider || acct.ttsProvider)) return acct;
    } catch { /* fall through to the panel blob */ }
    try {
        const local = require('./settings-store').readUserSettings();
        return local?.voice || null;
    } catch { return null; }
}

/**
 * Resolve the base URL this lane should use for `kind`, or null.
 *
 * @param {'stt'|'tts'} kind
 * @returns {Promise<{base: string, source: 'addon-option'|'household'}|null>}
 *   `source` is returned so the caller can LOG which tier answered — without it,
 *   a household-resolved satellite is indistinguishable from a configured one in
 *   the logs, and the first support question about this feature is "where did it
 *   get that URL from".
 */
async function resolveSatelliteBase(kind) {
    if (kind !== 'stt' && kind !== 'tts') return null;

    const opts = readOptions();
    const optKey = kind === 'stt' ? 'stt_url' : 'tts_url';
    const configured = String(opts[optKey] || '').trim().replace(/\/+$/, '');
    if (configured) return { base: configured, source: 'addon-option' };

    const voice = await _householdVoice();
    if (!voice) return null;

    const provider = String((kind === 'stt' ? voice.sttProvider : voice.ttsProvider) || '');
    if (!SERVER_REACHABLE[kind].has(provider)) {
        // The household DID choose something; this class just cannot consume it.
        // Logged distinctly from "nothing configured", because they are different
        // situations and only one of them is a thing the user can fix here.
        if (provider) {
            console.log(`[satellite-engines] ${kind}: household uses "${provider}", which this lane cannot consume — falling through`);
        }
        return null;
    }

    const urlKey = kind === 'stt' ? 'localSttUrl' : 'localTtsUrl';
    const base = String(voice[urlKey] || '').trim().replace(/\/+$/, '');
    if (!base) {
        console.warn(`DROP: satellite-${kind}-no-url — household provider is "${provider}" but ${urlKey} is empty`);
        return null;
    }
    return { base, source: 'household' };
}

module.exports = { resolveSatelliteBase, SERVER_REACHABLE };
