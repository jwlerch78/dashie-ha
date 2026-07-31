<p align="center">
  <img src="dashie-ha/logo.png" alt="Dashie" width="420">
</p>

<h3 align="center">Wall dashboards and voice for Home Assistant.</h3>

<p align="center">
  <a href="https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fjwlerch78%2Fdashie-ha">
    <img src="https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg" alt="Add repository to my Home Assistant">
  </a>
</p>

---

Dashie is a family dashboard for Home Assistant — calendar, photos, weather,
chores, and camera feeds on a wall tablet or an old TV — with a voice assistant
that understands what you actually said. "Turn off everything downstairs except
the porch light," and it does.

This repository is both the front door and the install target. The add-on you
paste into Home Assistant lives here, and so does the source for most of what
runs.

**You don't need a tablet to start.** The add-on works on its own: it gives every
Assist device you already own — HA Voice PE, ESPHome satellites, your phone — an
assistant with a real brain, no screen and no account required. For a lot of
people that is the whole product. Add a display later if you want the dashboard.

## Install the add-on

**1.** Click the button above — or add this repository by hand:
Settings → Add-ons → Add-on Store → **⋮ → Repositories** → paste
`https://github.com/jwlerch78/dashie-ha`

**2.** Install **Dashie for Home Assistant** from the store, then press **Start**.
It sets everything else up for you, including the Dashie Voice integration.

**3.** Open the **Dashie** panel in your sidebar and click **Restart Home
Assistant** when the banner asks.

**4.** After the restart: Settings → Devices & Services → **Configure** on the
discovered Dashie card. Done — every Assist device in the house now has a
"Dashie" voice assistant available.

## Add a screen

Optional, and it comes after the add-on works.

The dashboard runs on an Android tablet, a Fire TV, or anything else that takes
an APK — a $60 tablet on a wall bracket is the common setup. Grab the build from
[Releases](../../releases), sideload it, and point it at your Home Assistant.

That gets you your HA dashboards, plus calendar, photos, and weather, plus
hands-free voice with a wake word — the same assistant the add-on already gave
your satellites, now with a screen to draw on.

## Pick how it thinks

Choose in the Dashie panel, switch any time:

| | |
|---|---|
| **Cloud** | Best quality, zero setup. Sign in and go — metered credits, no subscription. |
| **Hybrid** | Cloud AI with free, private voice engines on your own hardware. |
| **Local** | Your own AI model and voice engines. Nothing leaves your network. Free. |

Going local? A language model needs somewhere real to run — a GPU or
Apple-silicon box on your network answers in seconds, a small CPU-only HA box
takes minutes. Cloud and Hybrid exist for exactly that case.

## What's open, what isn't, and what that means for self-hosting

"Open source" gets used loosely, so here is the specific version. Two of these
run without us and two don't:

| | License | Runs without us? |
|---|---|---|
| **Add-on** — server, console, AI brain | AGPL-3.0, in this repo | **Yes, completely.** In local mode nothing contacts a Dashie service — no account, no telemetry, not even a version ping. |
| **HA integration** | AGPL-3.0, [separate repo](https://github.com/jwlerch78/dashie-voice-integration) | **Yes.** |
| **`kiosk-overlay/`** — the Home-Assistant-facing web layer inside the tablet app | AGPL-3.0, in this repo | **Readable, not independently buildable.** It imports from Dashie's private app tree, so it is published to be inspected, not compiled. |
| **The tablet/TV app itself** | Closed. Built APK in [Releases](../../releases) | **No.** It signs in to Dashie's hosted backend, and its cloud voice path calls our endpoints at fixed addresses. |

Put plainly: **the voice add-on is genuinely self-hostable. The tablet app is
not.** If "open" means "I can run all of this on my own hardware forever," that
is true of the add-on and false of the app.

What the app *can* honestly claim is narrower and still worth something: you can
read its HA-facing layer, download the binary yourself, and keep a copy that
works if we disappear. Not that you could rebuild it from source.

We would rather you learn that here than find it out later.

## Works with your gear

| Satellite | Dashie pipeline | Wake word (screen off) | Realtime conversation |
|---|---|---|---|
| **HA Voice PE / ESPHome satellites** | ✅ | ✅ on-device | ❌ |
| **Dashie tablets / TV** | ✅ | ✅ on-device | ✅ |
| **Fully Kiosk / browser dashboards** | ✅ via satellite cards | ⚠️ card-dependent | ❌ |

Wake word runs wherever it makes sense for your hardware: on-device, or in the
pipeline for satellites that can't do it locally (experimental — we're building
it). Dashie ships custom microWakeWord models (`hey_dashie`, `chickadee`) that
run unmodified on the standard `wyoming-microwakeword` add-on, and supports the
community ones (Okay Nabu, Hey Jarvis, Alexa) referenced by name from the
official repo — use ours, use theirs, or bring your own. Realtime
speech-to-speech (interrupt it mid-sentence, keep talking) needs more than HA's
standard pipeline; today the Dashie app is the one satellite we know of that
supports it.

## How the lights stay on

The add-on is AGPL-3.0 and self-hostable — every capability works with your own
engines and keys, forever, and nothing in it is feature-gated on paying.
**Dashie Cloud** is the optional convenience: hosted AI, ears, and voices,
metered by usage with no subscription. The tablet app is the commercial product.
That's the whole business model, in the open.

Exactly what data leaves your box in each mode — local mode: nothing — is in
[PRIVACY.md](PRIVACY.md). Who builds what, which parts of the cloud are *not*
published and why, and how the money flows is in
[PROVENANCE.md](PROVENANCE.md). Both are written to be checked, not skimmed.

Dashie is **heavily AI-assisted, human-reviewed**, by one maintainer, on top of a
voice stack that has been running in real households since 2025 — which is why
the commit history is short and fast. Said here rather than only in
[PROVENANCE.md](PROVENANCE.md), because you shouldn't have to go looking. Judge
the code.

## Issues, and why there are no pull requests

**Bug reports and feature requests are genuinely wanted** —
[open an issue](../../issues/new/choose). Real-world HA setups are the thing one
maintainer cannot manufacture. Issues are read and triaged, bugs before feature
requests; no promised response time, because a promise nobody keeps is worse than
none.

**Pull requests are not accepted.** Not "not yet" — this is a read-and-fork
project, not a collaborative one, and it is more honest to say so than to leave a
contribution path open that dead-ends. Fork it, run it, change it for yourself;
that is what the license is for. If you have a fix, describe it in an issue with
the file and the reasoning and it can be acted on directly.

Integration issues (entities, config flow, pipeline setup) belong in
[dashie-voice-integration](https://github.com/jwlerch78/dashie-voice-integration/issues).

## For developers

- [Add-on internals & option reference](dashie-ha/DOCS.md) — the deeper technical
  story, engine recipes, and every config option
- [Integration source](https://github.com/jwlerch78/dashie-voice-integration) —
  HACS or manual install, for people who'd rather manage it themselves; the
  add-on's auto-installer never touches a HACS-managed copy
- [`kiosk-overlay/`](kiosk-overlay/) — the HA-facing web layer inside the tablet
  app (source, no build artifacts)
- [`tools/`](tools/) — maintainers' headless dev rig (set `DASHIE_HA_HOST`)

## License

[AGPL-3.0](LICENSE), including the network-use clause. The HA integration is
AGPL-3.0 too.
