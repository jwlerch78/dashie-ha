# SPDX-License-Identifier: AGPL-3.0-only
"""The lease-nudge entity — the transport for "renew NOW" (CONTRACTS #71).

WHY AN ENTITY AND NOT AN EVENT
------------------------------
The first transport fired a custom HA event. It could not be delivered: Home
Assistant allowlists which event types a NON-ADMIN user may subscribe to, and a
wall tablet running as a non-admin user is the normal household topology. The
fast path was silently degrading to TTL-only — up to 30 minutes — for most real
installs, which is precisely the failure the nudge exists to prevent, arriving
through authorization where re-subscribing cannot help.

``state_changed`` is the one event a non-admin user CAN subscribe to. Proved on a
real box with the control beside it on the same connection: the tablet's user
subscribed and received ``state_changed``, while the same connection asking for
the custom event was refused ``unauthorized``.

(Wording note: this file generates into a free edition whose deny scan forbids
billing vocabulary, and rightly — a reader there should never meet a word
implying a paid tier that does not exist. The scan cannot tell a WebSocket
listener from a billing arrangement, and neither can a skimming human, so the
prose here says "subscribe to" and never the noun.)

🔴 THE STATE IS MEANINGLESS ON PURPOSE, AND THIS IS BINDING
-----------------------------------------------------------
The state is a timestamp. It carries no grant, no denial, no capability list —
nothing readable as a decision.

An entity differs from an event in one dangerous way: it PERSISTS and can be read
back. A state that said anything about authorization would become a second,
weaker, DURABLE source of truth for it — readable by anything on the box,
surviving restarts, and eventually consulted by some future code path that "just
wants to avoid a round-trip". That is the second authorization source the whole
lease design exists to prevent, and the one failure an entity can produce that an
event structurally could not.

The device's only question is *did this change*. It must never parse the value.

WHAT THE DEVICE DOES
--------------------
Any change — including ``unknown`` -> a timestamp after a restart — means renew
now, then obey the real answer. It must NOT self-destruct on the nudge itself:
that would make an unauthenticated signal a denial of service and add a second,
untested revocation path.
"""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

# 🔴 THE WIRE VALUE. The device matches the entity_id SUFFIX, never the whole id,
# because the domain differs per brand — matching the full id would put an
# edition-keyed constant on the device, the shape the API-prefix and header
# contracts had to live with and that this one is deliberately free of.
NUDGE_OBJECT_ID = f"{DOMAIN}_lease_nudge"
SERVICE_LEASE_NUDGE = "lease_nudge"

# Diagnostic only. The device must never branch on it, so a new reason never
# needs a device build.
_VALID_REASONS = ("sharing_changed", "config_changed", "manual")

NUDGE_SCHEMA = vol.Schema(
    {
        vol.Optional("reason", default="manual"): cv.string,
        vol.Optional("endpoint_ids"): vol.All(cv.ensure_list, [cv.string]),
    }
)


class LeaseNudgeSensor(SensorEntity):
    """Its state is the instant of the last nudge. Nothing else."""

    _attr_should_poll = False
    _attr_icon = "mdi:bell-ring-outline"
    # Not diagnostic-category: a diagnostic entity is hidden by default in some
    # dashboards, and an entity nobody can see is one nobody can debug.
    _attr_name = "Lease nudge"

    def __init__(self, entry: ConfigEntry) -> None:
        self._attr_unique_id = f"{entry.entry_id}_lease_nudge"
        self.entity_id = f"sensor.{NUDGE_OBJECT_ID}"
        self._reason: str | None = None
        self._endpoint_ids: list[str] | None = None
        # Deliberately None at startup rather than "now": a fresh state at setup
        # would nudge every satellite on every add-on restart, turning a restart
        # into a household-wide renewal storm.
        self._stamp: str | None = None

    @property
    def native_value(self) -> str | None:
        return self._stamp

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        attrs: dict[str, Any] = {}
        if self._reason:
            attrs["reason"] = self._reason
        if self._endpoint_ids:
            # Best-effort HINT from the add-on's observational record. Absent or
            # empty means everyone; being unlisted is never a denial.
            attrs["endpoint_ids"] = self._endpoint_ids
        return attrs

    def nudge(self, reason: str, endpoint_ids: list[str] | None) -> None:
        self._reason = reason if reason in _VALID_REASONS else "manual"
        self._endpoint_ids = endpoint_ids or None
        # utcnow, not now(): the value is compared by nobody, but a UTC instant
        # is the one form that reads the same in every household.
        self._stamp = dt_util.utcnow().isoformat()
        self.async_write_ha_state()
        _LOGGER.info(
            "LEASE: nudge raised reason=%s endpoints=%s",
            self._reason,
            ",".join(self._endpoint_ids) if self._endpoint_ids else "all",
        )


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    sensor = LeaseNudgeSensor(entry)
    async_add_entities([sensor])

    async def _handle(call: ServiceCall) -> None:
        sensor.nudge(call.data.get("reason", "manual"), call.data.get("endpoint_ids"))

    # Registered per entry but idempotent: a second config entry would simply
    # re-register the same handler name, and only one entry is ever expected.
    hass.services.async_register(DOMAIN, SERVICE_LEASE_NUDGE, _handle, schema=NUDGE_SCHEMA)
