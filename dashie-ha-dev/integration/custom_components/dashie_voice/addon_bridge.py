# SPDX-License-Identifier: AGPL-3.0-only
"""Bridge to the Dashie for Home Assistant add-on — discovery, auth, and the single brain POST site.

Ported from the Dashie integration's addon_bridge (subset). The add-on owns engine
routing and key custody; this module is the only place the integration reaches it.
"""

from __future__ import annotations

import glob
import json
import logging
import os
import time

from aiohttp import ClientTimeout
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    ADDON_CANDIDATES,
    ADDON_CONVERSE_PATH,
    ADDON_PING_PATH,
    ADDON_PORT,
    BRIDGE_HEADER,
)

_LOGGER = logging.getLogger(__name__)

SUPERVISOR_URL = "http://supervisor"

# Turn budget: a BACKSTOP against a hung add-on, not the UX budget — satellites
# impose their own pipeline timeouts. A local model on modest CPU hardware (the
# open build's common case) can legitimately take minutes on the brain's long
# prompts (measured: ~4.5 min for a 49-entity turn on a 4-core HAOS box);
# dropping a turn the model finishes later is strictly worse than waiting.
_TIMEOUT = ClientTimeout(total=300)
_PING_TIMEOUT = ClientTimeout(total=5)

# Resolved add-on base is cached: rediscovery on every turn would add a Supervisor
# round-trip to voice latency. A failed call clears the cache so the next turn
# rediscovers (add-on restarted, container renamed, …).
_CACHE_TTL_S = 300
_base_cache: tuple[str, float] | None = None


class AddonUnavailable(Exception):
    """The Dashie for Home Assistant add-on can't be reached (not installed, stopped, or no bridge secret)."""


class SharingDisabled(AddonUnavailable):
    """Add-on reachable + signed in, but household cloud sharing is off (HTTP 403).

    Lives here, with the transport that produces it, rather than in the account
    lane that mostly raises it: `addon_voice.converse_local` also turns a 403
    into this, and an exception type shared by two lanes belongs under both. A
    build with no account never sees a 403 and so never raises it.
    """


_secret_cache: str | None = None


def set_bridge_config(secret: str | None, host: str | None, port: int | None) -> None:
    """Prime the bridge with Supervisor-discovery credentials (from the config
    entry, at setup). Discovery is the PRIMARY channel; passing an empty secret
    leaves the legacy file-read fallback in charge. Also seeds the base cache
    with the discovered host so the first turn skips candidate probing."""
    global _secret_cache, _base_cache  # noqa: PLW0603
    if secret:
        _secret_cache = secret
    if host:
        _base_cache = (f"http://{host}:{port or ADDON_PORT}", time.monotonic())


def _read_bridge_secret_sync(hass: HomeAssistant) -> str | None:
    """Read the shared secret the add-on drops in its addon_config folder.

    Primary (works on HAOS, verified 2026-07-25): `.dashie_voice/bridge_secret`
    inside the HA config dir — the add-on writes it via its homeassistant_config
    mount, because HA Core does NOT see /addon_configs on HAOS. INTERIM channel
    (other add-ons with a config mount can read it); replace with Supervisor
    discovery (CONTRACTS.md).

    Fallbacks: the addon_config folder, named after the INSTALLED slug, which
    carries an install-dependent prefix (`local_dashie_ha` from /addons,
    `<repo-hash>_dashie_ha` from a repo channel) — so glob for *dashie_ha.
    """
    candidates: list[str] = [hass.config.path(".dashie_voice/bridge_secret")]
    for root in (hass.config.path("addon_configs"), "/addon_configs"):
        candidates.extend(sorted(glob.glob(os.path.join(root, "*dashie_ha", "bridge_secret"))))
    for path in candidates:
        try:
            with open(path, encoding="utf-8") as fh:
                secret = fh.read().strip()
            if secret:
                return secret
        except OSError:
            continue
    return None


async def _read_bridge_secret(hass: HomeAssistant) -> str | None:
    """Cached, executor-wrapped secret read (file I/O off the event loop)."""
    global _secret_cache  # noqa: PLW0603
    if _secret_cache:
        return _secret_cache
    _secret_cache = await hass.async_add_executor_job(_read_bridge_secret_sync, hass)
    if _secret_cache:
        _LOGGER.info("Dashie Voice bridge secret loaded from addon_config")
    return _secret_cache


async def _discover_via_supervisor(session) -> list[str]:
    """Ask the Supervisor for the Dashie for Home Assistant add-on's hostname (supervised installs only)."""
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        return []
    try:
        async with session.get(
            f"{SUPERVISOR_URL}/addons",
            headers={"Authorization": f"Bearer {token}"},
            timeout=_PING_TIMEOUT,
        ) as resp:
            data = await resp.json(content_type=None)
    except Exception:  # noqa: BLE001 — discovery is best-effort; candidates cover the rest
        return []
    bases = []
    for addon in (data.get("data") or {}).get("addons") or []:
        slug = addon.get("slug") or ""
        # Match every Dashie-for-HA channel, not just the prod slug: the dev add-on's
        # slug is `<hash>_dashie_ha_dev`, which does NOT end with "dashie_ha" —
        # so the old check skipped it and the integration could never reach the
        # dev add-on (addon_unreachable; kiosks never picked up the account).
        if "dashie_ha" in slug and addon.get("state") == "started":
            hostname = addon.get("hostname") or slug.replace("_", "-")
            bases.append(f"http://{hostname}:8099")
    return bases


async def _resolve_base(hass: HomeAssistant) -> str:
    """Find a reachable add-on base URL, preferring the cached one."""
    global _base_cache  # noqa: PLW0603
    if _base_cache and (time.monotonic() - _base_cache[1]) < _CACHE_TTL_S:
        return _base_cache[0]

    session = async_get_clientsession(hass)
    candidates = await _discover_via_supervisor(session)
    candidates.extend(b for b in ADDON_CANDIDATES if b not in candidates)

    for base in candidates:
        try:
            async with session.get(f"{base}{ADDON_PING_PATH}", timeout=_PING_TIMEOUT) as resp:
                if resp.status < 500:
                    _base_cache = (base, time.monotonic())
                    return base
        except Exception:  # noqa: BLE001 — unreachable candidate, try the next
            continue
    raise AddonUnavailable(f"no reachable Dashie for Home Assistant add-on (tried {len(candidates)} bases)")


async def addon_brain_target(hass: HomeAssistant) -> tuple[str, dict[str, str]]:
    """Where the ADD-ON brain is, and how to authenticate to it.

    Split out of call_addon_brain so a caller that must own its own request —
    the LAN gateway, which streams — can reach the same endpoint with the same
    credential rather than re-deriving either. Raises AddonUnavailable for the
    same reasons, at the same point.
    """
    secret = await _read_bridge_secret(hass)
    if not secret:
        raise AddonUnavailable("bridge secret not found — is the add-on installed?")
    base = await _resolve_base(hass)
    return f"{base}{ADDON_CONVERSE_PATH}", {
        "Content-Type": "application/json",
        BRIDGE_HEADER: secret,
    }


async def call_addon_brain(hass: HomeAssistant, payload: dict) -> tuple[dict, int]:
    """POST a VoiceRequest to the add-on brain. THE one brain POST site (seam rule).

    Returns (turn, status) with status normalized to 200 on any <400 response.
    Raises AddonUnavailable when the add-on or its bridge secret is missing.
    """
    global _base_cache  # noqa: PLW0603
    secret = await _read_bridge_secret(hass)
    if not secret:
        raise AddonUnavailable("bridge secret not found — is the Dashie for Home Assistant add-on installed?")

    base = await _resolve_base(hass)
    session = async_get_clientsession(hass)
    try:
        async with session.post(
            f"{base}{ADDON_CONVERSE_PATH}",
            json=payload,
            headers={"Content-Type": "application/json", BRIDGE_HEADER: secret},
            timeout=_TIMEOUT,
        ) as resp:
            turn = await resp.json(content_type=None)
            return turn, (200 if resp.status < 400 else resp.status)
    except AddonUnavailable:
        raise
    except Exception as err:  # noqa: BLE001
        _base_cache = None  # force rediscovery next turn
        raise AddonUnavailable(f"brain call failed: {err}") from err


async def call_addon_raw(
    hass: HomeAssistant,
    path: str,
    body: bytes,
    content_type: str,
    timeout_s: int = 60,
) -> tuple[int, bytes, str]:
    """POST raw bytes to an add-on endpoint (STT audio in, TTS audio out).

    Returns (status, response_bytes, response_content_type). Raises
    AddonUnavailable when the add-on or its bridge secret is missing.
    """
    global _base_cache  # noqa: PLW0603
    secret = await _read_bridge_secret(hass)
    if not secret:
        raise AddonUnavailable("bridge secret not found — is the Dashie for Home Assistant add-on installed?")

    base = await _resolve_base(hass)
    session = async_get_clientsession(hass)
    try:
        async with session.post(
            f"{base}{path}",
            data=body,
            headers={"Content-Type": content_type, BRIDGE_HEADER: secret},
            timeout=ClientTimeout(total=timeout_s),
        ) as resp:
            payload = await resp.read()
            return resp.status, payload, resp.headers.get("Content-Type", "")
    except AddonUnavailable:
        raise
    except Exception as err:  # noqa: BLE001
        _base_cache = None  # force rediscovery next call
        raise AddonUnavailable(f"add-on call failed: {err}") from err


async def call_addon_json(
    hass: HomeAssistant,
    path: str,
    *,
    method: str = "get",
    payload: dict | None = None,
    timeout_s: int = 5,
) -> tuple[int, dict]:
    """Call a JSON add-on endpoint with the bridge secret. Returns (status, body).

    The generic transport under account_bridge.py (the LAN-sharing lane) —
    call_addon_brain/call_addon_raw stay the voice-turn sites. Raises
    AddonUnavailable when the add-on or its bridge secret is missing.
    """
    global _base_cache  # noqa: PLW0603
    secret = await _read_bridge_secret(hass)
    if not secret:
        raise AddonUnavailable("bridge secret not found — is the Dashie for Home Assistant add-on installed?")

    base = await _resolve_base(hass)
    session = async_get_clientsession(hass)
    try:
        async with session.request(
            method.upper(),
            f"{base}{path}",
            json=payload,
            headers={BRIDGE_HEADER: secret},
            timeout=ClientTimeout(total=timeout_s),
        ) as resp:
            raw = await resp.text()
            try:
                body = json.loads(raw) if raw and raw.strip() else None
            except ValueError:
                body = None
            # 🔴 The `{}` fallback stays (this is the shared transport — every caller
            # already reads a dict and several treat empty as "use defaults"), but it is
            # no longer SILENT. A body we could not read used to vanish here with nothing
            # logged anywhere: the converse-local stream bug then surfaced as a perfectly
            # ordinary HTTP 200 empty turn, and the only evidence in the whole system was
            # the device's own blank-turn DROP. One log line is the difference between
            # that and a live debugging session.
            if not isinstance(body, dict):
                _LOGGER.warning(
                    "DROP: %s returned a body we cannot use — status=%s bytes=%d preview=%r",
                    path, resp.status, len(raw or ""), (raw or "")[:300].replace("\n", "\\n"),
                )
            return resp.status, (body if isinstance(body, dict) else {})
    except AddonUnavailable:
        raise
    except Exception as err:  # noqa: BLE001
        _base_cache = None  # force rediscovery next call
        raise AddonUnavailable(f"add-on call failed: {err}") from err


async def ping_addon(hass: HomeAssistant) -> bool:
    """Reachability probe for the config flow. Never raises."""
    try:
        await _resolve_base(hass)
        return True
    except AddonUnavailable:
        return False
