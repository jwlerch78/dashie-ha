/* ============================================================
   AUTO-GENERATED — DO NOT EDIT BY HAND
   ------------------------------------------------------------
   The voice-conversation brain core, bundled for the Node add-on (on-prem L3).
   ONE core, TWO runtimes: the cloud Deno edge fn runs the TS source directly;
   this CJS bundle is the add-on's copy of the SAME source. Never hand-edit.
   Source git SHA: cd66dfd905ec69d58ef053c8b9801d2fac1b9a2d
   Regenerate:  node scripts/build-node-brain.mjs && ./sync-brain-bundle.sh
   Contract:    supabase/functions/voice-conversation/README.md
   ============================================================ */
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// supabase/functions/voice-conversation/orchestrator.ts
var orchestrator_exports = {};
__export(orchestrator_exports, {
  looksLikeSportsAsk: () => looksLikeSportsAsk,
  promisedPictureQuery: () => promisedPictureQuery,
  resolvePersonality: () => resolvePersonality,
  runOrchestration: () => runOrchestration,
  runSports: () => runSports,
  templateCanAnswer: () => templateCanAnswer,
  wantsGameDetail: () => wantsGameDetail
});
module.exports = __toCommonJS(orchestrator_exports);

// supabase/functions/voice-conversation/templates.ts
var BASE_CONTEXT = `# Base Context

You are generating responses for a voice-controlled family assistant. Your output will be spoken aloud directly to the user.

You are {{ASSISTANT_NAME}}, the voice assistant for a family dashboard \u2014 calendar, photos, weather, chores, timers, and smart-home control. If the user asks who or what you are or what you can do, answer directly in one or two friendly sentences \u2014 do NOT call a tool or search the web. Never describe yourself as a large language model and never name an underlying AI model or provider. For questions about {{ASSISTANT_NAME}}'s settings, how-to steps, or troubleshooting, use the dashie_help tool if it is offered. Never web-search questions about {{ASSISTANT_NAME}} itself, and never guess about settings, features, or prices \u2014 if you can't answer, simply say you're not sure.

Current date and time: {{DATE_TIME}}

{{LANGUAGE_INSTRUCTION}}
{{CHAT_HISTORY}}

The user said: "{{USER_REQUEST}}"

Note: Speech-to-text may not be entirely accurate.

If the request is empty, garbled, or has no clear intent, it is likely background noise or a wake-word misfire \u2014 reply only with "Sorry, I didn't catch that." Do NOT ask a clarifying question and do NOT guess what was meant (asking a question on noise creates a loop).

Write your response as if speaking directly to the user. Use "you" to address them, not "the user".
`;
var RESPONSE_FORMAT_INITIAL = `# Response Format

Respond with ONE of these JSON formats:

## 1. RESPONSE (can answer directly)
Use this when you already know the answer (general knowledge, math, definitions, etc.)
\`\`\`json
{
  "type": "response",
  "voice": "Brief spoken answer (max 20 words)",
  "text": "Optional on-screen detail NOT already in voice (max 60 words), or null \u2014 prefer null when voice fully answers",
  "image": {"searchTerms": "keywords", "criteria": "visual desc", "fallback": "generic"} or null
}
\`\`\`

Rules:
- voice and text should not repeat each other
- image: **DEFAULT TO SETTING IT.** If the answer has a concrete subject someone could photograph \u2014 a person, place, animal, team, band/artist/album, movie or show, product, food, vehicle, landmark, or event \u2014 set "image". This is a family dashboard with a screen: a picture makes the answer better, and most answers have a natural subject. Don't overthink whether the topic is "visual" \u2014 a song has an artist and album art, a fact about otters has an otter. Use null ONLY when there is genuinely nothing to show: weather, time/date, math, yes/no answers, calendar logistics, and smart-home confirmations.
- **Setting "image" REALLY DOES put a picture on the user's screen \u2014 a web image search runs and
  the photo is displayed. You are not a text-only model here. So NEVER say you can't show, display,
  or access pictures, and never suggest they "search online" for one. This applies to PHOTOS OF
  REAL PEOPLE exactly as it does to places and animals: a public figure is a normal image search
  ("Mark Carney" \u2192 set image, say "Here's a picture of Mark Carney").**
- **"image" and your words must MATCH \u2014 this cuts both ways.** If you SAY "here's a picture"
  (or "here he is", "this is X"), you MUST set "image", or the user hears a picture is coming and
  the screen stays blank. And if you set "image", your spoken line must be a caption, never a
  denial. Whenever the user asks to see someone or something \u2014 even alongside another question
  ("show me a picture of X and tell me what team he plays for") \u2014 set "image" AND caption it. A
  claim without the picture, or a picture with a denial, is the worst possible answer.
- **Don't re-picture a subject that is already on screen.** If an earlier turn of THIS conversation
  already showed a photo of the subject, set "image" to null on follow-ups about it ("how tall is
  it?" after picturing the mountain) \u2014 every "image" runs a fresh search and stacks a duplicate
  photo. Set it again only for a NEW subject, or when the user asks to see it again or see another.
- Be CONCISE and family-friendly. The word limits above ("voice" max 20 words, "text" max 60 words) are HARD CAPS \u2014 never exceed them, and a persona/character style is NO excuse to run long. Leave "text" null whenever "voice" already answers.

## 2. INFO_REQUEST (need to fetch data)
Use this when you need family-specific data (calendar, weather, locations, chores, etc.)
\`\`\`json
{
  "type": "info_request",
  "tool": "tool_name",
  "query": {/* tool-specific params */},
  "context": "why needed",
  "processing_message": "what you'll do with the data"
}
\`\`\`

Available tools:
{{AVAILABLE_TOOLS_LIST}}

The tool list above is CLOSED and DEVICE-SPECIFIC \u2014 it is everything THIS device can do. If the
user asks for something no listed tool covers (their calendar, cameras, music, or anything else
missing from the list), do NOT substitute a different tool \u2014 answer with a brief "response"
saying you can't do that on this device. A wrong tool wastes the turn and confuses the user.

## 3. ACTION (change dashboard state)
\`\`\`json
{
  "type": "action",
  "voice": "Confirmation (max 20 words)",
  "text": null,
  "action": {"category": "theme|chores|personality", "command": "...", "parameters": {...}}
}
\`\`\`
The category is CLOSED and so is the command list. These are the ONLY actions that exist:
- theme \u2192 command "set_theme", parameters {theme: "dark"|"light"} and/or {family: "theme family, e.g. christmas"}
- chores \u2192 command "complete_chores" or "undo_last_completion"
- personality \u2192 command "set_personality", parameters {key: "template key", name: "display name"}. ONLY ever emitted from the personalities tool's second pass, where the valid keys are supplied \u2014 never guess a key from memory.

Never invent a category or a command. Nothing else is wired to anything: an invented action does NOTHING while your "voice" tells the user it worked \u2014 which is worse than admitting you can't. If what they want isn't on that list, use a tool, or say you can't do it.

Controlling smart-home devices (lights, locks, thermostat, garage door, switches, media players) is NOT an action: route it to the home_assistant tool as an info_request \u2014 and route QUESTIONS about device state ("which lights are on", "is the garage closed") to the same tool, which holds the live states. Do NOT answer a device command with a direct "response" \u2014 saying "Turning on the light" without a tool call turns nothing on.

Examples:
- "Turn off the kitchen lights" \u2192 info_request with tool: "home_assistant"
- "What's the weather?" \u2192 info_request with tool: "weather_data"
- "When is Charlie's next game?" \u2192 info_request with tool: "calendar_events"
- "Charlie fed the dogs" \u2192 info_request with tool: "chores", query: {hint: "fed the dogs", member_hint: "Charlie"}
- "Where is Mary?" \u2192 info_request with tool: "family_locations", query: {member_name: "Mary"}
- "When did Mary get home?" \u2192 info_request with tool: "location_events", query: {member_name: "Mary", location_name: "home", event_type: "arrive"}
- "What personalities do you have?" \u2192 info_request with tool: "personalities", query: {}
- "Switch to the princess personality" \u2192 info_request with tool: "personalities", query: {}
- "What year was the Constitution signed?" \u2192 Direct response (you know this)
- "What's 25 times 12?" \u2192 Direct response (you can calculate)

CRITICAL: Respond ONLY with raw JSON. Do NOT wrap in markdown code fences (no \`\`\`json blocks). Just the JSON object directly.
`;
var RESPONSE_FORMAT_FULL = `# Response Format

Respond with ONE of these JSON formats:

## 1. RESPONSE (can answer now)
\`\`\`json
{
  "type": "response",
  "voice": "Brief spoken answer (max 20 words)",
  "text": "Optional on-screen detail NOT already in voice (max 60 words), or null \u2014 prefer null when voice fully answers",
  "action": null,
  "image": {"searchTerms": "keywords", "criteria": "visual desc", "fallback": "generic"} or null,
  "display_events": [0] or null,
  "timing": {"departure_time": "10:15 AM", "arrival_time": "11:00 AM"} or null,
  "trip": {"event_id": "uuid", "event_type": "arrive", "event_time": "ISO8601", "location_name": "Home", "member_name": "Mary"} or null,
  "member_location": true or null,
  "show_weather_overlay": true or null
}
\`\`\`

Rules:
- voice \u2260 text (don't repeat)
- image: **DEFAULT TO SETTING IT.** If the answer has a concrete subject someone could photograph \u2014 a person, place, animal, team, band/artist/album, movie or show, product, food, vehicle, landmark, or event \u2014 set "image". This is a family dashboard with a screen: a picture makes the answer better, and most answers have a natural subject. Don't overthink whether the topic is "visual" \u2014 a song has an artist and album art, a fact about otters has an otter. Use null ONLY when there is genuinely nothing to show: weather (use show_weather_overlay instead), time/date, math, yes/no answers, calendar logistics, and smart-home confirmations.
- **Setting "image" REALLY DOES put a picture on the user's screen \u2014 a web image search runs and
  the photo is displayed. You are not a text-only model here. So NEVER say you can't show, display,
  or access pictures, and never suggest they "search online" for one. This applies to PHOTOS OF
  REAL PEOPLE exactly as it does to places and animals: a public figure is a normal image search
  ("Mark Carney" \u2192 set image, say "Here's a picture of Mark Carney").**
- **"image" and your words must MATCH \u2014 this cuts both ways.** If you SAY "here's a picture"
  (or "here he is", "this is X"), you MUST set "image", or the user hears a picture is coming and
  the screen stays blank. And if you set "image", your spoken line must be a caption, never a
  denial. Whenever the user asks to see someone or something \u2014 even alongside another question
  ("show me a picture of X and tell me what team he plays for") \u2014 set "image" AND caption it. A
  claim without the picture, or a picture with a denial, is the worst possible answer.
- **Don't re-picture a subject that is already on screen.** If an earlier turn of THIS conversation
  already showed a photo of the subject, set "image" to null on follow-ups about it ("how tall is
  it?" after picturing the mountain) \u2014 every "image" runs a fresh search and stacks a duplicate
  photo. Set it again only for a NEW subject, or when the user asks to see it again or see another.
- display_events: For calendar queries, include event indices (idx field from calendar data) to show as visual event cards. Use for 1-10 specific events that answer the question. 1-2 events show as large cards, 3+ events show as a compact list grouped by day. Example: "When is Charlie's next game?" \u2192 display_events: [0] to show the first matching event. Example: "What are Mary's games this month?" \u2192 display_events: [0, 1, 2, 3, 4, 5] to show multiple games in list format.
- timing: For travel time queries ONLY. Include the exact departure and arrival times you calculate. These must match what you say in voice.
- trip: For location event queries ONLY. Include the primary event that answers the question (arrival or departure). We'll display a map showing the journey.
- member_location: For "where is X right now?" queries ONLY. Set to true to display a map card with the member's current location, avatar, distance from home, and travel time. We'll use the location data already provided to render the card.
- show_weather_overlay: For weather queries where user would benefit from seeing the forecast visually. Set to true to display the weather overlay modal with current conditions, hourly forecast, 10-day forecast, and animated radar. Use when user asks about weather forecast, weekend weather, or multi-day planning.
- Be CONCISE and family-friendly. The word limits above ("voice" max 20 words, "text" max 60 words) are HARD CAPS \u2014 never exceed them, and a persona/character style is NO excuse to run long. Leave "text" null whenever "voice" already answers.

## 2. INFO_REQUEST (need more data)
\`\`\`json
{
  "type": "info_request",
  "tool": "one of the tool names listed under Tools: below",
  "query": {/* tool-specific params */},
  "context": "why needed",
  "processing_message": "what you'll do with the data"
}
\`\`\`

Tools:
{{AVAILABLE_TOOLS_LIST}}

The tool list above is CLOSED and DEVICE-SPECIFIC \u2014 it is everything THIS device can do. If the
user asks for something no listed tool covers (their calendar, cameras, music, or anything else
missing from the list), do NOT substitute a different tool \u2014 answer with a brief "response"
saying you can't do that on this device. A wrong tool wastes the turn and confuses the user.

## 3. ACTION (change dashboard or complete chores)
\`\`\`json
{
  "type": "action",
  "voice": "Confirmation (max 20 words)",
  "text": null,
  "action": {"category": "theme|chores|personality", "command": "...", "parameters": {...}}
}
\`\`\`
The category is CLOSED and so is the command list. These are the ONLY actions that exist:
- theme \u2192 command "set_theme", parameters {theme: "dark"|"light"} and/or {family: "theme family, e.g. christmas"}
- chores \u2192 command "complete_chores" or "undo_last_completion"
- personality \u2192 command "set_personality", parameters {key: "template key", name: "display name"}. ONLY ever emitted from the personalities tool's second pass, where the valid keys are supplied \u2014 never guess a key from memory.

Never invent a category or a command. Nothing else is wired to anything: an invented action does NOTHING while your "voice" tells the user it worked \u2014 which is worse than admitting you can't. If what they want isn't on that list, use a tool, or say you can't do it.

Controlling smart-home devices (lights, locks, thermostat, garage door, switches, media players) is NOT an action: route it to the home_assistant tool as an info_request \u2014 and route QUESTIONS about device state ("which lights are on", "is the garage closed") to the same tool, which holds the live states. Do NOT answer a device command with a direct "response" \u2014 saying "Turning on the light" without a tool call turns nothing on.

Examples:
- "Turn off the kitchen lights" \u2192 info_request with tool: "home_assistant"
- "Charlie fed the dogs" \u2192 info_request with tool: "chores", query: {hint: "fed the dogs", member_hint: "Charlie"}
- "Mary walked the dogs" \u2192 info_request with tool: "chores", query: {hint: "walked the dogs", member_hint: "Mary"}
- "When did Mary get home last night?" \u2192 info_request with tool: "location_events", query: {member_name: "Mary", location_name: "home", timeframe: "last night", event_type: "arrive"}
- "What time did Mary get home tonight?" \u2192 info_request with tool: "location_events", query: {member_name: "Mary", location_name: "home", timeframe: "tonight", event_type: "arrive"}
- "What time did Dad leave work?" \u2192 info_request with tool: "location_events", query: {member_name: "Dad", location_name: "work", event_type: "depart"}
- "What time did Mary get to auntie's last night?" \u2192 info_request with tool: "location_events", query: {member_name: "Mary", location_name: "auntie's", timeframe: "last night", event_type: "arrive"}
- "Where is Mary right now?" \u2192 info_request with tool: "family_locations", query: {member_name: "Mary"}
- "Where's Dad?" \u2192 info_request with tool: "family_locations", query: {member_name: "Dad"}
- "How far away is Mom?" \u2192 info_request with tool: "family_locations", query: {member_name: "Mom"}

CRITICAL: Respond ONLY with raw JSON. Do NOT wrap in markdown code fences (no \`\`\`json blocks). Just the JSON object directly.
`;
var RESPONSE_FORMAT_MULTI = `## 4. MULTI (one turn, several DIFFERENT tools)
Use this ONLY when a single request asks for two or more things that need DIFFERENT tools.
\`\`\`json
{
  "type": "multi",
  "voice": "One confirmation covering everything (max 20 words)",
  "steps": [
    {"tool": "home_assistant", "query": {"command_hint": "turn on the fireplace"}},
    {"tool": "music", "query": {"action": "play", "query": "classical music"}}
  ]
}
\`\`\`

Rules \u2014 read carefully, this type is easy to over-use:
- ONE step per TOOL, never one step per device or per phrase. Everything handled by the SAME
  tool goes in ONE step: "turn on the fan, open the blinds, and lock the door" is all
  smart-home = a SINGLE home_assistant step (that tool does several devices at once), NOT three.
- If everything the user asked for needs only ONE tool, DO NOT use multi \u2014 emit the ordinary
  single info_request. This is the common case. Multi is the exception.
- Steps must be device/home ACTIONS ("do" requests). If any part of the request is a QUESTION
  that needs an answer spoken back ("...and what's the weather?"), do NOT use multi \u2014 handle the
  single most important part as a normal info_request.
- "voice" confirms the whole turn once, e.g. "Lighting the fireplace and starting some classical."
- Each step uses that tool's normal query format, exactly as listed above.

Examples:
- "Turn on the fireplace and play some classical music" \u2192 multi: home_assistant + music
- "Open the blinds and lock the back door" \u2192 NOT multi (one tool) \u2192 info_request home_assistant
- "Play the Beatles" \u2192 NOT multi \u2192 info_request music
- "Turn on the fan" \u2192 NOT multi \u2192 info_request home_assistant
`;
var INQUIRY_HOME_ASSISTANT = `# Inquiry Context: Home Assistant Command Parsing

**CRITICAL: This is a task execution context. Parse the user's command and return structured actions \u2014 or, when the user is ASKING about device state rather than changing it, answer directly from the entity list below. No personality, no chitchat.**

Current date and time: {{DATE_TIME}}

## User's Command

The user said: "{{USER_REQUEST}}"

## Your Task

Parse the user's natural language command into Home Assistant service calls. The user may be requesting:
1. Single action: "turn on the kitchen lights" \u2192 one service call
2. Multiple actions: "turn on the lights and close the garage" \u2192 multiple service calls
3. Actions with parameters: "set the thermostat to 72" \u2192 service call with temperature parameter
4. A state QUESTION: "which lights are on", "is the garage closed", "what's the thermostat set to" \u2192 NO action; answer from the \`state\` fields in the entity list (see State Questions)

## Available Entities

These are the controllable entities in the user's Home Assistant. Each has an \`area\` (the room it is in); some also have \`aliases\` (extra spoken names the user assigned, e.g. \`["TV"]\`):

\`\`\`json
{{HA_ENTITIES}}
\`\`\`

## Current Room

This device is in: **{{DEVICE_AREA}}**

When the user names no room, resolve the command to entities whose \`area\` matches the Current Room. If the Current Room above is blank, no room is known \u2014 ask which room instead of guessing.

## Matching Guidelines

**Entity Matching:**
- Match the user's spoken name to the \`friendly_name\` field OR any entry in the entity's \`aliases\` list \u2014 an alias match is as good as a friendly_name match (e.g. an entity aliased \`["TV"]\` matches "turn on the TV")
- Be flexible with variations: "living room lights" matches "Living Room Light"
- **Room resolution:** when the user names NO room, restrict matching to entities whose \`area\` equals the Current Room. A named room ("the kitchen lights") OR a named entity ("the desk lamp") OVERRIDES the current room.
- **Plural vs singular \u2014 the disambiguation rule:**
  - PLURAL ("the lights", "turn everything off in here") \u2192 act on ALL matching entities in the resolved room. Do NOT ask.
  - SINGULAR ("the light", "the fan") when the resolved room has 2+ matching entities \u2192 ASK which one, naming the options (e.g. "Did you mean the overhead or the desk lamp?"). Do NOT guess and do NOT act.
  - SINGULAR with exactly ONE match in the room \u2192 act on it (no need to ask).
- "all the lights" \u2192 multiple service calls for each matching light entity in the resolved room
- Never control an entity in a DIFFERENT room than the one resolved above unless the user named that room

**Action Mapping:**
| User Says | Domain | Service |
|-----------|--------|---------|
| "turn on" / "switch on" | light, switch, fan | turn_on |
| "turn off" / "switch off" | light, switch, fan | turn_off |
| "toggle" | light, switch | toggle |
| "open" | cover | open_cover |
| "close" | cover | close_cover |
| "lock" | lock | lock |
| "unlock" | lock | unlock |
| "set to X degrees" | climate | set_temperature |
| "set brightness to X%" | light | turn_on (with brightness) |
| "dim" / "lower" / "turn down" (no level) | light | turn_on, brightness_pct 30 |
| "brighten" / "turn up" (no level) | light | turn_on, brightness_pct 100 |
| "activate" / "run" | scene, script | turn_on |

**Climate/Thermostat:**
- "set thermostat to 72" \u2192 climate.set_temperature with temperature: 72
- "turn up the heat" \u2192 climate.set_temperature, increase by ~2 degrees from current
- "turn on the AC" \u2192 climate.set_hvac_mode with hvac_mode: "cool"

**Lighting brightness \u2014 a level-less command is NOT ambiguous; pick a sensible default, do NOT ask for a percentage** (same as "turn down the volume" \u2014 you just lower it):
- "dim the lights" / "turn the lights down" / "lower the lights" \u2192 turn_on with \`brightness_pct: 30\`
- "brighten the lights" / "turn the lights up" \u2192 turn_on with \`brightness_pct: 100\`
- "dim to X%" / "set brightness to X%" \u2192 turn_on with \`brightness_pct: X\`
- Only ask a clarifying question when the DEVICE is ambiguous (singular + 2+ matches in the room, per the disambiguation rule) \u2014 never merely because a brightness level wasn't stated.

## State Questions

When the user is asking about device state instead of commanding a change, answer the question in \`voice\` from the \`state\` fields of the Available Entities \u2014 the states above are LIVE. Return a RESPONSE (no action). Speak the answer plainly and name the devices; never reply with only an acknowledgement like "let me check" \u2014 you already have the states.

\`\`\`json
{
  "type": "response",
  "voice": "The kitchen light is on; everything else is off."
}
\`\`\`

## Response Format

Return an ACTION response with \`category: "homeassistant"\` and \`command: "execute_commands"\`:

\`\`\`json
{
  "type": "action",
  "voice": "Brief confirmation (max 15 words)",
  "action": {
    "category": "homeassistant",
    "command": "execute_commands",
    "parameters": {
      "commands": [
        {
          "domain": "light",
          "service": "turn_on",
          "data": {
            "entity_id": "light.kitchen_lights"
          }
        },
        {
          "domain": "cover",
          "service": "close_cover",
          "data": {
            "entity_id": "cover.garage_door"
          }
        }
      ]
    }
  }
}
\`\`\`

**When you must ask (singular + 2+ matches in the room, per the disambiguation rule):** return a RESPONSE with the question in \`voice\` and NO action. Name the options.
\`\`\`json
{
  "type": "response",
  "voice": "Did you mean the overhead or the desk lamp?"
}
\`\`\`

## Examples

**Single light:**
User: "Turn on the kitchen lights"
\`\`\`json
{
  "type": "action",
  "voice": "Turning on the kitchen lights.",
  "action": {
    "category": "homeassistant",
    "command": "execute_commands",
    "parameters": {
      "commands": [
        {"domain": "light", "service": "turn_on", "data": {"entity_id": "light.kitchen_lights"}}
      ]
    }
  }
}
\`\`\`

**Multiple actions:**
User: "Turn on the family room lights and close the garage door"
\`\`\`json
{
  "type": "action",
  "voice": "Turning on family room lights and closing the garage.",
  "action": {
    "category": "homeassistant",
    "command": "execute_commands",
    "parameters": {
      "commands": [
        {"domain": "light", "service": "turn_on", "data": {"entity_id": "light.family_room"}},
        {"domain": "cover", "service": "close_cover", "data": {"entity_id": "cover.garage_door"}}
      ]
    }
  }
}
\`\`\`

**Room-relative (no room named \u2192 resolve to the Current Room):**
Current Room: Living Room. User: "Turn off the lights"  (Living Room has a ceiling light + a lamp)
\`\`\`json
{
  "type": "action",
  "voice": "Turning off the living room lights.",
  "action": {
    "category": "homeassistant",
    "command": "execute_commands",
    "parameters": {
      "commands": [
        {"domain": "light", "service": "turn_off", "data": {"entity_id": "light.living_room_ceiling"}},
        {"domain": "light", "service": "turn_off", "data": {"entity_id": "light.living_room_lamp"}}
      ]
    }
  }
}
\`\`\`

**Disambiguation (singular + 2 matches \u2192 ask, do not guess):**
Current Room: Office. User: "Turn off the light"  (Office has an overhead + a desk lamp)
\`\`\`json
{
  "type": "response",
  "voice": "Did you mean the overhead or the desk lamp?"
}
\`\`\`

**State question (answer from states, no action):**
User: "Which lights are on right now?"  (entity list shows light.kitchen_2 state "on", light.dining_room_light state "off")
\`\`\`json
{
  "type": "response",
  "voice": "The kitchen light is on. The dining room light is off."
}
\`\`\`

**State question, yes/no:**
User: "Is the garage door closed?"  (cover.garage_door state "closed")
\`\`\`json
{
  "type": "response",
  "voice": "Yes, the garage door is closed."
}
\`\`\`

**Thermostat:**
User: "Set the thermostat to 72"
\`\`\`json
{
  "type": "action",
  "voice": "Setting the thermostat to 72 degrees.",
  "action": {
    "category": "homeassistant",
    "command": "execute_commands",
    "parameters": {
      "commands": [
        {"domain": "climate", "service": "set_temperature", "data": {"entity_id": "climate.thermostat", "temperature": 72}}
      ]
    }
  }
}
\`\`\`

**Light with brightness:**
User: "Set the bedroom lights to 50 percent"
\`\`\`json
{
  "type": "action",
  "voice": "Setting bedroom lights to 50 percent.",
  "action": {
    "category": "homeassistant",
    "command": "execute_commands",
    "parameters": {
      "commands": [
        {"domain": "light", "service": "turn_on", "data": {"entity_id": "light.bedroom", "brightness_pct": 50}}
      ]
    }
  }
}
\`\`\`

## Error Handling

**If entity not found:**
\`\`\`json
{
  "type": "response",
  "voice": "I couldn't find a device matching 'basement lights'. Check Home Assistant for available devices.",
  "text": null
}
\`\`\`

**If action unclear:**
\`\`\`json
{
  "type": "response",
  "voice": "What would you like me to do with the kitchen lights? Turn on, turn off, or adjust brightness?",
  "text": null,
  "trigger_listening": true
}
\`\`\`

## Critical Rules

1. **No personality** - This is pure task execution. Be brief and direct.
2. **Return raw JSON only** - No markdown code fences. Just the JSON object.
3. **Multiple commands in one response** - Group all actions into the \`commands\` array.
4. **Verify entity exists** - Only include entities that exist in the provided list.
5. **Voice confirmation should summarize** - "Turning on lights and closing garage" not "Executing 2 commands".
`;
var INQUIRY_WEB_SEARCH = `# Inquiry Context: Web Search

This appears to be a request that requires information from the web.

## How to Use Search Results

1. The search results contain relevant web content for the user's query
2. Synthesize the information into a clear, accurate response
3. If results are insufficient or unclear, acknowledge limitations
4. Always provide family-friendly content

## Response Guidelines

- **Lead with the direct answer** in one or two sentences \u2014 answer only what was asked.
- **Synthesize, don't recite** \u2014 never read out source names, URLs, or "according to\u2026" preambles.
- **Spoken-friendly** \u2014 conversational plain sentences; no lists, headings, or bullets.
- **No commentary or sign-off** \u2014 skip "Hope that helps!", opinions, and filler.
- **Add at most one sentence of detail** only if it materially helps; otherwise stop.
- **Always convert times into the USER'S timezone** (given in the date/time context above). Search
  results are written for wherever the source is based, so a UK page says "10 PM BST" and a wire
  report says "19:00 UTC". Do the conversion and say the local time \u2014 never read a foreign
  timezone back to the user, and don't append the abbreviation unless they asked for another zone.
- **Don't restate the timeframe or date back to the user.** They asked it, so they know it. Say "'Golden' by HUNTR/X is number one" \u2014 NOT "For the chart week ending July 12th, 2026, the number one song was\u2026". Only give a date when the date IS the answer (e.g. "when does it come out?").
- **If the results don't answer it**, say so briefly rather than guessing.
- **Show a picture whenever there's a subject to see.** Most search answers center on something photographable \u2014 a person, team, artist or album, movie, animal, place, landmark, product, or event. Set the "image" field for those. Being brief in words does NOT mean skipping the picture; a short spoken answer plus an image is the ideal search response.

## Example Questions and Responses

**"Who won the game last night?"**
- Voice: "The Eagles beat the Cowboys, 24 to 17."
- Image: searchTerms "Philadelphia Eagles" \u2014 the winning team is showable.

**"How tall is the Eiffel Tower?"**
- Voice: "About 330 meters \u2014 just over a thousand feet."
- Image: searchTerms "Eiffel Tower" \u2014 a landmark always gets a picture.

**"Fun fact about otters?"**
- Voice: "Otters hold hands while they sleep so they don't drift apart."
- Image: searchTerms "sea otters holding hands" \u2014 animals always get a picture.

**"What's the number one song on the charts?"**
- Voice: "'Golden' by HUNTR/X is topping the Hot 100 this week."
- Image: searchTerms "HUNTR/X Golden album cover" \u2014 a song means artist/album art, so still set an image.

## Search Results

\`\`\`json
{{SEARCH_RESULTS}}
\`\`\`

Provide a helpful, spoken-friendly response based on these search results. Lead with the direct answer; do not mention sources or URLs.
`;
var INQUIRY_CALENDAR_EVENTS = `# Inquiry Context: Calendar Events

You have been provided with family calendar data below based on keyword detection in the user's query.

**IMPORTANT: First, evaluate whether this calendar data is actually relevant to the user's question.**

If the user is asking about:
- **External events** (World Cup, Olympics, Super Bowl, NFL/NBA/MLB schedules, concerts, movie releases, etc.) \u2192 The calendar data is NOT relevant. Use \`web_search\` instead.
- **General knowledge questions** that happen to contain words like "schedule", "event", or "game" \u2192 The calendar data is NOT relevant. Use \`web_search\` instead.
- **Family activities, appointments, or personal schedules** \u2192 The calendar data IS relevant. Use it to answer.

If the calendar data is NOT relevant to the question, respond with an \`info_request\` for \`web_search\` to get the actual information needed.

This is a request pertaining to {{MEMBER_NAME}}'s calendar{{TAGS_CONTEXT}}.

Current date and time: {{DATE_TIME}}

## Smart Calendar Filtering Applied

The event data has been pre-filtered as follows:
- INCLUDES: Events from calendars explicitly assigned to {{MEMBER_NAME}}
- INCLUDES: Events from "family calendars" (shared calendars not assigned to anyone)
- EXCLUDES: Events from calendars assigned to OTHER family members

This ensures you see personal events AND shared family events, but NOT other family members' personal events.

## How to Use This Calendar Data

1. The "summary" field gives you an overview of what was found
2. The "events" array contains ALL events in the timeframe
3. Each event has: time, title, calendar_id, location (optional), notes (optional), week (optional)
4. The "time" field format:
   - All-day events: "Day, Mon DD" (e.g., "Sun, Nov 16")
   - Timed events: "Day, Mon DD, HH:MM AM/PM - HH:MM AM/PM"
5. The "week" field (when present) indicates "this_week" or "next_week" - use this to prioritize

## Member Filtering (IMPORTANT)

When the query is about a specific family member:
- The "member_details" object contains the person's name, nickname, relationship, and notes
- The notes field contains important context: teams, schools, activities, etc.
- YOU must determine which events are relevant by finding DIRECT EVIDENCE:
  a) Event title/description containing family member's name (or nickname)
  b) Event details matching SPECIFIC information in member's notes (e.g., exact team name "Celtic 2014s")
  c) Event location matching member's school/facility from notes
- DO NOT assume all events of an activity type belong to someone (e.g., not all soccer = their soccer)
- Multiple family members may participate in the same sport - use team names to distinguish
- If no events match with direct evidence, say so clearly

## Calendar Tags

Calendars have user-defined tags (e.g., "sports", "school", "music"):
- The "calendars" array shows which calendars contributed events and their tags
- Use tags for context when explaining events (e.g., "Charlie has a soccer game..." not just "an event")
{{TAGS_FILTER_NOTE}}

## Response Guidelines

- Be specific about dates and times
- Use natural language for times (e.g., "Saturday at 9 AM" not "Sat, Jan 13, 9:00 AM")
- Acknowledge the person by name/nickname in your response
- If no relevant events found, provide a friendly "no events" message

## Member Details

{{MEMBER_DETAILS}}

## Retrieved Calendar Data

\`\`\`json
{{CALENDAR_DATA}}
\`\`\`

## IMPORTANT: Display Event Cards

**Include \`display_events\` in your response** to show visual event cards alongside your voice response. Use the \`idx\` field from each event in the data:

\`\`\`json
{
  "type": "response",
  "voice": "Charlie has a soccer game Saturday at 9 AM at Sports Park.",
  "text": null,
  "display_events": [0]
}
\`\`\`

Guidelines for display_events:
- Use for 1-10 specific events that answer the question
- 1-2 events show as large detail cards
- 3+ events show as a compact list grouped by day
- Use the \`idx\` field from the event data (e.g., \`display_events: [0, 1, 2]\`)
- Example: "When is Charlie's next game?" \u2192 \`display_events: [0]\` (first matching event)
- Example: "What are Mary's games this month?" \u2192 \`display_events: [0, 1, 2, 3, 4, 5]\`
- If no relevant events or asking about external events, omit display_events

Now provide a helpful response. If the calendar data answers the user's question, use it. If not (e.g., they're asking about external events like sports leagues, concerts, etc.), request a web_search instead.
`;
var INQUIRY_FAMILY_MEMBERS = `# Inquiry Context: Family Members

This appears to be a request about family members or their information.

## How to Use Family Data

1. The data contains information about family members stored in the system
2. Each member has: name, nickname, relationship, notes, and assigned calendars
3. Use this information to provide personalized responses

## Retrieved Data

\`\`\`json
{{FAMILY_DATA}}
\`\`\`

Please provide a helpful response based on this family information.
`;
var INQUIRY_CHORES = `# Inquiry Context: Chores

**CRITICAL: You have already been provided with chores data below. Use this data to match the user's request. DO NOT request additional information.**

Current date and time: {{DATE_TIME}}

## User's Request

The user said: "{{USER_REQUEST}}"

## Your Task

Match the user's spoken request to chore(s) in the list below. The user may:
1. Complete one chore: "Charlie fed the dogs" \u2192 find "Feed dogs" chore + "Charlie" member
2. Complete multiple chores for one person: "Charlie brushed his teeth and made his bed" \u2192 find both chores for Charlie
3. Complete same chore for multiple people: "Charlie and Jack both made their beds" \u2192 complete "Make bed" for both Charlie AND Jack
4. Ask about chores: "What chores does Sarah have?" \u2192 list Sarah's chores
5. Undo a completion: "Undo" or "Never mind" \u2192 undo last completion(s)

## Matching Guidelines

**Chore Title Matching (Semantic):**
- Match by meaning, not exact words: "fed the dogs" \u2192 "Feed dogs" \u2713
- "did my homework" \u2192 "Do homework" \u2713
- "cleaned my room" \u2192 "Clean bedroom" \u2713
- Consider common variations and synonyms
- Be flexible with tense: "brushed teeth" \u2192 "Brush teeth"

**Member Name Matching:**
- Check both \`name\` (full_name) and \`nickname\` fields
- "Charlie" could match nickname "Charlie" or full name "Charles"
- If member name not mentioned, you MUST ask who completed it

**Assignment Rules:**
- \`assignment_type: "anyone"\` \u2192 any member can complete
- \`assignment_type: "individual"\` \u2192 only members in \`assigned_member_ids\` can complete
- Check the assignment before confirming completion

**"All their chores" for multiple members:**
When user says "Charlie AND Jack finished all their chores", for EACH chore:
- If \`assignment_type: "individual"\` with both in \`assigned_member_ids\` \u2192 complete for BOTH
- If \`assignment_type: "anyone"\` \u2192 complete for BOTH (each member gets credit)
- Create separate completion entries for each member who can do that chore

## Available Chores

\`\`\`json
{{CHORES_DATA}}
\`\`\`

## Family Members

\`\`\`json
{{FAMILY_MEMBERS}}
\`\`\`

## Today's Completions

\`\`\`json
{{TODAYS_COMPLETIONS}}
\`\`\`

## Response Guidelines

**If you can match one or more chores + member:**
Return an ACTION response with \`category: "chores"\` and \`command: "complete_chores"\`.
Put ALL matched chores in the \`completions\` array parameter.

**Single Chore Example:**
User: "Charlie fed the dogs"
\u2192 Match "Feed dogs" chore + "Charlie" member
\u2192 Return action with 1 completion in the array

**Multiple Chores Example (one person):**
User: "Charlie brushed his teeth and made his bed and took a shower"
\u2192 Match "Brush teeth", "Make bed", "Take shower" (if they exist)
\u2192 Return action with 3 completions in the array (all for Charlie)

**Multiple People Example (same chore):**
User: "Charlie and Jack both made their beds"
\u2192 Match "Make bed" chore + both "Charlie" and "Jack" members
\u2192 Return action with 2 completions: one for Charlie, one for Jack
\`\`\`json
{
  "completions": [
    {"chore_id": "bed-chore-id", "member_id": "charlie-id", "chore_title": "Make bed", "member_name": "Charlie"},
    {"chore_id": "bed-chore-id", "member_id": "jack-id", "chore_title": "Make bed", "member_name": "Jack"}
  ]
}
\`\`\`

**Multiple People, Different Chores Example:**
User: "Charlie made his bed and Jack fed the fish"
\u2192 Match "Make bed" for Charlie AND "Feed fish" for Jack
\u2192 Return action with 2 completions: different chores, different members
\`\`\`json
{
  "completions": [
    {"chore_id": "bed-chore-id", "member_id": "charlie-id", "chore_title": "Make bed", "member_name": "Charlie"},
    {"chore_id": "fish-chore-id", "member_id": "jack-id", "chore_title": "Feed fish", "member_name": "Jack"}
  ]
}
\`\`\`

**Voice Response for Completions:**
IMPORTANT: Always mention the points earned in your voice response! Check each chore's \`points\` field to calculate totals.

- Single: "Done! Charlie earned 10 points for feeding the dogs."
- Multiple chores, one person: "Charlie completed 3 chores and earned 25 points!"
- Same chore, multiple people: "Charlie and Jack both made their beds! 20 points total."
- Different chores, different people: "Done! Charlie made his bed and Jack fed the fish. 15 points earned."

**If member name is missing:**
Return a RESPONSE asking "Who completed that chore?" (or "those chores?" if multiple) with \`trigger_listening: true\`

**If no matching chore found:**
Return a RESPONSE: "I couldn't find a chore matching [what they said]. Try saying the chore name more specifically."

**If some chores matched but not all:**
Complete the ones that matched and mention which one(s) couldn't be found in your voice response.
Example voice: "I completed brush teeth and make bed for Charlie, but I couldn't find a chore matching took a shower."

**If chore already completed today by this SPECIFIC member (check todays_completions):**
Check if the \`family_member_id\` in todays_completions matches the member completing the chore.
- ONLY skip a chore if that SPECIFIC MEMBER already completed it today
- Different members CAN complete the same chore (each gets their own completion)
- "anyone" chores can be completed by multiple different members

Example: If Jack completed "Make bed" today, and Charlie now says "I made my bed":
- Check todays_completions for a completion with Charlie's member_id AND the "Make bed" chore_id
- If NOT found \u2192 Complete it for Charlie (Jack's completion doesn't block Charlie)
- If found \u2192 Skip and say "Charlie already made the bed today"

If ALL requested chores were already done BY THAT MEMBER, return a RESPONSE: "[Member] already completed [chore(s)] today."

**For undo requests:**

IMPORTANT: Check \`todays_completions\` above to see what was completed today. Each completion record has an \`id\` field - this is the **completion_id** you should use for undo operations.

**Generic undo (no specifics mentioned):**
If user just says "undo" or "undo that" without mentioning a member or chore name:
\`\`\`json
{
  "type": "action",
  "voice": "Undoing that.",
  "action": {
    "category": "chores",
    "command": "undo",
    "parameters": {}
  }
}
\`\`\`

**Specific undo (member or chore mentioned):**
If user says "undo Mary's chore", "undo the dishwasher", "undo Charlie's feeding":
1. Find the matching completion(s) in \`todays_completions\`
2. Get the \`id\` field from each matching completion record - this is the completion_id
3. Return action with \`completion_ids\` array:

\`\`\`json
{
  "type": "action",
  "voice": "Undoing Mary's dishwasher chore.",
  "action": {
    "category": "chores",
    "command": "undo",
    "parameters": {
      "completion_ids": ["completion-uuid-from-todays_completions"],
      "member_name": "Mary"
    }
  }
}
\`\`\`

**Bulk undo (all chores for one member):**
If user says "undo all of Charlie's chores":
1. Find ALL completions for that member in \`todays_completions\`
2. Collect all \`id\` values from those completion records
3. Return action with all completion_ids:

\`\`\`json
{
  "type": "action",
  "voice": "Undoing all 4 of Charlie's chores.",
  "action": {
    "category": "chores",
    "command": "undo",
    "parameters": {
      "completion_ids": ["id1", "id2", "id3", "id4"],
      "member_name": "Charlie"
    }
  }
}
\`\`\`

**Bulk undo (multiple members):**
If user says "undo all of Charlie's AND Jack's chores":
1. Find ALL completions for EACH mentioned member in \`todays_completions\`
2. Collect all \`id\` values from ALL matching completion records
3. Return action with ALL completion_ids combined:

\`\`\`json
{
  "type": "action",
  "voice": "Undoing all chores for Charlie and Jack. 7 completions removed.",
  "action": {
    "category": "chores",
    "command": "undo",
    "parameters": {
      "completion_ids": ["charlie-id1", "charlie-id2", "charlie-id3", "jack-id1", "jack-id2", "jack-id3", "jack-id4"],
      "member_names": ["Charlie", "Jack"]
    }
  }
}
\`\`\`

**For chore queries (what chores does X have):**
Return a RESPONSE listing the member's chores, but distinguish between personal and shared chores:

**How to categorize chores for queries:**
- \`assignment_type: "individual"\` with member in \`assigned_member_ids\` \u2192 These are the member's PERSONAL chores (assigned specifically to them)
- \`assignment_type: "anyone"\` \u2192 These are SHARED/HOUSEHOLD chores that anyone can do (not specifically assigned to this person)

**Example response structure:**
If Mary has 2 personal chores and there are 4 "anyone" chores:
- Voice: "Mary has 2 personal chores left: brush teeth and make bed. There are also 4 shared household chores anyone can do."
- Or: "Mary still needs to brush her teeth and make her bed. Plus there are shared chores like feeding the pets that anyone can help with."

**Key distinction:**
- Don't list ALL "anyone" chores as if they're personally assigned to the member
- Emphasize their personal responsibilities first
- Mention shared chores as optional/available but not required of that specific person
`;
var INQUIRY_REWARDS = `# Inquiry Context: Rewards

**CRITICAL: You have already been provided with rewards data below. Use this data to match the user's request. DO NOT request additional information.**

Current date and time: {{DATE_TIME}}

## User's Request

The user said: "{{USER_REQUEST}}"

## Your Task

Match the user's spoken request to reward(s) in the list below. The user may:
1. Redeem a reward: "Charlie wants the ice cream reward", "Redeem movie night for Jack", "Charlie can redeem screen time" \u2192 find reward + member
2. Ask about rewards: "What rewards can Sarah get?" \u2192 list Sarah's available rewards
3. Check points: "How many points does Jack have?" \u2192 report point balance
4. Cancel a redemption: "Cancel Charlie's reward" or "Undo" \u2192 cancel pending redemption

## Matching Guidelines

**Reward Title Matching (Semantic):**
- Match by meaning, not exact words: "wants ice cream" \u2192 "Ice cream treat"
- "get the movie" \u2192 "Movie night"
- "wants screen time" \u2192 "Extra screen time"
- Consider common variations and synonyms
- Be flexible with phrasing

**Member Name Matching:**
- Check both \`name\` (full_name) and \`nickname\` fields
- "Charlie" could match nickname "Charlie" or full name "Charles"
- If member name not mentioned, you MUST ask who wants the reward

**Assignment Rules:**
- \`assignment_type: "anyone"\` \u2192 any member can redeem
- \`assignment_type: "individual"\` \u2192 only members in \`assigned_member_ids\` can redeem
- Check the assignment before confirming redemption

**Point Validation:**
- Check member's \`total_points\` against reward's \`point_cost\`
- If insufficient points, inform the user how many more they need
- Never allow redemption if points are insufficient

## Available Rewards

\`\`\`json
{{REWARDS_DATA}}
\`\`\`

## Family Members (with point balances)

\`\`\`json
{{FAMILY_MEMBERS}}
\`\`\`

## Recent Redemptions (for cancel requests)

\`\`\`json
{{RECENT_REDEMPTIONS}}
\`\`\`

## Response Guidelines

**If you can match reward + member with sufficient points:**
Return an ACTION response with \`category: "rewards"\` and \`command: "redeem_reward"\`.

**Single Redemption Example:**
User: "Charlie wants the ice cream reward"
\u2192 Match "Ice cream treat" reward + "Charlie" member
\u2192 Verify Charlie has enough points (check \`total_points\` >= \`point_cost\`)
\u2192 Return action with redemption details

\`\`\`json
{
  "type": "action",
  "voice": "Done! Charlie redeemed Ice cream treat for 50 points. 120 points remaining.",
  "action": {
    "category": "rewards",
    "command": "redeem_reward",
    "parameters": {
      "reward_id": "reward-uuid-from-data",
      "family_member_id": "member-uuid-from-data",
      "reward_title": "Ice cream treat",
      "member_name": "Charlie"
    }
  }
}
\`\`\`

**Voice Response for Redemptions:**
IMPORTANT: Always mention the points spent AND remaining balance in your voice response!

- Single: "Done! Charlie redeemed [reward] for [cost] points. [remaining] points left."
- With encouragement: "Awesome! Sarah got [reward]! [cost] points spent, [remaining] to go."

**If member name is missing:**
Return a RESPONSE asking "Who wants to redeem that reward?" with \`trigger_listening: true\`

**If no matching reward found:**
Return a RESPONSE: "I couldn't find a reward matching [what they said]. Try saying the reward name more specifically."

**If insufficient points:**
Return a RESPONSE explaining the shortage:
"[Member] needs [X] more points for [reward]. They have [current] points but it costs [cost]."

**If reward not available to member (assignment_type: individual):**
Return a RESPONSE: "Sorry, [reward] isn't available to [member]. It's only for [assigned members]."

**For cancel/undo requests:**

IMPORTANT: Check \`recent_redemptions\` above to see pending redemptions. If there are redemptions and the user mentions a member name OR a reward name, look up the actual redemption ID from that data.

**Generic undo (no specifics mentioned):**
If user just says "undo" or "cancel that" without mentioning a member or reward name:
\`\`\`json
{
  "type": "action",
  "voice": "Cancelling that redemption.",
  "action": {
    "category": "rewards",
    "command": "cancel_redemption",
    "parameters": {}
  }
}
\`\`\`

**Specific cancel (member or reward mentioned):**
If user says "cancel Charlie's reward", "undo the ice cream":
1. Find the matching redemption in \`recent_redemptions\`
2. Get the \`id\` (redemption_id) from that record
3. Return action with those details:

\`\`\`json
{
  "type": "action",
  "voice": "Cancelled Charlie's Ice cream treat. 50 points refunded.",
  "action": {
    "category": "rewards",
    "command": "cancel_redemption",
    "parameters": {
      "redemption_id": "actual-uuid-from-recent_redemptions",
      "reward_title": "Ice cream treat",
      "member_name": "Charlie"
    }
  }
}
\`\`\`

**For reward queries (what rewards can X get):**
Return a RESPONSE listing the member's available rewards they can afford:
- Filter by assignment (anyone OR assigned to them)
- Filter by affordability (total_points >= point_cost)
- List rewards with their costs

**For point balance queries (how many points does X have):**
Return a RESPONSE with the member's current point balance from \`family_members\` data.
`;
var INQUIRY_LOCATION_EVENTS = `# Inquiry Context: Location Events

You have been provided with location history data below based on keyword detection in the user's query.

**IMPORTANT: This data shows when family members arrived at or departed from saved locations (Home, Work, School, etc.).**

Current date and time: {{DATE_TIME}}

## What This Data Contains

Location events are recorded when family members:
- Enter a saved location (geofence) - recorded as "arrive"
- Leave a saved location (geofence) - recorded as "depart"

Events are stored for 7 days and include:
- The family member who triggered the event
- The location name (e.g., "Home", "Work", "CFMS") - the user-defined name
- The location type (e.g., "home", "work", "school") - the semantic category
- The event type ("arrive" or "depart")
- The exact time of the event

**IMPORTANT: The \`location_type\` field helps match user queries to locations. For example, if a user asks "when did Charlie leave school?", events at "CFMS" will match because its \`location_type\` is "school".**

**IMPORTANT: Each event has a \`time_local\` field (e.g., "7:21 PM") which is the LOCAL time. Always use \`time_local\` when speaking times to the user. Do NOT try to convert the \`time\` field yourself - it's in UTC and will confuse you.**

## Query Details

- **Member requested**: {{MEMBER_NAME}}
- **Location filter**: {{LOCATION_NAME}}
- **Timeframe**: {{TIMEFRAME}}
- **Event type filter**: {{EVENT_TYPE}}

## How to Interpret This Data

1. **Arrival events** ("arrive") mean the person entered the location's geofence
2. **Departure events** ("depart") mean the person left the location's geofence
3. Events are sorted by time, most recent first
4. **Use \`time_local\` for speaking times** - this is already converted to local time (e.g., "7:21 PM")
5. The \`time\` field is UTC - do not use it for speaking, only for the trip object
6. If no events are found, it means:
   - The person hasn't triggered any geofence events in the timeframe
   - OR location tracking may not be enabled for that person
   - OR there are no saved locations configured

## Response Guidelines

- Use natural, conversational language
- Be specific about times (e.g., "Mary got home at 5:42 PM" not "Mary arrived at home")
- If multiple events, summarize the pattern (e.g., "Dad left work at 5:30 PM and got home at 6:15 PM")
- If no events found, explain what might have happened
- Acknowledge the person by name/nickname in your response
- For "when did X get home?" questions, look for the most recent "arrive" event at "Home"
- For "did X go to work?" questions, look for either an "arrive" at "Work" or "depart" from "Home"

## CRITICAL: Include Trip Data in Response

**You MUST include a \`trip\` object in your response** when answering about a specific arrival or departure event. This allows us to display a map of the journey.

\`\`\`json
{
  "type": "response",
  "voice": "Mary got home at 6:45 PM last night.",
  "text": null,
  "trip": {
    "event_id": "uuid-of-the-primary-event",
    "event_type": "arrive",
    "event_time": "2024-12-12T18:45:00Z",
    "location_name": "Home",
    "member_name": "Mary"
  }
}
\`\`\`

The \`trip\` object contains:
- \`event_id\`: The \`id\` field from the event in the data (the one that directly answers the question)
- \`event_type\`: "arrive" or "depart"
- \`event_time\`: The ISO timestamp of the event
- \`location_name\`: The location name from the event
- \`member_name\`: The family member's name

**The event you include should be the PRIMARY event that answers the user's question.**
- "When did Mary get home?" \u2192 include the arrival event at Home
- "What time did Dad leave work?" \u2192 include the departure event at Work

## Example Responses

Good: "Mary got home at 6:45 PM last night."
\`\`\`json
{
  "type": "response",
  "voice": "Mary got home at 6:45 PM last night.",
  "text": null,
  "trip": {
    "event_id": "abc123",
    "event_type": "arrive",
    "event_time": "2024-12-12T18:45:00Z",
    "location_name": "Home",
    "member_name": "Mary"
  }
}
\`\`\`

Good: "Dad left work at 5:30 PM and got home at 6:15 PM."
\`\`\`json
{
  "type": "response",
  "voice": "Dad left work at 5:30 PM and got home at 6:15 PM.",
  "text": null,
  "trip": {
    "event_id": "def456",
    "event_type": "arrive",
    "event_time": "2024-12-12T18:15:00Z",
    "location_name": "Home",
    "member_name": "Dad"
  }
}
\`\`\`

If no events are found, do NOT include the \`trip\` field:
\`\`\`json
{
  "type": "response",
  "voice": "I don't see any location events for Mary in the last 24 hours.",
  "text": "Location tracking may not be enabled, or she hasn't triggered any geofence events."
}
\`\`\`

## Member Details

{{MEMBER_DETAILS}}

## Retrieved Location Events

\`\`\`json
{{LOCATION_EVENTS_DATA}}
\`\`\`

Now provide a helpful, natural response about the location history. If no events were found, let the user know and suggest possible reasons (location tracking may not be enabled, no geofence events in that timeframe, etc.).
`;
var INQUIRY_TRAVEL_TIME = `# Inquiry Context: Travel Time

You have been provided with travel time data for an upcoming trip or event.

**IMPORTANT: Use this data to answer questions about when to leave, travel times, and arrival planning.**

Current date and time: {{DATE_TIME}}

## What This Data Contains

Travel time calculations include:
- Distance from origin to destination
- Estimated travel time (with current traffic conditions)
- Traffic level indicator (light/moderate/heavy)
- Recommended departure time (accounting for early arrival buffer)
- Early arrival buffer applied (varies by event type)

## Query Details

- **Event**: {{EVENT_TITLE}}
- **Event Start Time**: {{EVENT_START_TIME}}
- **Event Location**: {{EVENT_LOCATION}}
- **Origin**: {{ORIGIN_ADDRESS}}
- **Event Notes**: {{EVENT_NOTES}}

## CRITICAL: Check Event Notes for Arrival Time

**Before using the default recommended departure time, check the event notes for a specific arrival time instruction.**

Look for phrases like:
- "arrive by 11am" or "arrive by 11:00"
- "be there by 10:30"
- "arrival time: 9am"
- "need to be there 30 minutes early"

**If the event notes specify an arrival time, calculate the departure time based on that arrival time, NOT the event start time.** For example:
- Event starts at 12:00 PM but notes say "arrive by 11:00 AM"
- With a 40-minute drive, you should leave by 10:20 AM (to arrive by 11:00 AM)
- Do NOT use the 12:00 PM start time in this case

## How to Interpret This Data

1. **Travel Duration**: The time shown includes current/predicted traffic conditions
2. **Recommended Departure**: The system-calculated departure accounts for:
   - Travel time with traffic
   - Default early arrival buffer (games: 30 min, practices: 15 min, other: 5 min)
   - **However, if event notes specify an arrival time, override this calculation**
3. **Traffic Level**:
   - "light" = Normal conditions, travel time is close to no-traffic estimate
   - "moderate" = Some delays, 10-30% longer than normal
   - "heavy" = Significant delays, >30% longer than normal

## Response Guidelines

- Give a clear, direct answer about when to leave
- **If event notes specify an arrival time, use that for your calculation and mention it**
- Mention the travel time and any traffic considerations
- Include the event start time for context
- If traffic is moderate or heavy, mention this
- Use natural language for times (e.g., "You should leave by 4:15 PM" not "depart at 16:15:00")
- If no travel data is available (e.g., event has no location), explain this clearly

## CRITICAL: Include Timing Data in Response

**You MUST include \`timing\` in your response JSON** with the exact times you calculate. This ensures the visual display matches what you say.

\`\`\`json
{
  "type": "response",
  "voice": "Leave by 10:15 AM to arrive by 11 AM for Jack's game.",
  "text": "It's about a 40-minute drive.",
  "timing": {
    "departure_time": "10:15 AM",
    "arrival_time": "11:00 AM"
  }
}
\`\`\`

The \`timing\` object contains:
- \`departure_time\`: The time you tell the user to leave (formatted like "10:15 AM")
- \`arrival_time\`: The time you expect them to arrive (formatted like "11:00 AM")

**These times MUST match exactly what you say in the voice response.** The display card uses these values directly.

## Example Responses

Good: "The notes say to arrive by 11 AM for Jack's noon game. It's about a 40-minute drive, so you should leave by 10:15 AM."
\`\`\`json
{
  "type": "response",
  "voice": "The notes say to arrive by 11 AM for Jack's noon game. It's about a 40-minute drive, so you should leave by 10:15 AM.",
  "text": null,
  "timing": {"departure_time": "10:15 AM", "arrival_time": "11:00 AM"}
}
\`\`\`

Good: "You should leave by 4:15 PM to get to Jack's soccer game on time. It's about a 25-minute drive, and I've built in 30 minutes for warmup since it's a game."
\`\`\`json
{
  "type": "response",
  "voice": "You should leave by 4:15 PM to get to Jack's soccer game on time. It's about a 25-minute drive.",
  "text": "I've built in 30 minutes for warmup since it's a game.",
  "timing": {"departure_time": "4:15 PM", "arrival_time": "4:40 PM"}
}
\`\`\`

Good: "The dentist appointment is 15 minutes away. Leave by 2:40 PM to arrive a few minutes early for your 3 PM appointment."
\`\`\`json
{
  "type": "response",
  "voice": "The dentist appointment is 15 minutes away. Leave by 2:40 PM to arrive a few minutes early.",
  "text": null,
  "timing": {"departure_time": "2:40 PM", "arrival_time": "2:55 PM"}
}
\`\`\`

Good: "Traffic is moderate right now, so leave a bit earlier than usual - around 5:30 PM to make the 6:30 practice."
\`\`\`json
{
  "type": "response",
  "voice": "Traffic is moderate right now, so leave a bit earlier than usual - around 5:30 PM to make the 6:30 practice.",
  "text": null,
  "timing": {"departure_time": "5:30 PM", "arrival_time": "6:15 PM"}
}
\`\`\`

## Retrieved Travel Time Data

\`\`\`json
{{TRAVEL_TIME_DATA}}
\`\`\`

Now provide a helpful, natural response about when to leave and travel time. Be specific about the recommended departure time, and remember to check the event notes for any specific arrival time requirements.
`;
var INQUIRY_FAMILY_LOCATIONS = `# Inquiry Context: Family Member Current Location

You have been provided with real-time location data below based on keyword detection in the user's query.

**IMPORTANT: This data shows where a family member is RIGHT NOW, along with travel time to get home IF they were to leave now.**

Current date and time: {{DATE_TIME}}

## What This Data Contains

- **Current GPS coordinates** with reverse-geocoded address
- **Travel time and distance from home** (with current traffic conditions) - this is how long it WOULD take, not an ETA
- **Movement status** - whether they're stationary, driving, moving, etc.
- **Whether they're at a saved location** (Home, Work, School, etc.)
- **Today's calendar events** for context about where they might be going

## Query Details

- **Member requested**: {{MEMBER_NAME}}

## How to Interpret This Data

1. **Location fields** (use in this priority order for response):
   - \`at_saved_location.name\` - **BEST** - If present, use this! (e.g., "Home", "Work", "School", "Grandma's")
   - \`location.place_name\` - Business/landmark name from GPS (e.g., "Starbucks", "Tampa International Airport")
   - \`location.address\` - Street address (e.g., "123 Main St, Tampa, FL")
   - \`location.city\` + \`location.state\` - General area (e.g., "Tampa, FL")
2. **Age of location data** (\`age_description\`, \`age_minutes\`) - How recent the GPS fix is
3. **Movement status** (\`movement_status\`) - Key field! Indicates:
   - \`stationary\` - Not moving (recent data)
   - \`likely_stationary\` - Probably not moving (data 5-30 min old)
   - \`driving\` - Actively driving
   - \`in_vehicle_stopped\` - In car but stopped
   - \`moving\` - Walking or slow movement
   - \`unknown_stale_data\` - Data is 30+ minutes old
4. **At saved location** (\`at_saved_location\`) - If they're at a saved place like Home, Work, School, etc. This is the most useful location info when present!
5. **Travel from home** - How long it WOULD take to get home if they left now (NOT an ETA!)
6. **Today's events** - Their calendar for context

## CRITICAL: Travel Time vs ETA

**DO NOT say "she'll be home at X" or "ETA is X" unless they are actively driving (\`movement_status: "driving"\`).**

- If stationary/likely_stationary: Say "about X minutes from home if she left now" or "X minutes away with current traffic"
- If driving: Use \`eta_home_if_left_now\` to give an actual ETA (e.g., "she should be home around 4:15 PM")
- Never assume someone is leaving - they might be at a destination

## Response Guidelines

- Be conversational and helpful
- **Lead with WHERE they are** - address, saved location name, or general area
- **For travel time**: Say "about X minutes from home" or "X away if they left now" - NOT "ETA is X"
- **Mention if they're at a saved location** (e.g., "at Work" or "at School")
- **Use calendar context** if relevant to explain why they might be there
- **Note movement status** if relevant (driving, stationary, etc.)
- **Note data freshness** if location is stale (>5 minutes old)

## Example Responses

**At a saved location (use at_saved_location.name):**
"Mary is at School right now. She's about 25 minutes from home with current traffic."

**At a place with a name (use place_name):**
"Mary is at Starbucks on Dale Mabry right now. It'd take her about 15 minutes to get home if she left now."

**At an address (use address):**
"Mary is at 1234 Main Street in Tampa. She's about 20 minutes from home with current traffic."

**Only city/state available:**
"Mary is in Tampa right now. Traffic is moderate, so it'd take her about 50 minutes to get home if she left now."

**Actively driving:**
"Mary is on the road right now, about 20 minutes from home. She should be back around 3:45 PM."

**With calendar context:**
"Mary is in downtown Tampa - looks like she has a meeting there at 2pm. She's about 35 minutes from home if she leaves after."

**Stale location data:**
"Mary's last known location was near USF campus about 15 minutes ago. She might be in class - I see she has Chemistry at 1pm."

**No location available:**
"I don't have a current location for Mary. Location sharing might not be enabled on her device."

## Member Details

{{MEMBER_DETAILS}}

## Retrieved Location Data

\`\`\`json
{{LOCATION_DATA}}
\`\`\`

## IMPORTANT: Include Map Display

**Always include \`"member_location": true\` in your response** to display a map card showing the member's location with their avatar, distance from home, and travel time. Example:

\`\`\`json
{
  "type": "response",
  "voice": "Mary is at School, about 25 minutes from home.",
  "text": null,
  "member_location": true
}
\`\`\`

Now provide a helpful, natural response about where this family member is. Be careful not to assume they're heading home - phrase travel time as "X minutes from home" not "ETA is X".
`;
var INQUIRY_WEATHER = `# Inquiry Context: Weather Data

You have been provided with weather data below based on the user's weather-related question.

**This data contains current conditions, hourly forecast (next 6 hours), and 10-day daily forecast for the family's location.**

Current date and time: {{DATE_TIME}}

## What This Data Contains

- **Current conditions**: Temperature, weather description, wind speed, humidity
- **Hourly forecast**: Next 6 hours with temperature, precipitation chance, wind, humidity
- **Daily forecast**: 10-day forecast with highs, lows, precipitation chance, UV index
- **Location**: City and state for the forecast

## Query Details

- **Location**: {{LOCATION_CITY}}, {{LOCATION_STATE}}

## How to Interpret This Data

1. **Temperature**: All temperatures are in Fahrenheit
2. **Precipitation chance**: Percentage chance of rain/snow (rounded to 5%)
3. **Wind speed**: In miles per hour (mph)
4. **Humidity**: Percentage
5. **UV Index**: Scale 0-11+ (0-2 low, 3-5 moderate, 6-7 high, 8-10 very high, 11+ extreme)

## Response Guidelines

- **Be conversational and natural** - Answer like a helpful family assistant
- **Lead with the most relevant info** for their question (current temp, rain chance, etc.)
- **Keep voice responses concise** - 20 words max for voice
- **Add context when helpful** - "Good day for outdoor activities" or "Might want a jacket"
- **Don't recite all the data** - Pick what's relevant to their question
- **Use show_weather flag** when visual would help (forecast questions, planning questions)

## Example Questions and Responses

**"What's the weather?"** (general question)
- Voice: "It's 45 degrees and cloudy. Chance of rain this afternoon around 60%."
- Text: null (or add wind/humidity if notably high/low)
- show_weather_overlay: true

**"Will it rain today?"** (specific question)
- Voice: "Yes, 60% chance of rain starting around 3pm. Might want an umbrella."
- Text: null
- show_weather_overlay: false (simple answer, no visual needed)

**"What's the weather this weekend?"** (forecast question)
- Voice: "Saturday looks nice, sunny and 55. Sunday has a 40% chance of showers."
- Text: null
- show_weather_overlay: true (user wants to see the forecast)

**"Should I bring a jacket?"** (practical question)
- Voice: "Yes, it's 45 degrees now and dropping to 38 tonight. Definitely jacket weather."
- Text: null
- show_weather_overlay: false

**"How windy is it?"** (specific detail)
- Voice: "Winds are about 15 miles per hour right now."
- Text: null
- show_weather_overlay: false

**"Is it a good day for the park?"** (planning question)
- Voice: "Perfect day for it! 68 degrees and sunny, low chance of rain."
- text: null
- show_weather_overlay: true

## Retrieved Weather Data

\`\`\`json
{{WEATHER_DATA}}
\`\`\`

## IMPORTANT: Show Weather Overlay Flag

If showing a visual forecast would help the user (general weather questions, forecast questions, multi-day planning questions), set \`show_weather_overlay: true\` in your response:

\`\`\`json
{
  "type": "response",
  "voice": "Here's the forecast. Currently 45 and cloudy with rain expected this afternoon.",
  "text": null,
  "show_weather_overlay": true
}
\`\`\`

For simple questions (specific temp, yes/no rain questions, wind speed), you can omit the flag or set it to false.

Now provide a helpful, natural response about the weather. Be conversational and answer what they actually asked.
`;
var INQUIRY_SPORTS = `# Sports Data

You requested sports data and here are the results.

The user asked: "{{USER_REQUEST}}"

Sports results (live from the sports provider):
{{SPORTS_DATA}}

## Response Guidelines

- Answer the user's specific question directly and conversationally \u2014 a score, a
  result, who won, or when the next game is.
- Lead with the outcome: e.g. "Mexico beat South Korea 2-0" or "The Lakers play
  the Celtics tonight at 7:30."
- **Always write scores as digits joined by a hyphen \u2014 "2-0", "3-1", "110-104" \u2014
  never spelled out ("two to nothing", "zero to zero"). When you name the leading
  or winning team, put their score first: "France leads 1-0".**
- Use the team/country names from the data. Include the score when the game is
  final or in progress; for upcoming games give the matchup and start time. If the
  game is in progress, include the clock/period from \`detail\` (e.g. "37'", "4th").
- **Dates are read aloud: say full day and month names ("Sunday, July 19"), never abbreviations
  ("Sun, Jul 19") \u2014 TTS pronounces those as words. Prefer "today"/"tomorrow" when they apply.**
- **The data has ONLY fixtures and scores \u2014 no rosters, line-ups, players, or standings. If the
  user asked something this data cannot answer (e.g. "who's starting at striker?"), say you don't
  have that rather than reading the fixture back at them: repeating the schedule answers nothing.**
- **Scoring detail (when the data includes an \`events\` array): mention the key
  scoring plays in the \`text\` field, not the spoken \`voice\`. Use the \`clock\` and
  \`player\` from each event \u2014 phrasing follows the sport: soccer goals "Messi 38'",
  football "Kelce TD (Q2)", etc. Mark soccer penalties "(pen)" and own goals
  "(OG)". Keep \`voice\` to the score/result; put scorers and extra games in \`text\`.**
  Not every sport returns events (e.g. basketball usually has none) \u2014 if \`events\`
  is absent, just give the score.
- If there are multiple games, summarize the most relevant one (the team the user
  asked about) in the voice; put extra games in the text field.
- If the results are EMPTY (no game in the window we checked), use your Google Search
  to find the real answer, and give the ACTUAL date AND local start time \u2014 e.g. "They
  don't play today; their next game is Thursday at 7:10 PM." Convert to the user's local
  timezone and say the day plus the clock time; never answer with just a day, a vague
  "later this week", or a time in another timezone. If the results are non-empty but
  don't contain the game asked about, say you couldn't find that game.
- NEVER invent a score, a scorer, or a kickoff time \u2014 a searched answer must come from
  the search, not from memory.
- Keep the spoken \`voice\` answer under 25 words and natural to hear aloud.
`;
var INQUIRY_DASHIE_HELP = `# Inquiry Context: Dashie Product Help

The user asked about Dashie itself \u2014 its features, settings, how to do something, or how to fix a
problem. Curated product documentation has been retrieved below. It is the ONLY trustworthy source
about Dashie: answer from it, never from your general knowledge or the web.

## Response Guidelines

- **Answer only from the documentation below.** If it covers the question, lead with the direct
  answer in one or two sentences.
- **Never invent** settings locations, menu names, steps, prices, or features. Wrong directions
  are worse than no answer.
- **Spoken-friendly** \u2014 conversational plain sentences; no lists, headings, or markdown. Turn
  written steps like "Settings \u2192 Display \u2192 Manage Themes" into speech: "open Settings, then
  Display, then Manage Themes."
- **Keep beta caveats** \u2014 if the documentation says a feature is newer or may not be on the
  user's plan yet, keep that caveat in your answer.
- **If \`found\` is false or the documentation doesn't actually answer the question**, say you're
  not sure about that one. Do not guess, and do not offer to search the web for it.

## Example Questions and Responses

**"How do I add a calendar?"**
- Voice: "Open Settings, then Calendar, then Add Calendar \u2014 you can connect a Google or Outlook account from there."

**"What can you do?"**
- Voice: "I can help with your family calendar, weather, chores, timers, smart-home control, and questions like this one \u2014 just ask."

**"How much does Dashie cost?"** (not covered)
- Voice: "I'm not sure about pricing, honestly \u2014 I don't want to guess at a number."

## Retrieved Product Documentation

\`\`\`json
{{DASHIE_HELP_DATA}}
\`\`\`

Provide a helpful, spoken-friendly response based only on this documentation.
`;
var INQUIRY_PERSONALITIES = `# Inquiry Context: Personalities

The user asked about Dashie's personalities \u2014 either what's available, or to switch to one.

## Available Personalities

\`\`\`json
{{PERSONALITY_CATALOG}}
\`\`\`

This list is the ONLY source of truth. Never invent a personality that isn't in it, and never
promise one you can't see here.

## Decide which of the two things they want

### A. They're ASKING what personalities exist
("what personalities do you have", "who can you be", "what are my options")

Respond with \`"type": "response"\`:
- **voice**: name just TWO OR THREE as examples, conversationally, and mention there are more.
  Keep it to one sentence \u2014 do NOT read the whole list aloud, it's tedious to listen to.
  e.g. "I can be a pirate, a wizard, or a princess \u2014 and a few more besides."
- **text**: list ALL of them, one per line, as \`Name \u2014 short description\`. This is the screen,
  so completeness belongs here rather than in the spoken line.
- **image**: null.

### B. They're asking to SWITCH
("switch to the princess personality", "be a pirate", "talk like a cowboy", "go back to normal")

Respond with \`"type": "action"\`:

\`\`\`json
{
  "type": "action",
  "voice": "Switching to Princess now.",
  "text": null,
  "action": {
    "category": "personality",
    "command": "set_personality",
    "parameters": {"key": "princess", "name": "Princess"}
  }
}
\`\`\`

- \`key\` MUST be the exact \`key\` from the catalog above \u2014 not the spoken words.
- Match generously on intent: "be a wizard", "talk like Dumbledore", "do the wizard voice" all
  mean \`wizard\`. Requests to go back to normal/default/"just be Dashie" mean \`dashie\`.
- **\`voice\` MUST be a short real sentence \u2014 NEVER null and never empty.** Keep it to a brief
  handoff like "Switching to Princess now." (max 8 words). It is spoken in the OUTGOING voice,
  and the new personality greets the family straight after, so do not welcome them yourself and
  do not describe the new character. A null or empty \`voice\` makes the system read this JSON
  aloud instead.
- If NOTHING in the catalog plausibly matches what they asked for, do not switch. Use
  \`"type": "response"\` instead and say which ones you do have (per branch A).

## Ambiguity

If it's genuinely unclear whether they're asking or switching, prefer branch A (just tell them
the options). Listing is harmless; switching the household's assistant by mistake is not.
`;
var AVAILABLE_TOOLS_LIST = `- calendar_events: query: {time_range: "today|tomorrow|this_week|next_week|weekend|next_weekend|next_30_days|next_60_days|next_12_months|date_range|<weekday e.g. wednesday for that specific day>", start_date?: "YYYY-MM-DD", end_date?: "YYYY-MM-DD", member_name?: "name (for a specific person)", query?: "keyword to find ONE specific event e.g. physical therapy (for "what time is X")", tags?: ["soccer"], mode?: "next|list"} - Family calendar events. Set member_name when the question is about one person; use "weekend" for "this weekend" and "next_weekend" for "next weekend"; use mode "next" for a single upcoming event ("when is the next game"), "list" (default) for an overview ("what's on this weekend"). For a NAMED month or explicit period ("in December", "the week of the 20th") use time_range "date_range" WITH start_date + end_date covering it (a named month = its NEXT occurrence). For "when is X" with NO period named ("when is Veeva Break"), use query + mode "next" + time_range "next_12_months" so the search can't miss a far-out event
- calendar_write: query: {action: "create|update|delete|confirm|cancel", title?: "event title (create) or the NEW title (update)", date?: "YYYY-MM-DD (create, or the NEW day on update)", start_time?: "HH:MM 24h", end_time?: "HH:MM 24h", all_day?: true, location?: "place", description?: "details", calendar_name?: "which calendar \u2014 when the user names one OR answers the which-calendar question", calendar_names?: ["Dad work","Mom"] (when they name MORE THAN ONE calendar \u2014 "add it to Dad and Mom's calendars"), match_query?: "words identifying the EXISTING event (update/delete), e.g. dentist", match_date?: "YYYY-MM-DD the existing event is on, if the user named its day", scope?: "all (ONLY when they say the whole series/all of them; default is just that one)"} - CHANGE the family calendar: action "create" to add ("add/put/schedule X on the calendar", "can you add an event\u2026"), "update" to change an existing event ("move/change/reschedule/rename my dentist appointment"), "delete" to remove one ("cancel/delete/remove my dentist appointment" \u2014 cancelling an APPOINTMENT/EVENT is a delete, not a conversation-cancel). Emit the action IMMEDIATELY with whatever the user actually said \u2014 every field is optional (a bare "add an event to dad's calendar" is a valid create with ONLY calendar_name); the DEVICE walks the user through anything missing (what to add, day and time, which calendar, which event) and ALWAYS asks for confirmation before touching the calendar. NEVER invent a field, NEVER ask your own follow-up questions for this tool \u2014 call it and let the device ask. For update/delete identify the existing event in match_query (+ match_date if they named its day) and put ONLY the changes in the top-level fields ("move the dentist to 4pm" = match_query "dentist" + start_time "16:00"). Dates are ABSOLUTE from the current date in your context ("Friday" = a real YYYY-MM-DD; "Friday at 8am" = date + start_time together). Omit end_time unless stated (defaults to one hour / the event's current length; "two hours" = end_time is start plus that). EXCEPTION \u2014 a SPORTING EVENT (a game, match, or fixture: "add the Argentina game", "put the Chiefs game on the calendar"): set end_time to TWO hours after start_time (e.g. start 15:00 \u2192 end_time 17:00), since games run long \u2014 unless the user gives a duration. When the user answers a device question, re-emit the SAME action carrying the newly answered field(s) (the device remembers the rest); AFTER the device asks its confirmation question, ANY yes ("yes", "yep", "do it", "go ahead", "delete it") = action "confirm" \u2014 NEVER re-send create/update/delete at that point unless the user CHANGED a detail ("make it two hours" = re-emit the action with the corrected field); "no"/"never mind" there = action "cancel". NOT for reading the calendar (calendar_events), NOT for reminders/timers (schedule_action)
- family_members: query: {} - Info about family members (age, relationship, etc.)
- web_search: query: "search string" - Current events, news, external info (IMPORTANT: query is a STRING)
- personalities: query: {} - Dashie's PERSONALITIES/characters: what's available AND switching to one ("what personalities do you have", "who can you be", "switch to the princess personality", "be a pirate", "talk like a wizard", "go back to normal"). The list lives in the database and changes \u2014 never answer from memory or say you have no personalities
- chores: query: {hint: "task description", member_hint: "name"} - When someone reports completing a chore
- rewards: query: {} - Rewards catalog and redemption status
- schedule_action: query: {time: "HH:MM" (24h local) OR delay_minutes: number, recurrence: "once"|"daily", kind: "notify"|"command"|"prompt", prompt: "see kind", label: "short confirmation e.g. 'check the oven'"} - Use WHENEVER the request has a future time or delay attached, even for things you could answer now: "remind me to check the oven in 3 minutes", "tell me a joke in 5 minutes", "turn the porch light off at 9:30", "at 6am read me the weather". The delay/time means DEFER \u2014 do NOT answer/act now, schedule it. kind picks what happens at fire time: "notify" = a plain reminder/announcement \u2014 Dashie just SPEAKS the text, no AI involved ("remind me to X", "tell me to X at 9") \u2014 prompt is the announcement itself, e.g. "check the oven" (strip the "remind me to" wrapper); "command" = a smart-home CONTROL action (turn on/off, lock, open \u2014 Dashie issues it directly at that time); "prompt" = something Dashie must THINK about, check, or look up at fire time ("tell me IF the garage is open", "read me the weather", "tell me a joke") \u2014 prompt is the instruction as a user request. prompt is REQUIRED for every kind \u2014 never emit the call without it (for kind="command" it's the control action itself, e.g. "turn on the string lights"). delay_minutes for "in N minutes/hours" \u2014 fractional for sub-minute delays ("in thirty seconds" = 0.5); time for a clock time. recurrence defaults to "once" \u2014 a bare clock time ("at 6am read me the weather", "turn the porch light off at 9:30") is a ONE-SHOT; only use "daily" when the user EXPLICITLY asks for a repeat ("every night at 9pm", "each morning", "every day at 6am"). Never turn a one-off into a standing daily alarm. ("daily" requires time, never delay_minutes.) NOT for sensor thresholds.
- location_events: query: {member_name: "Mary", location_name: "home", timeframe: "today|yesterday|last_night", event_type: "arrive|depart"} - Arrival/departure history
- travel_time: query: {event_title: "game", member_name: "Jack"} - When to leave for an event
- family_locations: query: {member_name: "Mary"} - Current GPS location ("where is X right now?")
- weather_data: query: {timeframe: "current|today|tonight|tomorrow|weekend|this_week|precip_timing|<weekday e.g. saturday>", location?: "city or place, ONLY if the user names one \u2014 omit for the family's home location"} - Current conditions or forecast. Use timeframe to capture what they asked ("right now" \u2192 current, "this weekend" \u2192 weekend, "will it rain today" \u2192 today, "what's the weather tomorrow" \u2192 tomorrow, "when will the rain stop"/"when does it start raining" \u2192 precip_timing)
- home_assistant: query: {command_hint: "transcript"} - Smart home control NOW (lights, thermostat, garage, etc.). If the request has a future time or delay ("turn the porch light off in 5 minutes", "turn on the lights at 9:30"), DO NOT use this \u2014 use schedule_action so it runs later, not now.
- sports: query: {sport: "soccer|football|basketball|baseball|hockey", league: "nfl|nba|mlb|nhl|college-football|world-cup|premier-league|...", team: "team or country name", date: "YYYY-MM-DD (optional)", type: "score|schedule", list: true (for PLURAL "games")} - Live game SCORES and SCHEDULES, and nothing else. MANDATORY for the score, the result, who won, the kickoff time, "what time is the game", WHICH TEAMS are playing, and upcoming fixtures. NEVER answer THOSE from your own knowledge or a web/Google search, not even one you are sure about: this tool is the ONLY source with the user's correct LOCAL time (a web answer comes back in the wrong timezone) and the ONLY way the scorecard appears on screen. Always emit an info_request for this tool instead of replying directly. **This tool returns ONLY fixtures and scores. It has NO roster, lineup, player, stats, standings, or club-history data.** A question about WHO PLAYS or PLAYED a position ("who's starting at striker for Spain", "who's their quarterback"), a player's stats or injuries, the table/standings, or a club's history is NOT a score/schedule question \u2014 use web_search for those, even when the user names a team or a specific game. Calling this tool for a roster question hands you back the FIXTURE, and reading that out loud answers nothing (it just repeats the schedule at the user). Set list:true for any MULTI-game ask \u2014 "what games are on", "the NEXT games", "upcoming/today's World Cup games" (the plural "games" is the tell); leave it off for one team's score or "the next game" (singular). A FOLLOW-UP asking for MORE about a game already discussed ("tell me more about that game", details, color, highlights, a recap, how a team played) is ALSO not a score/schedule question: use web_search with a SELF-CONTAINED query naming both teams and the date from the conversation (e.g. "Yankees White Sox July 27 2026 recap key plays") \u2014 NEVER answer it from conversation memory alone; the score you already gave is exactly what the user wants to go BEYOND
- get_current_time: query: {} - The CURRENT local date, time, and day of week. Call for "what time is it", "what's the date", "what day is it", AND to anchor any today/tomorrow/this-week/next reasoning. Authoritative \u2014 use it instead of your own clock, which is UTC and wrong for the user.
- music: query: {action: "now_playing|search|play|pause|resume|stop|next|previous|volume_up|volume_down", query?: "song/artist/album text (for search or play)", uri?: "exact uri from a prior search result (for play)", speaker?: "speaker name, ONLY if the user names one"} - Music: what's playing now (action "now_playing" \u2014 "what song is this", "who sings this"), find music ("search" \u2014 returns matches to disambiguate), play it ("play" with the chosen uri, or a query), and transport \u2014 "stop the music"\u2192stop, "pause"\u2192pause, "turn it up/down"\u2192volume_up/volume_down, "next/skip"\u2192next. NEVER use "search" for a transport phrase
- video_feeds: query: {action: "show|hide|show_all|hide_all|playback", camera?: "the camera name the user said, e.g. \\"pool\\" or \\"front door\\"", time?: "for playback ONLY \u2014 the user's own words for WHEN, e.g. \\"10 minutes ago\\", \\"at 10:30pm\\", \\"last night\\""} - Cameras: show a live feed ("show" + camera), hide it ("hide"), all of them ("show_all"/"hide_all"), or play back RECORDED footage from a past moment ("playback" + camera + time \u2014 "what happened at the front door around 3pm", "show me the pool camera 10 minutes ago"). Pass the user's own words through as "time" \u2014 the device resolves them in its own timezone. Use "show" (live) when no past time is mentioned
- open_app: query: {app: "the app name the user said, e.g. \\"Netflix\\", \\"YouTube TV\\", \\"Prime Video\\", \\"Spotify\\""} - Open/launch a whole app on this screen: "open Netflix", "put on YouTube TV", "launch Spotify", "go to Prime Video". Pass the app name the user said through as "app"; the device matches it against installed apps. Use ONLY for opening an app \u2014 NOT for playing a specific song (use music) or showing cameras (use video_feeds)
- dashie_help: query: {question: "the user's question"} - Detailed help on Dashie ITSELF: settings and where to find them, how-to steps, troubleshooting ("how do I add a calendar", "where do I change the theme", "why is my screen black"). Do NOT use for who/what-are-you or general "about Dashie" questions \u2014 answer those directly from your identity context. Never web_search Dashie product questions`;
function fillTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const v = values[key];
    return v !== void 0 && v !== null ? v : "";
  });
}
function formatDateTime(tz) {
  const now = /* @__PURE__ */ new Date();
  const requested = tz?.trim();
  const serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    return fmtInZone(now, requested || serverZone);
  } catch {
    return fmtInZone(now, serverZone);
  }
}
function fmtInZone(now, timeZone) {
  const date = now.toLocaleDateString("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  const time = now.toLocaleTimeString("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });
  return `${date}, ${time}`;
}

// supabase/functions/voice-conversation/personality-prompt-builder.js
function buildPersonalityPrompt(personality) {
  if (!personality) {
    return { responsePrefix: "", responseSuffix: "" };
  }
  if (!hasStructuredFields(personality)) {
    return {
      responsePrefix: "",
      responseSuffix: addFamilyNotes("", personality.family_notes)
    };
  }
  let prefix = "";
  let suffix = "";
  if (personality.personality_overview) {
    const overview = personality.personality_overview.trim();
    const name = personality.name || "this character";
    prefix += `Embody this character, ${name}: ${overview}`;
    if (!prefix.endsWith(".") && !prefix.endsWith("!") && !prefix.endsWith("?")) {
      prefix += ".";
    }
    prefix += "\n\n";
  }
  if (personality.similar_persona) {
    prefix += `Channel a personality similar to ${personality.similar_persona}.

`;
  }
  if (personality.adjectives && personality.adjectives.length > 0) {
    const adjectiveList = formatList(personality.adjectives);
    prefix += `Be ${adjectiveList} in your responses.

`;
  }
  if (personality.topics && personality.topics.length > 0) {
    const topicList = formatList(personality.topics);
    prefix += `Topics you naturally reference: ${topicList}.

`;
  }
  if (personality.example_phrases && personality.example_phrases.length > 0) {
    suffix += "\n\nUse phrases like:\n";
    personality.example_phrases.forEach((phrase) => {
      const cleanPhrase = phrase.trim().replace(/^["']|["']$/g, "");
      suffix += `- "${cleanPhrase}"
`;
    });
  }
  suffix = addFamilyNotes(suffix, personality.family_notes);
  suffix += "\n\nVARY YOUR RESPONSES - don't start every response the same way. Mix up your openings.";
  suffix += `

CRITICAL \u2014 brevity OVERRIDES the character's urge to elaborate:
- LEAD WITH THE ANSWER. No wind-up, no restating the question, no "Ah, you're asking about..." preamble before the facts.
- Spoken "voice": ONE sentence, ~25 words max. Give the answer plus at most a couple words of character flavor, then STOP.
- No closing flourish, no reflection on what it reminds you of, no tangents or rhetorical questions back to the user.
- Character lives in a word or two of word CHOICE, never in extra sentences. A wordy answer is a worse answer, even in character.`;
  return { responsePrefix: prefix.trim(), responseSuffix: suffix };
}
function addFamilyNotes(suffix, familyNotes) {
  if (familyNotes && familyNotes.trim()) {
    suffix += `

Family-specific notes: ${familyNotes.trim()}`;
  }
  return suffix;
}
function formatList(items) {
  if (!items || items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  const allButLast = items.slice(0, -1).join(", ");
  const last = items[items.length - 1];
  return `${allButLast}, and ${last}`;
}
function hasStructuredFields(personality) {
  if (!personality) return false;
  return !!(personality.personality_overview || personality.similar_persona || personality.adjectives && personality.adjectives.length > 0 || personality.topics && personality.topics.length > 0 || personality.example_phrases && personality.example_phrases.length > 0);
}

// supabase/functions/voice-conversation/prompt.ts
var INQUIRY_BY_TYPE = {
  "home-assistant": INQUIRY_HOME_ASSISTANT,
  "web-search": INQUIRY_WEB_SEARCH,
  "calendar-events": INQUIRY_CALENDAR_EVENTS,
  "family-members": INQUIRY_FAMILY_MEMBERS,
  "chores": INQUIRY_CHORES,
  "rewards": INQUIRY_REWARDS,
  "location-events": INQUIRY_LOCATION_EVENTS,
  "travel-time": INQUIRY_TRAVEL_TIME,
  "family-locations": INQUIRY_FAMILY_LOCATIONS,
  "weather": INQUIRY_WEATHER,
  "sports": INQUIRY_SPORTS,
  "dashie-help": INQUIRY_DASHIE_HELP,
  "personalities": INQUIRY_PERSONALITIES
};
function languageNameFor(code) {
  return {
    "en-US": "English",
    "en-GB": "British English",
    "es-ES": "Spanish",
    "es-US": "Spanish",
    "fr-FR": "French",
    "de-DE": "German",
    "it-IT": "Italian",
    "pt-BR": "Brazilian Portuguese",
    "nl-NL": "Dutch",
    "pl-PL": "Polish",
    "hi-IN": "Hindi",
    "ja-JP": "Japanese",
    "ko-KR": "Korean",
    "zh-CN": "Simplified Chinese"
    // deno-lint-ignore no-explicit-any
  }[code] || code;
}
var DEVICE_ONLY_TOOLS = ["music", "video_feeds", "open_app"];
var MULTI_ANCHOR_ONE_OF = "Respond with ONE of these JSON formats:";
var MULTI_ANCHOR_ONE_OF_PATCHED = "Respond with ONE of these JSON formats (use MULTI only for several DIFFERENT tools in one request):";
var MULTI_ANCHOR_CRITICAL = "CRITICAL: Respond ONLY with raw JSON.";
function injectMultiBlock(prompt) {
  if (!prompt.includes(MULTI_ANCHOR_ONE_OF) || !prompt.includes(MULTI_ANCHOR_CRITICAL)) {
    console.warn("\u26A0\uFE0F multi block: anchors not found in initial prompt \u2014 emitting without multi");
    return prompt;
  }
  return prompt.replace(MULTI_ANCHOR_ONE_OF, MULTI_ANCHOR_ONE_OF_PATCHED).replace(MULTI_ANCHOR_CRITICAL, `
${RESPONSE_FORMAT_MULTI}
${MULTI_ANCHOR_CRITICAL}`);
}
function dropUnofferedExamples(text, context) {
  const offered = new Set(offeredToolNames(context));
  return text.split("\n").filter((line) => {
    const m = line.match(/tool:\s*"([a-z_]+)"/);
    return !m || offered.has(m[1]);
  }).join("\n");
}
function toolsListFor(context) {
  const drop = [];
  if (context.webSearchEnabled === false) drop.push("- web_search:");
  if (context.announcement === true) drop.push("- schedule_action:");
  if (context.calendarWriteEnabled === false) drop.push("- calendar_write:");
  if (Array.isArray(context.clientTools)) {
    for (const tool of DEVICE_ONLY_TOOLS) {
      if (!context.clientTools.includes(tool)) drop.push(`- ${tool}:`);
    }
    if (!context.clientTools.includes("calendar_write")) drop.push("- calendar_write:");
  }
  if (drop.length === 0) return AVAILABLE_TOOLS_LIST;
  return AVAILABLE_TOOLS_LIST.split("\n").filter((l) => !drop.some((d) => l.trimStart().startsWith(d))).join("\n");
}
function offeredToolNames(context) {
  const names = [];
  for (const line of toolsListFor(context).split("\n")) {
    const m = line.match(/^\s*-\s*([A-Za-z0-9_]+)\s*:/);
    if (m) names.push(m[1]);
  }
  return names;
}
function buildInquiryValues(inquiryType, data, baseValues) {
  switch (inquiryType) {
    case "calendar-events":
      return {
        ...baseValues,
        MEMBER_NAME: data.member_details?.nickname || data.member_details?.name || "the family",
        TAGS_CONTEXT: data.metadata?.tag_filter ? ` and events related to ${data.metadata.tag_filter.join(", ")}` : "",
        TAGS_FILTER_NOTE: data.metadata?.tag_filter ? ` (filtered by: ${data.metadata.tag_filter.join(", ")})` : "",
        MEMBER_DETAILS: data.member_details ? JSON.stringify(data.member_details, null, 2) : "No specific member filter applied.",
        CALENDAR_DATA: JSON.stringify(data, null, 2)
      };
    case "family-members":
      return { ...baseValues, FAMILY_DATA: JSON.stringify(data, null, 2) };
    case "web-search":
      return { ...baseValues, SEARCH_RESULTS: JSON.stringify(data, null, 2) };
    case "dashie-help":
      return { ...baseValues, DASHIE_HELP_DATA: JSON.stringify(data, null, 2) };
    case "personalities":
      return { ...baseValues, PERSONALITY_CATALOG: JSON.stringify(data, null, 2) };
    case "chores":
      return {
        ...baseValues,
        CHORES_DATA: JSON.stringify(data.chores, null, 2),
        FAMILY_MEMBERS: JSON.stringify(data.family_members, null, 2),
        TODAYS_COMPLETIONS: JSON.stringify(data.todays_completions, null, 2)
      };
    case "rewards":
      return {
        ...baseValues,
        REWARDS_DATA: JSON.stringify(data.rewards, null, 2),
        FAMILY_MEMBERS: JSON.stringify(data.family_members, null, 2),
        RECENT_REDEMPTIONS: JSON.stringify(data.recent_redemptions, null, 2)
      };
    case "location-events":
      return {
        ...baseValues,
        MEMBER_NAME: data.member_details?.nickname || data.member_details?.name || data.query?.member_name || "unknown",
        LOCATION_NAME: data.query?.location_name || "any location",
        TIMEFRAME: data.query?.timeframe || "today",
        EVENT_TYPE: data.query?.event_type || "all events",
        MEMBER_DETAILS: data.member_details ? JSON.stringify(data.member_details, null, 2) : "Member not found or not specified.",
        LOCATION_EVENTS_DATA: JSON.stringify(data, null, 2)
      };
    case "travel-time":
      return {
        ...baseValues,
        EVENT_TITLE: data.event?.title || data.event?.summary || "Unknown event",
        EVENT_START_TIME: data.event?.startTime || data.timing?.eventStart || "Unknown time",
        EVENT_LOCATION: data.event?.location || data.destination?.address || "Unknown location",
        ORIGIN_ADDRESS: data.origin?.address || "Home",
        EVENT_NOTES: data.event?.description || data.event?.notes || "No notes",
        TRAVEL_TIME_DATA: JSON.stringify(data, null, 2)
      };
    case "family-locations":
      return {
        ...baseValues,
        MEMBER_NAME: data.member?.nickname || data.member?.name || data.query?.member_name || "unknown",
        MEMBER_DETAILS: data.member ? JSON.stringify(data.member, null, 2) : "Member not found.",
        LOCATION_DATA: JSON.stringify(data, null, 2)
      };
    case "weather":
      return {
        ...baseValues,
        LOCATION_CITY: data.location?.city || "Unknown",
        LOCATION_STATE: data.location?.state || "",
        WEATHER_DATA: JSON.stringify(data, null, 2)
      };
    case "sports":
      return { ...baseValues, SPORTS_DATA: JSON.stringify(data, null, 2) };
    case "home-assistant":
      return {
        ...baseValues,
        HA_ENTITIES: JSON.stringify(data.entities || [], null, 2),
        HA_ENTITIES_BY_DOMAIN: JSON.stringify(data.entities_by_domain || {}, null, 2),
        COMMAND_HINT: data.command_hint || baseValues.USER_REQUEST
      };
    default:
      return baseValues;
  }
}
var PROVIDED_SPORTS_BLOCK = `## Pre-fetched Sports Data
Sports data has ALREADY been retrieved for the user's question \u2014 do NOT request it again:
\`\`\`json
{{PROVIDED_SPORTS}}
\`\`\`
If this data answers the question, reply with type "response", leading with the result **in your personality's voice** (a greeting or flourish is welcome; keep the score itself factual). If the data is the wrong game/team or empty, instead reply with type "info_request", tool "sports", and a corrected query.`;
var PROVIDED_CALENDAR_BLOCK = `## Pre-fetched Calendar Data
The family calendar for {{TIME_RANGE}} has ALREADY been retrieved for the user's question \u2014 do NOT request it again:
\`\`\`json
{{PROVIDED_CALENDAR}}
\`\`\`
{{MEMBERS_SECTION}}Answer from this data with type "response", in your personality's voice:
- Attribute events to people using each event's \`assigned_to\` matched against the family members \u2014 say "Charlie's soccer practice", not the raw calendar name. Use nicknames when present.
- ONE event: describe it naturally in one sentence \u2014 whose it is, what, and when. Mention the location only if it's a real place name (never a URL or meeting link).
- MULTIPLE events: an intelligent digest in at most two sentences \u2014 the count, the shape of the schedule (a busy morning, a free evening, back-to-back appointments), and one or two notable items. NEVER read the full list aloud \u2014 the events are already shown on screen.
- If \`truncated\` is true, this list is only the FIRST \`events.length\` of \`total\` events \u2014 NEVER say something isn't on the calendar; if you don't see what was asked about, say the schedule is packed and you don't see it among the first ones, and point to the on-screen list.
- Otherwise this data is the complete calendar for {{TIME_RANGE}}: if nothing matches what was asked, say so plainly \u2014 do not guess.
- If the user asked about a time window this data does NOT cover, instead reply with type "info_request", tool "calendar_events", and the correct query.`;
function providedCalendarBlock(provided) {
  const cal = provided ?? {};
  const timeRange = cal.time_range || "the requested period";
  const members = Array.isArray(cal.members) && cal.members.length ? `Family members (for attribution):
\`\`\`json
${JSON.stringify(cal.members, null, 2)}
\`\`\`
` : "";
  const events = cal.events ?? [];
  const payload = { total: cal.total ?? events.length, events };
  if (cal.truncated) payload.truncated = true;
  return PROVIDED_CALENDAR_BLOCK.replaceAll("{{TIME_RANGE}}", timeRange).replace("{{PROVIDED_CALENDAR}}", JSON.stringify(payload, null, 2)).replace("{{MEMBERS_SECTION}}", members);
}
function buildPrompt({ userRequest, inquiryType, retrievedData, context = {} }) {
  const dateTime = formatDateTime(context.timezone);
  let personalityConfig = null;
  if (context.customPersonalityConfig) {
    const result = buildPersonalityPrompt(context.customPersonalityConfig) || {};
    personalityConfig = {
      name: context.customPersonalityConfig.name,
      responsePrefix: result.responsePrefix,
      responseSuffix: result.responseSuffix
    };
  }
  const languageCode = context.language || "system";
  const languageInstruction = languageCode && languageCode !== "system" ? `Respond in ${languageNameFor(languageCode)}.` : "";
  const toolsList = toolsListFor(context);
  const baseValues = {
    // Assistant identity is a template variable (Chickadee open-core: the open
    // build names its own persona). Default 'Dashie' — a request without
    // assistant_name renders byte-identically to the pre-variable prompt.
    ASSISTANT_NAME: context.assistantName || "Dashie",
    DATE_TIME: dateTime,
    USER_REQUEST: userRequest,
    CHAT_HISTORY: context.chatHistory || "",
    AVAILABLE_TOOLS_LIST: toolsList,
    LANGUAGE_INSTRUCTION: languageInstruction,
    // Room awareness: the device's HA area (or '' when unknown → the template's fallback prose).
    // Rendered as {{DEVICE_AREA}} in the home_assistant prompt for room-relative resolution.
    DEVICE_AREA: context.deviceArea || "",
    ...context
  };
  let prompt = fillTemplate(BASE_CONTEXT, baseValues);
  if (personalityConfig) {
    prompt = (personalityConfig.responsePrefix || "") + "\n\n" + prompt;
  }
  if (!inquiryType && context.providedSports) {
    prompt += "\n\n" + PROVIDED_SPORTS_BLOCK.replace("{{PROVIDED_SPORTS}}", JSON.stringify(context.providedSports, null, 2));
  }
  if (!inquiryType && context.providedCalendar) {
    prompt += "\n\n" + providedCalendarBlock(context.providedCalendar);
  }
  if (inquiryType && retrievedData) {
    const inquiryTemplate = INQUIRY_BY_TYPE[inquiryType];
    if (inquiryTemplate) {
      const inquiryValues = buildInquiryValues(inquiryType, retrievedData, baseValues);
      prompt += "\n\n" + fillTemplate(inquiryTemplate, inquiryValues);
    }
    prompt += "\n\n" + dropUnofferedExamples(fillTemplate(RESPONSE_FORMAT_FULL, baseValues), context);
  } else {
    prompt += "\n\n" + dropUnofferedExamples(fillTemplate(RESPONSE_FORMAT_INITIAL, baseValues), context);
    if (context.multiEnabled) {
      prompt = injectMultiBlock(prompt);
    }
  }
  if (inquiryType === "home-assistant") {
  } else if (inquiryType && inquiryType !== "web-search") {
    prompt += '\n\nFor this answer, always set "image": null and do not say you are showing or displaying a picture \u2014 image display is not available for this response type.';
  } else if (context.retrievePicturesEnabled === false) {
    prompt += `

IMAGE DISPLAY IS UNAVAILABLE: always set "image": null, and never say you are showing or displaying a picture. Only if the user explicitly asked to see a picture, mention that you can't show pictures right now \u2014 otherwise this notice is irrelevant: ignore it and answer the request normally.`;
  }
  if (personalityConfig && personalityConfig.responseSuffix) {
    prompt += personalityConfig.responseSuffix;
  }
  return prompt;
}

// supabase/functions/voice-conversation/redact-args.ts
var PASS_KEYS = /* @__PURE__ */ new Set([
  "time_range",
  "mode",
  "timeframe",
  "when",
  "type",
  "sport",
  "league",
  "event_type",
  "date",
  "resolved"
]);
var MAX_ENUM_LEN = 40;
var encoder = new TextEncoder();
function readSalt() {
  try {
    const d = globalThis.Deno;
    if (d?.env?.get) return d.env.get("ARG_HASH_SALT") ?? "";
  } catch {
  }
  try {
    return globalThis.process?.env?.ARG_HASH_SALT ?? "";
  } catch {
  }
  return "";
}
var keyPromise = null;
function hmacKey() {
  if (!keyPromise) {
    keyPromise = (async () => {
      const salt = readSalt();
      const subtle = globalThis.crypto?.subtle;
      if (!salt || !subtle) return null;
      try {
        return await subtle.importKey(
          "raw",
          encoder.encode(salt),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        );
      } catch {
        return null;
      }
    })();
  }
  return keyPromise;
}
async function hmac12(value) {
  const key = await hmacKey();
  if (!key) return "";
  try {
    const sig = await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(value));
    return Array.from(new Uint8Array(sig).slice(0, 6)).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return "";
  }
}
async function redactString(value) {
  return `[redacted:${await hmac12(value)}:${value.length}]`;
}
async function redactValue(key, value) {
  if (value === null || value === void 0) return value ?? null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (key !== null && PASS_KEYS.has(key) && value.length <= MAX_ENUM_LEN) return value;
    return await redactString(value);
  }
  if (Array.isArray(value)) {
    return await Promise.all(value.map((v) => redactValue(null, v)));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = await redactValue(k, v);
    }
    return out;
  }
  return null;
}
async function redactToolArgs(args) {
  return await redactValue(null, args);
}

// supabase/functions/voice-conversation/multi.ts
var ACTION_TOOLS = /* @__PURE__ */ new Set(["home_assistant", "music", "video_feeds"]);
function validSteps(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const tool = s.tool;
    if (typeof tool !== "string" || !tool.trim()) continue;
    out.push({ tool: tool.trim(), query: s.query });
  }
  return out;
}
function mergeSameTool(steps) {
  const byTool = /* @__PURE__ */ new Map();
  for (const step of steps) {
    const seen = byTool.get(step.tool);
    if (!seen) {
      byTool.set(step.tool, { ...step });
      continue;
    }
    const a = seen.query;
    const b = step.query;
    const aHint = a && typeof a.command_hint === "string" ? a.command_hint.trim() : "";
    const bHint = b && typeof b.command_hint === "string" ? b.command_hint.trim() : "";
    if (aHint && bHint) {
      seen.query = { ...a, command_hint: `${aHint} and ${bHint}` };
    } else if (!aHint && bHint) {
      seen.query = { ...a ?? {}, ...b };
    }
  }
  return [...byTool.values()];
}
function toInfoRequest(step, voice) {
  return {
    type: "info_request",
    tool: step.tool,
    query: step.query,
    // Keep the model's spoken line ONLY as a processing message — a collapsed multi's `voice`
    // narrates work we're no longer all doing, so it must never be spoken as the confirmation.
    processing_message: typeof voice === "string" ? voice : void 0
  };
}
function normalizeMultiEnvelope(parsed) {
  if (!parsed || parsed.type !== "multi") return parsed;
  const steps = mergeSameTool(validSteps(parsed.steps));
  const actions = steps.filter((s) => ACTION_TOOLS.has(s.tool));
  if (actions.length >= 2) {
    return { type: "multi", voice: parsed.voice, steps: actions };
  }
  if (actions.length === 1) return toInfoRequest(actions[0], parsed.voice);
  if (steps.length > 0) return toInfoRequest(steps[0], parsed.voice);
  return { type: "multi", voice: parsed.voice, steps: [] };
}

// supabase/functions/voice-conversation/parse.ts
function parseContent(content) {
  if (!content || typeof content !== "string") return null;
  let body = content.trim();
  body = body.replace(/^\s*```(?:json|JSON)?\s*\r?\n?/i, "").replace(/\r?\n?\s*```\s*$/i, "").trim();
  const firstBrace = body.indexOf("{");
  if (firstBrace > 0) body = body.slice(firstBrace);
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
  }
  if (!parsed) {
    const cleaned = body.replace(/,(\s*[}\]])/g, "$1");
    try {
      parsed = JSON.parse(cleaned);
    } catch {
    }
    if (!parsed) {
      const first = firstBalancedObject(cleaned);
      if (first && first.length < cleaned.length) {
        try {
          parsed = JSON.parse(first);
          console.warn(`[parse] MULTI-EMISSION: took first balanced object (${first.length} of ${cleaned.length} chars) \u2014 model emitted trailing content`);
        } catch {
        }
      }
    }
    if (!parsed) {
      const repaired = repairTruncatedJson(cleaned);
      if (repaired) {
        try {
          parsed = JSON.parse(repaired);
        } catch {
        }
      }
    }
  }
  return parsed ? normalizeMultiEnvelope(normalizeParsedShape(parsed)) : null;
}
function normalizeParsedShape(parsed) {
  if (!parsed || typeof parsed !== "object") return parsed;
  if (typeof parsed.voice === "string") parsed.voice = sanitizeVoice(parsed.voice);
  const KNOWN_TOOLS = /* @__PURE__ */ new Set([
    "web_search",
    "calendar_events",
    "family_members",
    "chores",
    "rewards",
    "location_events",
    "travel_time",
    "family_locations",
    "weather_data",
    "home_assistant",
    "get_current_time",
    "dashie_help",
    "music",
    "schedule_action"
  ]);
  const TERMINAL_TYPES = /* @__PURE__ */ new Set(["response", "action", "info_request", "multi"]);
  const tool = parsed.type && KNOWN_TOOLS.has(parsed.type) && parsed.type !== "info_request" ? parsed.type : typeof parsed.tool === "string" && KNOWN_TOOLS.has(parsed.tool) && !TERMINAL_TYPES.has(parsed.type) ? parsed.tool : null;
  if (tool) {
    return {
      type: "info_request",
      tool,
      query: parsed.query,
      context: parsed.context,
      processing_message: parsed.processing_message
    };
  }
  return parsed;
}
function isLikelyNoise(text) {
  if (!text || typeof text !== "string") return true;
  return !new RegExp("\\p{L}", "u").test(text);
}
function sanitizeVoice(s) {
  if (!s || typeof s !== "string") return s;
  let out = s;
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  out = out.replace(/```[\s\S]*?```/g, "");
  out = out.replace(/`([^`]+)`/g, "$1");
  out = out.replace(/(\*\*|__)(.*?)\1/g, "$2");
  out = out.replace(/(\*|_)(.*?)\1/g, "$2");
  out = out.replace(/~~(.*?)~~/g, "$1");
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  out = out.replace(/^\s{0,3}>\s?/gm, "");
  out = out.replace(/^\s*([-*+•]|\d+\.)\s+/gm, "");
  out = out.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu,
    ""
  );
  out = out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return out;
}
function firstBalancedObject(s) {
  if (!s || s[0] !== "{") return null;
  let inString = false;
  let escape = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(0, i + 1);
    }
  }
  return null;
}
function repairTruncatedJson(s) {
  if (!s || s[0] !== "{") return null;
  let inString = false;
  let escape = false;
  const stack = [];
  let validEnd = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
    if (stack.length > 0 && (ch === "," || ch === "}" || ch === "]")) validEnd = i;
  }
  if (inString) return null;
  if (stack.length === 0) return s;
  let prefix = s;
  if (validEnd !== -1 && validEnd < s.length - 1) prefix = s.slice(0, validEnd + 1);
  prefix = prefix.replace(/,(\s*)$/, "$1");
  const closers = stack.map((c) => c === "{" ? "}" : "]").reverse().join("");
  return prefix + closers;
}

// supabase/functions/voice-conversation/dialog-policy.ts
var NOISE_REPLY = "Sorry, I didn't catch that.";
var END_INTENT_PHRASES = [
  "thanks",
  "thank you",
  "that's all",
  "thats all",
  "never mind",
  "nevermind",
  "ok thanks",
  "okay thanks",
  "ok thank you",
  "okay thank you",
  "stop",
  "done",
  "goodbye",
  "nothing",
  "shut up",
  "stop talking",
  "be quiet",
  "quiet",
  "shush",
  "stop it",
  "enough",
  "that's enough"
];
var HARD_STOP_PHRASES = ["shut up", "stop talking"];
var TRAILING_CLOSE_PHRASES = [
  "thanks",
  "thank you",
  "that's all",
  "thats all",
  "goodbye"
];
var normalize = (t) => (t || "").toLowerCase().replace(/[.!?,]+/g, " ").replace(/\s+/g, " ").trim();
function isEndIntent(text) {
  const t = normalize(text);
  if (!t) return false;
  if (END_INTENT_PHRASES.includes(t)) return true;
  if (HARD_STOP_PHRASES.some((p) => t.includes(p))) return true;
  return TRAILING_CLOSE_PHRASES.some((p) => t === p || t.endsWith(` ${p}`));
}
function isMissReply(voice) {
  return !!voice && /\bdidn.?t (?:quite )?catch that\b/i.test(voice);
}
function classifyMiss(route, voice) {
  if (route === "noise") return { miss: true, reason: "noise" };
  if (isMissReply(voice)) return { miss: true, reason: "no_intent" };
  return { miss: false, reason: null };
}

// supabase/functions/voice-conversation/models.ts
function providerForModel(modelId) {
  if (!modelId || typeof modelId !== "string") return "claude";
  const id = modelId.toLowerCase();
  if (id.startsWith("claude-")) return "claude";
  if (id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3")) return "openai";
  if (id.startsWith("gemini-")) return "gemini";
  if (id.startsWith("us.amazon.") || id.startsWith("bedrock-") || id.includes("nova")) return "bedrock";
  return "claude";
}

// supabase/functions/voice-conversation/force-search.ts
var ROLE_WORDS = [
  "president",
  "vice president",
  "prime minister",
  "pm",
  "chancellor",
  "premier",
  "chief minister",
  "mayor",
  "governor",
  "senator",
  "ceo",
  "chief executive",
  "cfo",
  "coo",
  "chairman",
  "chairwoman",
  "chairperson",
  "pope",
  "king",
  "queen",
  "monarch",
  "emperor",
  "leader",
  "secretary general",
  "secretary-general",
  "director general",
  "head coach",
  "manager",
  "commissioner"
];
var TITLE_WORDS = [
  "champion",
  "champions",
  "world champion",
  "reigning champion",
  "defending champion",
  "title holder",
  "world number one",
  "number one",
  "mvp"
];
var EVENT_WORDS = [
  "super bowl",
  "world series",
  "world cup",
  "nba finals",
  "nba championship",
  "stanley cup",
  "champions league",
  "masters",
  "wimbledon",
  "us open",
  "election",
  "grand prix",
  "f1 championship"
];
var LEAD_VERBS = ["runs", "leads", "heads", "owns", "founded", "controls"];
function alt(words) {
  return words.slice().sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}
var ROLE_RE = new RegExp(
  `\\bwho(?:'s| is| are| was| were)?\\s+(?:the\\s+)?(?:current|sitting|reigning|new|incoming|present)?\\s*(?:${alt(ROLE_WORDS)})\\b`,
  "i"
);
var LEAD_RE = new RegExp(`\\bwho\\s+(?:${alt(LEAD_VERBS)})\\s+\\w+`, "i");
var TITLE_RE = new RegExp(
  `\\bwho(?:'s| is| are)?\\s+(?:the\\s+)?(?:current|reigning|defending)\\s+(?:[\\w-]+\\s+){0,2}(?:${alt(TITLE_WORDS)})\\b`,
  "i"
);
var WON_RE = new RegExp(
  `\\bwho\\s+won\\s+(?:the\\s+)?(?:(?:most recent|last|latest|current)\\s+)?(?:${alt([...EVENT_WORDS, ...TITLE_WORDS])})\\b`,
  "i"
);
var EXPLICIT_YEAR_RE = /\b(?:18|19|20)\d\d\b/;
var FAMILY_RE = /\b(?:my|our|your|his|her|their)\s+(?:family|mom|mother|dad|father|sister|brother|son|daughter|kids?|child|children|wife|husband|grandma|grandpa|aunt|uncle|cousin|parents?)\b/i;
function detectMutableEntity(text) {
  const normalized = (text || "").toLowerCase().trim().replace(/[.,!?;:]+$/g, "");
  if (!normalized) return null;
  if (FAMILY_RE.test(normalized)) return null;
  if (EXPLICIT_YEAR_RE.test(normalized)) return null;
  if (ROLE_RE.test(normalized)) return "role";
  if (LEAD_RE.test(normalized)) return "lead";
  if (TITLE_RE.test(normalized)) return "title";
  if (WON_RE.test(normalized)) return "won";
  return null;
}

// supabase/functions/_shared/tools/sports-slate.ts
var MAX_SLATE = 60;
var STATE_RANK = { in: 0, pre: 1, post: 2 };
function compareGames(a, b) {
  const sa = deriveState(a), sb = deriveState(b);
  if (STATE_RANK[sa] !== STATE_RANK[sb]) return STATE_RANK[sa] - STATE_RANK[sb];
  const ta = Date.parse(a.startTime || "") || 0;
  const tb = Date.parse(b.startTime || "") || 0;
  return sa === "post" ? tb - ta : ta - tb;
}
function entryFor(g, tz) {
  const state = deriveState(g);
  const date = relativeDay(g.startTime, tz);
  const detail = state === "pre" ? scheduleWhen(g, tz) || tidyDetail(g.detail) : state === "post" ? date ? `Final \xB7 ${date}` : tidyDetail(g.detail) || "Final" : tidyDetail(g.detail) || "";
  return {
    state,
    detail,
    startTime: g.startTime,
    // A PRE/future game has no score — force null even when the provider sends 0 (ESPN → "0"),
    // so a slate row shows the kickoff time, not a misleading "0". Mirrors the single-card rule.
    // short/abbr = compact display forms for the stacked slate rows ("Diamondbacks"/"ARI").
    home: { name: g.home || "", score: state === "pre" ? null : g.homeScore ?? null, logo: g.homeLogo, short: g.homeShort, abbr: g.homeAbbr },
    away: { name: g.away || "", score: state === "pre" ? null : g.awayScore ?? null, logo: g.awayLogo, short: g.awayShort, abbr: g.awayAbbr },
    winner: g.winner ?? null
  };
}
var LEAGUE_LABELS = {
  mlb: "MLB",
  nba: "NBA",
  nfl: "NFL",
  nhl: "NHL",
  wnba: "WNBA",
  mls: "MLS",
  "world-cup": "World Cup",
  "premier-league": "Premier League",
  epl: "Premier League",
  "champions-league": "Champions League",
  ucl: "Champions League",
  "la-liga": "La Liga"
};
function leagueLabel(league, sport) {
  const raw = String(league || "").trim() || String(sport || "").trim();
  const key = raw.toLowerCase().replace(/\s+/g, "-");
  if (LEAGUE_LABELS[key]) return LEAGUE_LABELS[key];
  if (!key) return "";
  return key.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
function dayWord(g, tz) {
  const d = relativeDay(g.startTime, tz);
  if (!d) return "";
  if (d === "Today") return "today";
  if (d === "Tomorrow") return "tomorrow";
  if (d === "Yesterday") return "yesterday";
  return `on ${d.replace(/^\w{3}, /, "")}`;
}
function dedupeGames(games) {
  const seen = /* @__PURE__ */ new Set();
  return games.filter((g) => {
    const key = `${g.away || ""}|${g.home || ""}|${g.startTime || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function sharedDayLabel(games, tz) {
  const days = new Set(games.map((g) => relativeDay(g.startTime, tz)).filter(Boolean));
  if (days.size !== 1) return "";
  const d = [...days][0];
  if (d === "Today") return "today";
  if (d === "Tomorrow") return "tomorrow";
  if (d === "Yesterday") return "yesterday";
  return `on ${d.replace(/^\w{3}, /, "")}`;
}
function clause(g, tz, withDay = false) {
  const state = deriveState(g);
  const away = g.away || "TBD", home = g.home || "TBD";
  if (state === "in") {
    const hs = g.homeScore ?? 0, as = g.awayScore ?? 0;
    if (hs === as) return `${away} and ${home} tied ${as}\u2013${hs}`;
    const [ln, ls, tn, ts] = hs > as ? [home, hs, away, as] : [away, as, home, hs];
    return `${ln} lead ${tn} ${ls}\u2013${ts}`;
  }
  if (state === "post") {
    const hs = g.homeScore ?? 0, as = g.awayScore ?? 0;
    if (hs === as && !g.winner) return `${away} and ${home} tied ${as}\u2013${hs}`;
    const homeWon = g.winner ? g.winner === "home" : hs > as;
    const [w, ws, l, ls] = homeWon ? [home, hs, away, as] : [away, as, home, hs];
    return `${w} beat ${l} ${ws}\u2013${ls}`;
  }
  const t = clockTime(g.startTime, tz);
  const day = withDay ? dayWord(g, tz) : "";
  return `${away} vs ${home}${t ? ` at ${t}` : ""}${day ? ` ${day}` : ""}`;
}
function highlightGames(games, when) {
  if (when !== "last") {
    const pre = games.filter((g) => deriveState(g) === "pre");
    if (pre.length) return pre.slice(0, 2);
  }
  return games.slice(0, 2);
}
function slateVoice(games, query, tz) {
  const total = games.length;
  const team = String(query?.team ?? "").trim();
  const label = leagueLabel(query?.league, query?.sport);
  const day = sharedDayLabel(games, tz);
  const when = String(query?.when ?? "").toLowerCase();
  const noun = `game${total === 1 ? "" : "s"}`;
  const head = team ? `${team} have ${total} ${day ? "" : "upcoming "}${noun}${day ? ` ${day}` : ""}`.replace(/\s+/g, " ") : `There ${total === 1 ? "is" : "are"} ${total} ${label ? `${label} ` : ""}${noun}${day ? ` ${day}` : ""}`;
  const picks = highlightGames(games, when).map((g) => clause(g, tz, !day)).filter(Boolean);
  if (picks.length === 0) return `${head}.`;
  const list = picks.length >= 2 ? `${picks[0]}, and ${picks[1]}` : picks[0];
  return `${head}: ${list}.`;
}
function templateSlate(result, query, opts) {
  const tz = opts?.timezone;
  const raw = Array.isArray(result?.games) ? result.games : [];
  if (raw.length === 0) return { voice: "", structured_data: null };
  const all = dedupeGames(raw);
  const sorted = all.slice().sort(compareGames);
  const card2 = {
    type: "sports",
    league: String(query?.league ?? "") || void 0,
    games: sorted.slice(0, MAX_SLATE).map((g) => entryFor(g, tz)),
    total: sorted.length
  };
  return { voice: slateVoice(sorted, query, tz), structured_data: card2 };
}

// supabase/functions/_shared/tools/sports.ts
function envVar(key) {
  try {
    const d = globalThis.Deno;
    if (d?.env?.get) return d.env.get(key) ?? "";
  } catch {
  }
  try {
    return globalThis.process?.env?.[key] ?? "";
  } catch {
  }
  return "";
}
async function runSports(query, ctx) {
  const url = ctx?.supabaseUrl || envVar("SUPABASE_URL");
  const key = ctx?.anonKey || envVar("SUPABASE_ANON_KEY");
  const provider = ctx?.provider ?? "auto";
  const auth = ctx?.jwt ? `Bearer ${ctx.jwt}` : `Bearer ${key}`;
  const resp = await fetch(`${url}/functions/v1/sports-gateway`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key, Authorization: auth },
    body: JSON.stringify({ provider, query })
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(body.error || body.message || `HTTP ${resp.status}`);
  return body;
}
function resolveWhen(query) {
  const w = String(query?.when ?? "").toLowerCase();
  if (w === "last" || w === "next" || w === "live") return w;
  const t = String(query?.type ?? "").toLowerCase();
  if (t === "schedule") return "next";
  if (t === "score") return "last";
  return "";
}
function deriveState(g) {
  const s = (g.status || "").toLowerCase();
  const d = (g.detail || "").toLowerCase();
  if (/postpon|suspend|cancel/.test(s) || /postpon|suspend|cancel/.test(d)) return "pre";
  if (g.winner || s.includes("final") || s.includes("full")) return "post";
  if (g.homeScore == null && g.awayScore == null || s.includes("scheduled") || s.includes("pre")) return "pre";
  return "in";
}
function pickGame(games, team, when) {
  const matches = team ? games.filter((g) => (g.home || "").toLowerCase().includes(team) || (g.away || "").toLowerCase().includes(team)) : games.slice();
  const pool = matches.length ? matches : games;
  const byState = (st) => pool.filter((g) => deriveState(g) === st);
  if (when === "last") return byState("post").slice(-1)[0] || byState("in")[0] || pool[0];
  if (when === "next") return byState("pre")[0] || pool[0];
  if (when === "live") return byState("in")[0] || pool[0];
  return byState("in")[0] || byState("post").slice(-1)[0] || byState("pre")[0] || pool[0];
}
function groupScorers(g) {
  const out = [];
  for (const e of g.events || []) {
    if (!e.player || (e.scoreValue ?? 0) <= 0) continue;
    let entry = out.find((s) => s.player === e.player && s.side === e.side);
    if (!entry) {
      entry = { player: e.player, side: e.side, clocks: [] };
      out.push(entry);
    }
    if (e.clock) entry.clocks.push(e.clock);
  }
  return out;
}
function scorersText(g) {
  const scorers = groupScorers(g);
  if (!scorers.length) return null;
  const list = scorers.map((s) => `${s.player}${s.clocks.length ? ` (${s.clocks.join(", ")})` : ""}`).join(", ");
  return `Scorers: ${list}`;
}
function soccerHighlights(g) {
  const scorers = groupScorers(g);
  if (!scorers.length) return [];
  const fmt = (list) => list.map((s) => `${s.player}${s.clocks.length ? ` (${s.clocks.join(", ")})` : ""}`).join(", ");
  const out = [];
  const home = scorers.filter((s) => s.side === "home");
  const away = scorers.filter((s) => s.side === "away");
  const neutral = scorers.filter((s) => !s.side);
  if (home.length) out.push({ label: g.home || "Home", detail: fmt(home) });
  if (away.length) out.push({ label: g.away || "Away", detail: fmt(away) });
  if (neutral.length) out.push({ label: "Scorers", detail: fmt(neutral) });
  return out;
}
var isBaseball = (g) => /mlb|baseball/i.test(g.league || "");
function leaderHighlights(g) {
  const line = (ls) => (ls || []).filter((l) => l.player).map((l) => `${l.player} ${l.line}`).join(" \xB7 ");
  const out = [];
  const h = line(g.homeLeaders), a = line(g.awayLeaders);
  if (h) out.push({ label: g.home || "Home", detail: h });
  if (a) out.push({ label: g.away || "Away", detail: a });
  return out;
}
function pitcherHighlights(g) {
  const out = [];
  if (g.awayProbable) out.push({ label: g.away || "Away", detail: `${g.awayProbable} (P)` });
  if (g.homeProbable) out.push({ label: g.home || "Home", detail: `${g.homeProbable} (P)` });
  return out;
}
var WEEKDAYS = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
  Sun: "Sunday"
};
function tidyDetail(detail) {
  let d = (detail || "").trim();
  if (!d) return "";
  d = d.replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/, (_m, abbr) => WEEKDAYS[abbr] || abbr);
  d = d.replace(/\s+([A-Z]{2,4})\.?$/, (m, abbr) => abbr === "AM" || abbr === "PM" ? m : "");
  d = d.replace(/(\d+(?:st|nd|rd|th))\s+(?:Quarter|Inning|Period|Half)\b/gi, "$1");
  return d.trim();
}
function ymdInTz(d, tz) {
  return new Intl.DateTimeFormat("en-CA", { ...tz ? { timeZone: tz } : {}, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function relativeDay(startTime, tz) {
  if (!startTime) return "";
  const d = new Date(startTime);
  if (isNaN(d.getTime())) return "";
  const gameYmd = ymdInTz(d, tz);
  const nowYmd = ymdInTz(/* @__PURE__ */ new Date(), tz);
  const diff = Math.round((Date.parse(`${gameYmd}T00:00:00Z`) - Date.parse(`${nowYmd}T00:00:00Z`)) / 864e5);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  try {
    return new Intl.DateTimeFormat("en-US", { ...tz ? { timeZone: tz } : {}, weekday: "short", month: "short", day: "numeric" }).format(d);
  } catch {
    return "";
  }
}
function relativeDaySpoken(startTime, tz) {
  const rel = relativeDay(startTime, tz);
  if (!rel || rel === "Today" || rel === "Tomorrow" || rel === "Yesterday") return rel;
  try {
    const d = new Date(startTime);
    return new Intl.DateTimeFormat("en-US", {
      ...tz ? { timeZone: tz } : {},
      weekday: "long",
      month: "long",
      day: "numeric"
    }).format(d);
  } catch {
    return rel;
  }
}
function clockTime(startTime, tz) {
  if (!tz || !startTime) return "";
  const d = new Date(startTime);
  if (isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d).replace(/[\u202f\u00a0]/g, " ");
  } catch {
    return "";
  }
}
function scheduleWhen(g, tz) {
  const day = relativeDay(g.startTime, tz);
  const time = clockTime(g.startTime, tz);
  if (day && time) return `${day}, ${time}`;
  if (day) return day;
  const d = tidyDetail(g.detail);
  return d && /\d/.test(d) ? d : "";
}
function scheduleWhenSpoken(g, tz) {
  const day = relativeDaySpoken(g.startTime, tz);
  const time = clockTime(g.startTime, tz);
  if (day && time) return `${day}, ${time}`;
  if (day) return day;
  const d = tidyDetail(g.detail);
  return d && /\d/.test(d) ? d : "";
}
function formatGameDate(startTime, tz) {
  return relativeDay(startTime, tz);
}
function card(g, state, tz) {
  const date = formatGameDate(g.startTime, tz);
  const pens = g.homeShootout != null || g.awayShootout != null || state === "post" && !!g.winner && (g.homeScore ?? 0) === (g.awayScore ?? 0);
  const finalLabel = pens ? "Final (Pens)" : "Final";
  const detail = state === "pre" ? scheduleWhen(g, tz) || tidyDetail(g.detail) || g.startTime : state === "post" ? date ? `${finalLabel} \xB7 ${date}` : tidyDetail(g.detail) || finalLabel : tidyDetail(g.detail) || g.startTime;
  return {
    type: "sports",
    league: g.league,
    state,
    detail,
    venue: g.venue,
    // A PRE/future game has NO score — force null even when the provider sends 0 (ESPN returns
    // "0"/"0" for a scheduled game), so the card never shows a misleading "0 – 0". `?? null` alone
    // keeps a numeric 0; the state gate is what suppresses it. (Mirrors the no-R/H/E-lines rule.)
    home: { name: g.home || "", score: state === "pre" ? null : g.homeScore ?? null, record: g.homeRecord, logo: g.homeLogo, color: g.homeColor },
    away: { name: g.away || "", score: state === "pre" ? null : g.awayScore ?? null, record: g.awayRecord, logo: g.awayLogo, color: g.awayColor },
    winner: g.winner ?? null,
    // Per-sport population of the generic stats. Standout leader lines render for every
    // sport whose provider fills home/awayLeader (baseball batting, basketball PTS,
    // hockey PTS, football YDS); soccer keeps its goal-event highlights; pre-game
    // baseball shows probable pitchers. R/H/E lines REMOVED 2026-07-12 (user: a
    // single-line R/H/E doesn't attribute which team had what).
    lines: [],
    highlights: isBaseball(g) ? state === "pre" ? pitcherHighlights(g) : leaderHighlights(g) : soccerHighlights(g).length ? soccerHighlights(g) : state !== "pre" ? leaderHighlights(g) : [],
    scorers: groupScorers(g)
    // legacy — drop once all renderers read highlights
  };
}
function finalLine(g) {
  const hs = g.homeScore ?? 0, as = g.awayScore ?? 0;
  if (hs === as) {
    if (g.winner) {
      const homeWon2 = g.winner === "home";
      const w2 = homeWon2 ? g.home : g.away;
      const ps = g.homeShootout != null && g.awayShootout != null ? `, ${homeWon2 ? g.homeShootout : g.awayShootout} to ${homeWon2 ? g.awayShootout : g.homeShootout}` : "";
      return `${g.home} and ${g.away} drew ${hs} to ${as}, but ${w2} won on penalties${ps}.`;
    }
    return `${g.home} and ${g.away} tied ${hs} to ${as}.`;
  }
  const homeWon = g.winner ? g.winner === "home" : hs > as;
  const [w, ws, l, ls] = homeWon ? [g.home, hs, g.away, as] : [g.away, as, g.home, hs];
  return `${w} beat ${l} ${ws} to ${ls}.`;
}
function liveLine(g) {
  const hs = g.homeScore ?? 0, as = g.awayScore ?? 0;
  const when = tidyDetail(g.detail) ? `, ${tidyDetail(g.detail)}` : "";
  return `${g.away} ${as}, ${g.home} ${hs}${when}.`;
}
function scheduledLine(g, team, tz) {
  const teamName = team && (g.away || "").toLowerCase().includes(team) ? g.away : g.home;
  const opp = teamName === g.home ? g.away : g.home;
  const when = scheduleWhenSpoken(g, tz);
  return `${teamName} play ${opp}${when ? `, ${when}` : ""}.`;
}
function noGamesLine(query) {
  const team = String(query?.team ?? "").trim();
  return team ? `I couldn't find a game for ${team}.` : `I couldn't find that game.`;
}
function noRecentResultLine(g, query, tz) {
  const team = String(query?.team ?? "").trim() || g.home || "that team";
  const opp = (g.home || "").toLowerCase().includes(team.toLowerCase()) ? g.away : g.home;
  const when = scheduleWhen(g, tz);
  return `I couldn't find a recent ${team} result \u2014 their next game is${when ? ` ${when}` : ""} vs ${opp}.`;
}
function templateSports(result, query, opts) {
  const tz = opts?.timezone;
  const games = Array.isArray(result?.games) ? result.games : [];
  const team = String(query?.team ?? "").toLowerCase();
  const when = resolveWhen(query);
  if (!team && !when && games.length !== 1) {
    return { voice: "", text: null, structured_data: null, fallback: true };
  }
  if (games.length === 0) {
    return { voice: noGamesLine(query), text: null, structured_data: null };
  }
  const game = pickGame(games, team, when);
  const state = deriveState(game);
  if (when === "last" && state === "pre") {
    return { voice: noRecentResultLine(game, query, tz), text: null, structured_data: card(game, state, tz) };
  }
  const voice = state === "post" ? finalLine(game) : state === "in" ? liveLine(game) : scheduledLine(game, team, tz);
  const text = state === "pre" ? null : scorersText(game);
  return { voice, text, structured_data: card(game, state, tz) };
}

// supabase/functions/_shared/tools/image_search.ts
function envVar2(key) {
  try {
    const d = globalThis.Deno;
    if (d?.env?.get) return d.env.get(key) ?? "";
  } catch {
  }
  try {
    return globalThis.process?.env?.[key] ?? "";
  } catch {
  }
  return "";
}
async function runImageSearch(query, ctx) {
  const url = ctx?.supabaseUrl || envVar2("SUPABASE_URL");
  const anon = ctx?.anonKey || envVar2("SUPABASE_ANON_KEY");
  const auth = ctx?.jwt ? `Bearer ${ctx.jwt}` : `Bearer ${anon}`;
  const resp = await fetch(`${url}/functions/v1/serper-image-search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anon, Authorization: auth },
    body: JSON.stringify({ query, perPage: 10, sessionId: ctx?.sessionId ?? null })
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(body.error || body.message || `HTTP ${resp.status}`);
  return { images: Array.isArray(body?.images) ? body.images : [] };
}
var OFFICIAL_LOGO_URL = "https://dashieapp.com/artwork/Dashie_Full_Logo_Orange_Transparent.png";
function officialImage(query) {
  const q = query.toLowerCase();
  if (/dashie\s*(games|xp)/.test(q)) return null;
  if (!/\bdashie('s)?\b/.test(q) || !/\b(logo|icon|brand|branding)\b/.test(q)) return null;
  return {
    type: "image",
    url: OFFICIAL_LOGO_URL,
    thumbnail: OFFICIAL_LOGO_URL,
    description: "The Dashie logo",
    source: "dashie-official",
    attribution: { photographer: "Dashie", photographerUrl: "https://dashieapp.com" }
  };
}
function selectImage(images, criteria) {
  const valid = images.filter((i) => i && i.imageUrl);
  if (valid.length === 0) return null;
  if (!criteria || valid.length === 1) return valid[0];
  const keywords = criteria.toLowerCase().split(/\s+/).filter(Boolean);
  let best = valid[0];
  let bestScore = -Infinity;
  valid.forEach((img, index) => {
    const text = [img.title, img.source, img.domain].filter(Boolean).join(" ").toLowerCase();
    let score = 0;
    for (const k of keywords) if (text.includes(k)) score += 1;
    if (img.title && String(img.title).length > 10) score += 0.5;
    score += Math.max(0, 10 - index) * 0.01;
    if (score > bestScore) {
      bestScore = score;
      best = img;
    }
  });
  return best;
}
function buildImageCard(img) {
  return {
    type: "image",
    url: img.imageUrl,
    thumbnail: img.thumbnailUrl || img.imageUrl,
    description: img.title || "",
    source: "serper",
    attribution: {
      photographer: img.source || img.domain || "Google Images",
      photographerUrl: img.link || null
    }
  };
}
async function synthesizeImage(query, criteria, ctx) {
  const official = officialImage(query);
  if (official) {
    return {
      result: { found: true, description: official.description, source: "Dashie" },
      card: official
    };
  }
  const { images } = await runImageSearch(query, ctx);
  const picked = selectImage(images, criteria);
  if (!picked) return { result: { found: false }, card: null };
  const card2 = buildImageCard(picked);
  return {
    result: { found: true, description: card2.description, source: card2.attribution?.photographer ?? null },
    card: card2
  };
}

// supabase/functions/voice-conversation/personality.ts
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function listAvailablePersonalities(supabase) {
  const { data, error } = await supabase.from("personality_templates").select("key, name, description, is_seasonal, seasonal_start, seasonal_end, voice_mode, voice, greeting_fallback").eq("is_available", true).order("sort_order", { ascending: true });
  if (error || !Array.isArray(data)) return [];
  const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  return data.filter((r) => {
    if (!r.is_seasonal) return true;
    const start = r.seasonal_start;
    const end = r.seasonal_end;
    return (!start || today >= start) && (!end || today <= end);
  }).map((r) => ({
    key: String(r.key),
    name: String(r.name),
    description: r.description ?? null,
    // Voice fields MUST survive this map — set_personality enrichment reads them off the
    // catalog row. 2026-07-19 field bug: they were SELECTed above but dropped here, so
    // every switch shipped unenriched (the optional interface fields hid it from the
    // type-checker, and the orchestrator tests' fake catalogs included what the real
    // impl stripped).
    voice_mode: r.voice_mode ?? null,
    voice: r.voice ?? null,
    greeting_fallback: r.greeting_fallback ?? null
  }));
}
async function resolvePersonality(supabase, userId, endpointId, explicitId) {
  const id = explicitId || await readDevicePersonalityId(supabase, userId, endpointId);
  if (!id || id === "dashie") {
    const { data: dflt } = await supabase.from("user_personality_overrides").select("family_notes").eq("user_id", userId).eq("template_key", "dashie").maybeSingle();
    if (dflt?.family_notes) {
      return { name: "Dashie", family_notes: dflt.family_notes };
    }
    return null;
  }
  if (UUID_RE.test(id)) {
    const { data } = await supabase.from("user_personalities").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
    return data || null;
  }
  const { data: tpl } = await supabase.from("personality_templates").select("*").eq("key", id).maybeSingle();
  if (!tpl) return null;
  const { data: override } = await supabase.from("user_personality_overrides").select("*").eq("user_id", userId).eq("template_key", id).maybeSingle();
  return { ...tpl, family_notes: override?.family_notes || tpl.family_notes };
}
async function readDevicePersonalityId(supabase, userId, endpointId) {
  const { data: deviceRow } = await supabase.from("user_devices").select("settings").eq("auth_user_id", userId).eq("device_id", endpointId).maybeSingle();
  const devicePid = deviceRow?.settings?.aiVoice?.personalityId;
  if (devicePid) return devicePid;
  const { data: acct } = await supabase.from("user_settings").select("settings").eq("auth_user_id", userId).maybeSingle();
  const ai = acct?.settings?.ai;
  return ai?.defaultPersonalityId || ai?.personality_id || null;
}

// supabase/functions/_shared/tools/current_time.ts
var currentTimeTool = {
  name: "get_current_time",
  description: `Get the CURRENT local date, time, and day of week for the user. Call this for any question about the current time, date, or day ("what time is it", "what's today's date", "what day is it"), and to anchor any today/tomorrow/this-week/next reasoning. It is authoritative \u2014 use it instead of your own internal clock, which is UTC and wrong for the user. Read the date/time back in the user's local zone; never say UTC.`,
  parameters: { type: "object", properties: {} },
  // deno-lint-ignore require-await
  async execute(_args, ctx) {
    const tz = ctx.timezone || "UTC";
    const now = /* @__PURE__ */ new Date();
    const fmt = (opts) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).format(now);
    const day = fmt({ weekday: "long" });
    const date = fmt({ weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const time = fmt({ hour: "numeric", minute: "2-digit" });
    return {
      result: {
        found: true,
        day,
        // "Saturday"
        date,
        // "Saturday, June 27, 2026"
        time,
        // "11:55 PM"
        timezone: tz,
        // "America/New_York"
        spoken: `${date}, ${time}`
        // ready-to-read: "Saturday, June 27, 2026, 11:55 PM"
      }
    };
  }
};

// supabase/functions/_shared/tools/dashie-kb.generated.ts
var KB_CHUNKS = [
  {
    "id": "faq:how-is-dashie-different-from-fully-kiosk-browser",
    "file": "faq.md",
    "title": "How is Dashie different from Fully Kiosk Browser?",
    "topic": "faq",
    "status": "ga",
    "page": null,
    "action": null,
    "body": 'Dashie is purpose-built for Home Assistant rather than being a generic kiosk browser. Compared to\nFully Kiosk, Dashie adds a "Hey Dashie" voice assistant, a native music overlay, camera/face wake,\nauto-discovery and a URL builder for setup, and a Fully Kiosk\u2013compatible REST API. And you can sign\nin to turn the same app into a full family dashboard \u2014 no reinstall.'
  },
  {
    "id": "faq:which-calendars-and-photo-sources-are-supported",
    "file": "faq.md",
    "title": "Which calendars and photo sources are supported?",
    "topic": "faq",
    "status": "ga",
    "page": null,
    "action": null,
    "body": 'Calendars: Google and Outlook accounts, plus Home Assistant and CalDAV calendars, merged into one\nview. Photos come from several sources \u2014 Home Assistant media, a local folder, Immich, Google\nPhotos, Google Drive, and Dropbox \u2014 and you can also upload photos straight from your phone (see\n"How do I add my own photos?").'
  },
  {
    "id": "faq:can-multiple-family-members-use-it-how-do-roles-work",
    "file": "faq.md",
    "title": "Can multiple family members use it? How do roles work?",
    "topic": "faq",
    "status": "ga",
    "page": null,
    "action": null,
    "body": "Yes. A family has an Owner and can add Parents and Members. Owners and Parents can create and edit\nchores and rewards and see everyone's data; Members complete chores, redeem rewards, and manage\ntheir own profile. All members share the owner's account tier and feature access."
  },
  {
    "id": "faq:does-the-voice-assistant-use-my-data-or-send-it-to-the-web",
    "file": "faq.md",
    "title": "Does the voice assistant use my data or send it to the web?",
    "topic": "faq",
    "status": "ga",
    "page": null,
    "action": null,
    "body": "For product and how-to questions, Dashie answers from its own built-in knowledge rather than\nsearching the web. Calendar, weather, and smart-home answers come from your connected accounts and\ndevices. Full-mode voice uses a cloud AI provider you choose (Claude, OpenAI, or Gemini); kiosk\nvoice runs through Home Assistant's Assist pipeline. Search queries aren't logged with your\nidentity."
  },
  {
    "id": "faq:what-ai-models-can-i-choose-from",
    "file": "faq.md",
    "title": "What AI models can I choose from?",
    "topic": "faq",
    "status": "ga",
    "page": "voice-ai-model-select",
    "action": "open_settings_page(voice-ai-model-select)",
    "body": "Dashie supports multiple AI providers \u2014 Anthropic Claude, OpenAI, and Google Gemini. Pick the one\nyou want under **Settings \u2192 Voice & AI \u2192 AI model**."
  },
  {
    "id": "faq:does-dashie-work-offline",
    "file": "faq.md",
    "title": "Does Dashie work offline?",
    "topic": "faq",
    "status": "ga",
    "page": null,
    "action": null,
    "body": `Kiosk mode is designed to keep working offline for displaying a local Home Assistant dashboard.
The full family dashboard and cloud AI voice features need an internet connection. On-device wake
word detection works without the cloud. If you'd rather not use cloud voice at all, Dashie can use
local voice engines that run on your own hardware (see "Can I use local, private voice?").`
  },
  {
    "id": "faq:can-i-use-local-private-voice",
    "file": "faq.md",
    "title": "Can I use local, private voice?",
    "topic": "faq",
    "status": "beta",
    "page": "voice",
    "action": "open_settings_page(voice)",
    "body": "Newer feature \u2014 may not be on your plan yet. In **Settings \u2192 Voice & AI** you can choose local\nvoice engines that run on your own devices instead of the cloud \u2014 for example local text-to-speech\nand Whisper speech-to-text on your box, or Piper/Whisper through your Home Assistant. Local voice\nis private and doesn't use cloud voice. The available options appear only when Dashie detects a\nsupported engine on your setup."
  },
  {
    "id": "faq:how-do-i-contact-support",
    "file": "faq.md",
    "title": "How do I contact support?",
    "topic": "faq",
    "status": "ga",
    "page": null,
    "action": null,
    "body": "You can email the Dashie team at **support@dashieapp.com**. On Android you can also send\ndiagnostics from Settings \u2192 System to help them look into a problem."
  },
  {
    "id": "faq:what-happens-if-i-delete-my-account",
    "file": "faq.md",
    "title": "What happens if I delete my account?",
    "topic": "faq",
    "status": "beta",
    "page": null,
    "action": null,
    "body": "Newer behavior \u2014 may not be on your plan yet. Deleting your account is recoverable for a grace\nperiod (about 15 days): during that window you can change your mind and keep the account before\nanything is permanently removed. Account deletion is managed from your phone or the web console,\nnot from a shared family tablet."
  },
  {
    "id": "faq:what-s-the-difference-between-the-screensaver-photos-and-the",
    "file": "faq.md",
    "title": "What's the difference between the screensaver photos and the Photos widget?",
    "topic": "faq",
    "status": "ga",
    "page": null,
    "action": null,
    "body": "They're configured separately. The **screensaver** slideshow (what shows when the screen is idle)\nis set under Display \u2192 Screensaver and can use HA media, a local folder, Immich, or Google Photos.\nThe **Photos widget** (part of the dashboard grid) is set under Settings \u2192 Photos and can use\nDropbox albums. You can use different sources for each."
  },
  {
    "id": "features:what-widgets-can-i-put-on-the-dashboard",
    "file": "features.md",
    "title": "What widgets can I put on the dashboard?",
    "topic": "features",
    "status": "ga",
    "page": null,
    "action": null,
    "body": "The dashboard is a grid of widgets you can arrange across multiple pages. Available widgets are\nCalendar (upcoming events), Photos (family slideshow), Weather (current conditions, forecast,\nand animated radar), Clock (large digital clock and date), Chores (today's tasks), and Rewards\n(available rewards to redeem). You navigate the grid with a TV remote's D-pad, a keyboard, or\ntouch, and page between layouts with the arrow controls."
  },
  {
    "id": "features:how-does-the-calendar-work",
    "file": "features.md",
    "title": "How does the calendar work?",
    "topic": "features",
    "status": "ga",
    "page": null,
    "action": null,
    "body": `The Calendar widget shows your family's upcoming events. It supports multiple Google and Outlook
accounts, and can merge in calendars from Home Assistant and CalDAV \u2014 all deduplicated into one
view. You choose which of your connected calendars are visible. Ask the assistant things like
"what's on the calendar today?" or "when is the next soccer game?" and it reads from your real
merged calendar.`
  },
  {
    "id": "features:how-do-chores-work",
    "file": "features.md",
    "title": "How do chores work?",
    "topic": "features",
    "status": "ga",
    "page": null,
    "action": null,
    "body": 'Chores are gamified tasks for the family. A parent or owner creates recurring or one-time chores,\neach worth points, and assigns them to a specific member or to "anyone can complete." Chores can\nbe filtered by time of day (morning, afternoon, evening, anytime) and have emoji icons and\ncolors. When someone completes a chore the points are credited automatically. You can mark a\nchore done by voice: "mark dishes as done."'
  },
  {
    "id": "features:how-do-rewards-work",
    "file": "features.md",
    "title": "How do rewards work?",
    "topic": "features",
    "status": "ga",
    "page": null,
    "action": null,
    "body": "Rewards are things family members redeem with the points they earn from chores. A parent sets up\na reward catalog with a point cost for each item, optionally requiring parent approval. When a\nmember redeems a reward, their points are deducted automatically and the redemption is logged."
  },
  {
    "id": "features:how-does-the-photo-screensaver-photos-widget-work",
    "file": "features.md",
    "title": "How does the photo screensaver / photos widget work?",
    "topic": "features",
    "status": "ga",
    "page": null,
    "action": null,
    "body": "Dashie can show a photo slideshow both as a screensaver and as a dashboard widget. Photo sources\ninclude Home Assistant media, a local folder, Immich, Google Photos, and Dropbox (in full mode).\nYou can control slideshow timing and whether photo metadata (like date or caption) is shown."
  },
  {
    "id": "features:what-can-the-weather-widget-show",
    "file": "features.md",
    "title": "What can the weather widget show?",
    "topic": "features",
    "status": "ga",
    "page": null,
    "action": null,
    "body": `The Weather widget shows current conditions, a forecast, and an animated radar map. Weather data
comes from Open-Meteo and the radar from RainViewer. By voice you can ask "what's the weather?",
"will it rain today?", or "what's the forecast this weekend?"`
  },
  {
    "id": "features:what-is-the-hey-dashie-voice-assistant",
    "file": "features.md",
    "title": 'What is the "Hey Dashie" voice assistant?',
    "topic": "features",
    "status": "ga",
    "page": null,
    "action": null,
    "body": `Dashie includes a hands-free voice assistant activated by saying "Hey Dashie" (on supported
devices) or by tapping the microphone. It can answer questions about your calendar, the weather,
and sports; control Home Assistant devices; set timers; complete chores; change the theme; and
answer questions about Dashie itself. On the full dashboard it uses cloud AI (Claude, OpenAI, or
Gemini, your choice); kiosk voice runs through Home Assistant's Assist pipeline.`
  },
  {
    "id": "features:how-do-timers-work",
    "file": "features.md",
    "title": "How do timers work?",
    "topic": "features",
    "status": "ga",
    "page": null,
    "action": null,
    "body": 'You can set up to three countdown timers by voice \u2014 "set a 5 minute timer" \u2014 and ask "how much\ntime is left?", or pause, resume, and cancel them. Timers show in a small floating overlay and\nplay an alarm when they finish. They survive a page refresh.'
  },
  {
    "id": "features:what-can-dashie-do-with-home-assistant",
    "file": "features.md",
    "title": "What can Dashie do with Home Assistant?",
    "topic": "features",
    "status": "ga",
    "page": null,
    "action": null,
    "body": 'Dashie integrates tightly with Home Assistant. In kiosk mode it displays any HA dashboard\nfull-screen. With voice you can control HA devices \u2014 "turn on the kitchen lights," "close the\ngarage," "is the garage door open?" \u2014 including multi-device commands. Dashie can also sync its\ntheme to the HA frontend, and on Android it exposes a Fully Kiosk Browser\u2013compatible REST API so\nHA can control the device (screen on/off, volume, TTS announcements, camera snapshots, and more).'
  },
  {
    "id": "features:can-dashie-show-camera-video-feeds",
    "file": "features.md",
    "title": "Can Dashie show camera / video feeds?",
    "topic": "features",
    "status": "beta",
    "page": "video-feeds",
    "action": "open_settings_page(video-feeds)",
    "body": "Newer feature \u2014 Android/Home-Assistant kiosk devices, and may not be on your plan yet. On those\ndevices Dashie can play camera streams natively (smoother and lighter than in the HA web view):\ncameras can show as feed cards, pop up automatically on a motion or doorbell trigger (up to a 2\xD72\ngrid for several at once), go full-screen, and \u2014 with Frigate \u2014 play back events. Set feeds up\nunder **Settings \u2192 Video Feeds**."
  },
  {
    "id": "features:can-i-add-my-own-photos-from-my-phone",
    "file": "features.md",
    "title": "Can I add my own photos from my phone?",
    "topic": "features",
    "status": "beta",
    "page": null,
    "action": null,
    "body": "Newer feature \u2014 may not be on your plan yet. You can upload photos to Dashie's slideshow straight\nfrom your phone: the TV shows a QR code and a short pairing code, you open the link on your phone,\nand the photos you upload appear in the slideshow \u2014 no full sign-in needed. Photos can be kept in\nDashie's own storage or in your Google Drive."
  },
  {
    "id": "features:can-dashie-remind-me-about-things-scheduled-reminders",
    "file": "features.md",
    "title": "Can Dashie remind me about things? (scheduled reminders)",
    "topic": "features",
    "status": "beta",
    "page": null,
    "action": null,
    "body": `Newer feature \u2014 may not be on your plan yet. You can say "Hey Dashie, remind me to take out the
trash in 30 minutes." Dashie sets a reminder, confirms it out loud, and when it's time a reminder
pops up on screen with a chime and a spoken message. This is different from a timer (a countdown)
\u2014 a reminder is tied to a message and a time.`
  },
  {
    "id": "overview:what-is-dashie",
    "file": "overview.md",
    "title": "What is Dashie?",
    "topic": "overview",
    "status": "ga",
    "page": null,
    "action": null,
    "body": 'Dashie is a smart home dashboard for families. It runs on wall-mounted TVs, tablets, and in\nany web browser, and turns a screen into a shared family hub: calendar, photos, weather, a\nclock, chores and rewards, plus a "Hey Dashie" voice assistant. On Android it can also act as\na dedicated Home Assistant kiosk display. Think of it as the always-on screen in the kitchen or\nhallway that keeps the whole household on the same page.'
  },
  {
    "id": "overview:what-can-dashie-do-what-are-the-main-features",
    "file": "overview.md",
    "title": "What can Dashie do? / What are the main features?",
    "topic": "overview",
    "status": "ga",
    "page": null,
    "action": null,
    "body": 'The headline features are: a customizable widget dashboard (calendar, photos, weather, clock,\nchores, rewards); a "Hey Dashie" voice assistant for hands-free questions and control; family\ncoordination with chores and a points-based rewards system; a photo screensaver; timers; and\nHome Assistant integration for smart-home control. Ask "how do I\u2026" about any of these and Dashie\ncan walk you through it.'
  },
  {
    "id": "overview:what-are-the-two-modes-kiosk-and-full",
    "file": "overview.md",
    "title": "What are the two modes \u2014 kiosk and full?",
    "topic": "overview",
    "status": "ga",
    "page": null,
    "action": null,
    "body": "Dashie has two modes. **Kiosk mode** (no login) is a Home Assistant kiosk display \u2014 great for\nwall-mounted tablets showing an HA dashboard, with an optional voice add-on. **Full mode**\n(signed in with a Dashie account) is the whole family dashboard: calendar, photos, chores,\nrewards, and the AI voice assistant. You can switch between them anytime \u2014 signing in from kiosk\nmode opens the full dashboard, and signing out returns to the kiosk."
  },
  {
    "id": "overview:what-devices-and-platforms-does-dashie-run-on",
    "file": "overview.md",
    "title": "What devices and platforms does Dashie run on?",
    "topic": "overview",
    "status": "ga",
    "page": null,
    "action": null,
    "body": "Dashie runs on TV/display devices (Google TV / ONN sticks, Fire TV, Mioio Android displays),\nany modern desktop browser at dashieapp.com, phones and tablets (responsive web plus a native\niOS app), and Android as a single app that supports both kiosk and full modes. The same account\nand settings follow you across devices."
  },
  {
    "id": "overview:do-i-need-an-account",
    "file": "overview.md",
    "title": "Do I need an account?",
    "topic": "overview",
    "status": "ga",
    "page": null,
    "action": null,
    "body": "Kiosk mode (the Home Assistant display) needs no account. The full family dashboard \u2014 calendar,\nphotos, chores, rewards, and the AI voice assistant \u2014 requires a Dashie account, which you create\nby signing in with Google."
  },
  {
    "id": "overview:how-do-i-sign-in-or-create-an-account",
    "file": "overview.md",
    "title": "How do I sign in or create an account?",
    "topic": "overview",
    "status": "ga",
    "page": "account",
    "action": "open_settings_page(account)",
    "body": "Open **Settings \u2192 Account** and choose sign in. On a desktop or phone you sign in with Google.\nOn a TV, Dashie shows a QR code (device flow) \u2014 scan it with your phone to link the TV to your\naccount without typing. Once signed in, the dashboard switches to full mode automatically."
  },
  {
    "id": "settings-map:where-do-i-change-the-theme-turn-on-dark-mode",
    "file": "settings-map.md",
    "title": "Where do I change the theme / turn on dark mode?",
    "topic": "settings",
    "status": "ga",
    "page": "display-manage-themes",
    "action": "open_settings_page(display-manage-themes)",
    "body": 'Open **Settings \u2192 Display \u2192 Manage Themes**. There you can switch between Light and Dark mode and\npick seasonal overlays (Halloween, Christmas). You can also just say "switch to dark mode" or\n"turn on the light theme."'
  },
  {
    "id": "settings-map:where-are-the-display-settings-clock-format-dashboard-zoom-s",
    "file": "settings-map.md",
    "title": "Where are the display settings \u2014 clock format, dashboard zoom, screen-off?",
    "topic": "settings",
    "status": "ga",
    "page": "display",
    "action": "open_settings_page(display)",
    "body": "Open **Settings \u2192 Display**. This is where you set the 24-hour vs 12-hour clock, the dashboard\nzoom / display size, dark mode, and screen-off behavior."
  },
  {
    "id": "settings-map:how-do-i-set-up-sleep-and-wake-times",
    "file": "settings-map.md",
    "title": "How do I set up sleep and wake times?",
    "topic": "settings",
    "status": "ga",
    "page": "display-sleep",
    "action": "open_settings_page(display-sleep)",
    "body": "Open **Settings \u2192 Display \u2192 Sleep/Wake**. You can schedule when the screen sleeps and wakes, set\nan inactivity timeout, and choose the wake behavior."
  },
  {
    "id": "settings-map:where-do-i-change-the-screensaver-photo-source-and-timing",
    "file": "settings-map.md",
    "title": "Where do I change the screensaver \u2014 photo source and timing?",
    "topic": "settings",
    "status": "ga",
    "page": "display-screensaver",
    "action": "open_settings_page(display-screensaver)",
    "body": "Open **Settings \u2192 Display \u2192 Screensaver**. Choose the photo source (Home Assistant media, a local\nfolder, Immich, or Google Photos), how long each photo shows, the transition, dim brightness, and\nwhether photo metadata is displayed."
  },
  {
    "id": "settings-map:how-do-i-add-or-remove-a-calendar",
    "file": "settings-map.md",
    "title": "How do I add or remove a calendar?",
    "topic": "settings",
    "status": "ga",
    "page": "calendar-add",
    "action": "open_settings_page(calendar-add)",
    "body": "Open **Settings \u2192 Calendar**, then **Add calendar** to connect a Google or Outlook account, or\n**Remove** to disconnect one. Use **Select calendars** to choose which of your connected\ncalendars are visible on the dashboard. (To just pick which calendars show, use\nSettings \u2192 Calendar \u2192 Select calendars.)"
  },
  {
    "id": "settings-map:how-do-i-choose-which-calendars-are-visible",
    "file": "settings-map.md",
    "title": "How do I choose which calendars are visible?",
    "topic": "settings",
    "status": "ga",
    "page": "calendar-select",
    "action": "open_settings_page(calendar-select)",
    "body": "Open **Settings \u2192 Calendar \u2192 Select calendars** and toggle each calendar on or off. Only the ones\nyou enable appear on the dashboard and are read by the voice assistant."
  },
  {
    "id": "settings-map:where-are-the-voice-and-ai-settings",
    "file": "settings-map.md",
    "title": "Where are the voice and AI settings?",
    "topic": "settings",
    "status": "ga",
    "page": "voice",
    "action": "open_settings_page(voice)",
    "body": "Open **Settings \u2192 Voice & AI**. This is where you turn voice on or off, enable the wake word,\nchoose the voice pipeline, and pick the AI model. Sub-screens let you pick the spoken voice\n(Voice \u2192 Select voice), the AI model (Voice \u2192 AI model), and the wake word."
  },
  {
    "id": "settings-map:how-do-i-change-the-ai-voice-the-voice-dashie-speaks-in",
    "file": "settings-map.md",
    "title": "How do I change the AI voice (the voice Dashie speaks in)?",
    "topic": "settings",
    "status": "ga",
    "page": "voice-select",
    "action": "open_settings_page(voice-select)",
    "body": 'Open **Settings \u2192 Voice & AI \u2192 Select voice** and pick a voice. You can also say "change your\nvoice to <name>."'
  },
  {
    "id": "settings-map:how-do-i-change-which-ai-model-dashie-uses",
    "file": "settings-map.md",
    "title": "How do I change which AI model Dashie uses?",
    "topic": "settings",
    "status": "ga",
    "page": "voice-ai-model-select",
    "action": "open_settings_page(voice-ai-model-select)",
    "body": "Open **Settings \u2192 Voice & AI \u2192 AI model** and choose the provider/model (Claude, OpenAI, or\nGemini)."
  },
  {
    "id": "settings-map:where-do-i-manage-family-members-roles-and-invitations",
    "file": "settings-map.md",
    "title": "Where do I manage family members, roles, and invitations?",
    "topic": "settings",
    "status": "ga",
    "page": "family",
    "action": "open_settings_page(family)",
    "body": "Open **Settings \u2192 Family**. Add or edit members, set their role (Owner, Parent, or Member), pick\nmember colors, and send invitations so others can join the family."
  },
  {
    "id": "settings-map:where-are-the-chores-and-rewards-settings",
    "file": "settings-map.md",
    "title": "Where are the chores and rewards settings?",
    "topic": "settings",
    "status": "ga",
    "page": "chores-rewards",
    "action": "open_settings_page(chores-rewards)",
    "body": "Open **Settings \u2192 Chores & Rewards** to create and manage chores (points, assignment, time of\nday, icons) and the rewards catalog (point costs, approval)."
  },
  {
    "id": "settings-map:where-do-i-connect-photos-dropbox-albums-slideshow-timing",
    "file": "settings-map.md",
    "title": "Where do I connect photos (Dropbox / albums / slideshow timing)?",
    "topic": "settings",
    "status": "ga",
    "page": "photos",
    "action": "open_settings_page(photos)",
    "body": "Open **Settings \u2192 Photos** to connect Dropbox, choose albums, and set slideshow timing for the\nPhotos widget. (The screensaver's photo source is set separately under Display \u2192 Screensaver.)"
  },
  {
    "id": "settings-map:where-do-i-set-up-home-assistant-dashboard-url-token",
    "file": "settings-map.md",
    "title": "Where do I set up Home Assistant (dashboard URL, token)?",
    "topic": "settings",
    "status": "ga",
    "page": "home-assistant",
    "action": "open_settings_page(home-assistant)",
    "body": "Open **Settings \u2192 Home Assistant**. Set the dashboard URL, hide/show the HA sidebar and tabs,\nconfigure the API, and paste your access token. (This page is available in kiosk mode.)"
  },
  {
    "id": "settings-map:where-do-i-configure-family-gps-locations",
    "file": "settings-map.md",
    "title": "Where do I configure family GPS locations?",
    "topic": "settings",
    "status": "ga",
    "page": "locations",
    "action": "open_settings_page(locations)",
    "body": "Open **Settings \u2192 Locations** to configure family member GPS/location tracking."
  },
  {
    "id": "settings-map:where-do-i-set-up-music",
    "file": "settings-map.md",
    "title": "Where do I set up music?",
    "topic": "settings",
    "status": "ga",
    "page": "music",
    "action": "open_settings_page(music)",
    "body": "Open **Settings \u2192 Music** to pick the Home Assistant media_player entity and configure volume\nsync for the music overlay."
  },
  {
    "id": "settings-map:where-do-i-set-up-camera-video-feeds",
    "file": "settings-map.md",
    "title": "Where do I set up camera / video feeds?",
    "topic": "settings",
    "status": "beta",
    "page": "video-feeds",
    "action": "open_settings_page(video-feeds)",
    "body": "Newer feature \u2014 Android/Home-Assistant kiosk devices, may not be on your plan yet. Open\n**Settings \u2192 Video Feeds** to add camera streams, set the feed size, and control motion/doorbell\nalert behavior. Basic camera options are also under **Settings \u2192 Camera**."
  },
  {
    "id": "settings-map:where-are-account-settings-pin-zip-code-sign-out",
    "file": "settings-map.md",
    "title": "Where are account settings \u2014 PIN, zip code, sign out?",
    "topic": "settings",
    "status": "ga",
    "page": "account",
    "action": "open_settings_page(account)",
    "body": "Open **Settings \u2192 Account** for PIN protection, your zip code, and sign in / sign out. On a locked\nkiosk, opening Settings or the Control Center prompts for the PIN (with a short grace period after\nyou enter it correctly)."
  },
  {
    "id": "settings-map:where-do-i-find-device-info-cache-and-diagnostics",
    "file": "settings-map.md",
    "title": "Where do I find device info, cache, and diagnostics?",
    "topic": "settings",
    "status": "ga",
    "page": "system",
    "action": "open_settings_page(system)",
    "body": "Open **Settings \u2192 System** for device information, clearing the cache, sending diagnostics, and a\nshortcut to Android's own settings."
  },
  {
    "id": "settings-map:where-are-the-advanced-settings",
    "file": "settings-map.md",
    "title": "Where are the advanced settings?",
    "topic": "settings",
    "status": "ga",
    "page": "advanced",
    "action": "open_settings_page(advanced)",
    "body": "Open **Settings \u2192 Advanced** for return-to-home behavior, periodic refresh, performance and\nmemory management, and data-sharing options."
  },
  {
    "id": "troubleshooting:my-screen-is-black-blank",
    "file": "troubleshooting.md",
    "title": "My screen is black / blank",
    "topic": "troubleshooting",
    "status": "ga",
    "page": "display-screensaver",
    "action": "open_settings_page(display-screensaver)",
    "body": "A black screen is usually the screensaver or a scheduled sleep. Tap the screen or press a remote\nbutton to wake it. If it stays black, check **Settings \u2192 Display \u2192 Sleep/Wake** for a sleep\nschedule or inactivity timeout, and **Settings \u2192 Display \u2192 Screensaver** for the dim setting. If\nthe screen is on but the dashboard didn't come back, a reload usually fixes it."
  },
  {
    "id": "troubleshooting:my-calendar-events-aren-t-showing-up",
    "file": "troubleshooting.md",
    "title": "My calendar events aren't showing up",
    "topic": "troubleshooting",
    "status": "ga",
    "page": "calendar-select",
    "action": "open_settings_page(calendar-select)",
    "body": "First check **Settings \u2192 Calendar \u2192 Select calendars** and make sure the calendar is toggled on \u2014\nonly enabled calendars appear. If the account is missing entirely, re-add it under\nSettings \u2192 Calendar \u2192 Add calendar. Newly added events can take a short while to sync; a refresh\nspeeds it up."
  },
  {
    "id": "troubleshooting:the-voice-assistant-isn-t-responding-to-hey-dashie",
    "file": "troubleshooting.md",
    "title": `The voice assistant isn't responding to "Hey Dashie"`,
    "topic": "troubleshooting",
    "status": "ga",
    "page": "voice",
    "action": "open_settings_page(voice)",
    "body": "Check **Settings \u2192 Voice & AI**: make sure voice and the wake word are enabled and the microphone\nisn't muted. The wake word needs microphone permission and works on supported devices (Android/TV\nwith the voice feature). If the wake word won't trigger, you can always tap the microphone button\nto talk instead. Reducing background noise helps detection."
  },
  {
    "id": "troubleshooting:the-dashboard-is-frozen-or-won-t-load",
    "file": "troubleshooting.md",
    "title": "The dashboard is frozen or won't load",
    "topic": "troubleshooting",
    "status": "ga",
    "page": "system",
    "action": "open_settings_page(system)",
    "body": "Try reloading the dashboard first. If it's still stuck, clear the cache under\n**Settings \u2192 System**, then reload. On Android, force-stopping and reopening the app clears the\nin-memory state. If a specific widget is the problem, removing and re-adding it can help."
  },
  {
    "id": "troubleshooting:photos-aren-t-showing-in-the-screensaver-or-widget",
    "file": "troubleshooting.md",
    "title": "Photos aren't showing in the screensaver or widget",
    "topic": "troubleshooting",
    "status": "ga",
    "page": "display-screensaver",
    "action": "open_settings_page(display-screensaver)",
    "body": "Confirm the photo source is set and reachable under **Settings \u2192 Display \u2192 Screensaver** (for the\nscreensaver) or **Settings \u2192 Photos** (for the widget and Dropbox). If the source is Google\nPhotos, Immich, Dropbox, or HA media, make sure that connection is still authorized. An empty\nalbum or an expired connection shows no photos."
  },
  {
    "id": "troubleshooting:home-assistant-isn-t-connecting-or-the-dashboard-is-blank",
    "file": "troubleshooting.md",
    "title": "Home Assistant isn't connecting or the dashboard is blank",
    "topic": "troubleshooting",
    "status": "ga",
    "page": "home-assistant",
    "action": "open_settings_page(home-assistant)",
    "body": "Check **Settings \u2192 Home Assistant**: verify the dashboard URL and that the access token is still\nvalid. If HA is on your local network, the device needs to be on the same network. A 404 or blank\nHA iframe usually means the URL or token needs updating."
  },
  {
    "id": "troubleshooting:the-screen-keeps-going-to-sleep-too-soon-or-won-t-sleep",
    "file": "troubleshooting.md",
    "title": "The screen keeps going to sleep too soon (or won't sleep)",
    "topic": "troubleshooting",
    "status": "ga",
    "page": "display-sleep",
    "action": "open_settings_page(display-sleep)",
    "body": "Adjust the schedule and inactivity timeout under **Settings \u2192 Display \u2192 Sleep/Wake**. If it sleeps\ntoo soon, lengthen the inactivity timeout; if it never sleeps, check that a sleep schedule is set."
  },
  {
    "id": "troubleshooting:how-do-i-report-a-bug-or-something-that-s-broken",
    "file": "troubleshooting.md",
    "title": "How do I report a bug or something that's broken?",
    "topic": "troubleshooting",
    "status": "ga",
    "page": null,
    "action": null,
    "body": `If a fix here doesn't solve it, email the Dashie team at **support@dashieapp.com** with a
description of the problem. On Android you can also send diagnostics from **Settings \u2192 System**,
which gives the team device logs to look into it. (Voice-driven "tell the team X" support
submission is a planned addition.)`
  },
  {
    "id": "voice-capabilities:what-can-you-do-what-can-i-ask-you",
    "file": "voice-capabilities.md",
    "title": "What can you do? / What can I ask you?",
    "topic": "voice",
    "status": "ga",
    "page": null,
    "action": null,
    "body": "You can ask me about your family calendar, the weather, and sports scores; control your Home\nAssistant smart home; set and manage timers; complete chores; check where family members are and\ntravel time to events; change the theme or my voice; and ask how Dashie works \u2014 where a setting\nis, how to do something, or how to fix a problem. Just talk naturally, by voice or by typing."
  },
  {
    "id": "voice-capabilities:ask-about-the-calendar",
    "file": "voice-capabilities.md",
    "title": "Ask about the calendar",
    "topic": "voice",
    "status": "ga",
    "page": null,
    "action": null,
    "body": `Ask things like "what's on the calendar today?", "do I have anything this weekend?", "when is the
next soccer game?", or "what time is Mom's appointment?" I read from your real merged calendar,
including who each event belongs to.`
  },
  {
    "id": "voice-capabilities:ask-about-the-weather",
    "file": "voice-capabilities.md",
    "title": "Ask about the weather",
    "topic": "voice",
    "status": "ga",
    "page": null,
    "action": null,
    "body": `Ask "what's the weather?", "will it rain today?", "how's the forecast this weekend?", or the
weather for a specific place. I use your family's home location unless you name somewhere else.`
  },
  {
    "id": "voice-capabilities:control-the-smart-home-home-assistant",
    "file": "voice-capabilities.md",
    "title": "Control the smart home (Home Assistant)",
    "topic": "voice",
    "status": "ga",
    "page": null,
    "action": null,
    "body": 'Say things like "turn on the kitchen lights," "close the garage," "set the thermostat to 70," or\n"is the garage door open?" I pass these to Home Assistant, including multi-device commands.'
  },
  {
    "id": "voice-capabilities:set-timers",
    "file": "voice-capabilities.md",
    "title": "Set timers",
    "topic": "voice",
    "status": "ga",
    "page": null,
    "action": null,
    "body": 'Say "set a 5 minute timer," "how much time is left?", "pause the timer," or "cancel it." You can\nrun up to three timers at once.'
  },
  {
    "id": "voice-capabilities:chores-and-rewards",
    "file": "voice-capabilities.md",
    "title": "Chores and rewards",
    "topic": "voice",
    "status": "ga",
    "page": null,
    "action": null,
    "body": 'Say "mark dishes as done" or "I finished taking out the trash" to complete a chore, or ask "what\nchores are left?" You can also ask about rewards you can redeem.'
  },
  {
    "id": "voice-capabilities:change-the-theme-or-my-voice",
    "file": "voice-capabilities.md",
    "title": "Change the theme or my voice",
    "topic": "voice",
    "status": "ga",
    "page": null,
    "action": null,
    "body": `Say "switch to dark mode," "turn on the light theme," or "change your voice." For anything else in
settings, ask me where it is and I'll point you to the right page.`
  },
  {
    "id": "voice-capabilities:change-my-personality",
    "file": "voice-capabilities.md",
    "title": "Change my personality",
    "topic": "voice",
    "status": "ga",
    "page": null,
    "action": null,
    "body": 'Ask "what personalities do you have?" to hear the options, then say "switch to the princess\npersonality," "be a pirate," or "talk like a wizard" to change me. Each personality has its own\nvoice, and the change applies to this device only \u2014 so a different Dashie in another room keeps\nits own. Say "go back to normal" to return to the default.'
  },
  {
    "id": "voice-capabilities:sports-scores",
    "file": "voice-capabilities.md",
    "title": "Sports scores",
    "topic": "voice",
    "status": "ga",
    "page": null,
    "action": null,
    "body": `Ask "did the <team> win?", "what's the score?", or "when do the <team> play next?" I look up live
scores and schedules for a specific team or league.`
  },
  {
    "id": "voice-capabilities:ask-about-dashie-itself",
    "file": "voice-capabilities.md",
    "title": "Ask about Dashie itself",
    "topic": "voice",
    "status": "ga",
    "page": null,
    "action": null,
    "body": `Ask "how do I add a calendar?", "where's the dark mode setting?", "why is my screen black?", or
"what is Dashie?" I answer from Dashie's own knowledge rather than guessing or searching the web.`
  },
  {
    "id": "voice-capabilities:set-reminders",
    "file": "voice-capabilities.md",
    "title": "Set reminders",
    "topic": "voice",
    "status": "beta",
    "page": null,
    "action": null,
    "body": `Newer feature \u2014 may not be on your plan yet. Say "remind me to take out the trash in 30 minutes"
and I'll set a reminder and confirm it; when it's time a reminder pops up with a chime and a spoken
message. Reminders are for a message at a time; timers are plain countdowns.`
  },
  {
    "id": "voice-capabilities:have-a-back-and-forth-conversation",
    "file": "voice-capabilities.md",
    "title": "Have a back-and-forth conversation",
    "topic": "voice",
    "status": "beta",
    "page": "voice",
    "action": "open_settings_page(voice)",
    "body": `Newer feature \u2014 opt-in and may not be on your plan yet. If you turn on conversation mode in
**Settings \u2192 Voice & AI**, you can say "Hey Dashie, conversation mode" to start a continuous
back-and-forth \u2014 I keep listening between turns and you can interrupt me, until you say "that's
all" or go quiet. Normally each request just starts with "Hey Dashie."`
  }
];

// supabase/functions/_shared/tools/dashie-help.ts
var STOPWORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "do",
  "does",
  "for",
  "how",
  "i",
  "in",
  "is",
  "it",
  "my",
  "of",
  "on",
  "or",
  "the",
  "to",
  "what",
  "when",
  "where",
  "which",
  "why",
  "with",
  "you",
  "about",
  "me",
  "tell",
  // conversational filler — "tell me about X" must score only on X
  "dashie",
  "dashies"
  // present in nearly every chunk — zero discrimination
]);
function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter((w) => w.length > 1 && !STOPWORDS.has(w));
}
function stem(w) {
  return w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w;
}
function rankChunks(question, chunks = KB_CHUNKS) {
  const qTokens = [...new Set(tokenize(question).map(stem))];
  if (!qTokens.length) return [];
  const scored = [];
  for (const chunk of chunks) {
    const titleTokens = new Set(tokenize(chunk.title).map(stem));
    const bodyTokens = new Set(tokenize(chunk.body).map(stem));
    const metaTokens = new Set(tokenize(`${chunk.topic} ${chunk.page ?? ""}`).map(stem));
    let score = 0;
    for (const t of qTokens) {
      if (titleTokens.has(t)) score += 3;
      if (metaTokens.has(t)) score += 2;
      if (bodyTokens.has(t)) score += 1;
    }
    if (score > 0) scored.push({ chunk, score });
  }
  return scored.sort((a, b) => b.score - a.score);
}
var MAX_CHUNKS = 3;
var MIN_SCORE = 4;
var IDENTITY_RE = /\b(who are you|what are you|about (you|yourself|dashie)|what('s| is) dashie|what can (you|i|dashie)|what do you do|introduce yourself|tell me about (yourself|dashie|this))\b/i;
var IDENTITY_CHUNK_IDS = [
  "overview:what-is-dashie",
  "overview:what-can-dashie-do-what-are-the-main-features",
  "voice-capabilities:what-can-you-do-what-can-i-ask-you"
];
function identityChunks(chunks) {
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const picked = IDENTITY_CHUNK_IDS.map((id) => byId.get(id)).filter((c) => !!c);
  return picked.length ? picked : chunks.filter((c) => c.topic === "overview").slice(0, MAX_CHUNKS);
}
var dashieHelpTool = {
  name: "dashie_help",
  description: 'Look up how Dashie itself works \u2014 its features, settings and where to find them, how-to steps, and troubleshooting. Call this for ANY question about Dashie the product ("what can you do", "how do I add a calendar", "where do I change the theme", "why is my screen black"). It returns curated product documentation \u2014 answer from it and do NOT web-search or guess about Dashie. If it returns found:false, say you are not sure; never invent settings locations or prices.',
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "the user's question about Dashie, e.g. 'how do I add a calendar'"
      }
    },
    required: ["question"]
  },
  // deno-lint-ignore require-await
  async execute(args, _ctx) {
    const question = String(args?.question ?? "").trim();
    const ranked = rankChunks(question).filter((s) => s.score >= MIN_SCORE).slice(0, MAX_CHUNKS);
    let hits = ranked.map((s) => s.chunk);
    if (!hits.length && IDENTITY_RE.test(question)) hits = identityChunks(KB_CHUNKS);
    if (!hits.length) return { result: { found: false } };
    return {
      result: {
        found: true,
        question,
        // Beta chunks carry their caveat inline in the prose (see js/ai/knowledge/README.md),
        // so no extra gating here until dashie_help is tier-aware.
        chunks: hits.map((chunk) => ({
          title: chunk.title,
          topic: chunk.topic,
          status: chunk.status,
          answer: chunk.body
        }))
      }
    };
  }
};

// supabase/functions/voice-conversation/retention.ts
function retainFields(persist, userText, responseText, subtext) {
  if (!persist) return {};
  return {
    prompt_text: userText || null,
    response_text: responseText || null,
    display_text: subtext || null
  };
}

// supabase/functions/voice-conversation/weather-synth.ts
function wmoToCondition(code) {
  const c = Number(code);
  if (c === 0) return "sunny";
  if (c === 1 || c === 2) return "partlycloudy";
  if (c === 3) return "cloudy";
  if (c === 45 || c === 48) return "fog";
  if (c === 65 || c === 82) return "pouring";
  if (c === 66 || c === 67) return "snowy-rainy";
  if (c >= 51 && c <= 57 || c >= 61 && c <= 63 || c === 80 || c === 81) return "rainy";
  if (c >= 71 && c <= 77 || c === 85 || c === 86) return "snowy";
  if (c === 95) return "lightning-rainy";
  if (c === 96 || c === 99) return "hail";
  return "cloudy";
}
function weatherResultToReading(w) {
  return {
    found: true,
    source: w.provider,
    location: { city: w.location?.city || "", state: w.location?.state || "" },
    current: {
      temperature: w.current?.temperature,
      condition: wmoToCondition(w.current?.weatherCode),
      windSpeed: w.current?.windSpeed
    },
    daily: (w.daily || []).map((d) => ({
      date: d.date,
      dayName: d.dayName,
      high: d.high,
      low: d.low,
      condition: wmoToCondition(d.weatherCode),
      precipProbability: d.precipProbability
    })),
    hourly: (w.hourly || []).map((h) => ({
      time: h.time,
      precipProb: h.precipProb,
      condition: wmoToCondition(h.weatherCode)
    }))
  };
}
var CONDITION = {
  sunny: { adj: "sunny", precip: "rain" },
  clear: { adj: "clear", precip: "rain" },
  "clear-night": { adj: "clear", precip: "rain" },
  partlycloudy: { adj: "partly cloudy", precip: "rain" },
  cloudy: { adj: "cloudy", precip: "rain" },
  fog: { adj: "foggy", precip: "rain" },
  rainy: { adj: "rainy", precip: "rain" },
  pouring: { adj: "heavy rain", precip: "rain" },
  "snowy-rainy": { adj: "a wintry mix", precip: "wintry mix" },
  snowy: { adj: "snowy", precip: "snow" },
  "lightning-rainy": { adj: "thunderstorms", precip: "storms" },
  hail: { adj: "thunderstorms with hail", precip: "storms" }
};
function cond(token) {
  return CONDITION[String(token || "").toLowerCase()] || { adj: "mixed conditions", precip: "rain" };
}
function precipPhrase(day) {
  const p = Math.round(Number(day?.precipProbability) || 0);
  if (p < 20) return "";
  return `${p}% chance of ${cond(day?.condition).precip}`;
}
function dayLine(day, { withLow = true } = {}) {
  const { adj } = cond(day?.condition);
  const bits = [adj];
  if (Number.isFinite(day?.high)) bits.push(`high ${Math.round(day.high)}`);
  if (withLow && Number.isFinite(day?.low)) bits.push(`low ${Math.round(day.low)}`);
  const precip = precipPhrase(day);
  const line = bits.join(", ");
  return precip ? `${line}, ${precip}` : line;
}
var WEEKEND = /* @__PURE__ */ new Set(["saturday", "sunday"]);
function findDay(daily, name) {
  const want = String(name || "").toLowerCase();
  return daily.find((d) => String(d.dayName || "").toLowerCase() === want) || null;
}
function weekendDays(daily) {
  return daily.filter((d) => WEEKEND.has(String(d.dayName || "").toLowerCase())).slice(0, 2);
}
var WET_CONDITIONS = /* @__PURE__ */ new Set(["rainy", "pouring", "snowy", "snowy-rainy", "lightning-rainy", "hail"]);
function hourIsWet(h) {
  const prob = Number(h?.precipProb) || 0;
  return prob >= 50 || WET_CONDITIONS.has(String(h?.condition || "").toLowerCase());
}
function hourLabel(t) {
  const s = String(t || "").trim();
  const lbl = /^(\d{1,2})\s*(AM|PM)$/i.exec(s);
  if (lbl) return `${parseInt(lbl[1], 10)} ${lbl[2].toUpperCase()}`;
  const iso = /T(\d{2})/.exec(s);
  if (iso) {
    let h = parseInt(iso[1], 10);
    const ap = h < 12 ? "AM" : "PM";
    h %= 12;
    if (h === 0) h = 12;
    return `${h} ${ap}`;
  }
  return "";
}
function precipWord(hours) {
  const w = hours.find(hourIsWet);
  return String(w?.condition || "").toLowerCase().startsWith("snow") ? "snow" : "rain";
}
function precipTimingLine(data) {
  const hrs = (Array.isArray(data.hourly) ? data.hourly : []).slice(0, 18);
  if (hrs.length === 0) return currentLine(data);
  const word = precipWord(hrs);
  if (hourIsWet(hrs[0])) {
    const stop = hrs.findIndex((h, i) => i > 0 && !hourIsWet(h));
    if (stop === -1) return `The ${word} should stick around for the next several hours.`;
    const when2 = hourLabel(hrs[stop].time);
    return when2 ? `The ${word} should let up around ${when2}.` : `The ${word} should let up soon.`;
  }
  const start = hrs.findIndex(hourIsWet);
  if (start === -1) return `No ${word} in the forecast for the next several hours.`;
  const when = hourLabel(hrs[start].time);
  const Cap = word.charAt(0).toUpperCase() + word.slice(1);
  return when ? `${Cap} looks likely around ${when}.` : `${Cap} is possible later.`;
}
function currentLine(data) {
  const c = data.current || {};
  const place = data.location?.city ? ` in ${data.location.city}` : "";
  const temp = Number.isFinite(c.temperature) ? `${Math.round(c.temperature)} degrees` : "out";
  const head = `It's ${temp} and ${cond(c.condition).adj}${place}.`;
  const today = (data.daily || [])[0];
  const precip = today ? precipPhrase(today) : "";
  return precip ? `${head} ${precip[0].toUpperCase()}${precip.slice(1)} today.` : head;
}
function templateWeather(data, query = {}) {
  if (!data || data.found === false) {
    return { voice: "I couldn't get the weather right now.", text: null, card: null };
  }
  const daily = Array.isArray(data.daily) ? data.daily : [];
  const tf = String(query?.timeframe || "").toLowerCase().trim();
  let voice;
  if (tf === "weekend") {
    const wknd = weekendDays(daily);
    if (wknd.length === 0) {
      voice = currentLine(data);
    } else {
      const parts = wknd.map((d) => `${d.dayName} ${dayLine(d, { withLow: false })}`);
      voice = `This weekend: ${parts.join("; ")}.`;
    }
  } else if (tf === "tonight") {
    const today = daily[0];
    voice = today && Number.isFinite(today.low) ? `Tonight: ${cond(today.condition).adj}, low ${Math.round(today.low)}.` : currentLine(data);
  } else if (tf === "today") {
    const today = daily[0];
    voice = today ? `Today: ${dayLine(today)}.` : currentLine(data);
  } else if (tf === "tomorrow") {
    const t = daily[1];
    voice = t ? `Tomorrow: ${dayLine(t)}.` : currentLine(data);
  } else if (tf === "precip_timing") {
    voice = precipTimingLine(data);
  } else if (tf && tf !== "current" && tf !== "this_week") {
    const d = findDay(daily, tf);
    voice = d ? `${d.dayName}: ${dayLine(d)}.` : currentLine(data);
  } else {
    voice = currentLine(data);
  }
  return { voice, text: null, card: null };
}

// supabase/functions/voice-conversation/multi-dispatch.ts
var ZERO_USAGE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
function addUsage(a, u) {
  const b = u ?? {};
  return {
    input_tokens: a.input_tokens + (b.input_tokens ?? 0),
    output_tokens: a.output_tokens + (b.output_tokens ?? 0),
    total_tokens: a.total_tokens + (b.total_tokens ?? 0),
    reasoning_tokens: (a.reasoning_tokens ?? 0) + (b.reasoning_tokens ?? 0)
  };
}
function recoverHaAction(parsed) {
  const p = parsed;
  const query = p.query ?? {};
  const params = p.parameters ?? p.action?.parameters ?? {};
  const raw = Array.isArray(query.commands) ? query.commands : Array.isArray(params.commands) ? params.commands : Array.isArray(p.commands) ? p.commands : null;
  if (!raw) return null;
  const commands = raw.filter((c) => !!c && typeof c === "object" && typeof c.domain === "string" && typeof c.service === "string");
  if (commands.length === 0) return null;
  const voice = typeof parsed.voice === "string" && parsed.voice ? parsed.voice : "Done.";
  return {
    type: "action",
    voice,
    text: null,
    action: { category: "homeassistant", command: "execute_commands", parameters: { commands } }
  };
}
async function resolveHaStep(step, deps) {
  const commandHint = step.query?.command_hint;
  const hint = typeof commandHint === "string" && commandHint.trim() ? commandHint : deps.userText;
  const haContext = { ...deps.context, chatHistory: "" };
  const prompt = buildPrompt({
    userRequest: hint,
    inquiryType: "home-assistant",
    retrievedData: { entities: deps.entities ?? [], command_hint: hint },
    context: haContext
  });
  const pass2 = await deps.callGateway({ provider: deps.provider, prompt, modelId: deps.modelId, kind: "decide" });
  if (!pass2.ok || !pass2.raw) return { error: pass2.error || "ha pass-2 failed" };
  let parsed = parseContent(pass2.raw.content);
  if (parsed && parsed.type === "info_request") {
    const recovered = recoverHaAction(parsed);
    if (recovered) parsed = recovered;
  }
  const action = parsed?.action ?? null;
  const usage = addUsage({ ...ZERO_USAGE }, pass2.raw.usage);
  const stage = {
    name: "pass2_multi_ha",
    latency_ms: pass2.latency_ms,
    model: pass2.raw.model,
    provider: pass2.raw.provider,
    usage,
    type: parsed?.type
  };
  return { action, stage, usage, latencyMs: pass2.latency_ms };
}
async function dispatchMultiTurn(steps, deps) {
  const out = [];
  const stages = [];
  let usage = { ...ZERO_USAGE };
  let latencyMs = 0;
  for (const step of steps) {
    if (step.tool === "home_assistant") {
      if (!deps.entities || deps.entities.length === 0) {
        out.push({ tool: "home_assistant", unsupported_tool: "home_assistant" });
        continue;
      }
      const res = await resolveHaStep(step, deps);
      if ("error" in res) {
        out.push({ tool: "home_assistant", unsupported_tool: "home_assistant" });
        continue;
      }
      stages.push(res.stage);
      usage = addUsage(usage, res.usage);
      latencyMs += res.latencyMs;
      if (res.action) out.push({ tool: "home_assistant", action: res.action });
      else out.push({ tool: "home_assistant", unsupported_tool: "home_assistant" });
      continue;
    }
    if (step.tool === "music" || step.tool === "video_feeds") {
      out.push({ tool: step.tool, client_tool: { tool: step.tool, query: step.query } });
      continue;
    }
    out.push({ tool: step.tool, unsupported_tool: step.tool });
  }
  return { steps: out, stages, usage, latencyMs };
}

// supabase/functions/voice-conversation/orchestrator.ts
var KNOWN_DEVICE_TOOL_DECLINES = {
  // NB: calendar_events is intentionally NOT here — it's now offered to every caller and its
  // decline is self-fulfilled in the calendar branch (a non-claiming kiosk routes to it and gets
  // "…not set up on this device"). This map is the parse-fail backstop for tools that are DROPPED
  // from the offering (caps.tools), where a blob naming a dropped tool needs a canned decline.
  calendar_write: "I can't make calendar changes on this device.",
  music: "I can't control music on this device.",
  video_feeds: "I can't show cameras on this device.",
  open_app: "I can't open apps on this device."
};
var GAME_DETAIL_RE = /\b(summar(?:y|ize|ise)|recap|rundown|breakdown|break it down|highlights?|walk me through|go deeper|analy(?:sis|ze|se)|how did .{0,24}?(?:play|do|look)|what happened|tell me more|tell me about|more about|(?:any |more )?details?|who scored|who (?:got|had) (?:the |a )?goals?|top scorers?|hat[- ]?trick)\b/i;
function wantsGameDetail(text) {
  return !!text && GAME_DETAIL_RE.test(text);
}
var SCORE_SCHEDULE_RE = new RegExp(
  "(\\bscores?\\b|\\bwho\\s+won\\b|\\bwho\\s+is\\s+winning\\b|\\bwho'?s\\s+winning\\b|\\bdid\\s+(?:the\\s+)?\\w+(?:\\s+\\w+)?\\s+win\\b|\\bwin\\s+or\\s+lose\\b|\\bfinal\\b|\\bresults?\\b|\\bhow\\s+(?:did|are|is)\\s+.{0,24}?\\b(?:do|doing|going)\\b|\\bare\\s+they\\s+winning\\b|\\bwhen\\s+(?:is|are|do|does|did)\\b|\\bwhat\\s+time\\b|\\bwhat\\s+day\\b|\\bnext\\s+game\\b|\\blast\\s+game\\b|\\bplaying\\s+(?:today|tonight|tomorrow)\\b|\\bwho\\s+(?:are|is)\\s+(?:they|.{0,20}?)\\s*play(?:ing)?\\b|\\bwho\\s+do\\s+.{0,20}?\\bplay\\b|\\b(?:any|what|which)\\s+.{0,20}?\\b(?:games?|teams?)\\b|\\bgames?\\s+(?:on|today|tonight|tomorrow)\\b|\\bis\\s+there\\s+a\\s+game\\b|\\bare\\s+(?:they|the\\s+\\w+)\\s+playing\\b|\\bschedule\\b|\\bkick\\s?off\\b|\\bwho\\s+they\\s+play\\b)",
  "i"
);
function templateCanAnswer(text) {
  if (!text) return false;
  return SCORE_SCHEDULE_RE.test(text);
}
var SPORTS_ASK_RE = new RegExp(
  "\\b(world cup|fifa|nfl|nba|mlb|nhl|wnba|mls|premier league|champions league|la liga|bundesliga|serie a|super bowl|world series|stanley cup|march madness|college (?:football|basketball)|score|scores|scored|who won|final score|standings|shut ?out|games?|match(?:es|up)?|kick ?off|innings?|semifinals?|quarterfinals?)\\b",
  "i"
);
var SPORTS_RESULT_RE = /\bdid\b[^?]{0,32}\b(win|won|lose|lost|beat)\b/i;
var SPORTS_SCHEDULE_RE = /\b(?:when|what time)\b[^?]{0,32}\bplay(?:s|ing)?\b/i;
function looksLikeSportsAsk(text) {
  const t = text || "";
  return !!t && (SPORTS_ASK_RE.test(t) || SPORTS_RESULT_RE.test(t) || SPORTS_SCHEDULE_RE.test(t));
}
var TOOL_STATUS = {
  web_search: "Searching the web",
  sports: "Checking the score",
  home_assistant: "Asking Home Assistant",
  calendar_events: "Checking your calendar",
  weather_data: "Checking the weather",
  // A tool with no entry here falls back to 'Looking that up' — which is actively WRONG for a
  // tool that DOES something rather than looks something up. "turn the lights on in 5 minutes"
  // showed "Looking that up" while it was scheduling (John, 2026-07-13).
  schedule_action: "Setting that up"
};
var CALENDAR_WRITE_STATUS = {
  create: "Adding that to your calendar",
  update: "Updating your calendar",
  delete: "Removing that from your calendar"
};
function statusForTool(tool, query) {
  if (tool === "sports") {
    const q = query ?? {};
    const w = String(q.when ?? "").toLowerCase();
    const t = String(q.type ?? "").toLowerCase();
    if (w === "next" || w === "upcoming" || t === "schedule" || q.list === true) return "Checking the schedule";
  }
  if (tool === "calendar_write") {
    const a = String((query ?? {}).action ?? "").toLowerCase();
    return CALENDAR_WRITE_STATUS[a] || "Updating your calendar";
  }
  return TOOL_STATUS[tool] || "Looking that up";
}
function callerFulfills(req, tool) {
  const list = req.client_fulfilled_tools;
  if (!Array.isArray(list)) return true;
  return list.includes(tool);
}
function resolveWeatherLocation(query, zip) {
  const named = typeof query.location === "string" ? query.location.trim() : "";
  if (named) return { locationName: named };
  if (zip) return { zip };
  return null;
}
function enrichSetPersonalityAction(action, choices) {
  const params = action?.command === "set_personality" ? action.parameters : null;
  if (!params || typeof params.key !== "string") return null;
  const row = choices.find((c) => c.key === params.key);
  if (!row) return null;
  if (row.voice_mode != null) params.voice_mode = row.voice_mode;
  if (row.voice != null) params.voice_key = row.voice;
  if (row.greeting_fallback != null) params.greeting_fallback = row.greeting_fallback;
  return row;
}
async function restampVoiceForSwitch(io, supabase, voiceCtx, row) {
  const targetKey = row?.voice;
  if (!targetKey || !io.resolveVoiceId) return;
  try {
    const v = await io.resolveVoiceId(supabase, targetKey);
    if (v?.voiceId) {
      voiceCtx.voiceId = v.voiceId;
      voiceCtx.voiceProvider = v.provider;
    }
  } catch (e) {
    console.warn("set_personality voice restamp failed (turn keeps the prior voice):", e);
  }
}
var REQUEST_TYPE = "voice_conversation";
var DEFAULT_VOICE_KEY = "ASHLEY";
async function runOrchestration(deps, io) {
  const voiceCtx = { voiceId: null, voiceProvider: null };
  const turn = await orchestrate(deps, io, voiceCtx);
  if (turn.voice_id === void 0 && voiceCtx.voiceId) turn.voice_id = voiceCtx.voiceId;
  if (turn.voice_provider === void 0 && voiceCtx.voiceProvider) turn.voice_provider = voiceCtx.voiceProvider;
  if (classifyMiss(turn.route, turn.voice).miss) {
    const isFirstTurn = !deps.req.history || deps.req.history.length === 0;
    turn.metadata = { ...turn.metadata ?? {}, miss: true };
    if (isFirstTurn) turn.metadata.end_conversation = true;
  }
  if (voiceCtx.credit) turn.metadata = { ...turn.metadata ?? {}, credit: voiceCtx.credit };
  return turn;
}
async function orchestrate(deps, io, voiceCtx) {
  const { req, userId, token, supabase } = deps;
  const t0 = Date.now();
  if (isLikelyNoise(req.text)) {
    io.logInteraction(token, {
      miss: true,
      miss_reason: "noise",
      session_id: req.conversation_id || crypto.randomUUID(),
      request_type: REQUEST_TYPE,
      request_length: (req.text ?? "").length,
      model: "",
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      total_latency_ms: Date.now() - t0,
      success: true,
      endpoint_id: req.endpoint_id
    }).catch(() => {
    });
    return noiseTurn(t0);
  }
  if (isEndIntent(req.text)) return endIntentTurn(t0);
  const sessionId = req.conversation_id || crypto.randomUUID();
  const [personality, retainEnabled, spend, account, rateLimit] = await Promise.all([
    io.resolvePersonality(supabase, userId, req.endpoint_id, req.options?.personality_id),
    io.readRetainTranscripts(supabase, userId),
    // CR1 pre-flight credit gate — folded into the existing parallel reads (no added
    // latency). Absent IO (Node shell / tests) → always spendable. Inert until the
    // `voice_credit_enforce` flag is on for this env.
    io.checkSpendable ? io.checkSpendable(supabase, userId) : Promise.resolve({ spendable: true, balance: Number.POSITIVE_INFINITY, floor: 0, low: false }),
    // T3 (§16.7 item 4): account AI config (model + tool toggles). Absent IO → all-null.
    io.readAccountAiConfig ? io.readAccountAiConfig(supabase, userId) : Promise.resolve({ model: null, webSearchEnabled: null, retrievePicturesEnabled: null, zipCode: null, calendarWriteAccess: null }),
    // CR3: per-account rate-limit backstop. Absent IO → allowed. Inert until enabled.
    io.checkRateLimit ? io.checkRateLimit(supabase, userId) : Promise.resolve({ allowed: true, retryAfterSeconds: 0 })
  ]);
  const voiceKey = io.resolveEffectiveVoiceKey ? await io.resolveEffectiveVoiceKey(supabase, userId, req.endpoint_id, personality) || DEFAULT_VOICE_KEY : personality?.voice || DEFAULT_VOICE_KEY;
  const resolvedVoice = io.resolveVoiceId ? await io.resolveVoiceId(supabase, voiceKey) : null;
  voiceCtx.voiceId = resolvedVoice?.voiceId ?? null;
  voiceCtx.voiceProvider = resolvedVoice?.provider ?? null;
  if (io.checkSpendable) {
    voiceCtx.credit = {
      balance: Number.isFinite(spend.balance) ? spend.balance : null,
      spendable: spend.spendable,
      low: spend.low === true
    };
  }
  if (!rateLimit.allowed) return rateLimitedTurn(t0, rateLimit.retryAfterSeconds);
  const byokBrain = io.billing === "byok";
  if (!spend.spendable && !byokBrain) return insufficientCreditsTurn(t0, spend.balance);
  const paidToolsOk = spend.spendable && io.paidTools !== false;
  const modelId = req.options?.model || account.model || await io.getDefaultModel(supabase);
  const provider = providerForModel(modelId);
  const webSearchAllowed = account.webSearchEnabled !== false && paidToolsOk;
  const retrievePictures = (req.retrieve_pictures ?? (account.retrievePicturesEnabled ?? false)) && paidToolsOk;
  const voiceCalendarWrites = account.calendarWriteAccess === "voice" || account.calendarWriteAccess === "both";
  const callerMode = req.options?.retain_mode === "caller";
  const retain = {
    serverPersist: retainEnabled && !callerMode,
    // brain writes text to Supabase
    callerRetain: retainEnabled && callerMode,
    // caller stores text HA-locally
    userText: req.text
  };
  const deviceFulfilledRetain = () => retainFields(retain.serverPersist, retain.userText, "", null);
  const groundingAvailable = provider === "gemini" && webSearchAllowed;
  const geminiGrounds = groundingAvailable && !looksLikeSportsAsk(req.text);
  const promptWebSearch = webSearchAllowed && !geminiGrounds;
  const isAnnouncement = req.announcement === true;
  const clientTools = req.client_fulfilled_tools;
  const multiEnabled = Array.isArray(clientTools) && clientTools.includes("multi");
  const caps = {
    web_search: webSearchAllowed,
    retrieve_pictures: retrievePictures,
    grounding: geminiGrounds,
    multi: multiEnabled,
    tools: offeredToolNames({ webSearchEnabled: promptWebSearch, announcement: isAnnouncement, clientTools, calendarWriteEnabled: voiceCalendarWrites })
  };
  const context = {
    customPersonalityConfig: personality,
    chatHistory: formatHistory(req.history),
    language: req.language || "system",
    timezone: req.timezone,
    // client IANA zone → correct "today" in the prompt (server is UTC)
    webSearchEnabled: promptWebSearch,
    announcement: isAnnouncement,
    clientTools,
    // → toolsListFor drops device-only tools this caller can't fulfill
    multiEnabled,
    // → buildPrompt appends the capability-gated multi-emission block when true
    calendarWriteEnabled: voiceCalendarWrites,
    // → toolsListFor drops calendar_write when voice writes off
    // false → buildPrompt appends the image-unavailable instruction so the model can't
    // claim to show a picture the enrichment layer will drop.
    retrievePicturesEnabled: retrievePictures,
    // Room awareness (20260715): the HA area this device is in, so an unqualified command
    // ("turn off the lights") resolves to THIS room. Flows to both passes via `...context` in
    // buildPrompt → rendered as {{DEVICE_AREA}} in the home_assistant prompt. Absent → area-blind.
    deviceArea: req.provided_context?.device_area ?? null,
    // Assistant identity (Chickadee open-core): callers may name their persona;
    // absent → buildPrompt defaults to 'Dashie' (byte-identical legacy prompt).
    assistantName: req.assistant_name || null,
    caps
  };
  const forced = webSearchAllowed ? detectMutableEntity(req.text) : null;
  const providedSports = req.provided_context?.sports;
  const providedCalendar = req.provided_context?.calendar;
  const p1Prompt = buildPrompt({
    userRequest: req.text,
    inquiryType: null,
    context: {
      ...context,
      ...providedSports ? { providedSports } : {},
      ...providedCalendar ? { providedCalendar } : {}
    }
  });
  const forcedContent = forced ? JSON.stringify({
    type: "info_request",
    tool: "web_search",
    query: req.text,
    context: `forced web_search (mutable entity: ${forced})`,
    processing_message: "Looking that up"
  }) : null;
  const pass1 = forcedContent ? { ok: true, latency_ms: 0, raw: { content: forcedContent, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } } : await io.callGateway({ provider, prompt: p1Prompt, modelId, grounding: geminiGrounds, kind: "decide", temperature: req.options?.route_temperature, thinkingBudget: req.options?.thinking_budget ?? 0 });
  if (!pass1.ok || !pass1.raw) {
    return errorTurn(t0, pass1, [stageErr("pass1", pass1)]);
  }
  const p1Parsed = parseContent(pass1.raw.content);
  const p1Stage = passStage("pass1", pass1, p1Parsed?.type);
  const route = routeOf(p1Parsed);
  const turnMeta = toolMeta(p1Parsed, route, caps);
  deps.onStage?.({ stage: "routed", route, elapsed_ms: Date.now() - t0 });
  if (p1Parsed?.type === "info_request" && p1Parsed.tool) {
    deps.onStage?.({ stage: "fetching", tool: p1Parsed.tool, status: statusForTool(p1Parsed.tool, p1Parsed.query), elapsed_ms: Date.now() - t0 });
  }
  if (!p1Parsed && /^\s*(```[a-z]*\s*)?[{[]/i.test(pass1.raw.content || "")) {
    const blobTool = (pass1.raw.content || "").match(/"tool"\s*:\s*"([a-z_]+)"/)?.[1];
    if (blobTool && !caps.tools.includes(blobTool) && KNOWN_DEVICE_TOOL_DECLINES[blobTool]) {
      console.warn(`[orchestrator] DROP\u2192decline: pass-1 emitted unparseable JSON for unoffered tool '${blobTool}' \u2014 speaking the device-capability decline`);
      const declineVoice = KNOWN_DEVICE_TOOL_DECLINES[blobTool];
      const decline = { type: "response", voice: declineVoice, text: null, action: null };
      await logPass(
        io,
        deps,
        REQUEST_TYPE,
        req.endpoint_id,
        sessionId,
        p1Prompt,
        pass1,
        retainFields(retain.serverPersist, retain.userText, declineVoice, null),
        turnMeta
      );
      return finalize({ t0, parsed: decline, raw: pass1.raw, stages: [p1Stage], usage: pass1.raw.usage, latency: pass1.latency_ms, retain, sessionId, route });
    }
    const clarifyVoice = "Sorry, I didn't quite catch that \u2014 could you say it again?";
    const clarify = { type: "response", voice: clarifyVoice, text: null, action: null };
    await logPass(
      io,
      deps,
      REQUEST_TYPE,
      req.endpoint_id,
      sessionId,
      p1Prompt,
      pass1,
      retainFields(retain.serverPersist, retain.userText, clarifyVoice, null),
      turnMeta
    );
    return finalize({ t0, parsed: clarify, raw: pass1.raw, stages: [p1Stage], usage: pass1.raw.usage, latency: pass1.latency_ms, retain, sessionId, route });
  }
  if (!p1Parsed || p1Parsed.type === "response" || p1Parsed.type === "action") {
    if (p1Parsed?.type === "action" && p1Parsed.action?.command === "set_personality") {
      try {
        const choices = io.listPersonalities ? await io.listPersonalities(supabase) : await listAvailablePersonalities(supabase);
        const row = enrichSetPersonalityAction(p1Parsed.action, choices);
        const greeting = row?.greeting_fallback?.trim();
        if (greeting) p1Parsed.voice = greeting;
        await restampVoiceForSwitch(io, supabase, voiceCtx, row);
      } catch (e) {
        console.warn("set_personality direct-path enrichment failed (action ships unenriched):", e);
      }
    }
    const sportsCard = providedSports && p1Parsed?.type === "response" ? templateSports(providedSports, providedSports.query || {}, { timezone: req.timezone }).structured_data : void 0;
    const imageHint = !sportsCard && retrievePictures && p1Parsed?.type === "response" ? p1Parsed.image : void 0;
    const salvagedTerms = !imageHint?.searchTerms && !sportsCard && retrievePictures && p1Parsed?.type === "response" ? promisedPictureQuery(p1Parsed?.voice, req.text) : null;
    const effImageHint = imageHint?.searchTerms ? imageHint : salvagedTerms ? { searchTerms: salvagedTerms } : void 0;
    if (salvagedTerms) console.warn(`[orchestrator] image-salvage: voice promised a picture with no image field \u2192 searching "${salvagedTerms}"`);
    const imageCard = effImageHint?.searchTerms ? await resolveImageHint({ image: effImageHint }, token, sessionId, io.toolConn) : void 0;
    const card2 = sportsCard ?? imageCard;
    const calendarUsed = !!(providedCalendar && !sportsCard && !imageCard && p1Parsed?.type === "response");
    const logMeta = sportsCard ? {
      tool_used: "get_sports_scores",
      response_type: p1Parsed?.type ?? null,
      tool_trace: { route: "sports", tool: "get_sports_scores", args: providedSports?.query ?? null, caps }
    } : effImageHint?.searchTerms ? {
      tool_used: "show_image",
      response_type: p1Parsed?.type ?? null,
      tool_trace: { route: "image", tool: "show_image", args: { searchTerms: effImageHint.searchTerms, criteria: effImageHint.criteria ?? null, resolved: !!imageCard, salvaged: !!salvagedTerms }, caps }
    } : calendarUsed ? {
      tool_used: "calendar_context",
      response_type: p1Parsed?.type ?? null,
      tool_trace: { route: "calendar", tool: "calendar_context", args: { time_range: providedCalendar.time_range ?? null }, caps }
    } : turnMeta;
    await logPass(
      io,
      deps,
      REQUEST_TYPE,
      req.endpoint_id,
      sessionId,
      p1Prompt,
      pass1,
      retainFields(retain.serverPersist, retain.userText, responseTextOf(p1Parsed, pass1.raw), p1Parsed?.text ?? null),
      logMeta
    );
    return finalize({
      t0,
      parsed: p1Parsed,
      raw: pass1.raw,
      stages: [p1Stage],
      usage: pass1.raw.usage,
      latency: pass1.latency_ms,
      retain,
      sessionId,
      route: sportsCard ? "sports" : imageCard ? "image" : calendarUsed ? "calendar" : route,
      structured_data: card2 ?? void 0,
      // The device attached the window and holds the matching card — this flag tells it
      // the direct path was taken (render the held card). Absent on the tool-fallback path.
      metadata: calendarUsed ? { calendar_context_used: true } : void 0
    });
  }
  if (p1Parsed.type === "info_request" && p1Parsed.tool === "web_search") {
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1);
    const queryStr = typeof p1Parsed.query === "string" ? p1Parsed.query : p1Parsed.query?.query || p1Parsed.query?.q || req.text;
    if (!webSearchAllowed) {
      const NO_SEARCH_SENTINEL = {
        note: "Web search is turned OFF for this user. Do NOT claim to have searched. Answer the question from your own knowledge; if you are not certain of a current fact, say you are not able to look it up right now.",
        query: queryStr
      };
      return await secondPass(io, deps, t0, "web-search", NO_SEARCH_SENTINEL, [p1Stage, { name: "web_search_disabled", latency_ms: 0 }], pass1, provider, modelId, context, sessionId, retain, route, false);
    }
    if (provider === "gemini") {
      const GROUNDED_SENTINEL = {
        note: "No pre-fetched results were provided. Use your Google Search tool to find current information for the query, then answer.",
        query: queryStr
      };
      const groundedStage = { name: "grounded_search", latency_ms: 0, provider: "google-grounding" };
      return await secondPass(io, deps, t0, "web-search", GROUNDED_SENTINEL, [p1Stage, groundedStage], pass1, provider, modelId, context, sessionId, retain, route, true);
    }
    const tFetch = Date.now();
    let search;
    try {
      search = await io.runWebSearch(queryStr, token);
    } catch (e) {
      return errorTurn(
        t0,
        { error: `Web search failed: ${e.message}`, latency_ms: pass1.latency_ms },
        [p1Stage, { name: "fetch_search", latency_ms: Date.now() - tFetch, error: e.message }]
      );
    }
    const fetchStage = { name: "fetch_search", latency_ms: Date.now() - tFetch, result_count: search?.results?.length || 0, provider: search?.provider };
    await io.logWebSearch(token, {
      session_id: sessionId,
      provider: search?.provider || "unknown",
      query_length: queryStr.length,
      requested_count: 10,
      result_count: search?.result_count ?? search?.results?.length ?? 0,
      latency_ms: search?.latency ?? fetchStage.latency_ms,
      success: true
    });
    return await secondPass(io, deps, t0, "web-search", search, [p1Stage, fetchStage], pass1, provider, modelId, context, sessionId, retain, route);
  }
  if (p1Parsed.type === "info_request" && p1Parsed.tool === "home_assistant") {
    const entities = req.provided_context?.ha_entities;
    if (!entities) {
      await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1);
      return finalize({ t0, parsed: p1Parsed, raw: pass1.raw, stages: [p1Stage], usage: pass1.raw.usage, latency: pass1.latency_ms, unsupported_tool: "home_assistant", sessionId, route });
    }
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1);
    const commandHint = p1Parsed.query?.command_hint || req.text;
    return await secondPass(io, deps, t0, "home-assistant", { entities, command_hint: commandHint }, [p1Stage], pass1, provider, modelId, context, sessionId, retain, route);
  }
  if (p1Parsed.type === "info_request" && p1Parsed.tool === "sports") {
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1);
    const sportsQuery = typeof p1Parsed.query === "object" && p1Parsed.query ? p1Parsed.query : { team: req.text };
    if (req.timezone && sportsQuery.tz == null) sportsQuery.tz = req.timezone;
    {
      const t = String(sportsQuery.type ?? "").toLowerCase();
      if (sportsQuery.when == null && t === "schedule") sportsQuery.when = "next";
      if (sportsQuery.when == null && t === "score") sportsQuery.when = "last";
      delete sportsQuery.type;
      if (/\d{4}-\d{2}-\d{2}/.test(String(sportsQuery.date ?? ""))) sportsQuery.when = "date";
    }
    const teamless = !String(sportsQuery.team ?? "").trim();
    const wantsSlate = sportsQuery.list === true || teamless && sportsQuery.when == null;
    if (wantsSlate) sportsQuery.list = true;
    else if (teamless && sportsQuery.when == null) sportsQuery.when = "next";
    const tFetch = Date.now();
    let sports;
    try {
      sports = await io.runSports(sportsQuery, token);
    } catch (e) {
      return errorTurn(
        t0,
        { error: `Sports lookup failed: ${e.message}`, latency_ms: pass1.latency_ms },
        [p1Stage, { name: "fetch_sports", latency_ms: Date.now() - tFetch, error: e.message }]
      );
    }
    const fetchStage = { name: "fetch_sports", latency_ms: Date.now() - tFetch, result_count: sports?.games?.length || 0, provider: sports?.provider };
    await io.logSports(token, {
      session_id: sessionId,
      provider: sports?.provider || "unknown",
      query: JSON.stringify(sports?.query || sportsQuery || {}),
      result_count: sports?.games?.length || 0,
      latency_ms: sports?.latency ?? fetchStage.latency_ms,
      success: true
    });
    if ((sports?.games?.length || 0) === 0 && groundingAvailable) {
      return await secondPass(io, deps, t0, "sports", sports, [p1Stage, fetchStage], pass1, provider, modelId, context, sessionId, retain, route, true);
    }
    const cardForGames = () => {
      const n = sports?.games?.length ?? 0;
      if (n === 0) return void 0;
      if (wantsSlate && n !== 1) {
        return templateSlate(sports, sportsQuery, { timezone: req.timezone }).structured_data ?? void 0;
      }
      return templateSports(sports, sportsQuery, { timezone: req.timezone }).structured_data ?? void 0;
    };
    if ((sports?.games?.length || 0) > 0 && (wantsGameDetail(req.text) || !templateCanAnswer(req.text))) {
      return await secondPass(io, deps, t0, "sports", sports, [p1Stage, fetchStage], pass1, provider, modelId, context, sessionId, retain, route, false, cardForGames());
    }
    const synth = templateSports(sports, sportsQuery, { timezone: req.timezone });
    if ((wantsSlate || synth.fallback) && (sports?.games?.length ?? 0) !== 1) {
      const slate = templateSlate(sports, sportsQuery, { timezone: req.timezone });
      if (slate.structured_data) {
        const parsedSlate = { type: "response", voice: slate.voice, text: null, action: null };
        const slatePass = {
          ok: true,
          latency_ms: 0,
          raw: { content: slate.voice, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, model: "template", provider: "template" }
        };
        await logPass(
          io,
          deps,
          REQUEST_TYPE,
          req.endpoint_id,
          sessionId,
          "(sports slate template)",
          slatePass,
          retainFields(retain.serverPersist, retain.userText, slate.voice, null),
          turnMeta
        );
        return finalize({
          t0,
          parsed: parsedSlate,
          raw: pass1.raw,
          stages: [p1Stage, fetchStage],
          usage: pass1.raw?.usage,
          latency: pass1.latency_ms,
          structured_data: slate.structured_data ?? void 0,
          retain,
          sessionId,
          route
        });
      }
      return await secondPass(io, deps, t0, "sports", sports, [p1Stage, fetchStage], pass1, provider, modelId, context, sessionId, retain, route, false, cardForGames());
    }
    const parsed = { type: "response", voice: synth.voice, text: synth.text, action: null };
    const templatePass = {
      ok: true,
      latency_ms: 0,
      raw: { content: synth.voice, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, model: "template", provider: "template" }
    };
    await logPass(
      io,
      deps,
      REQUEST_TYPE,
      req.endpoint_id,
      sessionId,
      "(sports template)",
      templatePass,
      retainFields(retain.serverPersist, retain.userText, synth.voice, synth.text),
      turnMeta
    );
    return finalize({
      t0,
      parsed,
      raw: pass1.raw,
      stages: [p1Stage, fetchStage],
      usage: pass1.raw?.usage,
      latency: pass1.latency_ms,
      structured_data: synth.structured_data ?? void 0,
      retain,
      sessionId,
      route
    });
  }
  if (p1Parsed.type === "info_request" && p1Parsed.tool === "calendar_events") {
    if (!callerFulfills(req, "calendar")) {
      const declineVoice = "You don't have calendar access set up on this device yet.";
      const decline = { type: "response", voice: declineVoice, text: null, action: null };
      await logPass(
        io,
        deps,
        REQUEST_TYPE,
        req.endpoint_id,
        sessionId,
        p1Prompt,
        pass1,
        retainFields(retain.serverPersist, retain.userText, declineVoice, null),
        turnMeta
      );
      return finalize({
        t0,
        parsed: decline,
        raw: pass1.raw,
        stages: [p1Stage],
        usage: pass1.raw.usage,
        latency: pass1.latency_ms,
        retain,
        sessionId,
        route
      });
    }
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1, deviceFulfilledRetain(), turnMeta);
    return finalize({
      t0,
      parsed: p1Parsed,
      raw: pass1.raw,
      stages: [p1Stage],
      usage: pass1.raw.usage,
      latency: pass1.latency_ms,
      client_tool: { tool: "calendar", query: p1Parsed.query },
      sessionId,
      route
    });
  }
  if (p1Parsed.type === "info_request" && p1Parsed.tool === "calendar_write") {
    if (!voiceCalendarWrites) {
      const declineVoice = "Making calendar changes by voice is turned off. You can turn it on in Calendar settings.";
      const decline = { type: "response", voice: declineVoice, text: null, action: null };
      await logPass(
        io,
        deps,
        REQUEST_TYPE,
        req.endpoint_id,
        sessionId,
        p1Prompt,
        pass1,
        retainFields(retain.serverPersist, retain.userText, declineVoice, null),
        turnMeta
      );
      return finalize({
        t0,
        parsed: decline,
        raw: pass1.raw,
        stages: [p1Stage],
        usage: pass1.raw.usage,
        latency: pass1.latency_ms,
        retain,
        sessionId,
        route
      });
    }
    const caps2 = req.client_fulfilled_tools;
    if (!Array.isArray(caps2) || !caps2.includes("calendar_write")) {
      const declineVoice = "I can read the calendar here, but I can't make calendar changes from this device yet.";
      const decline = { type: "response", voice: declineVoice, text: null, action: null };
      await logPass(
        io,
        deps,
        REQUEST_TYPE,
        req.endpoint_id,
        sessionId,
        p1Prompt,
        pass1,
        retainFields(retain.serverPersist, retain.userText, declineVoice, null),
        turnMeta
      );
      return finalize({
        t0,
        parsed: decline,
        raw: pass1.raw,
        stages: [p1Stage],
        usage: pass1.raw.usage,
        latency: pass1.latency_ms,
        retain,
        sessionId,
        route
      });
    }
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1, deviceFulfilledRetain(), turnMeta);
    return finalize({
      t0,
      parsed: p1Parsed,
      raw: pass1.raw,
      stages: [p1Stage],
      usage: pass1.raw.usage,
      latency: pass1.latency_ms,
      client_tool: { tool: "calendar_write", query: p1Parsed.query },
      sessionId,
      route
    });
  }
  if (p1Parsed.type === "info_request" && p1Parsed.tool === "music") {
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1, deviceFulfilledRetain(), turnMeta);
    return finalize({
      t0,
      parsed: p1Parsed,
      raw: pass1.raw,
      stages: [p1Stage],
      usage: pass1.raw.usage,
      latency: pass1.latency_ms,
      client_tool: { tool: "music", query: p1Parsed.query },
      sessionId,
      route
    });
  }
  if (p1Parsed.type === "info_request" && p1Parsed.tool === "video_feeds") {
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1, deviceFulfilledRetain(), turnMeta);
    return finalize({
      t0,
      parsed: p1Parsed,
      raw: pass1.raw,
      stages: [p1Stage],
      usage: pass1.raw.usage,
      latency: pass1.latency_ms,
      client_tool: { tool: "video_feeds", query: p1Parsed.query },
      sessionId,
      route
    });
  }
  if (p1Parsed.type === "info_request" && p1Parsed.tool === "schedule_action") {
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1, deviceFulfilledRetain(), turnMeta);
    return finalize({
      t0,
      parsed: p1Parsed,
      raw: pass1.raw,
      stages: [p1Stage],
      usage: pass1.raw.usage,
      latency: pass1.latency_ms,
      client_tool: { tool: "schedule_action", query: p1Parsed.query },
      sessionId,
      route
    });
  }
  if (p1Parsed.type === "info_request" && p1Parsed.tool === "weather_data") {
    const wq = typeof p1Parsed.query === "object" && p1Parsed.query ? p1Parsed.query : {};
    if (io.getWeather && !callerFulfills(req, "weather")) {
      const loc = resolveWeatherLocation(wq, account.zipCode ?? null);
      let synthVoice;
      const tFetch = Date.now();
      let fetchStage;
      if (!loc) {
        synthVoice = "I don't know your location yet \u2014 add your zip code in settings and I can check the weather.";
        fetchStage = { name: "fetch_weather", latency_ms: 0, error: "no_location" };
      } else {
        try {
          const w = await io.getWeather(loc);
          synthVoice = templateWeather(weatherResultToReading(w), wq).voice;
          fetchStage = { name: "fetch_weather", latency_ms: Date.now() - tFetch, provider: w.provider };
        } catch (e) {
          synthVoice = "I couldn't get the weather right now.";
          fetchStage = { name: "fetch_weather", latency_ms: Date.now() - tFetch, error: e.message };
        }
      }
      const synth = { type: "response", voice: synthVoice, text: null, action: null };
      await logPass(
        io,
        deps,
        REQUEST_TYPE,
        req.endpoint_id,
        sessionId,
        p1Prompt,
        pass1,
        retainFields(retain.serverPersist, retain.userText, synthVoice, null),
        turnMeta
      );
      return finalize({
        t0,
        parsed: synth,
        raw: pass1.raw,
        stages: [p1Stage, fetchStage],
        usage: pass1.raw.usage,
        latency: pass1.latency_ms,
        retain,
        sessionId,
        route
      });
    }
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1, deviceFulfilledRetain(), turnMeta);
    return finalize({
      t0,
      parsed: p1Parsed,
      raw: pass1.raw,
      stages: [p1Stage],
      usage: pass1.raw.usage,
      latency: pass1.latency_ms,
      client_tool: { tool: "weather", query: p1Parsed.query },
      sessionId,
      route
    });
  }
  if (p1Parsed.type === "info_request" && p1Parsed.tool === "get_current_time") {
    const tRes = await currentTimeTool.execute({}, { timezone: req.timezone });
    const r = tRes?.result ?? {};
    const spoken = r.spoken || [r.date, r.time].filter(Boolean).join(", ") || "I couldn't determine the current time.";
    const parsed = { type: "response", voice: spoken, text: null, action: null };
    const templatePass = {
      ok: true,
      latency_ms: 0,
      raw: { content: spoken, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, model: "template", provider: "template" }
    };
    await logPass(
      io,
      deps,
      REQUEST_TYPE,
      req.endpoint_id,
      sessionId,
      "(current_time template)",
      templatePass,
      retainFields(retain.serverPersist, retain.userText, spoken, null),
      turnMeta
    );
    return finalize({
      t0,
      parsed,
      raw: pass1.raw,
      stages: [p1Stage],
      usage: pass1.raw?.usage,
      latency: pass1.latency_ms,
      retain,
      sessionId,
      route
    });
  }
  if (p1Parsed.type === "info_request" && p1Parsed.tool === "dashie_help") {
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1);
    const hq = typeof p1Parsed.query === "object" && p1Parsed.query ? String(p1Parsed.query.question ?? req.text) : typeof p1Parsed.query === "string" && p1Parsed.query ? p1Parsed.query : req.text;
    const tFetch = Date.now();
    const help = await dashieHelpTool.execute({ question: hq }, { timezone: req.timezone });
    const helpResult = help?.result ?? { found: false };
    const fetchStage = {
      name: "fetch_dashie_help",
      latency_ms: Date.now() - tFetch,
      result_count: helpResult.chunks?.length ?? 0
    };
    const helpData = helpResult.found ? helpResult : {
      found: false,
      note: "No product-documentation entry matched this question. Do NOT invent settings locations, steps, prices, or features. Say you are not sure about that one.",
      question: hq
    };
    return await secondPass(io, deps, t0, "dashie-help", helpData, [p1Stage, fetchStage], pass1, provider, modelId, context, sessionId, retain, route);
  }
  if (p1Parsed.type === "info_request" && p1Parsed.tool === "personalities") {
    await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1);
    const tFetch = Date.now();
    const choices = io.listPersonalities ? await io.listPersonalities(supabase) : await listAvailablePersonalities(supabase);
    const fetchStage = {
      name: "fetch_personalities",
      latency_ms: Date.now() - tFetch,
      result_count: choices.length
    };
    const catalogData = choices.length ? { found: true, current_personality: personality?.name ?? "Dashie", personalities: choices } : {
      found: false,
      note: "Could not read the personality list. Say you had trouble checking just now and to try again in a moment. Do NOT name personalities from memory and do NOT switch."
    };
    const pTurn = await secondPass(io, deps, t0, "personalities", catalogData, [p1Stage, fetchStage], pass1, provider, modelId, context, sessionId, retain, route);
    const enrichedRow = enrichSetPersonalityAction(pTurn.action, choices);
    const greeting = enrichedRow?.greeting_fallback?.trim();
    if (greeting) pTurn.voice = greeting;
    await restampVoiceForSwitch(io, supabase, voiceCtx, enrichedRow);
    return pTurn;
  }
  if (p1Parsed.type === "multi") {
    const stepsIn = p1Parsed.steps ?? [];
    if (stepsIn.length < 2) {
      await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1);
      const emptyMulti = { type: "response", voice: "", text: null, action: null };
      return finalize({ t0, parsed: emptyMulti, raw: pass1.raw, stages: [p1Stage], usage: pass1.raw.usage, latency: pass1.latency_ms, unsupported_tool: "multi", sessionId, route: "multi" });
    }
    const dispatch = await dispatchMultiTurn(stepsIn, {
      callGateway: io.callGateway,
      provider,
      modelId,
      context,
      userText: req.text,
      entities: req.provided_context?.ha_entities
    });
    await logPass(
      io,
      deps,
      REQUEST_TYPE,
      req.endpoint_id,
      sessionId,
      p1Prompt,
      pass1,
      retainFields(retain.serverPersist, retain.userText, typeof p1Parsed.voice === "string" ? p1Parsed.voice : "", null),
      turnMeta
    );
    const multiParsed = { type: "multi", voice: p1Parsed.voice, text: null, action: null };
    return finalize({
      t0,
      parsed: multiParsed,
      raw: pass1.raw,
      stages: [p1Stage, ...dispatch.stages],
      usage: sumUsage([pass1.raw.usage, dispatch.usage]),
      latency: pass1.latency_ms + dispatch.latencyMs,
      retain,
      sessionId,
      route: "multi",
      steps: dispatch.steps
    });
  }
  console.warn(`[orchestrator] DROP: pass-1 routed to unsupported tool '${p1Parsed.tool}' \u2014 falling back to caller's native path`);
  await logPass(io, deps, REQUEST_TYPE, req.endpoint_id, sessionId, p1Prompt, pass1);
  return finalize({ t0, parsed: p1Parsed, raw: pass1.raw, stages: [p1Stage], usage: pass1.raw.usage, latency: pass1.latency_ms, unsupported_tool: p1Parsed.tool, sessionId, route });
}
function routeOf(parsed) {
  if (!parsed) return "direct";
  if (parsed.type === "response") return "direct";
  if (parsed.type === "action") return "action";
  if (parsed.type === "multi") return "multi";
  if (parsed.type === "info_request") return parsed.tool || "unknown";
  return "direct";
}
async function secondPass(io, deps, t0, inquiryType, retrievedData, priorStages, pass1, provider, modelId, context, sessionId, retain, route, grounding = false, card2 = void 0) {
  const prompt = buildPrompt({ userRequest: deps.req.text, inquiryType, retrievedData, context });
  deps.onStage?.({ stage: "synthesizing", status: "Finalizing", elapsed_ms: Date.now() - t0 });
  const kind = inquiryType === "home-assistant" ? "decide" : "narrate";
  const pass2 = await io.callGateway({ provider, prompt, modelId, grounding, kind });
  if (!pass2.ok || !pass2.raw) {
    return errorTurn(t0, pass2, [...priorStages, stageErr("pass2", pass2)]);
  }
  let parsed = parseContent(pass2.raw.content);
  if (inquiryType === "home-assistant" && parsed && parsed.type === "info_request") {
    const recovered = recoverHaAction(parsed);
    if (recovered) parsed = recovered;
  }
  const jsonish = /^\s*(```[a-z]*\s*)?[{[]/i.test(pass2.raw.content || "");
  if (parsed && parsed.type === "info_request" || !parsed && jsonish) {
    console.warn(`\u26A0\uFE0F pass2 non-terminal (${parsed?.type ?? "unparsed JSON-ish"}) \u2014 clarifying instead of leaking`);
    const clarifyVoice = "Sorry, I didn't quite catch that \u2014 could you say it again?";
    parsed = { type: "response", voice: clarifyVoice, text: null, action: null };
  }
  await logPass(
    io,
    deps,
    REQUEST_TYPE,
    deps.req.endpoint_id,
    sessionId,
    prompt,
    pass2,
    retainFields(retain.serverPersist, retain.userText, responseTextOf(parsed, pass2.raw), parsed?.text ?? null),
    toolMeta(parseContent(pass1.raw?.content ?? ""), route, context?.caps)
  );
  const p2Stage = passStage("pass2", pass2, parsed?.type);
  const usage = sumUsage([pass1.raw?.usage, pass2.raw.usage]);
  const imageHint = parsed?.image;
  const imageCard = inquiryType === "web-search" && context?.retrievePicturesEnabled !== false && parsed?.type === "response" && imageHint?.searchTerms ? await resolveImageHint(parsed, deps.token, sessionId, io.toolConn) : void 0;
  return finalize({ t0, parsed, raw: pass2.raw, stages: [...priorStages, p2Stage], usage, latency: pass1.latency_ms + pass2.latency_ms, retain, sessionId, route, structured_data: card2 ?? imageCard ?? void 0 });
}
function promisedPictureQuery(voice, userText) {
  const v = String(voice || "");
  const promises = /\b(?:picture|photo|image|pic)s?\s+of\b/i.test(v) || // "a picture of X"
  /\b(?:here'?s?|here is)\b[^.!?]*\b(?:picture|photo|image|pic|one)\b/i.test(v) || // "here's a picture/one"
  /\bhere (?:he|she|it|they) (?:is|are)\b/i.test(v) || // "here he is"
  /\btake a look\b/i.test(v);
  if (!promises) return null;
  const m = v.match(/\b(?:picture|photo|image|pic)s?\s+of\s+(?:a |an |the )?([A-Za-z0-9][\w' -]{1,60}?)(?:[.,!?;:]|\s+(?:for you|right here|here)\b|$)/i);
  let subject = m?.[1]?.trim();
  if (!subject) {
    subject = String(userText || "").replace(/^(?:hey dashie[,\s]*)?(?:can you |could you |please |will you )?(?:show me|show us|pull up|find|display|get me|let me see|i want to see|can i see)\s+/i, "").replace(/\b(?:a |an |the )?(?:picture|photo|image|pic)s?\s+of\s+(?:a |an |the )?/i, "").replace(/[?.!]+$/, "").trim();
  }
  subject = subject.replace(/\b(?:please|for me|right now)\b/gi, "").replace(/\s+/g, " ").trim();
  return subject && subject.length >= 2 ? subject : null;
}
async function resolveImageHint(parsed, token, sessionId, conn) {
  const hint = parsed?.image;
  if (!hint?.searchTerms) return void 0;
  try {
    let synth = await synthesizeImage(hint.searchTerms, hint.criteria, { ...conn, jwt: token, sessionId });
    if (!synth.card && hint.fallback && hint.fallback !== hint.searchTerms) {
      synth = await synthesizeImage(hint.fallback, hint.criteria, { ...conn, jwt: token, sessionId });
    }
    return synth.card ?? void 0;
  } catch (_e) {
    return void 0;
  }
}
function responseTextOf(parsed, raw) {
  return parsed?.voice || raw.content || "";
}
function finalize({ t0, parsed, raw, stages, usage, latency, unsupported_tool, retain, sessionId, route, structured_data, client_tool, metadata, steps }) {
  const type = parsed?.type || "response";
  const callerRetain = !!retain?.callerRetain && !unsupported_tool && (type === "response" || type === "action");
  const isToolCall = type === "info_request" || type === "multi";
  const salvage = parsed ? "" : raw.content;
  return {
    ok: true,
    type,
    voice: parsed?.voice || (isToolCall ? "" : salvage) || "",
    text: parsed?.text ?? null,
    action: parsed?.action ?? null,
    parsed_ok: !!parsed,
    raw_content: raw.content,
    usage: normalizeUsage(usage),
    model: raw.model || "",
    provider: raw.provider || "",
    latency_ms: latency,
    total_latency_ms: Date.now() - t0,
    unsupported_tool: unsupported_tool || void 0,
    client_tool: client_tool || void 0,
    route,
    steps: steps && steps.length ? steps : void 0,
    stages,
    // Echo the session id (== ai_interactions.session_id) so callers can join the
    // HA-local transcript to the Supabase usage rows in the console (§17).
    conversation_id: sessionId,
    metadata: callerRetain || metadata ? { ...metadata ?? {}, ...callerRetain ? { retain_transcript: true } : {} } : void 0,
    structured_data
  };
}
function insufficientCreditsTurn(t0, balance) {
  return {
    ok: true,
    type: "response",
    voice: "",
    text: null,
    action: null,
    parsed_ok: true,
    raw_content: "",
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    model: "",
    provider: "",
    latency_ms: 0,
    total_latency_ms: Date.now() - t0,
    route: "insufficient_credits",
    stages: [{ name: "insufficient_credits", latency_ms: 0 }],
    metadata: { degraded: "insufficient_credits", balance }
  };
}
function rateLimitedTurn(t0, retryAfterSeconds) {
  return {
    ok: true,
    type: "response",
    voice: "",
    text: null,
    action: null,
    parsed_ok: true,
    raw_content: "",
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    model: "",
    provider: "",
    latency_ms: 0,
    total_latency_ms: Date.now() - t0,
    route: "rate_limited",
    stages: [{ name: "rate_limited", latency_ms: 0 }],
    metadata: { degraded: "rate_limited", retry_after_seconds: retryAfterSeconds }
  };
}
function endIntentTurn(t0) {
  return {
    ok: true,
    type: "response",
    voice: "",
    text: null,
    action: null,
    parsed_ok: true,
    raw_content: "",
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    model: "",
    provider: "",
    latency_ms: 0,
    total_latency_ms: Date.now() - t0,
    route: "end_intent",
    stages: [{ name: "end_intent_shortcircuit", latency_ms: 0 }],
    metadata: { short_circuit: "end_intent", end_conversation: true }
  };
}
function noiseTurn(t0) {
  const msg = NOISE_REPLY;
  return {
    ok: true,
    type: "response",
    voice: msg,
    text: null,
    action: null,
    parsed_ok: true,
    raw_content: msg,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    model: "",
    provider: "",
    latency_ms: 0,
    total_latency_ms: Date.now() - t0,
    route: "noise",
    stages: [{ name: "noise_shortcircuit", latency_ms: 0 }],
    metadata: { short_circuit: "noise" }
  };
}
function errorTurn(t0, result, stages) {
  return {
    ok: false,
    type: "error",
    voice: "",
    text: null,
    action: null,
    parsed_ok: false,
    raw_content: "",
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    model: "",
    provider: "",
    latency_ms: result.latency_ms,
    total_latency_ms: Date.now() - t0,
    route: "error",
    stages,
    metadata: { error: result.error }
  };
}
function passStage(name, r, type) {
  return { name, latency_ms: r.latency_ms, model: r.raw?.model, provider: r.raw?.provider, usage: normalizeUsage(r.raw?.usage), type: type || "response" };
}
function stageErr(name, r) {
  return { name, latency_ms: r.latency_ms, error: r.error };
}
function sumUsage(usages) {
  const total = { input_tokens: 0, output_tokens: 0, total_tokens: 0, reasoning_tokens: 0 };
  for (const u of usages) {
    if (!u) continue;
    total.input_tokens += u.input_tokens || 0;
    total.output_tokens += u.output_tokens || 0;
    total.total_tokens += u.total_tokens || 0;
    total.reasoning_tokens = (total.reasoning_tokens || 0) + (u.reasoning_tokens || 0);
  }
  return total;
}
function normalizeUsage(u) {
  return {
    input_tokens: u?.input_tokens || 0,
    output_tokens: u?.output_tokens || 0,
    total_tokens: u?.total_tokens || (u?.input_tokens || 0) + (u?.output_tokens || 0),
    reasoning_tokens: u?.reasoning_tokens || 0
  };
}
function formatHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return "";
  const lines = history.slice(-4).map((h) => `${h.role === "user" ? "User" : "You"}: ${h.text || ""}`);
  return `Recent conversation:
${lines.join("\n")}
`;
}
async function logPass(io, deps, requestType, endpointId, sessionId, prompt, pass, retainText = {}, meta = {}) {
  const usage = pass.raw?.usage || {};
  const trace = meta.tool_trace;
  const logMeta = trace && trace.args != null ? { ...meta, tool_trace: { ...trace, args: await redactToolArgs(trace.args) } } : meta;
  const isTemplate = pass.raw?.provider === "template";
  const parsed = parseContent(pass.raw?.content ?? "");
  const parsedOk = isTemplate ? null : !!parsed;
  const route = logMeta.tool_trace?.route ?? meta.tool_trace?.route;
  const isAnswerRow = isTemplate || parsed?.type === "response" || parsed?.type === "action" || !!route;
  const missClass = isAnswerRow ? classifyMiss(route, parsed?.voice ?? (isTemplate ? pass.raw?.content ?? null : null)) : { miss: null, reason: null };
  await io.logInteraction(deps.token, {
    parsed_ok: parsedOk,
    miss: missClass.miss,
    miss_reason: missClass.reason,
    session_id: sessionId,
    request_type: requestType,
    request_length: prompt.length,
    model: pass.raw?.model || "unknown",
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    total_tokens: usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0),
    api_latency_ms: pass.raw?.latency || 0,
    total_latency_ms: pass.latency_ms,
    success: true,
    endpoint_id: endpointId,
    // Transcript text (§17): present only on a terminal pass when serverPersist is on.
    ...retainText,
    ...logMeta
  });
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  if (io.debitAiUsage && (inTok || outTok)) {
    await io.debitAiUsage(deps.supabase, deps.userId, {
      model: pass.raw?.model || "unknown",
      inputTokens: inTok,
      outputTokens: outTok,
      requestType,
      sessionId
    });
  }
}
function toolMeta(parsed, route, caps) {
  const tool = (parsed?.type === "info_request" ? parsed.tool : null) ?? null;
  const args = (parsed?.type === "info_request" ? parsed.query : null) ?? null;
  return { tool_used: tool, response_type: parsed?.type ?? null, tool_trace: { route, tool, args, ...caps ? { caps } : {} } };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  looksLikeSportsAsk,
  promisedPictureQuery,
  resolvePersonality,
  runOrchestration,
  runSports,
  templateCanAnswer,
  wantsGameDetail
});
module.exports.BRAIN_SOURCE_SHA = "cd66dfd905ec69d58ef053c8b9801d2fac1b9a2d";
