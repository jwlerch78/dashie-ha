# SPDX-License-Identifier: AGPL-3.0-only
"""Config + options flows for Chickadee.

Deliberately thin: engine configuration (cloud / BYOK / local, keys, fallbacks)
lives in the Chickadee add-on's console — the integration is the Assist-pipeline
surface. The config flow checks the add-on is reachable and names the assistant;
the options flow renames it and re-surfaces add-on reachability.
"""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback
from homeassistant.helpers.service_info.hassio import HassioServiceInfo

from .addon_bridge import ping_addon
from .const import (
    CONF_ASSISTANT_NAME,
    CONF_BRIDGE_HOST,
    CONF_BRIDGE_PORT,
    CONF_BRIDGE_SECRET,
    DEFAULT_ASSISTANT_NAME,
    DOMAIN,
)

_USER_SCHEMA = vol.Schema(
    {vol.Optional(CONF_ASSISTANT_NAME, default=DEFAULT_ASSISTANT_NAME): str}
)


class ChickadeeConfigFlow(ConfigFlow, domain=DOMAIN):
    """Single-instance flow: reachability probe + assistant name."""

    VERSION = 1
    _hassio_discovery: HassioServiceInfo | None = None

    async def async_step_hassio(
        self, discovery_info: HassioServiceInfo
    ) -> ConfigFlowResult:
        """Supervisor discovery from the Chickadee add-on: {host, port, secret}.

        The add-on re-publishes on every start, so an EXISTING entry gets its
        bridge credentials refreshed silently here (the primary secret channel;
        the file copies are the legacy fallback). A fresh install stashes the
        payload and asks the user to confirm adding Chickadee.
        """
        bridge = {
            CONF_BRIDGE_SECRET: str(discovery_info.config.get("secret") or ""),
            CONF_BRIDGE_HOST: str(discovery_info.config.get("host") or ""),
            CONF_BRIDGE_PORT: int(discovery_info.config.get("port") or 8099),
        }
        await self.async_set_unique_id(DOMAIN)
        # Existing install → refresh bridge credentials in place, then abort.
        # (reload_on_update: the update listener reloads the entry, and setup
        # re-primes hass.data with the fresh secret.)
        self._abort_if_unique_id_configured(updates=bridge)

        self._hassio_discovery = discovery_info
        return await self.async_step_hassio_confirm()

    async def async_step_hassio_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Confirm creating the entry from add-on discovery."""
        assert self._hassio_discovery is not None
        if user_input is not None:
            info = self._hassio_discovery
            return self.async_create_entry(
                title=DEFAULT_ASSISTANT_NAME,
                data={
                    CONF_ASSISTANT_NAME: DEFAULT_ASSISTANT_NAME,
                    CONF_BRIDGE_SECRET: str(info.config.get("secret") or ""),
                    CONF_BRIDGE_HOST: str(info.config.get("host") or ""),
                    CONF_BRIDGE_PORT: int(info.config.get("port") or 8099),
                },
            )
        return self.async_show_form(step_id="hassio_confirm")

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        errors: dict[str, str] = {}
        if user_input is not None:
            # Warn-don't-block: the add-on may be installed after the integration.
            # The conversation entity DROP-logs loudly per turn until it appears.
            if not await ping_addon(self.hass):
                errors["base"] = "addon_unreachable"
            if not errors or user_input.get("ignore_addon"):
                name = (user_input.get(CONF_ASSISTANT_NAME) or DEFAULT_ASSISTANT_NAME).strip()
                return self.async_create_entry(
                    title=name, data={CONF_ASSISTANT_NAME: name}
                )

        schema = _USER_SCHEMA
        if errors:
            schema = _USER_SCHEMA.extend({vol.Optional("ignore_addon", default=False): bool})
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> ChickadeeOptionsFlow:
        return ChickadeeOptionsFlow()


class ChickadeeOptionsFlow(OptionsFlow):
    """Rename the assistant; surface add-on reachability.

    The name lives in entry.data (it's identity, not tuning) — saving a changed
    name updates the entry, and the update listener reloads so the conversation
    entity picks up its new display name. The entity_id (what the auto-created
    pipeline references) never changes on rename.
    """

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        entry = self.config_entry
        current = entry.data.get(CONF_ASSISTANT_NAME, DEFAULT_ASSISTANT_NAME)

        if user_input is not None:
            name = (user_input.get(CONF_ASSISTANT_NAME) or DEFAULT_ASSISTANT_NAME).strip()
            if name != current:
                self.hass.config_entries.async_update_entry(
                    entry, title=name, data={**entry.data, CONF_ASSISTANT_NAME: name}
                )
            return self.async_create_entry(data={})

        addon_status = (
            "reachable ✓"
            if await ping_addon(self.hass)
            else "NOT reachable ✗ — install/start the Chickadee add-on"
        )
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {vol.Optional(CONF_ASSISTANT_NAME, default=current): str}
            ),
            description_placeholders={"addon_status": addon_status},
        )
