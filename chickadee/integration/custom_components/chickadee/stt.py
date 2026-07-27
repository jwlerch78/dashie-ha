"""Chickadee speech-to-text entity — streams Assist audio to the add-on's STT engine.

The add-on owns which engine actually transcribes (BYO OpenAI-compatible server
now; hosted Chickadee Cloud engines with the account port). This entity collects
the pipeline's PCM stream, wraps it in a WAV container, and POSTs it over the
bridge (CONTRACTS.md: POST /api/voice/stt, audio/wav in → {text} out).
"""

from __future__ import annotations

import json
import logging
import struct
from collections.abc import AsyncIterable

from homeassistant.components import stt
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .addon_bridge import AddonUnavailable, call_addon_raw
from .const import ADDON_STT_PATH, SUPPORTED_LANGUAGES, UNIQUE_ID_STT

_LOGGER = logging.getLogger(__name__)

# Bound the collected utterance: 16 kHz * 2 bytes * 60 s = ~1.9 MB; 10 MB is generous.
_MAX_AUDIO_BYTES = 10 * 1024 * 1024


def _wav_header(pcm_len: int, rate: int, channels: int, width: int) -> bytes:
    """Minimal RIFF/WAVE header for a PCM payload."""
    byte_rate = rate * channels * width
    return (
        b"RIFF" + struct.pack("<I", 36 + pcm_len) + b"WAVE"
        + b"fmt " + struct.pack("<IHHIIHH", 16, 1, channels, rate, byte_rate, channels * width, width * 8)
        + b"data" + struct.pack("<I", pcm_len)
    )


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    async_add_entities([ChickadeeSttEntity()])


class ChickadeeSttEntity(stt.SpeechToTextEntity):
    """One STT entity per install; the add-on routes to the configured engine."""

    _attr_name = "Chickadee STT"
    _attr_unique_id = UNIQUE_ID_STT

    @property
    def supported_languages(self) -> list[str]:
        return SUPPORTED_LANGUAGES

    @property
    def supported_formats(self) -> list[stt.AudioFormats]:
        return [stt.AudioFormats.WAV]

    @property
    def supported_codecs(self) -> list[stt.AudioCodecs]:
        return [stt.AudioCodecs.PCM]

    @property
    def supported_bit_rates(self) -> list[stt.AudioBitRates]:
        return [stt.AudioBitRates.BITRATE_16]

    @property
    def supported_sample_rates(self) -> list[stt.AudioSampleRates]:
        return [stt.AudioSampleRates.SAMPLERATE_16000]

    @property
    def supported_channels(self) -> list[stt.AudioChannels]:
        return [stt.AudioChannels.CHANNEL_MONO]

    async def async_process_audio_stream(
        self, metadata: stt.SpeechMetadata, stream: AsyncIterable[bytes]
    ) -> stt.SpeechResult:
        chunks: list[bytes] = []
        size = 0
        async for chunk in stream:
            size += len(chunk)
            if size > _MAX_AUDIO_BYTES:
                _LOGGER.warning("DROP: STT stream exceeded %s bytes — truncating", _MAX_AUDIO_BYTES)
                break
            chunks.append(chunk)
        pcm = b"".join(chunks)
        if not pcm:
            return stt.SpeechResult(None, stt.SpeechResultState.ERROR)

        wav = _wav_header(len(pcm), int(metadata.sample_rate), int(metadata.channel), 2) + pcm
        try:
            status, body, _ctype = await call_addon_raw(
                self.hass, ADDON_STT_PATH, wav, "audio/wav", timeout_s=60
            )
        except AddonUnavailable as err:
            _LOGGER.warning("DROP: Chickadee STT — add-on unavailable: %s", err)
            return stt.SpeechResult(None, stt.SpeechResultState.ERROR)

        if status >= 400:
            _LOGGER.warning("DROP: Chickadee STT — add-on HTTP %s: %s", status, body[:200])
            return stt.SpeechResult(None, stt.SpeechResultState.ERROR)
        try:
            text = str(json.loads(body.decode("utf-8")).get("text") or "")
        except (ValueError, UnicodeDecodeError) as err:
            _LOGGER.warning("DROP: Chickadee STT — unparseable add-on response: %s", err)
            return stt.SpeechResult(None, stt.SpeechResultState.ERROR)
        return stt.SpeechResult(text, stt.SpeechResultState.SUCCESS)
