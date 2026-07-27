# Changelog

## 0.5.0 — 2026-07-27

### Added
- **The Chickadee Console** — the panel is now a full console (replacing the
  minimal sign-in page): Voice & AI (pipeline presets, engine pickers with
  live probe/preview, personalities), API Keys (on-box BYO provider keys,
  never synced), Local Engines (network scan for Ollama / Kokoro / Piper /
  Whisper on your LAN), Preferences, Credits, and Account.
- Console API surface: `/api/runtime`, `/api/auth/*` (device flow + the 0.4.0
  email/password endpoints), `/api/voice/engines|probe|preview|discover|
  converse-local|local-status`, `/api/keys/*`, `/api/settings/*`.
- Engine detection over the HA WebSocket API (`homeassistant_api` permission
  added) — the console lists your HA's real STT/TTS engines and voices.
- `backup_exclude` for on-box secrets (`api-keys.json`, the account-config
  replay cache).

### Changed
- The server is now Express with npm dependencies (`express`, `ws`) — no
  longer dependency-free. The **bridge surface is unchanged**: `/api/ping` +
  `/api/voice/converse|stt|tts|voices` keep their paths, auth, and shapes.
- Signed-out consoles show the sign-in screen; engine URLs remain
  configurable from the add-on Configuration tab either way.

## 0.4.0 — 2026-07-26

### Added
- **Email/password accounts** — create a Chickadee account or sign in directly
  from the panel, no second device and no Google required.
- **Streamlined Google sign-in** — "Continue with Google" opens the approval
  page in a new tab of the same browser (code pre-filled); the panel picks the
  session up automatically.
- Credit balance shown in the panel while signed in, with a pointer to
  self-hosted engines when the balance is empty.

### Fixed
- Sessions now survive their first token refresh: the add-on registers a
  stable device id at sign-in (previously every session silently expired
  after ~72 hours when the refresh was rejected as an unknown device).

## 0.3.0 — 2026-07-25

### Added
- **Chickadee Cloud (hosted engines)** — sign in from the new **Chickadee panel**
  in the HA sidebar (device flow: link + code, approve from any browser). While
  signed in, any engine left unconfigured runs on Chickadee Cloud under your
  account: brain, speech-to-text (Whisper), and voices — metered.
- `cloud_env` option (development / production).
- Degraded cloud turns (e.g. an empty credit balance) are now spoken instead of
  silently answering "OK."

## 0.2.2 — 2026-07-25

### Added
- `/api/voice/voices` — the configured TTS engine's voice catalog now feeds
  Home Assistant's native voice picker (e.g. all 68 Kokoro voices).

## 0.2.1 — 2026-07-25

### Changed
- The bridge secret is now handed to the integration via **Supervisor
  discovery** (the MQTT-broker credential pattern) instead of a file other
  add-ons could read. File copies remain as a fallback for older integrations.

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
