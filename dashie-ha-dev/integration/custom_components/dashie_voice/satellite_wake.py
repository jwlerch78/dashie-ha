# SPDX-License-Identifier: AGPL-3.0-only
"""Satellite wake word — deploy our microWakeWord models to the HA box and wire
the Assist pipeline's wake stage.

Our wake words (`hey_dashie`, `chickadee`) are custom microWakeWord models with
the identical tensor signature to the community `okay_nabu` model, so they run
unmodified on the official `rhasspy/wyoming-microwakeword` add-on — the box-side
wake engine for satellites that don't do wake detection themselves. Model
provenance and license: see `wake_models/README.md` next to the weights.

Pattern parity: Dashie never installs third-party add-ons (Piper/Whisper/
Ollama/Hermes are all detect-and-guide). The one thing STT/TTS don't need is
model deployment — those add-ons ship their own models; ours are custom, so we
place the manifest + tflite where the add-on's `--custom-model-dir` reads them.
The add-on lifecycle stays user-driven, exactly like Wyoming Piper/Whisper.

Deploy target `/share/microwakeword/` mirrors the established `/share/openwakeword`
convention. HA Core can write `/share` directly; blocking I/O runs in the executor.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from homeassistant.core import HomeAssistant

_LOGGER = logging.getLogger(__name__)

# Where the wyoming-microwakeword add-on should point --custom-model-dir. Mirrors
# the /share/openwakeword convention; /share is the only cross-add-on shared mount.
SHARE_MWW_DIR = "/share/microwakeword"

# Vendored bundle inside this package. Provenance + license: wake_models/README.md.
_BUNDLE_DIR = Path(__file__).parent / "wake_models"

# console VoiceAiOptions.WAKE_WORDS id -> (manifest, tflite, HA wake-word label).
# Only OUR custom words need deployment; community words (mww_okay_nabu, …) are
# already in the official repo and are referenced by name, not deployed.
WAKE_MODELS: dict[str, tuple[str, str, str]] = {
    "hey_dashie": ("hey_dashie.json", "hey_dashie.tflite", "Hey Dashie"),
    "chickadee": ("chickadee.json", "chickadee.tflite", "Chickadee"),
}


def is_custom_wake(wake_id: str | None) -> bool:
    """True for the wake words we ship models for (vs community / unset)."""
    return bool(wake_id) and wake_id in WAKE_MODELS


def _deploy_blocking(wake_id: str) -> str:
    """Copy the manifest + tflite for `wake_id` into SHARE_MWW_DIR. Runs in the
    executor. Returns the deployed manifest path. Raises on I/O failure."""
    manifest, model, _ = WAKE_MODELS[wake_id]
    dest = Path(SHARE_MWW_DIR)
    dest.mkdir(parents=True, exist_ok=True)
    for name in (manifest, model):
        src = _BUNDLE_DIR / name
        shutil.copy2(src, dest / name)
    return str(dest / manifest)


async def async_deploy_wake_model(hass: HomeAssistant, wake_id: str | None) -> bool:
    """Deploy the custom wake model for `wake_id` to /share/microwakeword.

    No-op (returns False) for community/unset words. Never raises — a deploy
    failure is a loud DROP, never a failed setup (voice still works; the user can
    place the model manually).
    """
    if not is_custom_wake(wake_id):
        return False
    try:
        path = await hass.async_add_executor_job(_deploy_blocking, wake_id)
    except OSError as err:
        _LOGGER.warning(
            "DROP: could not deploy '%s' wake model to %s — satellites can't use "
            "it until the file is placed manually (%s)",
            wake_id,
            SHARE_MWW_DIR,
            err,
        )
        return False
    _LOGGER.info(
        "DASHIE-WAKE deployed '%s' -> %s (point the wyoming-microwakeword "
        "add-on's --custom-model-dir at %s)",
        wake_id,
        path,
        SHARE_MWW_DIR,
    )
    return True


def resolve_wake(hass: HomeAssistant, wake_id: str | None) -> tuple[str | None, str | None]:
    """Resolve (wake_word_entity, wake_word_id) for the Assist pipeline.

    HA models a Wyoming wake service as ONE `wake_word` entity that offers many
    wake words; the pipeline picks the word via wake_word_id. We find a wake_word
    entity (the wyoming-microwakeword add-on, once configured) and pair it with
    our word's id. Returns (None, None) if no wake entity exists yet — caller
    leaves wake unset and DROP-warns, same as a missing STT/TTS entity.

    NOTE: not device-verified — the exact wake_word_id the add-on reports for a
    custom model may be the manifest stem or its wake_word label; we set the id
    Assist stores and let the add-on match. Confirm on a box with the add-on
    installed before relying on auto-selection.
    """
    if not is_custom_wake(wake_id):
        return None, None
    states = hass.states.async_entity_ids("wake_word")
    if not states:
        return None, None
    # Prefer an entity that looks like the microWakeWord service; else first wake entity.
    entity = next((e for e in states if "micro" in e.lower()), states[0])
    return entity, wake_id
