// Chickadee add-on — HTTP surface + bridge auth.
//
// Implements the integration↔add-on bridge contract (chickadee CONTRACTS.md):
//   - writes the bridge secret to the addon_config + HA-config mounts at startup
//   - GET  /api/ping            → liveness for discovery/config-flow probes
//   - POST /api/voice/converse  → one brain turn (converse.js → shared brain core)
//
// Auth is ENFORCED from birth (no observe-mode debt): the integration always
// sends X-Chickadee-Bridge-Secret — it refuses to call us without a secret.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { converse } = require('./converse');
const { handleStt, handleTts } = require('./engines');
const brainMeta = require('./brain/voice-brain.bundle.meta.json');

const VERSION = '0.2.0';  // keep in step with config.yaml version
const PORT = 8099;
const DATA_DIR = '/data';
const SECRET_FILE = path.join(DATA_DIR, 'bridge_secret.txt');
// Where to surface the secret for the integration. HA Core does NOT see
// /addon_configs on HAOS (verified 2026-07-25), so the addon_config copy alone
// is unreadable by the integration — we ALSO drop it inside the HA config dir
// (homeassistant_config:rw mount) at .chickadee/bridge_secret. INTERIM channel:
// any add-on with a config mount can read it; replace with Supervisor discovery.
const ADDON_CONFIG_CANDIDATES = ['/addon_config', '/config'];
const HA_CONFIG_CANDIDATES = ['/homeassistant'];
const HA_CONFIG_SUBDIR = '.chickadee';
const BRIDGE_HEADER = 'x-chickadee-bridge-secret';

// ── Bridge secret ─────────────────────────────────────────────────────────────

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

/** Mirror the secret where the integration can read it. */
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

function checkAuth(req, res) {
    const provided = String(req.headers[BRIDGE_HEADER] || '').trim();
    const secret = loadOrCreateSecret();
    const ok = provided.length > 0 &&
        provided.length === secret.length &&
        crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
    if (ok) return true;
    console.warn(`[bridge] DROP: rejected converse call (${provided ? 'bad_secret' : 'missing_secret'})`);
    sendJson(res, 401, { error: 'bridge_unauthorized' });
    return false;
}

// ── HTTP surface ──────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

async function handleConverse(req, res) {
    if (!checkAuth(req, res)) return;
    let payload;
    try {
        payload = JSON.parse((await readBody(req)) || '{}');
    } catch (e) {
        console.warn('[converse] DROP: unparseable converse body:', e.message);
        sendJson(res, 400, { error: 'bad_json' });
        return;
    }
    const { status, body } = await converse(payload);
    sendJson(res, status, body);
}

const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    if (req.method === 'GET' && url === '/api/ping') {
        sendJson(res, 200, { ok: true, service: 'chickadee', runtime: 'brain', version: VERSION, brain_sha: brainMeta.shortSha || null });
        return;
    }
    if (req.method === 'POST' && url === '/api/voice/converse') {
        handleConverse(req, res).catch((e) => {
            console.error('[converse] DROP: converse handler crashed:', e.message);
            sendJson(res, 500, { error: 'internal' });
        });
        return;
    }
    if (req.method === 'POST' && (url === '/api/voice/stt' || url === '/api/voice/tts')) {
        if (!checkAuth(req, res)) return;
        const handler = url === '/api/voice/stt' ? handleStt : handleTts;
        handler(req, res, sendJson).catch((e) => {
            console.error(`[engines] DROP: ${url} handler crashed:`, e.message);
            sendJson(res, 500, { error: 'internal' });
        });
        return;
    }
    console.warn(`[http] DROP: unhandled route ${req.method} ${url}`);
    sendJson(res, 404, { error: 'not_found' });
});

provisionSecret();
server.listen(PORT, () => {
    console.log(`[chickadee] brain runtime listening on :${PORT} (/api/ping, /api/voice/converse) — brain @ ${brainMeta.shortSha || '?'}`);
});
