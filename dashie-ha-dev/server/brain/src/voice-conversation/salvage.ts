// salvage.ts — split a FAILED-TO-PARSE prose answer into a spoken lead and an on-screen remainder.
//
// Why this exists (Tier 1 of the 2026-08-25 grounded-JSON ruling):
// When the model abandons the JSON contract, `finalize()` used to put the ENTIRE raw prose blob
// into `voice` and leave `text` null. Two consequences, measured on staging over 30 days
// (77 parse failures / 345 turns; grounded Gemini fails ~43% of the time vs ~18% ungrounded):
//   1. The spoken line runs to the length of the whole answer — up to 118 words, against a
//      contract cap of 20. That is the field report of a 118-word Avengers answer, mechanically.
//   2. `display_text` was empty on 77 of 77 failures. The screen — cards, images, display flags —
//      goes dark on every one, which is the differentiator we care most about.
//
// This module fixes (1) and the text half of (2): the lead sentences are spoken, the remainder is
// painted. It CANNOT recover `image` / `display_events` / `show_weather_overlay` / cards — those
// only come back with Tier 2 (grounding-as-retrieval + a synthesis pass). The `DROP:` marker at
// the call site is what makes the residue countable instead of invisible.
//
// 🔴 TIER 2 CONSTRAINT — VERIFIED 2026-08-25, do not re-litigate this from a guess.
// The obvious cheap fix ("just turn on Gemini's structured-output mode for grounded turns") is
// NOT AVAILABLE. Measured directly against v1beta generateContent on gemini-2.5-flash:
//   google_search alone                              → 200, groundingMetadata present
//   responseSchema alone                             → 200, valid JSON
//   google_search + responseMimeType application/json → 400 "Tool use with a response mime type:
//   google_search + responseMimeType + responseSchema → 400  'application/json' is unsupported"
// Grounding and structured output are mutually exclusive in a single call. So Tier 2's two-call
// shape (ground as RETRIEVAL, then synthesize the envelope in a second, ungrounded, schema-bound
// call) is not one option among several — it is the only one. Cost it as two calls or not at all.
//
// The same run also showed WHY you cannot simply drop grounding to get the JSON back: asked for
// the current PM of Canada, the grounded call answered "Mark Carney" (correct) and the ungrounded
// schema call answered "Justin Trudeau" — stale, stated flatly. That is verbatim the July bench's
// search-007 failure. Both halves are load-bearing; the second call must synthesize over the
// first call's retrieved text, never answer from its own weights.
//
// Design note — why a word BUDGET and not "the first sentence":
// The ruling's shape was lead-sentence → voice, remainder → text. Measured against the 76 real
// salvages, a bare first-sentence split regresses the spoken turn, because a personality preamble
// is very often its own leading sentence ("Oh, very well, if you must know such things.") — that
// split would speak the snark and put the ANSWER on screen. Accumulating whole sentences up to the
// contract's own 20-word cap keeps the preamble AND the answer in the spoken line while still
// cutting the long tail. It is the same intent with a boundary that survives the corpus.

import { sanitizeVoice } from './parse.ts';

/** The spoken-line budget, in words. Mirrors the JSON contract's own cap
 *  ("voice": max 20 words — js/ai/prompts/response-format*.md). Kept in sync by
 *  intent, not by codegen: if the prompt cap moves, move this with it. */
export const SALVAGE_VOICE_WORD_BUDGET = 20;

/** Abbreviations whose trailing period is NOT a sentence end. Cheap guard — an
 *  over-split only shortens the spoken chunk, it never corrupts it, so this list
 *  is deliberately short rather than exhaustive. */
const ABBREVIATIONS = /(?:\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|approx|no|inc|ltd|co|dept|est|fig|al)|\b[a-z](?:\.[a-z])+)\.$/i;

/** Split prose into sentences. Boundaries: a blank line (paragraph), or [.!?]+ followed by
 *  whitespace and something that can start a sentence. Returns the whole string as one
 *  element when no boundary is found — a run-on is spoken whole rather than cut mid-thought. */
export function splitSentences(prose: string): string[] {
  const out: string[] = [];
  for (const para of prose.split(/\n\s*\n/)) {
    const block = para.trim();
    if (!block) continue;
    let start = 0;
    // Candidate boundary: run of terminators, then whitespace, then an opener.
    const re = /[.!?]+["'”’)\]]*\s+(?=["'“‘(\[]*[A-Z0-9])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      const candidate = block.slice(start, m.index + m[0].length).trim();
      if (ABBREVIATIONS.test(candidate)) continue;   // "Dr. Strange" — not a boundary
      out.push(candidate);
      start = re.lastIndex;
    }
    const tail = block.slice(start).trim();
    if (tail) out.push(tail);
  }
  return out.length ? out : (prose.trim() ? [prose.trim()] : []);
}

function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * Split a salvaged prose answer into what we SPEAK and what we PAINT.
 *
 * Takes whole sentences from the front until the budget is met or exceeded (always at least
 * one), so the spoken line is never cut mid-sentence. Everything after that becomes `text`.
 *
 * - `voice` is run through `sanitizeVoice` — the same filter every PARSED voice already gets, so
 *   TTS never reads "asterisk me asterisk" out of a salvaged blob (real: the Yankees rows).
 * - `text` is left VERBATIM. Display keeps its markdown/emoji, per the same rule in parse.ts.
 * - A blob already within budget is spoken whole with `text: null` — byte-identical to the old
 *   behaviour. That is 62% of the measured corpus (47/76 ≤ 25 words), and it is the guarantee
 *   that this change cannot make a short salvage worse.
 */
export function splitSalvage(
  raw: string,
  budget: number = SALVAGE_VOICE_WORD_BUDGET,
): { voice: string; text: string | null } {
  const prose = String(raw ?? '').trim();
  if (!prose) return { voice: '', text: null };

  const sentences = splitSentences(prose);
  if (sentences.length <= 1) return { voice: sanitizeVoice(prose), text: null };

  let taken = 0;
  let words = 0;
  while (taken < sentences.length && words < budget) {
    words += wordCount(sentences[taken]);
    taken++;
  }

  const spoken = sentences.slice(0, taken).join(' ').trim();
  const rest = sentences.slice(taken).join(' ').trim();
  return { voice: sanitizeVoice(spoken), text: rest || null };
}
