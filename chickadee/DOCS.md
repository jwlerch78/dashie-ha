# Chickadee add-on

The Chickadee brain runtime. Pairs with the
[Chickadee integration](https://github.com/jwlerch78/chickadee) to give your
Assist pipeline a real brain: this add-on receives each pipeline stage from the
integration over an authenticated same-box bridge and routes it to the engines
**you** configure — any OpenAI-compatible endpoint, local or cloud.

Nothing talks to this add-on except the integration on the same box. No host
ports are published.

## Setup in one minute

1. Configure at least `llm_url` + `llm_model` below and start the add-on.
2. Install the Chickadee **integration** (HACS custom repo
   `https://github.com/jwlerch78/chickadee`) and add it in
   Settings → Devices & Services.
3. Build a pipeline in Settings → Voice assistants using the Chickadee
   conversation / STT / TTS entities (mix with Whisper/Piper/HA Cloud freely).

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

Options are read fresh on each turn — changing configuration only needs an add-on
**restart**, never a rebuild.

## Hardware guidance

The LLM stage is prompt-heavy. A GPU or Apple-silicon box on your LAN answers in
a few seconds; a CPU-only 4-core HA box can take **minutes per turn** on prompt
prefill alone. If your HA box is modest, run the model server on a faster machine
on your LAN and point `llm_url` / `stt_url` / `tts_url` at it — mixing is fine
(e.g. local Whisper + cloud LLM).

## How the bridge auth works

At startup the add-on generates a random bridge secret and writes it to
`.chickadee/bridge_secret` inside your Home Assistant config directory. The
integration reads it there and presents it on every request
(`X-Chickadee-Bridge-Secret`); anything without it gets a 401. The secret never
leaves the box. (Note: other add-ons with a config-directory mount could read
this file — a Supervisor-discovery handoff is planned to close that.)

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
[chickadee-addons issues](https://github.com/jwlerch78/chickadee-addons/issues).
