// types.ts — voice-conversation contract types.
// External contract: build plan §9. Internal design: §12.

/** Request body (§9). Required: text + endpoint_id; account carried by the JWT. */
export interface VoiceRequest {
  text: string;                 // REQUIRED — transcript
  endpoint_id: string;          // REQUIRED — personality resolution + usage attribution
  conversation_id?: string;
  language?: string;            // default "en"
  timezone?: string;            // client IANA zone (e.g. "America/New_York") — used to
                                // format "today" in the prompt; server runs UTC otherwise
                                // (10pm Eastern → next-day "today" without it)
  // When true, the brain streams NDJSON StageEvents as it works, then a final
  // { kind: 'final', turn } line — live progress + per-stage latency. Default
  // false → single JSON Turn (kiosk/bench/HA callers unaffected).
  stream?: boolean;
  // When true, the brain resolves a `response` turn's `image` hint into a
  // {type:'image'} card (enrichment, §3.5) — gated by the client's
  // ai.retrievePicturesEnabled setting. Default off (resolving costs a Serper call).
  retrieve_pictures?: boolean;
  // True when this turn is a SCHEDULED ACTION FIRING, not a person speaking: the device
  // replays a stored prompt back through the pipeline at fire time (WS5-a). The brain
  // must not offer schedule_action on such a turn — a fired action that re-schedules
  // itself compounds on every fire. Provenance the device has always known but never
  // sent; without it the client could only guess after the fact (a 15s window that
  // silently swallowed the USER's own scheduling requests). Old clients omit it →
  // undefined → unchanged behavior.
  announcement?: boolean;
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  // Device-fulfilled tools the CALLER can run locally (e.g. ['calendar','weather']).
  // When the brain routes to a device-fulfilled tool NOT in this list, it self-fulfills
  // server-side where it can (weather → edge Open-Meteo) instead of returning an
  // unfulfillable `client_tool`. ABSENT → caller fulfills every device tool (logged-in
  // tablet; unchanged — device stays the primary, dashboard-source path). The headless HA
  // gateway sends `[]` so "weather this weekend" answers instead of dead-ending as unsupported.
  client_fulfilled_tools?: string[];
  provided_context?: ProvidedContext;
  options?: {
    model?: string;
    web_search?: boolean;
    personality_id?: string;
    // Transcript-retention mode (build plan §17):
    //   'server' (default) — brain persists prompt/response text to Supabase
    //     ai_interactions when the account opted in (logged-in cloud path).
    //   'caller' — brain NEVER persists text; it returns metadata.retain_transcript
    //     so the caller (HA integration) can store the transcript HA-locally.
    retain_mode?: 'server' | 'caller';
    // WS-F.0c bench/debug ONLY: override the sampling temperature of the pass-1 ROUTING call
    // (the shipped config pins it to decide=0). The determinism harness sweeps this across
    // 0.7/0.2/0 against the deployed fn to measure route entropy. Absent → the intent-derived
    // default stands (temp 0 for routing) — no production caller sets it. Additive/nullable.
    route_temperature?: number;
    // Gemini thinkingConfig.thinkingBudget override for the pass-1 ROUTING call only (0 = off;
    // N = capped; a bench can also send a positive value to re-measure). ABSENT → the shipped
    // default of 0 (decode-pass thinking OFF since 20260717) — proven to hold routing/decomposition
    // accuracy 100% across every category while cutting the field compound turn ~15s→~1s. The
    // narrate pass-2 keeps dynamic thinking regardless. Additive/nullable.
    thinking_budget?: number;
  };
}

/** Caller-supplied gathered data — used instead of self-fulfilling (§9 A3). */
export interface ProvidedContext {
  // HA entities are caller-provided (the brain can't reach the add-on); §12 structural note.
  ha_entities?: HaEntity[];
  // The HA area this Dashie device is assigned to (its own device's area in HA's registry), e.g.
  // "Living Room". Lets an unqualified command ("turn off the lights") resolve to THIS room instead
  // of clarifying. Additive/nullable: absent → no room context (unchanged behavior). Room-awareness
  // build 20260715.
  device_area?: string;
  // Pre-fetched calendar window (calendar-color plan 20260711): the device sniffs a
  // calendar-shaped utterance, fetches the window locally (the merged multi-provider
  // truth lives on-device), and attaches it here so pass-1 answers directly with an
  // intelligent digest — single AND multi-event. The family roster rides along so the
  // model attributes events to people naturally ("Charlie's soccer practice").
  // Replaces the never-wired `calendar_events?: unknown[]` field (it had no writers).
  calendar?: ProvidedCalendar;
  // Pre-fetched sports (the sports-gateway result) — when present, pass-1 voices it
  // in personality (the §23.6 reward for pre-fetching); absent → route + template.
  sports?: unknown;
}

/** One compact event in a pre-fetched calendar window. Content flows to the model for
 *  THIS answer only — it is never persisted (prompt_text retention = user utterance only;
 *  the tool_trace for these turns carries {time_range} and no event content). */
export interface ProvidedCalendarEvent {
  date?: string;                  // "YYYY-MM-DD" or a day label ("Saturday")
  time?: string;                  // "3:00 PM"; omit for all-day
  title: string;
  assigned_to?: string | string[]; // family member name(s) whose calendar it's on
  all_day?: boolean;
  location?: string;
}

export interface ProvidedCalendarMember {
  name: string;
  nickname?: string;
  role?: string;                  // e.g. "parent" | "child" — optional color for phrasing
}

/** The pre-fetched window. `time_range` is the device-sniffed label ("today",
 *  "tomorrow", "this week", …) — it bounds BOTH this data and the card the device
 *  shows, so voice and screen can't disagree. */
export interface ProvidedCalendar {
  time_range?: string;
  events: ProvidedCalendarEvent[];
  members?: ProvidedCalendarMember[];
}

export interface HaEntity {
  entity_id: string;
  domain: string;
  friendly_name?: string;
  state?: string;
  // HA area this entity belongs to (directly or via its device), e.g. "Living Room". Enables
  // room-relative resolution ("the lights" → lights whose area == device_area) and same-room
  // disambiguation. Additive/nullable: absent → area-blind (unchanged). Room-awareness build.
  area?: string;
  // User-assigned voice aliases from HA's "Expose to Assist" Aliases column (e.g. "TV",
  // "fairy lights"). Match a spoken name against friendly_name ∪ aliases. Additive/nullable:
  // absent → match on friendly_name only (unchanged). 20260717.
  aliases?: string[];
  [k: string]: unknown;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  // Gemini hidden "thoughts" tokens, summed across passes (0 when thinking is off / non-Gemini).
  // Not part of output_tokens; surfaced so bench/analysis can see decode-pass thinking cost.
  reasoning_tokens?: number;
}

export type ResponseType = 'response' | 'action' | 'info_request' | 'multi' | 'error';

/** One leg of a `multi` turn — a normal per-tool call in the EXISTING vocabulary, so adding
 *  multi changes no per-tool schema. `query` may be absent (orchestrator falls back to the
 *  transcript). Guarantees on a normalized `multi` are in multi.ts's post-condition. */
export interface MultiStep {
  tool: string;
  query?: unknown;
}

/** One RESOLVED leg of a dispatched `multi` turn, carried on Turn.steps for the client to run.
 *  Exactly one of `action` (a server-resolved home_assistant execute_commands) or `client_tool`
 *  (a device-fulfilled music/video_feeds step) is set — unless the step couldn't be fulfilled,
 *  in which case `unsupported_tool` names it (e.g. a home_assistant step with no ha_entities). */
export interface TurnStep {
  tool: string;
  action?: ParsedResponse['action'];
  client_tool?: { tool: string; query?: unknown } | null;
  unsupported_tool?: string;
}

/** Parsed AI JSON (one pass). */
export interface ParsedResponse {
  type: ResponseType;
  voice?: string;
  text?: string | null;
  action?: { category: string; command: string; parameters?: Record<string, unknown> } | null;
  tool?: string;               // present when type === 'info_request'
  query?: unknown;
  steps?: MultiStep[];         // present when type === 'multi'
  [k: string]: unknown;
}

/**
 * Live progress event streamed before the final Turn (only when request.stream).
 * The brain OWNS the human-facing `status` copy per route/tool — the client just
 * displays it. `elapsed_ms` is wall-clock since the turn started and doubles as a
 * per-stage latency signal during development.
 *   - 'routed'       — pass-1 done, route decided (dev timing; no status)
 *   - 'fetching'     — about to run the tool (status = "Searching the web…" etc.)
 *   - 'synthesizing' — about to run the synthesis pass (status = "Finalizing…")
 */
export interface StageEvent {
  stage: 'routed' | 'fetching' | 'synthesizing';
  status?: string;             // display text — present only when the UI should update
  route?: string;
  tool?: string;
  elapsed_ms: number;
}

export interface Stage {
  name: string;                // 'pass1' | 'pass2' | 'fetch_search' | ...
  latency_ms: number;
  model?: string;
  provider?: string;
  usage?: Usage;
  type?: string;
  result_count?: number;
  error?: string;
}

/** Final turn returned to the caller (§9 A2 — superset of console's turn). */
export interface Turn {
  ok: boolean;
  type: ResponseType;
  voice: string;               // the spoken response TEXT (not a voice identity)
  // Resolved TTS voice for THIS turn, derived from the device's personality
  // (personality_templates.voice → tts_voices.provider_voice_id). The client passes it
  // straight to its TTS (e.g. native ElevenLabsTtsClient.speak(voiceId=…)) so voice
  // follows personality (D3). Null → the client's default voice. See personality.ts.
  voice_id?: string | null;
  // Vendor that owns [voice_id] (the resolved voice's tts_voices.provider): 'elevenlabs' |
  // 'inworld'. Native routes cloud TTS to this vendor; absent/null → client default vendor.
  // Additive/nullable (§13.16) — old clients ignore it.
  voice_provider?: string | null;
  text: string | null;
  action: ParsedResponse['action'];
  parsed_ok: boolean;
  raw_content: string;
  usage: Usage;
  model: string;
  provider: string;
  latency_ms: number;          // gateway round-trips, summed across passes
  total_latency_ms: number;    // wall clock incl. fetches
  structured_data?: unknown;   // tablet renders cards/overlays; others ignore
  conversation_id?: string;
  unsupported_tool?: string;
  // Device-fulfilled tool: the brain extracted the query (pass-1) but the data
  // lives on the device (e.g. the merged multi-provider calendar). The client runs
  // the local tool with this query + renders the card — NOT an AIService fallback.
  client_tool?: { tool: string; query?: unknown } | null;
  route?: string;              // pass-1 routing decision: 'direct'|'action'|'multi'|tool name (benchmark grading key)
  // Resolved legs of a `multi` turn (type === 'multi'): each carries a native HA action or a
  // device-fulfilled client_tool. The client runs each step in order and the single top-level
  // `voice` is the one spoken confirmation. Additive/nullable — old consumers ignore it, and it's
  // only ever present when the caller declared the `multi` capability. See multi-dispatch.ts.
  steps?: TurnStep[];
  stages: Stage[];
  metadata?: Record<string, unknown>;
}

export interface PromptContext {
  customPersonalityConfig?: Personality | null;
  // Assistant identity → {{ASSISTANT_NAME}} in the base prompt (Chickadee
  // open-core). Absent/null → 'Dashie' (byte-identical legacy prompt).
  assistantName?: string | null;
  chatHistory?: string;        // formatted "User: …\nYou: …"
  language?: string;
  timezone?: string;           // client IANA zone → formatDateTime() for {{DATE_TIME}}
  providedSports?: unknown;     // §23.6: pre-fetched sports → pass-1 voices it in personality
  providedCalendar?: unknown;   // 20260711: pre-fetched calendar window → pass-1 digests it directly
  webSearchEnabled?: boolean;   // T3: false → omit web_search from the offered tools list
  // true → this turn IS a scheduled action firing: omit schedule_action from the offered
  // tools list so the replay cannot re-schedule itself (see VoiceRequest.announcement).
  announcement?: boolean;
  // false → the prompt appends an image-unavailable instruction (set image:null, never
  // claim to show a picture). The response-format spec unconditionally advertises the
  // image field, so an ungated model said "Here's a picture of Oslo" while the
  // enrichment layer dropped the hint (BYOK add-on brain, 2026-07-13).
  retrievePicturesEnabled?: boolean;
  // `client_fulfilled_tools` from the request — what this caller can actually run locally.
  // Device-only tools (music, video_feeds) it doesn't claim are OMITTED from the offered
  // tools list: a model told about a capability the device lacks will call it, get declined,
  // and burn the turn. Absent → caller fulfills everything (old clients; unchanged).
  clientTools?: string[];
  // Multi-tool emission gate: true → buildPrompt appends the capability-gated `multi` block so
  // pass-1 may emit {type:"multi", steps:[…]} for a compound "do A and B" turn spanning DIFFERENT
  // tools. Derived from `client_fulfilled_tools` containing the `multi` token (orchestrator). Absent
  // → the block is withheld and the model keeps today's single-tool behavior (old clients unaffected).
  multiEnabled?: boolean;
  // Room awareness (20260715): the HA area this device is in ("Living Room"), rendered as
  // {{DEVICE_AREA}} in the home_assistant prompt so an unqualified command resolves to this room.
  // null/absent → area-blind (template falls back to "ask which room").
  deviceArea?: string | null;
  caps?: CapsSnapshot;          // logged into tool_trace.caps, never templated
}

/** Per-turn capability snapshot:
 *  what THIS turn was allowed to do, logged as ai_interactions.tool_trace.caps so a request
 *  blocked by an OFF toggle reads as "disabled" in analysis, not a defect. */
export interface CapsSnapshot {
  web_search: boolean;         // resolved account toggle (webSearchAllowed)
  retrieve_pictures: boolean;  // resolved request/account toggle
  grounding: boolean;          // Gemini native grounding fulfills web search on pass-1
  multi?: boolean;             // caller declared the `multi` capability → multi-emission offered
  tools: string[];             // tool names actually offered to pass-1 (post-filter)
}

export interface Personality {
  id?: string;
  key?: string;
  name?: string;
  base_personality?: string | null;
  personality_overview?: string | null;
  similar_persona?: string | null;
  adjectives?: string[] | null;
  topics?: string[] | null;
  example_phrases?: string[] | null;
  family_notes?: string | null;
  voice?: string | null;
  voice_mode?: string | null;
}
