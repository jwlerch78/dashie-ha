/**
 * Need 70 — the DECISION half of the HA viewport latch, kept free of the DOM so it can be tested.
 *
 * The latch itself lives in `kiosk-shell.js` because it writes inline styles into the HA child
 * document. What lives HERE is the part that was getting the answer wrong: deciding, from two
 * widths and the passage of time, whether the latch worked, has not answered yet, or failed.
 *
 * ## Why this is a module rather than three lines inline
 *
 * The shipped version decided ONCE, 4000 ms after applying, and treated everything that was not a
 * match as failure. X s4 graded that on `.41` and the DROP it printed named the reason:
 *
 *     DROP: HA viewport latch did not widen the child — child=0 expected≈1818
 *     DROP: HA viewport latch did not widen the child — child=0 expected≈1212
 *
 * **`child=0`, not 909.** A blank or mid-navigation document reports `innerWidth` 0 — so the verify
 * was not seeing a narrow child, it was seeing NO CHILD YET, and calling that a failure. Whether the
 * single read landed before or after HA finished loading is a race, which is why the same build
 * "worked at 50 %" and "failed at 75 %" in one sweep and then FAILED at 50 % on a re-run (X, n=1,
 * labelled as such). ⚠️ **There is no zoom threshold here. Anyone who writes one into a comment is
 * describing a schedule they got lucky with.**
 *
 * ## The three outcomes, and why the third one is the whole point
 *
 * `no-document` is not a failure and must not be counted as one. Collapsing it into `narrow` is
 * exactly the defect above, and it is also the "one message for three different failures"
 * diagnosability trap: a reader who sees `did not widen` cannot tell "this engine folds" from "we
 * looked too early".
 */

/** Attribute the kiosk CSS keys `transform: scale()` on. Verified state, never intent. */
export const LATCH_ATTR = 'data-ha-viewport-latched';

/**
 * How long to keep watching after applying. Matches `ha-theme-sync.js`'s window — NOT because the
 * code is shared (it is not; see the seam note in A-status s190 cont. 7) but because it is the same
 * box's HA frontend taking the same time to settle, measured by Y at +6 s and still moving at +11 s.
 */
export const VERIFY_WINDOW_MS = 20000;

/**
 * How long we wait for the frame to report a document AT ALL, before giving up.
 *
 * 🔴 Separate from [VERIFY_WINDOW_MS] because conflating them WAS a shipped bug (row 223,
 * 2026-09-09). A zoom apply reloads the frame and arms the latch in the same breath, so the
 * first ticks legitimately see no document. When both budgets were one 20 s number, a frame
 * that loaded slowly — or a stale reference that would never report again — spent the whole
 * budget before the latch was ever tested, and the user sat at visibly wrong layout for the
 * full 20 s while `never-loaded` was reported as if it were a diagnostic curiosity.
 *
 * Now: this governs *waiting for a document*, and the verify window starts when one APPEARS.
 * Shorter on purpose — if no document has reported in 5 s, more waiting has not helped.
 */
export const DOC_DEADLINE_MS = 5000;

/** Poll cadence while watching. */
export const VERIFY_POLL_MS = 500;

/** `calc()` can land a pixel off, so the comparison is approximate. */
export const WIDTH_TOLERANCE_PX = 4;

/**
 * Pure: what do these two widths mean?
 *
 * @param {number} childWidth  the HA document's own `innerWidth` (0 while it has no document)
 * @param {number} targetWidth the iframe element's layout width (`offsetWidth`)
 * @returns {'no-document'|'widened'|'narrow'}
 */
export function classifyLatch(childWidth, targetWidth, tolerancePx = WIDTH_TOLERANCE_PX) {
  // Either side being 0 means the question cannot be answered yet: no child document, or an element
  // that has not been laid out. Neither is evidence that the latch failed.
  if (!(childWidth > 0) || !(targetWidth > 0)) return 'no-document';
  return Math.abs(childWidth - targetWidth) <= tolerancePx ? 'widened' : 'narrow';
}

/**
 * How many ticks the lever gets to work once applied, before we call it a failure and revert.
 *
 * ⚠️ **This is the one timing guess left in this file and it is labelled as such.** It is small and
 * it has a reason: the lever is a synchronous style write, so if it is going to take effect it does
 * so within a relayout — X measured the child settling within one sample of any change. 3 s is
 * generous for that. It is NOT a guess about how long HA takes to boot, which is the class of guess
 * that lost all day; that question is answered by watching, not by waiting.
 */
export const LEVER_GRACE_TICKS = 6;

/**
 * Pure state machine for the verify loop. No DOM, no timers — the caller ticks it.
 *
 * ## 🔴 The first `narrow` tick is the INTERVENTION point, not the give-up point
 *
 * This is the change X's grade forced, and the reasoning is worth keeping because two more obvious
 * designs are both wrong. X fast-polled a real device and saw:
 *
 *     gate=true  htmlOvf=(empty)  elem=1212  child=1212   ← six samples, CORRECT
 *     gate=true  htmlOvf=(empty)  elem=1212  child=909    ← re-narrows on its own
 *     gate=null  htmlOvf=(empty)  elem=1212  child=909    ← old behaviour: revert, give up
 *
 * `htmlOvf` is EMPTY at every sample: the child was transiently correct off the element resize, the
 * caller's early "already correct, nothing to do" path concluded *non-folding engine*, and **the
 * overflow lever — the one thing that would have HELD the widening — was never applied.**
 *
 * Two designs considered and rejected, each for a measured reason:
 *  - **apply the lever always** (X's first suggestion, withdrawn by X on this objection): the lever
 *    is NOT inert where it is not needed. On a document whose `html` has no explicit height,
 *    `body{height:100%}` does not resolve and `html{overflow:hidden}` simply CLIPS — measured on the
 *    Fire tablet: 819 px scrollable before, 0 after. That trades John's permanent constraint
 *    ("we can't trade off scrolling for zoom") away on a device that needed nothing.
 *  - **require N consecutive correct samples before trusting "already correct"**: another fixed
 *    guess about timing, which is the exact class of thing this unit has lost to repeatedly.
 *
 * So: treat *correct right now* as UNPROVEN, and let the fold reveal itself. A device that never
 * narrows **never receives the lever** — the Fire tablet case is protected by construction rather
 * than by a timer — and a folding device gets it at the moment the fold appears, which is also the
 * moment X's hand-test says it holds (child stayed 1818 across 15 s).
 *
 * ## The rest of the clauses, each from a measured defect
 *  - `no-document` ticks are SKIPPED, not failed (the `child=0` defect).
 *  - a `widened` tick keeps watching to the end of the window, because the child can re-narrow after
 *    HA finishes laying out — which is precisely what X observed.
 *  - a window that expires having NEVER seen a document reverts with its OWN message.
 *
 * @param {object} opts
 * @param {() => {child:number, target:number}} opts.readWidths
 * @param {() => void} opts.onApplyLever   called AT MOST ONCE, on the first narrow tick
 * @param {(reason:string, detail:object) => void} opts.onRevert  called at most once
 * @param {number} [opts.windowMs]
 * @param {number} [opts.pollMs]
 * @param {number} [opts.leverGraceTicks]
 * @returns {{tick: (elapsedMs:number) => 'watching'|'reverted'|'done', isFinished: () => boolean,
 *            leverApplied: () => boolean}}
 */
export function createLatchVerifier({
  readWidths,
  onApplyLever,
  onRevert,
  windowMs = VERIFY_WINDOW_MS,
  pollMs = VERIFY_POLL_MS,
  leverGraceTicks = LEVER_GRACE_TICKS,
  docDeadlineMs = DOC_DEADLINE_MS,
}) {
  let finished = false;
  let sawDocument = false;
  let leverApplied = false;
  let ticksSinceLever = 0;
  // Elapsed time at which a document first reported. The verify window is measured from HERE,
  // not from arming — see DOC_DEADLINE_MS.
  let firstDocAtMs = -1;

  const noteDocument = (elapsedMs) => {
    if (!sawDocument) {
      sawDocument = true;
      firstDocAtMs = elapsedMs;
    }
  };

  const finish = (reason, detail) => {
    finished = true;
    if (reason) onRevert(reason, detail);
    return reason ? 'reverted' : 'done';
  };

  return {
    isFinished: () => finished,
    leverApplied: () => leverApplied,
    tick(elapsedMs) {
      if (finished) return 'done';

      let widths;
      try {
        widths = readWidths();
      } catch (e) {
        // Reading across into the child threw — most likely the document went away under us.
        // That is not "the latch failed", but we cannot keep asserting over a frame we cannot read,
        // so revert to today's behaviour and say which of the reasons this was.
        return finish('verify-threw', { message: e && e.message });
      }

      const verdict = classifyLatch(widths.child, widths.target);

      if (verdict === 'widened') {
        noteDocument(elapsedMs);
        // Deliberately NOT finished: keep watching for a re-narrow until the window closes.
      } else if (verdict === 'narrow') {
        noteDocument(elapsedMs);   // a narrow child is still a child — we DID look at something
        if (!leverApplied) {
          // 🔴 The fold has just revealed itself. This is the intervention.
          leverApplied = true;
          ticksSinceLever = 0;
          try { onApplyLever(); } catch (e) {
            return finish('lever-threw', { message: e && e.message });
          }
          return 'watching';
        }
        ticksSinceLever++;
        if (ticksSinceLever >= leverGraceTicks) {
          // The lever was applied and the child still has not adopted the element width. This
          // engine cannot be fixed from here; put it back exactly as HA left it.
          return finish('did-not-widen', { child: widths.child, target: widths.target });
        }
        return 'watching';
      }

      // 🔴 TWO BUDGETS, NOT ONE (row 223). Before a document has reported we are spending the
      // DOCUMENT deadline; once one has, the verify window starts from that moment. Sharing one
      // 20 s number meant a slow — or permanently detached — frame consumed the entire budget
      // before the latch was ever tested, and the user wore the wrong layout for all of it.
      if (!sawDocument) {
        if (elapsedMs + pollMs > docDeadlineMs) {
          // We never once saw a document, so we never actually tested anything — say so in its
          // own words rather than reusing "did not widen", which would tell the next reader the
          // engine folds when in fact we never looked at it.
          return finish('never-loaded', {
            child: widths.child, target: widths.target, windowMs: docDeadlineMs,
          });
        }
        return 'watching';
      }

      if (elapsedMs + pollMs > firstDocAtMs + windowMs) {
        return finish(null, null);   // ended having last seen a widened child: keep both halves
      }
      return 'watching';
    },
  };
}

/**
 * The DROP text for each revert reason. Separate messages for separate failures, on purpose:
 * one message covering three causes is the diagnosability defect this file exists to avoid.
 */
export function dropMessageFor(reason, detail = {}) {
  switch (reason) {
    case 'did-not-widen':
      return 'DROP: HA viewport latch — the child did not widen (child=' + detail.child +
             ' expected≈' + detail.target + '); reverted both halves, back to CSS zoom (need 70)';
    case 'never-loaded':
      return 'DROP: HA viewport latch — the HA frame never reported a document within ' +
             detail.windowMs + 'ms, so the latch was never tested; reverted both halves (need 70)';
    case 'verify-threw':
      return 'DROP: HA viewport latch — the verify threw (' + detail.message +
             '); reverted both halves (need 70)';
    case 'lever-threw':
      return 'DROP: HA viewport latch — applying the overflow lever threw (' + detail.message +
             '); reverted both halves (need 70)';
    default:
      return 'DROP: HA viewport latch — reverted for an unnamed reason "' + reason + '" (need 70)';
  }
}
