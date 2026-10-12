// SPDX-License-Identifier: AGPL-3.0-only
// check-brain-key-fallback.mjs — the brain's "key first, then credits" (John 2026-10-12), driven end to end.
//
// A household-key (BYOK) turn whose provider refuses the KEY is re-asked of Dashie Cloud on credits, with
// the key-health row written first. Everything else keeps the turn as it was. Rules and reasons:
// server/brain-key-fallback.js.
//
// REAL: converse.js, account-config.js, providers.js, brain/addon-io.js (so the refusal goes through the
// real gateway error branch), the real brain bundle (so pass 1 fails through the real errorTurn), the
// key-health vocabulary and key-health.js. FAKED: `fetch` (the provider, the account read, the
// database-operations writes, the cloud brain), auth, key-store, options, the panel blob, and the two
// box-local recorders (usage-store, turn-log), which would otherwise write into DATA_DIR.
// One leg swaps in a scripted brain: a pass-2 refusal needs a pass 1 that SUCCEEDS, and a real one would
// need a model's answer in a shape this file would then be pinning.
//
// ⚠️ What a green does NOT prove: that a real provider answers with these shapes today (fixtures follow
//    the shared vocabulary, not a live call); that the cloud brain bills the fallback turn (that is the
//    edge's own metering); that a tablet or HA speaker renders the pill or speaks the turn.
// Run: node scripts/check-brain-key-fallback.mjs   Exit 0 = ALL PASS, 1 = a failure, 2 = cannot check.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashie-ha', 'server');
const require_ = createRequire(path.join(SERVER, 'x.js'));
const stub = (rel, exports) => { const p = require_.resolve(rel); require_.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const state = {};
let events = [];   // ordered: 'report_key_failure:<status>', 'report_key_ok', 'cloud', 'provider'

stub('./auth', {
    getValidJwt: async () => { if (!state.signedIn) throw new Error('not_signed_in'); return { jwt: 'jwt-test', userId: 'user-test' }; },
    readStoredJwt: () => (state.signedIn ? 'jwt-test' : null),
});
stub('./key-store', {
    status: () => state.keys || {},
    readKeys: () => Object.fromEntries(Object.keys(state.keys || {}).map((p) => [p, { key: `sk-${p}` }])),
});
stub('./options', { readOptions: () => ({}) });
stub('./settings-store', { readUserSettings: () => state.localBlob ?? {} });
stub('./usage-store', { recordLocalUsage: () => {} });
stub('./turn-log', { recordTurnIfEnabled: () => {} });

// The brain: the REAL bundle unless a leg scripts one.
let realBrain;
try { realBrain = require_('./brain/voice-brain.bundle.js'); } catch (e) {
    console.error(`check-brain-key-fallback: cannot check — the brain bundle did not load: ${e.message}`); process.exit(2);
}
stub('./brain/voice-brain.bundle.js', {
    runOrchestration: (...a) => (state.brain || realBrain.runOrchestration)(...a),
    BRAIN_SOURCE_SHA: realBrain.BRAIN_SOURCE_SHA,
});

const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (/generativelanguage|api\.openai\.com|openrouter\.ai/.test(u)) {
        events.push('provider');
        const r = state.provider(events.filter((e) => e === 'provider').length);
        return json(r.status, r.body);
    }
    if (u.includes('/functions/v1/voice-conversation')) {
        events.push('cloud');
        if (state.cloud === 'throw') throw new Error('ECONNREFUSED');
        return json(state.cloud.status, state.cloud.body);
    }
    if (u.includes('/functions/v1/database-operations')) {
        const { operation, data } = JSON.parse(init.body || '{}');
        if (operation === 'report_key_failure') events.push(`report_key_failure:${data.provider}:${data.status}`);
        if (operation === 'report_key_ok') events.push(`report_key_ok:${data.provider}`);
        return json(200, operation === 'get_credit_balance' ? { balance: 10 } : {});
    }
    // the account read (account-config) and anything else
    return json(200, [{ settings: state.settings || {}, retain_transcripts: false }]);
};

let accountConfig, converse, keyHealth;
try {
    accountConfig = require_('./account-config.js');
    ({ converse } = require_('./converse.js'));
    keyHealth = require_('./key-health.js');
} catch (e) {
    console.error(`check-brain-key-fallback: cannot check — module did not load: ${e.message}`); process.exit(2);
}

const CLOUD_OK = { status: 200, body: { ok: true, type: 'chat', voice: 'It is three o\'clock.', text: 'It is three o\'clock.' } };
const NO_CREDITS = { status: 200, body: { ok: true, type: 'chat', voice: '', text: '', metadata: { degraded: 'insufficient_credits' } } };
const refuse = (status, message) => () => ({ status, body: { error: { message } } });
const answer = (content) => ({ status: 200, body: { choices: [{ message: { content } }], model: 'gemini-2.5-flash', usage: {} } });

const scenario = (s) => {
    Object.assign(state, {
        signedIn: true, keys: { gemini: true }, localBlob: {}, brain: null, cloud: CLOUD_OK,
        settings: { ai: { model: 'gemini-2.5-flash' }, voice: { householdSharing: true } },
    }, s);
    events = [];
    accountConfig.invalidate();
    keyHealth.__resetForTest();
};
const turn = async () => {
    const w = console.warn, l = console.log, e = console.error;
    const lines = [];
    console.warn = (...a) => lines.push(a.join(' ')); console.log = (...a) => lines.push(a.join(' ')); console.error = (...a) => lines.push(a.join(' '));
    try {
        const r = await converse({ text: 'what time is it' });
        return { route: r.routeTag || '(none)', voice: r.body?.voice ?? null, ok: r.body?.ok, events: [...events], lines };
    } finally { console.warn = w; console.log = l; console.error = e; }
};

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
    cond ? pass++ : fail++;
    console.log(`${cond ? '✅' : '🔴'} ${name}${cond ? '' : `\n     ${detail}`}`);
};
const show = (t) => JSON.stringify({ route: t.route, events: t.events, voice: t.voice });

console.log('\n── F: a KEY fault at pass 1 falls back to credits, the row written FIRST ──');
for (const [label, prov, want] of [
    ['401', refuse(401, 'Unauthorized'), 'invalid_key'],
    ['400 API_KEY_INVALID (Gemini)', refuse(400, 'API key not valid. Please pass a valid API key.'), 'invalid_key'],
    ['403', refuse(403, 'Permission denied'), 'forbidden'],
    ['429 quota', refuse(429, 'Resource has been exhausted'), 'rate_limited'],
]) {
    scenario({ provider: prov });
    const t = await turn();
    const iRow = t.events.indexOf(`report_key_failure:gemini:${want}`), iCloud = t.events.indexOf('cloud');
    check(`F ${label} → ${want}, row then cloud, the cloud's answer is returned`,
        t.route === 'byok:gemini→cloud' && iRow !== -1 && iCloud > iRow && t.voice === CLOUD_OK.body.voice
        && t.events.filter((e) => e === 'provider').length === 1, show(t));
}

console.log('\n── ⚖️ C: NOT the key — no fallback, no pill, the turn stands ──');
for (const [label, prov] of [['503 outage', refuse(503, 'Service Unavailable')], ['400 our malformed request', refuse(400, 'Invalid JSON payload received.')]]) {
    scenario({ provider: prov });
    const t = await turn();
    check(`C ${label} → no cloud, no key-health row`,
        t.route === 'byok:gemini' && !t.events.includes('cloud') && !t.events.some((e) => e.startsWith('report_key_failure')), show(t));
}

console.log('\n── N: the key is refused but nothing can pay — the ORIGINAL key turn ──');
scenario({ provider: refuse(401, 'Unauthorized'), cloud: NO_CREDITS });
let t = await turn();
check('N1 cloud answers insufficient_credits → original turn (spoken key error), row still written',
    t.route === 'byok:gemini' && t.events.includes('report_key_failure:gemini:invalid_key') && t.events.includes('cloud')
    && /key/i.test(t.voice || ''), show(t));
scenario({ provider: refuse(401, 'Unauthorized'), cloud: 'throw' });
t = await turn();
check('N2 cloud unreachable → original turn, not "couldn\'t reach Dashie Cloud"',
    t.route === 'byok:gemini' && /key/i.test(t.voice || '') && !/reach Dashie Cloud/.test(t.voice || ''), show(t));
scenario({ signedIn: false, provider: refuse(401, 'Unauthorized'),
    localBlob: { ai: { model: 'gemini-2.5-flash' }, voice: { householdSharing: true } } });
t = await turn();
check('N3 signed out → no cloud, no account write, the key error stands',
    t.route === 'byok:gemini' && !t.events.includes('cloud') && !t.events.some((e) => e.startsWith('report_key')) && /key/i.test(t.voice || ''), show(t));

console.log('\n── P: a refusal AFTER pass 1 never re-asks (tools may already have run and billed) ──');
const scripted = async (_deps, io) => {
    const p1 = await io.callGateway({ provider: 'gemini', prompt: 'p1', modelId: 'gemini-2.5-flash', kind: 'decide' });
    const p2 = await io.callGateway({ provider: 'gemini', prompt: 'p2', modelId: 'gemini-2.5-flash', kind: 'narrate' });
    return { ok: p1.ok && p2.ok, type: p2.ok ? 'chat' : 'error', voice: p2.ok ? 'fine' : 'Your Gemini key was rejected.' };
};
scenario({ brain: scripted, provider: (n) => (n === 1 ? answer('{"type":"chat"}') : refuse(401, 'Unauthorized')()) });
t = await turn();
check('P pass 2 refused → no cloud, the row IS written, the key turn stands',
    t.route === 'byok:gemini' && !t.events.includes('cloud') && t.events.includes('report_key_failure:gemini:invalid_key'), show(t));

console.log('\n── K: the key WORKS — the turn stands and a stale pill is cleared ──');
scenario({ brain: async (_d, io) => { const r = await io.callGateway({ provider: 'gemini', prompt: 'p', modelId: 'gemini-2.5-flash' }); return { ok: r.ok, type: 'chat', voice: 'fine' }; },
    provider: () => answer('fine') });
t = await turn();
await new Promise((r) => setTimeout(r, 20));   // reportOk is fire-and-forget
check('K pass 1 ok → no cloud, report_key_ok sent', t.route === 'byok:gemini' && !t.events.includes('cloud')
    && events.includes('report_key_ok:gemini'), JSON.stringify({ ...JSON.parse(show(t)), after: events }));

console.log('\n── ⚖️ R: only the BYOK tier is watched — the account\'s own box is never re-routed ──');
scenario({ keys: {}, settings: { ai: { model: 'local' }, voice: { householdSharing: true, localLlmUrl: 'http://box:11434', localLlmModel: 'qwen3', localLlmKey: 'sk-box' } },
    brain: async (_d, io) => { const r = await io.callGateway({ provider: 'local', prompt: 'p', modelId: 'qwen3' }); return { ok: r.ok, type: 'error', voice: '' }; } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => (String(url).startsWith('http://box:11434') ? (events.push('box'), json(401, { error: 'bad key' })) : realFetch(url, init));
t = await turn();
globalThis.fetch = realFetch;
check('R own box answers 401 → no cloud, no key-health row', t.route === 'local:account' && t.events.includes('box')
    && !t.events.includes('cloud') && !t.events.some((e) => e.startsWith('report_key')), show(t));

console.log(`\n${pass} passed, ${fail} failed`);
console.log('⚠️ A green does NOT prove: live provider shapes, the cloud billing the fallback turn, or any device rendering it.');
if (fail) process.exit(1);
console.log('check-brain-key-fallback: ALL PASS');
