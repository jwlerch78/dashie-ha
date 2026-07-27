# Chickadee Add-ons

Home Assistant add-on repository for [Chickadee](https://github.com/jwlerch78/chickadee) —
the open voice pipeline that gives your Assist pipeline a real brain.

## Installation

1. Settings → Add-ons → Add-on Store → **⋮ → Repositories**
2. Add `https://github.com/jwlerch78/chickadee`
3. Install **Chickadee** and configure your engines (see the add-on's
   Documentation tab)
4. Install the [Chickadee integration](https://github.com/jwlerch78/chickadee)
   via HACS and build your pipeline

## Add-ons

### Chickadee

The Chickadee brain runtime. Receives conversation / STT / TTS stages from the
`chickadee` integration over an authenticated same-box bridge and routes each to
any OpenAI-compatible endpoint you configure:

- **LLM** — Ollama, llama.cpp, vLLM, LM Studio on a LAN box; or a cloud
  provider's compat endpoint (Gemini, OpenRouter, OpenAI) with your own key
- **STT** — whisper.cpp server, faster-whisper / speaches, or a provider endpoint
- **TTS** — Kokoro-FastAPI or a provider endpoint

Mix freely — local Whisper + cloud LLM is a great combination. Full option
reference, engine recipes, hardware guidance, and troubleshooting live in
[chickadee/DOCS.md](chickadee/DOCS.md) (also rendered as the add-on's
Documentation tab in HA).

**A note on hardware:** the brain sends real prompts — a few thousand tokens once
your Assist-exposed entities are included. A model server on a GPU or
Apple-silicon box answers in seconds; a CPU-only HA box can take minutes per
turn. If your HA box is modest, run the engines on a faster machine on your LAN.

## Development tools

[`tools/`](tools/) holds the maintainers' remote dev rig (ingress shell,
Supervisor API client, full-pipeline test runner). Not needed to use the add-on.

## License

[AGPL-3.0](LICENSE). Operated by the makers of [Dashie](https://dashieapp.com).
