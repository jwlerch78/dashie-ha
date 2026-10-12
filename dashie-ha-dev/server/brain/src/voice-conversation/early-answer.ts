// early-answer.ts — SPEAK FIRST, PICTURE SECOND (VH, 2026-10-11).
//
// An image turn used to hold the WHOLE spoken answer until the picture search came back
// (orchestrator `await resolveImageHint`): ~2.4 s of silence (p50, Samsung vc368) on an answer that
// was already written. When the caller opts in, a SUPPLEMENTAL picture now lets the answer go out
// first, as a status-less `stage` line the tablet speaks, and the card follows in the final line.
//
// 🔴 John, 2026-10-11, verbatim: "I think an explicit picture request should wait. A picture that
// supplements the answer can talk first." So an EXPLICIT ask ("show me a picture of a spider") keeps
// the old path: wait, and walk the line back if no picture comes. Only a picture the prompt added to
// an answer (templates.ts "DEFAULT TO SETTING IT") speaks first.
//
// "Explicit" is decided from the USER's words, deterministically, not by the model: testable, free,
// and it cannot drift with a prompt edit. Both misclassifications fall back to a behavior that
// already exists (a missed explicit ask speaks first and still gets its picture; a false match waits
// as every image turn did before), so neither direction is a new failure mode.
//
// Structure + compat trace: .reference/threads/VH-speak-first-structure-20261011.md

/** Verbs that ask to SEE something. The one list: `promisedPictureQuery` strips these same lead-ins
 *  (plus PICTURE_FETCH_VERBS) from the user's words, so the two can never disagree about what counts
 *  as asking for a picture. Order matters for the alternation; keep it. */
export const PICTURE_SHOW_VERBS = ['show me', 'show us', 'pull up', 'display', 'let me see', 'i want to see', 'can i see'];
/** Lead-ins that fetch but do not by themselves ask to SEE ("find me a plumber"). Stripped by
 *  `promisedPictureQuery`, never sufficient for an explicit picture request. */
export const PICTURE_FETCH_VERBS = ['find', 'get me'];
/** "picture of", "photos of", … */
export const PICTURE_NOUN = '(?:picture|photo|image|pic)s?';

const SHOW_RE = new RegExp(`\\b(?:${PICTURE_SHOW_VERBS.join('|')})\\b`, 'i');
const NOUN_OF_RE = new RegExp(`\\b${PICTURE_NOUN}\\s+of\\b`, 'i');
const LOOKS_LIKE_RE = /\bwhat\s+(?:does|do|did)\s+.+\s+look\s+like\b/i;

/** Did the user ask to SEE something? ("show me a spider", "a picture of Saturn",
 *  "what does a narwhal look like"). John's ruling: these wait for the picture. */
export function isExplicitPictureRequest(userText: string | null | undefined): boolean {
  const t = String(userText || '');
  return SHOW_RE.test(t) || NOUN_OF_RE.test(t) || LOOKS_LIKE_RE.test(t);
}

/** May this image turn speak before its picture resolves? Every condition is a reason the voice
 *  might still change or the turn is not a plain answer: the caller must have opted in (old APKs,
 *  web and the HA add-on never do, so they keep the walk-back), the turn must be a pass-1 `response`
 *  carrying an image hint, sports must not own the card slot, the device's pre-fetched calendar must
 *  not be in play (its card decision waits on the image result), and the user must not have asked
 *  for the picture. */
export function isEarlyAnswerEligible(o: {
  optedIn: boolean;
  responseType: string | null | undefined;
  hasImageHint: boolean;
  sportsOwnsCard: boolean;
  calendarProvided: boolean;
  userText: string | null | undefined;
}): boolean {
  return o.optedIn && o.responseType === 'response' && o.hasImageHint && !o.sportsOwnsCard &&
    !o.calendarProvided && !isExplicitPictureRequest(o.userText);
}

/** Metadata on the EARLY turn: the card is still coming. */
export const EARLY_PENDING_META = { image_pending: true } as const;
/** Metadata on the FINAL turn after an early answer went out: the tablet uses it to attach the card
 *  without speaking twice, and `image_promise_broken` to show the on-screen fallback when no
 *  picture came (the spoken line can no longer be walked back). */
export function earlyFinalMeta(cardResolved: boolean): Record<string, unknown> {
  return cardResolved ? { early_answer_sent: true } : { early_answer_sent: true, image_promise_broken: true };
}
