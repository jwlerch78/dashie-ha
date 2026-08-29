// bench-override.ts — the ONE place that decides whether a request may layer a foreign system
// prompt onto Dashie's own. Thread V, 2026-08-28. Design of record: V-status s4 cont.1.
//
// WHY THIS EXISTS
// Unit ①'s head-to-head could compare community prompts only PROVIDER-DIRECT (prompt-probe /
// household-probe build the prompt locally and call Gemini themselves). That leaves end-to-end
// latency unmeasurable: `run.ts` reaches the deployed brain but has no way to say "and layer THIS
// prompt". This module is the narrow, gated hole that closes that gap on staging.
//
// WHAT IT IS NOT
// It is not a user-facing "bring your own prompt" feature. Unit ① measured what layering a
// community prompt does to a screened device: EOC populates the on-screen `text` field 0 of 12
// times. Shipping this to real households would hand them a working way to silently disable their
// own screen. Four independent gates exist so that outcome cannot happen by one mistake.
//
// 🔴 THE GATES ARE FAIL-CLOSED AND ORDER MATTERS. Absence of configuration is the off-switch:
// production is never given the secret, so the feature does not exist there — nobody has to
// remember to disable it.

/** Staging project ref. Hard-coded ON PURPOSE (gate 3): gate 1 already keeps prod off, but a
 *  secret pasted into the wrong project must not be sufficient on its own. Two independent things
 *  must both be wrong before a foreign prompt can reach a real household. */
const STAGING_PROJECT_REF = 'cwglbtosingboqepsmjk';

/** Bounds the field so it cannot become an unbounded injection surface. The largest arm in unit ①
 *  (NickM-27, 91 lines) is well under 4 KB. */
const MAX_PREFIX_BYTES = 8192;

/**
 * Read an env var without requiring `--allow-env`.
 *
 * 🔴 This is a FAIL-CLOSED read, not a convenience wrapper. A `PermissionDenied` means we cannot
 * verify what environment we are in — and "cannot verify" must never resolve to "allow". Returning
 * undefined sends the caller into gate 1's refusal path, which is the correct answer to an
 * unverifiable environment.
 *
 * It also keeps the orchestrator's unit suite runnable with no permissions, which is the existing
 * convention here (335 tests, no flags). Reading env unguarded broke 116 of them at authorship —
 * the tests were right and the code was wrong.
 */
export function readEnvSafe(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

export interface BenchOverrideDecision {
  /** The prefix to layer, or '' when the override is refused (the overwhelmingly common case). */
  prefix: string;
  /** True only when a foreign prompt is actually being layered. Callers MUST propagate this to the
   *  persisted turn — see the tagging note below. */
  active: boolean;
  /** Machine-readable reason, for the log marker and for tests. */
  reason: string;
}

const REFUSE = (reason: string): BenchOverrideDecision => ({ prefix: '', active: false, reason });

/**
 * Decide whether `req.bench_prompt_prefix` may be layered for this caller.
 *
 * `env` is injected rather than read from `Deno.env` directly so the negative cases are unit
 * testable — the whole value of this function is in what it REFUSES, and a gate whose refusals are
 * untestable is a gate nobody has checked.
 */
export function resolveBenchPromptPrefix(
  candidate: unknown,
  userId: string | null,
  env: { allowlist?: string; supabaseUrl?: string } = {},
): BenchOverrideDecision {
  // Nothing asked for — the normal path for every real turn. Not a refusal; don't log it.
  if (candidate === undefined || candidate === null || candidate === '') {
    return { prefix: '', active: false, reason: 'not-requested' };
  }

  // GATE 1 — secret present. Unset ⇒ the feature does not exist here.
  const allowlistRaw = (env.allowlist ?? '').trim();
  if (!allowlistRaw) return REFUSE('override-not-enabled-in-this-environment');

  // GATE 3 (checked early — it is the cheapest and the most important): staging asserted
  // independently of the secret.
  if (!(env.supabaseUrl ?? '').includes(STAGING_PROJECT_REF)) {
    return REFUSE('not-staging');
  }

  // GATE 2 — caller allowlisted. No real household's id is ever in this list.
  const allowed = allowlistRaw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!userId || !allowed.includes(userId)) return REFUSE('caller-not-allowlisted');

  // GATE 4 — bounded and well-typed.
  if (typeof candidate !== 'string') return REFUSE('not-a-string');
  if (new TextEncoder().encode(candidate).length > MAX_PREFIX_BYTES) return REFUSE('too-large');

  return { prefix: candidate, active: true, reason: 'accepted' };
}

/**
 * Log the decision. Standing rule 2 says every silent drop gets a loud, grep-able marker — and the
 * MIRROR of that rule is the half people forget: an override silently ACCEPTED is worse than one
 * silently refused, because every number measured afterwards is quietly about someone else's
 * prompt. Both sides log.
 */
export function logBenchOverride(d: BenchOverrideDecision, userId: string | null): void {
  if (d.reason === 'not-requested') return;
  if (d.active) {
    // 🔴 Deliberately loud. A turn served under a foreign prompt is not a normal turn.
    console.warn(`BENCH-PROMPT-OVERRIDE ACTIVE: a foreign system prompt is layered on this turn — user=${userId} bytes=${d.prefix.length}`);
  } else {
    console.warn(`DROP: bench-prompt-override refused (${d.reason}) user=${userId}`);
  }
}
