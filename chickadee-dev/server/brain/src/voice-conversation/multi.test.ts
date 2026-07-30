// multi.test.ts — the multi envelope normalizer.
//
// The fixtures are REAL model outputs captured by the 2026-07-16 feasibility spike, not invented
// shapes: qwen's multi[home_assistant+home_assistant] (5/5 reproducible) and the
// multi[home_assistant+weather_data] that 13/15 samples produced for "dim the lights and what is
// the weather?". If either of those stops being normalized, the defect ships.
//
//   deno test supabase/functions/voice-conversation/multi.test.ts

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { ACTION_TOOLS, normalizeMultiEnvelope } from './multi.ts';
import type { ParsedResponse } from './types.ts';

const n = (p: Record<string, unknown>) => normalizeMultiEnvelope(p as ParsedResponse);

// ── non-multi envelopes pass through untouched (this runs on every parse, incl. pass 2) ──

Deno.test('leaves a plain response untouched', () => {
  const input = { type: 'response', voice: 'Hello' };
  assertEquals(n(input), input as unknown as ParsedResponse);
});

Deno.test('leaves a single info_request untouched', () => {
  const input = { type: 'info_request', tool: 'weather_data', query: { timeframe: 'current' } };
  assertEquals(n(input), input as unknown as ParsedResponse);
});

Deno.test("leaves pass-2's action envelope untouched", () => {
  const input = {
    type: 'action',
    voice: 'Turning off the kitchen lights',
    action: { category: 'homeassistant', command: 'execute_commands', parameters: { commands: [] } },
  };
  assertEquals(n(input), input as unknown as ParsedResponse);
});

// ── the good case ──

Deno.test('keeps a genuine two-tool multi', () => {
  const out = n({
    type: 'multi',
    voice: 'Turning down the heat, dimming the lights, and starting some jazz.',
    steps: [
      { tool: 'home_assistant', query: { command_hint: 'turn down the thermostat and dim the lights' } },
      { tool: 'music', query: { action: 'play', query: 'jazz' } },
    ],
  });
  assertEquals(out.type, 'multi');
  assertEquals((out.steps as unknown[]).length, 2);
  assertEquals(out.voice, 'Turning down the heat, dimming the lights, and starting some jazz.');
});

Deno.test('keeps a three-action multi and preserves step order', () => {
  const out = n({
    type: 'multi',
    voice: 'On it.',
    steps: [
      { tool: 'video_feeds', query: { action: 'show', camera: 'front door' } },
      { tool: 'home_assistant', query: { command_hint: 'turn on the porch light' } },
      { tool: 'music', query: { action: 'stop' } },
    ],
  });
  assertEquals((out.steps as MultiStepish[]).map((s) => s.tool), ['video_feeds', 'home_assistant', 'music']);
});

// ── defect 2: qwen over-decomposes, 5/5 reproducible ──

Deno.test('REAL qwen output: merges multi[home_assistant+home_assistant] into one info_request', () => {
  // "turn down the thermostat and dim the lights" — one tool, so not a multi at all.
  const out = n({
    type: 'multi',
    voice: 'Turning down the thermostat and dimming the lights.',
    steps: [
      { tool: 'home_assistant', query: { command_hint: 'turn down the thermostat' } },
      { tool: 'home_assistant', query: { command_hint: 'dim the lights' } },
    ],
  });
  assertEquals(out.type, 'info_request');
  assertEquals(out.tool, 'home_assistant');
  // The joined hint reconstructs the request the model should have emitted as one step.
  assertEquals(out.query, { command_hint: 'turn down the thermostat and dim the lights' });
});

Deno.test('merges a same-tool duplicate but STAYS multi when a second tool survives', () => {
  const out = n({
    type: 'multi',
    voice: 'Sure.',
    steps: [
      { tool: 'home_assistant', query: { command_hint: 'dim the lights' } },
      { tool: 'home_assistant', query: { command_hint: 'lock the door' } },
      { tool: 'music', query: { action: 'play', query: 'jazz' } },
    ],
  });
  assertEquals(out.type, 'multi');
  const steps = out.steps as MultiStepish[];
  assertEquals(steps.length, 2);
  assertEquals(steps[0].query, { command_hint: 'dim the lights and lock the door' });
  assertEquals(steps[1].tool, 'music');
});

Deno.test('same-tool merge keeps the first query when hints are unmergeable', () => {
  const out = n({
    type: 'multi',
    voice: 'Sure.',
    steps: [
      { tool: 'music', query: { action: 'play', query: 'jazz' } },
      { tool: 'music', query: { action: 'stop' } },
      { tool: 'home_assistant', query: { command_hint: 'dim the lights' } },
    ],
  });
  const steps = out.steps as MultiStepish[];
  assertEquals(steps.length, 2);
  assertEquals(steps[0].query, { action: 'play', query: 'jazz' });
});

// ── defect 1: the action+question deferral leaks 13/15 — enforce it here ──

Deno.test('REAL leaked output: collapses multi[home_assistant+weather_data] to the action alone', () => {
  // "dim the lights and what is the weather?" — gemini 3/5, qwen 5/5, gemma 5/5 emitted this
  // despite the prompt forbidding it. Collapsing to home_assistant is byte-identical to today.
  const out = n({
    type: 'multi',
    voice: 'Dimming the lights and checking the weather for you.',
    steps: [
      { tool: 'home_assistant', query: { command_hint: 'dim the lights' } },
      { tool: 'weather_data', query: { timeframe: 'current' } },
    ],
  });
  assertEquals(out.type, 'info_request');
  assertEquals(out.tool, 'home_assistant');
  assertEquals(out.query, { command_hint: 'dim the lights' });
});

Deno.test('a collapsed multi never speaks its multi voice as the confirmation', () => {
  const out = n({
    type: 'multi',
    voice: 'Dimming the lights and checking the weather for you.',
    steps: [
      { tool: 'home_assistant', query: { command_hint: 'dim the lights' } },
      { tool: 'weather_data', query: { timeframe: 'current' } },
    ],
  });
  // It would confirm a weather answer we are no longer producing.
  assertEquals(out.voice, undefined);
  assertEquals(out.processing_message, 'Dimming the lights and checking the weather for you.');
});

Deno.test('drops question steps but keeps a multi when >= 2 actions survive', () => {
  const out = n({
    type: 'multi',
    voice: 'Sure.',
    steps: [
      { tool: 'home_assistant', query: { command_hint: 'dim the lights' } },
      { tool: 'music', query: { action: 'play', query: 'jazz' } },
      { tool: 'weather_data', query: { timeframe: 'current' } },
    ],
  });
  assertEquals(out.type, 'multi');
  assertEquals((out.steps as MultiStepish[]).map((s) => s.tool), ['home_assistant', 'music']);
});

Deno.test('all-question multi routes the first question, as a single-tool pass-1 does today', () => {
  const out = n({
    type: 'multi',
    voice: 'Let me check.',
    steps: [
      { tool: 'weather_data', query: { timeframe: 'current' } },
      { tool: 'calendar_events', query: { time_range: 'today' } },
    ],
  });
  assertEquals(out.type, 'info_request');
  assertEquals(out.tool, 'weather_data');
});

// ── malformed envelopes ──

Deno.test('an unknown tool is not swallowed — it reaches the unsupported_tool path', () => {
  const out = n({ type: 'multi', voice: 'Sure.', steps: [{ tool: 'lights', query: {} }] });
  assertEquals(out.type, 'info_request');
  assertEquals(out.tool, 'lights');
});

Deno.test('a single-step multi collapses to an ordinary info_request', () => {
  const out = n({
    type: 'multi',
    voice: 'Playing jazz.',
    steps: [{ tool: 'music', query: { action: 'play', query: 'jazz' } }],
  });
  assertEquals(out.type, 'info_request');
  assertEquals(out.tool, 'music');
});

Deno.test('drops junk steps (no tool / not an object) before deciding', () => {
  const out = n({
    type: 'multi',
    voice: 'Sure.',
    steps: [
      null,
      'nonsense',
      { query: { action: 'play' } },
      { tool: '   ' },
      { tool: 'music', query: { action: 'play', query: 'jazz' } },
    ],
  });
  assertEquals(out.type, 'info_request');
  assertEquals(out.tool, 'music');
});

Deno.test('empty/missing/non-array steps yield an empty multi for the error path — never voiced', () => {
  for (const steps of [[], undefined, 'nope', 42]) {
    const out = n({ type: 'multi', voice: 'Doing it all!', steps });
    assertEquals(out.type, 'multi', `steps=${JSON.stringify(steps)}`);
    assertEquals(out.steps, []);
  }
});

Deno.test('a step keeps an absent query (orchestrator falls back to the transcript)', () => {
  const out = n({
    type: 'multi',
    voice: 'Sure.',
    steps: [{ tool: 'home_assistant' }, { tool: 'music' }],
  });
  const steps = out.steps as MultiStepish[];
  assertEquals(steps.length, 2);
  assertEquals(steps[0].query, undefined);
});

Deno.test('ACTION_TOOLS is the device-fulfilled do-set, spelled as the prompt spells them', () => {
  assertEquals([...ACTION_TOOLS].sort(), ['home_assistant', 'music', 'video_feeds']);
});

interface MultiStepish {
  tool: string;
  query?: unknown;
}
