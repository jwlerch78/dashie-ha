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

// 🔴 DERIVED, not hard-coded — the vendored tree names itself.
//
// This was a literal `dashie_voice` on both paths. A branded build vendors
// `chickadee_voice` (correctly — the integration has its own generated repo), so
// the installer looked at a directory that does not exist, found nothing, and
// DROP-warned "sync-integration.sh not run?" — which is a red herring: the tree
// IS in the image, with a full manifest. The result was a fresh box with NO
// VOICE INTEGRATION AT ALL.
//
// Two copies of a name that must agree is the seam rule's own example, so the
// fix is to stop having two: read the vendored package name. There is exactly
// one, it is placed there by scripts/sync-integration.sh, and its name IS the
// integration's domain — which is also what it must be called inside HA's
// custom_components. One source, no substitution row, nothing to forget.
const VENDOR_ROOT = path.resolve(__dirname, '..', 'integration', 'custom_components');

function readVendoredDomain() {
    let entries = [];
    try {
        entries = fs.readdirSync(VENDOR_ROOT, { withFileTypes: true })
            .filter((e) => e.isDirectory() && fs.existsSync(path.join(VENDOR_ROOT, e.name, 'manifest.json')))
            .map((e) => e.name);
    } catch { /* reported below */ }
    if (entries.length === 1) return entries[0];
    // Loud, and specific about which of the two failures this is — "not vendored"
    // and "vendored twice" want opposite fixes.
    console.warn(
        entries.length === 0
            ? `DROP: no vendored integration under ${VENDOR_ROOT} (expected exactly one package with a manifest.json). ` +
              `The image was built without scripts/sync-integration.sh having run.`
            : `DROP: ${entries.length} vendored integrations under ${VENDOR_ROOT} (${entries.join(', ')}). ` +
              `Expected exactly one — a second copy means two integrations would fight over the same install.`,
    );
    return null;
}

const VENDORED_DOMAIN = readVendoredDomain();
const TARGET_DIR = VENDORED_DOMAIN
    ? path.join(HA_CONFIG_ROOT, 'custom_components', VENDORED_DOMAIN)
    : null;
// Vendored by scripts/sync-integration.sh, shipped in the image (Dockerfile).
const BUNDLED_DIR = VENDORED_DOMAIN ? path.join(VENDOR_ROOT, VENDORED_DOMAIN) : null;
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
/**
 * Any marker this add-on family has EVER written into its own integration dir.
 *
 * 🔴 Why a PATTERN and not a `LEGACY_MARKERS = [...]` list of old names, which is
 * the obvious fix and is broken here:
 *
 * This file is brand-generated, and the marker name contains the brand token. So
 * a previous name written as a literal in canon is SUBSTITUTED on the way into
 * the other brand's tree and arrives as TODAY'S name — the legacy entry matches
 * only what MARKER already matches, i.e. it is empty of meaning in the one tree
 * that needs it. **The old name cannot be spelled here, because spelling it is
 * what rebrands it.**
 *
 * ⚠️ That is not theoretical: the first version of this comment demonstrated the
 * problem with the two literals side by side, and generation rewrote both into
 * the same string — leaving "X becomes X" in the Chickadee tree. The explanation
 * destroyed itself in exactly the way it was describing. Hence no literals here
 * either: this comment has to survive the transform it is warning about.
 *
 * A pattern has no brand token to substitute, so it survives generation, and it
 * also survives the NEXT rename without anyone remembering to add a row.
 *
 * Scoped to our own integration's directory (TARGET_DIR is the vendored domain),
 * so a marker matching this convention inside it is ours by construction.
 */
const MARKER_RE = /^\.installed_by_[a-z0-9_]+_addon$/;

/** The marker file actually present, current name preferred. null ⇒ unmanaged. */
function findMarker(dir) {
    try {
        if (fs.existsSync(path.join(dir, MARKER))) return MARKER;
        return fs.readdirSync(dir).find((f) => MARKER_RE.test(f)) || null;
    } catch (e) {
        return null;
    }
}

function readInstalledHash(dir) {
    try {
        const marker = findMarker(dir);
        if (!marker) return null;
        const txt = fs.readFileSync(path.join(dir, marker), 'utf8');
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
        // readVendoredDomain already DROP-warned with the specific reason; bail
        // before any path.join(null) turns a clear diagnosis into a TypeError.
        if (!VENDORED_DOMAIN) return 'error';
        const bundled = readManifestVersion(BUNDLED_DIR);
        if (!bundled) {
            console.warn(`[installer] DROP: vendored ${VENDORED_DOMAIN} has no readable manifest.json at ${BUNDLED_DIR}`);
            return 'error';
        }
        console.log(`[installer] vendored integration domain: ${VENDORED_DOMAIN}`);
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

        // 🔴 Ownership is decided by "is there a marker of ours", NOT by "is there
        // a file with today's marker NAME". Those read identically until the name
        // changes, and then they differ on every box that was installed before it.
        //
        // That is what happened: renaming this marker for brand correctness
        // (2026-08-02) made every already-installed Chickadee box read as
        // HACS/manual, so the installer politely left it alone FOREVER — the
        // integration silently stopped updating on exactly the boxes being used
        // to test it. The marker's CONTENT was brand-correct and carried a valid
        // content-hash the whole time; only its filename was consulted.
        //
        // A re-copy self-migrates it: installCopy replaces TARGET_DIR wholesale,
        // so the stale-named marker is gone after one run with no migration code.
        const marker = findMarker(TARGET_DIR);
        if (!marker) {
            console.log(`[installer] integration v${installed} present but not add-on-managed (HACS/manual) — leaving it alone (bundled: v${bundled})`);
            return 'unmanaged';
        }
        // Standing rule 2: this drop was LOUD AND WRONG — it announced a
        // deliberate hands-off decision while describing a tree the add-on wrote
        // itself. A log line that reads correct is worse than a silent one,
        // because it ends the investigation. So the two cases now SAY they differ.
        if (marker !== MARKER) {
            console.warn(`[installer] DROP-AVERTED: found legacy marker "${marker}" (expected "${MARKER}") — this tree IS add-on-managed; migrating the marker name on this pass`);
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
        // Up to date, so no re-copy will run — which means a legacy-named marker
        // would never be migrated by the copy path and the warning above would
        // fire on EVERY start, forever. A permanent warning is one people learn
        // to scroll past, so finish the migration here instead of announcing it
        // repeatedly. Rename only; the content (including the valid hash) is
        // already correct, which is the whole reason this tree was recoverable.
        if (marker !== MARKER) {
            try {
                fs.renameSync(path.join(TARGET_DIR, marker), path.join(TARGET_DIR, MARKER));
                console.log(`[installer] migrated marker "${marker}" → "${MARKER}" (content already current)`);
            } catch (e) {
                console.warn(`[installer] could not migrate marker name: ${e.message}`);
            }
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
