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

**You do not need an account.** Open the Chickadee panel without signing in and
it shows your local-mode status — which engines are configured and where to
change them. Home Assistant has already authenticated you to reach the panel at
all, so there is nothing further to prove unless you want hosted compute. If you
point `llm_url`, `stt_url`, and `tts_url` at your own servers, you never sign in
and no Chickadee service is contacted.

Signing in is how you buy the hosted option, and that's all it is.

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
| `homeassistant_config:rw` | Two writes by the add-on: (1) the integration installer (below); (2) a fallback copy of the bridge secret at `<config>/.chickadee/bridge_secret` for older integration versions — Supervisor discovery is the primary channel. A third file, `<config>/.chickadee/loaded_hash`, appears in the same folder but is written by the *integration* running inside HA Core, not through this mount — see the installer note below. |
| `addon_config:rw` | **Granted but effectively unused.** Our own `/addon_configs/<slug>/` folder — it was meant to carry the bridge secret, but HA Core can't read that path on HAOS (verified 2026-07-25), so the secret goes via Supervisor discovery instead. Kept only for a future discovery handoff; listed here rather than quietly left in the manifest. |
| `backup_exclude` | Keeps your on-box API keys and account cache (`/data/api-keys.json`, `/data/account-config.cache.json`) **out of HA backups**. Note the scope: it covers those two `/data` files. Your console settings (`/data/chickadee_settings.json` — engine URLs and model ids when you use the add-on without an account) are **not** excluded: no secrets, so they ride along in backups and restore with them. The bridge secret's fallback copy at `<config>/.chickadee/bridge_secret` lives in your HA config directory, so it **is** included in HA backups — see "How the bridge auth works" below. |

**The integration installer** (`install_integration: true`, default): on
start, the add-on copies its bundled integration to
`/config/custom_components/chickadee` and marks the copy with a
`.installed_by_chickadee_addon` file. It only ever updates copies carrying
that marker — a HACS or manual install is **never touched**. It never
restarts Core on its own; it posts a notification and the panel banner, and
you click Restart. Turn it off to manage the integration yourself.

Installing a new copy also **deletes** the old
`<config>/custom_components/chickadee` — that is what "update" means here, and
it is why the marker check matters: without the marker the folder is left
alone entirely. The copy is staged at `…/chickadee.staging` first and swapped
in, so an interrupted update can't leave you with half an integration.

Because HA only loads a new integration version on restart, the integration
records which version Core actually has running in
`<config>/.chickadee/loaded_hash` (a 64-char hash, written by the integration
itself once HA starts it). The panel compares that against the version the
add-on installed, which is how it knows whether to show the "restart to apply"
nudge. Cosmetic — if the write fails, you get no nudge and nothing else
changes. Only add-on-managed installs write it; a HACS install has no marker,
so nothing is recorded.

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

## Who on your HA box can use the household account

Worth stating plainly, because it's a spending question. When you sign in and
turn **household sharing** on, the voice endpoints the integration exposes
(`/api/chickadee/voice/*`, `/api/chickadee/account/authorize`) are available to
**any logged-in Home Assistant user on your box — not just admins.** Any of
them can run voice turns that spend your Chickadee Cloud credits, and can
enroll a device into your household account.

That's deliberate. A dedicated **non-admin** HA user is the normal way to run a
wall tablet or kiosk, and that's exactly the token those devices present — so
requiring admin would break the households following the recommended practice,
in order to stop a household member from using a household feature.

The controls you actually have:

- **Household sharing is the switch.** It's off by default, fails closed, and
  turning it off revokes the devices that were enrolled through it. Sharing off
  → these endpoints return 403 and nothing can be spent.
- **Enrollment is attributed.** Authorizing a device logs the HA user who did
  it (`... authorized into the household account by HA user <name> (non-admin)`),
  so it's reviewable rather than anonymous.
- **Credits are a hard ceiling.** Metered usage stops at your balance; there's
  no overdraft, and auto-replenish is opt-in.

If you want stricter separation than that today, the answer is to not turn on
household sharing — run the box on your own engines (Local mode), which is
unmetered and needs no account at all.

## How the bridge auth works

At startup the add-on generates a random bridge secret and publishes it to the
integration via **Supervisor discovery** (the same credential channel the MQTT
broker uses); the integration presents it on every request
(`X-Chickadee-Bridge-Secret`), and anything without it gets a 401. The secret
never leaves the box. A copy is also written to `.chickadee/bridge_secret` in
the HA config directory as a fallback for older integration versions.

Two things about that fallback copy you should know:

- **It is in your HA backups.** `backup_exclude` only reaches files under
  `/data`; this copy is in your config directory, so a Home Assistant backup
  contains it. Treat an HA backup as containing this credential.
- **It is worth more than voice plumbing.** Presenting it to the add-on's
  `/api/internal/account-credential` returns your household account JWT. Any
  add-on with a config mount can read it — disclosed since 0.0.2 as `INTERIM`,
  and the reason the Supervisor-discovery channel above is the primary one.

The secret is generated once and persists in `/data/bridge_secret.txt` across
restarts and updates — it is **not** rotated on restart. Uninstalling the
add-on (which clears `/data`) generates a fresh one on the next install. So if
a backup containing the old secret concerns you, that's the reset.

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
