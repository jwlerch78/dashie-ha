# Chickadee add-on

The Chickadee brain runtime. Pairs with the
[Chickadee integration](https://github.com/jwlerch78/chickadee-integration)
to give your Assist pipeline a real brain: this add-on receives each pipeline
stage from the integration over an authenticated same-box bridge and routes it
to the engines **you** configure — any OpenAI-compatible endpoint, local or
cloud.

Nothing talks to this add-on except the integration on the same box. No host
ports are published. (Privacy details per mode: [PRIVACY.md](https://github.com/jwlerch78/chickadee/blob/main/PRIVACY.md);
who builds this and how it's funded: [PROVENANCE.md](https://github.com/jwlerch78/chickadee/blob/main/PROVENANCE.md).)

## Setup in one minute

1. Start the add-on, then either **sign in** (open the Chickadee panel in the HA
   sidebar — hosted Chickadee Cloud engines, metered) or configure your own
   engine URLs below. Anything you leave blank uses Chickadee Cloud when signed
   in.
2. The add-on **installs the Chickadee integration for you** (see
   `install_integration` below) — restart HA when the banner asks, then
   Configure the discovered card in Settings → Devices & Services. Prefer to
   manage it yourself? Set `install_integration: false` and install via HACS
   custom repo `https://github.com/jwlerch78/chickadee-integration`.
3. A ready-to-use Assist pipeline wired to the Chickadee conversation / STT /
   TTS entities is created for you (edit or mix with Whisper/Piper/HA Cloud
   freely in Settings → Voice assistants).

## Options

### LLM (the brain)

| Option | Meaning |
|---|---|
| `llm_url` | An OpenAI-compatible chat server. Either a **base URL** (we append `/v1/chat/completions`) — e.g. `http://192.168.1.50:11434` for Ollama — or a **full** chat-completions URL for providers whose compat path differs. |
| `llm_model` | Model id, e.g. `qwen2.5:7b` or `gemini-2.5-flash`. |
| `llm_api_key` | Bearer key for the endpoint. Leave blank for local Ollama / llama.cpp. |

Full-URL examples:

- Gemini: `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`
- OpenRouter: `https://openrouter.ai/api/v1/chat/completions`

**Model choice matters.** The brain sends real prompts (a few thousand tokens once
your exposed entities are included) and expects the model to hold a structured
action schema. In our testing, 1.5B–7B local models misroute or emit placeholder
JSON; current fast cloud models (e.g. Gemini Flash) and well-run larger local
models are reliable.

### STT (speech-to-text)

| Option | Meaning |
|---|---|
| `stt_url` | An OpenAI-compatible transcription server (we append `/v1/audio/transcriptions` unless the URL already ends with it) — whisper.cpp server, faster-whisper / speaches, or a provider endpoint. |
| `stt_model` | Model id the server expects (default `whisper-1`). |
| `stt_api_key` | Bearer key, if the endpoint needs one. |

### TTS (text-to-speech)

| Option | Meaning |
|---|---|
| `tts_url` | An OpenAI-compatible speech server (we append `/v1/audio/speech`) — e.g. Kokoro-FastAPI, or a provider endpoint. |
| `tts_voice` | Default voice id, e.g. `af_heart`. A pipeline/turn can override it. |
| `tts_api_key` | Bearer key, if the endpoint needs one. |

### Other

| Option | Meaning |
|---|---|
| `log_level` | Add-on log verbosity. `debug` shows per-turn engine routing. |
| `cloud_env` | Which Chickadee Cloud environment a signed-in account uses. **During the beta this defaults to `beta`** — Chickadee Cloud accounts run on our staging environment until the beta ends (stated here so it's not a surprise); `stable` is the production environment accounts will move to. `development`/`production` are accepted as legacy aliases. |
| `install_integration` | On (default): the add-on installs/updates the bundled Chickadee integration into `/config/custom_components/chickadee`. See **Permissions** below for exactly what this touches. Off: manage the integration yourself (HACS/manual). |

## Chickadee Cloud (hosted engines)

Sign in from the **Chickadee panel** in the HA sidebar (link + code, approve
from any browser). While signed in, every engine you leave blank runs on
Chickadee Cloud under your account — brain, speech-to-text, and voices —
metered against your credit balance. Configured URLs always win over the
hosted fallback, so mixing (own LLM + hosted voices, or the reverse) is one
Configuration-tab edit.

Options are read fresh on each turn — changing configuration only needs an add-on
**restart**, never a rebuild.

## Hardware guidance

The LLM stage is prompt-heavy. A GPU or Apple-silicon box on your LAN answers in
a few seconds; a CPU-only 4-core HA box can take **minutes per turn** on prompt
prefill alone. If your HA box is modest, run the model server on a faster machine
on your LAN and point `llm_url` / `stt_url` / `tts_url` at it — mixing is fine
(e.g. local Whisper + cloud LLM).

## Permissions & what this add-on touches

Add-ons declare their privileges up front — here's what each of ours is for,
so you can audit rather than trust:

| Declaration | Why |
|---|---|
| `ports: {}` | Nothing is published on your LAN. The integration reaches the add-on over Home Assistant's internal docker network only. |
| `ingress` | Serves the Chickadee panel in your sidebar. HA proxies and authenticates all of it — the console is only reachable by logged-in HA users. |
| `hassio_api` + `discovery` | Publishes the bridge secret to the integration via Supervisor discovery (the same credential channel the MQTT broker uses) and lists add-ons for engine detection. |
| `homeassistant_api` | The console's engine detection talks to HA's WebSocket API (`tts/engine/list` etc.) to show your real STT/TTS engines and voices. |
| `hassio_role: manager` | One thing: the panel's **Restart Home Assistant** button (the integration needs a Core restart to activate; the banner offers it one-click). The restart only ever happens when you click it. |
| `homeassistant_config:rw` | Two writes: (1) the integration installer (below); (2) a fallback copy of the bridge secret at `<config>/.chickadee/bridge_secret` for older integration versions — Supervisor discovery is the primary channel. |
| `backup_exclude` | Keeps your on-box secrets (`api-keys.json`, the account cache) **out of HA backups**. |

**The integration installer** (`install_integration: true`, default): on
start, the add-on copies its bundled integration to
`/config/custom_components/chickadee` and marks the copy with a
`.installed_by_chickadee_addon` file. It only ever updates copies carrying
that marker — a HACS or manual install is **never touched**. It never
restarts Core on its own; it posts a notification and the panel banner, and
you click Restart. Turn it off to manage the integration yourself.

**Wake-word models → `/share/microwakeword`:** when you pick one of
Chickadee's own wake words (`chickadee`, `hey_dashie`), the integration copies
that model's `.json` + `.tflite` into `/share/microwakeword/` so the standard
`wyoming-microwakeword` add-on can load it — mirroring the established
`/share/openwakeword` convention. This is the integration writing (HA Core can
write `/share` directly), not an add-on mount; `/share` is the one mount other
add-ons can read, which is the point — the wake engine is a different add-on.
Community wake words (Okay Nabu, Hey Jarvis, Alexa) are referenced by name
from the official repo and deploy nothing. The two models we ship were trained
in-house by Dashie; their weights are released under this repo's AGPL-3.0
alongside everything else, and the training pipeline is not yet public.

## How the bridge auth works

At startup the add-on generates a random bridge secret and publishes it to the
integration via **Supervisor discovery** (the same credential channel the MQTT
broker uses); the integration presents it on every request
(`X-Chickadee-Bridge-Secret`), and anything without it gets a 401. The secret
never leaves the box. A copy is also written to `.chickadee/bridge_secret` in
the HA config directory as a fallback for older integration versions.

## Troubleshooting

- **"Add-on unreachable" in the integration** — the add-on must be *started*, not
  just installed. Check the add-on Log tab for the startup banner.
- **Turns fail immediately** — look for `CHICKADEE-BRAIN` lines in the add-on log;
  they include the engine error (bad URL, bad key, model not found).
- **STT returns nothing / TTS silent** — look for `CHICKADEE-STT` / `CHICKADEE-TTS`
  lines; each logs the configured endpoint's response status.
- **Turns are extremely slow** — see Hardware guidance above; also try a smaller
  set of Assist-exposed entities (Settings → Voice assistants → Expose), since
  exposed entities dominate prompt size.
- **401 in the integration log** — stale bridge secret; restart the add-on, then
  reload the integration.

## Reporting issues

Please include your HA version, add-on version, engine setup (URLs/models —
**never keys**), and the `CHICKADEE-*` log lines:
[chickadee issues](https://github.com/jwlerch78/chickadee/issues).
