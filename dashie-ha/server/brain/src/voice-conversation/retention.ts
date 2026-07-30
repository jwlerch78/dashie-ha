// retention.ts — transcript retention opt-in + field builder (build plan §17).
//
// A SINGLE account-level flag (user_settings.settings.ai.retainTranscripts, default
// false) governs whether the user's utterance + the assistant's spoken reply are
// kept. WHERE they're kept depends on the call's retain_mode:
//   - server mode (logged-in cloud) → brain writes prompt_text/response_text onto
//     the terminal ai_interactions row (Supabase).
//   - caller mode (HA kiosk via the integration gateway) → brain persists NOTHING;
//     it signals the flag back via Turn.metadata.retain_transcript so the caller
//     stores the transcript HA-locally.
// Only the transcript TEXT is mode-split; token/cost rows always go to Supabase
// (billing is account-level).

// deno-lint-ignore no-explicit-any
type Supa = any;

/** Read the account-level transcript-retention opt-in. Never throws → false.
 *  Source of truth is the dedicated `user_settings.retain_transcripts` column —
 *  NOT `settings.ai.retainTranscripts` in the blob, which the tablet clobbers
 *  via full-blob writes (see migration 202606222200 / _TECHNICAL_DEBT.md). */
export async function readRetainTranscripts(supabase: Supa, userId: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('user_settings')
      .select('retain_transcripts')
      .eq('auth_user_id', userId)
      .maybeSingle();
    return data?.retain_transcripts === true;
  } catch {
    return false;
  }
}

/**
 * Build the prompt_text/response_text/display_text fields for the terminal
 * ai_interactions log. Returns the fields ONLY when we should persist text
 * server-side (persist=true); otherwise an empty object so the log row carries
 * no transcript text. `subtext` is the turn's on-screen `text` (may be empty).
 */
export function retainFields(
  persist: boolean,
  userText: string,
  responseText: string,
  subtext?: string | null,
): { prompt_text?: string; response_text?: string; display_text?: string } {
  if (!persist) return {};
  return {
    prompt_text: userText || null as unknown as string,
    response_text: responseText || null as unknown as string,
    display_text: subtext || null as unknown as string,
  };
}
