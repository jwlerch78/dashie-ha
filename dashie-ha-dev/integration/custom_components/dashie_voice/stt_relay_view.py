# SPDX-License-Identifier: AGPL-3.0-only
"""The tablet's Gemini STT relayed THROUGH Home Assistant to the add-on, with the add-on's answer intact.

POST /api/dashie_voice/voice/stt-relay   (HA-token auth, any HA user: see voice_view._actor)
    body   audio/wav (16 kHz mono PCM16, the same WAV the STT entity sends)
    →      the add-on's POST /api/voice/stt?engine=gemini, and its status + JSON body PASSED THROUGH VERBATIM:
           200 {text} · 402 {error:'insufficient_credits'} · 503 {error:'gemini_stt_no_key'} · 502 {...} · …
    503    {"reason": "addon_unavailable"}        the request was NEVER SENT (nothing happened; safe to retry)
    504    {"reason": "addon_outcome_unknown"}    sent, then the exchange failed: the add-on may have
                                                  billed credits. The tablet must NOT retry this turn elsewhere.
    400    {"reason": "bad_request", ...}         empty or oversized body; the add-on is not called
    EVERY response carries `X-Dashie-Stt-Relay: 1`, so the tablet can tell this route's own 404/503 apart from
    HA's 404 for a route that does not exist (an older integration). A bare 404 check could not (O, 10-12).

Why a view and not HA's STT entity: the entity (stt.py) must return HA's SpeechResult, which has no room for a
reason, so every add-on outcome reaches the tablet as one bare ERROR. That hides the one fact a fallback needs:
did anything happen? (HV-STT-GEMINI-ALIGNMENT-PLAN.md §9-§10; the double-charge window VH found.)
Key first, then credits, is the add-on's job (engines.js geminiSttBranch); nothing here spends anything.
"""
from __future__ import annotations

import logging

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .addon_bridge import AddonOutcomeUnknown, AddonUnavailable, call_addon_raw_phased
from .const import ADDON_STT_GEMINI_QUERY, ADDON_STT_PATH

_LOGGER = logging.getLogger(__name__)

STT_RELAY_URL = "/api/dashie_voice/voice/stt-relay"
RELAY_HEADER = {"X-Dashie-Stt-Relay": "1"}
MAX_AUDIO_BYTES = 10 * 1024 * 1024   # the STT entity's own bound (stt.py _MAX_AUDIO_BYTES)
RELAY_TIMEOUT_S = 60                 # the STT entity's own (stt.py timeout_s=60); a module constant so the test can shorten it


def _json(payload: dict, status: int) -> web.Response:
    return web.json_response(payload, status=status, headers=RELAY_HEADER)


class DashieVoiceSttRelayView(HomeAssistantView):
    """Tablet → HA → add-on Gemini STT, with the add-on's status and reason intact."""

    url = STT_RELAY_URL
    name = "api:dashie_voice:voice:stt-relay"
    requires_auth = True

    async def post(self, request: web.Request) -> web.Response:
        hass: HomeAssistant = request.app["hass"]
        try:
            wav = await request.read()
        except Exception:  # noqa: BLE001
            return _json({"reason": "bad_request", "error": "unreadable_body"}, 400)
        if not wav:
            return _json({"reason": "bad_request", "error": "empty_audio"}, 400)
        if len(wav) > MAX_AUDIO_BYTES:
            return _json({"reason": "bad_request", "error": "audio_too_large"}, 400)

        from .voice_view import _actor  # noqa: PLC0415 — one attribution helper; module-level would be circular
        try:
            status, body, ctype = await call_addon_raw_phased(
                hass, ADDON_STT_PATH + ADDON_STT_GEMINI_QUERY, wav, "audio/wav", timeout_s=RELAY_TIMEOUT_S,
            )
        except AddonUnavailable as err:
            _LOGGER.warning("DROP: Dashie Voice STT relay — add-on unavailable (never sent): %s", err)
            return _json({"reason": "addon_unavailable"}, 503)
        except AddonOutcomeUnknown as err:
            _LOGGER.warning(
                "DROP: Dashie Voice STT relay — OUTCOME UNKNOWN for %s (sent, then failed; may have been billed, "
                "do not retry): %s", _actor(request), err,
            )
            return _json({"reason": "addon_outcome_unknown"}, 504)

        if status >= 400:
            _LOGGER.info("Dashie Voice STT relay: add-on answered %s for %s: %s", status, _actor(request), body[:200])
        return web.Response(
            status=status, body=body, content_type=(ctype.split(";")[0].strip() or "application/json"),
            headers=RELAY_HEADER,
        )


def register_stt_relay_view(hass: HomeAssistant) -> None:
    """Register the STT relay (called from voice_view.register_voice_views)."""
    hass.http.register_view(DashieVoiceSttRelayView())
