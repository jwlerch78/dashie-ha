// prompt.test.ts — deterministic assembly checks for buildPrompt.
// Avoids asserting the date (formatDateTime uses current time); checks structure + fill.
// Run: deno test prompt.test.ts

import { assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildPrompt, offeredToolNames } from './prompt.ts';

const NO_PLACEHOLDERS = /\{\{\w+\}\}/; // any unfilled {{KEY}}

Deno.test('pass 1: fills placeholders, includes tools + user request', () => {
  const p = buildPrompt({ userRequest: 'what is the weather', inquiryType: null });
  assert(p.includes('what is the weather'), 'has user request');
  assert(p.includes('web_search'), 'has available tools list');
  assert(!NO_PLACEHOLDERS.test(p), 'no leftover {{PLACEHOLDER}}');
});

Deno.test('web search OFF: web_search tool is omitted, others stay (T3)', () => {
  const on = buildPrompt({ userRequest: 'hi', inquiryType: null, context: { webSearchEnabled: true } });
  assert(on.includes('- web_search:'), 'web_search listed when enabled');

  const off = buildPrompt({ userRequest: 'hi', inquiryType: null, context: { webSearchEnabled: false } });
  assert(!off.includes('- web_search:'), 'web_search line dropped when disabled');
  assert(off.includes('- sports:'), 'sports tool still present');
  assert(off.includes('- weather_data:'), 'weather tool still present');
  assert(!NO_PLACEHOLDERS.test(off), 'no leftover placeholders');
});

Deno.test('pass 1: does not include inquiry blocks', () => {
  const p = buildPrompt({ userRequest: 'hi', inquiryType: null });
  assert(!p.includes('# Inquiry Context'), 'no inquiry block in pass 1');
});

Deno.test('pass 2 web-search: includes results + inquiry block', () => {
  const data = { provider: 'brave', results: [{ title: 'Boston weather forecast', url: 'x', snippet: 'sunny 78' }] };
  const p = buildPrompt({ userRequest: 'weather?', inquiryType: 'web-search', retrievedData: data });
  assert(p.includes('# Inquiry Context: Web Search'), 'has web-search inquiry block');
  assert(p.includes('Boston weather forecast'), 'has retrieved results json');
  assert(!NO_PLACEHOLDERS.test(p), 'no leftover placeholders');
});

Deno.test('pass 2 home-assistant: includes entities', () => {
  const data = { entities: [{ entity_id: 'light.kitchen', state: 'off' }], command_hint: 'turn on kitchen' };
  const p = buildPrompt({ userRequest: 'lights', inquiryType: 'home-assistant', retrievedData: data });
  assert(p.includes('# Inquiry Context: Home Assistant'), 'has HA inquiry block');
  assert(p.includes('light.kitchen'), 'has entity id');
  assert(!NO_PLACEHOLDERS.test(p), 'no leftover placeholders');
});

Deno.test('personality config adds a prefix', () => {
  const base = buildPrompt({ userRequest: 'hi', inquiryType: null });
  const withP = buildPrompt({
    userRequest: 'hi',
    inquiryType: null,
    context: {
      customPersonalityConfig: {
        name: 'Santa',
        base_personality: 'santa',
        personality_overview: 'A jolly old elf who loves the holidays.',
        adjectives: ['jolly', 'warm'],
      },
    },
  });
  assert(withP.length > base.length, 'personality prefix lengthens the prompt');
});

// ── Capability gating (device-only tools) ────────────────────────────────────
// A tool the CALLER can't run must not be OFFERED: the model would call it, we'd decline,
// and the turn (plus credits) is spent on an apology. Absent list = old client = no gating.

Deno.test('offeredToolNames: absent client_fulfilled_tools offers every tool (old client)', () => {
  const tools = offeredToolNames({});
  assert(tools.includes('music'), 'music offered when the caller declares nothing');
});

Deno.test('offeredToolNames: music dropped when the caller cannot fulfill it', () => {
  const tools = offeredToolNames({ clientTools: ['calendar', 'weather'] });
  assert(!tools.includes('music'), 'music must NOT be offered to a device with no Music Assistant');
  assert(tools.includes('sports'), 'server-fulfilled tools are unaffected');
  assert(tools.includes('calendar_events'), 'read tools are unaffected');
});

Deno.test('offeredToolNames: music offered when the caller declares it', () => {
  const tools = offeredToolNames({ clientTools: ['calendar', 'weather', 'music'] });
  assert(tools.includes('music'), 'music offered to a device that has Music Assistant');
});

Deno.test('offeredToolNames: calendar_write dropped when voice-write policy is off', () => {
  const off = offeredToolNames({ calendarWriteEnabled: false });
  assert(!off.includes('calendar_write'), 'calendar_write must not be offered when voice writes are off');
  // Read tools are untouched by the write gate.
  assert(off.includes('calendar_events'), 'calendar READ stays offered');
  const on = offeredToolNames({ calendarWriteEnabled: true });
  assert(on.includes('calendar_write'), 'calendar_write offered when opted in (voice|both)');
  // undefined (caller does not set it) → unchanged (kept).
  assert(offeredToolNames({}).includes('calendar_write'), 'absent flag keeps calendar_write (back-compat)');
});

Deno.test('offeredToolNames: headless caller ([]) gets no device-only tools', () => {
  const tools = offeredToolNames({ clientTools: [] });
  assert(!tools.includes('music'), 'HA satellite has no music player');
  // NB: the PROMPT names tools differently from the WIRE (weather_data vs weather).
  assert(tools.includes('weather_data'), 'weather still offered — the brain self-fulfills it');
});

Deno.test('buildPrompt: an ungated tool line is absent from the prompt text itself', () => {
  const withMusic = buildPrompt({ userRequest: 'play some jazz', inquiryType: null, context: {} });
  const without = buildPrompt({
    userRequest: 'play some jazz', inquiryType: null,
    context: { clientTools: ['calendar', 'weather'] },
  });
  assert(withMusic.includes('- music:'), 'baseline prompt lists the music tool');
  assert(!without.includes('- music:'), 'gated prompt must not mention the music tool at all');
});

// ── calendar_events offered to EVERY caller (2026-07-21, supersedes the 2026-07-19 drop) ──
// A non-claiming caller (kiosk) is offered calendar_events and the orchestrator self-fulfills a
// graceful "not set up on this device" decline (like weather's server fulfill / calendar_write's
// decline). The prior DROP produced tool-substitution, not a decline (0/2 models declined — bench
// 2026-07-20). calendar_WRITE is still dropped (its branch declines; a write must not tempt routing).
Deno.test('offeredToolNames: calendar_events offered even when the caller does not claim calendar (kiosk)', () => {
  const tools = offeredToolNames({ clientTools: ['schedule_action', 'music'] });
  if (!tools.includes('calendar_events')) throw new Error('calendar_events must be offered (server self-fulfills the decline)');
  if (tools.includes('calendar_write')) throw new Error('calendar_write must NOT be offered to a non-claiming caller');
  if (!tools.includes('weather_data')) throw new Error('weather must STAY offered (server self-fulfill)');
});

Deno.test('offeredToolNames: calendar_events offered when claimed (full mode)', () => {
  const tools = offeredToolNames({ clientTools: ['calendar', 'calendar_write', 'weather'] });
  if (!tools.includes('calendar_events')) throw new Error('calendar_events missing for a claiming caller');
});

Deno.test('offeredToolNames: absent clientTools still offers calendar (legacy caller, unchanged)', () => {
  const tools = offeredToolNames({});
  if (!tools.includes('calendar_events')) throw new Error('legacy callers must keep calendar');
});

// ── Examples follow the offering ──────────────────────────────────────────────────────────
Deno.test('examples: every caller keeps the calendar_events example (it is always offered now)', () => {
  const prompt = buildPrompt({ userRequest: 'hi', inquiryType: null,
    context: { clientTools: ['weather', 'schedule_action', 'music'] } });
  if (!prompt.includes('calendar_events')) throw new Error('calendar_events example must survive for a non-claiming caller (it is offered)');
  if (!prompt.includes('tool: "chores"')) throw new Error('offered-tool examples must survive the filter');
});

Deno.test('examples: a claiming caller keeps the calendar example', () => {
  const prompt = buildPrompt({ userRequest: 'hi', inquiryType: null,
    context: { clientTools: ['calendar', 'calendar_write', 'weather'] } });
  if (!prompt.includes('tool: "calendar_events"')) throw new Error('calendar example missing for a claiming caller');
});
