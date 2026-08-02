# SPDX-License-Identifier: AGPL-3.0-only
"""WHERE the brain is — the one function that knows.

The gateway used to answer this three times over (`_cloud_base`, `_brain_url`,
`_stt_token_url` in voice_view.py), each reachable only by reading the function
above it. That is fine while there is one product. It stops being fine the moment
a second brand exists, because "where is the brain" is the thing that differs
between them — and a value that differs per brand, duplicated across call sites,
is the shape that breaks silently across a rename.

So this module owns the answer and nothing else. It imports only the transport
(`addon_bridge`) and is imported BY the account lane, never the other way round
— a build with no account lane does not ship `account_bridge.py`, and this
module still has to resolve a brain in that build.

WHAT THIS DOES NOT DO
---------------------
It does not POST. Callers still build their own request and handle their own
response, including the NDJSON streaming loop. That duplication is mechanical —
it does not rot across a rename — so consolidating it is a separate, larger
change that moves a shipped LAN-satellite path from "cloud with an account
credential" to "add-on that re-routes", and therefore owes an on-device run
before it can be called done. Tracked in the Dashie repo's build plan.

THE BRAND SEAM IS ONE CONSTANT
------------------------------
`_FALLBACK_CLOUD_BASE`. A build with an account cloud names it; a build without
one sets it to None, and the add-on becomes the brain — which is already the
stated architecture ("the add-on owns engine routing (cloud / BYOK / local) and
key custody", const.py). Nothing else in the gateway needs to know which brand it
is running as.
"""
from __future__ import annotations

from homeassistant.core import HomeAssistant

from .addon_bridge import AddonUnavailable, addon_brain_target

#: Fallback cloud base, used when the add-on is too old to report one. The
#: add-on is the real source (pushed in by the account lane on the first
#: sharing-status check); this is the floor under it.
#:
#: ⚠️ THIS CONSTANT IS THE BRAND SEAM. A build with no account cloud sets it to
#: None — that single change is what makes the add-on the brain for that build.
#: It is also self-policing: a branded variant that forgot to substitute it would
#: still carry this URL, and the generator's deny scan fails on exactly that.
_FALLBACK_CLOUD_BASE: str | None = "https://cwglbtosingboqepsmjk.supabase.co"

#: What the add-on reported, once it has. Set by the account lane, never read
#: from it — this module must not import `account_bridge`, because a build with
#: no account does not ship that module and this one still has to resolve a
#: brain. Pushing in beats pulling out for exactly that reason.
_reported_cloud_base: str | None = None


def set_reported_cloud_base(url: str) -> None:
    """Record the cloud base the add-on reported (account lane calls this)."""
    global _reported_cloud_base
    _reported_cloud_base = url


def cloud_base() -> str | None:
    """The account cloud base, or None when this build has no cloud at all."""
    return _reported_cloud_base or _FALLBACK_CLOUD_BASE


def default_brain_route() -> str:
    """The route to ASSUME when the authoritative one cannot be read.

    `get_voice_config` used to answer this itself by defaulting to "cloud" when
    the add-on was unreachable. In a build that HAS a cloud that guess is inert
    (the cloud lane needs an account credential from the same unreachable add-on,
    so it fails either way). In a build that has NO cloud it is wrong on its
    face: it names a route this build cannot take, over the add-on brain that is
    the only one it has.

    DERIVED from `cloud_base()` rather than declared, deliberately — a second
    per-brand constant is a second thing a branded variant can forget to
    substitute, and this seam is already exactly one constant.
    """
    return "cloud" if cloud_base() else "local"


async def brain_target(
    hass: HomeAssistant, cred: str | None = None
) -> tuple[str, dict[str, str]]:
    """Where to POST a VoiceRequest, and how to authenticate to it.

    Returns (url, headers). Raises AddonUnavailable when there is no cloud and
    the add-on cannot be reached — which for a no-cloud build is the only brain
    there is, so failing loudly is correct.

    `cred` is REQUIRED on a cloud build. This used to fetch one itself when the
    caller passed None, which was the module's only reason to import the account
    lane; no caller has ever relied on it (both pass a credential they already
    hold). Dropping it is what lets a no-account build ship this module unchanged.
    """
    base = cloud_base()
    if base:
        if cred is None:
            raise AddonUnavailable(
                "DROP: brain_target called without a credential on a cloud build — "
                "the caller must fetch one from the account lane"
            )
        return f"{base}/functions/v1/voice-conversation", {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {cred}",
            "apikey": cred,
        }

    # No cloud in this build: the add-on is the brain and owns engine routing.
    return await addon_brain_target(hass)
