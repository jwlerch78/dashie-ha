// prompt.ts — assemble the AI prompt (the crown jewels).
//
// Ported from js/ai/prompts/prompt-builder.js buildPrompt (271–358), buildInquiryValues (161–260),
// languageNameFor (112–129). Templates + fillTemplate + formatDateTime come from the GENERATED
// templates.ts (single source: js/ai/prompts/*.md via scripts/bundle-ai-prompts.js). Synchronous —
// no fetch/loadTemplate; templates are imported directly. Build plan §12.

import {
  AVAILABLE_TOOLS_LIST,
  BASE_CONTEXT,
  fillTemplate,
  formatDateTime,
  INQUIRY_CALENDAR_EVENTS,
  INQUIRY_CHORES,
  INQUIRY_DASHIE_HELP,
  INQUIRY_FAMILY_LOCATIONS,
  INQUIRY_FAMILY_MEMBERS,
  INQUIRY_HOME_ASSISTANT,
  INQUIRY_LOCATION_EVENTS,
  INQUIRY_PERSONALITIES,
  INQUIRY_REWARDS,
  INQUIRY_SPORTS,
  INQUIRY_TRAVEL_TIME,
  INQUIRY_WEATHER,
  INQUIRY_WEB_SEARCH,
  RESPONSE_FORMAT_FULL,
  RESPONSE_FORMAT_INITIAL,
  RESPONSE_FORMAT_MULTI,
} from './templates.ts';
import { buildPersonalityPrompt } from './personality-prompt-builder.js';
import type { PromptContext } from './types.ts';

// inquiryType (matches webapp loadTemplate(`inquiries/${type}.md`)) → bundled constant.
const INQUIRY_BY_TYPE: Record<string, string> = {
  'home-assistant': INQUIRY_HOME_ASSISTANT,
  'web-search': INQUIRY_WEB_SEARCH,
  'calendar-events': INQUIRY_CALENDAR_EVENTS,
  'family-members': INQUIRY_FAMILY_MEMBERS,
  'chores': INQUIRY_CHORES,
  'rewards': INQUIRY_REWARDS,
  'location-events': INQUIRY_LOCATION_EVENTS,
  'travel-time': INQUIRY_TRAVEL_TIME,
  'family-locations': INQUIRY_FAMILY_LOCATIONS,
  'weather': INQUIRY_WEATHER,
  'sports': INQUIRY_SPORTS,
  'dashie-help': INQUIRY_DASHIE_HELP,
  'personalities': INQUIRY_PERSONALITIES,
};

// Maps Preferences locale codes → plain-English names the AI understands.
// Mirrors prompt-builder.js languageNameFor (112–129).
function languageNameFor(code: string): string {
  return ({
    'en-US': 'English',
    'en-GB': 'British English',
    'es-ES': 'Spanish',
    'es-US': 'Spanish',
    'fr-FR': 'French',
    'de-DE': 'German',
    'it-IT': 'Italian',
    'pt-BR': 'Brazilian Portuguese',
    'nl-NL': 'Dutch',
    'pl-PL': 'Polish',
    'hi-IN': 'Hindi',
    'ja-JP': 'Japanese',
    'ko-KR': 'Korean',
    'zh-CN': 'Simplified Chinese',
    // deno-lint-ignore no-explicit-any
  } as any)[code] || code;
}

// Don't OFFER a tool this turn isn't allowed to use — omit its line so the model can't
// route to it (cleaner than listing it then forbidding it). The orchestrator/client keep
// hard guards as safety nets.
//
//  - T3 (web search OFF for the account): omit web_search. Sports/weather etc. stay.
//  - announcement (this turn IS a scheduled action firing): omit schedule_action. The
//    device replays a stored prompt through the pipeline at fire time, so the brain sees
//    a user-like utterance and could route it straight back to schedule_action — a fired
//    action re-scheduling ITSELF, compounding on every fire. Not offering the tool makes
//    that impossible by construction, which is why the client-side guard can't be the
//    primary defense: being after-the-fact, it could only tell a self-reschedule from a
//    real user request by guessing (a 15s window that silently ate the USER's own
//    scheduling requests when an unrelated action happened to fire nearby).
//  - device-only tools the CALLER can't fulfill: omit them. See DEVICE_ONLY_TOOLS below.
export type ToolsContext = {
  webSearchEnabled?: boolean;
  announcement?: boolean;
  /** `client_fulfilled_tools` from the request — what this device/caller can actually run. */
  clientTools?: string[];
  /** Household calendar-write policy, VOICE dimension (calendar.writeAccess ∈ voice|both).
   *  false → omit calendar_write so the model can't route to it (voice writes off / not opted
   *  in). undefined → keep (unchanged for callers that don't set it). The orchestrator + client
   *  keep hard guards. Mutating a real family calendar must be opt-in. */
  calendarWriteEnabled?: boolean;
};

/**
 * Device-fulfilled tools with NO server fallback: if the caller can't run it, nobody can.
 *
 * Offering one anyway is not harmless — the model is TOLD the capability exists, calls it,
 * and the turn is burned on an apology (a tablet with no Music Assistant, an HA satellite
 * with no cameras). Unlike weather/calendar, there is nothing the edge can self-fulfill.
 *
 * Absent `client_fulfilled_tools` still means "caller fulfills everything" (old clients,
 * logged-in tablet) — this only ever REMOVES a tool a caller explicitly didn't claim, so a
 * client that hasn't been taught to declare capabilities is unaffected.
 *
 * ⚠️ Each name must be spelled the SAME in the prompt's tools list and in the WIRE
 * `client_fulfilled_tools` vocabulary. Those two namespaces are NOT identical in general —
 * the prompt says `weather_data`/`calendar_events` where the wire says `weather`/`calendar`.
 * A name that differs between them would make the gate silently no-op (never matching the
 * client's claim → always dropped, or never dropped). `music` and `video_feeds` are spelled
 * identically in both; keep it that way for anything added here.
 */
const DEVICE_ONLY_TOOLS = ['music', 'video_feeds', 'open_app'];

// Anchors inside RESPONSE_FORMAT_INITIAL that the multi block patches around — kept in sync
// with response-format-initial.md and with tools/voice-bench/prompt-probe.ts (the arm that
// proved the wording). The multi section (RESPONSE_FORMAT_MULTI) is inserted right BEFORE the
// CRITICAL line, and the ONE_OF header gains a "use MULTI only for…" hint, exactly as the probe
// patches it. Server-side + capability-gated (buildPrompt), so the static template and the
// console mirrors stay byte-identical and an old client never receives the block.
const MULTI_ANCHOR_ONE_OF = 'Respond with ONE of these JSON formats:';
const MULTI_ANCHOR_ONE_OF_PATCHED =
  'Respond with ONE of these JSON formats (use MULTI only for several DIFFERENT tools in one request):';
const MULTI_ANCHOR_CRITICAL = 'CRITICAL: Respond ONLY with raw JSON.';

/** Splice the capability-gated multi-emission block into an assembled pass-1 prompt. If either
 *  anchor moved (response-format-initial.md changed), return the prompt UNCHANGED rather than
 *  emit a half-patched prompt — the feature silently stays off, which is the safe failure. */
function injectMultiBlock(prompt: string): string {
  if (!prompt.includes(MULTI_ANCHOR_ONE_OF) || !prompt.includes(MULTI_ANCHOR_CRITICAL)) {
    console.warn('⚠️ multi block: anchors not found in initial prompt — emitting without multi');
    return prompt;
  }
  // Leading "\n" matches the prompt-probe multi arm byte-for-byte (its MULTI_SECTION opened with a
  // newline), so the benched decomposition numbers transfer to the deployed prompt exactly.
  return prompt
    .replace(MULTI_ANCHOR_ONE_OF, MULTI_ANCHOR_ONE_OF_PATCHED)
    .replace(MULTI_ANCHOR_CRITICAL, `\n${RESPONSE_FORMAT_MULTI}\n${MULTI_ANCHOR_CRITICAL}`);
}

/**
 * Examples must follow the OFFERING (2026-07-19, found live on the kiosk): the Tools list is
 * gated per-caller, but the templates' hand-authored Examples still demonstrated routing to
 * dropped tools ("When is Charlie's next game?" → calendar_events on a kiosk that can't
 * fulfill it). Taught-but-unoffered is exactly the contradiction that made haiku contort
 * into unparseable JSON → clarify → device silence. Strip any example line that names a tool
 * absent from this caller's offered set; lines naming no tool pass through.
 */
function dropUnofferedExamples(text: string, context: ToolsContext): string {
  const offered = new Set(offeredToolNames(context));
  return text.split('\n')
    .filter((line) => {
      const m = line.match(/tool:\s*"([a-z_]+)"/);
      return !m || offered.has(m[1]);
    })
    .join('\n');
}

function toolsListFor(context: ToolsContext): string {
  const drop: string[] = [];
  if (context.webSearchEnabled === false) drop.push('- web_search:');
  if (context.announcement === true) drop.push('- schedule_action:');
  if (context.calendarWriteEnabled === false) drop.push('- calendar_write:');
  if (Array.isArray(context.clientTools)) {
    for (const tool of DEVICE_ONLY_TOOLS) {
      if (!context.clientTools.includes(tool)) drop.push(`- ${tool}:`);
    }
    // calendar_events stays OFFERED to every caller (like weather), even one that doesn't claim
    // 'calendar'. Superseding the 2026-07-19 honest-handshake DROP: omitting the tool didn't make
    // the model decline — it substituted the nearest tool (haiku → get_current_time, gemini →
    // trivia; 0/2 declined, bench 2026-07-20). Instead the orchestrator SELF-FULFILLS a graceful
    // "calendar isn't set up on this device" for a non-claiming caller (see the calendar_events
    // branch), the same shape as calendar_write's decline and weather's server fulfill. The model
    // routes reliably (6/6) and we author the decline, so it's deterministic — not model goodwill.
    // calendar_WRITE is still dropped: its own branch declines defensively, and a write tool must
    // not tempt routing at all (FB13 raw-JSON-leak risk on old APKs).
    if (!context.clientTools.includes('calendar_write')) drop.push('- calendar_write:');
  }
  if (drop.length === 0) return AVAILABLE_TOOLS_LIST;
  return AVAILABLE_TOOLS_LIST.split('\n')
    .filter((l) => !drop.some((d) => l.trimStart().startsWith(d)))
    .join('\n');
}

/** Tool names actually offered to pass-1 for this context — derived from the SAME filtered
 *  list buildPrompt injects, so the logged capability snapshot (tool_trace.caps.tools,
 *  Thread A #1) can't drift from what the model really saw. */
export function offeredToolNames(context: ToolsContext): string[] {
  const names: string[] = [];
  for (const line of toolsListFor(context).split('\n')) {
    const m = line.match(/^\s*-\s*([A-Za-z0-9_]+)\s*:/);
    if (m) names.push(m[1]);
  }
  return names;
}

// Build values for inquiry-specific templates. Ported from prompt-builder.js buildInquiryValues.
// deno-lint-ignore no-explicit-any
function buildInquiryValues(inquiryType: string, data: any, baseValues: Record<string, any>): Record<string, any> {
  switch (inquiryType) {
    case 'calendar-events':
      return {
        ...baseValues,
        MEMBER_NAME: data.member_details?.nickname || data.member_details?.name || 'the family',
        TAGS_CONTEXT: data.metadata?.tag_filter ? ` and events related to ${data.metadata.tag_filter.join(', ')}` : '',
        TAGS_FILTER_NOTE: data.metadata?.tag_filter ? ` (filtered by: ${data.metadata.tag_filter.join(', ')})` : '',
        MEMBER_DETAILS: data.member_details ? JSON.stringify(data.member_details, null, 2) : 'No specific member filter applied.',
        CALENDAR_DATA: JSON.stringify(data, null, 2),
      };
    case 'family-members':
      return { ...baseValues, FAMILY_DATA: JSON.stringify(data, null, 2) };
    case 'web-search':
      return { ...baseValues, SEARCH_RESULTS: JSON.stringify(data, null, 2) };
    case 'dashie-help':
      return { ...baseValues, DASHIE_HELP_DATA: JSON.stringify(data, null, 2) };
    case 'personalities':
      return { ...baseValues, PERSONALITY_CATALOG: JSON.stringify(data, null, 2) };
    case 'chores':
      return {
        ...baseValues,
        CHORES_DATA: JSON.stringify(data.chores, null, 2),
        FAMILY_MEMBERS: JSON.stringify(data.family_members, null, 2),
        TODAYS_COMPLETIONS: JSON.stringify(data.todays_completions, null, 2),
      };
    case 'rewards':
      return {
        ...baseValues,
        REWARDS_DATA: JSON.stringify(data.rewards, null, 2),
        FAMILY_MEMBERS: JSON.stringify(data.family_members, null, 2),
        RECENT_REDEMPTIONS: JSON.stringify(data.recent_redemptions, null, 2),
      };
    case 'location-events':
      return {
        ...baseValues,
        MEMBER_NAME: data.member_details?.nickname || data.member_details?.name || data.query?.member_name || 'unknown',
        LOCATION_NAME: data.query?.location_name || 'any location',
        TIMEFRAME: data.query?.timeframe || 'today',
        EVENT_TYPE: data.query?.event_type || 'all events',
        MEMBER_DETAILS: data.member_details ? JSON.stringify(data.member_details, null, 2) : 'Member not found or not specified.',
        LOCATION_EVENTS_DATA: JSON.stringify(data, null, 2),
      };
    case 'travel-time':
      return {
        ...baseValues,
        EVENT_TITLE: data.event?.title || data.event?.summary || 'Unknown event',
        EVENT_START_TIME: data.event?.startTime || data.timing?.eventStart || 'Unknown time',
        EVENT_LOCATION: data.event?.location || data.destination?.address || 'Unknown location',
        ORIGIN_ADDRESS: data.origin?.address || 'Home',
        EVENT_NOTES: data.event?.description || data.event?.notes || 'No notes',
        TRAVEL_TIME_DATA: JSON.stringify(data, null, 2),
      };
    case 'family-locations':
      return {
        ...baseValues,
        MEMBER_NAME: data.member?.nickname || data.member?.name || data.query?.member_name || 'unknown',
        MEMBER_DETAILS: data.member ? JSON.stringify(data.member, null, 2) : 'Member not found.',
        LOCATION_DATA: JSON.stringify(data, null, 2),
      };
    case 'weather':
      return {
        ...baseValues,
        LOCATION_CITY: data.location?.city || 'Unknown',
        LOCATION_STATE: data.location?.state || '',
        WEATHER_DATA: JSON.stringify(data, null, 2),
      };
    case 'sports':
      return { ...baseValues, SPORTS_DATA: JSON.stringify(data, null, 2) };
    case 'home-assistant':
      return {
        ...baseValues,
        HA_ENTITIES: JSON.stringify(data.entities || [], null, 2),
        HA_ENTITIES_BY_DOMAIN: JSON.stringify(data.entities_by_domain || {}, null, 2),
        COMMAND_HINT: data.command_hint || baseValues.USER_REQUEST,
      };
    default:
      return baseValues;
  }
}

export interface BuildPromptArgs {
  userRequest: string;
  inquiryType: string | null;   // null = pass 1; 'web-search' | 'home-assistant' | … = pass 2
  // deno-lint-ignore no-explicit-any
  retrievedData?: any;
  context?: PromptContext;
}

/** Assemble the complete prompt. Pass 1 (inquiryType=null): base + response-format-initial.
 *  Pass 2: base + inquiry-<type> + response-format (full). Personality prefix/suffix wrap it. */
// §23.6 pre-fetch path: appended to the pass-1 prompt when the caller supplied
// `provided_context.sports`. The model voices the result in personality (escaping
// the deterministic template that has no LLM to apply character), or self-corrects
// if the pre-fetched game is wrong. The card renders separately from structured_data.
const PROVIDED_SPORTS_BLOCK = `## Pre-fetched Sports Data
Sports data has ALREADY been retrieved for the user's question — do NOT request it again:
\`\`\`json
{{PROVIDED_SPORTS}}
\`\`\`
If this data answers the question, reply with type "response", leading with the result **in your personality's voice** (a greeting or flourish is welcome; keep the score itself factual). If the data is the wrong game/team or empty, instead reply with type "info_request", tool "sports", and a corrected query.`;

// Calendar-color plan (20260711): pre-fetched calendar window appended to pass-1 when the
// caller supplied `provided_context.calendar`. The model digests it directly — single AND
// multi-event — with member attribution from the roster; the device already holds the
// matching card, so the reply must never enumerate the list. Uncovered window → the model
// falls back to the calendar_events tool (today's client_tool path, nothing regresses).
const PROVIDED_CALENDAR_BLOCK = `## Pre-fetched Calendar Data
The family calendar for {{TIME_RANGE}} has ALREADY been retrieved for the user's question — do NOT request it again:
\`\`\`json
{{PROVIDED_CALENDAR}}
\`\`\`
{{MEMBERS_SECTION}}Answer from this data with type "response", in your personality's voice:
- Attribute events to people using each event's \`assigned_to\` matched against the family members — say "Charlie's soccer practice", not the raw calendar name. Use nicknames when present.
- ONE event: describe it naturally in one sentence — whose it is, what, and when. Mention the location only if it's a real place name (never a URL or meeting link).
- MULTIPLE events: an intelligent digest in at most two sentences — the count, the shape of the schedule (a busy morning, a free evening, back-to-back appointments), and one or two notable items. NEVER read the full list aloud — the events are already shown on screen.
- If \`truncated\` is true, this list is only the FIRST \`events.length\` of \`total\` events — NEVER say something isn't on the calendar; if you don't see what was asked about, say the schedule is packed and you don't see it among the first ones, and point to the on-screen list.
- Otherwise this data is the complete calendar for {{TIME_RANGE}}: if nothing matches what was asked, say so plainly — do not guess.
- If the user asked about a time window this data does NOT cover, instead reply with type "info_request", tool "calendar_events", and the correct query.`;

function providedCalendarBlock(provided: unknown): string {
  const cal = (provided ?? {}) as { time_range?: string; total?: number; truncated?: boolean; events?: unknown[]; members?: unknown[] };
  const timeRange = cal.time_range || 'the requested period';
  const members = Array.isArray(cal.members) && cal.members.length
    ? `Family members (for attribution):\n\`\`\`json\n${JSON.stringify(cal.members, null, 2)}\n\`\`\`\n`
    : '';
  const events = cal.events ?? [];
  // Serialize total/truncated ALONGSIDE the events — the truncation-honesty rule in the
  // block reads them (a list that was silently cut caused a false "no doctor appointments").
  const payload: Record<string, unknown> = { total: cal.total ?? events.length, events };
  if (cal.truncated) payload.truncated = true;
  return PROVIDED_CALENDAR_BLOCK
    .replaceAll('{{TIME_RANGE}}', timeRange)
    .replace('{{PROVIDED_CALENDAR}}', JSON.stringify(payload, null, 2))
    .replace('{{MEMBERS_SECTION}}', members);
}

export function buildPrompt({ userRequest, inquiryType, retrievedData, context = {} }: BuildPromptArgs): string {
  const dateTime = formatDateTime(context.timezone);

  // Custom personality config → prefix/suffix fragments.
  let personalityConfig: { name?: string; responsePrefix?: string; responseSuffix?: string } | null = null;
  if (context.customPersonalityConfig) {
    // personality-prompt-builder.js is generated JS; its JSDoc types are loose, so cross the
    // boundary via `any` rather than fight the inferred {Object} return / strict param types.
    // deno-lint-ignore no-explicit-any
    const result = ((buildPersonalityPrompt as any)(context.customPersonalityConfig) || {}) as {
      responsePrefix?: string;
      responseSuffix?: string;
    };
    personalityConfig = {
      name: context.customPersonalityConfig.name,
      responsePrefix: result.responsePrefix,
      responseSuffix: result.responseSuffix,
    };
  }

  // Language: 'system' or absent → no instruction (don't waste tokens on a no-op line).
  const languageCode = context.language || 'system';
  const languageInstruction = (languageCode && languageCode !== 'system')
    ? `Respond in ${languageNameFor(languageCode)}.`
    : '';

  const toolsList = toolsListFor(context);

  // deno-lint-ignore no-explicit-any
  const baseValues: Record<string, any> = {
    DATE_TIME: dateTime,
    USER_REQUEST: userRequest,
    CHAT_HISTORY: context.chatHistory || '',
    AVAILABLE_TOOLS_LIST: toolsList,
    LANGUAGE_INSTRUCTION: languageInstruction,
    // Room awareness: the device's HA area (or '' when unknown → the template's fallback prose).
    // Rendered as {{DEVICE_AREA}} in the home_assistant prompt for room-relative resolution.
    DEVICE_AREA: context.deviceArea || '',
    ...context,
  };

  let prompt = fillTemplate(BASE_CONTEXT, baseValues);

  // Personality prefix (prepend).
  if (personalityConfig) {
    prompt = (personalityConfig.responsePrefix || '') + '\n\n' + prompt;
  }

  // §23.6: pre-fetched sports on pass-1 → the model voices it in personality (or
  // emits a corrected info_request if the supplied data is wrong). Single pass.
  if (!inquiryType && context.providedSports) {
    prompt += '\n\n' + PROVIDED_SPORTS_BLOCK.replace('{{PROVIDED_SPORTS}}', JSON.stringify(context.providedSports, null, 2));
  }

  // 20260711: pre-fetched calendar window on pass-1 → the model answers schedule questions
  // directly with an intelligent digest (member-attributed), or falls back to the
  // calendar_events tool when the asked window isn't covered. Single pass.
  if (!inquiryType && context.providedCalendar) {
    prompt += '\n\n' + providedCalendarBlock(context.providedCalendar);
  }

  if (inquiryType && retrievedData) {
    const inquiryTemplate = INQUIRY_BY_TYPE[inquiryType];
    if (inquiryTemplate) {
      const inquiryValues = buildInquiryValues(inquiryType, retrievedData, baseValues);
      prompt += '\n\n' + fillTemplate(inquiryTemplate, inquiryValues);
    }
    // With retrieved data, use the full response format (all display flags).
    prompt += '\n\n' + dropUnofferedExamples(fillTemplate(RESPONSE_FORMAT_FULL, baseValues), context);
  } else {
    // Initial request — slim format focused on tool selection.
    prompt += '\n\n' + dropUnofferedExamples(fillTemplate(RESPONSE_FORMAT_INITIAL, baseValues), context);
    // Multi-tool emission (capability-gated): teach pass-1 to emit {type:"multi", steps:[…]}
    // ONLY when the caller declared the `multi` capability. Withheld otherwise so old clients —
    // which never declare it — keep today's exact single-tool behavior (a multi envelope would
    // be an unrecognized response to them). See orchestrator dispatch + 20260717 build plan.
    if (context.multiEnabled) {
      prompt = injectMultiBlock(prompt);
    }
  }

  // Image capability gate: the response-format spec unconditionally documents the
  // `image` field, so when retrieve-pictures is OFF the model must be told — or it
  // says "Here's a picture of X" while the enrichment layer silently drops the hint
  // (observed on the BYOK add-on brain, 2026-07-13). Appended server-side (not in the
  // shared .md template) so the console/webapp prompt surfaces stay byte-identical.
  if (context.retrievePicturesEnabled === false) {
    prompt += '\n\nIMAGE DISPLAY IS UNAVAILABLE: always set "image": null, and never say you are ' +
      'showing or displaying a picture. If asked for a picture, say you can\'t show pictures right now.';
  } else if (inquiryType && inquiryType !== 'web-search') {
    // Second axis of the same gate: enrichment only RESOLVES an `image` hint on pass-1 and on
    // the web-search synthesis pass (orchestrator secondPass). On every other pass-2 type the
    // hint is silently dropped — so suppress the field there rather than let the model promise
    // a picture that never renders. Worded narrowly (no "you can't show pictures" claim) so it
    // can't discourage sports/HA turns from referencing the cards they DO attach.
    prompt += '\n\nFor this answer, always set "image": null and do not say you are showing or ' +
      'displaying a picture — image display is not available for this response type.';
  }

  // Personality suffix (append after response format).
  if (personalityConfig && personalityConfig.responseSuffix) {
    prompt += personalityConfig.responseSuffix;
  }

  return prompt;
}
