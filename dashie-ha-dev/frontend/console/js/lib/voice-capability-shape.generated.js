// GENERATED FILE — DO NOT EDIT BY HAND.
// Source of truth: dashie-android …/halite/voice/VoiceCapabilityReport.kt (Report.toJson)
// Regenerate:      node scripts/gen-capability-shape.mjs   (in dashieapp_staging)
// Gate:            npm run lint:capability-shape
//
// CONTRACTS #79. The record is produced by Kotlin, uploaded by the device's own
// JS, and read FIELD BY FIELD by the console — across two repos with no shared
// module. Consumers import these names instead of writing string literals, so a
// Kotlin rename fails the gate instead of silently emptying every device card.
//
// 🔴 This record is PERSISTED (user_devices.settings.aiVoice.voiceCapabilities),
// so a rename does NOT just move a field — it strands every row already written
// by an un-updated APK. SHAPE_VERSION exists to make that a decision rather than
// an accident; bump it deliberately and say what happens to the old rows.

const CAPABILITY_SHAPE_VERSION = 1;

const CAPABILITY_FIELDS = Object.freeze({
  stackUp: 'stackUp',
  lane: 'lane',
  stt: Object.freeze({ _self: 'stt', registered: 'registered', available: 'available', priority: 'priority', running: 'running' }),
  tts: Object.freeze({ _self: 'tts', resolved: 'resolved' }),
  unmappedTypes: 'unmappedTypes',
  note: 'note',
});
