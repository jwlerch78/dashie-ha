// parse.test.ts — unit tests for the tolerant JSON parser (ported from console-ai-client.js).
// Run: deno test parse.test.ts

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { parseContent, sanitizeVoice, isLikelyNoise } from './parse.ts';

Deno.test('clean JSON parses', () => {
  const p = parseContent('{"type":"response","voice":"hi"}');
  assertEquals(p?.type, 'response');
  assertEquals(p?.voice, 'hi');
});

Deno.test('strips ```json fences', () => {
  const p = parseContent('```json\n{"type":"response","voice":"hi"}\n```');
  assertEquals(p?.type, 'response');
});

Deno.test('skips leading prose before the first brace', () => {
  const p = parseContent('Sure thing: {"type":"action","action":{"category":"homeassistant","command":"x"}}');
  assertEquals(p?.type, 'action');
});

Deno.test('strips trailing comma before brace', () => {
  const p = parseContent('{"type":"response","voice":"hi",}');
  assertEquals(p?.type, 'response');
});

Deno.test('repairs truncated JSON (cut between fields)', () => {
  const p = parseContent('{"type":"info_request","tool":"web_search","query":{"search_terms":"weather"},');
  assertEquals(p?.type, 'info_request');
  assertEquals(p?.tool, 'web_search');
});

Deno.test('repairs truncated JSON (missing outer close)', () => {
  const p = parseContent('{"type":"response","voice":"hi","extra":{"a":1}');
  assertEquals(p?.type, 'response');
  assertEquals(p?.voice, 'hi');
});

Deno.test('normalizes tool-name-as-type to info_request', () => {
  const p = parseContent('{"type":"web_search","query":{"search_terms":"x"}}');
  assertEquals(p?.type, 'info_request');
  assertEquals(p?.tool, 'web_search');
});

Deno.test('garbage returns null', () => {
  assertEquals(parseContent('not json at all'), null);
});

Deno.test('empty returns null', () => {
  assertEquals(parseContent(''), null);
});

Deno.test('truncated inside a string gives up (null)', () => {
  // No way to recover an unterminated string value.
  assertEquals(parseContent('{"type":"response","voice":"High of 78 deg'), null);
});

// ── sanitizeVoice (TTS cleanup) ──────────────────────────────────────────────

Deno.test('sanitizeVoice strips emoji', () => {
  assertEquals(sanitizeVoice('Sunny, high 78 🙂'), 'Sunny, high 78');
  assertEquals(sanitizeVoice('Done ✅👍'), 'Done');
});

Deno.test('sanitizeVoice strips markdown emphasis + code', () => {
  assertEquals(sanitizeVoice('It is **really** hot'), 'It is really hot');
  assertEquals(sanitizeVoice('Run `npm test` now'), 'Run npm test now');
  assertEquals(sanitizeVoice('A _quiet_ night'), 'A quiet night');
});

Deno.test('sanitizeVoice strips links to their label', () => {
  assertEquals(sanitizeVoice('See [the forecast](https://x.com)'), 'See the forecast');
});

Deno.test('sanitizeVoice strips line-start markup (headers/bullets)', () => {
  assertEquals(sanitizeVoice('# Weather\n- sunny\n- warm'), 'Weather\nsunny\nwarm');
});

Deno.test('sanitizeVoice leaves clean text untouched', () => {
  const clean = 'The Eagles beat the Cowboys 24 to 17.';
  assertEquals(sanitizeVoice(clean), clean);
});

Deno.test('parseContent sanitizes voice but preserves text (display)', () => {
  const p = parseContent('{"type":"response","voice":"Nice day ☀️ **out**","text":"Nice day ☀️ **out**"}');
  assertEquals(p?.voice, 'Nice day out');   // spoken: clean
  assertEquals(p?.text, 'Nice day ☀️ **out**'); // displayed: untouched
});

// ── isLikelyNoise (false-activation guard) ───────────────────────────────────

Deno.test('isLikelyNoise: empty / pure-symbol → noise', () => {
  assertEquals(isLikelyNoise(''), true);
  assertEquals(isLikelyNoise('   '), true);
  assertEquals(isLikelyNoise('...?!'), true);
  assertEquals(isLikelyNoise('123 ...'), true); // digits aren't letters
});

Deno.test('isLikelyNoise: any-script letters → not noise', () => {
  assertEquals(isLikelyNoise('weather?'), false);
  assertEquals(isLikelyNoise('lights off'), false);
  assertEquals(isLikelyNoise('今天天气'), false);   // non-Latin passes
  assertEquals(isLikelyNoise('¿qué hora es?'), false);
});

// ── multi envelope (normalization itself is covered in multi.test.ts) ─────────

Deno.test('multi: a well-formed envelope survives the parse', () => {
  const p = parseContent(JSON.stringify({
    type: 'multi',
    voice: 'Dimming the lights and starting some jazz.',
    steps: [
      { tool: 'home_assistant', query: { command_hint: 'dim the lights' } },
      { tool: 'music', query: { action: 'play', query: 'jazz' } },
    ],
  }));
  assertEquals(p?.type, 'multi');
  assertEquals(p?.steps?.length, 2);
});

Deno.test('multi: a STRAY top-level tool must not collapse the envelope to one info_request', () => {
  // Without 'multi' in TERMINAL_TYPES this hits the bare-tool-call rewrite (variant b) and every
  // step but music is silently discarded — the whole turn, minus the lights.
  const p = parseContent(JSON.stringify({
    type: 'multi',
    tool: 'music',
    voice: 'Dimming the lights and starting some jazz.',
    steps: [
      { tool: 'home_assistant', query: { command_hint: 'dim the lights' } },
      { tool: 'music', query: { action: 'play', query: 'jazz' } },
    ],
  }));
  assertEquals(p?.type, 'multi');
  assertEquals(p?.steps?.length, 2);
});

Deno.test('multi: normalization runs through parseContent (fenced qwen-shaped output)', () => {
  const p = parseContent('```json\n' + JSON.stringify({
    type: 'multi',
    voice: 'Turning down the thermostat and dimming the lights.',
    steps: [
      { tool: 'home_assistant', query: { command_hint: 'turn down the thermostat' } },
      { tool: 'home_assistant', query: { command_hint: 'dim the lights' } },
    ],
  }) + '\n```');
  assertEquals(p?.type, 'info_request');
  assertEquals(p?.tool, 'home_assistant');
  assertEquals(p?.query, { command_hint: 'turn down the thermostat and dim the lights' });
});

// ── Multi-emission repair (2026-07-19 kiosk-calendar silence; haiku thrash) ───────────────
Deno.test('multi-emission: two concatenated objects → the FIRST decision parses', () => {
  const r = parseContent('{"type":"response","voice":"I can\'t check the calendar on this device.","text":null}\n{"type":"response","voice":"Let me know if you need anything else!"}');
  assertEquals(r?.type, 'response');
  assertEquals(r?.voice, "I can't check the calendar on this device.");
});

Deno.test('multi-emission: object followed by prose elaboration → object parses', () => {
  const r = parseContent('{"type":"info_request","tool":"weather_data","query":{}}\nI will check the weather for you now.');
  assertEquals(r?.type, 'info_request');
  assertEquals(r?.tool, 'weather_data');
});

Deno.test('multi-emission: single clean object unchanged (no false trigger)', () => {
  const r = parseContent('{"type":"response","voice":"Hi there."}');
  assertEquals(r?.voice, 'Hi there.');
});
