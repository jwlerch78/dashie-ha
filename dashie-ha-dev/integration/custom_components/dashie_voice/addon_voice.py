# SPDX-License-Identifier: AGPL-3.0-only
"""Voice lane to the add-on — the calls that need no account.

Split out of `account_bridge.py`, which had grown two lanes with one name. It
described itself as "the LAN-sharing lane" while holding three functions that
have nothing to do with sharing: the add-on's own brain, its voice config, and a
BYOK Live token minted from a key the box already stores. None of them touch the
household account, the sharing opt-in, or the account JWT.

WHY THE SPLIT IS A FILE AND NOT A COMMENT
-----------------------------------------
A build with no account ships this module and NOT `account_bridge.py`. Making
the brand boundary a file boundary means the branded variant drops one path
instead of carving eight functions out of a shared file — and a carve is the
fragile kind of change: it is invisible to a residue scan, it re-breaks whenever
the source file is edited, and the generator's block-dropper has eaten
neighbouring code doing exactly this before.

So the rule for anything added here: if it needs the account credential, the
sharing gate, or the account JWT, it belongs in the account lane, not here.
"""

from __future__ import annotations

import logging

from homeassistant.core import HomeAssistant

from .addon_bridge import AddonUnavailable, SharingDisabled, call_addon_json, ping_addon

_LOGGER = logging.getLogger(__name__)

_VOICE_CONFIG_PATH = "/api/internal/voice-config"
_LEASE_PATH = "/api/internal/voice-lease"
_CONVERSE_LOCAL_PATH = "/api/voice/converse-local"
_LIVE_TOKEN_PATH = "/api/keys/live-token"

# Brain turns on modest hardware can take minutes (see addon_bridge._TIMEOUT).
_BRAIN_TIMEOUT_S = 300


async def request_lease(hass: HomeAssistant, payload: dict) -> tuple[dict, int]:
    """Ask the add-on for a capability lease — issue and renew are one call.

    CONTRACTS #65. This integration is a PROXY and makes no grant decision of
    its own: a decision here would be a second source of truth, which is the
    class of bug the lease exists to remove. It passes the add-on's status
    through untouched, because the STATUS is the protocol —

      200  granted
      403  a definite refusal → the device self-destructs at once
      503  the add-on is unreachable, so grant state is UNKNOWN, not withdrawn
           → the device keeps its lease and retries until expiry

    Raises nothing: an unreachable add-on becomes the 503 above rather than an
    exception, so the caller cannot accidentally turn "I couldn't ask" into "the
    answer was no".
    """
    try:
        status, body = await call_addon_json(hass, _LEASE_PATH, method="post", payload=payload, timeout_s=15)
    except AddonUnavailable as err:
        _LOGGER.warning("DROP: lease unreachable (%s) — reporting UNKNOWN, not denied", err)
        return {"granted": False, "reason": "addon_unavailable"}, 503
    return body, status


async def get_addon_availability(hass: HomeAssistant) -> dict:
    """Can this box serve voice at all — the answer that needs no account.

    The BASE of the status probe in every build. A build with an account then
    overlays the richer account answer (signed in? sharing on? which email?)
    on top; a build without one stops here, and "available" means exactly what
    it can mean there: the add-on is reachable.

    Never raises.
    """
    ok = await ping_addon(hass)
    return {"available": ok, "reason": "ok" if ok else "addon_unreachable"}


async def get_voice_config(hass: HomeAssistant) -> dict:
    """The voice route + kiosk mirror block, as the add-on reports it. Never raises.

    Returns `{}` when the config could not be read — NOT a guessed route. This
    used to fail open to `{"route": "cloud"}`, which named a lane a no-cloud
    build does not have; callers now apply their own default, and the one that
    needs a route asks `brain_target.default_brain_route()`, which derives it
    from the build's brain seam.

    Returning `{}` is safe for every caller: the status probe already gates on
    `route in ("local","cloud")` and simply reports no route it could not read,
    and the wake-word/personality readers are all `.get(...)` with fallbacks.
    """
    try:
        status, body = await call_addon_json(hass, _VOICE_CONFIG_PATH)
    except AddonUnavailable as err:
        _LOGGER.warning("DROP: voice-config unreadable (add-on unavailable: %s) — caller defaults apply", err)
        return {}
    if status != 200:
        _LOGGER.warning("DROP: voice-config unreadable (HTTP %s) — caller defaults apply", status)
        return {}
    return body or {}


async def converse_local(hass: HomeAssistant, payload: dict) -> tuple[dict, int]:
    """Run a transcript through the add-on's own brain (/api/voice/converse-local).

    On the Dashie for Home Assistant add-on this routes per ITS config: Configuration-tab engines
    first, signed-in cloud fallback. Raises SharingDisabled on 403, AddonUnavailable
    when unreachable.

    The 403 is the one account-shaped thing here, and it is the ADD-ON's gate,
    not this integration's — a build with no account simply never receives one.
    Which is why the message says what actually happened (the add-on refused)
    rather than naming the Dashie-side reason: the exception type already
    carries the meaning, and only one build has that reason to give.
    """
    # 🔴 STRIP `stream`. converse-local answers with ONE buffered JSON turn — this
    # helper's callers hand the result straight back and have no NDJSON path. But the
    # DEVICE sets stream:true on every turn (BrainConverseClient.kt) and the payload was
    # forwarded verbatim, so the add-on was asked to stream and replied with an empty
    # body — which the transport turned into `{}` and the caller reported as a perfectly
    # ordinary HTTP 200 empty turn. A/B'd to certainty by Thread T on one field:
    # {"text":…} → a full valid turn, {"text":…,"stream":true} → {}. Every local-route
    # turn from a real device was empty. Sending a flag this endpoint cannot honour is
    # the bug; not forwarding it is the fix. (Copy the dict — the caller keeps its own.)
    body_payload = {k: v for k, v in (payload or {}).items() if k != "stream"}

    status, body = await call_addon_json(
        hass, _CONVERSE_LOCAL_PATH, method="post", payload=body_payload, timeout_s=_BRAIN_TIMEOUT_S
    )
    if status == 403:
        raise SharingDisabled("add-on refused the local brain call (HTTP 403)")

    # An empty turn on a 2xx is never legitimate — a real turn always carries content —
    # and reporting it as success is what made the defect above invisible. The transport
    # has already logged WHAT came back; this refuses to launder it into a good answer.
    if status < 400 and not body:
        _LOGGER.warning(
            "DROP: converse-local returned an empty turn on HTTP %s — refusing to report it as success",
            status,
        )
        return {"ok": False, "error": "converse_local_empty_turn", "status": status}, 502

    return body, status


async def mint_live_token(hass: HomeAssistant, model: str | None = None) -> tuple[dict, int]:
    """Mint a Live-only Gemini ephemeral token from the box's stored gemini key.

    Returns (body, status) — the same order as the other public helpers, so
    callers see one order and only the transport underneath deals in two.

    BYOK, not account: the key is one the box already holds. Only the token
    crosses — the raw key never leaves the box.

    Raises AddonUnavailable when unreachable.
    """
    payload: dict = {}
    if model:
        payload["model"] = model
    status, body = await call_addon_json(hass, _LIVE_TOKEN_PATH, method="post", payload=payload, timeout_s=15)
    return body, status
