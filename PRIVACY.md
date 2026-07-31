# Privacy — what leaves your box, per mode

Dashie for Home Assistant's data posture depends entirely on which engines you
point it at.
Three modes, three answers. Everything here is verifiable in this repo's
source.

## Local mode (your own engines, no account)

**Nothing leaves your network.** Speech goes to the STT/TTS/LLM endpoints
you configured (your Ollama box, your Whisper server), the brain runs in
the add-on, and no Dashie service is contacted — there is no account,
no telemetry, no version ping.

**Your engine configuration stays on the box too.** With no account signed in,
the console writes its settings to `/data/dashie_ha_settings.json` on the add-on
— your endpoint URLs and model ids, never uploaded. (This was not always true:
until 2026-07-30 the console's only settings backend was the account one, so the
page for configuring *your own* local Ollama round-tripped that config through
our cloud. It was a real defect and it is fixed, not reworded.) Signing in later
switches the console to your account's settings; the two are deliberately kept
separate, with no sync or merge in either direction. Unlike your API keys, this
file is **not** excluded from HA backups — it holds no secrets, only URLs and
model names.

One honest exception, and it isn't us: opening the **console panel** currently
loads two JavaScript libraries (`hls.js`, `heic2any`) from the jsDelivr CDN, so
your browser makes two third-party requests when you view that page. Neither is
used by anything in this repo — they serve pages that only exist in the closed
family delta, which vendors this console as its core, and they are being moved
into that delta. Everything else the console needs is served from the add-on
itself (see `dashie-ha/frontend/console/vendor/`, where the Supabase SDK is
vendored for exactly this reason — it used to be a third request, on the sign-in
page). Voice, the brain, and your engines are unaffected either way: no audio,
transcript, or account data is involved, and the add-on makes no such request —
this is the panel's HTML in your browser.

## Bring-your-own-key

Audio and text go to **the providers you configured** (e.g. Google, OpenAI,
OpenRouter) under **your** API key, directly from your box. Your keys are stored
on-box only (`/data/api-keys.json`, file mode 600), are masked in the console UI,
and are excluded from HA backups (`backup_exclude`). Saving a key needs no Dashie
account — that is the point of it.

**With no account, Dashie's servers are not involved at all**: the turn is your
box talking to your provider. **If you are signed in**, the AI still runs entirely
on your key (we never bill tokens for it), but the turn is recorded in your
account's usage history like any other — and the optional extras that *are* ours,
web search and image lookup, become available and are billed to your credits when
the assistant uses them. Signing out returns you to the first sentence.

One credential this does **not** cover: the add-on↔integration bridge secret
is also mirrored to `<config>/.dashie_voice/bridge_secret`, which is in your HA
config directory and therefore **is** included in HA backups —
`backup_exclude` only reaches `/data`. It's a same-box credential (nothing is
exposed on your LAN), but while signed in it can be exchanged for your
household account token, so it's worth more than the name suggests. Details
and the reset in the add-on's DOCS → "How the bridge auth works".

## Dashie Cloud (signed in)

When you leave an engine blank while signed in, that stage runs on hosted
engines under your account:

- **Sent per turn:** the audio (STT), the turn text + your Assist-exposed
  entity context (LLM), and the reply text (TTS). Context is scoped to
  what the question needs — it sends your exposed-entity states, not your
  whole HA config.
- **Stored for billing:** per-call usage rows — model, token counts,
  latency, cost. Metered credits require this; it's the invoice.
- **Transcripts:** stored **only** if you enable transcript retention /
  "share to improve" in the console (off by default). Without it, billing
  rows carry usage numbers, not your words.
- Accounts & billing run on the same backend as the paid family edition —
  one account system, two editions (see [PROVENANCE.md](PROVENANCE.md)). Account deletion is available in the
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
  two pinned open-source libraries (hls.js, heic2any) from the jsDelivr CDN —
  a standard static fetch by your browser, no data sent beyond the request
  itself. (This said *three* until 2026-07-30; supabase-js was vendored into
  `dashie-ha/frontend/console/vendor/` and the count was not updated. Neither
  library is used by anything in this repo — see the local-mode section above.)
  The voice pipeline never touches a CDN
- The add-on ↔ integration bridge is same-box only (`ports: {}` — nothing
  is exposed on your LAN), authenticated with a random per-install secret

## Questions

Open an issue on this repo — privacy questions are welcome in public.
