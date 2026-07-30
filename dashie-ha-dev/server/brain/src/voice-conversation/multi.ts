// multi.ts — normalize the compound `{type:'multi', voice, steps:[…]}` envelope.
//
// Scope is multi-ACTION: N device "do" commands in one turn, one spoken confirmation, no
// synthesis. Action+question ("dim the lights and what's the weather") is DEFERRED — it needs a
// data fetch composed with spoken synthesis, which is a separate job.
//
// WHY THIS EXISTS RATHER THAN A PROMPT RULE
// The 2026-07-16 feasibility spike (RESULTS §"Multi-tool feasibility spike") measured two defects
// that a prompt cannot fix, because it asked for exactly these things and was ignored:
//   1. The deferral leaks. "dim the lights and what is the weather?" produced a multi in 13/15
//      samples DESPITE an explicit "do NOT use multi for a question" rule — including gemini at
//      3/5. Gemini being FLAKY here is why a model allowlist can't save us: there is no model to
//      gate to. (Its plan is a defensible reading of the request; it's only wrong against our
//      scoping choice — so we enforce the choice here.)
//   2. qwen3-30b over-decomposes 5/5 — one step per PHRASE, not per TOOL, emitting
//      multi[home_assistant + home_assistant] for "turn down the thermostat and dim the lights"
//      despite an explicit "ONE step per TOOL" rule.
// Both are mechanically detectable, so we detect them. Precedent: Fix C (`recoverHaAction`) is
// model-agnostic envelope recovery, not a prompt plea. Being model-agnostic also covers BYOK,
// where the user points the add-on at a brain we've never benchmarked.
//
// POST-CONDITION (the orchestrator may rely on all of it):
//   a returned `multi` has >= 2 steps, every step's tool is in ACTION_TOOLS, and no tool repeats.
//   Anything else is collapsed to a single `info_request` — or, only if nothing survives, to a
//   `multi` with `steps: []`, which the orchestrator MUST route to its error path and MUST NOT
//   voice (speaking `voice` there would confirm work we never did).

import type { ParsedResponse } from './types.ts';

/**
 * Device-fulfilled "do" tools — the multi-action scope. A step outside this set is a QUESTION
 * (it needs a gather + spoken answer) and is dropped per the deferral.
 *
 * ⚠️ Spelled as the PROMPT spells them (`home_assistant`, not the wire's `homeassistant`) —
 * these are matched against `step.tool`, which the model copies from the prompt's tools list.
 *
 * `music` is here because its multi-relevant actions are transport/play. Its `now_playing` action
 * is really a question ("what song is this"), but "play jazz and what song is this" is incoherent
 * as a request, so we don't split music by action — known and deliberate.
 */
export const ACTION_TOOLS = new Set(['home_assistant', 'music', 'video_feeds']);

export interface MultiStep {
  tool: string;
  query?: unknown;
}

/** A step is structurally usable if it names a tool. An UNKNOWN tool name is left alone here —
 *  it falls through to the orchestrator's existing `unsupported_tool` path rather than being
 *  silently swallowed, which is how a hallucinated tool stays visible. */
function validSteps(raw: unknown): MultiStep[] {
  if (!Array.isArray(raw)) return [];
  const out: MultiStep[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const tool = (s as Record<string, unknown>).tool;
    if (typeof tool !== 'string' || !tool.trim()) continue;
    out.push({ tool: tool.trim(), query: (s as Record<string, unknown>).query });
  }
  return out;
}

/**
 * Fold steps that share a tool into one, preserving first-seen order (defect 2).
 *
 * The only field worth merging is `command_hint` — it's what home_assistant's pass-2 reads to
 * resolve entities, and joining the hints reconstructs exactly the request the model should have
 * emitted as one step ("turn down the thermostat" + "dim the lights" → "turn down the thermostat
 * and dim the lights"). Other tools' queries (music's action/uri, video_feeds' camera) can't be
 * meaningfully combined — two different music actions in one turn is incoherent — so the first
 * wins and the rest are dropped.
 */
function mergeSameTool(steps: MultiStep[]): MultiStep[] {
  const byTool = new Map<string, MultiStep>();
  for (const step of steps) {
    const seen = byTool.get(step.tool);
    if (!seen) {
      byTool.set(step.tool, { ...step });
      continue;
    }
    const a = seen.query as Record<string, unknown> | undefined;
    const b = step.query as Record<string, unknown> | undefined;
    const aHint = a && typeof a.command_hint === 'string' ? a.command_hint.trim() : '';
    const bHint = b && typeof b.command_hint === 'string' ? b.command_hint.trim() : '';
    if (aHint && bHint) {
      seen.query = { ...a, command_hint: `${aHint} and ${bHint}` };
    } else if (!aHint && bHint) {
      seen.query = { ...(a ?? {}), ...b };
    }
    // else: nothing mergeable — first step stands.
  }
  return [...byTool.values()];
}

/** Collapse to the ordinary single tool call. `query` may be undefined — the orchestrator already
 *  falls back to the original transcript in that case (see parse.ts's canonical-tool-call note). */
function toInfoRequest(step: MultiStep, voice: unknown): ParsedResponse {
  return {
    type: 'info_request',
    tool: step.tool,
    query: step.query,
    // Keep the model's spoken line ONLY as a processing message — a collapsed multi's `voice`
    // narrates work we're no longer all doing, so it must never be spoken as the confirmation.
    processing_message: typeof voice === 'string' ? voice : undefined,
  };
}

/**
 * Enforce the post-condition above. Returns `parsed` untouched for any non-multi envelope, so
 * this is safe to call on every parse (pass 2 included).
 */
export function normalizeMultiEnvelope(parsed: ParsedResponse): ParsedResponse {
  if (!parsed || parsed.type !== 'multi') return parsed;

  const steps = mergeSameTool(validSteps(parsed.steps));
  const actions = steps.filter((s) => ACTION_TOOLS.has(s.tool));

  // The good case: a genuine multi-ACTION turn. Question steps are dropped per the deferral —
  // dropping them (rather than answering) is exactly what ships today, so it is not a regression.
  if (actions.length >= 2) {
    return { type: 'multi', voice: parsed.voice, steps: actions };
  }

  // One action + N questions (the s-009 shape, 13/15 of samples): the action is the whole turn.
  // Byte-identical to today's behaviour, where pass-1 routes this to home_assistant alone.
  if (actions.length === 1) return toInfoRequest(actions[0], parsed.voice);

  // No actions at all — the model used multi for several QUESTIONS. Route the first, which is
  // what a single-tool pass-1 does with a compound question today.
  if (steps.length > 0) return toInfoRequest(steps[0], parsed.voice);

  // Nothing usable. Hand the orchestrator an empty multi for its error path; do NOT voice it.
  return { type: 'multi', voice: parsed.voice, steps: [] };
}
