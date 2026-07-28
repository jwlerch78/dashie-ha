# Privacy — what leaves your box, per mode

Chickadee's data posture depends entirely on which engines you point it at.
Three modes, three answers. Everything here is verifiable in this repo's
source.

## Local mode (your own engines, no account)

**Nothing leaves your network.** Speech goes to the STT/TTS/LLM endpoints
you configured (your Ollama box, your Whisper server), the brain runs in
the add-on, and no Chickadee service is contacted — there is no account,
no telemetry, no version ping.

## Bring-your-own-key

Audio and text go to **the providers you configured** (e.g. Google, OpenAI,
OpenRouter) under **your** API key, directly from your box. Chickadee's
servers are not involved. Your keys are stored on-box only
(`/data/api-keys.json`, file mode 600), are masked in the console UI, and
are excluded from HA backups (`backup_exclude`).

## Chickadee Cloud (signed in)

When you leave an engine blank while signed in, that stage runs on hosted
engines under your account:

- **Sent per turn:** the audio (STT), the turn text + your Assist-exposed
  entity context (LLM), and the reply text (TTS). Context is scoped to
  what the question needs — Chickadee sends your exposed-entity states,
  not your whole HA config.
- **Stored for billing:** per-call usage rows — model, token counts,
  latency, cost. Metered credits require this; it's the invoice.
- **Transcripts:** stored **only** if you enable transcript retention /
  "share to improve" in the console (off by default). Without it, billing
  rows carry usage numbers, not your words.
- Accounts & billing run on the same backend as Dashie (see
  [PROVENANCE.md](PROVENANCE.md)). Account deletion is available in the
  console (Account → Danger Zone): billing stops immediately, data is
  purged after a 15-day grace window.

## Things this add-on never does, in any mode

- No analytics or tracking SDKs (no Google Analytics, Sentry, PostHog, …)
- No startup phone-home, no update checks, no version pings
- No listening: wake-word detection is your satellite's job; the add-on
  only receives audio HA's Assist pipeline hands it
- The **LAN engine scan** (console → Local Engines → Scan) runs only when
  you click it, probes private subnets only, uses read-only unauthenticated
  version-endpoint GETs to identify engines, and its results render in the
  console — they are never sent off-box
- One caveat for completeness: the **console page in your browser** loads
  three pinned open-source libraries (supabase-js, hls.js, heic2any) from
  the jsDelivr CDN — a standard static fetch by your browser, no data sent
  beyond the request itself. The voice pipeline never touches a CDN
- The add-on ↔ integration bridge is same-box only (`ports: {}` — nothing
  is exposed on your LAN), authenticated with a random per-install secret

## Questions

Open an issue on this repo — privacy questions are welcome in public.
