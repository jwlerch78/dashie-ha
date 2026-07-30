/**
 * Shared tool contract.
 *
 * A "tool" is a pure function + a JSON schema — deliberately independent of:
 *   • WHO calls it: the cascade brain (voice-conversation), the Gemini Live relay
 *     (conversation-relay), the HTTP tool-gateway, or a future add-on like an
 *     HA-local conversation agent. They are all just adapters around this contract.
 *   • HOW its result is shown: execute() NEVER renders or speaks. It returns plain
 *     data the caller's model can voice, plus an OPTIONAL structured `card` that a
 *     channel renders if it can (a screen) or ignores if it can't (headless).
 *
 * Keep execute() free of transport/runtime assumptions (no WebSocket, no Deno-only
 * globals beyond fetch) and read everything it needs from [ToolContext] so the same
 * code runs in-process or behind the HTTP gateway.
 */

export interface ToolContext {
  /** Supabase project URL + anon key for calling sibling gateways (sports, etc.). */
  supabaseUrl: string;
  anonKey: string;
  /** End-user identity, when available (auth + per-user data tools). */
  jwt?: string;
  userId?: string;
  /** IANA timezone, e.g. "America/New_York" — tools format times in the user's zone. */
  timezone?: string;
  /** "City, ST" or zip — for location-aware tools. */
  location?: string;
  /** Conversation/turn id — billed tools forward it so usage rows group with the turn. */
  sessionId?: string | null;
}

/** Structured UI payload. `type` discriminates the renderer (e.g. "sports"). */
export interface ToolCard {
  type: string;
  [k: string]: unknown;
}

export interface ToolResult {
  /** What the model speaks/answers from. Plain + JSON-serializable. */
  result: unknown;
  /** Optional render payload; channels show it if able, else ignore. */
  card?: ToolCard | null;
  /** Tool punts to LLM synthesis (e.g. open-ended "what games are on?" lists). */
  fallback?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the args — the single source projected into every LLM dialect. */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
