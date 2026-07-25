// personality.ts — resolve a personality for a device, server-side.
//
// Reads Supabase DIRECTLY with the service-role client (not DashieAuth.dbRequest).
//
// Resolution chain:
//   explicit personality_id (caller override, e.g. the console AI-chat picker)
//     → user_devices.settings.aiVoice.personalityId   (THE canonical per-device store)
//     → user_settings.ai.personality_id               (account-wide default fallback)
// A resolved id that's a UUID → custom (user_personalities); else a template key →
// personality_templates + user_personality_overrides (family_notes merge). 'dashie'/none → null
// (base prompt), matching the webapp's `personalityId !== 'dashie'` gate.
//
// Personality is DEVICE-SCOPED (SETTINGS.md Invariant 1 — per-room personalities, e.g. a
// princess in the kid's room). Its one canonical home is user_devices.aiVoice.personalityId,
// which the console device-page picker writes and full-dashie native already applies. This used
// to read a PARALLEL account-level store (user_settings.voice.endpointPersonalities[endpoint_id]
// + endpointDefaultPersonality) that the device-page picker never wrote — so per-device
// personality reached the brain for NO device. That parallel store existed only because the read
// was ported from the account-scoped console client; the service-role client here can read the
// device layer directly, so we do. endpoint_id == user_devices.device_id (D1), making this a
// single indexed lookup. See .reference/build-plans/20260703_VOICE_SETTINGS_ARCHITECTURE_HANDOFF.md.

import type { Personality } from './types.ts';

// deno-lint-ignore no-explicit-any
type Supa = any;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One row of the voice-facing personality catalog. Voice fields ride along so a
 *  set_personality action can be enriched DETERMINISTICALLY server-side (the client —
 *  native Kotlin especially — applies the switch without its own template lookup). */
export interface PersonalityChoice {
  key: string;
  name: string;
  description: string | null;
  voice_mode?: string | null;        // 'fixed' (personality owns its voice) | 'preferred'
  voice?: string | null;             // voiceKey when voice_mode='fixed'
  greeting_fallback?: string | null; // canned greeting if the template has one
}

/**
 * List the personalities a user may switch to BY VOICE.
 *
 * Read live from `personality_templates` on purpose: personalities are added by migration
 * (princess/wizard, 2026-07-17), so any hand-authored list — in a KB chunk or a prompt —
 * silently goes stale the next time one lands. The catalog is small (<15 rows) and this runs
 * only on a personality turn, not on every turn.
 *
 * Seasonal rows (Santa) are included only inside their date window, mirroring the settings
 * pickers, so "switch to Santa" in July doesn't offer something the UI is hiding.
 */
export async function listAvailablePersonalities(supabase: Supa): Promise<PersonalityChoice[]> {
  const { data, error } = await supabase
    .from('personality_templates')
    .select('key, name, description, is_seasonal, seasonal_start, seasonal_end, voice_mode, voice, greeting_fallback')
    .eq('is_available', true)
    .order('sort_order', { ascending: true });
  if (error || !Array.isArray(data)) return [];

  const today = new Date().toISOString().slice(0, 10);
  return data
    .filter((r: Record<string, unknown>) => {
      if (!r.is_seasonal) return true;
      const start = r.seasonal_start as string | null;
      const end = r.seasonal_end as string | null;
      // An open-ended window on either side stays open on that side.
      return (!start || today >= start) && (!end || today <= end);
    })
    .map((r: Record<string, unknown>) => ({
      key: String(r.key),
      name: String(r.name),
      description: (r.description as string | null) ?? null,
      // Voice fields MUST survive this map — set_personality enrichment reads them off the
      // catalog row. 2026-07-19 field bug: they were SELECTed above but dropped here, so
      // every switch shipped unenriched (the optional interface fields hid it from the
      // type-checker, and the orchestrator tests' fake catalogs included what the real
      // impl stripped).
      voice_mode: (r.voice_mode as string | null) ?? null,
      voice: (r.voice as string | null) ?? null,
      greeting_fallback: (r.greeting_fallback as string | null) ?? null,
    }));
}

export async function resolvePersonality(
  supabase: Supa,
  userId: string,
  endpointId: string,
  explicitId?: string | null,
): Promise<Personality | null> {
  const id = explicitId || (await readDevicePersonalityId(supabase, userId, endpointId));
  if (!id || id === 'dashie') {
    // Default personality → neutral base prompt (no structured persona). But the user's
    // Family Notes for the default MUST still apply — the editor lets them save notes on the
    // 'dashie' template, and dropping them here (as this used to) made that a silent no-op.
    // Return a family_notes-ONLY personality so buildPersonalityPrompt adds just the notes
    // suffix (no "Embody this character" prefix). No `voice`/`voice_mode` → voice resolution
    // in orchestrator.ts is identical to the previous null (falls through to device/account/
    // default). Mirrors the webapp cascade's default-personality branch in ai-service.js.
    const { data: dflt } = await supabase
      .from('user_personality_overrides')
      .select('family_notes')
      .eq('user_id', userId)
      .eq('template_key', 'dashie')
      .maybeSingle();
    if (dflt?.family_notes) {
      return { name: 'Dashie', family_notes: dflt.family_notes } as Personality;
    }
    return null; // no notes → base prompt (unchanged)
  }

  if (UUID_RE.test(id)) {
    // Custom personality (user-scoped).
    const { data } = await supabase
      .from('user_personalities')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();
    return (data as Personality) || null;
  }

  // Built-in template by key + user's family-notes override (merge mirrors
  // PersonalityPromptBuilder.mergePersonalityWithOverride).
  const { data: tpl } = await supabase
    .from('personality_templates')
    .select('*')
    .eq('key', id)
    .maybeSingle();
  if (!tpl) return null;

  const { data: override } = await supabase
    .from('user_personality_overrides')
    .select('*')
    .eq('user_id', userId)
    .eq('template_key', id)
    .maybeSingle();

  return { ...tpl, family_notes: override?.family_notes || tpl.family_notes } as Personality;
}

/**
 * Resolve a personality id for a device (WS-G §13.2 chain — the JS device twin
 * is js/data/settings/ai-voice-resolution.js, contract #22):
 *   1. user_devices.settings.aiVoice.personalityId  keyed (auth_user_id, device_id==endpointId)
 *      ('' is the INHERIT sentinel the console writes — falsy, falls through)
 *   2. user_settings.settings.ai.defaultPersonalityId  (WS-G account default)
 *   3. user_settings.settings.ai.personality_id        (legacy account fallback)
 * endpointId is the stable per-device id (== user_devices.device_id, D1), so (1) is a single
 * indexed lookup. A device with no per-device choice falls through to the account default.
 */
async function readDevicePersonalityId(supabase: Supa, userId: string, endpointId: string): Promise<string | null> {
  // 1. Per-device (canonical). endpoint_id == user_devices.device_id.
  const { data: deviceRow } = await supabase
    .from('user_devices')
    .select('settings')
    .eq('auth_user_id', userId)
    .eq('device_id', endpointId)
    .maybeSingle();
  const devicePid = (deviceRow?.settings as { aiVoice?: { personalityId?: string } } | undefined)
    ?.aiVoice?.personalityId;
  if (devicePid) return devicePid;

  // 2/3. Account defaults (WS-G default first, then the legacy slot).
  const { data: acct } = await supabase
    .from('user_settings')
    .select('settings')
    .eq('auth_user_id', userId)
    .maybeSingle();
  const ai = (acct?.settings as { ai?: { defaultPersonalityId?: string; personality_id?: string } } | undefined)?.ai;
  return ai?.defaultPersonalityId || ai?.personality_id || null;
}

/**
 * Effective TTS voice key for a device (WS-G §13.2, JS twin in
 * ai-voice-resolution.js — voice lock always wins):
 *   1. fixed-voice personality → its voice (the lock)
 *   2. user_devices.settings.aiVoice.voiceKey        (device override; '' = inherit)
 *   3. user_settings.settings.ai.defaultVoiceKey     (account default; '' = personality's preferred)
 *   4. personality's own (preferred) voice
 * Returns null when nothing applies → caller falls back to the product default.
 * Before WS-G the brain used only personality.voice, so device/account voice
 * choices never reached cascade turns at all.
 */
export async function resolveEffectiveVoiceKey(
  supabase: Supa,
  userId: string,
  endpointId: string,
  personality: Personality | null,
): Promise<string | null> {
  if (personality?.voice_mode === 'fixed' && personality.voice) return personality.voice;

  const { data: deviceRow } = await supabase
    .from('user_devices')
    .select('settings')
    .eq('auth_user_id', userId)
    .eq('device_id', endpointId)
    .maybeSingle();
  const deviceVoice = (deviceRow?.settings as { aiVoice?: { voiceKey?: string } } | undefined)
    ?.aiVoice?.voiceKey;
  if (deviceVoice) return deviceVoice;

  const { data: acct } = await supabase
    .from('user_settings')
    .select('settings')
    .eq('auth_user_id', userId)
    .maybeSingle();
  const defaultVoice = (acct?.settings as { ai?: { defaultVoiceKey?: string } } | undefined)
    ?.ai?.defaultVoiceKey;
  if (defaultVoice) return defaultVoice;

  return personality?.voice || null;
}

/**
 * Resolve a personality's voiceKey (personality_templates.voice, e.g. 'JERRY'/'COWBOY') to the
 * concrete ElevenLabs voice id the client TTS needs (tts_voices.provider_voice_id). This is
 * D3 "voice follows personality": the resolved personality already carries `.voice`, so the
 * brain looks up the catalog once and returns the id in the Turn — no client-side voice map,
 * no separately-synced voiceId. Returns null (→ client default voice) when the key is unknown
 * or unset (e.g. base 'dashie' → no personality → default).
 */
export async function resolveVoiceId(
  supabase: Supa,
  voiceKey?: string | null,
): Promise<{ voiceId: string | null; provider: string | null }> {
  if (!voiceKey) return { voiceId: null, provider: null };
  // Read the row's OWN provider (no longer elevenlabs-only) so a personality mapped to an
  // Inworld voice returns provider='inworld' → the native client routes to Inworld.
  const { data } = await supabase
    .from('tts_voices')
    .select('provider_voice_id, provider')
    .eq('key', voiceKey)
    .eq('is_available', true)
    .maybeSingle();
  return {
    voiceId: (data?.provider_voice_id as string | undefined) || null,
    provider: (data?.provider as string | undefined) || null,
  };
}
