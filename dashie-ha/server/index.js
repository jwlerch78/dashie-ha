// SPDX-License-Identifier: AGPL-3.0-only
// Dashie for Home Assistant add-on — Express server: bridge surface + Dashie console.
//
// Two audiences on one port (8099, ports:{} — hassio network + Ingress only):
//
//   BRIDGE (the integration; X-Dashie-Voice-Bridge-Secret enforced from birth):
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
//     /                          the vendored Dashie console SPA

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
    consoleAuthRouter, voiceConsoleRouter, keysRouter, settingsRouter, internalRouter, haRouter, feedsRouter, transcriptsRouter, usageRouter, haRegistry, haWorker,
    supervisor, installer, ingressIdentity;
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
    haRouter = require('./api/ha');
    feedsRouter = require('./api/feeds');
    transcriptsRouter = require('./api/transcripts');
    usageRouter = require('./api/usage');
    haRegistry = require('./ha-registry');
    haWorker = require('./ha-worker');
    supervisor = require('./supervisor');
    installer = require('./integration-installer');
    ingressIdentity = require('./ingress-identity');
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
    sendJson(res, 200, { ok: true, service: 'dashie_ha', runtime: 'brain', version: VERSION, brain_sha: brainMeta.shortSha || null });
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
    let loaded = null;
    // 'current' matters too: if the ADD-ON restarted (e.g. an update) before
    // the user ever restarted core, the files read as current while the
    // integration still isn't loaded — the banner must persist until it is.
    if (instStatus === 'installed' || instStatus === 'updated' || instStatus === 'current') {
        loaded = await supervisor.isIntegrationLoaded();
        pending = loaded === false;
    }
    // Once pending, distinguish "core hasn't restarted yet" (→ restart banner)
    // from "core restarted, discovery card is parked unclicked" (→ the banner
    // absorbs the click via /api/system/configure-integration). Only probed
    // while pending, so steady-state adds no WS traffic.
    let discoveredPending = false;
    // The apply-gap: the integration is LOADED, but the add-on has since
    // re-copied newer files (content-hash gate) that this loaded code predates
    // — a restart is needed to apply them. installedHash (on disk) vs the hash
    // the loaded integration stamped at its last setup; they converge on the
    // next restart, so this self-clears. Only checked when loaded (cheap file reads).
    let updatePending = false;
    if (pending) {
        discoveredPending = !!(await supervisor.getPendingIntegrationFlowId());
    } else if (loaded === true) {
        const onDisk = installer.getInstalledHash();
        const loadedHash = installer.getLoadedHash();
        updatePending = !!(onDisk && loadedHash && onDisk !== loadedHash);
    }
    // Ingress identity. HA has ALREADY authenticated whoever is reading this
    // panel, which is why the console API below needs no bridge secret — and it
    // is also why the UI must not demand a Dashie account from someone who
    // only wants their own local engines. Identity, never authorization: see
    // ingress-identity.js. Cloud surfaces still require a real signed JWT.
    const haUser = ingressIdentity.ingressUser(req);
    // Our own slug, so the local-mode panel can DEEP-LINK to the add-on's
    // Configuration page. The sidebar panel has no tabs of its own, so telling the
    // user to "use the Configuration tab" from in there is a dead end.
    const addonSlug = await supervisor.getSelfSlug();
    res.json({
        addon: true,
        dashie_ha: true,
        version: VERSION,
        supabase_env: CLOUD_ENV,
        email_auth: true,
        ingress: ingressIdentity.isIngress(req),
        ha_user: haUser,
        addon_slug: addonSlug,
        integration: instStatus,
        integration_pending_restart: pending,
        integration_discovered_pending: discoveredPending,
        integration_update_pending_restart: updatePending,
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

// Behind the banner's "Configure" button once core has restarted and the
// discovery card is parked: complete the flow so the integration loads —
// the "one-click Configure" the banner promises, no menu-diving (Ingress-
// trusted).
app.post('/api/system/configure-integration', async (req, res) => {
    const flowId = await supervisor.getPendingIntegrationFlowId();
    if (!flowId) {
        console.warn('[system] configure-integration: no pending dashie_voice discovery flow');
        return res.status(409).json({ ok: false, error: 'no_pending_flow' });
    }
    console.log(`[system] completing dashie_voice discovery flow ${flowId} from the console`);
    const result = await supervisor.completeIntegrationFlow(flowId);
    res.status(result.ok ? 200 : 502).json(result);
});

app.use('/api/auth', consoleAuthRouter);
app.use('/api/voice', voiceConsoleRouter);   // engines/probe/preview/discover/… (bridge routes matched above)
// HA data plane: device metrics/status, control, images, SSE, adopt.
// Mounted with the console routers — i.e. AFTER the raw-body bridge
// handlers above, which must keep seeing unparsed bodies.
app.use('/api/ha', haRouter);
// Household camera feeds (proxies the integration's feed_registry views).
app.use('/api/feeds', feedsRouter);
// HA-local kiosk voice transcripts (.storage/dashie.voice_transcripts).
app.use('/api/transcripts', transcriptsRouter);
// The READ half of the box-local usage record. Ingress-protected, read-only, and
// the ONLY usage surface an account-less box has (Supabase is unreachable there).
app.use('/api/usage', usageRouter);
app.use('/api/keys', keysRouter);
app.use('/api/settings', settingsRouter);
// Bridge-secret gated (LAN-sharing lane for the integration's /api/dashie/voice/* views).
app.use('/api/internal', internalRouter);

// ── Frontend: the vendored Dashie console ──────────────────────────────────

app.use('/', express.static(FRONTEND_DIR));

// Unhandled-route DROP logging, deduped.
//
// CLAUDE.md rule 2 says every dispatch fallthrough logs a distinctive DROP. It does
// NOT say log it unboundedly, and on 2026-07-31 that distinction became load-bearing:
// a client retry loop hit one unserved route hard enough that 2000/2000 lines of the
// add-on log were the same DROP marker, hiding the boot banner and every other line.
// A drop nobody can find in the noise is functionally a silent one.
//
// So: log the FIRST hit on a route immediately (never delay the signal), then at most
// once a minute with the suppressed count. The marker still greps.
const DROP_LOG_INTERVAL_MS = 60 * 1000;
const dropSeen = new Map();     // "METHOD /path" → { count, lastLoggedAt }
function logRouteDrop(method, path) {
    const key = `${method} ${path}`;
    const now = Date.now();
    let rec = dropSeen.get(key);
    if (!rec) {
        // Distinct unhandled paths are attacker/param controlled (/api/ha/image/<id>/…),
        // so bound the map rather than let it grow with traffic.
        if (dropSeen.size > 200) dropSeen.clear();
        rec = { count: 0, lastLoggedAt: 0 };
        dropSeen.set(key, rec);
    }
    rec.count++;
    if (now - rec.lastLoggedAt < DROP_LOG_INTERVAL_MS) return;
    const suppressed = rec.count - 1;
    rec.lastLoggedAt = now;
    rec.count = 0;
    console.warn(`[http] DROP: unhandled route ${key}`
        + (suppressed > 0 ? ` (${suppressed} more in the last ${DROP_LOG_INTERVAL_MS / 1000}s)` : ''));
}

// SPA fallback — non-API, extension-less paths get index.html.
app.get('*', (req, res, next) => {
    const normalizedPath = req.path.replace(/^\/+/, '/');
    if (normalizedPath.startsWith('/api/')) {
        logRouteDrop(req.method, normalizedPath);
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
console.log(`Dashie for Home Assistant add-on v${VERSION}`);
console.log(`Node: ${process.version} · data: ${DATA_DIR} · cloud: ${CLOUD_ENV} (${CLOUD.url})`);
console.log(`Console: ${FRONTEND_DIR} (${fs.existsSync(FRONTEND_DIR) ? 'present' : 'MISSING'})`);
console.log(`Brain: @ ${brainMeta.shortSha || '?'}`);
console.log('='.repeat(60));

bridgeAuth.provisionSecret();
// Primary secret channel: Supervisor discovery → integration async_step_hassio.
discovery.publishWithRetry(bridgeAuth.loadOrCreateSecret());
// THE HA WebSocket client — one socket, shared by engine detection, LAN
// discovery and the config-flow probe. No-op without a token.
haRegistry.start();
// Device-metrics poller (HA states → user_devices.metrics via database-operations).
// It is the ONLY writer of that data anywhere, which is why a published add-on
// without it showed the Devices page with empty cards. Degrades to an idle loop
// on a box with no HA token or no Dashie account — see runPoll's logSkip guards,
// which dedupe by reason so an unconfigured box logs once, not every 5s.
haWorker.start();
// "All at once" onboarding: install/update the vendored integration into
// /config/custom_components (option-gated; HACS installs never touched).
installer.ensureIntegration();
// Put the Dashie panel in the HA sidebar without hunting for the toggle.
supervisor.ensureSidebarPanel();
// Clear stored options whose schema key is gone. Removing an option from
// config.yaml removes it from the TAB, not from the box's stored config — measured
// on John's box after 0.9.20, where four of five removed keys survived, including
// the `log_level: debug` he had actually set. Fire-and-forget: every branch of the
// prune fails toward doing nothing, and startup must not wait on the Supervisor.
require('./prune-orphan-options').pruneOrphanOptions();

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[dashie-ha] listening on :${PORT} (bridge + console) — brain @ ${brainMeta.shortSha || '?'}`);
});
server.on('error', (err) => {
    console.error('[fatal] Server error:', err?.stack || err);
    process.exit(1);
});
