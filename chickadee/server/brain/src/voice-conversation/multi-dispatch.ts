// multi-dispatch.ts — fan a normalized `{type:'multi', steps:[…]}` turn out to each step's
// existing per-tool fulfillment, then return the RESOLVED steps for the client to run.
//
// The pass-1 emission + the normalizer (multi.ts) guarantee what arrives here: >= 2 steps, every
// tool in ACTION_TOOLS (home_assistant | music | video_feeds), no tool repeats. This module just
// fulfills each:
//   - home_assistant → resolve entities SERVER-SIDE via the same pass-2 the single-tool HA path
//     runs (a temp-0 decide call → an `execute_commands` action). Needs provided ha_entities;
//     absent → the step is marked unsupported (the caller falls back to its native HA path).
//   - music / video_feeds → a `client_tool` the device fulfills locally (no model pass), identical
//     to the single-tool device-fulfilled branches.
// The orchestrator wraps the result in ONE Turn (type 'multi', the model's single `voice`, and
// Turn.steps) — see the `p1Parsed.type === 'multi'` branch.
//
// Scope + compat: capability-gated upstream (buildPrompt only emits multi when the caller declared
// `multi`), so an old client never receives a multi envelope and this module never runs for it.

import { buildPrompt } from './prompt.ts';
import { parseContent } from './parse.ts';
import type { GatewayRaw, GatewayResult } from './gateway.ts';
import type { HaEntity, MultiStep, ParsedResponse, Stage, TurnStep, Usage } from './types.ts';

/** The pass-2 gateway call, narrowed to what dispatch needs (mirrors OrchestratorIO.callGateway).
 *  Injected rather than importing the whole IO so this module has no dependency on orchestrator. */
type CallGatewayFn = (args: {
  provider: string;
  prompt: string;
  modelId: string;
  grounding?: boolean;
  kind?: 'decide' | 'narrate';
  temperature?: number;
  thinkingBudget?: number;
}) => Promise<GatewayResult>;

export interface MultiDispatchDeps {
  callGateway: CallGatewayFn;
  provider: string;
  modelId: string;
  // The PromptContext passed to buildPrompt (personality, deviceArea, timezone, …). `unknown` to
  // match the orchestrator's own loosely-typed `context` object without re-importing its shape.
  context: unknown;
  userText: string;            // req.text — fallback command_hint when a step omits its query
  entities?: HaEntity[];       // provided_context.ha_entities for home_assistant resolution
}

export interface MultiDispatchResult {
  steps: TurnStep[];
  stages: Stage[];             // one pass-2 stage per home_assistant step resolved
  usage: Usage;                // summed HA pass-2 usage (music/video_feeds add none)
  latencyMs: number;           // summed HA pass-2 gateway latency
}

const ZERO_USAGE: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

function addUsage(a: Usage, u: GatewayRaw['usage']): Usage {
  const b = u ?? {};
  return {
    input_tokens: a.input_tokens + (b.input_tokens ?? 0),
    output_tokens: a.output_tokens + (b.output_tokens ?? 0),
    total_tokens: a.total_tokens + (b.total_tokens ?? 0),
    reasoning_tokens: (a.reasoning_tokens ?? 0) + (b.reasoning_tokens ?? 0),
  };
}

/**
 * Fix C, shared with the single-tool HA pass — lift HA commands out of a mis-enveloped pass-2 reply
 * into the terminal action shape. Models sometimes RE-EMIT the tool request
 * ({type:'info_request', tool:'home_assistant', query:{commands:[…]}}) instead of {type:'action'};
 * the commands are correct, only the envelope is wrong. Scoped to the HA pass (its only valid
 * terminal output IS an action) → safe, deterministic, model-agnostic. Returns null when no usable
 * commands are present (→ genuine clarify). Each command must name a domain + service, so we never
 * actuate an empty/garbage payload.
 */
export function recoverHaAction(parsed: NonNullable<ReturnType<typeof parseContent>>): ReturnType<typeof parseContent> | null {
  const p = parsed as Record<string, unknown>;
  const query = (p.query ?? {}) as Record<string, unknown>;
  const params = ((p.parameters ?? (p.action as Record<string, unknown> | undefined)?.parameters) ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(query.commands) ? query.commands
    : Array.isArray(params.commands) ? params.commands
    : Array.isArray(p.commands) ? p.commands
    : null;
  if (!raw) return null;
  const commands = raw.filter((c): c is Record<string, unknown> =>
    !!c && typeof c === 'object' && typeof (c as Record<string, unknown>).domain === 'string' && typeof (c as Record<string, unknown>).service === 'string');
  if (commands.length === 0) return null;
  const voice = typeof parsed.voice === 'string' && parsed.voice ? parsed.voice : 'Done.';
  return {
    type: 'action', voice, text: null,
    action: { category: 'homeassistant', command: 'execute_commands', parameters: { commands } },
  } as ReturnType<typeof parseContent>;
}

/** Resolve one home_assistant step into a native action via the same temp-0 decide pass the
 *  single-tool HA path uses. Returns the action (or null if the model didn't produce one) plus the
 *  pass-2 stage + usage + latency to fold into the turn. */
async function resolveHaStep(
  step: MultiStep,
  deps: MultiDispatchDeps,
): Promise<{ action: ParsedResponse['action'] | null; stage: Stage; usage: Usage; latencyMs: number } | { error: string }> {
  const commandHint = (step.query as Record<string, unknown> | undefined)?.command_hint;
  const hint = typeof commandHint === 'string' && commandHint.trim() ? commandHint : deps.userText;
  // Scope the HA pass-2 to THIS step's command — NOT the whole compound utterance. Passing the
  // full "dim the light AND play some jazz" as USER_REQUEST made the model see the music half it
  // can't fulfill and THRASH (~3600 thought tokens / ~20s, and a dropped action) instead of just
  // resolving the light. The step's command_hint is the HA-only request; use it for both
  // USER_REQUEST (base context) and COMMAND_HINT (the HA template) so nothing off-tool leaks in.
  // Drop conversation history too — HA entity resolution maps a command to entity_ids; the prior
  // turns ("that song" = Clair de Lune…) are noise that pushed the model to over-deliberate (and
  // dropped the action in the anaphoric-compound repro). The anaphora is already resolved by the
  // music step's query; the HA step only needs the command + entities.
  const haContext = { ...(deps.context as Record<string, unknown>), chatHistory: '' };
  const prompt = buildPrompt({
    userRequest: hint,
    inquiryType: 'home-assistant',
    retrievedData: { entities: deps.entities ?? [], command_hint: hint },
    context: haContext as never,
  });
  // HA resolution EMITS AN ACTION — a decision, not narration → decide (temp 0), like secondPass.
  const pass2 = await deps.callGateway({ provider: deps.provider, prompt, modelId: deps.modelId, kind: 'decide' });
  if (!pass2.ok || !pass2.raw) return { error: pass2.error || 'ha pass-2 failed' };
  let parsed = parseContent(pass2.raw.content);
  if (parsed && parsed.type === 'info_request') {
    const recovered = recoverHaAction(parsed);
    if (recovered) parsed = recovered;
  }
  const action = parsed?.action ?? null;
  const usage = addUsage({ ...ZERO_USAGE }, pass2.raw.usage);
  const stage: Stage = {
    name: 'pass2_multi_ha',
    latency_ms: pass2.latency_ms,
    model: pass2.raw.model,
    provider: pass2.raw.provider,
    usage,
    type: parsed?.type,
  };
  return { action, stage, usage, latencyMs: pass2.latency_ms };
}

/**
 * Dispatch every step. `steps`/`voice` come straight from the normalized multi envelope
 * (multi.ts guarantees the shape). Order is preserved so the device runs them in the spoken order.
 */
export async function dispatchMultiTurn(
  steps: MultiStep[],
  deps: MultiDispatchDeps,
): Promise<MultiDispatchResult> {
  const out: TurnStep[] = [];
  const stages: Stage[] = [];
  let usage: Usage = { ...ZERO_USAGE };
  let latencyMs = 0;

  for (const step of steps) {
    if (step.tool === 'home_assistant') {
      // Server-resolve only when the caller supplied entities; else fall back to the native HA path.
      if (!deps.entities || deps.entities.length === 0) {
        out.push({ tool: 'home_assistant', unsupported_tool: 'home_assistant' });
        continue;
      }
      const res = await resolveHaStep(step, deps);
      if ('error' in res) {
        // A failed HA pass-2 doesn't sink the whole turn — mark this leg unsupported, keep the rest.
        out.push({ tool: 'home_assistant', unsupported_tool: 'home_assistant' });
        continue;
      }
      stages.push(res.stage);
      usage = addUsage(usage, res.usage);
      latencyMs += res.latencyMs;
      if (res.action) out.push({ tool: 'home_assistant', action: res.action });
      else out.push({ tool: 'home_assistant', unsupported_tool: 'home_assistant' });
      continue;
    }
    // music / video_feeds — device-fulfilled, no model pass (same as the single-tool branches).
    if (step.tool === 'music' || step.tool === 'video_feeds') {
      out.push({ tool: step.tool, client_tool: { tool: step.tool, query: step.query } });
      continue;
    }
    // Any other tool shouldn't reach here (normalizeMultiEnvelope drops non-ACTION_TOOLS), but be
    // defensive: surface it as unsupported rather than silently dropping it.
    out.push({ tool: step.tool, unsupported_tool: step.tool });
  }

  return { steps: out, stages, usage, latencyMs };
}
