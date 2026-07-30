// parse.ts — tolerant parse of the AI's JSON response.
//
// Ported VERBATIM from console-ai-client.js: _parseContent (256–285), _normalizeParsedShape
// (287–310), _repairTruncatedJson (318–348). Build plan §12 ("tolerant; never hard-fail the turn").
// Returns the parsed object or null; the caller sets parsed_ok = !!parsed and, on null, returns the
// raw text as a 'response'.

import type { ParsedResponse } from './types.ts';
import { normalizeMultiEnvelope } from './multi.ts';

export function parseContent(content: string): ParsedResponse | null {
  if (!content || typeof content !== 'string') return null;
  let body = content.trim();
  // Strip ```json ... ``` fences (both inline and newline-separated).
  body = body
    .replace(/^\s*```(?:json|JSON)?\s*\r?\n?/i, '')
    .replace(/\r?\n?\s*```\s*$/i, '')
    .trim();
  const firstBrace = body.indexOf('{');
  if (firstBrace > 0) body = body.slice(firstBrace);

  // Try as-is first.
  // deno-lint-ignore no-explicit-any
  let parsed: any = null;
  try { parsed = JSON.parse(body); } catch { /* fall through */ }

  // Strip trailing commas before } or ]. Common Gemini quirk.
  if (!parsed) {
    const cleaned = body.replace(/,(\s*[}\]])/g, '$1');
    try { parsed = JSON.parse(cleaned); } catch { /* fall through */ }
    if (!parsed) {
      // MULTI-EMISSION repair (2026-07-19, the kiosk-calendar silence): haiku's thrash mode
      // emits SEVERAL top-level objects (or an object + prose) in one turn — brace-balanced
      // overall, so the truncation repair returned the whole string and JSON.parse failed on
      // "unexpected token after JSON". Take the FIRST balanced top-level object (the actual
      // decision; the tail is elaboration/repeats) and shout about the tail so the thrash
      // stays visible in logs while the user still gets an answer.
      const first = firstBalancedObject(cleaned);
      if (first && first.length < cleaned.length) {
        try {
          parsed = JSON.parse(first);
          console.warn(`[parse] MULTI-EMISSION: took first balanced object (${first.length} of ${cleaned.length} chars) — model emitted trailing content`);
        } catch { /* fall through to truncation repair */ }
      }
    }
    if (!parsed) {
      // Truncated response repair: trim to the last balanced brace.
      const repaired = repairTruncatedJson(cleaned);
      if (repaired) {
        try { parsed = JSON.parse(repaired); } catch { /* still null */ }
      }
    }
  }

  // normalizeMultiEnvelope is a no-op on every non-`multi` envelope, so it costs nothing on the
  // 95% single-tool path (and on pass 2, which never emits multi).
  return parsed ? normalizeMultiEnvelope(normalizeParsedShape(parsed)) : null;
}

/** Lenient normalization: `type: 'web_search'` (or any tool name) → canonical
 *  `type: 'info_request', tool: 'web_search'`. Gemini/OpenAI hit this when history
 *  primes them to treat the tool as the response type. */
// deno-lint-ignore no-explicit-any
function normalizeParsedShape(parsed: any): ParsedResponse {
  if (!parsed || typeof parsed !== 'object') return parsed;
  // Sanitize the spoken field for TTS (strip markdown + emoji). The `text`
  // (display) field is intentionally left UNTOUCHED so the tablet can still
  // render emphasis/emoji visually. Filter, not prompt — build plan §13.13a.
  if (typeof parsed.voice === 'string') parsed.voice = sanitizeVoice(parsed.voice);
  const KNOWN_TOOLS = new Set([
    'web_search', 'calendar_events', 'family_members', 'chores', 'rewards',
    'location_events', 'travel_time', 'family_locations', 'weather_data',
    'home_assistant', 'get_current_time', 'dashie_help', 'music',
    'schedule_action',
  ]);
  // Canonical tool call is `{type:'info_request', tool:'<known>'}`. Models (esp. Gemini/OpenAI,
  // when history primes them) emit two malformed variants instead — normalize both so the
  // orchestrator RUNS the tool (for Gemini → native grounding) rather than falling through to a
  // raw 'response' whose JSON gets read aloud:
  //   (a) `type:'<tool>'`          — the tool name used AS the response type
  //   (b) `{tool:'<tool>', query}` — a bare tool call with no (or a non-terminal) `type`
  // `query` may be absent — the orchestrator falls back to the original transcript.
  //
  // `multi` is terminal for the SAME reason the others are: a model that emits
  // `{type:'multi', tool:'music', steps:[…]}` (a stray top-level `tool` alongside the envelope)
  // would otherwise hit variant (b) and be rewritten to a single `info_request` for music —
  // silently discarding every other step. The multi envelope's shape is multi.ts's business.
  const TERMINAL_TYPES = new Set(['response', 'action', 'info_request', 'multi']);
  const tool =
    (parsed.type && KNOWN_TOOLS.has(parsed.type) && parsed.type !== 'info_request') ? parsed.type
    : (typeof parsed.tool === 'string' && KNOWN_TOOLS.has(parsed.tool) && !TERMINAL_TYPES.has(parsed.type)) ? parsed.tool
    : null;
  if (tool) {
    return {
      type: 'info_request',
      tool,
      query: parsed.query,
      context: parsed.context,
      processing_message: parsed.processing_message,
    };
  }
  return parsed;
}

/** True when a transcript is almost certainly a wake-word misfire / background
 *  noise rather than a real request: empty, or contains no letters in ANY script
 *  (pure punctuation/symbols/digits). High-precision on purpose — anything with
 *  letters (incl. non-Latin) passes through to the model, so legitimate short or
 *  non-English queries are never dropped. Lets the caller short-circuit before
 *  spending an AI call (build plan §13.13a; the model-facing half — "don't loop
 *  on a clarifying question" — lives in the prompt). */
export function isLikelyNoise(text: string): boolean {
  if (!text || typeof text !== 'string') return true;
  return !/\p{L}/u.test(text);
}

/** Strip markdown + emoji from text destined for TTS so the speech engine never
 *  reads "asterisk asterisk" or chokes on an emoji. Applied to the `voice` field
 *  only — `text` (display) keeps its formatting/emoji. Deterministic and
 *  model-independent (build plan §13.13a). */
export function sanitizeVoice(s: string): string {
  if (!s || typeof s !== 'string') return s;
  let out = s;
  // Links / images → keep the label, drop the URL.
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Code fences then inline code.
  out = out.replace(/```[\s\S]*?```/g, '');
  out = out.replace(/`([^`]+)`/g, '$1');
  // Emphasis: bold/italic (** __ * _) and strikethrough (~~).
  out = out.replace(/(\*\*|__)(.*?)\1/g, '$2');
  out = out.replace(/(\*|_)(.*?)\1/g, '$2');
  out = out.replace(/~~(.*?)~~/g, '$1');
  // Line-start markup: headers (#), blockquote (>), bullet/numbered list markers.
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  out = out.replace(/^\s{0,3}>\s?/gm, '');
  out = out.replace(/^\s*([-*+•]|\d+\.)\s+/gm, '');
  // Emoji / pictographs / dingbats / variation selectors / ZWJ / regional flags.
  out = out.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu,
    '',
  );
  // Collapse whitespace left behind by the removals.
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

/** The first balanced top-level {…} object in s (string-aware), or null when none closes.
 *  Multi-emission repair support — see parseContent. */
function firstBalancedObject(s: string): string | null {
  if (!s || s[0] !== '{') return null;
  let inString = false;
  let escape = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return s.slice(0, i + 1); }
  }
  return null;
}

/** Best-effort recovery of JSON truncated by max_tokens: track brace/bracket depth,
 *  ignore chars inside strings, trim to the longest balanced prefix, close open scopes.
 *  Won't recover an unfinished string field, but salvages truncation between fields. */
function repairTruncatedJson(s: string): string | null {
  if (!s || s[0] !== '{') return null;
  let inString = false;
  let escape = false;
  const stack: string[] = [];
  let validEnd = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
    // Mark valid end after a value-terminating char with a non-empty stack —
    // anything past this is mid-field and unparseable.
    if (stack.length > 0 && (ch === ',' || ch === '}' || ch === ']')) validEnd = i;
  }
  if (inString) return null;          // truncated inside a string — give up
  if (stack.length === 0) return s;   // already balanced; outer parse failed for another reason
  // Trim trailing comma if any (we may have stopped after one).
  let prefix = s;
  if (validEnd !== -1 && validEnd < s.length - 1) prefix = s.slice(0, validEnd + 1);
  prefix = prefix.replace(/,(\s*)$/, '$1');
  // Close all open scopes.
  const closers = stack.map((c) => (c === '{' ? '}' : ']')).reverse().join('');
  return prefix + closers;
}
