// SPDX-License-Identifier: AGPL-3.0-only
// sharing-state.js — classify what this household is ACTUALLY lending.
//
// CONTRACTS #72's five user-facing states, decided here so that exactly one
// place holds the rules. The console renders the sentences; this decides which
// state holds. Prose lives on the surface, classification lives here — the two
// editions share this file and must never disagree about the state, while the
// wording differs per surface by design (#72: the console says "in API Keys",
// the tablet says "in the <brand> console").
//
// ── WHY A SEPARATE MODULE RATHER THAN A ROUTE HANDLER ────────────────────────
//
// It started inside the /api/voice/sharing-state handler, where nothing could
// call it. A classification with five outcomes and a dominance rule that cannot
// be exercised by a control is a classification nobody can prove; the controls
// in scripts/check-sharing-state.mjs call THIS function, not a copy of its
// rules. A second copy written for a test is the hand-mirror the seam rule
// exists to stop, and it is worse in a test than in production because it
// passes while the shipped path is wrong.
//
// 🔴 PURE. No I/O, no clock, no reads. It is handed the output of
// `capability.grantableCapabilities(null)` and returns a verdict.

'use strict';

/**
 * @param {object} g  the shape returned by capability.grantableCapabilities():
 *                    { granted: string[], withheld: Record<string,string>,
 *                      sharing: boolean, states: Map<string,'metered'|'free'|'absent'> }
 * @returns {{state: string, remedy: string|null}}
 *
 *   state:
 *     using_keys    a metered capability exists AND sharing is on → it IS lent
 *     sharing_off   a metered capability exists AND sharing is off
 *     using_free    everything grantable is genuinely free and present
 *     unknown       nothing grantable, or the input is unusable → render NOTHING
 *
 *   remedy:
 *     not_configured   something is withheld as `capability_unavailable` and the
 *                      operator's action is to add a key
 *     null             no action, or the action is already implied by `state`
 */
function classifySharingState(g) {
    // 🔴 UNKNOWN IS NOT OFF, and this guard is the reason the function takes a
    // whole object rather than four arguments: a malformed or partial input
    // must not fall through into a confident "sharing is off". The 2026-07-31
    // bug was exactly this shape — sharing had been ON for a day while the card
    // rendered Off, because an unreadable state collapsed into the reassuring
    // answer. For a control that governs whether a box spends the household's
    // keys, the failure has to LOOK like a failure.
    if (!g || typeof g !== 'object' || !g.states || typeof g.states.values !== 'function') {
        return { state: 'unknown', remedy: null };
    }

    const granted = Array.isArray(g.granted) ? g.granted : [];
    const withheld = g.withheld && typeof g.withheld === 'object' ? g.withheld : {};
    const values = [...g.states.values()];
    const anyMetered = values.includes('metered');

    let state;
    if (anyMetered && g.sharing) state = 'using_keys';
    // 🔴 sharing_off DOMINATES using_free, deliberately. A box that holds a key
    // with sharing off is also, truthfully, "using built-in voice" — but the
    // actionable fact is that something IS being withheld, and the console is
    // where it gets flipped back on. Reporting the benign half of a true
    // sentence is how an operator concludes there is nothing to do.
    else if (anyMetered) state = 'sharing_off';
    else if (granted.length) state = 'using_free';
    // Nothing metered and nothing granted: there is no honest sentence for this,
    // so there is no sentence. Rendering a withheld string here would claim a
    // withholding that did not happen.
    else state = 'unknown';

    // ⚠️ The remedy rides ALONGSIDE `using_free` rather than replacing it, and
    // that is not a sixth state. #72's own wording makes the two describe one
    // situation from opposite ends: state 2's parenthetical is "(HA
    // Whisper/Piper, keyless tools)" — voice and tools with no `ai` — which is
    // precisely what puts `capability_unavailable` on `ai` in state 3. Both of
    // John's sentences are true at once and he approved both.
    //
    // Suppressed under `sharing_off` because `state` already carries that
    // remedy; emitting both would render two instructions for one situation and
    // send the operator to the wrong one first.
    //
    // 🔴 And suppressed under `unknown`, which the control caught and I had
    // wrong: `unknown` renders NOTHING, so a remedy surviving it is a bare
    // instruction with no situation attached — "add them in API Keys" floating
    // above an empty card. A remedy is a modifier on a rendered state, never a
    // thing that renders alone. Unreachable today (voice and tools are always
    // `free`, so the all-absent input cannot occur), which is exactly why it
    // needed a control rather than a reading: the day `capabilityState` gains a
    // fourth answer, nothing else would have caught it.
    const RENDERS = state === 'using_keys' || state === 'using_free';
    const reasons = new Set(Object.values(withheld));
    const remedy = RENDERS && reasons.has('capability_unavailable')
        ? 'not_configured'
        : null;

    return { state, remedy };
}

module.exports = { classifySharingState };
