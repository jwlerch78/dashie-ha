// SPDX-License-Identifier: AGPL-3.0-only
// server/lan-discovery.js — find self-hosted voice/AI engines on the household LAN.
//
// The Console's "Scan network" button (Local Engines page) calls POST /api/voice/discover,
// which lands here. Two stages:
//
//   1. deriveSubnet() — figure out WHICH /24 to scan, WITHOUT scanning. Every Dashie tablet
//      publishes its own LAN IP to HA (`sensor.<device>_wifi_signal` → attributes.ip_address),
//      and HA's own `internal_url` usually carries its host IP. We take the /24 the MAJORITY of
//      those agree on. A tablet can't misreport its own NIC, so this is proxy-proof: if HA sits
//      behind a reverse proxy at 10.x but the tablets are on 192.168.86.x, the tablets win —
//      which is correct, because the engines live where the tablets live.
//
//   2. scanSubnet() — TCP-probe the known engine ports across .1–.254 (bounded concurrency),
//      then identify only the ports that answered, via a read-only unauthenticated GET of
//      each engine's version/id endpoint — never POST, never /api/ on an unidentified host
//      (HaDiscovery.kt learned that hitting HA's /api/ blind trips its IP-ban; we don't
//      repeat it). Results render in the console and are never sent off-box.
//
// User-initiated only (a button), private ranges only (a scanner must never point at a public
// subnet), and nothing leaves the network.

const net = require('net');
const haWs = require('./ha-ws');

const CONNECT_TIMEOUT_MS = 300;   // dead hosts RST/timeout fast; live ones answer instantly
const FINGERPRINT_TIMEOUT_MS = 1500;
const CONCURRENCY = 128;

// port → how to identify what's listening. `http` fingerprints run only if the TCP probe
// succeeds. `kind` maps to the Local Engines editor's engine kind; `tcpOnly` engines (Wyoming)
// aren't OpenAI-compatible — we surface them as "use via Home Assistant", not selectable.
const ENGINE_PORTS = [
    { port: 11434, kind: 'llm', http: { path: '/api/tags',        engine: 'Ollama',        list: j => (j.models || []).map(m => m.name) } },
    { port: 8880,  kind: 'tts', http: { path: '/v1/audio/voices', engine: 'Kokoro',        list: j => normVoices(j) } },
    { port: 8881,  kind: 'tts', http: { path: '/health',          engine: 'Piper',         match: j => j && String(j.engine).toLowerCase() === 'piper' } },
    { port: 8000,  kind: 'stt', http: { path: '/v1/models',       engine: 'Whisper (OpenAI-compatible)', list: j => (j.data || []).map(m => m.id), fallback: { path: '/health', engine: 'Whisper (whisper.cpp)' } } },
    { port: 8080,  kind: 'llm', http: { path: '/v1/models',       engine: 'llama.cpp',      list: j => (j.data || []).map(m => m.id) } },
    { port: 1234,  kind: 'llm', http: { path: '/v1/models',       engine: 'LM Studio',      list: j => (j.data || []).map(m => m.id) } },
    { port: 10200, kind: 'tts', tcpOnly: true, engine: 'Wyoming Piper',   note: 'Configure under Home Assistant, then pick “Piper (Home Assistant)”.' },
    { port: 10300, kind: 'stt', tcpOnly: true, engine: 'Wyoming Whisper', note: 'Configure under Home Assistant, then pick “Whisper (Home Assistant)”.' },
];

function normVoices(j) {
    const list = Array.isArray(j?.voices) ? j.voices : [];
    return list.map(v => (typeof v === 'string' ? v : (v.voice_id || v.id || v.name))).filter(Boolean);
}

// RFC-1918 only. A scanner that can be pointed at a public /24 (misconfigured internal_url, a
// VPN interface) is a liability; refuse anything else and let the caller fall back to manual.
function isPrivate(ip) {
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(ip || ''));
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

const slash24 = ip => ip.split('.').slice(0, 3).join('.');   // 192.168.86.48 → "192.168.86"

/** The /24 to scan, decided from HA state alone (no scanning). Returns
 *  { subnet: "192.168.86", votes, sources } or { subnet: null, sources } when nothing usable. */
async function deriveSubnet() {
    const candidates = [];   // { ip, from }
    try {
        const cfg = await haWs.getHaConfig();
        const m = /(\d+\.\d+\.\d+\.\d+)/.exec(String(cfg?.internal_url || ''));
        if (m && isPrivate(m[1])) candidates.push({ ip: m[1], from: 'HA internal_url' });
    } catch { /* HA config optional */ }
    try {
        const states = await haWs.getStates();
        for (const s of states || []) {
            const ip = s?.attributes?.ip_address;
            if (ip && isPrivate(ip)) candidates.push({ ip, from: s.entity_id });
        }
    } catch { /* states optional */ }

    // Consensus: the /24 the most candidates share. Tablets outvote a single HA/proxy IP.
    const tally = {};
    for (const c of candidates) tally[slash24(c.ip)] = (tally[slash24(c.ip)] || []).concat(c);
    const ranked = Object.entries(tally).sort((a, b) => b[1].length - a[1].length);
    if (!ranked.length) return { subnet: null, votes: 0, sources: [] };
    const [subnet, winners] = ranked[0];
    return { subnet, votes: winners.length, sources: winners.map(w => ({ ip: w.ip, from: w.from })) };
}

// ── the sweep ────────────────────────────────────────────────────────────────

function tcpOpen(host, port) {
    return new Promise(resolve => {
        const sock = new net.Socket();
        let done = false;
        const finish = ok => { if (done) return; done = true; sock.destroy(); resolve(ok); };
        sock.setTimeout(CONNECT_TIMEOUT_MS);
        sock.once('connect', () => finish(true));
        sock.once('timeout', () => finish(false));
        sock.once('error', () => finish(false));
        sock.connect(port, host);
    });
}

async function getJson(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FINGERPRINT_TIMEOUT_MS);
    try {
        const r = await fetch(url, { signal: ctl.signal });   // read-only GET of a version/id endpoint
        if (!r.ok) return null;
        return await r.json().catch(() => ({}));   // reachable but non-JSON still counts as "up"
    } catch { return null; } finally { clearTimeout(timer); }
}

/** Identify what's on an open host:port. Returns a result row, or null if the port answered TCP
 *  but the HTTP fingerprint didn't confirm a known engine (a coincidental listener). */
async function fingerprint(host, spec) {
    const base = `http://${host}:${spec.port}`;
    if (spec.tcpOnly) {
        return { host, port: spec.port, url: base, kind: spec.kind, engine: spec.engine, tcpOnly: true, note: spec.note };
    }
    const h = spec.http;
    const j = await getJson(base + h.path);
    if (j === null) {
        if (!h.fallback) return null;
        const jf = await getJson(base + h.fallback.path);
        if (jf === null) return null;
        return { host, port: spec.port, url: base, kind: spec.kind, engine: h.fallback.engine, models: [] };
    }
    if (h.match && !h.match(j)) return null;              // health-shape check (Piper shim)
    const models = h.list ? h.list(j) : [];
    return { host, port: spec.port, url: base, kind: spec.kind, engine: h.engine, models };
}

/** Sweep `subnet` (".1"–".254" × every engine port) with bounded concurrency. Returns the
 *  identified engines, sorted by host then port. */
async function scanSubnet(subnet) {
    const jobs = [];
    for (let i = 1; i <= 254; i++) {
        const host = `${subnet}.${i}`;
        for (const spec of ENGINE_PORTS) jobs.push({ host, spec });
    }
    const results = [];
    let next = 0;
    async function worker() {
        while (next < jobs.length) {
            const { host, spec } = jobs[next++];
            if (!(await tcpOpen(host, spec.port))) continue;
            const row = await fingerprint(host, spec);
            if (row) results.push(row);
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    results.sort((a, b) => (a.host === b.host ? a.port - b.port
        : a.host.split('.').map(Number).at(-1) - b.host.split('.').map(Number).at(-1)));
    return results;
}

/** Top-level: derive the subnet, then scan it. `subnetOverride` ("192.168.1") skips derivation
 *  (the manual-entry fallback). Returns { ok, subnet, source, engines[] } — never throws. */
async function discover({ subnetOverride } = {}) {
    let subnet = null, source = null, votes = 0, sources = [];
    if (subnetOverride && /^\d+\.\d+\.\d+$/.test(subnetOverride) && isPrivate(`${subnetOverride}.1`)) {
        subnet = subnetOverride; source = 'manual';
    } else {
        const d = await deriveSubnet();
        subnet = d.subnet; votes = d.votes; sources = d.sources; source = 'ha';
    }
    if (!subnet) return { ok: false, reason: 'no_subnet', subnet: null, engines: [] };
    const engines = await scanSubnet(subnet);
    return { ok: true, subnet, source, votes, sources, engines };
}

module.exports = { discover, deriveSubnet, scanSubnet, isPrivate };
