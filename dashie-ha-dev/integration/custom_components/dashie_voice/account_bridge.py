# SPDX-License-Identifier: AGPL-3.0-only
"""Account/sharing bridge — the LAN-sharing lane to the Dashie for Home Assistant add-on.

Ported from the Dashie integration's addon_bridge account helpers. The add-on
holds the household account JWT and the sharing opt-in; this module is the only
place the integration asks for them.

⚠️ THIS WHOLE MODULE IS THE ACCOUNT LANE, and a build with no account does not
ship it. The add-on calls that need no account (its own brain, the voice config,
a BYOK Live token) moved to `addon_voice.py` so that the brand boundary is a
file boundary — see that module's header for why a carve would have been worse.
Anything added here must genuinely need the account JWT or the sharing gate.

Semantics preserved from the Dashie lane (they are field-tested):
  - credential cache capped at 5 min so an account swap on the box can't vend
    the old JWT for days;
  - sharing re-checked (30s TTL) even on a credential cache hit, so a revoked
    toggle takes effect without waiting for JWT expiry;
  - everything fails CLOSED on sharing.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime

from homeassistant.core import HomeAssistant

from .addon_bridge import AddonUnavailable, SharingDisabled, call_addon_json
from .brain_target import set_reported_cloud_base

_LOGGER = logging.getLogger(__name__)

_SHARING_STATUS_PATH = "/api/internal/sharing-status"
_CREDENTIAL_PATH = "/api/internal/account-credential"
_AUTHORIZE_DEVICE_PATH = "/api/internal/authorize-device"

_REFRESH_SKEW = 120.0
_CREDENTIAL_TTL = 300.0
_SHARING_TTL = 30.0

_cache: dict = {"jwt": None, "exp": 0.0, "user_id": None}
_sharing_cache: dict = {"off": False, "exp": 0.0}


async def get_sharing_status(hass: HomeAssistant) -> dict:
    """The add-on's `{available, signed_in, household_sharing, reason, account_email?, cloud_url?}`.

    Never raises — unreachable → `{available: False, reason: "addon_unreachable"}`.

    Also the only place the add-on's reported cloud base arrives, so it hands
    that straight to `brain_target`, which owns where the brain is. The
    dependency runs THIS way deliberately: the account lane knows about the
    brain seam, the brain seam knows nothing about the account lane, so a build
    without this module still resolves a brain.
    """
    try:
        status, body = await call_addon_json(hass, _SHARING_STATUS_PATH)
    except AddonUnavailable:
        return {"available": False, "reason": "addon_unreachable"}
    if status != 200:
        return {"available": False, "reason": "bad_response"}
    if isinstance(body, dict) and isinstance(body.get("cloud_url"), str) and body["cloud_url"].startswith("https://"):
        set_reported_cloud_base(body["cloud_url"].rstrip("/"))
    return body or {"available": False, "reason": "bad_response"}


async def _sharing_is_off(hass: HomeAssistant) -> bool:
    """True only when the add-on POSITIVELY reports sharing OFF (30s-TTL cached)."""
    now = time.time()
    if now < _sharing_cache["exp"]:
        return _sharing_cache["off"]
    status = await get_sharing_status(hass)  # never raises
    off = status.get("household_sharing") is False
    _sharing_cache["off"] = off
    _sharing_cache["exp"] = now + _SHARING_TTL
    return off


async def get_account_credential(hass: HomeAssistant) -> str:
    """The account JWT for cloud calls on the account's behalf (cached, capped).

    Raises SharingDisabled when the opt-in is off, AddonUnavailable otherwise.
    """
    now = time.time()
    if await _sharing_is_off(hass):
        raise SharingDisabled("household sharing disabled")
    if _cache["jwt"] and now < _cache["exp"] - _REFRESH_SKEW:
        return _cache["jwt"]

    status, body = await call_addon_json(hass, _CREDENTIAL_PATH)
    if status == 403:
        raise SharingDisabled("household sharing disabled")
    jwt = body.get("jwt") if status == 200 else None
    if not jwt:
        raise AddonUnavailable(f"no credential (HTTP {status} — add-on not signed in?)")

    user_id = body.get("user_id")
    if _cache["user_id"] and user_id and user_id != _cache["user_id"]:
        _LOGGER.info("Account credential switched accounts (%s → %s)", _cache["user_id"], user_id)
    _cache["jwt"] = jwt
    _cache["user_id"] = user_id
    # Cap the cache lifetime; the JWT's own expiry still wins when SOONER.
    _cache["exp"] = min(
        _parse_expiry(body.get("jwt_expires_at"), now),
        now + _CREDENTIAL_TTL + _REFRESH_SKEW,
    )
    return jwt


def clear_credential_cache() -> None:
    """Drop cached credential + sharing state (account swap / explicit refresh)."""
    if _cache["jwt"]:
        _LOGGER.info("Account credential cache cleared")
    _cache["jwt"] = None
    _cache["exp"] = 0.0
    _cache["user_id"] = None
    _sharing_cache["exp"] = 0.0


async def authorize_device(hass: HomeAssistant, user_code: str) -> tuple[dict, int]:
    """Authorize a LAN kiosk's device code into the household account (Kiosk Real Login).

    Returns (body, status); never raises.
    """
    try:
        status, body = await call_addon_json(
            hass, _AUTHORIZE_DEVICE_PATH, method="post", payload={"user_code": user_code}
        )
        return body, status
    except AddonUnavailable as err:
        return {"error": "addon_unavailable", "message": f"Dashie for Home Assistant add-on unreachable: {err}"}, 503


def _parse_expiry(iso: str | None, now: float) -> float:
    if not iso:
        return now + 3600.0
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return now + 3600.0
