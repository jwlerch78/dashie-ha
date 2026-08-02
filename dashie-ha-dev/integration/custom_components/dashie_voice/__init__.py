# SPDX-License-Identifier: AGPL-3.0-only
"""Dashie Voice — an open voice pipeline for Home Assistant.

The integration is the Assist-pipeline surface: conversation + STT + TTS
entities. The Dashie for Home Assistant add-on is the brain and engine router: it owns which
model/engine each entity actually talks to, plus key custody and the console
UI. They meet at the bridge (addon_bridge.py; contract in CONTRACTS.md).
"""

from __future__ import annotations

import logging
import os
import re

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.start import async_at_started

from .addon_voice import get_voice_config
from .addon_bridge import set_bridge_config
from .const import (
    CONF_BRIDGE_HOST,
    CONF_BRIDGE_PORT,
    CONF_BRIDGE_SECRET,
    DEVICE_SIBLING_DOMAIN,
)
from .pipeline import async_ensure_pipeline, async_wire_wake_when_ready
from .satellite_wake import async_deploy_wake_model
from .voice_view import register_voice_views

_LOGGER = logging.getLogger(__name__)

# SENSOR carries exactly one entity: the lease-nudge signal (CONTRACTS #71).
# It is a platform rather than a bare state write because the visibility proof
# that made this transport viable covers REGISTRY entities owned by an
# integration — a state-only entity written straight to the Core API would be
# trading a verified path for an unverified one in the exact area where the
# previous transport died of an unverified authorization assumption.
PLATFORMS: list[Platform] = [Platform.CONVERSATION, Platform.STT, Platform.TTS, Platform.SENSOR]

# hass.data flag — voice-gateway registration is once per HA run (views can't
# be unregistered), decided at HA start when every integration has set up.
_VOICE_VIEWS_KEY = "dashie_voice_views"


def _schedule_voice_views(hass: HomeAssistant) -> None:
    """Register the /api/dashie/voice/* gateway at HA start, with ownership guard.

    Those wire paths are a contract with shipped Dashie APKs. When BOTH halves
    of THIS BRAND's pair are installed, we own them ONLY if the sibling device
    integration has ceded (a ceding version sets
    hass.data[DEVICE_SIBLING_DOMAIN]['voice_views_ceded'] instead of
    registering). Deciding at EVENT_HOMEASSISTANT_STARTED makes the check
    order-independent — by then every integration has set up and the cede flag,
    if any, exists.

    Ownership is a WITHIN-brand handshake. The other brand's pair serves its own
    route prefix, so it is never a party to this decision and must not be
    consulted here.
    """
    if hass.data.get(_VOICE_VIEWS_KEY):
        return
    hass.data[_VOICE_VIEWS_KEY] = "scheduled"

    async def _decide(_hass: HomeAssistant) -> None:
        sibling_present = bool(hass.config_entries.async_entries(DEVICE_SIBLING_DOMAIN))
        sibling_data = hass.data.get(DEVICE_SIBLING_DOMAIN)
        ceded = isinstance(sibling_data, dict) and sibling_data.get("voice_views_ceded") is True
        if sibling_present and not ceded:
            # An older sibling already registered the routes — double-registering
            # would race on the same aiohttp resources.
            _LOGGER.warning(
                "DROP: Dashie Voice gateway NOT registered — the %s "
                "integration is present and has not ceded /api/dashie/voice/* "
                "(update it to a ceding version); kiosk LAN sharing stays on "
                "the Dashie add-on",
                DEVICE_SIBLING_DOMAIN,
            )
            hass.data[_VOICE_VIEWS_KEY] = "skipped"
            return
        register_voice_views(hass)
        hass.data[_VOICE_VIEWS_KEY] = "registered"

    async_at_started(hass, _decide)


def _record_loaded_hash_sync(hass: HomeAssistant) -> None:
    """Echo the add-on install marker's content-hash to a file the add-on reads,
    so the console can tell when an installed integration UPDATE hasn't been
    applied yet (add-on re-copied newer files, but this loaded code predates the
    restart → "restart to apply"). Written HERE, at setup, so it always reflects
    what core actually loaded; it self-clears on the next restart (this re-runs
    and stamps the current marker). Best-effort, and only meaningful for an
    add-on-managed install — a HACS/manual install has no marker, so nothing is
    written and the add-on shows no update nudge.
    """
    try:
        marker = os.path.join(os.path.dirname(__file__), ".installed_by_dashie_ha_addon")
        with open(marker, encoding="utf-8") as fh:
            match = re.search(r"content-hash:\s*([0-9a-f]{64})", fh.read(), re.I)
    except OSError:
        return
    if not match:
        return
    try:
        out_dir = hass.config.path(".dashie_voice")
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "loaded_hash"), "w", encoding="utf-8") as fh:
            fh.write(match.group(1) + "\n")
    except OSError as err:  # noqa: BLE001 — the nudge is cosmetic; never block setup
        _LOGGER.debug("could not record loaded integration hash: %s", err)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    # Bridge credentials from Supervisor discovery (primary channel; empty on
    # pre-discovery installs → file-read fallback stays in charge). Discovery
    # refreshes update the entry → reload → this re-primes with the new secret.
    set_bridge_config(
        entry.data.get(CONF_BRIDGE_SECRET),
        entry.data.get(CONF_BRIDGE_HOST),
        entry.data.get(CONF_BRIDGE_PORT),
    )
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    # Satellite wake: deploy the household's custom wake model to /share so the
    # wyoming-microwakeword add-on can serve it. No-op for community/unset words;
    # never raises. get_voice_config never raises (unreadable → {}, DROP-warned).
    wake_word_id = (await get_voice_config(hass)).get("default_wake_word")
    await async_deploy_wake_model(hass, wake_word_id)
    # After platform setup so the entities exist in the registry. Best-effort:
    # a failure DROP-warns inside, never blocks voice.
    await async_ensure_pipeline(hass, entry, wake_word_id=wake_word_id)
    # If the wyoming-microwakeword add-on is installed AFTER us, self-heal the
    # pipeline's wake stage when its entity appears (no reload needed).
    await async_wire_wake_when_ready(hass, entry, wake_word_id)
    # LAN-sharing gateway for Dashie kiosk satellites (ownership-guarded).
    _schedule_voice_views(hass)
    # Record the content-hash we loaded so the add-on can nudge "restart to
    # apply" after a future files-only update. Off the event loop, best-effort.
    await hass.async_add_executor_job(_record_loaded_hash_sync, hass)
    # Options-flow edits (assistant rename) apply via reload.
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
