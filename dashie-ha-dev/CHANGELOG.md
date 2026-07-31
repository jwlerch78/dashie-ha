# Changelog

Versions here are the ones released on this (`dashie_ha`) add-on channel.
The `dashie_ha_dev` channel runs ahead of it; its changes land here when they
ship to this channel.

Entries below 0.8.6 were written before 2026-07-30, when this project carried a
second brand name, "Chickadee". They are left as written — a changelog that
retcons its own history is worth less than one that doesn't. Everything that
name referred to is now "Dashie for Home Assistant"; the integration domain
`chickadee` is now `dashie_voice`.

## 0.8.6 — 2026-07-28

### Fixed
- **The setup funnel no longer dead-ends.** After the restart, Home Assistant
  parks a "Do you want to set up Chickadee?" card under Settings → Devices &
  Services → Discovered, and nothing loads until you click it — but the
  console's banner kept saying "Restart Home Assistant" (a no-op the second
  time) because it only checked whether the integration had loaded. The banner
  now advances: restart → **Configure Chickadee** (one click, completes the
  discovery flow for you) → loaded.

## 0.8.5 — 2026-07-27

### Fixed
- Your avatar now appears in the console when you sign in from the panel
  (the add-on stored the account but not the profile picture).
- The console's status banners moved above the top bar so they can't be
  covered by the sign-in card.

## 0.8.1 – 0.8.4 — 2026-07-27

### Changed
- This repository is now `jwlerch78/chickadee` — the front door. The
  integration moved to `jwlerch78/chickadee-integration`.
- Plain-language add-on store description.

### Fixed
- The restart banner is now visible **before** you sign in (the sign-in overlay
  covered it — and the funnel reaches the restart step pre-login).
- The banner no longer goes stale after an add-on update.

## 0.8.0 — 2026-07-27

### Added
- **One-click "Restart Home Assistant"** in the console, for the step in setup
  where the freshly-installed integration needs a Core restart to load. This is
  why the add-on declares **`hassio_role: manager`** — it is the only thing that
  privilege is used for, and the restart only ever happens when you click it.
- The add-on **adds its own panel to your HA sidebar** on first start, instead
  of asking you to turn "Show in sidebar" on by hand.
- `/api/runtime` now reports the integration's live status and whether a restart
  is pending, so the console can tell you where you are in setup.

## 0.7.0 — 2026-07-27

### Added
- **The add-on installs the Chickadee integration for you** (the pattern Get
  HACS uses) — it copies the bundled integration into
  `/config/custom_components/chickadee` and keeps it updated, then asks you to
  restart. This is what **`homeassistant_config:rw`** is for.
  - It only ever touches copies carrying its own marker file: a **HACS or
    manual install of the integration is never modified**.
  - It never restarts Core on its own.
  - Turn it off with the `install_integration` option if you'd rather manage
    the integration yourself.

### Changed
- 0.7.1 – 0.7.7 (same day): console branding and artwork, Chickadee-navy theme,
  `chickadee` as the default wake word, supplier names on the cloud engine
  labels ("Cloud STT (Deepgram / Whisper)"), and the default personality shown
  as "Standard".

## 0.6.0 — 2026-07-27

### Added
- **`/api/internal` — the LAN-sharing lane.** Lets Dashie kiosk devices on your
  network run their voice through this add-on's household account instead of
  each holding their own credential (`sharing-status`, `account-credential`,
  `authorize-device`, `voice-config`). It is same-box-authenticated via the
  bridge secret, reachable only through the integration, and gated on the
  account's household-sharing toggle, which fails closed.

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
