// supabase/functions/voice-conversation/prep-timing.ts
//
// PREP MARKS — what the brain does between `t0` and the first model call.
//
// 🔴 THE GAP THIS FILLS. `ai_interactions.total_latency_ms` is written as `pass.latency_ms`
// (orchestrator.ts:2281) — the MODEL PASS, not the turn. So everything before pass 1 (the
// context gather, the voice resolution, the model lookup) has never been measured, and on
// `cascade_brain` the difference between the device's turn time and the model's own time is
// **1.0–1.6 s, median ~1.2 s, on every single turn** (n=26 over 60 days, 2026-09-30). Today
// "the brain was slow" covers four different things with no way to separate them.
//
// 🔑 THE MARK THAT MAKES THIS HONEST IS `unattributed()`. Naming a few spans is easy and it is
// also how a measurement quietly stops being useful: label 200 ms, call the gap explained, and
// the remaining second becomes invisible because nothing reports it any more. The remainder is
// therefore computed and emitted EXPLICITLY, including — especially — when it is embarrassing.
// If it stays near a second the honest output is "still unexplained, now bounded", never a
// redefinition of the total that makes the gap vanish.
//
// ⚠️ PER-REQUEST, NEVER MODULE-LEVEL. A Deno isolate serves CONCURRENT requests, so a
// module-scoped accumulator would let one turn's marks land on another turn's row. It would pass
// every test and look correct in development while corrupting precisely the measurement it exists
// to take. The sink is therefore always passed in, never reached for.

import type { Stage } from './types.ts';

/** Where a turn's prep marks accumulate. One per request — see the module header. */
export type PrepSink = Stage[];

/** A fresh per-request sink. */
export function newPrepSink(): PrepSink {
  return [];
}

/**
 * Await `fn`, recording how long it took as a named stage.
 *
 * ⚠️ Records on the FAILURE path too, then rethrows. A prep step that throws after 900 ms is the
 * most interesting possible measurement, and the version of this that only records on success
 * would silently omit exactly those turns — leaving the slow, broken ones out of the average and
 * making the system look better the worse it behaves.
 *
 * @param name - stage name, e.g. 'prep_gather'. `Stage.name` is a free-form string (types.ts:210),
 *   so this adds no enum, no column and no migration.
 * @param sink - the per-request sink
 * @param fn - the work to time
 */
export async function timed<T>(name: string, sink: PrepSink, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    sink.push({ name, latency_ms: Date.now() - start });
  }
}

/** Record a span the caller measured itself (for a total, or a step not shaped as one await). */
export function mark(name: string, sink: PrepSink, latencyMs: number): void {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
  sink.push({ name, latency_ms: Math.round(latencyMs) });
}

/** The name carried by the whole-region total, so readers can find it without guessing. */
export const PREP_TOTAL = 'prep_total';

/** The name carried by the remainder. Present even when zero — an absent field reads as "fine". */
export const PREP_UNATTRIBUTED = 'prep_unattributed';

/**
 * The remainder: total minus everything we could name.
 *
 * 🔑 This is the whole point of the instrument. A large remainder is a RESULT — "the cost is real
 * and it is not in any step we thought to measure" — and it is the finding most likely to be
 * explained away, because the tidy alternative (report only the named parts) looks complete.
 *
 * @returns null when there is no total to subtract from — never 0, which would read as "fully
 *   attributed" and is the most flattering possible wrong answer.
 */
export function unattributed(sink: PrepSink): number | null {
  const total = sink.find((s) => s.name === PREP_TOTAL)?.latency_ms;
  if (typeof total !== 'number') return null;
  const named = sink
    .filter((s) => s.name !== PREP_TOTAL && s.name !== PREP_UNATTRIBUTED)
    .reduce((acc, s) => acc + (s.latency_ms || 0), 0);
  return total - named;
}

/**
 * Finish the sink: append the remainder so it travels with the marks rather than needing to be
 * recomputed by every reader (and forgotten by most). Idempotent.
 */
export function sealPrep(sink: PrepSink): PrepSink {
  if (sink.some((s) => s.name === PREP_UNATTRIBUTED)) return sink;
  const rest = unattributed(sink);
  if (rest !== null) sink.push({ name: PREP_UNATTRIBUTED, latency_ms: rest });
  return sink;
}
