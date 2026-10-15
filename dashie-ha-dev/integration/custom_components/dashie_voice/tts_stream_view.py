# SPDX-License-Identifier: AGPL-3.0-only
"""Path K: a tablet's Gemini voice, streamed THROUGH Home Assistant from the add-on.

POST /api/dashie_voice/voice/tts-stream   (HA-token auth, any HA user: see voice_view._actor)
    body  {"text": str, "voice": str?, "voice_provider": str?}
          voice          = the voice to speak in: the household's Gemini voice name, or a personality's
                           ElevenLabs voice id (John 2026-10-15)
          voice_provider = which household-key lane: absent = Gemini (every tablet before 10-15),
                           'elevenlabs' = the add-on's ElevenLabs lane. Forwarded as-is; the add-on
                           refuses a provider it has no lane for (409 no_key), never the Gemini voice.
    200   audio/pcm, pcm_24000, streamed as the add-on produces it   (paid by the household's KEY)
    409   {"reason": "no_key"} | {"reason": "key_failed", "provider", "status"}   passed through verbatim
    503   {"reason": "addon_unavailable"}
    The tablet pays with credits ITSELF on any non-200 (it calls the edge gemini-tts directly); nothing
    here spends credits. The 409 status vocabulary is generated from the edge's (CONTRACTS.md; the
    add-on's dashie-ha/server/generated/key-health-vocab.js).

Why a view and not HA's own TTS: tts_get_url renders the whole clip before anything plays, and the
integration's TTS entity can return only (format, bytes) (tts.py). Gemini streams first audio in about a
second; the whole clip takes several. So this view pipes the add-on's bytes as they arrive, adding no
buffering of its own (VH measured the HA relay at ~0 ms on a Mac, 10-12; a lower bound, not a
validation).

The add-on side: dashie-ha/server/gemini-tts-lane.js streamWithKey, reached at the add-on's
POST /api/voice/tts with {"stream": true} (the same bridge-secret route as the TTS entity).
"""
from __future__ import annotations

import logging

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .addon_bridge import AddonUnavailable, stream_addon
from .const import ADDON_TTS_PATH

_LOGGER = logging.getLogger(__name__)

TTS_STREAM_URL = "/api/dashie_voice/voice/tts-stream"
MAX_CHARS = 5000
#: Headers that describe the audio, copied from the add-on's 200. Nothing else crosses.
#: 🔴 X-Tts-Provider is LOAD-BEARING: it names the lane that actually spoke ('gemini' / 'elevenlabs'), and the
#: tablet REFUSES an ElevenLabs request whose 200 lacks `X-Tts-Provider: elevenlabs` (VH's tablet ladder),
#: because an older add-on ignores voice_provider and would answer in the Gemini voice. That guard is only
#: as good as this pass-through: drop the header here and an ElevenLabs request is refused even when the
#: add-on served it correctly. The tablet fails closed; this list is what lets it see the truth.
PASS_HEADERS = ("Content-Type", "X-Audio-Format", "X-Streaming", "X-Tts-Payer", "X-Tts-Provider")


class DashieVoiceTtsStreamView(HomeAssistantView):
    """Tablet → HA → add-on Gemini TTS, streamed (path K)."""

    url = TTS_STREAM_URL
    name = "api:dashie_voice:voice:tts-stream"
    requires_auth = True

    async def post(self, request: web.Request) -> web.StreamResponse:
        hass: HomeAssistant = request.app["hass"]
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            return web.json_response({"reason": "bad_request", "error": "invalid_json"}, status=400)
        text = (body or {}).get("text")
        if not isinstance(text, str) or not text.strip():
            return web.json_response({"reason": "bad_request", "error": "text_required"}, status=400)
        voice = (body or {}).get("voice")
        voice_provider = (body or {}).get("voice_provider")
        payload = {"text": text[:MAX_CHARS], "stream": True}
        if isinstance(voice, str) and voice:
            payload["voice"] = voice
        if isinstance(voice_provider, str) and voice_provider:
            payload["voice_provider"] = voice_provider

        try:
            async with stream_addon(hass, ADDON_TTS_PATH, payload) as resp:
                if resp.status != 200:
                    # 409 no_key / key_failed (and any other refusal) pass through verbatim: the
                    # tablet routes on the body, and the add-on wrote the pill row before answering.
                    raw = await resp.read()
                    from .voice_view import _actor  # noqa: PLC0415 — one attribution helper; module-level would be circular
                    _LOGGER.info(
                        "Dashie Voice TTS stream: add-on answered %s for %s (tablet pays with credits)",
                        resp.status, _actor(request),
                    )
                    return web.Response(
                        status=resp.status, body=raw,
                        content_type=(resp.content_type or "application/json"),
                    )
                downstream = web.StreamResponse(
                    status=200,
                    headers={h: resp.headers[h] for h in PASS_HEADERS if h in resp.headers}
                    | {"Cache-Control": "no-store"},
                )
                await downstream.prepare(request)
                sent = 0
                try:
                    async for chunk in resp.content.iter_any():
                        await downstream.write(chunk)
                        sent += len(chunk)
                except Exception as err:  # noqa: BLE001
                    # After prepare() a status can't change: end short, loudly. The tablet hears a
                    # truncated reply rather than silence.
                    _LOGGER.warning("DROP: Dashie Voice TTS stream cut after %d bytes: %s", sent, err)
                try:
                    await downstream.write_eof()
                except Exception:  # noqa: BLE001
                    pass
                return downstream
        except AddonUnavailable as err:
            _LOGGER.warning("DROP: Dashie Voice TTS stream — add-on unavailable: %s", err)
            return web.json_response({"reason": "addon_unavailable"}, status=503)


def register_tts_stream_view(hass: HomeAssistant) -> None:
    """Register path K (called from voice_view.register_voice_views)."""
    hass.http.register_view(DashieVoiceTtsStreamView())
