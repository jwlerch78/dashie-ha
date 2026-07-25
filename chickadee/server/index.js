// Chickadee add-on — brain-runtime STUB.
//
// Implements the integration↔add-on bridge contract (chickadee CONTRACTS.md):
//   - writes the bridge secret to the addon_config mount at startup
//   - GET  /api/ping            → liveness for discovery/config-flow probes
//   - POST /api/voice/converse  → one turn; stub replies {"text": ...}
//
// Auth is ENFORCED from birth (no observe-mode debt): the integration always
// sends X-Chickadee-Bridge-Secret — it refuses to call us without a secret.
// The real brain runtime replaces handleConverse(); everything else stays.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT = 8099;
const DATA_DIR = '/data';
const SECRET_FILE = path.join(DATA_DIR, 'bridge_secret.txt');
// In-container mount point for `addon_config:rw` — HA has used both names across
// versions (surfaces to HA Core at /config/addon_configs/<slug>/). Write to
// whichever exists. Safe: this add-on maps ONLY data + addon_config, so an
// in-container /config can only be the addon_config mount.
const ADDON_CONFIG_CANDIDATES = ['/addon_config', '/config'];
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

/** Mirror the secret to addon_config so the integration can read it. */
function provisionSecret() {
    const secret = loadOrCreateSecret();
    let wrote = 0;
    for (const dir of ADDON_CONFIG_CANDIDATES) {
        try {
            if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
            const dst = path.join(dir, 'bridge_secret');
            const tmp = dst + '.tmp';
            fs.writeFileSync(tmp, secret, { mode: 0o600 });
            fs.renameSync(tmp, dst);
            console.log(`[bridge] secret provisioned to ${dst} (surfaces at /config/addon_configs/<slug>/bridge_secret)`);
            wrote++;
        } catch (e) {
            console.warn(`[bridge] could not write ${dir}: ${e.message}`);
        }
    }
    if (!wrote) {
        console.error('[bridge] DROP: no addon_config mount found — the integration cannot ' +
            "read the bridge secret and every converse call will fail. Is 'addon_config:rw' in config.yaml map?");
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

/** The stub turn. The real brain runtime (engine routing, tools, persona) replaces this. */
async function handleConverse(req, res) {
    if (!checkAuth(req, res)) return;
    let payload;
    try {
        payload = JSON.parse((await readBody(req)) || '{}');
    } catch (e) {
        console.warn('[brain-stub] DROP: unparseable converse body:', e.message);
        sendJson(res, 400, { error: 'bad_json' });
        return;
    }
    const text = String(payload.text || '').trim();
    const nEntities = ((payload.provided_context || {}).ha_entities || []).length;
    // CHICKADEE-TURN is the device-verification log marker — grep for it.
    console.log(`CHICKADEE-TURN text="${text}" endpoint_id=${payload.endpoint_id || '?'} ` +
        `conversation_id=${payload.conversation_id || '-'} entities=${nEntities} area=${(payload.provided_context || {}).device_area || '-'}`);
    sendJson(res, 200, {
        text: text
            ? `Chickadee heard: ${text}. The brain runtime isn't wired up yet, but the bridge works.`
            : 'Chickadee is listening, but no text arrived.',
    });
}

const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    if (req.method === 'GET' && url === '/api/ping') {
        sendJson(res, 200, { ok: true, service: 'chickadee', runtime: 'brain-stub', version: '0.0.1' });
        return;
    }
    if (req.method === 'POST' && url === '/api/voice/converse') {
        handleConverse(req, res).catch((e) => {
            console.error('[brain-stub] DROP: converse handler crashed:', e.message);
            sendJson(res, 500, { error: 'internal' });
        });
        return;
    }
    console.warn(`[brain-stub] DROP: unhandled route ${req.method} ${url}`);
    sendJson(res, 404, { error: 'not_found' });
});

provisionSecret();
server.listen(PORT, () => {
    console.log(`[chickadee] brain-runtime stub listening on :${PORT} (/api/ping, /api/voice/converse)`);
});
