# Bundled wake-word models

Two custom [microWakeWord](https://github.com/kahrendt/microWakeWord) models, plus
their manifests:

| File | Wake word | Selected by |
|---|---|---|
| `chickadee.tflite` / `.json` | "Chickadee" | `chickadee` — the default on this build |
| `hey_dashie.tflite` / `.json` | "Hey Dashie" | `hey_dashie` — for [Dashie](https://dashieapp.com) satellites |

## Provenance

Both models were **trained in-house by Dashie** (the makers of Chickadee — see
[PROVENANCE.md](../../../../../PROVENANCE.md)). They are original models, not
derivatives or re-labels of a community model.

They share the tensor signature of the community `okay_nabu` model, which is why
they load unmodified on the official `rhasspy/wyoming-microwakeword` add-on.

**The training pipeline is not yet public.** The weights here are the complete,
runnable artifact — nothing about using, inspecting, or redistributing them depends
on the trainer — but if you want to *reproduce* them, you can't do that from this
repo today. Said plainly rather than left to be discovered.

## License

The weights are released under this repository's **AGPL-3.0-only**, the same as the
rest of Chickadee. See [LICENSE](../LICENSE).

## Deployment

`satellite_wake.py` copies the selected model's `.json` + `.tflite` into
`/share/microwakeword/` so the `wyoming-microwakeword` add-on can load them via
`--custom-model-dir`. Only these custom words deploy anything — community wake words
(Okay Nabu, Hey Jarvis, Alexa) already ship with the official add-on and are
referenced by name. User-facing description of this write is in
[the add-on's DOCS.md](../../../../DOCS.md#permissions--what-this-add-on-touches).
