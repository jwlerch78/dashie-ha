// sports-depth.test.ts — L1 regex-coverage for the sports TEMPLATE-vs-MODEL default (option A).
//
// Companion to game-depth.test.ts, which pins the DETAIL vocabulary (recap/scorers → secondPass).
// This pins the other half of the same gate: which asks the deterministic template may answer at
// all. Model-independent, so it's a pure fixture test — no model, no network, no deploy.
//
// THE BUG THIS ENCODES (field, 2026-07-16, Samsung + local qwen3:30b-q4):
//   "Who's starting at Striker for Spain?"  → "Spain play Argentina, Sun, Jul 19."   (×3, verbatim)
// The template was the DEFAULT for anything GAME_DETAIL_RE didn't claim. It has no "I don't know"
// branch — given a game it describes the fixture, whatever it was asked — and the data carries no
// rosters. So the answer repeated forever. ai_interactions proved it: every one of those turns is
// qwen3:30b (pass-1 routing) + a SECOND row with model='template' — the model never saw the data.
//
// Option A inverts the default: template only for a recognised score/schedule ask, else the model
// (which can say "I don't have roster data"). A miss toward the model costs one call and still
// answers; a miss toward the template is wrong forever. Fail toward the one that can admit it.
//
// Run: deno test supabase/functions/voice-conversation/sports-depth.test.ts

import { assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { templateCanAnswer, wantsGameDetail } from './orchestrator.ts';

/** The effective gate in the orchestrator's sports branch (games.length > 0). */
const goesToModel = (t: string) => wantsGameDetail(t) || !templateCanAnswer(t);

// ── TEMPLATE: what it can genuinely answer. A regression here costs money + latency on the
// hot path (every score check), so this side is the one to keep tight.

Deno.test('TEMPLATE: the verbatim field utterances that MUST stay on the template', () => {
  for (
    const t of [
      'What time is the World Cup game on Sunday?',   // field — a real schedule ask
      'What time is the World Cup game on Saturday?', // field
      'What baseball teams are on today?',            // field
      'What World Cup games are on tomorrow?',        // field
    ]
  ) assert(!goesToModel(t), `expected TEMPLATE for: "${t}"`);
});

Deno.test('TEMPLATE: score / result asks', () => {
  for (
    const t of [
      "what's the score",
      'what is the score of the Chiefs game',
      'who won the Chiefs game?',
      'who won',
      'did the Chiefs win',
      'did the Chiefs win last night',
      'who is winning',
      'are they winning',
      'what was the final score',
      'what were the results',
    ]
  ) assert(!goesToModel(t), `expected TEMPLATE for: "${t}"`);
});

Deno.test('TEMPLATE: fixture / schedule asks', () => {
  for (
    const t of [
      'when is the next Chiefs game',
      'when do the Chiefs play',
      'when are the Chiefs playing',
      'what time is the game',
      'what time do they play',
      'when is the next game',
      'is there a game today',
      'are the Chiefs playing tonight',
      'who are the Chiefs playing',
      'who do the Chiefs play next',
      'what games are on today',
      'any games on tonight',
      "what's the schedule",
    ]
  ) assert(!goesToModel(t), `expected TEMPLATE for: "${t}"`);
});

// ── MODEL: the class the template cannot answer. The fixture data has no rosters, line-ups,
// stats, standings, injuries or club history — no wording of the template could serve these.

Deno.test('MODEL: the verbatim field roster utterances — the repeat bug', () => {
  for (
    const t of [
      "Who's starting at Striker for Spain?",
      "Who's starting its striker for Spain on Sunday?",
      "And who's starting at Striker for Spain in the World Cup game Sunday?",
      'We\'re starting at Striker for Spain.',   // the STT-mangled one, same intent
    ]
  ) assert(goesToModel(t), `expected MODEL for: "${t}" — the template would read the fixture back`);
});

Deno.test('MODEL: rosters, stats, standings — data we simply do not have', () => {
  for (
    const t of [
      'who is their quarterback',
      "who's their quarterback",
      'who plays quarterback for the Chiefs',
      'who is on the roster',
      "what's the lineup",
      'is Mahomes injured',
      'how many yards does Mahomes have',
      'where are the Chiefs in the standings',
      'how many Super Bowls have the Chiefs won',
      'who is the manager of Spain',
    ]
  ) assert(goesToModel(t), `expected MODEL for: "${t}"`);
});

Deno.test('MODEL: DETAIL asks still route to synthesis (game-depth behaviour preserved)', () => {
  for (
    const t of [
      'give me a recap of the game',
      'summarize the Chiefs game',
      'who scored',
      'tell me more about the game',
      'what happened in the game',
    ]
  ) assert(goesToModel(t), `expected MODEL (detail) for: "${t}"`);
});

// ── the boundary that matters most: "who ... play" is a FIXTURE ask,
// "who plays <position>" is a ROSTER ask. Same three words, opposite paths.

Deno.test('BOUNDARY: who-are-they-playing (fixture) vs who-plays-position (roster)', () => {
  const cases: Array<[string, boolean, string]> = [
    ['who are the Chiefs playing', false, 'fixture — which OPPONENT'],
    ['who do the Chiefs play', false, 'fixture'],
    ['who is Spain playing on Sunday', false, 'fixture'],
    ['who plays quarterback for the Chiefs', true, 'roster — which PERSON'],
    ["who's starting at striker for Spain", true, 'roster'],
    ['who is their quarterback', true, 'roster'],
  ];
  for (const [text, toModel, note] of cases) {
    assert(goesToModel(text) === toModel, `"${text}" expected model=${toModel} (${note})`);
  }
});

Deno.test('empty / undefined text never reaches the template', () => {
  // No games branch runs for these anyway; pinned so the helper stays total.
  assert(!templateCanAnswer(undefined));
  assert(!templateCanAnswer(''));
});
