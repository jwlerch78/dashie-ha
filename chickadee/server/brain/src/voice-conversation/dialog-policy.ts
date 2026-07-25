// dialog-policy.ts — the UNIFIED conversation-dialog policy.
//
// The DECISIONS that both surfaces must obey — when to close the dialog, what counts as a
// "didn't catch that" miss, which utterances are end-intents — live HERE, in the shared brain,
// so the tablet (native Kotlin `VoicePipelineCoordinator`) and the console/web JS loop
// (`conversation-loop.js`) only RENDER the decision. They do NOT each re-decide it (that
// duplication is exactly what let the stop-word + miss-cap fixes drift onto one surface).
// See `.reference/build-plans/20260707_DIALOG_POLICY_UNIFICATION.md`.
//
// Contract — the brain stamps these on `turn.metadata`:
//   • `miss: true`            → a no-intent / "didn't catch that" turn. Surfaces: show a SILENT
//                               visual notice, do NOT speak it, do NOT record it into history.
//   • `end_conversation: true`→ close the dialog now. Surfaces: tear down the overlay + mic.
// Set by the brain on: an end-intent utterance, OR a miss BEFORE any successful turn (a first
// utterance the brain can't parse right after a wake trigger is almost certainly a FALSE trigger
// with background talk — give up immediately instead of looping "didn't catch that").
//
// ⚠️ Pure + dual-runtime (Deno edge + Node add-on): no Deno.*, no https imports, no Supabase.

/** The canonical no-intent reply. The prompt instructs the model to return EXACTLY this on
 *  noise/garbled input (templates.ts), and the brain recognizes it to tag `miss`. One string,
 *  one source. */
export const NOISE_REPLY = "Sorry, I didn't catch that.";

/** Whole-utterance phrases that CLOSE the dialog: the polite closers PLUS stop imperatives
 *  ("shut up", "stop talking"…) so a kid/roommate telling Dashie to stop actually stops. */
export const END_INTENT_PHRASES: readonly string[] = [
  'thanks', 'thank you', "that's all", 'thats all', 'never mind', 'nevermind',
  'ok thanks', 'okay thanks', 'ok thank you', 'okay thank you',
  'stop', 'done', 'goodbye', 'nothing',
  'shut up', 'stop talking', 'be quiet', 'quiet', 'shush', 'stop it', 'enough', "that's enough",
];

/** Unambiguous stop imperatives that also close on a SUBSTRING match — handles "shut up already"
 *  and a stop phrase buried in a garbled/echoed transcript ("…oh stop talking"). */
export const HARD_STOP_PHRASES: readonly string[] = ['shut up', 'stop talking'];

/** Polite closers that ALSO close when they END a longer utterance ("got it, thanks",
 *  "great thank you", "perfect, that's all"). END-anchored, NOT substring — so a closer at
 *  the START with more speech after ("thanks, what's the weather?") stays open. Deliberately
 *  a SMALL, unambiguous subset: NOT 'stop'/'done'/'nothing'/'quiet', which are unsafe as a
 *  trailing match ("don't stop", "i'm not done", "there's nothing", "the house is quiet"). */
export const TRAILING_CLOSE_PHRASES: readonly string[] = [
  'thanks', 'thank you', "that's all", 'thats all', 'goodbye',
];

// Strip ALL sentence punctuation, not just trailing — STT (Deepgram) punctuates
// mid-utterance ("okay. thanks."), which broke exact-match on multi-word closers.
const normalize = (t: string): string =>
  (t || '').toLowerCase().replace(/[.!?,]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Does this utterance mean "we're done / stop talking"? Exact match on END_INTENT_PHRASES, or a
 *  substring match on the unambiguous HARD_STOP_PHRASES. */
export function isEndIntent(text: string): boolean {
  const t = normalize(text);
  if (!t) return false;
  if (END_INTENT_PHRASES.includes(t)) return true;
  if (HARD_STOP_PHRASES.some((p) => t.includes(p))) return true;
  // Trailing polite closer ("got it thanks", "great thank you"): match only at the END,
  // so a closer with more speech after it ("thanks, what's next") does NOT close.
  return TRAILING_CLOSE_PHRASES.some((p) => t === p || t.endsWith(` ${p}`));
}

/** Is this spoken line the no-intent "didn't catch that" reply (from the noise short-circuit OR
 *  the model following the prompt's noise instruction)? */
export function isMissReply(voice?: string | null): boolean {
  return !!voice && /\bdidn.?t (?:quite )?catch that\b/i.test(voice);
}

/** SERVER-side miss classification (WS-F.0a) — the SINGLE source of the miss rule, used by
 *  both the metadata stamp (client signal) and the log path (DB persistence) so they can't drift.
 *  Coarse by design: the server can only distinguish "no real words" (noise / false-wake) from
 *  "had words, model punted" (no_intent). The finer STT-side classes (truncation / stt-damage /
 *  self-hearing) need the transcript + STT confidence + prior-utterance compare and are derived
 *  in the analysis layer, NOT here. */
export function classifyMiss(
  route?: string | null,
  voice?: string | null,
): { miss: boolean; reason: 'noise' | 'no_intent' | null } {
  if (route === 'noise') return { miss: true, reason: 'noise' };
  if (isMissReply(voice)) return { miss: true, reason: 'no_intent' };
  return { miss: false, reason: null };
}
