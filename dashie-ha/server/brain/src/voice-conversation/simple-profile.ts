// simple-profile.ts — the ONE table of values a "simple voice" household runs on (John 2026-11-14).
//
// A household with no Home Assistant and Advanced Tablet Controls OFF gets no AI/voice pickers on the
// tablet. Hiding a picker is not enough: a hidden choice still runs (the Kingtop, 11-13, spoke a Gemini
// voice nobody on screen had chosen). So the tablet sends `voice_profile: 'simple'` and the brain
// applies this table, ignoring whatever the request options, the device row or the account row say.
//
// John's rulings, 2026-11-14:
//   - one AI model, Google Gemini — read from runtime_config.default_model (hot-editable), so the
//     Dec-1 gemini-2.5-flash reroute is a config row, not a deploy;
//   - web search ON; pictures ON (source stays the account's choice, default free);
//   - the voice is the personality's own ("our preferred option for each personality") — no
//     device/account voice override, and the tablet speaks it via the personality ladder;
//   - stored choices are left untouched, so turning advanced on restores them.
//
// The tablet half (display/response format, STT/TTS engine) is SimpleVoiceProfile.kt. Contract row:
// .reference/JS_KOTLIN_CONTRACTS.md (voice_profile).

export const SIMPLE_VOICE_PROFILE = 'simple';

export function isSimpleProfile(req: { voice_profile?: string }): boolean {
  return req.voice_profile === SIMPLE_VOICE_PROFILE;
}

/** Model: request override → account → global default; simple → the global default ONLY. */
export async function resolveModelId(
  simple: boolean,
  requested: string | undefined,
  accountModel: string | null | undefined,
  getDefault: () => Promise<string>,
): Promise<string> {
  if (simple) return await getDefault();
  return requested || accountModel || await getDefault();
}

/** Web search: ON unless the account disabled it; simple → ON. Paid-tool gating applies to both. */
export function resolveWebSearch(simple: boolean, accountEnabled: boolean | null | undefined, paidToolsOk: boolean): boolean {
  return (simple || accountEnabled !== false) && paidToolsOk;
}

/** Pictures: request → account → off; simple → ON. */
export function resolveRetrievePictures(
  simple: boolean,
  requested: boolean | undefined,
  accountEnabled: boolean | null | undefined,
): boolean {
  if (simple) return true;
  return requested ?? (accountEnabled ?? false);
}

/** Voice key: simple → the personality's own voice (fixed OR preferred), no overrides. Null → normal chain. */
export function simpleVoiceKey(simple: boolean, personality: { voice?: string | null } | null | undefined): string | null {
  return simple && personality?.voice ? personality.voice : null;
}
