# Chickadee Add-ons

Home Assistant add-on repository for [Chickadee](https://github.com/jwlerch78/chickadee) —
the voice/AI pipeline for Home Assistant.

## Add-ons

| Add-on | Description |
|---|---|
| **Chickadee** | The Chickadee brain runtime. Pairs with the `chickadee` integration to give your Assist pipeline a real brain — point it at any OpenAI-compatible model server (Ollama, llama.cpp, vLLM, LM Studio, or a cloud provider's compat endpoint with your own key). |

## Configuration

| Option | Meaning |
|---|---|
| `llm_url` | Base URL of an OpenAI-compatible model server (no trailing `/v1`), e.g. `http://homeassistant.local:11434` for an Ollama add-on, or a provider's compat endpoint. |
| `llm_model` | Model id to run, e.g. `qwen2.5:7b`. |
| `llm_api_key` | Bearer key for the endpoint — leave blank for local Ollama/llama.cpp. |

A note on hardware: the brain sends real prompts (a few thousand tokens once your
exposed entities are included). A small model on a GPU or an Apple-silicon box
answers in seconds; a CPU-only Home Assistant box can take minutes per turn.
If your HA box is modest, run the model server on a faster machine on your LAN
and point `llm_url` at it.

## Installation

1. Settings → Add-ons → Add-on Store → ⋮ → Repositories
2. Add `https://github.com/jwlerch78/chickadee-addons`
3. Install **Chickadee**, then add the **Chickadee** integration in
   Settings → Devices & Services.

## License

[AGPL-3.0](LICENSE)
