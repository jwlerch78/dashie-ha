<p align="center">
  <img src="chickadee/logo.png" alt="Chickadee" width="420">
</p>

<h3 align="center">Voice &amp; AI for Home Assistant — plug and play.</h3>

<p align="center">
  <a href="https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fjwlerch78%2Fchickadee">
    <img src="https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg" alt="Add repository to my Home Assistant">
  </a>
</p>

---

Chickadee gives your Home Assistant voice assistant a real brain. Ask it
anything, tell it to do things around the house in plain language — "turn off
everything downstairs except the porch light" — and it understands, acts, and
answers back in a natural voice.

It works with the voice hardware you already have (Home Assistant Voice
Preview Edition, ESPHome satellites, tablets, wall dashboards), and it runs on
**your** terms: bring your own AI key, run everything on your own hardware, or
use Chickadee Cloud and skip the setup entirely.

## Install

**1.** Click the button above — or add this repository by hand:
Settings → Add-ons → Add-on Store → **⋮ → Repositories** → paste
`https://github.com/jwlerch78/chickadee`

**2.** Install **Chickadee** from the store, then press **Start**.
It sets everything else up for you — including the Chickadee integration.

**3.** Open the **Chickadee** panel in your sidebar and click
**Restart Home Assistant** when the banner asks.

**4.** After the restart: Settings → Devices &amp; Services →
**Configure** on the discovered Chickadee card. Done — you now have a
"Chickadee" voice assistant available to every Assist device.

Then open the Chickadee panel to choose how it thinks and speaks:

| | |
|---|---|
| **Cloud** | Best quality, zero setup. Sign in and go — metered credits, no subscription. |
| **Hybrid** | Cloud AI with free, private voice engines on your own hardware. |
| **Local** | Your own AI model and voice engines. Nothing leaves your network. Free. |

## What it can do

- Real smart-home control through your Assist-exposed devices — including
  multi-step commands, in one breath.
- Questions, timers, conversation — answered in a natural voice, not a beep.
- Works with any AI you point it at: local (Ollama, llama.cpp, vLLM,
  LM Studio) or your own key for Gemini, OpenAI, OpenRouter, and friends.
- Local speech engines supported out of the box: Whisper for ears,
  Kokoro/Piper for voice.

**Honest hardware note:** a language model needs somewhere real to run. A GPU
or Apple-silicon box on your network answers in seconds; a small CPU-only HA
box will take minutes per reply. Cloud and Hybrid exist for exactly that case.

## Works with your gear

| Satellite | Chickadee pipeline | Wake word (screen off) | Realtime conversation |
|---|---|---|---|
| **HA Voice PE / ESPHome satellites** | ✅ | ✅ on-device | ❌ |
| **[Dashie](https://dashieapp.com) tablets / TV** | ✅ | ✅ on-device | ✅ |
| **Fully Kiosk / browser dashboards** | ✅ via satellite cards | ⚠️ card-dependent | ❌ |

Wake word is your satellite's job — Chickadee begins where the wake word ends.
Realtime speech-to-speech (interrupt it mid-sentence, keep talking) can't ride
HA's standard pipeline on any satellite; today the Dashie app is the one
satellite we know of that supports it.

## How it works, in one paragraph

The add-on you just installed is the brain runtime: it receives the
speech-to-text, understanding, and text-to-speech stages from the Chickadee
integration (which it installs and keeps updated for you) and routes each one
to the engine you chose — local box, your API key, or Chickadee Cloud. The
deeper technical story, option reference, and engine recipes live in the
[add-on documentation](chickadee/DOCS.md) and the
[integration repository](https://github.com/jwlerch78/chickadee-integration).

## Free, open, and how the lights stay on

Chickadee is AGPL-3.0 and fully self-hostable — every capability works with
your own engines and keys, forever. **Chickadee Cloud** is the optional
convenience: hosted AI, ears, and voices, metered by usage with no
subscription. That's the whole business model, in the open.

Chickadee is built and operated by the makers of
[Dashie](https://dashieapp.com), the family dashboard for Home Assistant.

## For developers

- [Integration source](https://github.com/jwlerch78/chickadee-integration)
  (HACS / manual install for people who'd rather manage it themselves —
  the add-on's auto-installer never touches a HACS-managed copy)
- [Add-on internals & option reference](chickadee/DOCS.md)
- [`tools/`](tools/) — maintainers' headless dev rig (set `CHICKADEE_HA_HOST`)

## License

[AGPL-3.0](LICENSE)
