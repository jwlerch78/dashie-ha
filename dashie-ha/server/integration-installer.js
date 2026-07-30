// SPDX-License-Identifier: AGPL-3.0-only
// integration-installer.js — install/update the Dashie Voice INTEGRATION from the
// add-on ("all at once" onboarding: add-on → integration → discovery → done).
//
// Pattern precedent: the official "Get HACS" add-on — an add-on with a
// homeassistant_config mount writes /config/custom_components/<domain> and the
// user restarts HA to load it. There is no Supervisor "install integration"
// API; the file copy IS the mechanism.
//
// Rules:
//   - `install_integration: false` (Configuration tab) disables all of this.
//   - We only ever touch an install WE made (ownership marker file). A HACS or
//     manual install is never modified — we just log its version.
//   - Fresh install / version update → copy + marker + a persistent
//     notification asking for the HA restart (we never restart core
//     unilaterally). After restart, Supervisor discovery pops the one-click
//     Configure card (config_flow.async_step_hassio_confirm).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { readOptions } = require('./options');

// homeassistant_config:rw mounts the HA config dir here (same mount
// bridge-auth.js provisions the secret through).
const HA_CONFIG_ROOT = '/homeassistant';
const TARGET_DIR = path.join(HA_CONFIG_ROOT, 'custom_components', 'dashie_voice');
// Vendored by scripts/sync-integration.sh, shipped in the image (Dockerfile).
const BUNDLED_DIR = path.resolve(__dirname, '..', 'integration', 'custom_components', 'dashie_voice');
const MARKER = '.installed_by_dashie_ha_addon';

function readManifestVersion(dir) {
    try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        return typeof m.version === 'string' ? m.version : null;
    } catch (e) {
        return null;
    }
}

/**
 * Deterministic content hash of an integration package tree. The update
 * decision keys on THIS, not the manifest version: gating on version silently
 * skipped code-only changes (a fix that didn't bump manifest.json → stale on
 * disk, forever "current"). Hashing the actual files means ANY change ships,
 * with zero version bookkeeping. Sorted paths → order-stable; __pycache__/.pyc
 * excluded (runtime-generated, would make an otherwise-identical tree differ).
 */
function hashDir(dir) {
    const h = crypto.createHash('sha256');
    const walk = (d, rel) => {
        let entries;
        try {
            entries = fs.readdirSync(d, { withFileTypes: true });
        } catch { return; }
        entries
            .filter((e) => e.name !== '__pycache__' && !e.name.endsWith('.pyc'))
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach((e) => {
                const abs = path.join(d, e.name);
                const r = rel ? `${rel}/${e.name}` : e.name;
                if (e.isDirectory()) {
                    h.update(`D:${r}\n`);
                    walk(abs, r);
                } else {
                    h.update(`F:${r}\n`);
                    h.update(fs.readFileSync(abs));
                }
            });
    };
    walk(dir, '');
    return h.digest('hex');
}

/** The content-hash line we stamp into the marker at install time, or null. */
function readInstalledHash(dir) {
    try {
        const txt = fs.readFileSync(path.join(dir, MARKER), 'utf8');
        const m = txt.match(/content-hash:\s*([0-9a-f]{64})/i);
        return m ? m[1] : null;
    } catch (e) {
        return null;
    }
}

async function notifyRestart(message) {
    // Persistent notification via the Core API (homeassistant_api grant).
    // Best-effort: the install still worked if HA is briefly unreachable.
    const token = process.env.SUPERVISOR_TOKEN;
    if (!token) return;
    try {
        const resp = await fetch('http://supervisor/core/api/services/persistent_notification/create', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'Dashie Voice',
                message,
                notification_id: 'dashie_voice_integration_install',
            }),
        });
        if (!resp.ok) console.warn(`[installer] notification HTTP ${resp.status}`);
    } catch (e) {
        console.warn('[installer] could not create HA notification:', e.message);
    }
}

function installCopy(contentHash) {
    // Stage next to the target so the final rename is same-filesystem.
    const tmp = TARGET_DIR + '.staging';
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(BUNDLED_DIR, tmp, { recursive: true });
    // The marker carries BOTH the ownership signal (safe to update) and the
    // content-hash stamp the next run compares against. Hash is of BUNDLED_DIR,
    // which has no marker — so it stays stable regardless of what we write here.
    fs.writeFileSync(path.join(tmp, MARKER),
        'Installed by the Dashie for Home Assistant add-on — re-copied whenever the bundled integration changes.\n' +
        'Delete this file to manage the integration yourself (HACS/manual).\n' +
        `content-hash: ${contentHash}\n`);
    fs.rmSync(TARGET_DIR, { recursive: true, force: true });
    fs.renameSync(tmp, TARGET_DIR);
}

/**
 * Ensure the integration is installed/current. Never throws; loud logs.
 * Returns 'installed' | 'updated' | 'current' | 'unmanaged' | 'disabled' | 'error'.
 */
async function ensureIntegration() {
    try {
        if (readOptions().install_integration === false) {
            console.log('[installer] install_integration is off — skipping');
            return 'disabled';
        }
        const bundled = readManifestVersion(BUNDLED_DIR);
        if (!bundled) {
            console.warn('[installer] DROP: no bundled integration in this image (sync-integration.sh not run?)');
            return 'error';
        }
        const bundledHash = hashDir(BUNDLED_DIR);
        if (!fs.existsSync(path.join(HA_CONFIG_ROOT, 'custom_components')) &&
            !fs.existsSync(HA_CONFIG_ROOT)) {
            console.warn('[installer] DROP: HA config mount missing — cannot install the integration');
            return 'error';
        }

        const installed = readManifestVersion(TARGET_DIR);
        if (installed === null) {
            fs.mkdirSync(path.dirname(TARGET_DIR), { recursive: true });
            installCopy(bundledHash);
            console.log(`[installer] ✅ integration v${bundled} INSTALLED to ${TARGET_DIR}`);
            await notifyRestart(
                `The Dashie Voice integration (v${bundled}) was installed. ` +
                '**Restart Home Assistant** (Settings → System → Restart) to activate it — '
                + 'Dashie Voice will then appear as a discovered device to configure with one click.');
            return 'installed';
        }

        const managed = fs.existsSync(path.join(TARGET_DIR, MARKER));
        if (!managed) {
            console.log(`[installer] integration v${installed} present but not add-on-managed (HACS/manual) — leaving it alone (bundled: v${bundled})`);
            return 'unmanaged';
        }
        // Content-hash gate (NOT version): re-copy whenever the bundled files
        // differ from what we last installed, so code-only changes ship without
        // a manifest bump. An old marker with no hash line reads as null → the
        // first run under this installer re-copies once to establish the stamp.
        const installedHash = readInstalledHash(TARGET_DIR);
        if (installedHash !== bundledHash) {
            installCopy(bundledHash);
            const how = installedHash ? 'content changed' : 'establishing content stamp';
            console.log(`[installer] ✅ integration RE-COPIED (${how}) — installed v${installed}, bundled v${bundled}`);
            await notifyRestart(
                `The Dashie Voice integration was updated (bundled v${bundled}). ` +
                '**Restart Home Assistant** to apply.');
            return 'updated';
        }
        console.log(`[installer] integration v${installed} matches bundled content — current`);
        return 'current';
    } catch (e) {
        console.error('[installer] DROP: integration install failed:', e?.stack || e);
        return 'error';
    }
}

/** Content-hash of the integration currently ON DISK (from the marker), or null. */
function getInstalledHash() {
    return readInstalledHash(TARGET_DIR);
}

/** Content-hash the LOADED integration stamped at its last setup (the integration
 *  writes it to <config>/.dashie_voice/loaded_hash), or null. When this differs from
 *  getInstalledHash() the add-on has re-copied newer files that a core restart
 *  hasn't loaded yet → the console nudges "restart to apply". Self-clears: the
 *  integration rewrites it on its next setup (i.e. after that restart). */
function getLoadedHash() {
    try {
        const txt = fs.readFileSync(path.join(HA_CONFIG_ROOT, '.dashie_voice', 'loaded_hash'), 'utf8');
        const m = txt.match(/([0-9a-f]{64})/i);
        return m ? m[1] : null;
    } catch (e) {
        return null;
    }
}

let _lastResult = null;

/** The most recent ensureIntegration outcome ('installed'|'updated'|'current'|…). */
function getStatus() { return _lastResult; }

async function ensureIntegrationTracked() {
    _lastResult = await ensureIntegration();
    return _lastResult;
}

module.exports = { ensureIntegration: ensureIntegrationTracked, getStatus, getInstalledHash, getLoadedHash };
