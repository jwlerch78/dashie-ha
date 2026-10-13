// SPDX-License-Identifier: AGPL-3.0-only
// server/provider-fetch.js — every call this add-on makes to GOOGLE passes through here, so a test box can
// make Google "fail" on purpose (John 10-12: built so T's hardware legs can prove that an outage spends
// no credits, which is the half of ruling A that only a failing provider can show).
//
// The DEV-ONLY add-on option `debug_provider_fault` (off | 503 | timeout | unparsed) is declared in the dev
// channel's overlay ONLY (scripts/compose-dev-config.mjs). Prod's schema does not have it, so Home Assistant
// rejects it there before the add-on starts: that absence is the enforcement, as for lease_ttl_seconds.
//
// Rules:
//   - ONE hook for every lane (STT, TTS key + stream, the brain, the Live token mint), not a copy per lane.
//     It wraps `fetch`, never a URL constant, because generated/gemini-tts-stream.js is generated from the
//     edge and must not change for a test switch.
//   - GOOGLE ONLY (generativelanguage.googleapis.com). ElevenLabs, OpenAI, OpenRouter, the account's own
//     model box and every Dashie Cloud call pass through untouched, so a fallback to credits is real.
//   - LOUD: an armed switch logs FAULT-INJECTION ARMED once, and EVERY faked call logs `FAULT-INJECTED:`,
//     so a hardware result can never be mistaken for a real answer from Google. The query string is cut
//     before logging (the Live mint carries ?key=).
//   - Read ONCE per process. Home Assistant restarts the add-on when its options are saved.
//   - Off (the default, and any unknown value, which also logs a DROP) is plain `fetch`.

'use strict';

const GOOGLE = /^https:\/\/generativelanguage\.googleapis\.com\//;
const FAULTS = new Set(['503', 'timeout', 'unparsed']);
const UNANSWERED_MS = 30_000;   // a "timeout" with no caller signal still ends, rather than hanging the lane

let mode = null;   // null = not read yet

function faultMode() {
    if (mode !== null) return mode;
    let v = 'off';
    try { v = String(require('./options').readOptions().debug_provider_fault ?? 'off'); } catch { v = 'off'; }
    if (v !== 'off' && !FAULTS.has(v)) console.warn(`DROP: debug_provider_fault=${v.slice(0, 20)} is not off|503|timeout|unparsed — treated as off`);
    mode = FAULTS.has(v) ? v : 'off';
    if (mode !== 'off') console.warn(`FAULT-INJECTION ARMED: debug_provider_fault=${mode} — every Google call on this box is FAKED until the option is set back to off`);
    return mode;
}

/** `fetch`, unless the dev switch is armed and `url` is Google's: then the chosen fault, loudly. */
async function providerFetch(url, init = {}) {
    const m = faultMode();
    if (m === 'off' || !GOOGLE.test(String(url))) return fetch(url, init);
    console.warn(`FAULT-INJECTED: ${m} for ${String(url).replace(/\?.*$/, '')}`);
    if (m === '503') {
        return new Response(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'FAULT-INJECTED: The model is overloaded.' } }),
            { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    if (m === 'unparsed') return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    // 'timeout': never answer, so the CALLER's own timer fires, as it would against a hung Google.
    return new Promise((_, reject) => {
        const fail = () => { const e = new Error('FAULT-INJECTED: no answer'); e.name = 'AbortError'; reject(e); };
        const sig = init.signal;
        if (!sig) { setTimeout(fail, UNANSWERED_MS); return; }
        if (sig.aborted) { fail(); return; }
        sig.addEventListener('abort', fail, { once: true });
    });
}

// Read at LOAD, which is startup (every Google lane requires this module): an ARMED box says so in its
// first lines, not only once a call happens to be faked. A box left armed is the hazard (O, 10-12).
faultMode();

/** Test seam: forget the cached mode so the next call re-reads the option. */
function __resetForTest() { mode = null; }

module.exports = { providerFetch, __resetForTest };
