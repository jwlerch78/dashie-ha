// integration-installer.js — install/update the Chickadee INTEGRATION from the
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

const { readOptions } = require('./options');

// homeassistant_config:rw mounts the HA config dir here (same mount
// bridge-auth.js provisions the secret through).
const HA_CONFIG_ROOT = '/homeassistant';
const TARGET_DIR = path.join(HA_CONFIG_ROOT, 'custom_components', 'chickadee');
// Vendored by scripts/sync-integration.sh, shipped in the image (Dockerfile).
const BUNDLED_DIR = path.resolve(__dirname, '..', 'integration', 'custom_components', 'chickadee');
const MARKER = '.installed_by_chickadee_addon';

function readManifestVersion(dir) {
    try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        return typeof m.version === 'string' ? m.version : null;
    } catch (e) {
        return null;
    }
}

/** a newer than b? Numeric per-part compare ("0.10.0" > "0.9.1"). */
function isNewer(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x !== y) return x > y;
    }
    return false;
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
                title: 'Chickadee',
                message,
                notification_id: 'chickadee_integration_install',
            }),
        });
        if (!resp.ok) console.warn(`[installer] notification HTTP ${resp.status}`);
    } catch (e) {
        console.warn('[installer] could not create HA notification:', e.message);
    }
}

function installCopy() {
    // Stage next to the target so the final rename is same-filesystem.
    const tmp = TARGET_DIR + '.staging';
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(BUNDLED_DIR, tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, MARKER),
        'Installed by the Chickadee add-on — updated on add-on updates.\n' +
        'Delete this file to manage the integration yourself (HACS/manual).\n');
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
        if (!fs.existsSync(path.join(HA_CONFIG_ROOT, 'custom_components')) &&
            !fs.existsSync(HA_CONFIG_ROOT)) {
            console.warn('[installer] DROP: HA config mount missing — cannot install the integration');
            return 'error';
        }

        const installed = readManifestVersion(TARGET_DIR);
        if (installed === null) {
            fs.mkdirSync(path.dirname(TARGET_DIR), { recursive: true });
            installCopy();
            console.log(`[installer] ✅ integration v${bundled} INSTALLED to ${TARGET_DIR}`);
            await notifyRestart(
                `The Chickadee integration (v${bundled}) was installed. ` +
                '**Restart Home Assistant** (Settings → System → Restart) to activate it — '
                + 'Chickadee will then appear as a discovered device to configure with one click.');
            return 'installed';
        }

        const managed = fs.existsSync(path.join(TARGET_DIR, MARKER));
        if (!managed) {
            console.log(`[installer] integration v${installed} present but not add-on-managed (HACS/manual) — leaving it alone (bundled: v${bundled})`);
            return 'unmanaged';
        }
        if (isNewer(bundled, installed)) {
            installCopy();
            console.log(`[installer] ✅ integration UPDATED v${installed} → v${bundled}`);
            await notifyRestart(
                `The Chickadee integration was updated to v${bundled}. ` +
                '**Restart Home Assistant** to apply.');
            return 'updated';
        }
        console.log(`[installer] integration v${installed} is current`);
        return 'current';
    } catch (e) {
        console.error('[installer] DROP: integration install failed:', e?.stack || e);
        return 'error';
    }
}

let _lastResult = null;

/** The most recent ensureIntegration outcome ('installed'|'updated'|'current'|…). */
function getStatus() { return _lastResult; }

async function ensureIntegrationTracked() {
    _lastResult = await ensureIntegration();
    return _lastResult;
}

module.exports = { ensureIntegration: ensureIntegrationTracked, getStatus };
