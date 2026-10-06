// ha-devices-block.ts — tell PASS 1 which smart-home devices and rooms this home has.
//
// WHY (Thread VH s6, 2026-10-02; John: "yes - let's do that"). Pass 1 decides the route and has
// never seen the home's entity list — only the home_assistant pass 2 does. With pass-1 thinking OFF
// (orchestrator.ts:859, shipped 20260717 for latency), Gemini answered "is the back door locked" /
// "what's the office temperature" from its own knowledge instead of routing: provider-direct on
// the deployed prompt, 30/32 direct (tools/voice-bench/h2h-inpractice/thinking-vs-temp-diagnostic.ts).
// Adding this block, thinking still off: HA questions routed 102/104 (was 70/104), and general
// questions that merely mention a device word stayed off home control 0/48 — pass1-names.ts,
// results/pass1-names-s6.txt. The block text and its position (immediately before the CRITICAL
// line) are EXACTLY what that probe measured; change either and re-measure.
//
// 📌 Server-side constant, not a js/ai/prompts .md, on the same reasoning as the sports/calendar
// blocks in prompt.ts: the .md sources regenerate into the console repos, and this block is
// data-driven per turn anyway. Aliases are listed only when the entity HAS them, so the bench
// household (no aliases) renders byte-identically to the measured arm.
//
// Pure + dual-runtime (Deno edge + Node add-on): no Deno.*, no imports beyond types.

import type { HaEntity } from './types.ts';

const CRITICAL_ANCHOR = 'CRITICAL: Respond ONLY with raw JSON';

// 20261002 (VH s8): the block alone turned overheard people-talk into a clarifying question —
// "Is that Dave? Okay. Good. Did he bring it?" got "I'm not sure what 'it' refers to…" 15/16 vs 6/16
// without the block (pass1-chatter.ts, p=0.001), which leaves the mic open on a bystander. This one
// sentence took it to 0/16 with routing 38/39 and over-routing 0/12 unchanged, and held-out chatter
// 8/16 → 5/16 (pass1-chatter-fix.ts, results/pass1-chatter-fix.json). Its example deliberately shares
// no words with any test line. Change the wording and re-measure.
const OVERHEARD_RULE =
  'Not everything you hear is a request to you. If the speech is people talking to each other — half of a ' +
  "conversation, with \"he\", \"she\" or \"it\" pointing at something nobody told you about (for example \"Did you " +
  "find where she left the car keys? Okay, never mind.\") — it is overheard, not a question about this home: reply only " +
  'with "Sorry, I didn\'t catch that." Do NOT ask a clarifying question.';

function deviceLine(e: HaEntity): string {
  const name = e.friendly_name || e.entity_id;
  const also = e.aliases?.length ? ` (also called: ${e.aliases.join(', ')})` : '';
  return `- ${name}${also} — ${e.domain} — ${e.area ?? 'no room'}`;
}

export function haDevicesBlock(entities: HaEntity[]): string {
  return `## Devices in this home
These are the user's smart-home devices (name — type — room). You cannot see their state here, but the home_assistant tool can.
${entities.map(deviceLine).join('\n')}

Any question about the current state of one of these devices or rooms ("is the back door locked", "what's the office temperature", "which lights are on in the kitchen"), and any command to one of them, is an info_request with tool: "home_assistant". Never answer those from your own knowledge — you do not know this home's current state. A general question that merely mentions a device TYPE ("what's a good dehumidifier brand") is NOT about this home.
${OVERHEARD_RULE}

`;
}

/** Insert the block immediately before the pass-1 CRITICAL line. No entities → prompt unchanged.
 *  Anchor missing → append at the end with a loud DROP marker (standing rule 2): the routing hint
 *  still reaches the model, but at an unmeasured position, and the log says so. */
export function injectHaDevices(prompt: string, entities: HaEntity[] | undefined): string {
  if (!entities?.length) return prompt;
  const block = haDevicesBlock(entities);
  const at = prompt.indexOf(CRITICAL_ANCHOR);
  if (at < 0) {
    console.warn('DROP: ha-devices block anchor (CRITICAL line) not found in pass-1 prompt — appended at the END, an UNMEASURED position');
    return `${prompt}\n\n${block}`;
  }
  return prompt.slice(0, at) + block + prompt.slice(at);
}
