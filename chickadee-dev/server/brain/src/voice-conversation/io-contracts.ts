// io-contracts.ts — the SHAPES the brain core exchanges with its I/O layer.
//
// Why this file exists, and why it is separate from the modules that implement
// the I/O:
//
// The core (orchestrator + friends) never calls the network directly. It takes an
// `OrchestratorIO` and calls through it, so one core serves two runtimes: the
// Deno edge function binds the real Supabase-coupled impls (default-io.ts), and
// the Node add-on binds its own (chickadee-io.js). That seam is the whole
// dual-runtime contract — see README "Dual-runtime sync contract".
//
// But the core still needs the TYPES of what flows across that seam. Those types
// used to live inside the implementation modules (gateway.ts, gather.ts,
// logging.ts), which are Deno/Supabase-coupled and NOT published with the open
// brain. The core imported them with `import type`, which type-checks fine here —
// and then broke the published copy, because:
//
//   esbuild ERASES type-only imports, so they never appear in the metafile, and
//   sync-brain-bundle.sh derives the vendored file list FROM the metafile. Every
//   `import type` target was therefore silently never copied. The public brain
//   source shipped with 5 unresolvable modules and `deno check` failed with 10
//   errors — the first command a developer runs after cloning it.
//
// So the contract types live here, with the core that depends on them, and the
// implementation modules re-export them for their existing callers. Nothing about
// what we publish changed; the types were always the core's business.
//
// RULE: this file holds types ONLY — no imports of Deno/Supabase modules, no
// runtime code. It is published with the core, so anything added here is public.
// If a shape needs a secret, an env var, or a fetch, it does not belong here.

/** Raw payload the ai-gateway returns for one model call. */
export interface GatewayRaw {
  content: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; reasoning_tokens?: number };
  model?: string;
  provider?: string;
  latency?: number;
}

/** One model call's outcome, as the core sees it. `ok: false` carries `error`
 *  and the core degrades rather than throwing. */
export interface GatewayResult {
  ok: boolean;
  raw?: GatewayRaw;
  latency_ms: number;
  error?: string;
}

/** A web-search gather's results, normalized across providers. */
export interface WebSearchResult {
  provider: string;
  query: string;
  results: Array<{ title: string; url: string; snippet: string; age?: string }>;
  result_count: number;
  latency: number;
}

/** One turn's interaction record. Written fire-and-forget; the core never
 *  depends on the write succeeding. */
export interface LogData {
  session_id?: string | null;
  request_type: string;        // 'voice_conversation'
  request_length: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  response_type?: string | null;
  tool_used?: string | null;
  action_taken?: string | null;
  tool_trace?: Record<string, unknown> | null;   // {route, tool, args} — per-turn tool decision (analysis)
  // Did this pass's output satisfy the JSON contract? false = the parse failed and the turn
  // degraded to a raw 'response' (indistinguishable from a genuine direct answer without this).
  // null = a template pass (locally synthesized prose, no model JSON to parse).
  parsed_ok?: boolean | null;
  // WS-F.0a miss instrumentation. `miss`: true/false on an ANSWER row, null on a tool-call
  // (info_request) row — analysis excludes nulls from the miss-rate denominator. `miss_reason`:
  // the coarse server-knowable class ('noise' | 'no_intent'). Finer STT-side classes are derived
  // in analysis, not set here.
  miss?: boolean | null;
  miss_reason?: string | null;
  api_latency_ms?: number;
  total_latency_ms: number;
  success: boolean;
  endpoint_id?: string;        // per-endpoint attribution (build plan §11); persisted as ai_interactions.device_id
  [k: string]: unknown;
}

/** A web-search call's log record. */
export interface WebSearchLogData {
  session_id?: string | null;
  provider: string;            // ACTUAL provider the gateway used (e.g. 'tavily')
  query_length: number;
  requested_count?: number;
  result_count?: number;
  latency_ms?: number;
  success: boolean;
}

/** A sports tool call's log record. Sports is "included, not billed" — no
 *  deduction is written for it. */
export interface SportsLogData {
  session_id?: string | null;
  provider: string;            // ESPN / api-sports
  query?: string;
  result_count?: number;
  latency_ms?: number;
  success: boolean;
}
