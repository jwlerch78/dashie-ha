"""Chickadee text-to-speech entity — asks the add-on's TTS engine for spoken audio.

The add-on owns which engine synthesizes (BYO OpenAI-compatible server now;
hosted Chickadee Cloud voices with the account port). Bridge contract
(CONTRACTS.md): POST /api/voice/tts {text, voice?} → audio/wav bytes.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from homeassistant.components import tts
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from homeassistant.core import callback

from .addon_bridge import AddonUnavailable, call_addon_raw
from .const import ADDON_TTS_PATH, ADDON_TTS_VOICES_PATH, SUPPORTED_LANGUAGES, UNIQUE_ID_TTS

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    async_add_entities([ChickadeeTtsEntity()])


class ChickadeeTtsEntity(tts.TextToSpeechEntity):
    """One TTS entity per install; the add-on routes to the configured engine."""

    _attr_name = "Chickadee TTS"
    _attr_unique_id = UNIQUE_ID_TTS
    _attr_default_language = "en-US"
    _attr_supported_languages = SUPPORTED_LANGUAGES
    _attr_supported_options = [tts.ATTR_VOICE]

    def __init__(self) -> None:
        self._voices: list[tts.Voice] = []

    async def async_added_to_hass(self) -> None:
        """Fetch the engine's voice catalog once for HA's native voice picker.

        async_get_supported_voices is a sync callback, so the catalog is
        prefetched here. Best-effort: no catalog → the picker falls back to
        free-text, synthesis is unaffected (engine default voice)."""
        await super().async_added_to_hass()
        try:
            status, body, _ctype = await call_addon_raw(
                self.hass, ADDON_TTS_VOICES_PATH, b"{}", "application/json", timeout_s=15
            )
            if status < 400:
                raw = json.loads(body.decode("utf-8")).get("voices") or []
                self._voices = [
                    tts.Voice(v["voice_id"], v.get("name") or v["voice_id"])
                    for v in raw
                    if isinstance(v, dict) and v.get("voice_id")
                ]
                _LOGGER.info("Chickadee TTS voice catalog: %d voices", len(self._voices))
        except (AddonUnavailable, ValueError, UnicodeDecodeError) as err:
            _LOGGER.debug("Chickadee TTS voice catalog unavailable: %s", err)

    @callback
    def async_get_supported_voices(self, language: str) -> list[tts.Voice] | None:
        return self._voices or None

    async def async_get_tts_audio(
        self, message: str, language: str, options: dict[str, Any]
    ) -> tts.TtsAudioType:
        payload = json.dumps(
            {"text": message, "voice": str(options.get(tts.ATTR_VOICE) or "")}
        ).encode("utf-8")
        try:
            status, body, ctype = await call_addon_raw(
                self.hass, ADDON_TTS_PATH, payload, "application/json", timeout_s=60
            )
        except AddonUnavailable as err:
            _LOGGER.warning("DROP: Chickadee TTS — add-on unavailable: %s", err)
            return None, None

        if status >= 400 or not body or "audio" not in (ctype or ""):
            _LOGGER.warning("DROP: Chickadee TTS — add-on HTTP %s (%s): %s", status, ctype, body[:200])
            return None, None
        # Extension follows the engine: BYO servers return WAV, the hosted
        # (Chickadee Cloud) voice returns MP3 (audio/mpeg).
        ext = "mp3" if "mpeg" in ctype or "mp3" in ctype else "wav"
        return ext, body
