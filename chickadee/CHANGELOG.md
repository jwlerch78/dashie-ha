# Changelog

## 0.2.0 — 2026-07-25

- **STT and TTS engine endpoints** — the add-on now serves `/api/voice/stt` and
  `/api/voice/tts` for the integration's STT/TTS entities, routing to any
  OpenAI-compatible transcription / speech server. New options: `stt_url`,
  `stt_model`, `stt_api_key`, `tts_url`, `tts_voice`, `tts_api_key`.
- Full audio→action→audio Assist pipeline verified end-to-end (~8 s with
  LAN-hosted Whisper + Kokoro and a fast LLM).
- Brain update: entity questions ("which lights are on?") are answered from live
  entity states — no more card-assuming acknowledgements on audio-only
  satellites — and the assistant's identity follows the name configured in the
  integration.

## 0.1.1 — 2026-07-25

- `llm_url` accepts **full** chat-completions URLs, enabling providers whose
  OpenAI-compat path differs from `<base>/v1/chat/completions` (Gemini,
  OpenRouter).
- Brain-core update: image-capability gate no longer makes small models parrot a
  "pictures are off" apology on unrelated smart-home commands.

## 0.1.0 — 2026-07-25

- **Real brain runtime** behind `/api/voice/converse` — the shared Chickadee
  brain core (vendored, generated bundle) with open-posture routing: any
  OpenAI-compatible LLM endpoint via `llm_url` / `llm_model` / `llm_api_key`.
  Executes real smart-home actions against Assist-exposed entities.
- Local-only conversation logging; no hosted services required.

## 0.0.2 — 2026-07-25

- Bridge secret also provisioned into the HA config directory
  (`.chickadee/bridge_secret`) so HA Core can read it on HAOS.

## 0.0.1 — 2026-07-25

- Initial scaffold: bridge-authenticated HTTP surface (`/api/ping`,
  `/api/voice/converse`) on the internal add-on network, auth enforced from
  birth.
