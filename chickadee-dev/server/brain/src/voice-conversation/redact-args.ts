// redact-args.ts — free-text arg redaction for the LOGGED tool trace (Thread A #2,
// 20260710_VOICE_FEEDBACK_AND_IMPROVEMENT.md).
//
// ai_interactions.tool_trace is fleet-wide analysis metadata under the "Share Performance
// Data" consent — it must be clean-by-construction: STRUCTURED enum args (when/sport/league/
// time_range/…) pass verbatim; every OTHER string value (search strings, calendar keywords,
// member names, team names, HA command hints) is replaced with an equality-preserving token
//   [redacted:<hmac12>:<len>]
// so "same value re-asked" is still detectable without the content being readable. The full
// values remain available on the CONSENTED channels only: prompt_text (retain_transcripts)
// and voice_feedback down-vote snapshots — this module touches neither; it is applied in
// logPass() to the logged copy alone, never to the Turn returned to the device (client_tool
// queries must arrive intact to be fulfilled).
//
// Rules (allowlist, so a future new arg DEFAULTS to redacted):
//   • booleans / numbers / null pass through
//   • strings under an ALLOWLISTED key pass verbatim — unless suspiciously long (>40 chars),
//     which redacts anyway (a model stuffing free text into an enum field must not leak)
//   • ALL other strings → the redacted token (top-level string args too, e.g. web_search)
//   • arrays/objects recurse, preserving shape
//
// Hash = HMAC-SHA256(value) under the ARG_HASH_SALT secret, truncated to 12 hex chars —
// per-deployment salt so tokens aren't dictionary-reversible. No salt / no WebCrypto
// (browser bundle) → fail CLOSED: redact with an empty hash ("[redacted::<len>]").
//
// Pure + cross-runtime (Deno edge fn, Node eval shell, browser brain bundle): env access is
// guarded, crypto via globalThis.crypto.subtle only.

/** Arg keys whose values are structured enums/dates (tool-schemas.js TOOL_VALUES + sports
 *  `when`/`date` + the image trace's `resolved`) — safe to keep verbatim fleet-wide. */
const PASS_KEYS = new Set([
  'time_range', 'mode', 'timeframe', 'when', 'type', 'sport', 'league',
  'event_type', 'date', 'resolved',
]);

/** An allowlisted key's value longer than this is treated as free text and redacted. */
const MAX_ENUM_LEN = 40;

const encoder = new TextEncoder();

function readSalt(): string {
  try {
    // deno-lint-ignore no-explicit-any
    const d = (globalThis as any).Deno;
    if (d?.env?.get) return d.env.get('ARG_HASH_SALT') ?? '';
  } catch { /* env permission denied → no salt */ }
  try {
    // deno-lint-ignore no-explicit-any
    return (globalThis as any).process?.env?.ARG_HASH_SALT ?? '';
  } catch { /* not Node */ }
  return '';
}

// Import the HMAC key once per isolate (salt is deployment-static).
let keyPromise: Promise<CryptoKey | null> | null = null;
function hmacKey(): Promise<CryptoKey | null> {
  if (!keyPromise) {
    keyPromise = (async () => {
      const salt = readSalt();
      const subtle = globalThis.crypto?.subtle;
      if (!salt || !subtle) return null;   // fail closed: redact without a hash
      try {
        return await subtle.importKey(
          'raw', encoder.encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
        );
      } catch {
        return null;
      }
    })();
  }
  return keyPromise;
}

/** Test seam: reset the cached key so a test can vary the salt. */
export function _resetHmacKeyForTest(): void {
  keyPromise = null;
}

/** 12-hex-char HMAC-SHA256 of the value, or '' when no salt/crypto is available. */
async function hmac12(value: string): Promise<string> {
  const key = await hmacKey();
  if (!key) return '';
  try {
    const sig = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(value));
    return Array.from(new Uint8Array(sig).slice(0, 6))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return '';
  }
}

async function redactString(value: string): Promise<string> {
  return `[redacted:${await hmac12(value)}:${value.length}]`;
}

async function redactValue(key: string | null, value: unknown): Promise<unknown> {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (key !== null && PASS_KEYS.has(key) && value.length <= MAX_ENUM_LEN) return value;
    return await redactString(value);
  }
  if (Array.isArray(value)) {
    // Items inherit NO key — an array under a non-allowlisted key ("tags") redacts per item.
    return await Promise.all(value.map((v) => redactValue(null, v)));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = await redactValue(k, v);
    }
    return out;
  }
  return null;   // functions/symbols/etc. never belong in a log
}

/**
 * Redact a tool-trace `args` payload for logging. Never mutates the input (the same object
 * may be referenced by the Turn's client_tool). A top-level string (web_search's query) is
 * redacted like any other free-text value.
 */
export async function redactToolArgs(args: unknown): Promise<unknown> {
  return await redactValue(null, args);
}
