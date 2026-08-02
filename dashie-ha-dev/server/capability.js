// SPDX-License-Identifier: AGPL-3.0-only
// capability.js — is a capability METERED on this box, and does the household
// still lend it?
//
// ── THE PREDICATE (decided 2026-08-02) ───────────────────────────────────────
//
//   A capability is METERED for this box when exercising it draws on a
//   credential or balance the household pays for, and which THIS BOX supplies
//   on the satellite's behalf. Metered capabilities are gated. Unmetered ones
//   never are.
//
// ⚠️ Say "account credits", never the brand's — this file is generated into an
// edition that has no account, where a comment about that brand's credits would
// substitute cleanly into a confident description of something that does not
// exist. The predicate is edition-neutral; its prose has to be too.
//
// Both clauses do work. *Credential OR balance*: account credits and a household
// BYOK key are the same thing to the household — money it spends — and the old
// gate could only see the first. *Which THIS BOX supplies*: a satellite spending
// its own key is out of scope; this governs what the box LENDS.
//
// 🔴 WHY THIS FILE EXISTS AT ALL — the brand branch disappears.
//
// The grant gate used to read `if (CLOUD.url)`, which is blank on Chickadee, so
// every satellite always granted while the spend path handed out the household's
// BYOK key. `CLOUD.url` was standing in for "does a metered resource exist here":
// a proxy for the question, not the question. Asking the real one leaves nothing
// brand-shaped to ask, so ONE code path serves both editions and a build that
// mis-generates `CLOUD.url` can no longer mis-grant.
//
// It is one module rather than a check in each lane because there are two lanes —
// the credential-vending lane (`/api/internal/voice-lease`) and the SPENDING lane
// (`converse.js`) — and they were already inconsistent: one was gated and the
// other was not. Two copies of a predicate is how that happens again.
//
// ── WHAT IT IS NOT ───────────────────────────────────────────────────────────
// A hygiene control, not a security boundary. The boundary that holds is the
// bridge secret plus Home Assistant's own auth; this decides what the household
// currently lends, and every request is still scope-checked on its own merits.

'use strict';

const auth = require('./auth');
const keyStore = require('./key-store');
const settingsStore = require('./settings-store');
const { readOptions } = require('./options');
const { getAccountVoiceConfig } = require('./account-config');

/** Keys that make a capability cost money. Grouped by what they buy, because
 *  the answer is per-capability: a box with a brain key but no TTS key lends
 *  `ai` and not `voice`, and that partial grant is a normal steady state. */
const METERED_KEYS = {
    ai: ['openrouter', 'gemini', 'claude', 'openai', 'bedrock', 'hermes'],
    voice: ['deepgram', 'elevenlabs', 'inworld'],
    tools: ['tavily', 'brave', 'pexels', 'apisports'],
};

/** Everything this box will lease at all. */
const LEASABLE_CAPABILITIES = ['voice', 'ai', 'tools'];

function signedIn() {
    try { return !!auth.readStoredJwt(); } catch { return false; }
}

/**
 * Does the household still lend its metered resources?
 *
 * ONE key name — `voice.householdSharing` — read from whichever settings backend
 * this box has. The console already writes it through a single call site
 * (`saveDefault('voice.householdSharing', …)`) and `console-auth` already
 * switches backends underneath that on local mode, so this mirrors plumbing that
 * exists rather than inventing a second vocabulary that can drift.
 *
 * 🔴 The default is asymmetric ON PURPOSE, and the axis is *account*, not brand:
 *
 *   with an account     → default OFF. The grant crosses an account boundary —
 *                         a device that is not signed in would spend the
 *                         signed-in owner's credits. Opt-in is right, and any
 *                         read error also lands here: fail CLOSED.
 *   without an account  → default ON. There is no boundary to cross. The person
 *                         who stored the key and the person who set up the
 *                         satellite are the same person, and Home Assistant has
 *                         already authenticated everyone who can reach this box.
 *                         Defaulting OFF would make the documented setup path —
 *                         add key, satellite works — silently broken, and broken
 *                         in a way indistinguishable from the bug this replaces.
 *
 * (The second default is a MONEY default, so it is one constant, alone, on its
 * own line — easy to find and easy to flip if the conservative read wins.)
 */
const ACCOUNTLESS_SHARING_DEFAULT = true;

async function readHouseholdSharing() {
    if (signedIn()) {
        try {
            const cfg = await getAccountVoiceConfig();
            return cfg.householdSharing === true;
        } catch {
            return false;   // fail closed: never lend the account's money on a read error
        }
    }
    try {
        const v = settingsStore.readUserSettings()?.voice?.householdSharing;
        return typeof v === 'boolean' ? v : ACCOUNTLESS_SHARING_DEFAULT;
    } catch {
        // No account ⇒ nothing of anyone else's to protect, and failing closed
        // here would take the whole household's voice out over a file read.
        return ACCOUNTLESS_SHARING_DEFAULT;
    }
}

/**
 * `metered` | `free` | `absent` — the three-way answer the two-way one hid.
 *
 * `absent` matters: a box with no brain at all is not "free AI", and granting
 * `ai` there would send the satellite to ask a box that can only answer with
 * setup guidance — losing today's silent fall-back to Home Assistant's own
 * engines. Metered/free/absent maps exactly onto the operator's three next
 * steps: flip sharing back on · nothing to do · add a key or sign in.
 */
function capabilityState(cap, opts = null) {
    const o = opts || readOptions();
    const keys = (() => {
        try { return keyStore.status(); } catch { return {}; }
    })();
    const hasKey = (p) => keys[p] === true;   // key-store.status() is booleans-only

    // An account IS a metered resource for all three: credits pay for every one.
    if (signedIn()) return 'metered';
    if ((METERED_KEYS[cap] || []).some(hasKey)) return 'metered';

    if (cap === 'ai') {
        const endpoint = String(o.llm_url || '').trim();
        const model = String(o.llm_model || '').trim();
        if (!endpoint || !model) return 'absent';
        // 🔴 The KEY decides, not the route. converse.js takes the local route on
        // `endpoint && model` and passes `key: llm_api_key || ''`. Empty key =
        // Ollama on the user's own hardware, where no money moves and gating it
        // would be a pure outage. Non-empty = a paid endpoint. Same route,
        // opposite answers, and only the key tells them apart.
        return String(o.llm_api_key || '').trim() ? 'metered' : 'free';
    }

    // Home Assistant's own engines are always there: Whisper/Piper for voice,
    // keyless ESPN sports and Wikimedia images for tools. Neither can be absent.
    return 'free';
}

/** Grant when it costs nothing, or when it costs something the household still
 *  lends. Absent is never granted — there is nothing to grant. */
async function grantableCapabilities(asked) {
    const wanted = Array.isArray(asked) && asked.length
        ? LEASABLE_CAPABILITIES.filter((c) => asked.includes(c))
        : LEASABLE_CAPABILITIES.slice();

    const opts = readOptions();
    const states = new Map(wanted.map((c) => [c, capabilityState(c, opts)]));
    const sharing = await readHouseholdSharing();
    const granted = wanted.filter((c) => {
        const s = states.get(c);
        return s === 'free' || (s === 'metered' && sharing);
    });

    // 🔴 The refusal must separate two OPPOSITE operator actions, or it produces
    // the undebuggable state the 2026-07-13 incident produced:
    //
    //   sharing_disabled       a resource exists and the household withdrew it
    //                          → flip sharing back on
    //   capability_unavailable nothing is configured
    //                          → add a key or sign in
    //
    // 🔴 PER CAPABILITY, not just for a whole refusal — the case that caught me.
    // The common state is a PARTIAL grant: `ai` withheld while `voice` and
    // `tools` are granted, because Home Assistant's own engines cost nothing and
    // are never gated. That is correct and is not an error, but with only a
    // top-level reason it is also SILENT: the caller sees a shorter list and
    // cannot tell "sharing is off" from "no key here". Those are the two
    // opposite operator actions the requirement is about, so the distinction has
    // to survive a partial grant too, not only a total refusal.
    const withheld = {};
    for (const [c, s] of states) {
        if (granted.includes(c)) continue;
        withheld[c] = s === 'metered' ? 'sharing_disabled' : 'capability_unavailable';
    }

    let reason = 'ok';
    if (!granted.length) {
        reason = [...states.values()].includes('metered')
            ? 'sharing_disabled'
            : 'capability_unavailable';
    }
    return { granted, withheld, reason, sharing, states };
}

/**
 * The SPEND-path question: may this box take a route that costs the household
 * money? `state` is the route's own cost, resolved by the caller — converse.js
 * knows which of its four routes it picked and what key is behind it.
 */
async function mayTakeMeteredRoute() {
    return readHouseholdSharing();
}

module.exports = {
    LEASABLE_CAPABILITIES,
    METERED_KEYS,
    ACCOUNTLESS_SHARING_DEFAULT,
    readHouseholdSharing,
    capabilityState,
    grantableCapabilities,
    mayTakeMeteredRoute,
};
