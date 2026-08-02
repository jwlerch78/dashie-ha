// orchestrator.test.ts — the two-pass loop with mocked I/O (no network).
// Exercises REAL prompt assembly + REAL parse + a FAKE gateway/search/log.
// Run: deno test orchestrator.test.ts

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { looksLikeSportsAsk, type OrchestratorIO, promisedPictureQuery, runOrchestration } from './orchestrator.ts';
// Contract shapes come from published modules, not the Deno-coupled impls — so this
// test ships runnable with the open brain source. See io-contracts.ts.
import type { LogData } from './io-contracts.ts';
import type { WeatherResult } from './weather.ts';
import type { VoiceRequest } from './types.ts';

function makeIO(responses: string[], opts: { gatewayFails?: boolean; retain?: boolean; model?: string; spendable?: boolean; rateLimited?: boolean; weather?: WeatherResult | 'throw'; sportsGames?: Array<Record<string, unknown>>; account?: { model?: string | null; webSearchEnabled?: boolean | null; retrievePicturesEnabled?: boolean | null; zipCode?: string | null; calendarWriteAccess?: string | null } } = {}) {
  let calls = 0;
  let searches = 0;
  let lastGrounding = false;
  let firstGrounding: boolean | null = null;
  let lastModel: string | null = null;
  let lastPrompt: string | null = null;
  let lastSportsQuery: Record<string, unknown> | null = null;
  const kinds: Array<'decide' | 'narrate'> = [];
  const temps: Array<number | undefined> = [];
  const model = opts.model ?? 'gemini-2.5-flash';
  const provider = model.startsWith('gemini-') ? 'gemini' : (model.startsWith('claude-') ? 'claude' : 'openai');
  const logs: LogData[] = [];
  const searchLogs: Array<{ provider: string; result_count?: number }> = [];
  const io: OrchestratorIO = {
    callGateway: (args) => {
      if (opts.gatewayFails) return Promise.resolve({ ok: false, error: 'boom', latency_ms: 1 });
      lastGrounding = !!args.grounding;
      if (firstGrounding === null) firstGrounding = !!args.grounding;
      lastModel = args.modelId;
      lastPrompt = args.prompt;
      kinds.push(args.kind ?? 'narrate');   // record the decide/narrate intent per pass
      temps.push(args.temperature);          // record the (usually undefined) per-call temp override
      const content = responses[calls++] ?? '{"type":"response","voice":"fallback"}';
      return Promise.resolve({
        ok: true,
        raw: { content, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, model, provider },
        latency_ms: 1,
      });
    },
    runWebSearch: (q) => {
      searches++;
      return Promise.resolve({ provider: 'tavily', query: q, results: [{ title: 'r', url: 'u', snippet: 's' }], result_count: 1, latency: 1 });
    },
    runSports: (q) => {
      searches++;
      lastSportsQuery = q as Record<string, unknown>;
      // Default: ONE game (the single-card path). A slate test passes opts.sportsGames
      // — a lone game now renders as the richer detail card, not a 1-row slate.
      const games = opts.sportsGames ?? [{ league: 'fifa.world', home: 'Mexico', away: 'South Korea', homeScore: 1, awayScore: 0, status: 'Final' }];
      return Promise.resolve({ provider: 'espn', query: q, games, result_count: games.length, latency: 1 });
    },
    resolvePersonality: () => Promise.resolve(null),
    logInteraction: (_t, d) => { logs.push(d); return Promise.resolve(); },
    logWebSearch: (_t, d) => { searchLogs.push(d); return Promise.resolve(); },
    logSports: () => Promise.resolve(),
    getDefaultModel: () => Promise.resolve(model),
    readRetainTranscripts: () => Promise.resolve(opts.retain ?? false),
    // Only wire the CR1 gate when the test opts in (default: omitted → always spendable).
    ...(opts.spendable === undefined ? {} : {
      checkSpendable: () => Promise.resolve({ spendable: opts.spendable!, balance: opts.spendable ? 5 : 0, floor: 0 }),
    }),
    // Only wire the T3 account config when the test opts in (default: omitted → all-null).
    ...(opts.account === undefined ? {} : {
      readAccountAiConfig: () => Promise.resolve({ model: null, webSearchEnabled: null, retrievePicturesEnabled: null, calendarWriteAccess: null, ...opts.account }),
    }),
    // Only wire the CR3 rate limiter when the test opts in (default: omitted → allowed).
    ...(opts.rateLimited === undefined ? {} : {
      checkRateLimit: () => Promise.resolve({ allowed: !opts.rateLimited, retryAfterSeconds: opts.rateLimited ? 30 : 0 }),
    }),
    // Only wire the weather self-fulfiller when the test opts in (default: omitted → absent IO
    // → the weather branch hands back client_tool, unchanged).
    ...(opts.weather === undefined ? {} : {
      getWeather: () => opts.weather === 'throw'
        ? Promise.reject(new Error('geocode failed'))
        : Promise.resolve(opts.weather as WeatherResult),
    }),
  };
  return { io, logs, searchLogs, gatewayCalls: () => calls, searchCalls: () => searches, grounded: () => lastGrounding, pass1Grounded: () => !!firstGrounding, lastPrompt: () => lastPrompt, lastModel: () => lastModel, lastSportsQuery: () => lastSportsQuery, kinds: () => kinds, temps: () => temps };
}

function deps(req: Partial<VoiceRequest> = {}) {
  return { req: { text: 'hi', endpoint_id: 'kiosk-1', ...req } as VoiceRequest, userId: 'u1', token: 'tok', supabase: {} };
}

Deno.test('direct response → one pass, logged once', async () => {
  const m = makeIO(['{"type":"response","voice":"It is sunny"}']);
  const turn = await runOrchestration(deps(), m.io);
  assertEquals(turn.type, 'response');
  assertEquals(turn.voice, 'It is sunny');
  assertEquals(turn.stages.length, 1);
  assertEquals(m.gatewayCalls(), 1);
  assertEquals(m.logs.length, 1);
});

Deno.test('tool logging: direct response → response_type=response, no tool, tool_trace has route', async () => {
  const m = makeIO(['{"type":"response","voice":"It is sunny"}']);
  await runOrchestration(deps(), m.io);
  const log = m.logs.at(-1)!;
  assertEquals(log.response_type, 'response');
  assertEquals(log.tool_used, null);
  assert(log.tool_trace && (log.tool_trace as { route?: string }).route, 'tool_trace carries a route');
  assertEquals((log.tool_trace as { tool?: unknown }).tool, null);
});

// ── Fix C: recover a mis-enveloped pass-2 home_assistant action ──
// The model resolves the entities correctly but re-emits the tool request
// ({type:info_request, tool:home_assistant, query:{commands}}) instead of {type:action}. The
// orchestrator used to discard it as a clarify; now it lifts the commands into the action.

Deno.test('Fix C: pass-2 info_request WITH commands → recovered as an action', async () => {
  const m = makeIO([
    // pass-1 routes to home_assistant
    '{"type":"info_request","tool":"home_assistant","query":{"command_hint":"turn on the office lights"}}',
    // pass-2 mis-envelopes: info_request instead of action, but commands are correct
    '{"type":"info_request","tool":"home_assistant","query":{"commands":[{"domain":"light","service":"turn_on","data":{"entity_id":"light.office"}}]}}',
  ]);
  const turn = await runOrchestration(deps({ text: 'turn on the office lights', provided_context: { ha_entities: [{ entity_id: 'light.office', domain: 'light', friendly_name: 'Office', state: 'off' }] } }), m.io);
  assertEquals(turn.type, 'action');
  assertEquals(turn.action?.category, 'homeassistant');
  assertEquals(turn.action?.command, 'execute_commands');
  const cmds = (turn.action?.parameters as { commands?: Array<Record<string, unknown>> })?.commands;
  assertEquals(cmds?.[0]?.data, { entity_id: 'light.office' });
});

Deno.test('Fix C: pass-2 info_request with NO commands → still clarifies (no phantom action)', async () => {
  const m = makeIO([
    '{"type":"info_request","tool":"home_assistant","query":{"command_hint":"do the thing"}}',
    // pass-2 loops the tool but carries nothing actionable
    '{"type":"info_request","tool":"home_assistant","query":{"note":"unclear"}}',
  ]);
  const turn = await runOrchestration(deps({ text: 'do the thing', provided_context: { ha_entities: [{ entity_id: 'light.x', domain: 'light', friendly_name: 'X', state: 'off' }] } }), m.io);
  assertEquals(turn.type, 'response');           // clarify, not a fabricated action
  assertEquals(turn.action, null);
  assert(turn.voice.includes("didn't quite catch"), 'speaks the clarification');
});

Deno.test('Fix C: recovery drops malformed commands (no domain/service) — never actuates garbage', async () => {
  const m = makeIO([
    '{"type":"info_request","tool":"home_assistant","query":{"command_hint":"x"}}',
    '{"type":"info_request","tool":"home_assistant","query":{"commands":[{"entity_id":"light.office"}]}}',   // no domain/service
  ]);
  const turn = await runOrchestration(deps({ text: 'x', provided_context: { ha_entities: [{ entity_id: 'light.office', domain: 'light', friendly_name: 'Office', state: 'off' }] } }), m.io);
  assertEquals(turn.type, 'response');           // filtered to empty → clarify, not a junk action
  assertEquals(turn.action, null);
});

// ── decide-vs-narrate temperature (the temp 0.7 routing bug) ──
// A routing decision / action emission must be deterministic (kind:'decide' → temp 0); prose
// synthesis keeps warmth (kind:'narrate' → 0.7). These pin which pass gets which INTENT — the
// gateway maps intent→temperature, so pinning intent here is sufficient and mock-independent.

Deno.test('temp: pass-1 routing is a DECIDE call', async () => {
  const m = makeIO(['{"type":"response","voice":"hi"}']);
  await runOrchestration(deps(), m.io);
  assertEquals(m.kinds(), ['decide']);
});

Deno.test('temp: the home_assistant second pass is DECIDE (it emits an action, not prose)', async () => {
  const m = makeIO([
    '{"type":"info_request","tool":"home_assistant","query":{"command_hint":"turn on the light"}}',
    '{"type":"action","voice":"Done.","action":{"category":"homeassistant","command":"execute_commands","parameters":{"commands":[]}}}',
  ]);
  await runOrchestration(deps({ text: 'turn on the light', provided_context: { ha_entities: [{ entity_id: 'light.x', domain: 'light', friendly_name: 'X', state: 'off' }] } }), m.io);
  // pass-1 routes (decide); pass-2 emits the action (decide) — neither should sample.
  assertEquals(m.kinds(), ['decide', 'decide']);
});

Deno.test('temp: no route_temperature → pass-1 sends no explicit override (intent default stands)', async () => {
  const m = makeIO(['{"type":"response","voice":"hi"}']);
  await runOrchestration(deps(), m.io);
  // undefined at the call site → gateway.ts falls back to TEMPERATURE['decide'] (0). The knob is inert.
  assertEquals(m.temps(), [undefined]);
});

Deno.test('temp: options.route_temperature overrides ONLY the pass-1 routing call (WS-F.0c bench knob)', async () => {
  const m = makeIO([
    '{"type":"info_request","tool":"web_search","query":"tallest mountain"}',
    '{"type":"response","voice":"Everest, 8849 meters."}',
  ]);
  await runOrchestration(deps({ text: 'how tall is everest', options: { route_temperature: 0.7 } }), m.io);
  // Pass-1 (routing) carries the override; the pass-2 synthesis is untouched (still its intent default).
  assertEquals(m.temps(), [0.7, undefined]);
  assertEquals(m.kinds(), ['decide', 'narrate']);
});

Deno.test('temp: a web_search synthesis second pass is NARRATE (prose keeps warmth)', async () => {
  const m = makeIO([
    '{"type":"info_request","tool":"web_search","query":"tallest mountain"}',
    '{"type":"response","voice":"Everest, 8849 meters."}',
  ]);
  await runOrchestration(deps({ text: 'how tall is everest' }), m.io);
  assertEquals(m.kinds(), ['decide', 'narrate']);   // route decision, then narration
});

// ── parsed_ok: the JSON contract's failure rate (was computed and thrown away) ──
// The whole point: a model that IGNORES the contract and answers in prose degrades to
// type:'response' — byte-identical in the DB to a model that correctly chose not to call a
// tool. These tests pin the one column that tells them apart.

Deno.test('parsed_ok: valid contract JSON → logged true', async () => {
  const m = makeIO(['{"type":"response","voice":"It is sunny"}']);
  const turn = await runOrchestration(deps(), m.io);
  assertEquals(turn.parsed_ok, true);
  assertEquals(m.logs.at(-1)!.parsed_ok, true);
});

Deno.test('parsed_ok: prose fallback → turn SPEAKS as a response, but the log says parsed_ok=false', async () => {
  // The invisible failure. The model ignored the JSON contract entirely and just talked —
  // for an HA command this is exactly the "hallucinated having turned the light on" case.
  const m = makeIO(['Sure, turning on the office light.']);
  const turn = await runOrchestration(deps({ text: 'turn on the office light' }), m.io);
  const log = m.logs.at(-1)!;
  // The user hears a normal spoken answer and the route reads 'direct' — nothing looks wrong.
  assertEquals(turn.type, 'response');
  assertEquals(turn.route, 'direct');
  assertEquals(log.tool_used, null);
  // response_type is null here (toolMeta does `parsed?.type ?? null`), which LOOKS like a tell —
  // but it is NOT a usable one: the non-terminal pass-1 rows log null too (next test). Only
  // parsed_ok separates "model broke the contract" from "model correctly answered directly".
  assertEquals(log.response_type, null);
  assertEquals(log.parsed_ok, false);
  assertEquals(turn.parsed_ok, false);
});

Deno.test('parsed_ok: why response_type=null is NOT a proxy for a parse failure', async () => {
  // A perfectly-parsed tool call logs a non-terminal pass-1 row with response_type=null (that
  // call site passes no meta). So `response_type IS NULL` conflates a contract violation with a
  // healthy tool turn — which is precisely why the failure rate was unmeasurable before this.
  const m = makeIO([
    '{"type":"info_request","tool":"web_search","query":"weather in boston"}',
    '{"type":"response","voice":"It is 50 and sunny."}',
  ]);
  await runOrchestration(deps({ text: 'what is the weather' }), m.io);
  const pass1 = m.logs[0];
  // Absent here; the DB handler stores it as NULL (`logData.response_type || null`) — the same
  // NULL the broken-contract row above lands as …
  assertEquals(pass1.response_type ?? null, null);
  assertEquals(pass1.parsed_ok, true);       // … but the contract was honored. Only this tells them apart.
  // WS-F.0a: EXACTLY ONE miss row per turn. The non-terminal pass-1 tool-call row is excluded
  // (miss=null — it's not an answer); the terminal pass-2 answer row is miss=false. So a 2-pass
  // turn contributes ONE row to the denominator, not two (no double-count).
  assertEquals(pass1.miss ?? null, null);
  assertEquals(m.logs.at(-1)!.miss, false);
});

Deno.test('parsed_ok: fenced + trailing-comma JSON still parses → true (tolerant parse, not a violation)', async () => {
  const m = makeIO(['```json\n{"type":"response","voice":"ok",}\n```']);
  const turn = await runOrchestration(deps(), m.io);
  assertEquals(turn.parsed_ok, true);
  assertEquals(m.logs.at(-1)!.parsed_ok, true);
});

Deno.test('parsed_ok: template pass → null (synthesized prose, no model JSON to grade)', async () => {
  // A template row must not count as a contract violation — it would silently inflate the
  // failure rate of every model that routes to sports.
  const m = makeIO(['{"type":"info_request","tool":"sports","query":{"team":"Rays"}}']);
  await runOrchestration(deps({ text: 'did the rays win' }), m.io);
  const templateLog = m.logs.find((l) => l.model === 'template');
  assert(templateLog, 'sports synthesis logged a template pass');
  assertEquals(templateLog!.parsed_ok, null);
  // The pass-1 row that MADE the (valid) tool call is still graded true.
  assertEquals(m.logs[0].parsed_ok, true);
});

Deno.test('tool logging: a tool turn → tool_used + REDACTED free-text args on the terminal row', async () => {
  const m = makeIO([
    '{"type":"info_request","tool":"web_search","query":"weather in boston"}',
    '{"type":"response","voice":"It is 78"}',
  ]);
  await runOrchestration(deps(), m.io);
  const terminal = m.logs.find((l) => l.tool_used === 'web_search')!;
  assert(terminal, 'a row logged the web_search tool');
  assertEquals((terminal.tool_trace as { tool?: unknown }).tool, 'web_search');
  // The logged copy never carries the raw search string — an equality-
  // preserving token replaces it ("weather in boston" is 17 chars).
  const args = String((terminal.tool_trace as { args?: unknown }).args);
  assert(/^\[redacted:[0-9a-f]*:17\]$/.test(args), `expected redacted token, got: ${args}`);
});

Deno.test('tool logging: an image on a direct response → show_image, searchTerms redacted, resolved kept', async () => {
  // "Show me a picture" answers directly but ATTACHES an image card — that IS a tool use. The card
  // resolver hits the network (no --allow-net here → resolves false), but the tool + terms still log.
  const m = makeIO(['{"type":"response","voice":"Here is a picture.","image":{"searchTerms":"Harry Kane"}}']);
  await runOrchestration(deps({ retrieve_pictures: true }), m.io);
  const log = m.logs.at(-1)!;
  assertEquals(log.tool_used, 'show_image');
  assertEquals((log.tool_trace as { route?: string }).route, 'image');
  const args = (log.tool_trace as { args?: { searchTerms?: string; resolved?: boolean } }).args!;
  assert(/^\[redacted:[0-9a-f]*:10\]$/.test(String(args.searchTerms)), `searchTerms must be redacted, got: ${args.searchTerms}`);
  assertEquals(args.resolved, false);   // structured boolean survives redaction
});

// ── image promise safety-net (2026-07-27) ──────────────────────────────────
Deno.test('promisedPictureQuery: names the subject from the MODEL voice ("picture of X")', () => {
  // The exact field failure: "show me a picture of a chickadee" → the model spoke a caption but
  // set no image field. The subject is in its own words.
  assertEquals(
    promisedPictureQuery('You\'d like to see a picture of a chickadee, my dear friend? Here is a lovely one for you.', 'you show me a picture of a tickety?'),
    'chickadee',
  );
});

Deno.test('promisedPictureQuery: "here he is" with no subject → falls back to the user request', () => {
  assertEquals(promisedPictureQuery('Here he is!', 'show me Mark Carney'), 'Mark Carney');
});

Deno.test('promisedPictureQuery: a normal answer makes NO promise → null (never fabricates)', () => {
  assertEquals(promisedPictureQuery('It is 72 degrees and sunny.', "what's the weather"), null);
  assertEquals(promisedPictureQuery('The capital of France is Paris.', "what's the capital of France"), null);
  // "picture this" is not a promise to SHOW a picture.
  assertEquals(promisedPictureQuery('Picture this: a calmer morning.', 'motivate me'), null);
});

Deno.test('image salvage: a promise with NO image field still logs show_image (salvaged)', async () => {
  // The model promises a picture but omits `image` — the safety-net derives a query so the
  // screen isn't blank. The resolver hits the network (resolves false here), but the tool logs.
  const m = makeIO(['{"type":"response","voice":"Here is a picture of a chickadee for you."}']);
  await runOrchestration(deps({ retrieve_pictures: true }), m.io);
  const log = m.logs.at(-1)!;
  assertEquals(log.tool_used, 'show_image');
  const args = (log.tool_trace as { args?: { salvaged?: boolean; resolved?: boolean } }).args!;
  assertEquals(args.salvaged, true);
});

Deno.test('image salvage: a plain answer with no promise does NOT trigger an image search', async () => {
  const m = makeIO(['{"type":"response","voice":"It is 72 and sunny."}']);
  await runOrchestration(deps({ retrieve_pictures: true }), m.io);
  assertEquals(m.logs.at(-1)!.tool_used, null);   // no show_image
});

// ── I4: no published code path calls a metered cloud tool when self-hosted ──────────────
// The claim a hostile reader tests first, and until now it was backed by code-reading
// only (T2 plan: "manual and never run"). These are the automated half.
//
// The self-hosted shell (chickadee-io / addon-io) fails checkSpendable OPEN so a BYOK
// turn can run on the user's own endpoint. That same signal used to be the ONLY gate on
// the Dashie-funded tools, so `retrieve_pictures: true` from the caller re-enabled image
// search on a box with no account — it missed us only because that shell's toolConn is
// empty, making the URL relative so fetch threw. Off by rule now; these pin it.

Deno.test('I4: paidTools:false → request retrieve_pictures:true CANNOT re-enable image search', async () => {
  const m = makeIO(['{"type":"response","voice":"Here is a picture of a chickadee for you."}']);
  const io: OrchestratorIO = { ...m.io, billing: 'byok', paidTools: false };
  await runOrchestration(deps({ retrieve_pictures: true }), io);
  const log = m.logs.at(-1)!;
  const caps = (log.tool_trace as { caps?: { web_search: boolean; retrieve_pictures: boolean } }).caps!;
  assertEquals(caps.retrieve_pictures, false);   // the request override does NOT win here
  assertEquals(caps.web_search, false);          // same gate covers the other funded tool
  assertEquals(log.tool_used, null);             // and no image search was even attempted
});

Deno.test('I4: paidTools absent (cloud shell) leaves the request override working', async () => {
  // Guards the fix against over-reach: the metered cloud path is unchanged.
  const m = makeIO(['{"type":"response","voice":"hi"}']);
  await runOrchestration(deps({ retrieve_pictures: true }), m.io);
  const caps = (m.logs.at(-1)!.tool_trace as { caps?: { retrieve_pictures: boolean } }).caps!;
  assertEquals(caps.retrieve_pictures, true);
});

Deno.test('capability snapshot: every terminal row carries tool_trace.caps (toggles + offered tools)', async () => {
  // Default account: web search ON, gemini model → native grounding, no web_search tool offered.
  const m = makeIO(['{"type":"response","voice":"It is sunny"}']);
  await runOrchestration(deps(), m.io);
  const caps = (m.logs.at(-1)!.tool_trace as { caps?: { web_search: boolean; retrieve_pictures: boolean; grounding: boolean; tools: string[] } }).caps!;
  assert(caps, 'tool_trace carries a caps snapshot');
  assertEquals(caps.web_search, true);
  assertEquals(caps.retrieve_pictures, false);   // request default off
  assertEquals(caps.grounding, true);            // gemini grounds natively
  assert(caps.tools.includes('calendar_events') && caps.tools.includes('sports'), 'offered tool list present');
  assert(!caps.tools.includes('web_search'), 'gemini-grounds → web_search not in the offered list');
});

Deno.test('capability snapshot: account web search OFF → caps says disabled (reads as "disabled", not defect)', async () => {
  const m = makeIO(['{"type":"response","voice":"hi"}'], { account: { webSearchEnabled: false } });
  await runOrchestration(deps({ retrieve_pictures: true }), m.io);
  const caps = (m.logs.at(-1)!.tool_trace as { caps?: { web_search: boolean; retrieve_pictures: boolean; grounding: boolean; tools: string[] } }).caps!;
  assertEquals(caps.web_search, false);
  assertEquals(caps.retrieve_pictures, true);    // request override wins
  assertEquals(caps.grounding, false);           // no grounding when search is disabled
  assert(!caps.tools.includes('web_search'));
});

Deno.test('device-fulfilled tool turn logs the user utterance (console showed "(transcript not saved)")', async () => {
  // calendar/music/schedule_action/weather are pass-1-only: the DEVICE composes and speaks the
  // ack, so there's no server-side response text. These branches passed {} for the retain fields,
  // so the row carried NO transcript and the console rendered every scheduling / calendar / music
  // turn as "(transcript not saved for this turn)" — timing and tokens, but not what was asked.
  const m = makeIO(['{"type":"info_request","tool":"schedule_action","query":{"delay_minutes":5,"kind":"prompt","prompt":"tell me a joke"}}'], { retain: true });
  await runOrchestration(deps({ text: 'tell me a joke in 5 minutes' }), m.io);
  const row = m.logs.at(-1)!;
  assertEquals(row.prompt_text, 'tell me a joke in 5 minutes');
  // No response_text: the device speaks the ack, the brain never sees it. Honest null beats a
  // fabricated one.
  assertEquals(row.response_text ?? null, null);
});

Deno.test('device-fulfilled tool turn honors the retention opt-in (no retain → no transcript)', async () => {
  const m = makeIO(['{"type":"info_request","tool":"schedule_action","query":{"delay_minutes":5,"kind":"prompt","prompt":"tell me a joke"}}'], { retain: false });
  await runOrchestration(deps({ text: 'tell me a joke in 5 minutes' }), m.io);
  assertEquals(m.logs.at(-1)!.prompt_text ?? null, null);
});

Deno.test('announcement turn: schedule_action is NOT offered (a fired action cannot re-schedule itself)', async () => {
  // A scheduled action firing replays its stored prompt back through the pipeline, so the
  // brain sees a user-like utterance. If schedule_action were on the menu the replay could
  // route straight back to it — the action re-scheduling ITSELF, compounding every fire.
  // Not offering the tool makes that impossible by construction (vs. guessing after the fact).
  const m = makeIO(['{"type":"response","voice":"Why did the chicken…"}']);
  await runOrchestration(deps({ announcement: true }), m.io);
  const caps = (m.logs.at(-1)!.tool_trace as { caps?: { tools: string[] } }).caps!;
  assert(!caps.tools.includes('schedule_action'), 'schedule_action must not be offered on an announcement turn');
  // Everything else this turn still needs stays available — a fired "tell me if the garage
  // is open" must still be able to reach home_assistant.
  assert(caps.tools.includes('home_assistant'), 'other tools remain offered on an announcement turn');
});

Deno.test('normal turn: schedule_action IS offered (guard must not leak into ordinary turns)', async () => {
  const m = makeIO(['{"type":"response","voice":"ok"}']);
  await runOrchestration(deps(), m.io);
  const caps = (m.logs.at(-1)!.tool_trace as { caps?: { tools: string[] } }).caps!;
  assert(caps.tools.includes('schedule_action'), 'a user turn can still schedule');
});

Deno.test('redaction never touches the Turn: client_tool query arrives intact while the log is redacted', async () => {
  const m = makeIO(['{"type":"info_request","tool":"calendar_events","query":{"time_range":"today","query":"dentist"}}']);
  const turn = await runOrchestration(deps(), m.io);
  // Device fulfillment needs the raw keyword — the returned Turn is untouched.
  const q = turn.client_tool?.query as Record<string, unknown>;
  assertEquals(q?.query, 'dentist');
  assertEquals(q?.time_range, 'today');
  // The logged copy keeps the structured window but redacts the free-text keyword.
  const logged = (m.logs.at(-1)!.tool_trace as { args?: Record<string, unknown> }).args!;
  assertEquals(logged.time_range, 'today');
  assert(/^\[redacted:[0-9a-f]*:7\]$/.test(String(logged.query)), `expected redacted keyword, got: ${logged.query}`);
});

Deno.test('capability snapshot: the pass-2 (synthesis) row carries caps too', async () => {
  // Non-gemini model → real two-pass web search; the terminal pass-2 row logs toolMeta from
  // pass-1 + the caps that rode on context into secondPass.
  const m = makeIO([
    '{"type":"info_request","tool":"web_search","query":"latest news"}',
    '{"type":"response","voice":"Here is the news"}',
  ], { model: 'claude-sonnet-5' });
  await runOrchestration(deps(), m.io);
  const terminal = m.logs.find((l) => l.tool_used === 'web_search')!;
  const caps = (terminal.tool_trace as { caps?: { web_search: boolean; tools: string[] } }).caps!;
  assert(caps, 'pass-2 row carries caps');
  assertEquals(caps.web_search, true);
  assert(caps.tools.includes('web_search'), 'non-gemini + search ON → web_search offered');
});

Deno.test('get_current_time → server-templated LOCAL time, no pass-2, never UTC (contract #20)', async () => {
  // The seam that let cascade answer time in UTC while Live got it right: get_current_time was
  // a server tool the cascade never offered. Now it's dispatched here and templated from the
  // tool's local `spoken` value — one gateway call (pass-1), no pass-2 synthesis.
  const m = makeIO(['{"type":"info_request","tool":"get_current_time","query":{}}']);
  const turn = await runOrchestration(deps({ timezone: 'America/New_York' }), m.io);
  assert(turn.voice && turn.voice.length > 0, 'expected a spoken local time');
  assert(!/\bUTC\b/i.test(turn.voice!), `must not answer in UTC — got: ${turn.voice}`);
  assert(/\b\d{4}\b/.test(turn.voice!), `expected a local date with a year — got: ${turn.voice}`);
  assertEquals(m.gatewayCalls(), 1); // tier-1 template: pass-1 only, no pass-2
});

Deno.test('action → returned, NOT dispatched by the brain', async () => {
  const m = makeIO(['{"type":"action","voice":"ok","action":{"category":"homeassistant","command":"execute_commands","parameters":{}}}']);
  const turn = await runOrchestration(deps(), m.io);
  assertEquals(turn.type, 'action');
  assert(turn.action, 'action present');
  assertEquals(turn.action?.command, 'execute_commands');
  assertEquals((turn as { action_result?: unknown }).action_result, undefined); // brain does not dispatch
});

Deno.test('web_search (Gemini) → native grounding, no Tavily fetch', async () => {
  // Gemini models ground via Google Search inside the gateway call (build plan §D):
  // no runWebSearch, no Tavily search-log; the second pass runs WITH grounding on.
  const m = makeIO([
    '{"type":"info_request","tool":"web_search","query":"weather"}',
    '{"type":"response","voice":"It is 78"}',
  ]); // default model = gemini-2.5-flash
  const turn = await runOrchestration(deps(), m.io);
  assertEquals(turn.voice, 'It is 78');
  assertEquals(m.searchCalls(), 0);                 // Tavily NOT called
  assertEquals(m.gatewayCalls(), 2);                // pass1 + grounded synthesis
  assertEquals(m.grounded(), true);                 // synthesis pass requested grounding
  assertEquals(turn.stages.map((s) => s.name), ['pass1', 'grounded_search', 'pass2']);
  assertEquals(turn.usage.total_tokens, 30);
  assertEquals(m.logs.length, 2);
  assertEquals(m.searchLogs.length, 0);             // no Tavily-style web-search log
});

Deno.test('web_search (non-Gemini) → Tavily two-pass', async () => {
  // Non-Gemini / local models can't ground → keep the runWebSearch (Tavily) two-pass.
  const m = makeIO([
    '{"type":"info_request","tool":"web_search","query":"weather"}',
    '{"type":"response","voice":"It is 78"}',
  ], { model: 'claude-haiku-4-5' });
  const turn = await runOrchestration(deps(), m.io);
  assertEquals(turn.voice, 'It is 78');
  assertEquals(m.searchCalls(), 1);                 // Tavily called
  assertEquals(m.gatewayCalls(), 2);
  assertEquals(m.grounded(), false);                // no grounding for non-Gemini
  assertEquals(turn.stages.map((s) => s.name), ['pass1', 'fetch_search', 'pass2']);
  assertEquals(turn.usage.total_tokens, 30);
  assertEquals(m.logs.length, 2);
  assertEquals(m.searchLogs.length, 1);
  assertEquals(m.searchLogs[0].provider, 'tavily');
  assertEquals(m.searchLogs[0].result_count, 1);
});

Deno.test('Gemini: pass-1 grounds natively, web_search NOT offered as a JSON tool (FB34 v2)', async () => {
  // Design rule (John, 2026-07-06): Gemini uses ITS OWN search — grounding is enabled on
  // pass-1 and web_search never appears in its offered tool list, so a current-events query
  // answers in ONE grounded call (no synthesis pass to re-emit a tool request from).
  const m = makeIO(['{"type":"response","voice":"Balogun starts up top"}']); // default gemini
  const turn = await runOrchestration(deps({ text: 'who starts at striker' }), m.io);
  assertEquals(turn.voice, 'Balogun starts up top');
  assertEquals(m.pass1Grounded(), true);                       // grounding ON at pass-1
  assertEquals(m.gatewayCalls(), 1);                           // one call, no second pass
  assert(!m.lastPrompt()?.includes('- web_search:'), 'web_search absent from Gemini tool list');
});

Deno.test('non-Gemini: pass-1 NOT grounded, web_search still offered (Tavily path intact)', async () => {
  const m = makeIO(['{"type":"response","voice":"hi"}'], { model: 'claude-haiku-4-5' });
  await runOrchestration(deps(), m.io);
  assertEquals(m.pass1Grounded(), false);
  assert(m.lastPrompt()?.includes('- web_search:'), 'web_search offered to non-Gemini');
});

Deno.test('Gemini + web search OFF: no grounding, no tool — opt-out fully honored', async () => {
  const m = makeIO(['{"type":"response","voice":"hi"}'], { account: { webSearchEnabled: false } });
  await runOrchestration(deps(), m.io);
  assertEquals(m.pass1Grounded(), false);
  assert(!m.lastPrompt()?.includes('- web_search:'), 'no web_search tool when disabled');
});

Deno.test('pass2 re-emits a tool request → clarification, never the raw JSON (FB34)', async () => {
  // Seen on-device 2026-07-06: grounded Gemini answered the web-search synthesis pass with
  // ANOTHER fenced info_request/web_search; the turn finalized as info_request with no
  // text/voice and the client displayed the raw JSON. Pass-2 must be terminal.
  const toolReq = '```json { "type": "info_request", "tool": "web_search", "query": "US national soccer team starting striker", "processing_message": "Hang loose!" } ```';
  const m = makeIO([toolReq, toolReq]); // pass1 AND pass2 both emit the tool request
  const turn = await runOrchestration(deps(), m.io);
  assertEquals(turn.type, 'response');
  assert(turn.voice && !turn.voice.includes('{'), 'voice is prose, not JSON');
  assertEquals(m.gatewayCalls(), 2);   // no third pass — we clarify, we don't loop
});

Deno.test('pass2 unparsable JSON-ish → clarification, never the raw payload (FB34)', async () => {
  const m = makeIO([
    '{"type":"info_request","tool":"web_search","query":"weather"}',
    '```json {"type":"respo', // truncated inside a string, nothing balanced → unrepairable
  ]);
  const turn = await runOrchestration(deps(), m.io);
  assertEquals(turn.type, 'response');
  assert(turn.voice && !turn.voice.includes('{'), 'voice is prose, not JSON');
});

Deno.test('home_assistant WITH provided entities → two passes, action returned', async () => {
  const m = makeIO([
    '{"type":"info_request","tool":"home_assistant","query":{"command_hint":"lights"}}',
    '{"type":"action","voice":"on","action":{"category":"homeassistant","command":"execute_commands","parameters":{"commands":[]}}}',
  ]);
  const turn = await runOrchestration(deps({ provided_context: { ha_entities: [{ entity_id: 'light.k', domain: 'light' }] } }), m.io);
  assertEquals(turn.type, 'action');
  assertEquals(m.gatewayCalls(), 2);
  assertEquals(turn.stages.map((s) => s.name), ['pass1', 'pass2']);
});

Deno.test('sports → single pass (templated), self-fulfilled, route=sports', async () => {
  // pass-1 classifies; the answer is TEMPLATED from the gateway games[] (no pass-2 LLM).
  const m = makeIO([
    '{"type":"info_request","tool":"sports","query":{"sport":"soccer","league":"world-cup","team":"Mexico","type":"score"}}',
  ]);
  const turn = await runOrchestration(deps({ text: 'what was the score of the mexico game' }), m.io);
  assertEquals(turn.route, 'sports');
  assertEquals(turn.voice, 'Mexico beat South Korea 1 to 0.');
  assertEquals((turn.structured_data as { type: string })?.type, 'sports');
  assertEquals(turn.stages.map((s) => s.name), ['pass1', 'fetch_sports']);
  assertEquals(m.gatewayCalls(), 1); // single LLM pass
});

Deno.test('sports DETAIL ask → LLM synthesis (pass-2) WITH the score card (2026-07-28)', async () => {
  // "give me a summary" wants scorers/plays, so the RICH synthesis voices it — but the card
  // rides along anyway. Supersedes DLG-2's "no card on the synthesis pass": a model-voiced
  // sports answer with a blank card slot read as "the tool never ran" on the dashboard
  // (field 2026-07-28, Cowboy-voiced Yankees recap with no scorecard). A follow-up may
  // re-show the same card — accepted tradeoff.
  const m = makeIO([
    '{"type":"info_request","tool":"sports","query":{"sport":"soccer","league":"world-cup","team":"Mexico","type":"score"}}',
    '{"type":"response","voice":"Mexico won 1-0.","text":"Martín scored in the 23rd minute."}',
  ]);
  const turn = await runOrchestration(deps({ text: 'give me a detailed summary of the mexico game' }), m.io);
  assertEquals(turn.route, 'sports');
  assertEquals(turn.voice, 'Mexico won 1-0.');
  assertEquals((turn.structured_data as { type: string })?.type, 'sports');  // card rides the synthesis
  assertEquals(turn.stages.map((s) => s.name), ['pass1', 'fetch_sports', 'pass2']);
  assertEquals(m.gatewayCalls(), 2);                              // pass-1 + synthesis
});

Deno.test('sports GLANCE ask still templates with a card (DLG-2 negative)', async () => {
  const m = makeIO([
    '{"type":"info_request","tool":"sports","query":{"sport":"soccer","league":"world-cup","team":"Mexico","type":"score"}}',
  ]);
  const turn = await runOrchestration(deps({ text: 'whats the score of the mexico game' }), m.io);
  assertEquals((turn.structured_data as { type: string })?.type, 'sports');  // card present
  assertEquals(m.gatewayCalls(), 1);                              // no synthesis pass
});

Deno.test('prefetched sports answered directly on pass-1 → card shows the kickoff time (tz plumbed)', async () => {
  // Field bug 2026-07-16: "when is Spain playing" showed "Sun, Jul 19" with NO time while
  // "next Argentina game" (same fixture, fetched via the sports TOOL) showed "…, 2:00 PM".
  // Root cause: the pass-1 DIRECT path (prefetched sports voiced by the model) built the card
  // via templateSports WITHOUT the user's tz, so clockTime() returned '' → no kickoff time.
  // The axis was direct-vs-tool, not which team was named. This pins the tz onto the card.
  const PREFETCHED = {
    provider: 'espn',
    query: { team: 'Spain', league: 'world-cup', when: 'next' },
    games: [{
      league: 'FIFA World Cup', home: 'Spain', away: 'Argentina',
      homeScore: null, awayScore: null, status: 'Scheduled', state: 'pre',
      startTime: '2026-07-19T19:00Z',
    }],
    result_count: 1, latency: 1,
  };
  const m = makeIO(['{"type":"response","voice":"Spain play Argentina on Sunday."}']);
  const turn = await runOrchestration(
    deps({ text: 'when is Spain playing', timezone: 'America/Chicago', provided_context: { sports: PREFETCHED } }),
    m.io,
  );
  assertEquals((turn.structured_data as { type: string })?.type, 'sports');
  const detail = (turn.structured_data as { detail?: string })?.detail ?? '';
  // 19:00Z = 2:00 PM in America/Chicago (CDT). Assert a clock time is present — the whole bug.
  assert(/\d{1,2}:\d{2}\s?(AM|PM)/.test(detail), `card detail should carry a kickoff time, got: "${detail}"`);
  assertEquals(m.gatewayCalls(), 1); // direct — no tool fetch, no pass-2
});

Deno.test('sports slate (teamless): legacy type stripped, date promoted to when:date, tz forwarded', async () => {
  // The Jul-5 bug: `type:"schedule"` survived the teamless-slate guard, derived when=next
  // in the gateway (effectiveWhen), and collapsed "what games are on tonight" to a single
  // game from the NEXT (UTC) day — "There is 1 World Cup game today: Spain vs Portugal".
  const SLATE_GAMES = [
    { league: 'fifa.world', home: 'France', away: 'Spain', homeScore: null, awayScore: null, status: 'Scheduled', state: 'pre', startTime: '2026-07-14T19:00Z' },
    { league: 'fifa.world', home: 'England', away: 'Argentina', homeScore: null, awayScore: null, status: 'Scheduled', state: 'pre', startTime: '2026-07-15T19:00Z' },
  ];
  const m = makeIO([
    '{"type":"info_request","tool":"sports","query":{"sport":"soccer","league":"world-cup","type":"schedule","date":"2026-07-05"}}',
  ], { sportsGames: SLATE_GAMES });
  const turn = await runOrchestration(deps({ text: 'what time is the world cup game tonight', timezone: 'America/New_York' }), m.io);
  assertEquals(turn.route, 'sports');
  const q = m.lastSportsQuery()!;
  assertEquals(q.type, undefined);           // collapsing legacy intent stripped
  assertEquals(q.when, 'date');              // explicit day still bounds the slate
  assertEquals(q.date, '2026-07-05');
  assertEquals(q.tz, 'America/New_York');    // user zone → user-day windows in the gateway
  // Teamless → the slate template (games[] card), not the single-game card.
  assert(Array.isArray((turn.structured_data as { games?: unknown[] })?.games));
});

Deno.test('sports slate: list:true keeps when:next (future slate fetches the window, not just today)', async () => {
  // The Jul-12 bug: a plural "next World Cup games" ask dropped `when`, so the gateway
  // fetched only today (empty for a league idle today) and collapsed to 1. list:true must
  // KEEP when:next so the upcoming window is fetched AND stay a slate (not a single card).
  const SLATE_GAMES = [
    { league: 'fifa.world', home: 'France', away: 'Spain', homeScore: null, awayScore: null, status: 'Scheduled', state: 'pre', startTime: '2026-07-14T19:00Z' },
    { league: 'fifa.world', home: 'England', away: 'Argentina', homeScore: null, awayScore: null, status: 'Scheduled', state: 'pre', startTime: '2026-07-15T19:00Z' },
  ];
  const m = makeIO([
    '{"type":"info_request","tool":"sports","query":{"sport":"soccer","league":"world-cup","type":"schedule","list":true}}',
  ], { sportsGames: SLATE_GAMES });
  const turn = await runOrchestration(deps({ text: 'when are the next world cup games', timezone: 'America/New_York' }), m.io);
  assertEquals(turn.route, 'sports');
  const q = m.lastSportsQuery()!;
  assertEquals(q.list, true);                // slate signal preserved to the gateway
  assertEquals(q.when, 'next');              // legacy type:schedule → when:next, KEPT (not dropped)
  assertEquals(q.type, undefined);
  assert(Array.isArray((turn.structured_data as { games?: unknown[] })?.games)); // slate card, not single
});

Deno.test('sports single: teamless "the next game" (no list) → single card, when:next kept', async () => {
  const m = makeIO([
    '{"type":"info_request","tool":"sports","query":{"sport":"soccer","league":"world-cup","type":"schedule"}}',
  ]);
  const turn = await runOrchestration(deps({ text: 'when is the next world cup game', timezone: 'America/New_York' }), m.io);
  const q = m.lastSportsQuery()!;
  assertEquals(q.when, 'next');              // upcoming window so templateSports cards it with venue
  assertEquals(q.list, undefined);           // NOT a slate — one game
});

Deno.test('device-fulfilled tool with no voice → empty Turn.voice, NOT the raw JSON (field bug 2026-07-17)', async () => {
  // Mio: "play jazz and dim the lights" → a music info_request with no `voice` field (a tool call
  // carries no spoken answer — the device speaks its own "Playing X"). finalize's `|| raw.content`
  // salvage then read the whole {"type":"info_request",...} blob aloud AND painted it on screen.
  const rawJson = '{"type":"info_request","tool":"music","query":{"action":"play","query":"jazz"},"processing_message":"Playing jazz."}';
  const m = makeIO([rawJson]);
  const turn = await runOrchestration(deps({ text: 'play some jazz' }), m.io);
  assertEquals(turn.type, 'info_request');
  assertEquals(turn.client_tool?.tool, 'music');
  assertEquals(turn.voice, '');                 // ← the fix: empty, never the JSON
  assert(!turn.voice.includes('info_request')); // guard the exact regression
});

Deno.test('calendar_events → client_tool (device-fulfilled), one pass, no pass2', async () => {
  const m = makeIO(['{"type":"info_request","tool":"calendar_events","query":{"timeframe":"today","member_name":"Charlie"}}']);
  const turn = await runOrchestration(deps(), m.io);
  assertEquals(turn.route, 'calendar_events');
  assertEquals(turn.client_tool?.tool, 'calendar');
  assertEquals((turn.client_tool?.query as Record<string, unknown>)?.member_name, 'Charlie');
  assertEquals(turn.stages.map((s) => s.name), ['pass1']); // no pass2 — device fulfills
  assertEquals(m.gatewayCalls(), 1);                       // single LLM pass
  assertEquals(turn.unsupported_tool, undefined);
  // WS-F.0a: a device-fulfilled turn is a SUCCESSFUL answer, not a miss — the row must be
  // miss=false (in the denominator), NOT miss=null. Marking it null would exclude common
  // calendar/weather turns and inflate the miss rate. It carries route (via turnMeta) → answer row.
  const log = m.logs.at(-1)!;
  assertEquals(log.miss, false);
  assertEquals(log.miss_reason, null);
});

Deno.test('calendar_events needs no provided_context (events live on the device)', async () => {
  const m = makeIO(['{"type":"info_request","tool":"calendar_events","query":{}}']);
  const turn = await runOrchestration(deps(), m.io); // no provided_context.calendar
  assertEquals(turn.client_tool?.tool, 'calendar');
  assertEquals(turn.unsupported_tool, undefined);
});

Deno.test('calendar_events on a non-claiming caller (kiosk) → server-fulfilled decline, no client_tool', async () => {
  // 2026-07-21: a caller whose client_fulfilled_tools omits 'calendar' is now OFFERED calendar and
  // routes to it; the orchestrator speaks a graceful "not set up on this device" instead of handing
  // back a client_tool the kiosk would drop. Supersedes the 2026-07-19 offering-drop (which made the
  // model substitute the nearest tool — 0/2 declined, bench 2026-07-20).
  const m = makeIO(['{"type":"info_request","tool":"calendar_events","query":{"timeframe":"tomorrow"}}']);
  const turn = await runOrchestration(deps({ client_fulfilled_tools: ['music', 'video_feeds'] }), m.io);
  assertEquals(turn.type, 'response');
  assertEquals(turn.route, 'calendar_events');       // it DID route to calendar (reliable) …
  assertEquals(turn.client_tool, undefined);          // … but the brain answered, no device hand-off
  assert(turn.voice.toLowerCase().includes('calendar'), 'the decline names the calendar');
  assert(!/couldn't work out|remind|junk food/i.test(turn.voice), 'not a substitute-tool answer');
  assertEquals(turn.stages.map((s) => s.name), ['pass1']); // no pass2
  assertEquals(m.gatewayCalls(), 1);
});

Deno.test('calendar_events with an explicit calendar claim → client_tool (full mode, unchanged)', async () => {
  const m = makeIO(['{"type":"info_request","tool":"calendar_events","query":{"timeframe":"today"}}']);
  const turn = await runOrchestration(deps({ client_fulfilled_tools: ['calendar', 'weather'] }), m.io);
  assertEquals(turn.client_tool?.tool, 'calendar');   // claiming caller still gets the device hand-off
  assertEquals(turn.route, 'calendar_events');
});

// ── Pre-fetched calendar window (calendar-color plan 20260711) ──────────────────────

const CAL_CTX = {
  time_range: 'tomorrow',
  events: [{ date: '2026-07-12', time: '4:00 PM', title: 'Soccer practice', assigned_to: 'Charles' }],
  members: [{ name: 'Charles', nickname: 'Charlie', role: 'child' }],
};

Deno.test('provided calendar → pass-1 digests directly: flag + route + window-only trace', async () => {
  const m = makeIO(['{"type":"response","voice":"Just one thing tomorrow — Charlie has soccer practice at 4."}']);
  const turn = await runOrchestration(deps({ provided_context: { calendar: CAL_CTX } }), m.io);
  assertEquals(turn.type, 'response');
  assertEquals(m.gatewayCalls(), 1);                              // single pass, no tool round-trip
  assertEquals(turn.route, 'calendar');
  assertEquals(turn.metadata?.calendar_context_used, true);       // device renders its held card
  assertEquals(turn.client_tool, undefined);
  // The prompt carried the window, the events, AND the roster (nickname attribution).
  assert(m.lastPrompt()!.includes('Pre-fetched Calendar Data'));
  assert(m.lastPrompt()!.includes('Soccer practice'));
  assert(m.lastPrompt()!.includes('Charlie'));
  // The trace is content-free: route + the exclusion-marker tool + the window label only.
  const log = m.logs[0] as Record<string, unknown>;
  assertEquals(log.tool_used, 'calendar_context');
  const trace = log.tool_trace as { route: string; tool: string; args: Record<string, unknown> };
  assertEquals(trace.route, 'calendar');
  assertEquals(trace.tool, 'calendar_context');
  assertEquals(trace.args, { time_range: 'tomorrow' });           // no event content in the trace
  assertEquals(JSON.stringify(trace).includes('Soccer'), false);
});

Deno.test('provided calendar but uncovered window → tool fallback (client_tool), no flag', async () => {
  const m = makeIO(['{"type":"info_request","tool":"calendar_events","query":{"time_range":"next_30_days"}}']);
  const turn = await runOrchestration(deps({ provided_context: { calendar: CAL_CTX } }), m.io);
  assertEquals(turn.client_tool?.tool, 'calendar');               // today's path, unchanged
  assertEquals(turn.metadata?.calendar_context_used, undefined);
  assertEquals((turn.client_tool?.query as Record<string, unknown>)?.time_range, 'next_30_days');
});

Deno.test('no provided calendar → prompt has no calendar block, direct turn keeps route=direct', async () => {
  const m = makeIO(['{"type":"response","voice":"hi"}']);
  const turn = await runOrchestration(deps(), m.io);
  assertEquals(m.lastPrompt()!.includes('Pre-fetched Calendar Data'), false);
  assertEquals(turn.route, 'direct');
  assertEquals(turn.metadata?.calendar_context_used, undefined);
});

Deno.test('weather_data → client_tool (device-fulfilled), one pass, no pass2', async () => {
  // Weather is served on-device by the native WeatherDataProvider (HA/Open-Meteo toggle),
  // so the brain only extracts the query and hands it back — like calendar. Route stays
  // 'weather_data' (the pass-1 decision); the device fetches + speaks.
  const m = makeIO(['{"type":"info_request","tool":"weather_data","query":{"timeframe":"weekend"}}']);
  const turn = await runOrchestration(deps({ text: "what's the weather this weekend" }), m.io);
  assertEquals(turn.route, 'weather_data');
  assertEquals(turn.client_tool?.tool, 'weather');
  assertEquals((turn.client_tool?.query as Record<string, unknown>)?.timeframe, 'weekend');
  assertEquals(turn.stages.map((s) => s.name), ['pass1']); // no pass2 — device fulfills
  assertEquals(m.gatewayCalls(), 1);                       // single LLM pass
  assertEquals(turn.unsupported_tool, undefined);
});

const calWriteReq = '{"type":"info_request","tool":"calendar_write","query":{"action":"create","title":"Dentist","date":"2026-07-15","start_time":"15:00"}}';

Deno.test('calendar_write + declared capability → client_tool, one pass', async () => {
  // The write tool INVERTS absent-means-fulfilled: only a caller that EXPLICITLY lists
  // 'calendar_write' gets the client_tool (20260713_VOICE_CALENDAR_CRUD_DESIGN.md §2.4).
  // Requires the household voice-write policy ON (calendar.writeAccess ∈ voice|both).
  const m = makeIO([calWriteReq], { account: { calendarWriteAccess: 'both' } });
  const turn = await runOrchestration(
    deps({ text: 'add dentist tuesday at 3', client_fulfilled_tools: ['calendar', 'weather', 'calendar_write'] }), m.io);
  assertEquals(turn.client_tool?.tool, 'calendar_write');
  assertEquals((turn.client_tool?.query as Record<string, unknown>)?.action, 'create');
  assertEquals(turn.stages.map((s) => s.name), ['pass1']); // device fulfills, no pass2
  assertEquals(m.gatewayCalls(), 1);
  assertEquals(turn.unsupported_tool, undefined);
});

Deno.test('calendar_write + NO capability list (old APK) → graceful spoken decline, no client_tool', async () => {
  // An old client never sends the list; an unhandled client_tool there would reproduce
  // the FB13 raw-JSON-leak class — the brain must decline in plain speech instead.
  // Voice-write policy ON so this exercises the CAPABILITY decline, not the policy one.
  const m = makeIO([calWriteReq], { account: { calendarWriteAccess: 'both' } });
  const turn = await runOrchestration(deps({ text: 'add dentist tuesday at 3' }), m.io);
  assertEquals(turn.type, 'response');
  assertEquals(turn.client_tool, undefined);
  assertEquals(turn.unsupported_tool, undefined);
  assert(turn.voice.includes("can't make calendar changes"), turn.voice);
  assertEquals(m.gatewayCalls(), 1);
});

Deno.test('calendar_write + list present but tool NOT declared (headless gateway) → same decline', async () => {
  const m = makeIO([calWriteReq], { account: { calendarWriteAccess: 'both' } });
  const turn = await runOrchestration(deps({ text: 'add dentist tuesday at 3', client_fulfilled_tools: [] }), m.io);
  assertEquals(turn.client_tool, undefined);
  assert(turn.voice.includes("can't make calendar changes"), turn.voice);
});

// ── calendar.writeAccess VOICE gate (household policy over the family calendar) ──
Deno.test('calendar_write + writeAccess UNSET (default touch = voice off) → policy decline, calendar_write NOT offered', async () => {
  // No account setting → the 'touch' default → voice writes off. Even a fully-capable client is
  // declined at the household-policy layer BEFORE the capability check, and calendar_write is
  // dropped from the offered tools list so the model shouldn't route here in the first place.
  const m = makeIO([calWriteReq]);
  const turn = await runOrchestration(
    deps({ text: 'add dentist tuesday at 3', client_fulfilled_tools: ['calendar', 'calendar_write'] }), m.io);
  assertEquals(turn.type, 'response');
  assertEquals(turn.client_tool, undefined);
  assert(turn.voice.includes('turned off'), turn.voice);
  const caps = (m.logs.at(-1)!.tool_trace as { caps?: { tools?: string[] } })?.caps;
  assert(!caps?.tools?.includes('calendar_write'), `calendar_write should be dropped: ${caps?.tools}`);
});

Deno.test("calendar_write + writeAccess 'touch' → policy decline (touch allows manual, not voice)", async () => {
  const m = makeIO([calWriteReq], { account: { calendarWriteAccess: 'touch' } });
  const turn = await runOrchestration(
    deps({ text: 'add dentist tuesday at 3', client_fulfilled_tools: ['calendar_write'] }), m.io);
  assert(turn.voice.includes('turned off'), turn.voice);
  assertEquals(turn.client_tool, undefined);
});

Deno.test("calendar_write + writeAccess 'voice' + declared → client_tool (opted in)", async () => {
  const m = makeIO([calWriteReq], { account: { calendarWriteAccess: 'voice' } });
  const turn = await runOrchestration(
    deps({ text: 'add dentist tuesday at 3', client_fulfilled_tools: ['calendar_write'] }), m.io);
  assertEquals(turn.client_tool?.tool, 'calendar_write');
  const caps = (m.logs.at(-1)!.tool_trace as { caps?: { tools?: string[] } })?.caps;
  assert(caps?.tools?.includes('calendar_write'), `calendar_write should be offered: ${caps?.tools}`);
});

const WEATHER: WeatherResult = {
  provider: 'open-meteo',
  location: { city: 'Naperville', state: 'IL', latitude: 41.75, longitude: -88.15 },
  current: { temperature: 72, weatherCode: 2, description: 'Partly cloudy', windSpeed: 6 },
  daily: [
    { date: '2026-07-04', dayName: 'Saturday', high: 78, low: 60, weatherCode: 0, description: 'Clear sky', precipProbability: 5 },
    { date: '2026-07-05', dayName: 'Sunday', high: 71, low: 58, weatherCode: 61, description: 'Slight rain', precipProbability: 60 },
  ],
  latency: 12,
};
const weatherReq = '{"type":"info_request","tool":"weather_data","query":{"timeframe":"weekend"}}';

Deno.test('weather_data + headless caller → server-fulfilled response turn (no client_tool)', async () => {
  // A caller that omits 'weather' from client_fulfilled_tools (the headless HA gateway) can't
  // run the on-device tool, so the brain self-fulfills via getWeather + weather-synth and
  // speaks the SAME phrasing the device would. Location comes from the account ZIP.
  const m = makeIO([weatherReq], { weather: WEATHER, account: { zipCode: '60540' } });
  const turn = await runOrchestration(deps({ text: "what's the weather this weekend", client_fulfilled_tools: [] }), m.io);
  assertEquals(turn.type, 'response');
  assertEquals(turn.client_tool, undefined);            // NOT handed back to the caller
  assertEquals(turn.unsupported_tool, undefined);       // NOT a dead-end
  assertEquals(turn.voice, 'This weekend: Saturday sunny, high 78; Sunday rainy, high 71, 60% chance of rain.');
  assertEquals(turn.stages.map((s) => s.name), ['pass1', 'fetch_weather']);
  assertEquals(m.gatewayCalls(), 1);                    // single LLM pass, no synthesis pass
});

Deno.test('weather_data + logged-in caller (no capability list) → client_tool, unchanged', async () => {
  // Absent client_fulfilled_tools → the tablet fulfills weather locally; server stays hands-off
  // even though getWeather is available (device-source parity preserved).
  const m = makeIO([weatherReq], { weather: WEATHER, account: { zipCode: '60540' } });
  const turn = await runOrchestration(deps({ text: "what's the weather this weekend" }), m.io);
  assertEquals(turn.client_tool?.tool, 'weather');
  assertEquals(turn.stages.map((s) => s.name), ['pass1']);
});

Deno.test('weather_data + headless caller, no location known → graceful spoken prompt', async () => {
  const m = makeIO([weatherReq], { weather: WEATHER }); // no account ZIP, query has no location
  const turn = await runOrchestration(deps({ text: 'weather this weekend', client_fulfilled_tools: [] }), m.io);
  assertEquals(turn.type, 'response');
  assert(turn.voice.includes('zip code'), turn.voice);
  assertEquals(turn.client_tool, undefined);
});

Deno.test('weather_data + headless caller, getWeather throws → friendly apology', async () => {
  const m = makeIO([weatherReq], { weather: 'throw', account: { zipCode: '60540' } });
  const turn = await runOrchestration(deps({ text: 'weather this weekend', client_fulfilled_tools: [] }), m.io);
  assertEquals(turn.voice, "I couldn't get the weather right now.");
  assertEquals(turn.stages.find((s) => s.name === 'fetch_weather')?.error, 'geocode failed');
});

Deno.test('home_assistant WITHOUT entities → unsupported, one pass', async () => {
  const m = makeIO(['{"type":"info_request","tool":"home_assistant","query":{}}']);
  const turn = await runOrchestration(deps(), m.io);
  assertEquals(turn.unsupported_tool, 'home_assistant');
  assertEquals(m.gatewayCalls(), 1);
});

Deno.test('unsupported tool → flagged', async () => {
  const m = makeIO(['{"type":"info_request","tool":"travel_time","query":{}}']);
  const turn = await runOrchestration(deps(), m.io);
  assertEquals(turn.unsupported_tool, 'travel_time');
});

Deno.test('noise transcript → short-circuit, no AI call, but a countable miss marker (WS-F.0a)', async () => {
  const m = makeIO(['{"type":"response","voice":"should not run"}']);
  const turn = await runOrchestration(deps({ text: '...?!' }), m.io);
  assertEquals(turn.type, 'response');
  assert(turn.voice.includes("didn't catch"), 'speaks didnt-catch');
  assertEquals(m.gatewayCalls(), 0); // still no AI spend
  // Now logs ONE marker row so the ambient/false-wake miss class is countable — but it
  // carries no tokens (→ no deduction), no transcript, and is flagged miss/noise.
  assertEquals(m.logs.length, 1);
  const log = m.logs.at(-1)!;
  assertEquals(log.miss, true);
  assertEquals(log.miss_reason, 'noise');
  assertEquals(log.model, '');                 // no model → the deduction path skips it
  assertEquals(log.input_tokens, 0);
  assertEquals(log.output_tokens, 0);
  assertEquals(log.prompt_text ?? null, null); // noise never carries transcript
  assertEquals(turn.stages.map((s) => s.name), ['noise_shortcircuit']);
});

// ── Unified dialog policy (20260707): metadata.miss / metadata.end_conversation ────────────

Deno.test('dialog policy: end-intent ("shut up") → end_conversation, no AI call', async () => {
  const m = makeIO(['{"type":"response","voice":"should not run"}']);
  const turn = await runOrchestration(deps({ text: 'shut up' }), m.io);
  assertEquals(turn.route, 'end_intent');
  assertEquals(turn.metadata?.end_conversation, true);
  assertEquals(turn.voice, '');            // silent close — nothing spoken/re-heard
  assertEquals(m.gatewayCalls(), 0);       // no AI spend
  assertEquals(m.logs.length, 0);
});

Deno.test('dialog policy: first-turn noise → miss + end_conversation (likely false trigger)', async () => {
  const m = makeIO(['{"type":"response","voice":"should not run"}']);
  const turn = await runOrchestration(deps({ text: '...?!' }), m.io);  // no history → first turn
  assertEquals(turn.metadata?.miss, true);
  assertEquals(turn.metadata?.end_conversation, true);
});

Deno.test('dialog policy: model returns the noise line, first turn → miss + end_conversation', async () => {
  const m = makeIO(['{"type":"response","voice":"Sorry, I didn\'t catch that."}']);
  const turn = await runOrchestration(deps({ text: 'garbled background chatter here' }), m.io);
  assertEquals(turn.metadata?.miss, true);
  assertEquals(turn.metadata?.end_conversation, true);
});

Deno.test('dialog policy: a miss MID-conversation (has history) → miss, but NOT end_conversation', async () => {
  const m = makeIO(['{"type":"response","voice":"Sorry, I didn\'t catch that."}']);
  const turn = await runOrchestration(
    deps({ text: 'mumble', history: [{ role: 'user', text: 'what\'s the weather' }, { role: 'assistant', text: 'Sunny.' }] }),
    m.io,
  );
  assertEquals(turn.metadata?.miss, true);
  assertEquals(turn.metadata?.end_conversation, undefined);  // don't kill a real conversation on one mishear
  // WS-F.0a: the PERSISTED answer row also carries miss/no_intent (not just the client metadata stamp).
  const log = m.logs.at(-1)!;
  assertEquals(log.miss, true);
  assertEquals(log.miss_reason, 'no_intent');
  assertEquals(log.endpoint_id, 'kiosk-1'); // device attribution flows to the row (→ device_id)
});

Deno.test('dialog policy: a real answer is NOT tagged a miss', async () => {
  const m = makeIO(['{"type":"response","voice":"It is sunny"}']);
  const turn = await runOrchestration(deps({ text: 'what\'s the weather' }), m.io);
  assertEquals(turn.metadata?.miss, undefined);
  assertEquals(turn.metadata?.end_conversation, undefined);
  // The persisted answer row is miss=false (an answer row, in the denominator, not a miss).
  const log = m.logs.at(-1)!;
  assertEquals(log.miss, false);
  assertEquals(log.miss_reason, null);
});

// ── CR1 pre-flight credit gate (build plan §3.5) ───────────────────────────

Deno.test('insufficient credits → terminal, no AI call, no deduction', async () => {
  const m = makeIO(['{"type":"response","voice":"should not run"}'], { spendable: false });
  const turn = await runOrchestration(deps(), m.io);
  assertEquals(turn.type, 'response');
  assertEquals(turn.voice, '');                          // says nothing if caller ignores metadata
  assertEquals(turn.route, 'insufficient_credits');
  assertEquals(turn.metadata?.degraded, 'insufficient_credits');
  assertEquals(m.gatewayCalls(), 0);                     // no AI spend
  assertEquals(m.logs.length, 0);                        // no deduction/logging
  assertEquals(turn.stages.map((s) => s.name), ['insufficient_credits']);
});

Deno.test('spendable → proceeds normally (gate is additive)', async () => {
  const m = makeIO(['{"type":"response","voice":"It is sunny"}'], { spendable: true });
  const turn = await runOrchestration(deps(), m.io);
  assertEquals(turn.voice, 'It is sunny');
  assertEquals(m.gatewayCalls(), 1);
});

// ── CR3 per-account rate-limit backstop (build plan §3.5) ──────────────────

Deno.test('rate limited → terminal, no AI call, retry_after surfaced', async () => {
  const m = makeIO(['{"type":"response","voice":"should not run"}'], { rateLimited: true });
  const turn = await runOrchestration(deps(), m.io);
  assertEquals(turn.type, 'response');
  assertEquals(turn.voice, '');
  assertEquals(turn.route, 'rate_limited');
  assertEquals(turn.metadata?.degraded, 'rate_limited');
  assertEquals(turn.metadata?.retry_after_seconds, 30);
  assertEquals(m.gatewayCalls(), 0); // no AI spend
  assertEquals(m.logs.length, 0);    // no deduction/logging
});

Deno.test('not rate limited → proceeds normally', async () => {
  const m = makeIO(['{"type":"response","voice":"It is sunny"}'], { rateLimited: false });
  const turn = await runOrchestration(deps(), m.io);
  assertEquals(turn.voice, 'It is sunny');
  assertEquals(m.gatewayCalls(), 1);
});

// ── T3: account config resolution (build plan §16.7 item 4) ────────────────

Deno.test('model resolves from the account when the request omits it', async () => {
  const m = makeIO(['{"type":"response","voice":"hi"}'], { account: { model: 'claude-sonnet-5' } });
  await runOrchestration(deps(), m.io);
  assertEquals(m.lastModel(), 'claude-sonnet-5'); // account model reached the gateway
});

Deno.test('request options.model overrides the account model', async () => {
  const m = makeIO(['{"type":"response","voice":"hi"}'], { account: { model: 'claude-sonnet-5' } });
  await runOrchestration(deps({ options: { model: 'gemini-2.5-flash' } }), m.io);
  assertEquals(m.lastModel(), 'gemini-2.5-flash');
});

Deno.test('no account model → falls back to the global default', async () => {
  const m = makeIO(['{"type":"response","voice":"hi"}'], { model: 'gemini-3.1-flash' }); // getDefaultModel fake
  await runOrchestration(deps(), m.io);
  assertEquals(m.lastModel(), 'gemini-3.1-flash');
});

Deno.test('web search ON (default) → mutable-entity query is force-searched', async () => {
  const m = makeIO(['{"type":"response","voice":"searched"}']); // no account → webSearchEnabled null → ON
  const turn = await runOrchestration(deps({ text: 'who is the president' }), m.io);
  assertEquals(turn.route, 'web_search'); // deterministic force-search fired
});

Deno.test('account web search OFF → force-search suppressed, answered directly', async () => {
  const m = makeIO(['{"type":"response","voice":"answering directly"}'], { account: { webSearchEnabled: false } });
  const turn = await runOrchestration(deps({ text: 'who is the president' }), m.io);
  assert(turn.route !== 'web_search', 'force-search suppressed');
  assertEquals(turn.voice, 'answering directly');
  assertEquals(m.gatewayCalls(), 1); // a real pass-1 ran, not the synthetic forced path
});

Deno.test('web search OFF + model routes web_search anyway → NO search, direct pass-2', async () => {
  // Non-Gemini so runWebSearch would normally run; the hard guard must skip it.
  const m = makeIO([
    '{"type":"info_request","tool":"web_search","query":"price of gold"}', // model ignored the directive
    '{"type":"response","voice":"I cannot look that up right now."}',       // pass-2 answers from knowledge
  ], { model: 'claude-sonnet-4-6', account: { webSearchEnabled: false } });
  const turn = await runOrchestration(deps({ text: "what's the price of gold" }), m.io);
  assertEquals(m.searchCalls(), 0);           // NO web search executed
  assertEquals(m.searchLogs.length, 0);       // nothing logged/debited
  assertEquals(m.gatewayCalls(), 2);          // pass1 + direct pass2
  assertEquals(turn.voice, 'I cannot look that up right now.');
  assertEquals(turn.stages.map((s) => s.name), ['pass1', 'web_search_disabled', 'pass2']);
});

Deno.test('non-Latin query is NOT treated as noise', async () => {
  const m = makeIO(['{"type":"response","voice":"答案"}']);
  const turn = await runOrchestration(deps({ text: '今天天气怎么样' }), m.io);
  assertEquals(m.gatewayCalls(), 1); // letters in any script pass through
  assertEquals(turn.voice, '答案');
});

Deno.test('gateway failure → error turn', async () => {
  const m = makeIO([], { gatewayFails: true });
  const turn = await runOrchestration(deps(), m.io);
  assertEquals(turn.ok, false);
  assertEquals(turn.type, 'error');
});

// ── transcript retention (§17) ─────────────────────────────────────────────

Deno.test('retain OFF → no transcript text logged (default)', async () => {
  const m = makeIO(['{"type":"response","voice":"It is sunny"}']);
  await runOrchestration(deps(), m.io);
  assertEquals(m.logs[0].prompt_text, undefined);
  assertEquals(m.logs[0].response_text, undefined);
});

Deno.test('retain ON + server mode → text on terminal log, no caller signal', async () => {
  const m = makeIO(['{"type":"response","voice":"It is sunny"}'], { retain: true });
  const turn = await runOrchestration(deps({ text: 'how is the weather' }), m.io);
  assertEquals(m.logs[0].prompt_text, 'how is the weather');
  assertEquals(m.logs[0].response_text, 'It is sunny');
  assertEquals(turn.metadata?.retain_transcript, undefined); // server-persisted, no caller signal
});

Deno.test('retain ON + caller mode → NO text in Supabase, caller signal set', async () => {
  const m = makeIO(['{"type":"response","voice":"It is sunny"}'], { retain: true });
  const turn = await runOrchestration(deps({ text: 'how is the weather', options: { retain_mode: 'caller' } }), m.io);
  assertEquals(m.logs[0].prompt_text, undefined); // never persisted server-side
  assertEquals(m.logs[0].response_text, undefined);
  assertEquals(turn.metadata?.retain_transcript, true); // caller stores HA-locally
});

Deno.test('retain ON + two passes → text only on terminal (pass2) log', async () => {
  const m = makeIO([
    '{"type":"info_request","tool":"web_search","query":"weather"}',
    '{"type":"response","voice":"It is 78"}',
  ], { retain: true });
  await runOrchestration(deps({ text: 'weather please' }), m.io);
  assertEquals(m.logs.length, 2);
  assertEquals(m.logs[0].prompt_text, undefined);   // pass1 non-terminal
  assertEquals(m.logs[1].prompt_text, 'weather please');
  assertEquals(m.logs[1].response_text, 'It is 78');
});

Deno.test('route reflects the pass-1 decision (benchmark grading key)', async () => {
  assertEquals((await runOrchestration(deps(), makeIO(['{"type":"response","voice":"hi"}']).io)).route, 'direct');
  assertEquals((await runOrchestration(deps(), makeIO(['{"type":"action","voice":"ok","action":{"category":"homeassistant","command":"execute_commands"}}']).io)).route, 'action');
  assertEquals((await runOrchestration(deps(), makeIO(['{"type":"info_request","tool":"web_search","query":"x"}','{"type":"response","voice":"y"}']).io)).route, 'web_search');
  assertEquals((await runOrchestration(deps(), makeIO(['{"type":"info_request","tool":"calendar-events","query":{}}']).io)).route, 'calendar-events');
});

Deno.test('turn echoes conversation_id for transcript→usage join', async () => {
  const m = makeIO(['{"type":"response","voice":"hi"}']);
  const turn = await runOrchestration(deps({ conversation_id: 'sess-123' }), m.io);
  assertEquals(turn.conversation_id, 'sess-123');     // matches ai_interactions.session_id
  assertEquals(m.logs[0].session_id, 'sess-123');
});

Deno.test('retain ON + caller mode + unsupported fall-back → no caller signal', async () => {
  const m = makeIO(['{"type":"info_request","tool":"travel_time","query":{}}'], { retain: true });
  const turn = await runOrchestration(deps({ options: { retain_mode: 'caller' } }), m.io);
  assertEquals(turn.unsupported_tool, 'travel_time');
  assertEquals(turn.metadata?.retain_transcript, undefined); // not a Dashie spoken turn
});

// ── sports grounding guard (2026-07-13): Gemini must not answer a game question from
// native Google grounding — route:direct meant NO scorecard and a Pacific-time answer.

Deno.test('sports ask → grounding OFF on pass-1 (model must call the tool, not Google)', async () => {
  const m = makeIO(['{"type":"info_request","tool":"sports","query":{"league":"world-cup","type":"schedule"}}']);
  await runOrchestration(deps({ text: 'what time is the World Cup game tomorrow' }), m.io);
  assertEquals(m.pass1Grounded(), false);   // the shortcut is taken away
});

Deno.test('non-sports current-events ask → grounding still ON (unchanged)', async () => {
  const m = makeIO(['{"type":"response","voice":"ok"}']);
  await runOrchestration(deps({ text: 'who is the prime minister of canada' }), m.io);
  assertEquals(m.pass1Grounded(), true);
});

Deno.test('looksLikeSportsAsk: fires on games/scores/leagues, not on unrelated asks', () => {
  for (const t of [
    'what time is the World Cup game tomorrow', 'did the Yankees win', "what's the score",
    'who won the Super Bowl', 'what games are on tonight', 'when is the next match',
    'when do the Yankees play', 'what time do they play',   // team name is the only sports noun
  ]) assert(looksLikeSportsAsk(t), `should fire: ${t}`);
  for (const t of [
    'what is the weather tomorrow', 'turn off the lights', 'when is mom home',
    'what is the capital of France',
    'play some music', 'play the next song',   // bare "play" stays music, not sports
  ]) assertEquals(looksLikeSportsAsk(t), false, `should NOT fire: ${t}`);
});

// ── tool-first / web-second + the lone-game detail card (2026-07-13) ──

Deno.test('teamless ask resolving to ONE game → single detail card WITH venue (not a 1-row slate)', async () => {
  const m = makeIO(
    ['{"type":"info_request","tool":"sports","query":{"sport":"soccer","league":"world-cup","type":"schedule"}}'],
    { sportsGames: [{
      league: 'fifa.world', home: 'France', away: 'Spain', homeScore: null, awayScore: null,
      status: 'Scheduled', state: 'pre', venue: 'AT&T Stadium (Arlington, Texas)',
    }] },
  );
  const turn = await runOrchestration(deps({ text: 'what time is the world cup game tomorrow' }), m.io);
  const card = turn.structured_data as { venue?: string; games?: unknown[] };
  assertEquals(card.games, undefined);                                // NOT a slate card
  assertEquals(card.venue, 'AT&T Stadium (Arlington, Texas)');        // the stadium shows
});

Deno.test('sports tool finds NOTHING → second pass runs WITH grounding (tool first, web second)', async () => {
  const m = makeIO([
    '{"type":"info_request","tool":"sports","query":{"team":"Yankees","league":"mlb","type":"schedule"}}',
    '{"type":"response","voice":"They do not play today; their next game is Thursday at 7:10 PM."}',
  ], { sportsGames: [] });
  const turn = await runOrchestration(deps({ text: 'when do the Yankees play' }), m.io);
  assertEquals(m.pass1Grounded(), false);   // pass-1: grounding OFF → the tool got called
  assertEquals(m.grounded(), true);         // pass-2: grounding ON  → the web can answer the miss
  assert(turn.voice.includes('Thursday'));
});

// ── Salvage regression (2026-07-18 incident C, ALL axes) ─────────────────────────────────
// finalize()'s `raw.content` salvage exists ONLY for a turn that FAILED to parse (raw content
// is genuine prose there). For any PARSED turn with an empty `voice`, raw.content IS the JSON
// blob — salvaging it reads the blob aloud (2026-07-17 Mio music info_request; 2026-07-18 the
// set_personality action). These lock the rule per type so it can't re-break one axis at a time.

Deno.test('salvage: PARSED action with voice:null never speaks the JSON blob', async () => {
  const { io } = makeIO([
    '{"type":"action","voice":null,"text":null,"action":{"category":"personality","command":"set_personality","parameters":{"key":"pirate","name":"Pirate"}}}',
  ]);
  const turn = await runOrchestration(deps(), io);
  assertEquals(turn.type, 'action');
  assert(!turn.voice.includes('{'), `voice must never be raw JSON, got: ${turn.voice}`);
  assertEquals(turn.voice, '');
  assertEquals(turn.action?.command, 'set_personality');
});

Deno.test('salvage: PARSED response with voice:null never speaks the JSON blob', async () => {
  const { io } = makeIO([
    '{"type":"response","voice":null,"text":"on-screen only"}',
  ]);
  const turn = await runOrchestration(deps(), io);
  assertEquals(turn.type, 'response');
  assert(!turn.voice.includes('{'), `voice must never be raw JSON, got: ${turn.voice}`);
});

Deno.test('salvage: tool-call turn (info_request → client_tool) carries empty voice, not JSON', async () => {
  // calendar is device-fulfilled → returned as client_tool with no second pass.
  const { io } = makeIO([
    '{"type":"info_request","tool":"calendar_events","query":{"time_range":"today"}}',
  ]);
  const turn = await runOrchestration(deps(), io);
  assert(!String(turn.voice).includes('{'), `voice must never be raw JSON, got: ${turn.voice}`);
});

Deno.test('salvage: UNPARSED prose still salvages (the case the salvage is FOR)', async () => {
  const { io } = makeIO(['Sure — all done!']);
  const turn = await runOrchestration(deps(), io);
  assertEquals(turn.parsed_ok, false);
  assertEquals(turn.voice, 'Sure — all done!');
});

Deno.test('personalities: set_personality action is enriched with the catalog row voice fields (deterministic, not model-echoed)', async () => {
  const { io } = makeIO([
    '{"type":"info_request","tool":"personalities","query":{}}',
    // The model deliberately does NOT include voice fields — enrichment must add them.
    '{"type":"action","voice":"Switching to Princess now.","text":null,"action":{"category":"personality","command":"set_personality","parameters":{"key":"princess","name":"Princess"}}}',
  ]);
  io.listPersonalities = () => Promise.resolve([
    { key: 'dashie', name: 'Dashie', description: null, voice_mode: 'preferred', voice: null, greeting_fallback: null },
    { key: 'princess', name: 'Princess', description: 'royal', voice_mode: 'fixed', voice: 'HANA', greeting_fallback: 'Greetings, my loyal subjects!' },
  ]);
  io.resolveVoiceId = (_s, key) => Promise.resolve(
    key === 'HANA' ? { voiceId: 'Hana', provider: 'inworld' } : { voiceId: null, provider: null });
  const turn = await runOrchestration(deps(), io);
  assertEquals(turn.type, 'action');
  const p = turn.action?.parameters as Record<string, unknown>;
  assertEquals(p.key, 'princess');
  assertEquals(p.voice_mode, 'fixed');
  assertEquals(p.voice_key, 'HANA');
  assertEquals(p.greeting_fallback, 'Greetings, my loyal subjects!');
  // The spoken confirmation is the NEW character's greeting, not the old character
  // narrating the switch (John 2026-07-19) — the client pins the new voice before TTS.
  assertEquals(turn.voice, 'Greetings, my loyal subjects!');
  // …and THIS turn's TTS voice is the NEW personality's (trailing-voice fix): the greeting
  // must not arrive in the previous character's voice.
  assertEquals(turn.voice_id, 'Hana');
  assertEquals(turn.voice_provider, 'inworld');
});

Deno.test('personalities: preferred-voice switch carries voice_mode but no voice_key pin', async () => {
  const { io } = makeIO([
    '{"type":"info_request","tool":"personalities","query":{}}',
    '{"type":"action","voice":"Back to normal.","text":null,"action":{"category":"personality","command":"set_personality","parameters":{"key":"dashie","name":"Dashie"}}}',
  ]);
  io.listPersonalities = () => Promise.resolve([
    { key: 'dashie', name: 'Dashie', description: null, voice_mode: 'preferred', voice: null, greeting_fallback: null },
  ]);
  const turn = await runOrchestration(deps(), io);
  const p = turn.action?.parameters as Record<string, unknown>;
  assertEquals(p.voice_mode, 'preferred');
  assertEquals(p.voice_key, undefined);
});

Deno.test('personalities: DIRECT pass-1 set_personality action is enriched too (2026-07-19 field gap)', async () => {
  // The model frequently routes an explicit "switch to santa" as a terminal pass-1 ACTION
  // (route:'action') — no personalities tool pass. The enrichment must run on this path as
  // well; found on-device when the staging brain shipped the action unenriched.
  const { io } = makeIO([
    '{"type":"action","voice":"Ho ho ho! Switching now!","text":null,"action":{"category":"personality","command":"set_personality","parameters":{"key":"santa","name":"Santa"}}}',
  ]);
  io.listPersonalities = () => Promise.resolve([
    { key: 'dashie', name: 'Dashie', description: null, voice_mode: 'preferred', voice: null, greeting_fallback: null },
    { key: 'santa', name: 'Santa', description: 'jolly', voice_mode: 'fixed', voice: 'SANTA', greeting_fallback: 'Ho ho ho!' },
  ]);
  io.resolveVoiceId = (_s, key) => Promise.resolve(
    key === 'SANTA' ? { voiceId: 'santa-voice-id', provider: 'elevenlabs' } : { voiceId: null, provider: null });
  const turn = await runOrchestration(deps(), io);
  assertEquals(turn.type, 'action');
  const p = turn.action?.parameters as Record<string, unknown>;
  assertEquals(p.key, 'santa');
  assertEquals(p.voice_mode, 'fixed');
  assertEquals(p.voice_key, 'SANTA');
  assertEquals(p.greeting_fallback, 'Ho ho ho!');
  assertEquals(turn.voice, 'Ho ho ho!'); // in-character greeting replaces the narration
  assertEquals(turn.voice_id, 'santa-voice-id'); // trailing-voice fix on the direct path too
});

Deno.test('personalities: direct-path enrichment failure degrades to the unenriched action', async () => {
  const { io } = makeIO([
    '{"type":"action","voice":"Switching!","text":null,"action":{"category":"personality","command":"set_personality","parameters":{"key":"santa","name":"Santa"}}}',
  ]);
  io.listPersonalities = () => Promise.reject(new Error('catalog read failed'));
  const turn = await runOrchestration(deps(), io);
  assertEquals(turn.type, 'action');
  const p = turn.action?.parameters as Record<string, unknown>;
  assertEquals(p.key, 'santa');
  assertEquals(p.voice_mode, undefined); // unenriched, but the turn still lands
});

// ── Honest decline for a known-but-unoffered tool (kiosk calendar, 2026-07-19) ────────────
Deno.test('unoffered-tool decline: malformed JSON naming an UNOFFERED known tool speaks the capability decline, not clarify', async () => {
  // Broken JSON (unterminated string) naming video_feeds — a tool a non-claiming caller is NOT
  // offered (calendar_events used to be the repro here, but it's now offered to everyone and
  // self-fulfills its own decline in the calendar branch — a parse SUCCESS, not this backstop).
  const { io } = makeIO(['{"type":"info_request","tool":"video_feeds","query":{"feed":"po']);
  const turn = await runOrchestration(deps({ client_fulfilled_tools: ['weather', 'schedule_action'] }), io);
  assertEquals(turn.voice, "I can't show cameras on this device.");
});

Deno.test('unoffered-tool decline: same broken JSON with the tool OFFERED still clarifies (a real garble)', async () => {
  const { io } = makeIO(['{"type":"info_request","tool":"video_feeds","query":{"feed":"po']);
  const turn = await runOrchestration(deps({ client_fulfilled_tools: ['video_feeds', 'weather'] }), io);
  assert(turn.voice.startsWith('Sorry'), `expected clarify, got: ${turn.voice}`);
});

Deno.test('unoffered-tool decline: unknown tool name in the blob keeps the clarify', async () => {
  const { io } = makeIO(['{"type":"info_request","tool":"flurbometer","query":{']);
  const turn = await runOrchestration(deps(), io);
  assert(turn.voice.startsWith('Sorry'), `expected clarify, got: ${turn.voice}`);
});
