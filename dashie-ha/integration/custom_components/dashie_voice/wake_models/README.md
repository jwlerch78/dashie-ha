# Bundled wake-word models

Two custom [microWakeWord](https://github.com/kahrendt/microWakeWord) models, plus
their manifests:

| File | Wake word | Selected by |
|---|---|---|
| `hey_dashie.tflite` / `.json` | "Hey Dashie" | `hey_dashie` — the default | 
| `chickadee.tflite` / `.json` | "Chickadee" | `chickadee` — selectable alternative |

The `chickadee` model predates the 2026-07-30 brand consolidation. It is kept
because the weights are real and someone may have selected it; it is no longer
any build's default. See [PROVENANCE.md](https://github.com/jwlerch78/dashie-ha-console/blob/main/PROVENANCE.md).

## Provenance

Both models were **trained in-house by Dashie** (see
[PROVENANCE.md](https://github.com/jwlerch78/dashie-ha-console/blob/main/PROVENANCE.md)).
They are original models, not derivatives or re-labels of a community model.

<!-- Links to the add-on repo are absolute on purpose: this file ships at two
     different depths (canonical here, and vendored into the add-on image), so a
     relative path can only ever resolve in one of them. -->


They share the tensor signature of the community `okay_nabu` model, which is why
they load unmodified on the official `rhasspy/wyoming-microwakeword` add-on.

**The training pipeline is not yet public.** The weights here are the complete,
runnable artifact — nothing about using, inspecting, or redistributing them depends
on the trainer — but if you want to *reproduce* them, you can't do that from this
repo today. Said plainly rather than left to be discovered.

## License

The weights are released under this repository's **AGPL-3.0-only**, the same as the
rest of this integration. See [LICENSE](../LICENSE).

## Deployment

`satellite_wake.py` copies the selected model's `.json` + `.tflite` into
`/share/microwakeword/` so the `wyoming-microwakeword` add-on can load them via
`--custom-model-dir`. Only these custom words deploy anything — community wake words
(Okay Nabu, Hey Jarvis, Alexa) already ship with the official add-on and are
referenced by name. User-facing description of this write is in
[the add-on's DOCS.md](https://github.com/jwlerch78/dashie-ha-console/blob/main/dashie-ha/DOCS.md#permissions--what-this-add-on-touches).
