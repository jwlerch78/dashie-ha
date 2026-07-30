// SPDX-License-Identifier: AGPL-3.0-only
// server/settings-store.js
// Persistent add-on-local settings (separate from auth/JWT storage).
//
// Holds two things:
//
//   householdSharing — the opt-in for whether un-logged-in tablets / voice
//     satellites on this HA network may use this add-on's account credential
//     for Dashie Cloud (AI voice billed to the account's credits). Default OFF.
//
//   userSettings — the console's settings blob for a box with NO account.
//     Same shape as the cloud's user_settings, written through the same seam
//     (console-auth loadUserSettings / saveUserSettings), so a signed-out user
//     can configure their OWN engines without that config ever leaving the box.
//     Signing in switches the console back to the account's settings; there is
//     deliberately NO sync or merge between the two (see the build plan —
//     every silent-merge scheme we have shipped has bitten us).
//
// Stored in /data (the add-on's persistent volume) — survives restarts and
// updates, cleared only on add-on uninstall or a full HA wipe (a fresh install
// then correctly re-requires the opt-in).

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const SETTINGS_FILE = path.join(DATA_DIR, 'chickadee_settings.json');

const DEFAULTS = {
    householdSharing: false,
    userSettings: {},
};

/** Read all settings, merged over defaults. Never throws. */
function readSettings() {
    try {
        if (!fs.existsSync(SETTINGS_FILE)) return { ...DEFAULTS };
        const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        return { ...DEFAULTS, ...data };
    } catch (e) {
        console.error('[settings] Failed to read settings:', e.message);
        return { ...DEFAULTS };
    }
}

/** Merge `patch` into stored settings and persist atomically. Returns the new settings. */
function writeSettings(patch) {
    const next = { ...readSettings(), ...patch };
    const tmp = SETTINGS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, SETTINGS_FILE);
    return next;
}

/** True when the account holder has opted into household-wide Dashie Cloud sharing. */
function isHouseholdSharingEnabled() {
    return readSettings().householdSharing === true;
}

// ── Account-less console settings ────────────────────────────────────────────

/** True for a mergeable plain object (not null, not an array). */
function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep-merge `patch` over `base`, returning a new object.
 *
 * Semantics are deliberately IDENTICAL to the cloud's jwt-auth 'save' op, which
 * is what the same console code hits when signed in: objects merge key-by-key,
 * arrays and scalars replace wholesale, and null overwrites (a key cannot be
 * deleted by patching — write null to clear it). Diverging here would make the
 * signed-out console behave subtly differently from the signed-in one, through
 * the same call sites.
 */
function deepMerge(base, patch) {
    const out = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        out[key] = isPlainObject(value) && isPlainObject(out[key])
            ? deepMerge(out[key], value)
            : value;
    }
    return out;
}

/** The account-less console settings blob. Never throws; `{}` before first write. */
function readUserSettings() {
    const stored = readSettings().userSettings;
    return isPlainObject(stored) ? stored : {};
}

/** Deep-merge a nested partial into the account-less blob. Returns the new blob. */
function patchUserSettings(partial) {
    const next = deepMerge(readUserSettings(), partial);
    writeSettings({ userSettings: next });
    return next;
}

module.exports = {
    readSettings, writeSettings, isHouseholdSharingEnabled,
    readUserSettings, patchUserSettings,
};
