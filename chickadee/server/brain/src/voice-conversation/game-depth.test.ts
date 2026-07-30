// game-depth.test.ts — L1 regex-coverage for the DLG-2 sports "depth" router.
//
// After the cascade brain routes a turn to the sports tool AND games are fetched, the
// orchestrator picks one of two response paths based ONLY on the user's original text:
//   • GLANCE (default) → templateSports: 1 model call, one-line score voice, emits a score card
//   • DETAIL           → secondPass (INQUIRY_SPORTS synthesis): 2 model calls, rich recap, NO card
// The boundary is a deterministic regex on req.text (`wantsGameDetail`), NOT a model-set flag
// (FB34: the model is unreliable at emitting new structured fields). Because it's model-independent,
// its vocabulary is a pure fixture test — no model, no network, no deploy.
//
// This complements the two existing orchestrator.test.ts DLG-2 tests (which prove the wiring —
// DETAIL→pass2/no-card, GLANCE→card — for ONE phrase each). Here we pin the whole VOCABULARY, so a
// future edit to GAME_DETAIL_RE that drops/loosens a phrase fails loudly.
//
// The gate is intentionally BROAD — it only runs inside the sports branch, where the model has
// already committed to a sports query — so "tell me about"/"more about" over-matching is by design.
//
// Run: deno test supabase/functions/voice-conversation/game-depth.test.ts
//
// NOT covered here (different layers, tracked in the eval STATE handoff):
//   • routing accuracy (did the model pick sports at all) → L2 Live cases (cases/sports*.json)
//   • detail-path SYNTHESIS quality (recap reads well, scorers in text, no invented plays) →
//     model-dependent AND cascade-side; the L2 Live harness doesn't drive the cascade brain, so
//     this needs a cascade-brain harness (open work).

import { assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { wantsGameDetail } from './orchestrator.ts';

// Should route DETAIL (→ synthesis, no card). One phrase per regex alternation + real utterances.
const DETAIL: string[] = [
  'give me a summary of the Mexico game',
  'summarize the Lakers game',
  "recap last night's Lakers game",
  'give me the rundown',              // "rundown"
  'break it down for me',             // "break it down"
  'breakdown of the game',            // "breakdown" (one word)
  'highlights from the game',
  'any highlights?',                  // "highlights?"
  'walk me through the game',
  'go deeper on the game',
  'analysis of the match',            // "analysis"
  'analyze the match',                // "analyze"
  'how did the Celtics play?',        // how did .{0,24}? play
  'how did they do?',                 // how did .{0,24}? do
  'how did the game look?',           // how did .{0,24}? look
  'what happened in the World Cup final?',
  'tell me more about that game',     // "tell me more" (the canonical dialog follow-up)
  'tell me about the Yankees game',   // "tell me about"
  'more about the Dodgers game',      // "more about"
  'any details on the Yankees game?', // "any details"
  'more details please',              // "more details"
  'what were the details?',           // "details"
  'RECAP the game',                   // case-insensitive
  // Scorer-intent (finding #9, approach A) — routes to synthesis so the LLM voices scorers
  // cross-sport. Pairs with the INQUIRY_SPORTS prompt fix (step 2, pending).
  'who scored?',                      // "who scored"
  'who scored in the game?',
  'who got the goals?',               // who (?:got|had) (?:the |a )?goals?
  'who had a goal?',
  'top scorer of the match',          // "top scorer"
  'did anyone get a hat trick?',      // "hat trick"
];

// Should stay GLANCE (→ template + card, 1 call). None of these may trip the regex.
const GLANCE: string[] = [
  "what's the score of the Mexico game",
  'who won the Lakers game?',
  'did the Celtics win?',
  'when do the Yankees play next?',   // "play" only matches after "how did …"
  'what time is the game?',
  'are the Lakers playing tonight?',  // "playing" ditto
  'who is winning?',
  "what's the final?",
];

// Boundary cases — assert CURRENT behavior so any change is deliberate (these define where the
// vocabulary may want tuning; see the notes).
const BOUNDARY: Array<{ text: string; detail: boolean; note: string }> = [
  // (Scorer-intent — "who scored" etc. — was DONE via approach A and is now in DETAIL above.)
  // Minor vocabulary gap: only "breakdown" (one word) and "break it down" trigger; "break down the
  // game" (no "it") does not.
  { text: 'break down the game', detail: false, note: 'no match — "break it down"/"breakdown" only' },
];

Deno.test('DLG-2 depth: DETAIL phrases route to synthesis', () => {
  for (const t of DETAIL) {
    assert(wantsGameDetail(t), `expected DETAIL (synthesis) for: "${t}"`);
  }
});

Deno.test('DLG-2 depth: GLANCE phrases stay templated (no false positives)', () => {
  for (const t of GLANCE) {
    assert(!wantsGameDetail(t), `expected GLANCE (template+card) for: "${t}" — regex over-matched`);
  }
});

Deno.test('DLG-2 depth: boundary cases pin current behavior', () => {
  for (const { text, detail, note } of BOUNDARY) {
    assert(wantsGameDetail(text) === detail, `boundary "${text}" expected detail=${detail} (${note})`);
  }
});

Deno.test('DLG-2 depth: empty/undefined text → GLANCE (never synthesis)', () => {
  assert(!wantsGameDetail(undefined));
  assert(!wantsGameDetail(''));
});
