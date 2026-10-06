// SPDX-License-Identifier: AGPL-3.0-only
// server/ha-control-map.js
// The ONE place the three different names for a single device control are
// reconciled. Keep it that way: a fourth copy in the Console was the bug this
// file exists to prevent.
//
// Three vocabularies, all real, none of them interchangeable:
//
//   1. ROLE            what the Console calls it, and what /api/ha/control takes
//                      on the wire:  refresh · relaunch · bring_to_foreground
//   2. suffix          the tail of the HA entity_id, derived by HA from the
//                      integration's _attr_name:
//                      refresh_webview · restart_app · bring_to_foreground
//   3. unique_id tail  what the integration stamps, and therefore the key
//                      ha-metrics puts in entityIdsByRole (it prefers
//                      _roleFromUniqueId over the entity_id slug path):
//                      refresh_webview · restart · foreground
//
// (2) and (3) agree for most controls and disagree for exactly the ones that
// were broken: relaunch, bring_to_foreground and reload. Measured against a
// live box 2026-10-03: button.fire_tv_restart_app and
// button.fire_tv_bring_to_foreground exist, while entityIdsByRole holds them
// under `restart` and `foreground`. So keying availability off the ROLE, or off
// entityIdsByRole[role], lights up some buttons and not others — which reads
// exactly like a working fix.
//
// Hence availableControlRoles() below asks the only question that cannot be
// wrong by construction: *would the press resolve to an entity HA actually
// has?* It resolves the same way /api/ha/control does, then checks existence.
// It can therefore never be more optimistic than the press itself — a button it
// enables is a button that will resolve.

const CONTROL_MAP = {
    lock:                    { suffix: 'lock', domain: 'switch', kind: 'switch' },
    screen:                  { suffix: 'screen', domain: 'switch', kind: 'switch' },
    screensaver:             { suffix: 'screensaver', domain: 'switch', kind: 'switch' },
    dark_mode:               { suffix: 'dark_mode', domain: 'switch', kind: 'switch' },
    keep_screen_on:          { suffix: 'keep_screen_on', domain: 'switch', kind: 'switch' },
    auto_brightness:         { suffix: 'auto_brightness', domain: 'switch', kind: 'switch' },
    hide_sidebar:            { suffix: 'hide_sidebar', domain: 'switch', kind: 'switch' },
    hide_tabs:               { suffix: 'hide_tabs', domain: 'switch', kind: 'switch' },
    start_on_boot:           { suffix: 'start_on_boot', domain: 'switch', kind: 'switch' },
    camera_stream_enabled:   { suffix: 'camera_stream_enabled', domain: 'switch', kind: 'switch' },
    camera_software_encoding:{ suffix: 'camera_software_encoding', domain: 'switch', kind: 'switch' },
    volume:                  { suffix: 'volume', domain: 'number', kind: 'number' },
    brightness:              { suffix: 'brightness', domain: 'number', kind: 'number' },
    zoom:                    { suffix: 'zoom', domain: 'number', kind: 'number' },
    reload:                  { suffix: 'reload_dashboard', domain: 'button', kind: 'button' },
    relaunch:                { suffix: 'restart_app', domain: 'button', kind: 'button' },
    refresh:                 { suffix: 'refresh_webview', domain: 'button', kind: 'button' },
    bring_to_foreground:     { suffix: 'bring_to_foreground', domain: 'button', kind: 'button' },
    reboot:                  { suffix: 'reboot_device', domain: 'button', kind: 'button' },
    clear_cache:             { suffix: 'clear_cache', domain: 'button', kind: 'button' },
    clear_storage:           { suffix: 'clear_storage', domain: 'button', kind: 'button' },
};

/**
 * Resolve a control role to the entity_id a press would target.
 *
 * `lookupEntityId(suffix)` returns the worker-resolved entity_id for that
 * entity suffix, or a falsy value if the worker has not bucketed one. Passing a
 * lookup rather than a map keeps both callers honest: /api/ha/control holds a
 * per-role getter, ha-metrics holds the whole entityIdsByRole object, and
 * neither has to reshape itself to match the other.
 *
 * Worker-resolved id first — correct on partial-migration devices whose
 * entity_id slug drifted from the anchor's — constructed id second. Returns
 * null when there is no slug to construct from.
 */
function resolveControlEntityId(role, { lookupEntityId, slug }) {
    const map = CONTROL_MAP[role];
    if (!map) return null;
    const resolved = lookupEntityId ? lookupEntityId(map.suffix) : null;
    if (resolved) return resolved;
    return slug ? `${map.domain}.${slug}_${map.suffix}` : null;
}

/**
 * The control roles whose entity HA actually holds, i.e. the ones a press will
 * resolve. `hasEntity(entityId) -> boolean` is supplied by the caller so this
 * module stays I/O-free and testable.
 *
 * Deliberately returns ROLES, not entity_ids: the Console speaks roles, and
 * handing it anything else would re-import the name mismatch it cannot see.
 */
function availableControlRoles({ lookupEntityId, slug, hasEntity }) {
    const roles = [];
    for (const role of Object.keys(CONTROL_MAP)) {
        const entityId = resolveControlEntityId(role, { lookupEntityId, slug });
        if (entityId && hasEntity(entityId)) roles.push(role);
    }
    return roles;
}

module.exports = { CONTROL_MAP, resolveControlEntityId, availableControlRoles };
