// Chickadee add-on — Express server: bridge surface + Chickadee console.
//
// Two audiences on one port (8099, ports:{} — hassio network + Ingress only):
//
//   BRIDGE (the integration; X-Chickadee-Bridge-Secret enforced from birth):
//     GET  /api/ping             liveness for discovery/config-flow probes
//     POST /api/voice/converse   one brain turn (converse.js)
//     POST /api/voice/stt|tts    engine routing (engines.js)
//     *    /api/voice/voices     TTS voice catalog (engines.js)
//   These handlers predate Express and read their own raw bodies — no global
//   body parser may run before them (STT posts binary audio).
//
//   CONSOLE (HA Ingress authenticates the user; no bridge secret):
//     GET  /api/runtime          add-on detection for the SPA (+ email_auth)
//     /api/auth/*                sign-in state, device flow, email/password
//     /api/voice/engines|probe|preview|discover|local-status|converse-local
//     /api/keys/*                on-box BYO provider keys
//     /api/settings/*            add-on-local settings
//     /                          the vendored Chickadee console SPA

'use strict';

process.on('uncaughtException', (err) => {
    console.error('[fatal] Uncaught exception:', err?.stack || err);
    process.exit(1);
});
process.on('unhandledRejection', (err) => {
    console.error('[fatal] Unhandled rejection:', err?.stack || err);
    process.exit(1);
});

let path, fs, express, config, bridgeAuth, converseMod, enginesMod, discovery, brainMeta,
    consoleAuthRouter, voiceConsoleRouter, keysRouter, settingsRouter, internalRouter, haWs,
    supervisor, installer;
try {
    path = require('path');
    fs = require('fs');
    express = require('express');
    config = require('./config');
    bridgeAuth = require('./bridge-auth');
    converseMod = require('./converse');
    enginesMod = require('./engines');
    discovery = require('./discovery');
    brainMeta = require('./brain/voice-brain.bundle.meta.json');
    consoleAuthRouter = require('./api/console-auth');
    voiceConsoleRouter = require('./api/voice-console');
    keysRouter = require('./api/keys');
    settingsRouter = require('./api/settings');
    internalRouter = require('./api/internal');
    haWs = require('./ha-ws');
    supervisor = require('./supervisor');
    installer = require('./integration-installer');
} catch (err) {
    console.error('[fatal] Failed to load modules:', err?.stack || err);
    console.error('[fatal] Node version:', process.version);
    process.exit(1);
}

const { PORT, FRONTEND_DIR, DATA_DIR, CLOUD_ENV, CLOUD, VERSION } = config;
const app = express();

// ── Plumbing shared with the pre-Express bridge handlers ──────────────────────

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

// Normalize leading double-slashes. HA Ingress can route paths like //api/runtime
// (ingress_entry + relative-URL interaction); Express route matching is strict
// about a single leading slash.
app.use((req, res, next) => {
    if (req.url.startsWith('//')) req.url = req.url.replace(/^\/+/, '/');
    next();
});

// ── Bridge surface (secret-gated; raw bodies; BEFORE any parser) ──────────────

app.get('/api/ping', (req, res) => {
    sendJson(res, 200, { ok: true, service: 'chickadee', runtime: 'brain', version: VERSION, brain_sha: brainMeta.shortSha || null });
});

app.post('/api/voice/converse', (req, res) => {
    if (!bridgeAuth.checkAuth(req, res, sendJson)) return;
    (async () => {
        let payload;
        try {
            payload = JSON.parse((await readBody(req)) || '{}');
        } catch (e) {
            console.warn('[converse] DROP: unparseable converse body:', e.message);
            sendJson(res, 400, { error: 'bad_json' });
            return;
        }
        const { status, body } = await converseMod.converse(payload);
        sendJson(res, status, body);
    })().catch((e) => {
        console.error('[converse] DROP: converse handler crashed:', e.message);
        sendJson(res, 500, { error: 'internal' });
    });
});

app.all('/api/voice/voices', (req, res) => {
    if (!bridgeAuth.checkAuth(req, res, sendJson)) return;
    enginesMod.handleVoices(req, res, sendJson).catch((e) => {
        console.error('[engines] DROP: voices handler crashed:', e.message);
        sendJson(res, 500, { error: 'internal' });
    });
});

for (const [route, handler] of [['/api/voice/stt', enginesMod.handleStt], ['/api/voice/tts', enginesMod.handleTts]]) {
    app.post(route, (req, res) => {
        if (!bridgeAuth.checkAuth(req, res, sendJson)) return;
        handler(req, res, sendJson).catch((e) => {
            console.error(`[engines] DROP: ${route} handler crashed:`, e.message);
            sendJson(res, 500, { error: 'internal' });
        });
    });
}

// ── Console surface (Ingress-trusted) ─────────────────────────────────────────

// Add-on detection for the SPA (console-auth.js _probeAddonMode). email_auth
// advertises the email/password endpoints so the login screen lights them up.
const STARTED_AT = new Date().toISOString();
app.get('/api/runtime', async (req, res) => {
    // integration_pending_restart drives the console's "restart HA to
    // activate" banner: the installer put files down this add-on run AND the
    // running core hasn't loaded the component. isIntegrationLoaded is the
    // live check — the installer status alone goes stale across core restarts.
    const instStatus = installer.getStatus();
    let pending = false;
    if (instStatus === 'installed' || instStatus === 'updated') {
        const loaded = await supervisor.isIntegrationLoaded();
        pending = loaded === false;
    }
    res.json({
        addon: true,
        chickadee: true,
        version: VERSION,
        supabase_env: CLOUD_ENV,
        email_auth: true,
        integration: instStatus,
        integration_pending_restart: pending,
        started_at: STARTED_AT,
    });
});

// Behind the console banner's "Restart Home Assistant" button (Ingress-
// trusted; requires hassio_role: manager in config.yaml).
app.post('/api/system/restart-core', async (req, res) => {
    console.log('[system] core restart requested from the console');
    const ok = await supervisor.restartCore();
    res.status(ok ? 200 : 502).json({ ok });
});

app.use('/api/auth', consoleAuthRouter);
app.use('/api/voice', voiceConsoleRouter);   // engines/probe/preview/discover/… (bridge routes matched above)
app.use('/api/keys', keysRouter);
app.use('/api/settings', settingsRouter);
// Bridge-secret gated (LAN-sharing lane for the integration's /api/dashie/voice/* views).
app.use('/api/internal', internalRouter);

// ── Frontend: the vendored Chickadee console ──────────────────────────────────

app.use('/', express.static(FRONTEND_DIR));

// SPA fallback — non-API, extension-less paths get index.html.
app.get('*', (req, res, next) => {
    const normalizedPath = req.path.replace(/^\/+/, '/');
    if (normalizedPath.startsWith('/api/')) {
        console.warn(`[http] DROP: unhandled route ${req.method} ${normalizedPath}`);
        return res.status(404).json({ error: 'not_found' });
    }
    if (req.path.includes('.')) return next();
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

app.use((err, req, res, next) => {
    console.error('[server error]', err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'server_error', message: err.message });
});

// ── Start ─────────────────────────────────────────────────────────────────────

console.log('='.repeat(60));
console.log(`Chickadee add-on v${VERSION}`);
console.log(`Node: ${process.version} · data: ${DATA_DIR} · cloud: ${CLOUD_ENV} (${CLOUD.url})`);
console.log(`Console: ${FRONTEND_DIR} (${fs.existsSync(FRONTEND_DIR) ? 'present' : 'MISSING'})`);
console.log(`Brain: @ ${brainMeta.shortSha || '?'}`);
console.log('='.repeat(60));

bridgeAuth.provisionSecret();
// Primary secret channel: Supervisor discovery → integration async_step_hassio.
discovery.publishWithRetry(bridgeAuth.loadOrCreateSecret());
// HA WebSocket (engine detection / LAN discovery) — no-op without a token.
haWs.start();
// "All at once" onboarding: install/update the vendored integration into
// /config/custom_components (option-gated; HACS installs never touched).
installer.ensureIntegration();
// Put the Chickadee panel in the HA sidebar without hunting for the toggle.
supervisor.ensureSidebarPanel();

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[chickadee] listening on :${PORT} (bridge + console) — brain @ ${brainMeta.shortSha || '?'}`);
});
server.on('error', (err) => {
    console.error('[fatal] Server error:', err?.stack || err);
    process.exit(1);
});
