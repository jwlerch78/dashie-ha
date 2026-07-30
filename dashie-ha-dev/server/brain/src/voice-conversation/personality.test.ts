// personality.test.ts — resolvePersonality with a fake Supabase client (no DB).
// Run: deno test personality.test.ts

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { listAvailablePersonalities, resolvePersonality, resolveVoiceId } from './personality.ts';

// Minimal fake of the supabase-js query chain: .from().select().eq()*.maybeSingle().
// deno-lint-ignore no-explicit-any
function fakeSupabase(tables: Record<string, any[]>) {
  return {
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      let rows: any[] = [...(tables[table] || [])];
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select() { return q; },
        eq(col: string, val: unknown) { rows = rows.filter((r) => r[col] === val); return q; },
        order() { return q; },
        maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: null }); },
        single() { return Promise.resolve({ data: rows[0] ?? null, error: null }); },
      };
      return q;
    },
  };
}

const UUID = '12345678-1234-1234-1234-123456789abc';

Deno.test('explicit UUID → custom personality', async () => {
  const supa = fakeSupabase({
    user_personalities: [{ id: UUID, user_id: 'u1', name: 'My Custom', personality_overview: 'x' }],
  });
  const p = await resolvePersonality(supa, 'u1', 'ep', UUID);
  assertEquals(p?.name, 'My Custom');
});

Deno.test('explicit template key → template + override merge', async () => {
  const supa = fakeSupabase({
    personality_templates: [{ key: 'pirate', name: 'Pirate', family_notes: 'tpl notes', personality_overview: 'arr' }],
    user_personality_overrides: [{ user_id: 'u1', template_key: 'pirate', family_notes: 'my pirate notes' }],
  });
  const p = await resolvePersonality(supa, 'u1', 'ep', 'pirate');
  assertEquals(p?.name, 'Pirate');
  assertEquals(p?.family_notes, 'my pirate notes'); // override wins
});

Deno.test('template key, no override → template family_notes preserved', async () => {
  const supa = fakeSupabase({
    personality_templates: [{ key: 'pirate', name: 'Pirate', family_notes: 'tpl notes' }],
  });
  const p = await resolvePersonality(supa, 'u1', 'ep', 'pirate');
  assertEquals(p?.family_notes, 'tpl notes');
});

Deno.test('no explicit → resolves from the device layer (user_devices.aiVoice.personalityId)', async () => {
  const supa = fakeSupabase({
    user_devices: [{ auth_user_id: 'u1', device_id: 'dev-1', settings: { aiVoice: { personalityId: 'pirate' } } }],
    personality_templates: [{ key: 'pirate', name: 'Pirate' }],
  });
  const p = await resolvePersonality(supa, 'u1', 'dev-1');
  assertEquals(p?.name, 'Pirate');
});

Deno.test('device personality wins over the account default', async () => {
  const supa = fakeSupabase({
    user_devices: [{ auth_user_id: 'u1', device_id: 'dev-1', settings: { aiVoice: { personalityId: 'pirate' } } }],
    user_settings: [{ auth_user_id: 'u1', settings: { ai: { personality_id: 'friendly' } } }],
    personality_templates: [{ key: 'pirate', name: 'Pirate' }, { key: 'friendly', name: 'Friendly' }],
  });
  const p = await resolvePersonality(supa, 'u1', 'dev-1');
  assertEquals(p?.name, 'Pirate');
});

Deno.test('device row without a personality → falls back to account default ai.personality_id', async () => {
  const supa = fakeSupabase({
    user_devices: [{ auth_user_id: 'u1', device_id: 'dev-1', settings: {} }],
    user_settings: [{ auth_user_id: 'u1', settings: { ai: { personality_id: 'pirate' } } }],
    personality_templates: [{ key: 'pirate', name: 'Pirate' }],
  });
  const p = await resolvePersonality(supa, 'u1', 'dev-1');
  assertEquals(p?.name, 'Pirate');
});

Deno.test('no device row at all → falls back to account default', async () => {
  const supa = fakeSupabase({
    user_settings: [{ auth_user_id: 'u1', settings: { ai: { personality_id: 'pirate' } } }],
    personality_templates: [{ key: 'pirate', name: 'Pirate' }],
  });
  const p = await resolvePersonality(supa, 'u1', 'some-endpoint');
  assertEquals(p?.name, 'Pirate');
});

Deno.test("'dashie' + no override → null (base prompt)", async () => {
  const p = await resolvePersonality(fakeSupabase({}), 'u1', 'ep', 'dashie');
  assertEquals(p, null);
});

Deno.test("'dashie' + Family Notes → notes-only personality (no persona prefix)", async () => {
  const supa = fakeSupabase({
    user_personality_overrides: [{ user_id: 'u1', template_key: 'dashie', family_notes: 'We have a dog named Rex' }],
  });
  const p = await resolvePersonality(supa, 'u1', 'ep', 'dashie');
  assertEquals(p?.name, 'Dashie');
  assertEquals(p?.family_notes, 'We have a dog named Rex');
  // No structured persona fields → buildPersonalityPrompt emits a notes-only suffix,
  // no "Embody this character" prefix, and no voice → voice resolution unchanged.
  assertEquals((p as { personality_overview?: string }).personality_overview, undefined);
  assertEquals((p as { voice?: string }).voice, undefined);
});

Deno.test('nothing configured → null', async () => {
  const p = await resolvePersonality(fakeSupabase({}), 'u1', 'ep');
  assertEquals(p, null);
});

Deno.test('template key not found → null', async () => {
  const p = await resolvePersonality(fakeSupabase({ personality_templates: [] }), 'u1', 'ep', 'ghost');
  assert(p === null);
});

// ── resolveVoiceId (D3: personality voiceKey → ElevenLabs provider_voice_id) ──

Deno.test('resolveVoiceId: voiceKey → {voiceId, provider}', async () => {
  const supa = fakeSupabase({
    tts_voices: [{ key: 'JERRY', provider: 'elevenlabs', is_available: true, provider_voice_id: 'rHWSYoq8UlV0YIBKMryp' }],
  });
  assertEquals(await resolveVoiceId(supa, 'JERRY'), { voiceId: 'rHWSYoq8UlV0YIBKMryp', provider: 'elevenlabs' });
});

Deno.test('resolveVoiceId: inworld voice → provider=inworld', async () => {
  const supa = fakeSupabase({
    tts_voices: [{ key: 'ASHLEY', provider: 'inworld', is_available: true, provider_voice_id: 'Ashley' }],
  });
  assertEquals(await resolveVoiceId(supa, 'ASHLEY'), { voiceId: 'Ashley', provider: 'inworld' });
});

Deno.test('resolveVoiceId: null/blank voiceKey → nulls (default voice)', async () => {
  const supa = fakeSupabase({ tts_voices: [{ key: 'JERRY', provider: 'elevenlabs', is_available: true, provider_voice_id: 'x' }] });
  assertEquals(await resolveVoiceId(supa, null), { voiceId: null, provider: null });
  assertEquals(await resolveVoiceId(supa, ''), { voiceId: null, provider: null });
});

Deno.test('resolveVoiceId: unknown key → nulls', async () => {
  const supa = fakeSupabase({ tts_voices: [{ key: 'JERRY', provider: 'elevenlabs', is_available: true, provider_voice_id: 'x' }] });
  assertEquals(await resolveVoiceId(supa, 'NOPE'), { voiceId: null, provider: null });
});

Deno.test('resolveVoiceId: unavailable voice → nulls', async () => {
  const supa = fakeSupabase({
    tts_voices: [{ key: 'JERRY', provider: 'elevenlabs', is_available: false, provider_voice_id: 'x' }],
  });
  assertEquals(await resolveVoiceId(supa, 'JERRY'), { voiceId: null, provider: null });
});

// ── WS-G Round B (§13.2): account defaults + inherit sentinel + effective voice ──

import { resolveEffectiveVoiceKey } from './personality.ts';

Deno.test("WS-G: device '' (inherit sentinel) → ai.defaultPersonalityId", async () => {
  const supa = fakeSupabase({
    user_devices: [{ auth_user_id: 'u1', device_id: 'dev-1', settings: { aiVoice: { personalityId: '' } } }],
    user_settings: [{ auth_user_id: 'u1', settings: { ai: { defaultPersonalityId: 'pirate', personality_id: 'friendly' } } }],
    personality_templates: [{ key: 'pirate', name: 'Pirate' }, { key: 'friendly', name: 'Friendly' }],
  });
  const p = await resolvePersonality(supa, 'u1', 'dev-1');
  assertEquals(p?.name, 'Pirate'); // defaultPersonalityId beats legacy personality_id
});

Deno.test('WS-G: no defaultPersonalityId → legacy ai.personality_id still works', async () => {
  const supa = fakeSupabase({
    user_devices: [{ auth_user_id: 'u1', device_id: 'dev-1', settings: {} }],
    user_settings: [{ auth_user_id: 'u1', settings: { ai: { personality_id: 'friendly' } } }],
    personality_templates: [{ key: 'friendly', name: 'Friendly' }],
  });
  const p = await resolvePersonality(supa, 'u1', 'dev-1');
  assertEquals(p?.name, 'Friendly');
});

Deno.test('WS-G: device override still beats the account default', async () => {
  const supa = fakeSupabase({
    user_devices: [{ auth_user_id: 'u1', device_id: 'dev-1', settings: { aiVoice: { personalityId: 'pirate' } } }],
    user_settings: [{ auth_user_id: 'u1', settings: { ai: { defaultPersonalityId: 'friendly' } } }],
    personality_templates: [{ key: 'pirate', name: 'Pirate' }, { key: 'friendly', name: 'Friendly' }],
  });
  const p = await resolvePersonality(supa, 'u1', 'dev-1');
  assertEquals(p?.name, 'Pirate');
});

Deno.test('WS-G voice: fixed-voice personality locks the voice (beats device + default)', async () => {
  const supa = fakeSupabase({
    user_devices: [{ auth_user_id: 'u1', device_id: 'dev-1', settings: { aiVoice: { voiceKey: 'JERRY' } } }],
    user_settings: [{ auth_user_id: 'u1', settings: { ai: { defaultVoiceKey: 'ASHLEY' } } }],
  });
  const personality = { voice_mode: 'fixed', voice: 'COWBOY' } as never;
  assertEquals(await resolveEffectiveVoiceKey(supa, 'u1', 'dev-1', personality), 'COWBOY');
});

Deno.test('WS-G voice: device override beats account default (flexible personality)', async () => {
  const supa = fakeSupabase({
    user_devices: [{ auth_user_id: 'u1', device_id: 'dev-1', settings: { aiVoice: { voiceKey: 'JERRY' } } }],
    user_settings: [{ auth_user_id: 'u1', settings: { ai: { defaultVoiceKey: 'ASHLEY' } } }],
  });
  assertEquals(await resolveEffectiveVoiceKey(supa, 'u1', 'dev-1', null), 'JERRY');
});

Deno.test("WS-G voice: device '' (inherit) → account defaultVoiceKey", async () => {
  const supa = fakeSupabase({
    user_devices: [{ auth_user_id: 'u1', device_id: 'dev-1', settings: { aiVoice: { voiceKey: '' } } }],
    user_settings: [{ auth_user_id: 'u1', settings: { ai: { defaultVoiceKey: 'ASHLEY' } } }],
  });
  assertEquals(await resolveEffectiveVoiceKey(supa, 'u1', 'dev-1', null), 'ASHLEY');
});

Deno.test("WS-G voice: '' default ('personality's preferred') → personality voice", async () => {
  const supa = fakeSupabase({
    user_settings: [{ auth_user_id: 'u1', settings: { ai: { defaultVoiceKey: '' } } }],
  });
  const personality = { voice_mode: 'preferred', voice: 'PIRATE' } as never;
  assertEquals(await resolveEffectiveVoiceKey(supa, 'u1', 'dev-1', personality), 'PIRATE');
});

Deno.test('WS-G voice: nothing anywhere → null (caller falls back to product default)', async () => {
  assertEquals(await resolveEffectiveVoiceKey(fakeSupabase({}), 'u1', 'dev-1', null), null);
});

Deno.test('listAvailablePersonalities: voice fields SURVIVE the row map (2026-07-19 field bug)', async () => {
  // The catalog SELECTed voice_mode/voice/greeting_fallback but the .map() dropped them, so
  // every set_personality switch shipped unenriched — the optional interface fields hid it
  // from the type-checker, and the orchestrator tests' fake catalogs included the very
  // fields the real impl stripped. This test runs the REAL impl over a stubbed query.
  const rows = [
    { key: 'pirate', name: 'Pirate Captain', description: 'arr', is_seasonal: false,
      voice_mode: 'fixed', voice: 'PIRATE', greeting_fallback: 'Arrr, yer captain be aboard!' },
    { key: 'santa', name: 'Santa', description: null, is_seasonal: true,
      seasonal_start: '2099-12-01', seasonal_end: '2099-12-31',
      voice_mode: 'fixed', voice: 'SANTA', greeting_fallback: 'Ho ho ho!' },
  ];
  const supa = {
    from: () => ({ select: () => ({ eq: () => ({
      order: () => Promise.resolve({ data: rows, error: null }),
    }) }) }),
  };
  const list = await listAvailablePersonalities(supa as never);
  assertEquals(list.length, 1); // seasonal santa outside its window is filtered
  assertEquals(list[0].key, 'pirate');
  assertEquals(list[0].voice_mode, 'fixed');
  assertEquals(list[0].voice, 'PIRATE');
  assertEquals(list[0].greeting_fallback, 'Arrr, yer captain be aboard!');
});
