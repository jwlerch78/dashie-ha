# SPDX-License-Identifier: AGPL-3.0-only
"""Chickadee conversation entity — routes Assist utterances to the Chickadee brain.

Port of the Dashie integration's conversation entity (device-verified there), with
the brain call redirected from the cloud gateway to the Chickadee add-on bridge:
the add-on owns engine routing (cloud / BYOK / local), the entity owns executing
the HA actions the brain resolves — in-process, because a satellite can't.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components import conversation
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import MATCH_ALL
from homeassistant.core import HomeAssistant
from homeassistant.helpers import intent
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .addon_bridge import AddonUnavailable, call_addon_brain
from .const import CONF_ASSISTANT_NAME, DEFAULT_ASSISTANT_NAME, UNIQUE_ID_CONVERSATION
from .entity_context import device_area_name, gather_exposed_entities, is_exposed

_LOGGER = logging.getLogger(__name__)

_CONTROL_FEATURE = conversation.ConversationEntityFeature.CONTROL

# Two-layer gate on what a brain response may execute. Model output is untrusted input:
# it can be prompt-injected through a calendar title, a media title, or an entity's own
# friendly_name, so "the brain wouldn't ask for that" is not a control.
#
#   Layer 1 (this list) — the floor. Domains a voice assistant plausibly controls. Its
#     real job is excluding the escape hatches, which is why the exclusions matter more
#     than the inclusions: shell_command, python_script, hassio, homeassistant (.stop /
#     .restart), notify, persistent_notification, backup, recorder, and anything else
#     not named here.
#   Layer 2 (_exec_commands) — every target entity must be Assist-exposed.
#
# Layer 2 is the tighter gate; a user who exposes script.foo to Assist meant it to be
# runnable. Layer 1 exists so an unexposed-but-dangerous domain can never be reached
# even if the exposure predicate is wrong or a future HA renames something.
ALLOWED_SERVICE_DOMAINS = frozenset({
    "alarm_control_panel", "automation", "button", "climate", "cover", "fan",
    "humidifier", "input_boolean", "input_button", "input_number", "input_select",
    "lawn_mower", "light", "lock", "media_player", "number", "scene", "script",
    "select", "siren", "switch", "todo", "vacuum", "valve", "water_heater",
})


def _target_entity_ids(data: dict[str, Any]) -> list[str]:
    """Entity ids a service call targets. HA accepts a str, a comma-string, or a list.

    Also reads `target.entity_id` — the brain doesn't emit that shape today (every
    example in the prompt is flat `data.entity_id`), but HA accepts it, so reading only
    the flat form would leave a shape that bypasses the exposure check.
    """
    raw: list[Any] = []
    for src in (data, data.get("target") if isinstance(data.get("target"), dict) else None):
        if not isinstance(src, dict):
            continue
        val = src.get("entity_id")
        if isinstance(val, str):
            raw.extend(val.split(","))
        elif isinstance(val, (list, tuple)):
            raw.extend(val)
    return [e.strip() for e in raw if isinstance(e, str) and e.strip()]


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    async_add_entities([ChickadeeConversationEntity(config_entry)])


class ChickadeeConversationEntity(conversation.ConversationEntity):
    """One conversation agent per install; the display name is the user's persona name."""

    _attr_has_entity_name = False
    _attr_unique_id = UNIQUE_ID_CONVERSATION
    _attr_supported_features = _CONTROL_FEATURE

    def __init__(self, config_entry: ConfigEntry) -> None:
        self._attr_name = config_entry.data.get(CONF_ASSISTANT_NAME, DEFAULT_ASSISTANT_NAME)

    @property
    def supported_languages(self) -> list[str] | str:
        # The brain handles language; accept everything.
        return MATCH_ALL

    async def async_process(
        self, user_input: conversation.ConversationInput
    ) -> conversation.ConversationResult:
        hass = self.hass
        text = (user_input.text or "").strip()
        language = user_input.language or "en"

        if not text:
            return self._result("Sorry, I didn't catch that.", user_input, language)

        # Headless VoiceRequest: exposed entities + the satellite's room. Pass-through
        # philosophy — the add-on (the gateway) owns overrides, this caller declares only
        # what it knows. client_fulfilled_tools=[] tells the brain to self-fulfill or
        # decline: an Assist satellite has no device to run a client tool on.
        provided_context: dict[str, Any] = {}
        entities = gather_exposed_entities(hass)
        if entities:
            provided_context["ha_entities"] = entities
        device_area = device_area_name(hass, getattr(user_input, "device_id", None))
        if device_area:
            provided_context["device_area"] = device_area

        payload = {
            "text": text,
            "conversation_id": user_input.conversation_id,
            "endpoint_id": "ha-voice",
            "client_fulfilled_tools": [],
            "provided_context": provided_context,
            "timezone": str(hass.config.time_zone or "UTC"),
            # Persona: the configured assistant name renders as {{ASSISTANT_NAME}}
            # in the brain's base prompt (absent → brain defaults to its own).
            "assistant_name": self._attr_name,
        }

        try:
            turn, status = await call_addon_brain(hass, payload)
        except AddonUnavailable as err:
            _LOGGER.warning("DROP: Chickadee conversation — add-on unavailable: %s", err)
            return self._result(
                "I can't reach the Chickadee add-on right now. Please check that it's running.",
                user_input,
                language,
            )
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("DROP: Chickadee conversation — brain call failed: %s", err)
            return self._result("Something went wrong reaching the brain.", user_input, language)

        if status >= 400 or not isinstance(turn, dict):
            _LOGGER.warning("DROP: Chickadee brain returned HTTP %s: %s", status, turn)
            return self._result("I couldn't handle that request.", user_input, language)

        # Execute any HA action(s) the brain resolved, in-process (the satellite can't).
        await self._execute_ha_actions(hass, turn)

        speech = turn.get("voice") or turn.get("text") or ""

        # Tools that can't be fulfilled headless come back as an unsupported_tool marker or
        # a client_tool request — the brain usually still speaks a decline, but log a loud
        # DROP either way (no silent drops) and never go quiet on the user.
        if turn.get("unsupported_tool"):
            _LOGGER.warning(
                "DROP: brain routed to unsupported_tool=%s (headless satellite)",
                turn["unsupported_tool"],
            )
        client_tool = turn.get("client_tool")
        if isinstance(client_tool, dict) and client_tool.get("tool"):
            _LOGGER.warning(
                "DROP: brain returned client_tool=%s (not fulfillable headless)",
                client_tool["tool"],
            )
            if not speech:
                speech = "That isn't available on this device."

        return self._result(speech or "OK.", user_input, language)

    async def _execute_ha_actions(self, hass: HomeAssistant, turn: dict) -> None:
        """Run any home_assistant execute_commands the brain returned ('action' or 'multi' steps)."""
        actions: list[dict] = []
        if isinstance(turn.get("action"), dict):
            actions.append(turn["action"])
        for step in turn.get("steps") or []:
            if not isinstance(step, dict):
                continue
            if isinstance(step.get("action"), dict):
                actions.append(step["action"])
            elif step.get("client_tool"):
                _LOGGER.warning("DROP: multi step client_tool=%s (headless)", step.get("client_tool"))

        for act in actions:
            category = act.get("category")
            command = act.get("command")
            if category not in ("homeassistant", "home_assistant"):
                _LOGGER.warning("DROP: non-HA action category=%s command=%s", category, command)
                continue
            if command != "execute_commands":
                _LOGGER.warning("DROP: unknown HA action command=%s", command)
                continue
            for cmd in (act.get("parameters") or {}).get("commands") or []:
                domain = cmd.get("domain")
                service = cmd.get("service")
                if not domain or not service:
                    _LOGGER.warning("DROP: HA command missing domain/service: %s", cmd)
                    continue
                # The brain emits {domain, service, data:{...}} — service data NESTED under
                # "data". Tolerate a flat {domain, service, ...data} shape for forward-compat.
                if isinstance(cmd.get("data"), dict):
                    data = dict(cmd["data"])
                else:
                    data = {k: v for k, v in cmd.items() if k not in ("domain", "service")}

                # Layer 1 — domain floor.
                if domain not in ALLOWED_SERVICE_DOMAINS:
                    _LOGGER.warning(
                        "DROP: HA %s.%s rejected — domain not in ALLOWED_SERVICE_DOMAINS", domain, service
                    )
                    continue

                # Layer 2 — every target must be Assist-exposed. Untargeted calls are
                # refused rather than allowed: the brain always emits entity_id (every
                # example in its prompt does, and it has no area/device targeting), so a
                # targetless call is either a new emitter shape or an injection — both
                # want a look, not a silent service call against everything.
                targets = _target_entity_ids(data)
                if not targets:
                    _LOGGER.warning(
                        "DROP: HA %s.%s rejected — no target entity_id (data=%s)", domain, service, data
                    )
                    continue
                unexposed = [e for e in targets if not is_exposed(hass, e)]
                if unexposed:
                    _LOGGER.warning(
                        "DROP: HA %s.%s rejected — target(s) not Assist-exposed: %s",
                        domain, service, ", ".join(unexposed),
                    )
                    continue

                try:
                    await hass.services.async_call(domain, service, data, blocking=True)
                    _LOGGER.info("Chickadee executed HA %s.%s %s", domain, service, data)
                except Exception as err:  # noqa: BLE001
                    _LOGGER.warning("DROP: HA %s.%s failed: %s", domain, service, err)

    @staticmethod
    def _result(
        speech: str, user_input: conversation.ConversationInput, language: str
    ) -> conversation.ConversationResult:
        intent_response = intent.IntentResponse(language=language)
        intent_response.async_set_speech(speech)
        return conversation.ConversationResult(
            response=intent_response, conversation_id=user_input.conversation_id
        )
