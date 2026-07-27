// bridge-auth.js — the integration↔add-on bridge secret (chickadee CONTRACTS.md).
//
// Extracted from index.js when the server became Express (console port); the
// behavior is unchanged: generate-or-load the secret in /data, mirror it where
// the integration can read it (legacy file channels), and verify the
// X-Chickadee-Bridge-Secret header on bridge calls. The PRIMARY channel is
// Supervisor discovery (discovery.js) — the file copies remain for older
// integrations.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./config');

const SECRET_FILE = path.join(DATA_DIR, 'bridge_secret.txt');
// Where to surface the secret for the integration. HA Core does NOT see
// /addon_configs on HAOS (verified 2026-07-25), so the addon_config copy alone
// is unreadable by the integration — we ALSO drop it inside the HA config dir
// (homeassistant_config:rw mount) at .chickadee/bridge_secret. INTERIM channel:
// any add-on with a config mount can read it; Supervisor discovery is primary.
const ADDON_CONFIG_CANDIDATES = ['/addon_config', '/config'];
const HA_CONFIG_CANDIDATES = ['/homeassistant'];
const HA_CONFIG_SUBDIR = '.chickadee';
const BRIDGE_HEADER = 'x-chickadee-bridge-secret';

let _secret = null;

function loadOrCreateSecret() {
    if (_secret) return _secret;
    try {
        if (fs.existsSync(SECRET_FILE)) {
            const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
            if (s) { _secret = s; return _secret; }
        }
    } catch (e) {
        console.error('[bridge] failed to read secret:', e.message);
    }
    _secret = crypto.randomBytes(32).toString('hex');
    try {
        const tmp = SECRET_FILE + '.tmp';
        fs.writeFileSync(tmp, _secret, { mode: 0o600 });
        fs.renameSync(tmp, SECRET_FILE);
        console.log('[bridge] generated a new bridge secret');
    } catch (e) {
        console.error('[bridge] failed to persist secret:', e.message);
    }
    return _secret;
}

/** Mirror the secret where the integration can read it (legacy file channels). */
function provisionSecret() {
    const secret = loadOrCreateSecret();
    let wrote = 0;
    const targets = [];
    for (const dir of ADDON_CONFIG_CANDIDATES) {
        targets.push(path.join(dir, 'bridge_secret'));
    }
    for (const dir of HA_CONFIG_CANDIDATES) {
        targets.push(path.join(dir, HA_CONFIG_SUBDIR, 'bridge_secret'));
    }
    for (const dst of targets) {
        try {
            const dir = path.dirname(dst);
            const mountRoot = dst.split(path.sep).slice(0, 2).join(path.sep) || path.sep;
            if (!fs.existsSync(mountRoot) || !fs.statSync(mountRoot).isDirectory()) continue;
            fs.mkdirSync(dir, { recursive: true });
            const tmp = dst + '.tmp';
            fs.writeFileSync(tmp, secret, { mode: 0o600 });
            fs.renameSync(tmp, dst);
            console.log(`[bridge] secret provisioned to ${dst}`);
            wrote++;
        } catch (e) {
            console.warn(`[bridge] could not write ${dst}: ${e.message}`);
        }
    }
    if (!wrote) {
        console.error('[bridge] DROP: no writable secret target found — the integration cannot ' +
            'read the bridge secret and every converse call will fail. Check config.yaml map entries.');
    }
}

/**
 * Verify the bridge secret header. On failure sends the 401 itself and
 * returns false (same contract the pre-Express handlers used).
 */
function checkAuth(req, res, sendJson) {
    const provided = String(req.headers[BRIDGE_HEADER] || '').trim();
    const secret = loadOrCreateSecret();
    const ok = provided.length > 0 &&
        provided.length === secret.length &&
        crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
    if (ok) return true;
    console.warn(`[bridge] DROP: rejected bridge call (${provided ? 'bad_secret' : 'missing_secret'})`);
    sendJson(res, 401, { error: 'bridge_unauthorized' });
    return false;
}

module.exports = { loadOrCreateSecret, provisionSecret, checkAuth };
