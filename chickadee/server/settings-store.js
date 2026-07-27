// server/settings-store.js
// Persistent add-on-local settings (separate from auth/JWT storage).
//
// Currently holds the household-sharing opt-in: whether un-logged-in
// tablets / voice satellites on this HA network may use this add-on's account
// credential for Dashie Cloud (AI voice billed to the account's credits).
//
// Stored in /data (the add-on's persistent volume) — survives restarts and
// updates, cleared only on add-on uninstall or a full HA wipe (a fresh install
// then correctly re-requires the opt-in). Default OFF.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const SETTINGS_FILE = path.join(DATA_DIR, 'chickadee_settings.json');

const DEFAULTS = {
    householdSharing: false,
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

module.exports = { readSettings, writeSettings, isHouseholdSharingEnabled };
