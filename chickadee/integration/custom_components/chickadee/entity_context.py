"""Assist-exposed entity context, brain-shaped.

Port of the Dashie integration's exposed-entities enricher (single source of the
entity shape the brain reads: see that repo's 20260717_HA_ENTITY_EXPOSURE_CONTRACT.md).
Shape per entity: {entity_id, domain, friendly_name, state, area?, aliases?} —
area/aliases omitted when empty; ids with no current state skipped.
"""

from __future__ import annotations

import logging

from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

_LOGGER = logging.getLogger(__name__)

try:
    from homeassistant.components.homeassistant.exposed_entities import async_should_expose
except ImportError:  # pragma: no cover — very old HA
    async_should_expose = None


def _area_name_for(entity_id: str, ent_reg, dev_reg, area_reg) -> str | None:
    reg = ent_reg.async_get(entity_id)
    if reg is None:
        return None
    area_id = reg.area_id
    if not area_id and reg.device_id:
        device = dev_reg.async_get(reg.device_id)
        area_id = device.area_id if device else None
    if not area_id:
        return None
    area = area_reg.async_get_area(area_id)
    return area.name if area else None


def gather_exposed_entities(hass: HomeAssistant) -> list[dict]:
    """The Assist-exposed entity set, enriched for the brain. Never raises."""
    if async_should_expose is None:
        return []
    ent_reg = er.async_get(hass)
    dev_reg = dr.async_get(hass)
    area_reg = ar.async_get(hass)

    out: list[dict] = []
    for state in hass.states.async_all():
        entity_id = state.entity_id
        try:
            if not async_should_expose(hass, "conversation", entity_id):
                continue
            ent = {
                "entity_id": entity_id,
                "domain": entity_id.split(".")[0],
                "friendly_name": state.attributes.get("friendly_name") or "",
                "state": state.state,
            }
            area = _area_name_for(entity_id, ent_reg, dev_reg, area_reg)
            if area:
                ent["area"] = area
            reg = ent_reg.async_get(entity_id)
            raw_aliases = getattr(reg, "aliases", None) if reg is not None else None
            if raw_aliases:
                # Only real string aliases: reg.aliases can hold non-str objects that
                # json.dumps chokes on downstream.
                str_aliases = sorted(a for a in raw_aliases if isinstance(a, str) and a)
                if str_aliases:
                    ent["aliases"] = str_aliases
            out.append(ent)
        except Exception:  # noqa: BLE001 — one bad entity must never break a turn
            continue
    return out


def device_area_name(hass: HomeAssistant, device_id: str | None) -> str | None:
    """The area of the satellite device that heard the utterance (for room-aware commands)."""
    if not device_id:
        return None
    dev_reg = dr.async_get(hass)
    device = dev_reg.async_get(device_id)
    if device is None or not device.area_id:
        return None
    area = ar.async_get(hass).async_get_area(device.area_id)
    return area.name if area else None
