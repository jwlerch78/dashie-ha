// SPDX-License-Identifier: AGPL-3.0-only
// check-provider-fault.mjs — the dev-only Google fault switch (server/provider-fetch.js, option
// debug_provider_fault). It exists so a test box can prove ruling A on hardware (John 10-12: an outage
// spends no credits), so this gate proves the SWITCH, not the ruling (check-key-first-tts and
// check-key-first-consistency prove the ruling).
//
//   ⚖️ OFF is plain fetch: the real call happens and nothing says FAULT-INJECTED (the control that
//      proves the instrument touches the subject only when armed).
//   A  an armed switch announces itself once (FAULT-INJECTION ARMED), and an unknown value is off + DROP.
//   F  each fault (503 / unparsed / timeout) on a Google URL, loudly, and never with the ?key= logged.
//   G  only Google is faked: a Dashie Cloud or ElevenLabs call passes through while armed.
//   L  a real lane (gemini-stt.transcribe) driven while armed fails as an OUTAGE (upstream_error), not a key fault.
//   S  SOURCE: no Google-facing lane file calls Google with bare fetch (one hook, not one per lane), and
//      prod's config.yaml does not declare the option while dev's does.
//
// ⚠️ What a green does NOT prove: that Home Assistant REFUSES the option on prod. S reads the schema
//    source; the refusal has to be OBSERVED on a test box (O's condition 1). Nor that a tablet or speaker
//    spends nothing: that is the 0.9.58 hardware leg.
// Run: node scripts/check-provider-fault.mjs   Exit 0 = ALL PASS, 1 = a failure, 2 = cannot check.
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'dashie-ha', 'server');
const require_ = createRequire(path.join(SERVER, 'x.js'));
const stub = (rel, exports) => { const p = require_.resolve(rel); require_.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const state = { opt: 'off' };
stub('./options', { readOptions: () => ({ debug_provider_fault: state.opt }) });
stub('./key-store', { readKeys: () => ({ gemini: { key: 'AIza-control-key' } }), status: () => ({ gemini: true }) });

let real = [];   // URLs that reached the (stubbed) network
globalThis.fetch = async (url) => { real.push(String(url)); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'real' }] } }] }), { status: 200 }); };

let lines = [];
const quiet = async (fn) => {
    const w = console.warn, l = console.log; lines = [];
    console.warn = (...a) => lines.push(a.join(' ')); console.log = (...a) => lines.push(a.join(' '));
    try { return await fn(); } finally { console.warn = w; console.log = l; }
};

let pf, stt;
try {
    await quiet(async () => { pf = require_('./provider-fetch.js'); stt = require_('./gemini-stt.js'); });
} catch (e) { console.error(`check-provider-fault: cannot check — ${e.message}`); process.exit(2); }

let pass = 0, fail = 0;
const check = (name, cond, detail) => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '🔴'} ${name}${cond ? '' : `\n     ${detail}`}`); };
const arm = (v) => { state.opt = v; pf.__resetForTest(); real = []; };
const G = 'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent';

console.log('\n── ⚖️ OFF is plain fetch ──');
arm('off');
let r = await quiet(() => pf.providerFetch(G, {}));
check('⚖️ off: the real Google call happens, status 200, and nothing says FAULT', r.status === 200 && real.includes(G) && !lines.some((l) => /FAULT/.test(l)), JSON.stringify({ real, lines }));

console.log('\n── A: armed announces itself; unknown is off ──');
arm('503');
await quiet(() => pf.providerFetch(G, {}));
check('A1 armed: FAULT-INJECTION ARMED logged once, naming the option and the mode',
    lines.filter((l) => l.startsWith('FAULT-INJECTION ARMED: debug_provider_fault=503')).length === 1, lines.join(' | '));
await quiet(() => pf.providerFetch(G, {}));
check('A2 the ARMED line is not repeated per call', !lines.some((l) => l.startsWith('FAULT-INJECTION ARMED')), lines.join(' | '));
arm('500');
r = await quiet(() => pf.providerFetch(G, {}));
check('A3 an unknown value is OFF with a DROP (never a half-armed state)', r.status === 200 && real.includes(G) && lines.some((l) => l.startsWith('DROP: debug_provider_fault=500')), lines.join(' | '));

console.log('\n── F: each fault, loudly ──');
arm('503');
r = await quiet(() => pf.providerFetch(`${G}?key=AIza-secret`, {}));
check('F1 503: a 503 answer, nothing reached the network, FAULT-INJECTED logged',
    r.status === 503 && real.length === 0 && lines.some((l) => l.startsWith('FAULT-INJECTED: 503 for https://generativelanguage')), lines.join(' | '));
check('F2 the ?key= is never logged', !lines.some((l) => l.includes('AIza-secret')), lines.join(' | '));
arm('unparsed');
r = await quiet(() => pf.providerFetch(G, {}));
check('F3 unparsed: a 200 with an empty object', r.status === 200 && (await r.text()) === '{}' && real.length === 0, `status=${r.status}`);
arm('timeout');
const ctl = new AbortController();
const p = quiet(() => pf.providerFetch(G, { signal: ctl.signal }).then(() => 'answered', (e) => e.name));
setTimeout(() => ctl.abort(), 30);
check('F4 timeout: no answer until the CALLER aborts, then AbortError', (await p) === 'AbortError' && real.length === 0, 'did not reject as AbortError');

console.log('\n── G: only Google is faked ──');
arm('503');
for (const u of ['https://cwglbtosingboqepsmjk.supabase.co/functions/v1/gemini-stt', 'https://api.elevenlabs.io/v1/text-to-speech/x']) {
    r = await quiet(() => pf.providerFetch(u, {}));
    check(`G armed, ${new URL(u).host} passes through untouched`, r.status === 200 && real.includes(u) && !lines.some((l) => l.startsWith('FAULT-INJECTED')), lines.join(' | '));
}

console.log('\n── L: a real lane, armed, fails as an OUTAGE ──');
arm('503');
r = await quiet(() => stt.transcribe(Buffer.alloc(3200)));
check('L1 gemini-stt armed 503 → not ok, keyFailure upstream_error (an outage: ruling A spends nothing on it)',
    r.ok === false && r.keyFailure?.status === 'upstream_error' && real.length === 0 && lines.some((l) => l.startsWith('FAULT-INJECTED: 503')), JSON.stringify(r));
arm('off');
r = await quiet(() => stt.transcribe(Buffer.alloc(3200)));
check('⚖️ L2 the same lane disarmed reaches Google and transcribes', r.ok === true && r.text === 'real' && real.length === 1, JSON.stringify(r));

console.log('\n── S: source ──');
const LANES = ['gemini-stt.js', 'gemini-tts.js', 'gemini-tts-lane.js', 'live-token.js', 'byok-tts.js', 'brain/addon-io.js'];
for (const f of LANES) {
    const bare = readFileSync(path.join(SERVER, f), 'utf8').split('\n')
        .filter((l) => /(^|[^A-Za-z_.])fetch\(/.test(l) && !/^\s*(\/\/|\*)/.test(l) && !/CLOUD\.url/.test(l));
    check(`S ${f}: every non-Dashie-Cloud call goes through providerFetch`, bare.length === 0, bare.join(' | '));
}
check('S generated/gemini-tts-stream.js makes no call of its own (the hook wraps fetch, the generated file is untouched)',
    !/\bfetch\(/.test(readFileSync(path.join(SERVER, 'generated', 'gemini-tts-stream.js'), 'utf8')), 'it calls fetch');
const prod = readFileSync(path.join(ROOT, 'dashie-ha', 'config.yaml'), 'utf8');
const dev = readFileSync(path.join(ROOT, 'dashie-ha-dev', 'config.yaml'), 'utf8');
check('S prod config.yaml does NOT declare debug_provider_fault; dev declares option + schema',
    !prod.includes('debug_provider_fault') && /debug_provider_fault: "off"/.test(dev) && /debug_provider_fault: list\(off\|503\|timeout\|unparsed\)\?/.test(dev), 'see the two config.yaml files');

console.log(`\n${pass} passed, ${fail} failed`);
console.log('⚠️ A green does NOT prove Home Assistant refuses the option on prod (observe that on a test box), or that any device spends nothing.');
if (fail) process.exit(1);
console.log('check-provider-fault: ALL PASS');
