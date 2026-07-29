# SPDX-License-Identifier: AGPL-3.0-only
"""Auto-create the Chickadee Assist pipeline on config-entry setup.

The plug-and-play promise: install the add-on, add the integration, and a
working pipeline wired to conversation + STT + TTS appears — no manual Assist
configuration. Idempotent: any existing pipeline that references a Chickadee
entity is the user's (edits and all) and is left alone; we recreate only when
none exists. We never mark ours preferred — that's the user's call.

The public assist_pipeline helper (async_create_default_pipeline) hardcodes the
Home Assistant conversation agent, so we build the settings dict ourselves and
create through the pipeline store — the same path the frontend's
assist_pipeline/pipeline/create WS command takes (verified against HA 2026.5).
The store import is internal API: it's guarded, and a future HA refactor
degrades to a loud DROP warning, never a failed setup.
"""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import async_track_state_added_domain
from homeassistant.util import language as language_util

from . import satellite_wake
from .const import (
    CONF_ASSISTANT_NAME,
    DEFAULT_ASSISTANT_NAME,
    DOMAIN,
    SUPPORTED_LANGUAGES,
    UNIQUE_ID_CONVERSATION,
    UNIQUE_ID_STT,
    UNIQUE_ID_TTS,
)

_LOGGER = logging.getLogger(__name__)


def _best_language(preferred: str, supported: list[str]) -> str:
    """Pick the supported language tag closest to the install's language."""
    matches = language_util.matches(preferred, supported)
    return matches[0] if matches else supported[0]


async def async_ensure_pipeline(
    hass: HomeAssistant, entry: ConfigEntry, wake_word_id: str | None = None
) -> None:
    """Create the Chickadee Assist pipeline if no pipeline references our entities.

    Called after platform setup so the entities exist in the registry. Any
    failure is a loud WARN, never a failed entry setup — voice still works via
    a manually-built pipeline.

    `wake_word_id` is the household's default wake word (console
    VoiceAiOptions.WAKE_WORDS id). For our custom words we wire the satellite
    wake stage to the wyoming-microwakeword add-on when it's present; otherwise
    the pipeline is created with wake unset and a DROP-warn tells the user to
    install/configure the add-on (same detect-and-guide flow as Wyoming STT/TTS).
    """
    try:
        from homeassistant.components.assist_pipeline import async_get_pipelines
        from homeassistant.components.assist_pipeline.pipeline import (
            async_setup_pipeline_store,
        )
    except ImportError as err:
        _LOGGER.warning(
            "DROP: assist_pipeline store API changed — cannot auto-create the "
            "Chickadee pipeline, create one manually in Settings > Voice assistants (%s)",
            err,
        )
        return

    ent_reg = er.async_get(hass)
    conversation_id = ent_reg.async_get_entity_id(
        "conversation", DOMAIN, UNIQUE_ID_CONVERSATION
    )
    stt_id = ent_reg.async_get_entity_id("stt", DOMAIN, UNIQUE_ID_STT)
    tts_id = ent_reg.async_get_entity_id("tts", DOMAIN, UNIQUE_ID_TTS)

    if conversation_id is None:
        _LOGGER.warning(
            "DROP: Chickadee conversation entity not registered yet — pipeline not created"
        )
        return

    # Idempotency: any pipeline touching a Chickadee entity — whatever the user
    # renamed or rewired around it — counts as ours already existing.
    ours = {conversation_id, stt_id, tts_id} - {None}
    for pipeline in async_get_pipelines(hass):
        if {pipeline.conversation_engine, pipeline.stt_engine, pipeline.tts_engine} & ours:
            _LOGGER.debug(
                "Chickadee pipeline already present ('%s') — leaving it untouched",
                pipeline.name,
            )
            return

    if stt_id is None or tts_id is None:
        # A conversation-only pipeline is still useful (text Assist); WARN loudly.
        _LOGGER.warning(
            "DROP: Chickadee STT/TTS entity missing (stt=%s tts=%s) — creating a "
            "reduced pipeline",
            stt_id,
            tts_id,
        )

    language = hass.config.language or "en"
    engine_language = _best_language(language, SUPPORTED_LANGUAGES)
    name = entry.data.get(CONF_ASSISTANT_NAME) or DEFAULT_ASSISTANT_NAME

    # Satellite wake: pair our custom word with the wyoming-microwakeword entity
    # if it's live. None,None when the add-on isn't configured yet — pipeline is
    # still created (wake unset), with guidance below.
    wake_entity, wake_id = satellite_wake.resolve_wake(hass, wake_word_id)
    if satellite_wake.is_custom_wake(wake_word_id) and wake_entity is None:
        _LOGGER.warning(
            "DROP: wake word '%s' selected but no wyoming-microwakeword entity found "
            "— install the add-on and point --custom-model-dir at %s (the model is "
            "already deployed there); satellites won't wake until then",
            wake_word_id,
            satellite_wake.SHARE_MWW_DIR,
        )

    settings = {
        "conversation_engine": conversation_id,
        "conversation_language": language,
        "language": language,
        "name": name,
        "stt_engine": stt_id,
        "stt_language": engine_language if stt_id else None,
        "tts_engine": tts_id,
        "tts_language": engine_language if tts_id else None,
        # None = the add-on's configured default voice (tts_voice option).
        "tts_voice": None,
        "wake_word_entity": wake_entity,
        "wake_word_id": wake_id,
    }

    try:
        pipeline_data = await async_setup_pipeline_store(hass)
        pipeline = await pipeline_data.pipeline_store.async_create_item(settings)
    except Exception as err:  # noqa: BLE001 — never fail entry setup over this
        _LOGGER.warning("DROP: Chickadee pipeline creation failed: %s", err)
        return

    _LOGGER.info(
        "CHICKADEE-PIPELINE created '%s' (id=%s) conversation=%s stt=%s tts=%s wake=%s",
        name,
        pipeline.id,
        conversation_id,
        stt_id,
        tts_id,
        wake_entity or "unset",
    )


def _our_entity_ids(hass: HomeAssistant) -> set[str]:
    """The Chickadee-owned pipeline entity ids currently in the registry."""
    ent_reg = er.async_get(hass)
    return {
        ent_reg.async_get_entity_id("conversation", DOMAIN, UNIQUE_ID_CONVERSATION),
        ent_reg.async_get_entity_id("stt", DOMAIN, UNIQUE_ID_STT),
        ent_reg.async_get_entity_id("tts", DOMAIN, UNIQUE_ID_TTS),
    } - {None}


async def _apply_wake_to_pipeline(
    hass: HomeAssistant, wake_entity: str, wake_id: str | None
) -> bool:
    """Set wake on the existing Chickadee pipeline if it's currently unset.

    Returns True when there's nothing left to do — either we set it, or the user
    already chose a wake entity (never override that). False means keep watching.
    """
    try:
        from homeassistant.components.assist_pipeline import async_get_pipelines
        from homeassistant.components.assist_pipeline.pipeline import (
            async_setup_pipeline_store,
        )
    except ImportError:
        return False

    ours = _our_entity_ids(hass)
    for pipeline in async_get_pipelines(hass):
        if not (
            {pipeline.conversation_engine, pipeline.stt_engine, pipeline.tts_engine} & ours
        ):
            continue
        if pipeline.wake_word_entity:
            return True  # already has wake (ours or the user's) — stop watching
        try:
            store_data = await async_setup_pipeline_store(hass)
            await store_data.pipeline_store.async_update_item(
                pipeline.id,
                {"wake_word_entity": wake_entity, "wake_word_id": wake_id},
            )
        except Exception as err:  # noqa: BLE001 — best-effort, never crash a callback
            _LOGGER.warning(
                "DROP: could not wire wake into pipeline '%s': %s", pipeline.name, err
            )
            return False
        _LOGGER.info(
            "CHICKADEE-WAKE self-healed pipeline '%s' -> wake=%s (%s)",
            pipeline.name,
            wake_entity,
            wake_id,
        )
        return True
    return False


async def async_wire_wake_when_ready(
    hass: HomeAssistant, entry: ConfigEntry, wake_word_id: str | None
) -> None:
    """Self-heal wake if the add-on is installed AFTER integration setup.

    When a custom wake word is selected but no wyoming-microwakeword entity is up
    yet, the pipeline is created with wake unset. Rather than force an integration
    reload, watch the wake_word domain and wire the pipeline the moment the entity
    appears. One-shot (unsubscribes on success); cleaned up on entry unload.
    """
    if not satellite_wake.is_custom_wake(wake_word_id):
        return
    wake_entity, _ = satellite_wake.resolve_wake(hass, wake_word_id)
    if wake_entity is not None:
        return  # already wired at creation — nothing to wait for

    async def _on_wake_entity_added(_event: Event) -> None:
        entity, wake_id = satellite_wake.resolve_wake(hass, wake_word_id)
        if entity is None:
            return
        if await _apply_wake_to_pipeline(hass, entity, wake_id):
            unsub()

    unsub = async_track_state_added_domain(hass, "wake_word", _on_wake_entity_added)
    entry.async_on_unload(unsub)
