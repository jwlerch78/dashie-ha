// orchestrator.ts — the two-pass loop.
//
// Ported from console-ai-client.js sendQuery (482–721), _finalize (735–758), _sumUsage (723–732).
// Build plan §12. Adapted for the brain (surface-agnostic):
//   - NO NLP fast-path (caller/surface-specific).
//   - NO HA entity FETCH — entities arrive via provided_context.ha_entities.
//   - NO action dispatch — the brain RETURNS the action; the caller executes it.
//   - Logging/deduction uses the account JWT (per pass), via database-operations.
//
// I/O (gateway call, web search, personality, logging) is injectable so the loop is unit-testable
// without network. runOrchestration(deps) uses the real I/O; tests pass a fake.
//
// ⚠️ DUAL-RUNTIME CORE — this file runs in BOTH Deno (cloud edge fn) and Node (add-on, on-prem L3),
// bundled from the SAME source (no second copy). Keep it pure: NO `Deno.*`, NO `https://` imports,
// NO Supabase imports — runtime coupling lives only in the injectable OrchestratorIO adapters.
// See README "Dual-runtime sync contract" + build plan §13.16. Re-authoring this as a Node copy is
// the forbidden move (recreates the §1 drift).

// ⚠️ DUAL-RUNTIME CORE: value imports below are ALL from pure modules (prompt/parse/models/
// force-search/synthesis/retention) — no Deno.*/https/Supabase. The I/O implementations
// (gateway/gather/personality/logging/config + readRetainTranscripts) are imported TYPE-ONLY
// here and provided at call time via OrchestratorIO. Deno wires them in default-io.ts; the Node
// add-on wires its own. Keep it this way — see README "Dual-runtime sync contract" + §13.16.
import { buildPrompt, offeredToolNames } from './prompt.ts';

// Spoken decline per KNOWN tool a caller wasn't offered (see the clarify-path refinement in
// runOrchestration). Only tools a device can legitimately lack belong here — server tools are
// always offered. Deterministic English v1 (matches the clarify sentinel's precedent).
const KNOWN_DEVICE_TOOL_DECLINES: Record<string, string> = {
  // NB: calendar_events is intentionally NOT here — it's now offered to every caller and its
  // decline is self-fulfilled in the calendar branch (a non-claiming kiosk routes to it and gets
  // "…not set up on this device"). This map is the parse-fail backstop for tools that are DROPPED
  // from the offering (caps.tools), where a blob naming a dropped tool needs a canned decline.
  calendar_write: "I can't make calendar changes on this device.",
  music: "I can't control music on this device.",
  video_feeds: "I can't show cameras on this device.",
  open_app: "I can't open apps on this device.",
};
import { redactToolArgs } from './redact-args.ts';
import { parseContent, isLikelyNoise } from './parse.ts';
import { isEndIntent, classifyMiss, NOISE_REPLY } from './dialog-policy.ts';
import { providerForModel } from './models.ts';
import { detectMutableEntity } from './force-search.ts';
import { templateSports } from './synthesis/sports.ts';
import { templateSlate } from './synthesis/sports.ts';
import { synthesizeImage } from '../_shared/tools/image_search.ts';
// Re-exported for the Node add-on shell: sports is pure keyless fetch (ESPN), so
// node-io binds it straight from the bundle instead of stubbing or an HTTP hop.
export { runSports } from '../_shared/tools/sports.ts';
// Re-exported for the same reason: the add-on's node-io was stubbing personality to null
// (base prompt on EVERY local turn — FB41), so a household's chosen character was silently
// dead on the on-prem brain while the cloud brain applied it. This is the ONE canonical
// resolver (the cloud's default-io.ts wires the same function); node-io now calls it with an
// account-JWT Supabase client instead of hand-copying the device→account→template chain.
export { resolvePersonality } from './personality.ts';
import { listAvailablePersonalities } from './personality.ts';
import type { PersonalityChoice } from './personality.ts';
import { currentTimeTool } from '../_shared/tools/current_time.ts';
import { dashieHelpTool } from '../_shared/tools/dashie-help.ts';
import type { ToolContext } from '../_shared/tools/types.ts';
import { retainFields } from './retention.ts';
import { templateWeather, weatherResultToReading } from './weather-synth.ts';
import type { GatewayResult } from './gateway.ts';
import type { SportsResult, WebSearchResult, WeatherLocation, WeatherResult } from './gather.ts';
import type { LogData, WebSearchLogData, SportsLogData } from './logging.ts';
import type { CapsSnapshot, Personality, Stage, StageEvent, TurnStep, Turn, Usage, VoiceRequest } from './types.ts';
import { dispatchMultiTurn, recoverHaAction } from './multi-dispatch.ts';

export interface OrchestrationDeps {
  req: VoiceRequest;
  userId: string;
  token: string;        // account JWT — used for logging/deduction
  supabase: unknown;    // service-role client for DB reads
  // Live progress sink (streaming callers only). Fires at each stage boundary
  // with brain-owned status copy + elapsed_ms. Undefined for non-streaming callers.
  onStage?: (e: StageEvent) => void;
}

// DLG-2: does the user want a game SUMMARY/recap/analysis (→ the rich LLM synthesis with
// scorers & plays) rather than just the score (→ the fast deterministic template)? Deterministic
// on purpose — more reliable than asking the model to set a flag (cf. detectMutableEntity), and
// safe to keep broad because it's only consulted INSIDE the sports branch (the model already
// decided this is a sports query). A detail turn also emits NO score card, which is what stops
// the duplicate-card-on-follow-up the score card was already shown on the glance turn.
// Scorer-intent ("who scored", "top scorer", "hat trick") routes here too (finding #9, approach
// A): the LLM synthesis voices scorers cross-sport from the events/highlights data, which the
// glance template can't. (Pairs with the INQUIRY_SPORTS prompt fix — see SPORTS.md #9.)
const GAME_DETAIL_RE =
  /\b(summar(?:y|ize|ise)|recap|rundown|breakdown|break it down|highlights?|walk me through|go deeper|analy(?:sis|ze|se)|how did .{0,24}?(?:play|do|look)|what happened|tell me more|tell me about|more about|(?:any |more )?details?|who scored|who (?:got|had) (?:the |a )?goals?|top scorers?|hat[- ]?trick)\b/i;
// Exported for the regex-coverage eval (`game-depth.test.ts`) — the depth decision is
// deterministic and model-independent, so its vocabulary is unit-testable without a model.
export function wantsGameDetail(text: string | undefined): boolean {
  return !!text && GAME_DETAIL_RE.test(text);
}

/**
 * What the TEMPLATE can actually answer: a score, a result, or a fixture (when/where/who's
 * playing). That is the whole of `templateSports` — finalLine / liveLine / scheduledLine.
 *
 * WHY THIS EXISTS (2026-07-16 field bug). The gate used to be "template unless the text matches
 * GAME_DETAIL_RE", i.e. the template was the DEFAULT and caught everything unrecognised. But the
 * template has no "I don't know" branch — given a game, it describes the fixture, whatever it was
 * asked. So a roster question fell through and got the schedule read at it, every time:
 *
 *   "Who's starting at Striker for Spain?"  → "Spain play Argentina, Sun, Jul 19."   (×3, verbatim)
 *
 * The data has no rosters/line-ups/stats/standings, so no wording of the template could have
 * answered it. Inverting the default fixes the CLASS: template only when we recognise a
 * score/schedule ask; anything else goes to the model, which can at least say it doesn't have that.
 *
 * The asymmetry is the argument: a miss toward the MODEL costs one call and still answers
 * correctly (and on a local/BYOK brain costs nothing at all); a miss toward the TEMPLATE hands the
 * user a confidently wrong answer forever. Fail toward the component that can admit ignorance.
 *
 * Deterministic and model-independent → unit-testable with no model (see sports-depth.test.ts,
 * same rationale as game-depth.test.ts).
 */
const SCORE_SCHEDULE_RE = new RegExp(
  '(' +
  // ── SCORE / RESULT ──
  '\\bscores?\\b|\\bwho\\s+won\\b|\\bwho\\s+is\\s+winning\\b|\\bwho\'?s\\s+winning\\b|' +
  '\\bdid\\s+(?:the\\s+)?\\w+(?:\\s+\\w+)?\\s+win\\b|\\bwin\\s+or\\s+lose\\b|\\bfinal\\b|' +
  '\\bresults?\\b|\\bhow\\s+(?:did|are|is)\\s+.{0,24}?\\b(?:do|doing|going)\\b|\\bare\\s+they\\s+winning\\b|' +
  // ── FIXTURE / SCHEDULE ──
  '\\bwhen\\s+(?:is|are|do|does|did)\\b|\\bwhat\\s+time\\b|\\bwhat\\s+day\\b|' +
  '\\bnext\\s+game\\b|\\blast\\s+game\\b|\\bplaying\\s+(?:today|tonight|tomorrow)\\b|' +
  '\\bwho\\s+(?:are|is)\\s+(?:they|.{0,20}?)\\s*play(?:ing)?\\b|\\bwho\\s+do\\s+.{0,20}?\\bplay\\b|' +
  '\\b(?:any|what|which)\\s+.{0,20}?\\b(?:games?|teams?)\\b|\\bgames?\\s+(?:on|today|tonight|tomorrow)\\b|' +
  '\\bis\\s+there\\s+a\\s+game\\b|\\bare\\s+(?:they|the\\s+\\w+)\\s+playing\\b|\\bschedule\\b|\\bkick\\s?off\\b|' +
  '\\bwho\\s+they\\s+play\\b' +
  ')',
  'i',
);

/** True when `templateSports` can genuinely answer this — a score/result/fixture ask. False for
 *  anything else routed to sports (rosters, line-ups, stats, standings, injuries, club history):
 *  those need the model, because the fixture data cannot answer them at all. */
export function templateCanAnswer(text: string | undefined): boolean {
  if (!text) return false;
  return SCORE_SCHEDULE_RE.test(text);
}

/**
 * Is this utterance about a GAME (score, result, fixture, kickoff time)? Used only to turn
 * Gemini's native grounding OFF for the turn, so the model can't answer from Google Search
 * and must route to `get_sports_scores` (which alone carries the scorecard + the user's
 * local times). Safe to keep broad: a game/score/league question belongs to a TOOL — sports,
 * or the family calendar for a bare "the game" (the calendar-first rule) — never to grounding.
 * Exported for the L1 regex-coverage test.
 */
const SPORTS_ASK_RE = new RegExp(
  '\\b(' +
  // named competitions
  'world cup|fifa|nfl|nba|mlb|nhl|wnba|mls|premier league|champions league|la liga|bundesliga|' +
  'serie a|super bowl|world series|stanley cup|march madness|college (?:football|basketball)|' +
  // result / score phrasing
  'score|scores|scored|who won|final score|standings|shut ?out|' +
  // the game itself (schedule/kickoff asks land here)
  'games?|match(?:es|up)?|kick ?off|innings?|semifinals?|quarterfinals?' +
  ')\\b',
  'i',
);
// "did the Yankees win", "did they lose", "did Arsenal beat United" — a result question
// whose only sports noun is the TEAM NAME, which no word list can enumerate.
const SPORTS_RESULT_RE = /\bdid\b[^?]{0,32}\b(win|won|lose|lost|beat)\b/i;
// "when do the Yankees play", "what time do they play" — same problem for the schedule
// side. Anchored on when/what-time + play so it can't swallow "play some music" (no
// when/what-time) — a bare "play X" stays a music/transport intent.
const SPORTS_SCHEDULE_RE = /\b(?:when|what time)\b[^?]{0,32}\bplay(?:s|ing)?\b/i;
export function looksLikeSportsAsk(text: string | undefined): boolean {
  const t = text || '';
  return !!t && (SPORTS_ASK_RE.test(t) || SPORTS_RESULT_RE.test(t) || SPORTS_SCHEDULE_RE.test(t));
}

/** Brain-owned progress copy per tool — the client displays these verbatim. No trailing
 *  "…": the client's thinking indicator is already an animated ellipsis, so the copy would
 *  double it up ("Checking the score……"). */
const TOOL_STATUS: Record<string, string> = {
  web_search: 'Searching the web',
  sports: 'Checking the score',
  home_assistant: 'Asking Home Assistant',
  calendar_events: 'Checking your calendar',
  weather_data: 'Checking the weather',
  // A tool with no entry here falls back to 'Looking that up' — which is actively WRONG for a
  // tool that DOES something rather than looks something up. "turn the lights on in 5 minutes"
  // showed "Looking that up" while it was scheduling (John, 2026-07-13).
  schedule_action: 'Setting that up',
};
/** calendar_write covers create AND update/delete — the status must follow the ACTION
 *  ("Adding that to your calendar" on a delete read as wrong, John 2026-07-13). The
 *  confirm/cancel legs get the neutral copy (the brain doesn't know the pending op). */
const CALENDAR_WRITE_STATUS: Record<string, string> = {
  create: 'Adding that to your calendar',
  update: 'Updating your calendar',
  delete: 'Removing that from your calendar',
};
/** A schedule/upcoming sports ask is "Checking the schedule", not "the score" — decided by
 *  the query's temporal intent (when:next/upcoming or type:schedule, or a list slate). */
function statusForTool(tool: string, query?: unknown): string {
  if (tool === 'sports') {
    const q = (query ?? {}) as Record<string, unknown>;
    const w = String(q.when ?? '').toLowerCase();
    const t = String(q.type ?? '').toLowerCase();
    if (w === 'next' || w === 'upcoming' || t === 'schedule' || q.list === true) return 'Checking the schedule';
  }
  if (tool === 'calendar_write') {
    const a = String(((query ?? {}) as Record<string, unknown>).action ?? '').toLowerCase();
    return CALENDAR_WRITE_STATUS[a] || 'Updating your calendar';
  }
  return TOOL_STATUS[tool] || 'Looking that up';
}

/** Can the CALLER fulfill this device tool locally? Absent list → yes (logged-in tablet;
 *  unchanged — device stays primary). A list that omits the tool → no (headless gateway). */
function callerFulfills(req: VoiceRequest, tool: string): boolean {
  const list = req.client_fulfilled_tools;
  if (!Array.isArray(list)) return true;
  return list.includes(tool);
}

/** Weather location for the server fallback: a user-named place wins ("weather in Boston"),
 *  else the account's home ZIP. null → no location known (graceful spoken prompt upstream). */
function resolveWeatherLocation(query: Record<string, unknown>, zip: string | null): WeatherLocation | null {
  const named = typeof query.location === 'string' ? query.location.trim() : '';
  if (named) return { locationName: named };
  if (zip) return { zip };
  return null;
}

/** Deterministic voice enrichment for a `set_personality` action (VOICE_SINGLE_PATH item 11):
 *  attach the switched-to template's voice fields (`voice_mode`/`voice_key`/`greeting_fallback`)
 *  so native clients apply the switch without a template service. Must run on EVERY path that
 *  can emit the action — the personalities second pass AND a direct pass-1 action (the model
 *  frequently routes an explicit "switch to X" as `type:'action'`; found on-device 2026-07-19
 *  when the direct path shipped the action unenriched). Additive params; no-op when the key
 *  isn't in the catalog.
 *
 *  Returns the matched catalog row so the caller can also swap the spoken confirmation for
 *  the template's IN-CHARACTER greeting (John 2026-07-19): the model narrates the switch in
 *  the OLD personality's style ("Ho ho ho! Switching to Pirate now!"), but the moment worth
 *  hearing is the NEW character introducing itself — and since the client pins the new voice
 *  BEFORE TTS, the greeting speaks in the new voice too. */
function enrichSetPersonalityAction(
  action: { command?: string; parameters?: Record<string, unknown> } | null | undefined,
  choices: PersonalityChoice[],
): PersonalityChoice | null {
  const params = action?.command === 'set_personality' ? action.parameters : null;
  if (!params || typeof params.key !== 'string') return null;
  const row = choices.find((c) => c.key === params.key);
  if (!row) return null;
  if (row.voice_mode != null) params.voice_mode = row.voice_mode;
  if (row.voice != null) params.voice_key = row.voice;
  if (row.greeting_fallback != null) params.greeting_fallback = row.greeting_fallback;
  return row;
}

/** Trailing-voice fix (John 2026-07-19): the turn's TTS voice is resolved once at request
 *  START — while the OLD personality is still active — so a switch confirmation spoke one
 *  personality behind (the princess greeting arrived in the pirate voice). Re-stamp THIS
 *  turn's voiceCtx with the switched-to template's voice (its pinned voice when `fixed`,
 *  its preferred voice otherwise) so the greeting speaks as the NEW character. Later turns
 *  resolve the full WS-G chain normally. Best-effort: a resolve miss keeps the old stamp. */
async function restampVoiceForSwitch(
  io: OrchestratorIO,
  supabase: unknown,
  voiceCtx: OrchestrateCtx,
  row: PersonalityChoice | null,
): Promise<void> {
  const targetKey = row?.voice;
  if (!targetKey || !io.resolveVoiceId) return;
  try {
    const v = await io.resolveVoiceId(supabase, targetKey);
    if (v?.voiceId) {
      voiceCtx.voiceId = v.voiceId;
      voiceCtx.voiceProvider = v.provider;
    }
  } catch (e) {
    console.warn('set_personality voice restamp failed (turn keeps the prior voice):', e);
  }
}

/** Injectable I/O — the runtime's I/O shell. Deno provides `defaultIO` (default-io.ts);
 *  the Node add-on (L3) provides its own; tests pass fakes. Signatures are explicit (not
 *  `typeof` the impls) so the core needs no value import of the Deno modules. */
export interface OrchestratorIO {
  // `kind` selects the sampling temperature by intent (decide=0 | narrate=0.7); see gateway.ts.
  // `temperature`, when set, OVERRIDES that intent default (WS-F.0c bench knob — see the pass-1
  // call site). Both optional so a runtime that doesn't care (or an old mock) still satisfies the type.
  callGateway: (args: { provider: string; prompt: string; modelId: string; grounding?: boolean; kind?: 'decide' | 'narrate'; temperature?: number; thinkingBudget?: number }) => Promise<GatewayResult>;
  // `authToken` (the turn's user JWT) is forwarded to the billable web-search gateway as
  // the caller identity — the gateway rejects bare-anon once enforcement is on. OPTIONAL so
  // a runtime/mock that omits it still satisfies the type (falls back to anon in the impl).
  runWebSearch: (query: string, authToken?: string) => Promise<WebSearchResult>;
  runSports: (query: Record<string, unknown>, authToken?: string) => Promise<SportsResult>;
  // Self-fulfill weather (Open-Meteo + geocode) — ONLY the headless/anon path calls this
  // (a device fulfills weather locally from its dashboard source). OPTIONAL — absent IO
  // (Node add-on shell without it / older tests) → the weather branch falls back to handing
  // the query to the caller via `client_tool`, unchanged. See weather.ts / weather-synth.ts.
  getWeather?: (loc: WeatherLocation) => Promise<WeatherResult>;
  resolvePersonality: (supabase: unknown, userId: string, endpointId: string, explicitId?: string | null) => Promise<Personality | null>;
  // D3 (voice follows personality): resolve the personality's voiceKey → concrete TTS voice id
  // returned in the Turn. OPTIONAL — absent IO (Node shell / older tests) → no voice_id (client
  // default voice, unchanged).
  resolveVoiceId?: (supabase: unknown, voiceKey?: string | null) => Promise<{ voiceId: string | null; provider: string | null }>;
  // WS-G Round B (§13.2): effective voice key = fixed-personality lock → device
  // aiVoice.voiceKey → account ai.defaultVoiceKey → personality's preferred voice.
  // OPTIONAL — absent IO falls back to the pre-WS-G `personality.voice` behavior.
  resolveEffectiveVoiceKey?: (supabase: unknown, userId: string, endpointId: string, personality: Personality | null) => Promise<string | null>;
  // Voice-facing personality catalog (the `personalities` tool). OPTIONAL — absent IO falls
  // back to the direct implementation, so the Node add-on shell and older tests are unaffected.
  listPersonalities?: (supabase: unknown) => Promise<PersonalityChoice[]>;
  logInteraction: (token: string, data: LogData) => Promise<void>;
  // Debit AI token usage AT-SOURCE (audit #7) from the REAL API-returned counts, in-process,
  // instead of trusting the client-forgeable log_ai_interaction round-trip. OPTIONAL: only the
  // cloud IO binds it (default-io → debitBalance, gated by debit_at_source); the Node/on-prem
  // shell omits it (BYOK never debits) and older mocks are unaffected → no debit there.
  debitAiUsage?: (supabase: unknown, userId: string, args: { model: string; inputTokens: number; outputTokens: number; requestType: string; sessionId: string }) => Promise<void>;
  logWebSearch: (token: string, data: WebSearchLogData) => Promise<void>;
  logSports: (token: string, data: SportsLogData) => Promise<void>;
  getDefaultModel: (supabase: unknown) => Promise<string>;
  readRetainTranscripts: (supabase: unknown, userId: string) => Promise<boolean>;
  // CR1 pre-flight credit gate (build plan §3.5). OPTIONAL: an IO shell that omits it
  // (the not-yet-built Node add-on shell; fakes in tests) is treated as always-spendable,
  // so the gate is purely additive. The Deno shell reads user_credits + the floor and
  // honors the `voice_credit_enforce` kill-switch.
  checkSpendable?: (supabase: unknown, userId: string) => Promise<{ spendable: boolean; balance: number; floor: number; low?: boolean }>;
  // T3 (build plan §16.7 item 4): resolve the account's AI config (model + tool toggles)
  // from user_settings. OPTIONAL — absent IO (Node shell / tests) → all-null (request /
  // global-default behavior, unchanged). The account values are DEFAULTS the request can override.
  readAccountAiConfig?: (supabase: unknown, userId: string) => Promise<{ model: string | null; webSearchEnabled: boolean | null; retrievePicturesEnabled: boolean | null; zipCode?: string | null; calendarWriteAccess?: string | null }>;
  // CR3 (build plan §3.5): per-account rate-limit backstop. OPTIONAL — absent IO → always
  // allowed. Inert until `voice_rate_limit_enabled`. Atomic + fail-open (abuse guard only).
  checkRateLimit?: (supabase: unknown, userId: string) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  // BYOK (Open Brain WS-I): 'byok' = the AI tokens run on the USER'S OWN key/model
  // (add-on brain), so out-of-credits must NOT reject the turn — the AI costs Dashie
  // nothing. Instead the DASHIE-FUNDED tools (web search / image search) are disabled
  // for the turn and the prompt says so honestly. Absent/'metered' → unchanged CR1
  // terminal rejection.
  billing?: 'metered' | 'byok';
  // Supabase connection for shared tools that reach edge fns over HTTP (image search).
  // The cloud shell omits it (the tools fall back to Deno env); the Node add-on shell
  // MUST supply it — there is no Deno env there, and without it image resolution threw.
  toolConn?: { supabaseUrl: string; anonKey: string };
}

/** Per-turn retention resolution (build plan §17). `serverPersist` → write text on
 *  the terminal Supabase log row; `callerRetain` → signal the caller to store HA-locally. */
interface RetainCtx {
  serverPersist: boolean;
  callerRetain: boolean;
  userText: string;
}

const REQUEST_TYPE = 'voice_conversation';

// Product-wide default voice for the base/default personality (which carries no voiceKey of
// its own). Resolved through tts_voices, so its provider drives the vendor: Ashley → Inworld.
// THE one place to change the default voice/vendor product-wide (server-side, no APK).
const DEFAULT_VOICE_KEY = 'ASHLEY';

/**
 * Public entry. Runs the core loop, then stamps the personality-derived TTS `voice_id`
 * (D3) onto whatever Turn the core produced — resolved ONCE from the personality's voiceKey
 * (personality_templates.voice → tts_voices), so voice follows personality on every spoken
 * turn without threading it through each return site. Terminal error/credit/noise turns keep
 * `voice_id` undefined (they speak in the client default). Streaming + non-streaming both go
 * through here, so the emitted final Turn carries it.
 */
export async function runOrchestration(deps: OrchestrationDeps, io: OrchestratorIO): Promise<Turn> {
  const voiceCtx: OrchestrateCtx = { voiceId: null, voiceProvider: null };
  const turn = await orchestrate(deps, io, voiceCtx);
  if (turn.voice_id === undefined && voiceCtx.voiceId) turn.voice_id = voiceCtx.voiceId;
  // voice_provider follows the resolved voice's catalog provider so native routes to the
  // right vendor. Additive/nullable (§13.16) — absent → client falls back to its default.
  if (turn.voice_provider === undefined && voiceCtx.voiceProvider) turn.voice_provider = voiceCtx.voiceProvider;
  // Unified dialog policy (20260707): tag a no-intent turn (`miss`) and decide the first-turn
  // give-up (`end_conversation`) HERE, so every surface just renders it (silent notice / close)
  // instead of each loop running its own miss-cap. A miss = the noise short-circuit OR the model
  // returning the canonical noise line. First turn (no prior history) → likely a false wake
  // trigger with background talk → close immediately. One site, like the voice_id/credit stamps.
  if (classifyMiss(turn.route, turn.voice).miss) {
    const isFirstTurn = !deps.req.history || deps.req.history.length === 0;
    turn.metadata = { ...(turn.metadata ?? {}), miss: true };
    if (isFirstTurn) (turn.metadata as Record<string, unknown>).end_conversation = true;
  }
  // CR2/CR4: stamp the credit snapshot (from the CR1 pre-flight read already in the
  // Promise.all — no extra read) onto EVERY turn's metadata. This is the client's
  // cached-balanceSpendable refresh channel (CR-b, decided 2026-07-04): the tablet
  // learns balance/spendable/low as a side effect of normal turns. Same post-stamp
  // pattern as voice_id above — one site, not threaded through each finalize call.
  // Nullable/ignorable per the §13.16 compat contract (old callers just don't read it).
  if (voiceCtx.credit) turn.metadata = { ...(turn.metadata ?? {}), credit: voiceCtx.credit };
  return turn;
}

/** Per-request context the wrapper stamps onto the returned Turn (voice_id + credit). */
interface OrchestrateCtx {
  voiceId: string | null;
  voiceProvider: string | null;
  credit?: { balance: number | null; spendable: boolean; low: boolean };
}

async function orchestrate(deps: OrchestrationDeps, io: OrchestratorIO, voiceCtx: OrchestrateCtx): Promise<Turn> {
  const { req, userId, token, supabase } = deps;
  const t0 = Date.now();

  // False-activation guard: a pure-noise transcript (no letters in any script)
  // is a wake-word misfire — return a terminal "didn't catch that" with no AI
  // call/credit. The model-facing half ("don't loop on a clarifying question")
  // lives in the prompt. Build plan §13.13a.
  if (isLikelyNoise(req.text)) {
    // WS-F.0a: this is the AMBIENT / false-wake miss class — the biggest one, and it
    // short-circuits before any log, so it was invisible in ai_interactions. Write a
    // countable marker row (miss=true, reason='noise') so the miss rate isn't blind to
    // it. No transcript (noise carries no real words → prompt_text stays null regardless
    // of retention), no tokens, no credit. Fire-and-forget; never blocks the turn.
    // High-volume on a flaky wake word — sample here if it ever strains writes.
    io.logInteraction(token, {
      miss: true,
      miss_reason: 'noise',
      session_id: req.conversation_id || crypto.randomUUID(),
      request_type: REQUEST_TYPE,
      request_length: (req.text ?? '').length,
      model: '',
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      total_latency_ms: Date.now() - t0,
      success: true,
      endpoint_id: req.endpoint_id,
    }).catch(() => {});
    return noiseTurn(t0);
  }

  // Unified dialog policy (20260707): an end-intent ("thanks" / "shut up" / "stop talking" …)
  // closes the dialog — decided HERE so every surface honors metadata.end_conversation. Silent
  // (no voice) so nothing is spoken/re-heard; no AI call, no credit.
  if (isEndIntent(req.text)) return endIntentTurn(t0);

  // ai_interactions.session_id is NOT NULL — always supply one (conversation_id when present).
  const sessionId = req.conversation_id || crypto.randomUUID();
  const [personality, retainEnabled, spend, account, rateLimit] = await Promise.all([
    io.resolvePersonality(supabase, userId, req.endpoint_id, req.options?.personality_id),
    io.readRetainTranscripts(supabase, userId),
    // CR1 pre-flight credit gate — folded into the existing parallel reads (no added
    // latency). Absent IO (Node shell / tests) → always spendable. Inert until the
    // `voice_credit_enforce` flag is on for this env.
    io.checkSpendable
      ? io.checkSpendable(supabase, userId)
      : Promise.resolve({ spendable: true, balance: Number.POSITIVE_INFINITY, floor: 0, low: false }),
    // T3 (§16.7 item 4): account AI config (model + tool toggles). Absent IO → all-null.
    io.readAccountAiConfig
      ? io.readAccountAiConfig(supabase, userId)
      : Promise.resolve({ model: null, webSearchEnabled: null, retrievePicturesEnabled: null, zipCode: null, calendarWriteAccess: null }),
    // CR3: per-account rate-limit backstop. Absent IO → allowed. Inert until enabled.
    io.checkRateLimit
      ? io.checkRateLimit(supabase, userId)
      : Promise.resolve({ allowed: true, retryAfterSeconds: 0 }),
  ]);

  // D3 (voice follows personality) + WS-G Round B: resolve the effective voice key → concrete
  // TTS voice id once; the wrapper stamps it onto the returned Turn. Chain (§13.2, voice lock
  // wins): fixed-personality voice → device aiVoice.voiceKey → account ai.defaultVoiceKey →
  // personality's preferred voice → DEFAULT_VOICE_KEY. Absent IO (Node shell / older tests) →
  // the pre-WS-G personality.voice behavior. Every turn then carries a voice + provider →
  // native routes purely on voice_provider.
  const voiceKey = io.resolveEffectiveVoiceKey
    ? (await io.resolveEffectiveVoiceKey(supabase, userId, req.endpoint_id, personality)) || DEFAULT_VOICE_KEY
    : (personality?.voice || DEFAULT_VOICE_KEY);
  const resolvedVoice = io.resolveVoiceId ? await io.resolveVoiceId(supabase, voiceKey) : null;
  voiceCtx.voiceId = resolvedVoice?.voiceId ?? null;
  voiceCtx.voiceProvider = resolvedVoice?.provider ?? null;

  // CR2/CR4: expose the credit snapshot for the wrapper's metadata stamp (only when the
  // shell actually did the read — absent IO / Node shell stays metadata-silent).
  if (io.checkSpendable) {
    voiceCtx.credit = {
      balance: Number.isFinite(spend.balance) ? spend.balance : null,
      spendable: spend.spendable,
      low: spend.low === true,
    };
  }

  // Rate-limited → terminal, BEFORE any gateway spend (abuse backstop, checked first).
  if (!rateLimit.allowed) return rateLimitedTurn(t0, rateLimit.retryAfterSeconds);
  // Out of credits → terminal, BEFORE any gateway spend. Soft signal only
  // (metadata.degraded); the caller renders the prompt-to-choose (CR2). No AI
  // call, no deduction, no log. Build plan §3.5 / CR1.
  // BYOK exception: the AI tokens are on the user's own key ($0 to Dashie), so the
  // turn proceeds — only the Dashie-funded tools (web/image search) are gated off
  // below via paidToolsOk, and the prompt tells the model honestly.
  const byokBrain = io.billing === 'byok';
  if (!spend.spendable && !byokBrain) return insufficientCreditsTurn(t0, spend.balance);
  const paidToolsOk = spend.spendable;   // false only reachable on the BYOK path

  // T3 resolution — request override → ACCOUNT setting → global default. This is what
  // makes the console's model/tool choices actually take effect (§16.7 item 4).
  const modelId = req.options?.model || account.model || (await io.getDefaultModel(supabase));
  const provider = providerForModel(modelId);
  // web search: ON unless the account explicitly disabled it (null/unset → ON, unchanged).
  // paidToolsOk gates the Dashie-funded tools on a BYOK out-of-credits turn.
  const webSearchAllowed = account.webSearchEnabled !== false && paidToolsOk;
  // retrieve pictures: explicit request wins; else the account default; else off.
  const retrievePictures = (req.retrieve_pictures ?? (account.retrievePicturesEnabled ?? false)) && paidToolsOk;
  // Calendar-write VOICE gate (household policy, calendar.writeAccess). Voice may CUD calendar
  // entries only when the account chose 'voice' or 'both'. null/unset/'none'/'touch' → OFF (the
  // 'touch' default). Opt-in by construction so voice can't mutate a real family calendar until the
  // household turns it on. Gates BOTH the tool declaration (below, so the model can't route to it)
  // AND the calendar_write fulfillment branch (defense in depth).
  const voiceCalendarWrites = account.calendarWriteAccess === 'voice' || account.calendarWriteAccess === 'both';
  // Single account-level opt-in; retain_mode splits WHERE the text lands (§17).
  const callerMode = req.options?.retain_mode === 'caller';
  const retain: RetainCtx = {
    serverPersist: retainEnabled && !callerMode,   // brain writes text to Supabase
    callerRetain: retainEnabled && callerMode,     // caller stores text HA-locally
    userText: req.text,
  };

  /**
   * Transcript fields for a DEVICE-fulfilled tool turn (calendar / music / schedule_action /
   * weather). These pass-1-only turns have no server-side response text — the DEVICE composes
   * and speaks the ack ("Okay — at 6 AM, I'll read you the weather") — so response_text stays
   * null. But the user's UTTERANCE is known and is governed by the same retain_transcripts
   * opt-in as every other turn (redact-args.ts names prompt_text as THE consented channel for
   * free text), so there was never a reason to drop it.
   *
   * These branches previously logged `{}` — no transcript at all — so the console rendered
   * "(transcript not saved for this turn)" for EVERY scheduling, calendar, and music turn: the
   * row showed timing and tokens but not what the user actually asked for.
   */
  const deviceFulfilledRetain = () => retainFields(retain.serverPersist, retain.userText, '', null);

  // Gemini does its OWN web search (native Google grounding on pass-1, below) — never offer it
  // web_search as a JSON tool (FB34 v2, John 2026-07-06: "it shouldn't have been given that tool
  // as an option"). Offering it produced the two-pass dance where the grounded synthesis pass
  // could re-emit the tool request. Non-Gemini providers keep the tool (Tavily two-pass).
  // SPORTS GROUNDING GUARD (2026-07-13): with native grounding on, Gemini answers game
  // questions straight from Google Search — route:direct, NO tool call. That silently
  // costs BOTH the scorecard (no tool result → no structured_data) and the user's
  // timezone (a web answer came back "at noon Pacific Time" on an Eastern device).
  // Prompting alone didn't hold, so take the shortcut AWAY: no grounding on a
  // sports-shaped turn → the model has no current data to lean on and must emit the
  // sports info_request. Deterministic, per the "move determinism out of the model"
  // rule. Anything the tool can't serve still falls through to its normal handling.
  const groundingAvailable = provider === 'gemini' && webSearchAllowed;
  const geminiGrounds = groundingAvailable && !looksLikeSportsAsk(req.text);
  // false → prompt omits web_search from the tools list (T3 opt-out, or Gemini-grounds-natively)
  const promptWebSearch = webSearchAllowed && !geminiGrounds;
  // Capability snapshot (Thread A #1): what THIS turn was allowed to do, logged into
  // tool_trace.caps on every terminal row — so an image request with retrieve_pictures
  // OFF reads as "disabled" in the fleet metadata, not a routing defect. `tools` comes
  // from the same filtered list buildPrompt injects (offeredToolNames), so it can't drift.
  // Rides on `context` so secondPass carries it to its toolMeta() without a new param.
  // WS5-a: this turn is a scheduled action FIRING (the device replaying a stored prompt),
  // not a person speaking → schedule_action is not offered, so the replay can't re-schedule
  // itself. Flows into the caps snapshot too, so the log shows what the model really saw.
  const isAnnouncement = req.announcement === true;
  // What this caller can actually run locally. Device-only tools (music, video_feeds) are
  // not offered to the model when the caller didn't claim them — otherwise the model is told
  // a capability exists, calls it, and the turn is burned on "I can't do that here".
  const clientTools = req.client_fulfilled_tools;
  // Multi-tool emission is a dedicated capability the client opts into by putting `multi` in
  // client_fulfilled_tools (a per-device rollout knob, not one of the DEVICE_ONLY tools). Only
  // then does buildPrompt teach pass-1 to emit {type:"multi", steps:[…]} AND the orchestrator
  // dispatch each step. No current client declares it → the feature is dark in prod until a device
  // (APK / kiosk JS) fulfills the steps and claims the token. See 20260717 build plan Part A.
  const multiEnabled = Array.isArray(clientTools) && clientTools.includes('multi');
  const caps: CapsSnapshot = {
    web_search: webSearchAllowed,
    retrieve_pictures: retrievePictures,
    grounding: geminiGrounds,
    multi: multiEnabled,
    tools: offeredToolNames({ webSearchEnabled: promptWebSearch, announcement: isAnnouncement, clientTools, calendarWriteEnabled: voiceCalendarWrites }),
  };
  const context = {
    customPersonalityConfig: personality,
    chatHistory: formatHistory(req.history),
    language: req.language || 'system',
    timezone: req.timezone,   // client IANA zone → correct "today" in the prompt (server is UTC)
    webSearchEnabled: promptWebSearch,
    announcement: isAnnouncement,
    clientTools,   // → toolsListFor drops device-only tools this caller can't fulfill
    multiEnabled,  // → buildPrompt appends the capability-gated multi-emission block when true
    calendarWriteEnabled: voiceCalendarWrites,   // → toolsListFor drops calendar_write when voice writes off
    // false → buildPrompt appends the image-unavailable instruction so the model can't
    // claim to show a picture the enrichment layer will drop.
    retrievePicturesEnabled: retrievePictures,
    // Room awareness (20260715): the HA area this device is in, so an unqualified command
    // ("turn off the lights") resolves to THIS room. Flows to both passes via `...context` in
    // buildPrompt → rendered as {{DEVICE_AREA}} in the home_assistant prompt. Absent → area-blind.
    deviceArea: req.provided_context?.device_area ?? null,
    caps,
  };

  // ── PASS 1 (or deterministic force-search gate, §23.5) ──────────────────────
  // Mutable-entity fact queries (current officeholders/execs/champions) get
  // answered from a model's stale memory and hallucinate (probe: 0% search,
  // 50–78% stale). A deterministic gate force-routes them to web_search, skipping
  // the pass-1 LLM call — covers every surface that reaches the brain (console,
  // cloud) from one place. The synthetic pass1 (0 tokens / 0 latency) flows through
  // the existing web_search branch unchanged.
  // Force-search is a web_search action → skip it when the account disabled web search
  // (respects the privacy/cost opt-out). The MODEL-routed web_search is also gated: the
  // prompt omits web_search from the tools list (buildPrompt, via context.webSearchEnabled)
  // + a hard guard in the web_search branch. So "web search off" is fully honored.
  const forced = webSearchAllowed ? detectMutableEntity(req.text) : null;
  // §23.6: caller-supplied pre-fetched sports → pass-1 voices it in personality
  // (the reward for pre-fetching). Absent → route + template, unchanged.
  const providedSports = req.provided_context?.sports as SportsResult | undefined;
  // Calendar-color plan (20260711): device-sniffed pre-fetched calendar window → pass-1
  // digests it directly (single AND multi-event, member-attributed). The device holds the
  // matching card; the brain only flags that the direct path was taken.
  const providedCalendar = req.provided_context?.calendar;
  const p1Prompt = buildPrompt({
    userRequest: req.text, inquiryType: null,
    context: {
      ...context,
      ...(providedSports ? { providedSports } : {}),
      ...(providedCalendar ? { providedCalendar } : {}),
    },
  });
  const forcedContent = forced
    ? JSON.stringify({
      type: 'info_request', tool: 'web_search', query: req.text,
      context: `forced web_search (mutable entity: ${forced})`,
      processing_message: 'Looking that up',
    })
    : null;
  const pass1: GatewayResult = forcedContent
    ? { ok: true, latency_ms: 0, raw: { content: forcedContent, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }
    // Gemini: native Google Search available on pass-1 — current-events queries ground and
    // answer in ONE call (no web_search JSON tool, no synthesis second pass). Gemini only
    // bills grounding when it actually searches; device-control turns don't.
    // Pass-1 is the ROUTING decision → deterministic (kind:'decide', temp 0). The same utterance
    // must not route differently across runs. (A grounded Gemini pass-1 also answers directly here;
    // that's the one irreducible decide/narrate collision — we prioritize stable routing.)
    // WS-F.0c: options.route_temperature is a bench/debug override for the routing pass ONLY — it
    // lets the determinism experiment re-sample this decision at 0.7/0.2/0 against the deployed fn.
    // Absent (every production caller) → the kind:'decide' default (temp 0) stands, unchanged.
    // options.thinking_budget overrides the thinking budget for THIS pass-1 decide call; absent
    // (every production caller) → thinkingBudget 0 (decode-pass thinking OFF), the shipped default
    // since 20260717. Pass-1 is a temp-0 CLASSIFICATION — Gemini's dynamic thinking bought nothing
    // here: the broad thinking-off A/B held 100% on every category (12 single-tool controls +
    // sports/images/web_search/schedule_action field fixtures) AND cut the field compound turn from
    // ~15s to ~1s. Only pass-1 is flipped — the narrate pass-2 (synthesis prose) keeps dynamic
    // thinking (it's not the latency hotspot and warmth may benefit). The HA pass-2 resolution
    // (kind:'decide') is left on dynamic too — its thinking-off was not benched (large entity lists).
    : await io.callGateway({ provider, prompt: p1Prompt, modelId, grounding: geminiGrounds, kind: 'decide', temperature: req.options?.route_temperature, thinkingBudget: req.options?.thinking_budget ?? 0 });
  if (!pass1.ok || !pass1.raw) {
    return errorTurn(t0, pass1, [stageErr('pass1', pass1)]);
  }
  // Parse BEFORE logging so a terminal pass can carry the retained transcript text.
  const p1Parsed = parseContent(pass1.raw.content);
  const p1Stage = passStage('pass1', pass1, p1Parsed?.type);
  // The pass-1 routing decision — the canonical grading key for the benchmark.
  const route = routeOf(p1Parsed);
  // Per-turn tool decision for the log (analysis): route + tool + args + caps on every terminal row.
  const turnMeta = toolMeta(p1Parsed, route, caps);
  // Live progress: route decided (dev timing), then the tool label the UI shows
  // while the fetch + synthesis run. Brain owns the copy; no-op for non-streaming.
  deps.onStage?.({ stage: 'routed', route, elapsed_ms: Date.now() - t0 });
  if (p1Parsed?.type === 'info_request' && p1Parsed.tool) {
    deps.onStage?.({ stage: 'fetching', tool: p1Parsed.tool, status: statusForTool(p1Parsed.tool, p1Parsed.query), elapsed_ms: Date.now() - t0 });
  }

  // HARD RULE: never surface a raw/unparsed model payload as the answer. When pass-1 didn't
  // parse AND the raw is JSON-ish (a tool call the normalizer couldn't repair, or broken JSON),
  // speak a clarification instead of reading the tool-request JSON aloud — reaching for or
  // voicing a tool request makes no sense to the user. Plain-prose fallbacks (no leading brace)
  // still pass through to the direct-response branch below.
  if (!p1Parsed && /^\s*(```[a-z]*\s*)?[{[]/i.test(pass1.raw.content || '')) {
    // Honest-decline refinement (2026-07-19, found on the kiosk): when the malformed blob
    // NAMES a real tool the caller was deliberately NOT offered (e.g. a kiosk asking about
    // the calendar — the model, taught the tool by the prompt's examples, contorts into
    // broken JSON for it), "didn't catch that" gaslights the user — they said it perfectly.
    // Say what's true instead: this device can't do that. Regex over the RAW so malformed/
    // truncated JSON still matches; unknown tool names keep the clarify (genuine garble).
    const blobTool = (pass1.raw.content || '').match(/"tool"\s*:\s*"([a-z_]+)"/)?.[1];
    if (blobTool && !caps.tools.includes(blobTool) && KNOWN_DEVICE_TOOL_DECLINES[blobTool]) {
      console.warn(`[orchestrator] DROP→decline: pass-1 emitted unparseable JSON for unoffered tool '${blobTool}' — speaking the device-capability decline`);
      const declineVoice = KNOWN_DEVICE_TOOL_DECLINES[blobTool];
      const decline = { type: 'response', voice: declineVoice, text: null, action: null } as ReturnType<typeof parseContent>;
      await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1,
        retainFields(retain.serverPersist, retain.userText, declineVoice, null), turnMeta);
      return finalize({ t0, parsed: decline, raw: pass1.raw, stages: [p1Stage], usage: pass1.raw.usage, latency: pass1.latency_ms, retain, sessionId, route });
    }
    const clarifyVoice = "Sorry, I didn't quite catch that — could you say it again?";
    const clarify = { type: 'response', voice: clarifyVoice, text: null, action: null } as ReturnType<typeof parseContent>;
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1,
      retainFields(retain.serverPersist, retain.userText, clarifyVoice, null), turnMeta);
    return finalize({ t0, parsed: clarify, raw: pass1.raw, stages: [p1Stage], usage: pass1.raw.usage, latency: pass1.latency_ms, retain, sessionId, route });
  }

  // Direct response / action → pass1 is terminal.
  if (!p1Parsed || p1Parsed.type === 'response' || p1Parsed.type === 'action') {
    // set_personality emitted as a DIRECT pass-1 action (not via the personalities tool):
    // fetch the catalog and attach the template's voice fields here too — the tool branch's
    // enrichment never runs on this path. A read failure degrades to the unenriched action
    // (the client applies id/name and leaves the voice — same as an old brain).
    if (p1Parsed?.type === 'action' && p1Parsed.action?.command === 'set_personality') {
      try {
        const choices = io.listPersonalities
          ? await io.listPersonalities(supabase)
          : await listAvailablePersonalities(supabase);
        const row = enrichSetPersonalityAction(p1Parsed.action, choices);
        // Speak the NEW character's greeting instead of the old character narrating the
        // switch. Blank/absent greeting → keep the model's line.
        const greeting = row?.greeting_fallback?.trim();
        if (greeting) p1Parsed.voice = greeting;
        // TRAILING-VOICE fix (John 2026-07-19): the turn's TTS voice was resolved at
        // request START (still the OLD personality), so every switch confirmation spoke
        // one personality behind ("Oh, hello!" in the pirate voice). Re-stamp THIS
        // turn's voice with the switched-to template's voice.
        await restampVoiceForSwitch(io, supabase, voiceCtx, row);
      } catch (e) {
        console.warn('set_personality direct-path enrichment failed (action ships unenriched):', e);
      }
    }
    // §23.6: pre-fetched sports voiced in personality on pass-1 → attach the SAME
    // deterministic card as the no-prefetch template path (only the voice differs).
    const sportsCard = (providedSports && p1Parsed?.type === 'response')
      // Pass the user's zone so the PRE-game card shows the kickoff time (clockTime returns
      // '' without a tz). Field bug 2026-07-16: a prefetched fixture answered directly on
      // pass-1 showed "Sun, Jul 19" with NO time, while the same fixture fetched via the
      // sports TOOL (pass-2, line ~781) showed "Sun, Jul 19, 2:00 PM" — the two paths must
      // format the card identically. Team-independent: the axis was direct-vs-tool, not which
      // side was named.
      ? templateSports(providedSports, (providedSports.query as Record<string, unknown>) || {}, { timezone: req.timezone }).structured_data
      : undefined;
    // Image enrichment (cascade trigger, §3.5): the model emits an `image` hint on a direct
    // response → resolve via the shared image_search resolver → {type:'image'} card. Gated by the
    // client's retrieve_pictures setting; skipped when sports already owns the slot.
    const imageHint = (!sportsCard && retrievePictures && p1Parsed?.type === 'response')
      ? (p1Parsed as { image?: { searchTerms?: string; criteria?: string } }).image
      : undefined;
    const imageCard = imageHint?.searchTerms ? await resolveImageHint(p1Parsed, token, sessionId, io.toolConn) : undefined;
    const card = sportsCard ?? imageCard;
    // A "direct" answer that ATTACHES a card is a tool use — log it as one (not "direct") so
    // "show me a picture" and a prefetched score are attributable. Image logs its search terms +
    // whether it resolved (a miss still voiced an answer). Else the plain turnMeta.
    // Pre-fetched calendar answered directly on pass-1 → attributable as a calendar turn.
    // The trace carries the WINDOW ONLY ({time_range}), never event content — and
    // `tool:'calendar_context'` doubles as the improvement-pool exclusion marker
    // (Google Limited Use: calendar-derived turns stay out of the corpus).
    const calendarUsed = !!(providedCalendar && !sportsCard && !imageCard && p1Parsed?.type === 'response');
    const logMeta = sportsCard
      ? { tool_used: 'get_sports_scores', response_type: p1Parsed?.type ?? null,
          tool_trace: { route: 'sports', tool: 'get_sports_scores', args: providedSports?.query ?? null, caps } }
      : imageHint?.searchTerms
        ? { tool_used: 'show_image', response_type: p1Parsed?.type ?? null,
            tool_trace: { route: 'image', tool: 'show_image', args: { searchTerms: imageHint.searchTerms, criteria: imageHint.criteria ?? null, resolved: !!imageCard }, caps } }
        : calendarUsed
          ? { tool_used: 'calendar_context', response_type: p1Parsed?.type ?? null,
              tool_trace: { route: 'calendar', tool: 'calendar_context', args: { time_range: providedCalendar.time_range ?? null }, caps } }
          : turnMeta;
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1,
      retainFields(retain.serverPersist, retain.userText, responseTextOf(p1Parsed, pass1.raw), p1Parsed?.text ?? null), logMeta);
    return finalize({
      t0, parsed: p1Parsed, raw: pass1.raw, stages: [p1Stage], usage: pass1.raw.usage,
      latency: pass1.latency_ms, retain, sessionId,
      route: sportsCard ? 'sports' : (imageCard ? 'image' : (calendarUsed ? 'calendar' : route)),
      structured_data: card ?? undefined,
      // The device attached the window and holds the matching card — this flag tells it
      // the direct path was taken (render the held card). Absent on the tool-fallback path.
      metadata: calendarUsed ? { calendar_context_used: true } : undefined,
    });
  }

  // ── info_request → web_search (self-fulfilled) ────────────────────────────
  if (p1Parsed.type === 'info_request' && p1Parsed.tool === 'web_search') {
    // Non-terminal pass: token/cost logged, but no transcript text (pass2 is terminal).
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1);
    const queryStr = typeof p1Parsed.query === 'string'
      ? p1Parsed.query
      : ((p1Parsed.query as Record<string, string>)?.query || (p1Parsed.query as Record<string, string>)?.q || req.text);

    // Web search OFF for this account, but the model routed here anyway (emitted
    // web_search from training priors even though it wasn't in the offered tools list)
    // → do NOT search. Answer from the model's own knowledge via a direct pass-2 (no
    // Tavily fetch, no grounding, no search-cost debit). Safety net behind the tool-list
    // omission — makes "web search off" a hard guarantee.
    if (!webSearchAllowed) {
      const NO_SEARCH_SENTINEL = {
        note: 'Web search is turned OFF for this user. Do NOT claim to have searched. Answer the question from your own knowledge; if you are not certain of a current fact, say you are not able to look it up right now.',
        query: queryStr,
      };
      return await secondPass(io, deps, t0, 'web-search', NO_SEARCH_SENTINEL, [p1Stage, { name: 'web_search_disabled', latency_ms: 0 }], pass1, provider, modelId, context, sessionId, retain, route, false);
    }

    // Gemini models: native Google Search grounding — the model fetches live results
    // and answers in ONE call (no Tavily fetch, no separate search-cost debit; the
    // cost rides the grounded Gemini tokens that secondPass's logPass records). The
    // existing web-search template still applies; we pass a sentinel in place of
    // pre-fetched results telling the model to use its search tool. Non-Gemini / local
    // models fall through to the runWebSearch (Tavily/Brave) two-pass below.
    // Build plan 20260628 §D ("fix web search to Google for Gemini").
    if (provider === 'gemini') {
      const GROUNDED_SENTINEL = {
        note: 'No pre-fetched results were provided. Use your Google Search tool to find current information for the query, then answer.',
        query: queryStr,
      };
      const groundedStage: Stage = { name: 'grounded_search', latency_ms: 0, provider: 'google-grounding' };
      return await secondPass(io, deps, t0, 'web-search', GROUNDED_SENTINEL, [p1Stage, groundedStage], pass1, provider, modelId, context, sessionId, retain, route, true);
    }

    const tFetch = Date.now();
    let search: WebSearchResult;
    try {
      search = await io.runWebSearch(queryStr, token);
    } catch (e) {
      return errorTurn(t0, { error: `Web search failed: ${(e as Error).message}`, latency_ms: pass1.latency_ms },
        [p1Stage, { name: 'fetch_search', latency_ms: Date.now() - tFetch, error: (e as Error).message }]);
    }
    const fetchStage: Stage = { name: 'fetch_search', latency_ms: Date.now() - tFetch, result_count: search?.results?.length || 0, provider: search?.provider };
    // Log the ACTUAL provider the gateway used + debit its searchCost (same
    // log_web_search path the webapp uses). Build plan §15.5.
    await io.logWebSearch(token, {
      session_id: sessionId,
      provider: search?.provider || 'unknown',
      query_length: queryStr.length,
      requested_count: 10,
      result_count: search?.result_count ?? search?.results?.length ?? 0,
      latency_ms: search?.latency ?? fetchStage.latency_ms,
      success: true,
    });
    return await secondPass(io, deps, t0, 'web-search', search, [p1Stage, fetchStage], pass1, provider, modelId, context, sessionId, retain, route);
  }

  // ── info_request → home_assistant (entities from provided_context) ────────
  if (p1Parsed.type === 'info_request' && p1Parsed.tool === 'home_assistant') {
    const entities = req.provided_context?.ha_entities;
    if (!entities) {
      // Brain can't fetch HA entities; caller didn't supply them. Surface as unsupported
      // so the caller can fall back to its native HA path. Not a Dashie spoken turn → no transcript.
      await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1);
      return finalize({ t0, parsed: p1Parsed, raw: pass1.raw, stages: [p1Stage], usage: pass1.raw.usage, latency: pass1.latency_ms, unsupported_tool: 'home_assistant', sessionId, route });
    }
    // Non-terminal pass: no transcript text (pass2 is terminal).
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1);
    const commandHint = (p1Parsed.query as Record<string, string>)?.command_hint || req.text;
    return await secondPass(io, deps, t0, 'home-assistant', { entities, command_hint: commandHint }, [p1Stage], pass1, provider, modelId, context, sessionId, retain, route);
  }

  // ── info_request → sports (self-fulfilled via sports-gateway) ─────────────
  if (p1Parsed.type === 'info_request' && p1Parsed.tool === 'sports') {
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1);
    const sportsQuery = (typeof p1Parsed.query === 'object' && p1Parsed.query) ? p1Parsed.query as Record<string, unknown> : { team: req.text };
    // The user's zone rides along so the gateway anchors "today" on the USER's calendar
    // day — the server is UTC, where 8 PM Eastern is already tomorrow.
    if (req.timezone && sportsQuery.tz == null) sportsQuery.tz = req.timezone;
    // Legacy `type` (score/schedule) → `when` (the gateway's temporal axis); an explicit
    // date wins. Keep any `when` the model set — the gateway now bounds the window by it.
    {
      const t = String(sportsQuery.type ?? '').toLowerCase();
      if (sportsQuery.when == null && t === 'schedule') sportsQuery.when = 'next';
      if (sportsQuery.when == null && t === 'score') sportsQuery.when = 'last';
      delete sportsQuery.type;
      if (/\d{4}-\d{2}-\d{2}/.test(String(sportsQuery.date ?? ''))) sportsQuery.when = 'date';
    }
    // SLATE vs single. A slate = the model set list:true (plural "next games") OR a bare
    // teamless ask with no temporal focus (legacy "what games are on"). Set list:true so
    // the gateway KEEPS the whole window (its finalize bypasses the single-game collapse)
    // AND keep `when` so a future slate ("next games") fetches the upcoming window, not
    // just today — the Jul-12 "only 1 game" bug was `when` being dropped, leaving today
    // (empty for a league idle today, e.g. World Cup). A teamless SINGLE ask ("the next
    // game") keeps when → templateSports cards ONE game WITH venue.
    const teamless = !String(sportsQuery.team ?? '').trim();
    const wantsSlate = sportsQuery.list === true || (teamless && sportsQuery.when == null);
    if (wantsSlate) sportsQuery.list = true;
    else if (teamless && sportsQuery.when == null) sportsQuery.when = 'next';
    const tFetch = Date.now();
    let sports: SportsResult;
    try {
      sports = await io.runSports(sportsQuery, token);
    } catch (e) {
      return errorTurn(t0, { error: `Sports lookup failed: ${(e as Error).message}`, latency_ms: pass1.latency_ms },
        [p1Stage, { name: 'fetch_sports', latency_ms: Date.now() - tFetch, error: (e as Error).message }]);
    }
    const fetchStage: Stage = { name: 'fetch_sports', latency_ms: Date.now() - tFetch, result_count: sports?.games?.length || 0, provider: sports?.provider };
    // Log the sports call so it shows as a step in the Analysis view (mirrors
    // logWebSearch). Sports is included, not billed — no deduction.
    await io.logSports(token, {
      session_id: sessionId,
      provider: sports?.provider || 'unknown',
      query: JSON.stringify(sports?.query || sportsQuery || {}),
      result_count: sports?.games?.length || 0,
      latency_ms: sports?.latency ?? fetchStage.latency_ms,
      success: true,
    });
    // ── DLG-2: detail/summary ask → rich LLM synthesis, no card ───────────────
    // "give me a summary / recap / how did they play" wants scorers + plays, not the
    // one-line score the template emits. Route to the INQUIRY_SPORTS synthesis pass
    // (which the template path otherwise reaches only on an empty slate). It attaches
    // NO structured_data, so no duplicate score card on the follow-up turn. Only when
    // we actually got games — an empty result still falls to the template's own
    // "couldn't find it" handling below.
    // ── TOOL FIRST, WEB SECOND (2026-07-13) ───────────────────────────────────
    // The tool found NO game. Grounding was switched off for pass-1 (looksLikeSportsAsk)
    // so the model couldn't shortcut past the tool — but now that the tool has come up
    // empty, the web is exactly the right fallback ("no game today, but they play
    // Thursday"). Re-enable grounding for the synthesis pass so the model can search and
    // answer with the REAL date/time, instead of a dead-end "I couldn't find a game" or a
    // guess from memory. Non-Gemini/opted-out accounts keep the template's miss line.
    if ((sports?.games?.length || 0) === 0 && groundingAvailable) {
      return await secondPass(io, deps, t0, 'sports', sports, [p1Stage, fetchStage], pass1, provider, modelId, context, sessionId, retain, route, true);
    }
    // Model synthesis when the template can't serve the ask: a DETAIL request (recap/scorers —
    // the template only emits a one-liner), OR anything we don't recognise as a score/schedule
    // question. The second half is the 2026-07-16 inversion (see templateCanAnswer): the template
    // used to be the catch-all and would read the fixture back at a roster question forever.
    if ((sports?.games?.length || 0) > 0 && (wantsGameDetail(req.text) || !templateCanAnswer(req.text))) {
      return await secondPass(io, deps, t0, 'sports', sports, [p1Stage, fetchStage], pass1, provider, modelId, context, sessionId, retain, route);
    }
    // ── Tier-1 structured tool: template the answer (no pass-2 LLM) ───────────
    // The gateway already returned structured games[]; synthesize deterministically
    // + emit a card payload. See 20260623_VOICE_TIER1_STRUCTURED_TOOLS.md §1.
    // SLATE ask → deterministic games[] card + brief spoken line, mirroring the registry
    // tool's list:true path. `wantsSlate` (computed above from list:true / bare teamless)
    // is the signal now — templateSports.fallback no longer detects it since we keep
    // `when`. Genuinely-empty slate still falls to the LLM.
    const synth = templateSports(sports, sportsQuery, { timezone: req.timezone });
    // A slate that resolved to exactly ONE game renders as the richer detail card
    // (stadium + city/state, records) rather than a one-row slate. Keyed on the GAME
    // COUNT, not on whether templateSports produced a card — an explicit list:true with a
    // directed `when` makes templateSports pick a single game, and that must NOT override
    // a genuine multi-game slate.
    if ((wantsSlate || synth.fallback) && (sports?.games?.length ?? 0) !== 1) {
      const slate = templateSlate(sports, sportsQuery, { timezone: req.timezone });
      if (slate.structured_data) {
        const parsedSlate = { type: 'response', voice: slate.voice, text: null, action: null } as ReturnType<typeof parseContent>;
        const slatePass: GatewayResult = {
          ok: true, latency_ms: 0,
          raw: { content: slate.voice, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, model: 'template', provider: 'template' },
        };
        await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, '(sports slate template)', slatePass,
          retainFields(retain.serverPersist, retain.userText, slate.voice, null), turnMeta);
        return finalize({
          t0, parsed: parsedSlate, raw: pass1.raw!, stages: [p1Stage, fetchStage],
          usage: pass1.raw?.usage, latency: pass1.latency_ms,
          structured_data: slate.structured_data ?? undefined,
          retain, sessionId, route,
        });
      }
      return await secondPass(io, deps, t0, 'sports', sports, [p1Stage, fetchStage], pass1, provider, modelId, context, sessionId, retain, route);
    }
    const parsed = { type: 'response', voice: synth.voice, text: synth.text, action: null } as ReturnType<typeof parseContent>;
    // Log the synthesis as a zero-token "template" pass so the Analysis step and
    // server-side retention (response text) stay in parity with the old pass-2 path.
    const templatePass: GatewayResult = {
      ok: true, latency_ms: 0,
      raw: { content: synth.voice, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, model: 'template', provider: 'template' },
    };
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, '(sports template)', templatePass,
      retainFields(retain.serverPersist, retain.userText, synth.voice, synth.text), turnMeta);
    return finalize({
      t0, parsed, raw: pass1.raw!, stages: [p1Stage, fetchStage],
      usage: pass1.raw?.usage, latency: pass1.latency_ms,
      structured_data: synth.structured_data ?? undefined,
      retain, sessionId, route,
    });
  }

  // ── info_request → calendar (DEVICE-fulfilled) ────────────────────────────
  // The merged multi-provider calendar truth (Google + Outlook + HA + CalDAV) is
  // built ON THE DEVICE; an edge fn can't reconstruct it. So the brain only extracts
  // the query (pass-1) and hands it back via `client_tool`; the client runs the local
  // calendar tool + renders the card — no pass-2, no AIService fallback.
  // Build plan 20260623_VOICE_TIER1_STRUCTURED_TOOLS.md §3.
  if (p1Parsed.type === 'info_request' && p1Parsed.tool === 'calendar_events') {
    // A caller that doesn't fulfill 'calendar' (kiosk — its JS-lane executor 404s) is now OFFERED
    // the tool anyway (prompt.ts) and routes here reliably; the brain SELF-FULFILLS a graceful
    // decline instead of handing back a client_tool the device would drop. This replaces the
    // 2026-07-19 offering DROP, which produced tool-substitution rather than a decline (0/2 models
    // declined on their own — bench 2026-07-20). Same shape as calendar_write's decline below.
    // It's a spoken `response` turn the brain owns — no client_tool — so there's no old-APK
    // raw-JSON-leak risk (the concern the honest-handshake guarded), and "not configured" is a
    // truthful calendar STATE, not a hidden capability drop.
    if (!callerFulfills(req, 'calendar')) {
      const declineVoice = "You don't have calendar access set up on this device yet.";
      const decline = { type: 'response', voice: declineVoice, text: null, action: null } as ReturnType<typeof parseContent>;
      await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1,
        retainFields(retain.serverPersist, retain.userText, declineVoice, null), turnMeta);
      return finalize({
        t0, parsed: decline, raw: pass1.raw, stages: [p1Stage], usage: pass1.raw.usage,
        latency: pass1.latency_ms, retain, sessionId, route,
      });
    }
    // turnMeta so the device-fulfilled turn still carries route/tool/args(redacted)/caps —
    // the "calendar with time_range=next_week vs next_weekend" diagnostic the trace exists for.
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1, deviceFulfilledRetain(), turnMeta);
    return finalize({
      t0, parsed: p1Parsed, raw: pass1.raw, stages: [p1Stage], usage: pass1.raw.usage,
      latency: pass1.latency_ms, client_tool: { tool: 'calendar', query: p1Parsed.query }, sessionId, route,
    });
  }

  // ── info_request → calendar_write (DEVICE-fulfilled, capability-GATED) ─────
  // Calendar CREATE by voice (confirm-first; the device owns the pending draft +
  // slot-fill/confirm questions — 20260713_VOICE_CALENDAR_CRUD_DESIGN.md §2.3/§2.4).
  // Unlike every read tool, this deliberately INVERTS the absent-means-fulfilled
  // client_fulfilled_tools rule: an unhandled client_tool on an old APK reproduces the
  // FB13 raw-JSON-leak bug, and a write tool must never take that risk. Only callers
  // that EXPLICITLY declare 'calendar_write' get the client_tool; everyone else gets a
  // graceful spoken decline.
  if (p1Parsed.type === 'info_request' && p1Parsed.tool === 'calendar_write') {
    // Household calendar-write VOICE gate (calendar.writeAccess ∉ {voice, both}). The prompt already
    // omits calendar_write when this is off, so the model normally can't route here — this is the
    // defense-in-depth decline for a model that emits it anyway (training priors) or an old bundle.
    if (!voiceCalendarWrites) {
      const declineVoice = "Making calendar changes by voice is turned off. You can turn it on in Calendar settings.";
      const decline = { type: 'response', voice: declineVoice, text: null, action: null } as ReturnType<typeof parseContent>;
      await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1,
        retainFields(retain.serverPersist, retain.userText, declineVoice, null), turnMeta);
      return finalize({
        t0, parsed: decline, raw: pass1.raw, stages: [p1Stage], usage: pass1.raw.usage,
        latency: pass1.latency_ms, retain, sessionId, route,
      });
    }
    const caps = req.client_fulfilled_tools;
    if (!Array.isArray(caps) || !caps.includes('calendar_write')) {
      const declineVoice = "I can read the calendar here, but I can't make calendar changes from this device yet.";
      const decline = { type: 'response', voice: declineVoice, text: null, action: null } as ReturnType<typeof parseContent>;
      await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1,
        retainFields(retain.serverPersist, retain.userText, declineVoice, null), turnMeta);
      return finalize({
        t0, parsed: decline, raw: pass1.raw, stages: [p1Stage], usage: pass1.raw.usage,
        latency: pass1.latency_ms, retain, sessionId, route,
      });
    }
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1, deviceFulfilledRetain(), turnMeta);
    return finalize({
      t0, parsed: p1Parsed, raw: pass1.raw, stages: [p1Stage], usage: pass1.raw.usage,
      latency: pass1.latency_ms, client_tool: { tool: 'calendar_write', query: p1Parsed.query }, sessionId, route,
    });
  }

  // ── info_request → music (DEVICE-fulfilled) ───────────────────────────────
  // Now-playing state + the Music Assistant library live on the device (MusicVoiceTool
  // via MA REST); an edge fn can't reach either. Same shape as calendar: pass-1 extracts
  // the query, the device fulfills + speaks deterministically. No pass-2.
  // Design: 20260711_AI_MUSIC_TOOL_DESIGN.md §3.
  if (p1Parsed.type === 'info_request' && p1Parsed.tool === 'music') {
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1, deviceFulfilledRetain(), turnMeta);
    return finalize({
      t0, parsed: p1Parsed, raw: pass1.raw, stages: [p1Stage], usage: pass1.raw.usage,
      latency: pass1.latency_ms, client_tool: { tool: 'music', query: p1Parsed.query }, sessionId, route,
    });
  }

  // ── info_request → video_feeds (DEVICE-fulfilled) ─────────────────────────
  // Cameras live on the device (the native overlay + the LAN/Frigate streams); an edge fn
  // can reach neither. Same shape as music: pass-1 extracts {action, camera?, time?}, the
  // device shows the feed and speaks its own confirmation. No pass-2 — the FEED is the
  // answer, so there is nothing for a second model pass to say.
  //
  // `time` travels as the user's PHRASE ("10 minutes ago"), not a timestamp: the device
  // resolves it with its own clock/zone. A model-emitted instant re-introduces the
  // timezone-over-the-wire bug (the get_current_time-answered-in-UTC class).
  //
  // Capability-gated upstream: the tool isn't in the prompt at all unless the caller declared
  // 'video_feeds', so a device with no cameras can't route here.
  if (p1Parsed.type === 'info_request' && p1Parsed.tool === 'video_feeds') {
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1, deviceFulfilledRetain(), turnMeta);
    return finalize({
      t0, parsed: p1Parsed, raw: pass1.raw, stages: [p1Stage], usage: pass1.raw.usage,
      latency: pass1.latency_ms, client_tool: { tool: 'video_feeds', query: p1Parsed.query }, sessionId, route,
    });
  }

  // ── info_request → schedule_action (DEVICE-fulfilled) ─────────────────────
  // AI callbacks (WS5-a): the alarm + store + fire-time pipeline injection all
  // live on the device (AlarmManager owns firing — cloud is never the firing
  // path). Same shape as calendar/music: pass-1 extracts {time, recurrence,
  // prompt, label}; ScheduleActionDirective.kt creates the action and speaks
  // the ack. Plan 20260710_VOICE_ID_CONDITION_ALERTS_PLAN.md WS5-a.
  if (p1Parsed.type === 'info_request' && p1Parsed.tool === 'schedule_action') {
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1, deviceFulfilledRetain(), turnMeta);
    return finalize({
      t0, parsed: p1Parsed, raw: pass1.raw, stages: [p1Stage], usage: pass1.raw.usage,
      latency: pass1.latency_ms, client_tool: { tool: 'schedule_action', query: p1Parsed.query }, sessionId, route,
    });
  }

  // ── info_request → weather ────────────────────────────────────────────────
  // PRIMARY (device-fulfilled): served on-device by the native WeatherDataProvider
  // (HA-first or Open-Meteo, per the user's dashboard toggle) so a voice answer matches
  // the dashboard's source. An edge fn can't reach the user's HA, so — like calendar — the
  // brain extracts the query (pass-1) and hands it back via `client_tool`; the device
  // fetches + speaks. This is the logged-in tablet path (absent client_fulfilled_tools).
  //
  // FALLBACK (server-fulfilled): a caller that CAN'T run weather locally (the headless HA
  // gateway / anon kiosk → client_fulfilled_tools omits 'weather') would dead-end on
  // client_tool. So the brain self-fulfills via getWeather (edge Open-Meteo) + the SAME
  // phrasing the device speaks (weather-synth), returning a real spoken `response` turn.
  // Voice-only — matches the device path (its weather card renderer isn't built). Build plan §0.
  if (p1Parsed.type === 'info_request' && p1Parsed.tool === 'weather_data') {
    const wq = (typeof p1Parsed.query === 'object' && p1Parsed.query) ? p1Parsed.query as Record<string, unknown> : {};
    if (io.getWeather && !callerFulfills(req, 'weather')) {
      const loc = resolveWeatherLocation(wq, account.zipCode ?? null);
      let synthVoice: string;
      const tFetch = Date.now();
      let fetchStage: Stage;
      if (!loc) {
        synthVoice = "I don't know your location yet — add your zip code in settings and I can check the weather.";
        fetchStage = { name: 'fetch_weather', latency_ms: 0, error: 'no_location' };
      } else {
        try {
          const w = await io.getWeather(loc);
          synthVoice = templateWeather(weatherResultToReading(w), wq).voice;
          fetchStage = { name: 'fetch_weather', latency_ms: Date.now() - tFetch, provider: w.provider };
        } catch (e) {
          synthVoice = "I couldn't get the weather right now.";
          fetchStage = { name: 'fetch_weather', latency_ms: Date.now() - tFetch, error: (e as Error).message };
        }
      }
      const synth = { type: 'response', voice: synthVoice, text: null, action: null } as ReturnType<typeof parseContent>;
      await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1,
        retainFields(retain.serverPersist, retain.userText, synthVoice, null), turnMeta);
      return finalize({
        t0, parsed: synth, raw: pass1.raw, stages: [p1Stage, fetchStage], usage: pass1.raw.usage,
        latency: pass1.latency_ms, retain, sessionId, route,
      });
    }
    // Device-fulfilled weather: same turnMeta stamp as calendar above (route/tool/args/caps).
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1, deviceFulfilledRetain(), turnMeta);
    return finalize({
      t0, parsed: p1Parsed, raw: pass1.raw, stages: [p1Stage], usage: pass1.raw.usage,
      latency: pass1.latency_ms, client_tool: { tool: 'weather', query: p1Parsed.query }, sessionId, route,
    });
  }

  // ── info_request → get_current_time (SERVER-fulfilled, tier-1 template) ────
  // Pure server tool: the exact local date/time in the user's zone. Fixes the cascade model
  // answering in UTC (it trusts its own clock over the prompt, but reads tool output). No card,
  // no pass-2 — template the ready-to-read `spoken` value. Contract #20 (lint:shared-tools).
  if (p1Parsed.type === 'info_request' && p1Parsed.tool === 'get_current_time') {
    const tRes = await currentTimeTool.execute({}, { timezone: req.timezone } as ToolContext);
    const r = (tRes?.result ?? {}) as { spoken?: string; date?: string; time?: string };
    const spoken = r.spoken || [r.date, r.time].filter(Boolean).join(', ') || "I couldn't determine the current time.";
    const parsed = { type: 'response', voice: spoken, text: null, action: null } as ReturnType<typeof parseContent>;
    const templatePass: GatewayResult = {
      ok: true, latency_ms: 0,
      raw: { content: spoken, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, model: 'template', provider: 'template' },
    };
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, '(current_time template)', templatePass,
      retainFields(retain.serverPersist, retain.userText, spoken, null), turnMeta);
    return finalize({
      t0, parsed, raw: pass1.raw!, stages: [p1Stage],
      usage: pass1.raw?.usage, latency: pass1.latency_ms, retain, sessionId, route,
    });
  }

  // ── info_request → dashie_help (SERVER-fulfilled KB retrieval + pass-2) ────
  // Product questions route to the curated KB (dashie-kb.generated.ts) instead of
  // web-search-and-hallucinate. Retrieval is deterministic keyword scoring — no network,
  // no billing. Pass-2 synthesizes the spoken answer from the retrieved chunks; on a miss
  // (found:false — including pricing, intentionally unauthored) a sentinel tells the model
  // to defer to support@dashieapp.com rather than invent settings paths or prices.
  // Design: 20260711_DASHIE_SKILL_DESIGN.md §4.2.
  if (p1Parsed.type === 'info_request' && p1Parsed.tool === 'dashie_help') {
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1);
    const hq = (typeof p1Parsed.query === 'object' && p1Parsed.query)
      ? String((p1Parsed.query as Record<string, unknown>).question ?? req.text)
      : (typeof p1Parsed.query === 'string' && p1Parsed.query ? p1Parsed.query : req.text);
    const tFetch = Date.now();
    const help = await dashieHelpTool.execute({ question: hq }, { timezone: req.timezone } as ToolContext);
    const helpResult = (help?.result ?? { found: false }) as { found?: boolean; chunks?: unknown[] };
    const fetchStage: Stage = {
      name: 'fetch_dashie_help', latency_ms: Date.now() - tFetch,
      result_count: helpResult.chunks?.length ?? 0,
    };
    const helpData = helpResult.found ? helpResult : {
      found: false,
      note: 'No product-documentation entry matched this question. Do NOT invent settings ' +
        'locations, steps, prices, or features. Say you are not sure about that one and that ' +
        'the user can email support@dashieapp.com.',
      question: hq,
    };
    return await secondPass(io, deps, t0, 'dashie-help', helpData, [p1Stage, fetchStage], pass1, provider, modelId, context, sessionId, retain, route);
  }

  // ── info_request → personalities (self-fulfilled: catalog read + synthesis) ────
  // BOTH "what personalities do you have?" and "switch to the princess personality" route
  // here. The catalog is read LIVE from personality_templates — personalities arrive by
  // migration (princess/wizard, 2026-07-17), so a hand-authored list in a prompt or KB chunk
  // would silently go stale on the next one. The switch branch also NEEDS the live rows: it
  // resolves the spoken words to a real `key` it can see, instead of guessing one that would
  // fail closed at the client.
  if (p1Parsed.type === 'info_request' && p1Parsed.tool === 'personalities') {
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1);
    const tFetch = Date.now();
    const choices = io.listPersonalities
      ? await io.listPersonalities(supabase)
      : await listAvailablePersonalities(supabase);
    const fetchStage: Stage = {
      name: 'fetch_personalities', latency_ms: Date.now() - tFetch, result_count: choices.length,
    };
    // An empty catalog (RLS change, transient read failure) must NOT degrade into a switch to
    // a guessed key — that would silently repoint the household's assistant. Fail closed.
    const catalogData = choices.length
      ? { found: true, current_personality: personality?.name ?? 'Dashie', personalities: choices }
      : {
        found: false,
        note: 'Could not read the personality list. Say you had trouble checking just now and ' +
          'to try again in a moment. Do NOT name personalities from memory and do NOT switch.',
      };
    const pTurn = await secondPass(io, deps, t0, 'personalities', catalogData, [p1Stage, fetchStage], pass1, provider, modelId, context, sessionId, retain, route);
    // Deterministic voice enrichment (VOICE_SINGLE_PATH Batch 3 item 11): the catalog rows are
    // RIGHT HERE, so attach the switched-to personality's voice fields to the action instead of
    // making every client re-lookup the template (native Kotlin has no template service at all —
    // this is what lets set_personality apply natively on kiosk AND full mode). Deterministic
    // post-processing, never model-echoed; additive params, so old clients simply ignore them.
    // (Shared with the direct pass-1 action path above — enrichSetPersonalityAction.)
    const enrichedRow = enrichSetPersonalityAction(pTurn.action, choices);
    // In-character greeting replaces the switch narration (see the direct-path note above).
    const greeting = enrichedRow?.greeting_fallback?.trim();
    if (greeting) pTurn.voice = greeting;
    // Trailing-voice fix — this turn speaks in the switched-to voice (see direct-path note).
    await restampVoiceForSwitch(io, supabase, voiceCtx, enrichedRow);
    return pTurn;
  }

  // ── multi (one turn, several DIFFERENT tools) ─────────────────────────────
  // Capability-gated: pass-1 only emits this when the caller declared `multi` (buildPrompt). The
  // normalizer (multi.ts) guarantees the shape here — >= 2 ACTION_TOOLS steps, no dupes — OR hands
  // an empty-multi for the error path. Fan each step to its existing fulfillment (HA resolves an
  // action server-side; music/video_feeds ride back as client_tools), return ONE turn carrying the
  // model's single `voice` + Turn.steps. See multi-dispatch.ts + 20260717 build plan Part A.
  if (p1Parsed.type === 'multi') {
    const stepsIn = p1Parsed.steps ?? [];
    // Empty-multi: nothing survived normalization → nothing to do. Do NOT voice it (speaking the
    // confirmation would claim work we never did). Surface as unsupported so the caller can retry
    // via its native path — same treatment as an unfulfillable tool.
    if (stepsIn.length < 2) {
      await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1);
      const emptyMulti = { type: 'response', voice: '', text: null, action: null } as ReturnType<typeof parseContent>;
      return finalize({ t0, parsed: emptyMulti, raw: pass1.raw, stages: [p1Stage], usage: pass1.raw.usage, latency: pass1.latency_ms, unsupported_tool: 'multi', sessionId, route: 'multi' });
    }
    const dispatch = await dispatchMultiTurn(stepsIn, {
      callGateway: io.callGateway,
      provider,
      modelId,
      context,
      userText: req.text,
      entities: req.provided_context?.ha_entities,
    });
    // The brain speaks ONE confirmation for the whole turn — retain it as the spoken text (the
    // device fulfills the steps but the user hears `voice`).
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1,
      retainFields(retain.serverPersist, retain.userText, typeof p1Parsed.voice === 'string' ? p1Parsed.voice : '', null), turnMeta);
    const multiParsed = { type: 'multi', voice: p1Parsed.voice, text: null, action: null } as ReturnType<typeof parseContent>;
    return finalize({
      t0, parsed: multiParsed, raw: pass1.raw,
      stages: [p1Stage, ...dispatch.stages],
      usage: sumUsage([pass1.raw.usage, dispatch.usage]),
      latency: pass1.latency_ms + dispatch.latencyMs,
      retain, sessionId, route: 'multi', steps: dispatch.steps,
    });
  }

  // ── info_request → unsupported tool ───────────────────────────────────────
  // Fell back to the caller's native path → not a Dashie spoken turn → no transcript.
  // Graceful by design, but LOUD: the model routing to a tool with no brain branch is
  // prompt/schema drift (a renamed tool, or a hand-list ghost) — logPass alone hides it.
  console.warn(`[orchestrator] DROP: pass-1 routed to unsupported tool '${p1Parsed.tool}' — falling back to caller's native path`);
  await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1);
  return finalize({ t0, parsed: p1Parsed, raw: pass1.raw, stages: [p1Stage], usage: pass1.raw.usage, latency: pass1.latency_ms, unsupported_tool: p1Parsed.tool, sessionId, route });
}

// recoverHaAction moved to multi-dispatch.ts (shared by secondPass here and the multi HA legs).

/** Map a parsed pass-1 response to a canonical route label for grading:
 *  'direct' (answered, no tool), 'action' (HA/device command), 'multi' (a compound turn), or
 *  the tool name (web_search | home_assistant | calendar-events | weather | sports | …). */
function routeOf(parsed: ReturnType<typeof parseContent>): string {
  if (!parsed) return 'direct';
  if (parsed.type === 'response') return 'direct';
  if (parsed.type === 'action') return 'action';
  if (parsed.type === 'multi') return 'multi';
  if (parsed.type === 'info_request') return parsed.tool || 'unknown';
  return 'direct';
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function secondPass(
  io: OrchestratorIO,
  deps: OrchestrationDeps,
  t0: number,
  inquiryType: string,
  retrievedData: unknown,
  priorStages: Stage[],
  pass1: GatewayResult,
  provider: string,
  modelId: string,
  context: unknown,
  sessionId: string,
  retain: RetainCtx,
  route: string,
  grounding = false,
): Promise<Turn> {
  const prompt = buildPrompt({ userRequest: deps.req.text, inquiryType, retrievedData, context: context as never });
  // Live progress: tool fetch done, synthesis pass starting. Reads as the 3rd act of
  // the progression the client shows — "Thinking…" (pass-1) → tool status
  // ("Searching the web…") → "Finalizing…" (this synthesis pass) → the answer.
  deps.onStage?.({ stage: 'synthesizing', status: 'Finalizing', elapsed_ms: Date.now() - t0 });
  // grounding=true → Gemini does the web search itself inside this call (no Tavily).
  // The home_assistant second pass EMITS AN ACTION (execute_commands + entity_id) — that's a
  // decision, not narration, so it must be deterministic too. Every other inquiry type (web-search,
  // dashie-help, sports) synthesizes prose and keeps the warmth.
  const kind = inquiryType === 'home-assistant' ? 'decide' : 'narrate';
  const pass2 = await io.callGateway({ provider, prompt, modelId, grounding, kind });
  if (!pass2.ok || !pass2.raw) {
    return errorTurn(t0, pass2, [...priorStages, stageErr('pass2', pass2)]);
  }
  // pass2 must be terminal — but models sometimes RE-EMIT a tool request here instead of
  // answering (seen 2026-07-06, FB34: grounded Gemini answered the web-search synthesis pass
  // with another fenced info_request/web_search; finalize passed it through, the client had no
  // text/voice to render and displayed the raw JSON). We don't loop tools — same HARD RULE as
  // pass-1: never surface a tool request / unparsed JSON-ish payload as the answer; speak a
  // clarification instead.
  let parsed = parseContent(pass2.raw.content);
  // Fix C — recover a mis-enveloped home_assistant action. On pass-2 the model sometimes RE-EMITS
  // the tool request instead of the action: {type:'info_request', tool:'home_assistant',
  // query:{commands:[…]}}. The commands are CORRECT — only the envelope is wrong (observed
  // intermittently across gemma/gpt-oss/qwen3, amplified by large entity lists). Rather than throw
  // a valid resolution away as a clarify, lift the commands into the terminal action shape. Scoped
  // to the home-assistant pass (its only valid terminal output IS an action) → safe, deterministic,
  // model-agnostic. See 20260714_LOCAL_MODEL_BENCHMARK_RESULTS.md.
  if (inquiryType === 'home-assistant' && parsed && parsed.type === 'info_request') {
    const recovered = recoverHaAction(parsed);
    if (recovered) parsed = recovered;
  }
  const jsonish = /^\s*(```[a-z]*\s*)?[{[]/i.test(pass2.raw.content || '');
  if ((parsed && parsed.type === 'info_request') || (!parsed && jsonish)) {
    console.warn(`⚠️ pass2 non-terminal (${parsed?.type ?? 'unparsed JSON-ish'}) — clarifying instead of leaking`);
    const clarifyVoice = "Sorry, I didn't quite catch that — could you say it again?";
    parsed = { type: 'response', voice: clarifyVoice, text: null, action: null } as ReturnType<typeof parseContent>;
  }
  // Tool decision comes from pass-1 (the info_request that triggered this synthesis) + the route.
  await logPass(io, deps, REQUEST_TYPE, deps.req.endpoint_id, sessionId, prompt, pass2,
    retainFields(retain.serverPersist, retain.userText, responseTextOf(parsed, pass2.raw), parsed?.text ?? null),
    toolMeta(parseContent(pass1.raw?.content ?? ''), route, (context as { caps?: CapsSnapshot } | null)?.caps));
  const p2Stage = passStage('pass2', pass2, parsed?.type);
  const usage = sumUsage([pass1.raw?.usage, pass2.raw.usage]);
  // Image enrichment on the SYNTHESIS pass. Pass-1 has resolved hints since forever (~:619),
  // but secondPass never did — so any answer that needed a tool was structurally unable to
  // show a picture no matter what the model emitted ("what's the #1 song?" → web search →
  // hint silently dropped). Field-reported 2026-07-18 as "it shows pictures only sparingly";
  // the real axis was direct-answer vs tool-routed, not the prompt wording.
  // Scoped to web-search deliberately: home-assistant emits an action (not prose) and sports
  // owns the card slot via its own finalize calls (~:823/:841). buildPrompt suppresses the
  // `image` field on the other pass-2 types so the model can't claim a picture we'd drop.
  const imageHint = (parsed as { image?: { searchTerms?: string } } | null)?.image;
  const imageCard = (inquiryType === 'web-search'
      && (context as { retrievePicturesEnabled?: boolean } | null)?.retrievePicturesEnabled !== false
      && parsed?.type === 'response'
      && imageHint?.searchTerms)
    ? await resolveImageHint(parsed, deps.token, sessionId, io.toolConn)
    : undefined;
  return finalize({ t0, parsed, raw: pass2.raw, stages: [...priorStages, p2Stage], usage, latency: (pass1.latency_ms + pass2.latency_ms), retain, sessionId, route, structured_data: imageCard ?? undefined });
}

/** Resolve a `response` turn's `image` hint into a {type:'image'} card via the
 *  shared image_search resolver (which calls serper-image-search → meters + bills).
 *  Returns undefined on no-hint / no-result / error — enrichment is best-effort and
 *  never fails the turn. */
async function resolveImageHint(
  parsed: ReturnType<typeof parseContent>,
  token: string,
  sessionId: string | undefined,
  // io.toolConn — required on the Node add-on runtime (no Deno env to fall back to);
  // the cloud shell omits it and image_search reads its own env.
  conn?: { supabaseUrl: string; anonKey: string },
): Promise<unknown> {
  const hint = (parsed as { image?: { searchTerms?: string; criteria?: string; fallback?: string } } | null)?.image;
  if (!hint?.searchTerms) return undefined;
  try {
    let synth = await synthesizeImage(hint.searchTerms, hint.criteria, { ...conn, jwt: token, sessionId });
    // Robustness (README rule 4): retry with the model's generic fallback query
    // before giving up, rather than returning no card on a too-specific miss.
    if (!synth.card && hint.fallback && hint.fallback !== hint.searchTerms) {
      synth = await synthesizeImage(hint.fallback, hint.criteria, { ...conn, jwt: token, sessionId });
    }
    return synth.card ?? undefined;
  } catch (_e) {
    return undefined;
  }
}

/** The user-facing spoken text for retention — the parsed voice, else raw content. */
function responseTextOf(parsed: ReturnType<typeof parseContent>, raw: NonNullable<GatewayResult['raw']>): string {
  return parsed?.voice || raw.content || '';
}

function finalize(
  { t0, parsed, raw, stages, usage, latency, unsupported_tool, retain, sessionId, route, structured_data, client_tool, metadata, steps }: {
    t0: number;
    parsed: ReturnType<typeof parseContent>;
    raw: NonNullable<GatewayResult['raw']>;
    stages: Stage[];
    usage?: Usage | { input_tokens?: number; output_tokens?: number; total_tokens?: number; reasoning_tokens?: number };
    latency: number;
    unsupported_tool?: string;
    retain?: RetainCtx;
    sessionId?: string;
    route?: string;
    structured_data?: unknown;
    client_tool?: { tool: string; query?: unknown } | null;
    metadata?: Record<string, unknown>;   // caller-supplied flags (e.g. calendar_context_used)
    steps?: TurnStep[];                    // resolved legs of a `multi` turn (client runs each)
  },
): Turn {
  const type = parsed?.type || 'response';
  // Caller-mode retention signal: only for real spoken turns (not unsupported fall-backs).
  const callerRetain = !!retain?.callerRetain && !unsupported_tool && (type === 'response' || type === 'action');
  // A tool call (info_request / multi) carries NO spoken answer by design — the device runs the
  // tool and speaks its OWN confirmation (music: "Playing X"; calendar/weather/cameras: the tool's
  // voice). The `|| raw.content` salvage exists for a MALFORMED response/action where the model
  // failed to fill `voice`; applying it to a tool call reads the raw JSON aloud AND paints it on
  // screen. Field bug 2026-07-17 (Mio): "play jazz and dim the lights" → a music info_request with
  // no voice → the whole `{"type":"info_request",...}` blob was spoken + displayed. Empty is right.
  const isToolCall = type === 'info_request' || type === 'multi';
  // Same rule, second axis (field bug 2026-07-18, Samsung + Mio): a PARSED action/response that
  // left `voice` null also has raw.content == that very JSON, so salvaging reads the blob aloud —
  // a personality switch spoke its own {"type":"action","command":"set_personality",…} out loud,
  // and the fenced variant tripped the pass-2 clarify instead. Salvage only when parsing FAILED,
  // which is the case the salvage was actually for (raw.content is genuine prose there).
  const salvage = parsed ? '' : raw.content;
  return {
    ok: true,
    type,
    voice: parsed?.voice || (isToolCall ? '' : salvage) || '',
    text: parsed?.text ?? null,
    action: parsed?.action ?? null,
    parsed_ok: !!parsed,
    raw_content: raw.content,
    usage: normalizeUsage(usage),
    model: raw.model || '',
    provider: raw.provider || '',
    latency_ms: latency,
    total_latency_ms: Date.now() - t0,
    unsupported_tool: unsupported_tool || undefined,
    client_tool: client_tool || undefined,
    route,
    steps: steps && steps.length ? steps : undefined,
    stages,
    // Echo the session id (== ai_interactions.session_id) so callers can join the
    // HA-local transcript to the Supabase usage rows in the console (§17).
    conversation_id: sessionId,
    metadata: (callerRetain || metadata)
      ? { ...(metadata ?? {}), ...(callerRetain ? { retain_transcript: true } : {}) }
      : undefined,
    structured_data,
  };
}

/** Terminal "out of credits" turn (CR1, build plan §3.5) — no AI call, no deduction,
 *  no logging. Empty `voice` so a caller that ignores `metadata.degraded` simply says
 *  nothing (never speaks a cloud reply it can't afford); a CR2-aware caller reads
 *  `metadata.degraded === 'insufficient_credits'` and renders the prompt-to-choose. */
function insufficientCreditsTurn(t0: number, balance: number): Turn {
  return {
    ok: true,
    type: 'response',
    voice: '',
    text: null,
    action: null,
    parsed_ok: true,
    raw_content: '',
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    model: '',
    provider: '',
    latency_ms: 0,
    total_latency_ms: Date.now() - t0,
    route: 'insufficient_credits',
    stages: [{ name: 'insufficient_credits', latency_ms: 0 }],
    metadata: { degraded: 'insufficient_credits', balance },
  };
}

/** Terminal "rate limited" turn (CR3, build plan §3.5) — the per-account backstop tripped
 *  (a looping/compromised endpoint). No AI call, no deduction, no log. Empty `voice` (a
 *  caller that ignores metadata says nothing); `metadata.degraded='rate_limited'` +
 *  retry_after_seconds for a caller that wants to surface "try again shortly". */
function rateLimitedTurn(t0: number, retryAfterSeconds: number): Turn {
  return {
    ok: true,
    type: 'response',
    voice: '',
    text: null,
    action: null,
    parsed_ok: true,
    raw_content: '',
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    model: '',
    provider: '',
    latency_ms: 0,
    total_latency_ms: Date.now() - t0,
    route: 'rate_limited',
    stages: [{ name: 'rate_limited', latency_ms: 0 }],
    metadata: { degraded: 'rate_limited', retry_after_seconds: retryAfterSeconds },
  };
}

/** Terminal end-intent turn ("thanks"/"shut up"/…) — closes the dialog, no AI call, no
 *  deduction, no logging. Silent (voice=null) so nothing is spoken/re-heard. Every surface
 *  honors metadata.end_conversation. */
function endIntentTurn(t0: number): Turn {
  return {
    ok: true,
    type: 'response',
    voice: '',
    text: null,
    action: null,
    parsed_ok: true,
    raw_content: '',
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    model: '',
    provider: '',
    latency_ms: 0,
    total_latency_ms: Date.now() - t0,
    route: 'end_intent',
    stages: [{ name: 'end_intent_shortcircuit', latency_ms: 0 }],
    metadata: { short_circuit: 'end_intent', end_conversation: true },
  };
}

/** Terminal "didn't catch that" turn for a noise misfire — no AI call, no
 *  deduction, no logging. */
function noiseTurn(t0: number): Turn {
  const msg = NOISE_REPLY;
  return {
    ok: true,
    type: 'response',
    voice: msg,
    text: null,
    action: null,
    parsed_ok: true,
    raw_content: msg,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    model: '',
    provider: '',
    latency_ms: 0,
    total_latency_ms: Date.now() - t0,
    route: 'noise',
    stages: [{ name: 'noise_shortcircuit', latency_ms: 0 }],
    metadata: { short_circuit: 'noise' },
  };
}

function errorTurn(t0: number, result: { error?: string; latency_ms: number }, stages: Stage[]): Turn {
  return {
    ok: false,
    type: 'error',
    voice: '',
    text: null,
    action: null,
    parsed_ok: false,
    raw_content: '',
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    model: '',
    provider: '',
    latency_ms: result.latency_ms,
    total_latency_ms: Date.now() - t0,
    route: 'error',
    stages,
    metadata: { error: result.error },
  };
}

function passStage(name: string, r: GatewayResult, type?: string): Stage {
  return { name, latency_ms: r.latency_ms, model: r.raw?.model, provider: r.raw?.provider, usage: normalizeUsage(r.raw?.usage), type: type || 'response' };
}

function stageErr(name: string, r: { latency_ms: number; error?: string }): Stage {
  return { name, latency_ms: r.latency_ms, error: r.error };
}

function sumUsage(usages: Array<{ input_tokens?: number; output_tokens?: number; total_tokens?: number; reasoning_tokens?: number } | undefined>): Usage {
  const total: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0, reasoning_tokens: 0 };
  for (const u of usages) {
    if (!u) continue;
    total.input_tokens += u.input_tokens || 0;
    total.output_tokens += u.output_tokens || 0;
    total.total_tokens += u.total_tokens || 0;
    total.reasoning_tokens = (total.reasoning_tokens || 0) + (u.reasoning_tokens || 0);
  }
  return total;
}

function normalizeUsage(u?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; reasoning_tokens?: number }): Usage {
  return {
    input_tokens: u?.input_tokens || 0,
    output_tokens: u?.output_tokens || 0,
    total_tokens: u?.total_tokens || ((u?.input_tokens || 0) + (u?.output_tokens || 0)),
    reasoning_tokens: u?.reasoning_tokens || 0,
  };
}

function formatHistory(history?: VoiceRequest['history']): string {
  if (!Array.isArray(history) || history.length === 0) return '';
  const lines = history.slice(-4).map((h) => `${h.role === 'user' ? 'User' : 'You'}: ${h.text || ''}`);
  return `Recent conversation:\n${lines.join('\n')}\n`;
}

async function logPass(
  io: OrchestratorIO,
  deps: OrchestrationDeps,
  requestType: string,
  endpointId: string,
  sessionId: string,
  prompt: string,
  pass: GatewayResult,
  retainText: { prompt_text?: string; response_text?: string } = {},
  // Per-turn tool decision {tool_used, response_type, tool_trace} — populated on terminal passes
  // so a row carries WHAT it did (route + tool + args), not just what it said. See toolMeta().
  meta: Record<string, unknown> = {},
): Promise<void> {
  const usage = pass.raw?.usage || {};
  // Thread A #2: the logged tool_trace is fleet-wide analysis metadata — redact free-text
  // arg values (search strings, calendar keywords, names) on the LOGGED COPY ONLY, without
  // mutating meta (the same args object is referenced by the Turn's client_tool, which the
  // device needs intact to fulfill the tool). Structured enum args pass through verbatim.
  const trace = meta.tool_trace as { args?: unknown } | undefined;
  const logMeta = (trace && trace.args != null)
    ? { ...meta, tool_trace: { ...trace, args: await redactToolArgs(trace.args) } }
    : meta;
  // Parse once, reuse for BOTH parsed_ok and the miss classification below.
  // A template pass is locally synthesized prose (provider='template'), not model JSON.
  const isTemplate = pass.raw?.provider === 'template';
  const parsed = parseContent(pass.raw?.content ?? '');
  // Did THIS pass's output satisfy the JSON contract? Computed here, not at the ~18 call sites, so
  // every logged pass carries it — including the non-terminal pass-1 rows that pass no `meta`.
  // Template → null (no model JSON to parse), so it can't drag down the measured failure rate.
  const parsedOk = isTemplate ? null : !!parsed;
  // Miss (WS-F.0a) applies only to ANSWER rows — a pass whose parsed output is a spoken reply
  // (response/action), not a tool call (info_request). This makes EXACTLY ONE row per turn carry
  // miss (true/false); tool-call passes get null and are excluded from the miss-rate denominator.
  // A template answer has no parsed `voice` but its route is known via meta → classify on route.
  const route = (logMeta.tool_trace as { route?: string } | undefined)?.route
    ?? (meta.tool_trace as { route?: string } | undefined)?.route;
  // An ANSWER row = the terminal row of the turn (exactly one per turn). Three shapes:
  //   • a spoken reply (response/action) or a template answer, OR
  //   • a DEVICE-FULFILLED tool answer (calendar/weather/music) — parsed type is info_request but
  //     the row carries a terminal tool_trace.route (turnMeta) and the device speaks. Those are
  //     successful answers and MUST count in the denominator, else the miss rate is inflated.
  // A NON-terminal pass-1 tool-call row is bare (no meta → no route) → miss=null → excluded.
  const isAnswerRow = isTemplate || parsed?.type === 'response' || parsed?.type === 'action' || !!route;
  const missClass = isAnswerRow
    ? classifyMiss(route, parsed?.voice ?? (isTemplate ? (pass.raw?.content ?? null) : null))
    : { miss: null as boolean | null, reason: null as string | null };
  await io.logInteraction(deps.token, {
    parsed_ok: parsedOk,
    miss: missClass.miss,
    miss_reason: missClass.reason,
    session_id: sessionId,
    request_type: requestType,
    request_length: prompt.length,
    model: pass.raw?.model || 'unknown',
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    total_tokens: usage.total_tokens || ((usage.input_tokens || 0) + (usage.output_tokens || 0)),
    api_latency_ms: pass.raw?.latency || 0,
    total_latency_ms: pass.latency_ms,
    success: true,
    endpoint_id: endpointId,
    // Transcript text (§17): present only on a terminal pass when serverPersist is on.
    ...retainText,
    ...logMeta,
  });

  // Debit AI tokens AT-SOURCE (#7): the cloud IO debits in-process from the REAL counts we just
  // logged (same predicate the log_ai_interaction op used); the Node/on-prem shell omits
  // debitAiUsage (BYOK never debits). Gated INSIDE the impl by debit_at_source, so this is inert
  // until the cutover. Fail-soft — debitBalance never throws.
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  if (io.debitAiUsage && (inTok || outTok)) {
    await io.debitAiUsage(deps.supabase, deps.userId, {
      model: pass.raw?.model || 'unknown',
      inputTokens: inTok,
      outputTokens: outTok,
      requestType,
      sessionId,
    });
  }
}

/** Per-turn tool decision for the log: the route + the pass-1 tool call + its args (null on a
 *  direct no-tool response) + the capability snapshot. Populates the existing
 *  tool_used/response_type columns + tool_trace. Args here are the RAW model args — logPass
 *  redacts free-text values on the logged copy (Thread A #2). */
function toolMeta(parsed: ReturnType<typeof parseContent>, route: string, caps?: CapsSnapshot): Record<string, unknown> {
  const tool = (parsed?.type === 'info_request' ? parsed.tool : null) ?? null;
  const args = (parsed?.type === 'info_request' ? parsed.query : null) ?? null;
  return { tool_used: tool, response_type: parsed?.type ?? null, tool_trace: { route, tool, args, ...(caps ? { caps } : {}) } };
}
