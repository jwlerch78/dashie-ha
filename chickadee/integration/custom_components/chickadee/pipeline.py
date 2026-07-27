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
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.util import language as language_util

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


async def async_ensure_pipeline(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Create the Chickadee Assist pipeline if no pipeline references our entities.

    Called after platform setup so the entities exist in the registry. Any
    failure is a loud WARN, never a failed entry setup — voice still works via
    a manually-built pipeline.
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
        "wake_word_entity": None,
        "wake_word_id": None,
    }

    try:
        pipeline_data = await async_setup_pipeline_store(hass)
        pipeline = await pipeline_data.pipeline_store.async_create_item(settings)
    except Exception as err:  # noqa: BLE001 — never fail entry setup over this
        _LOGGER.warning("DROP: Chickadee pipeline creation failed: %s", err)
        return

    _LOGGER.info(
        "CHICKADEE-PIPELINE created '%s' (id=%s) conversation=%s stt=%s tts=%s",
        name,
        pipeline.id,
        conversation_id,
        stt_id,
        tts_id,
    )
