// SPDX-License-Identifier: AGPL-3.0-only
// check-brain-route-tiers.mjs — controls for the TIER SELECTION in server/converse.js:
// **which endpoint actually receives the inference call.**
//
// WHY THIS EXISTS (2026-08-22 live defect, T cont.27 / A cont.6). `resolveBrainRoute`
// returns `route:'local'` for MORE THAN ONE target — the account's own box
// (`reason:'local_model'`) and the household's BYOK provider key (`'byok'`); there was a
// third, `'hermes'`, until it was stripped on 2026-08-23. `route` answers WHERE
// ORCHESTRATION RUNS; it does NOT answer which endpoint gets the call. `converse.js` gated
// Tier 1 on `route === 'local'`, read the where-flag as a which-endpoint flag, and so
// claimed them all. A BYOK Gemini household with one leftover engine row had every turn
// sent to its own TERMINATED GPU box and died in ~10 s — while `resolveByokTarget`, two
// screens further down, would have answered it.
//
// That category error is invisible to every other gate here, because every component
// involved was individually correct. So this file asserts the OUTCOME: for a given
// account row, which endpoint does the turn actually go to.
//
// It drives the REAL converse.js, the REAL account-config.js (its Supabase read stubbed at
// `fetch`, so the resolution and the routing are the true ones) and the REAL providers.js.
// Only the edges are faked: auth, key-store, options, settings-store, the brain bundle,
// and `createAddonIO` — the last of which is the probe, since the shell handed to it IS
// the answer to "which endpoint".
//
// 🔴 key-store is STUBBED deliberately: DATA_DIR resolves to `dashie-ha/data/` outside the
// container, which holds a developer's REAL api-keys.json. Reading it would make the
// result depend on whose machine this runs on.
//
//   node scripts/check-brain-route-tiers.mjs
import { createRequire } from 'node:module';
import path from 'node:path';

const SERVER = path.resolve(
    process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dashie-ha', 'server'),
);
const require_ = createRequire(path.join(SERVER, 'x.js'));

const state = {};
let captured = null;      // the shell handed to createAddonIO — the probe
let warnings = [];
let cloudCalled = false;  // did the turn reach the metered Dashie Cloud brain?

const stub = (rel, exports) => {
  const p = require_.resolve(rel);
  require_.cache[p] = { id: p, filename: p, loaded: true, exports };
};

stub('./auth', {
  getValidJwt: async () => {
    if (!state.signedIn) throw new Error('not_signed_in');
    return { jwt: 'jwt-test', userId: 'user-test' };
  },
});
stub('./key-store', {
  status: () => state.keys || {},
  readKeys: () => Object.fromEntries(Object.keys(state.keys || {}).map((p) => [p, { key: `sk-${p}` }])),
});
stub('./options', { readOptions: () => state.options || {} });
stub('./settings-store', { readUserSettings: () => state.localBlob ?? {} });
stub('./brain/addon-io', {
  createAddonIO: (opts) => { captured = opts; return {}; },
});
stub('./brain/voice-brain.bundle.js', {
  runOrchestration: async () => ({ type: 'test', ok: true }),
  BRAIN_SOURCE_SHA: 'testtest',
});

// The account row, served to the REAL account-config through the REAL fetch call site.
// Also records a hit on the Dashie Cloud brain, so "this turn went to the metered cloud"
// is OBSERVED rather than inferred from the absence of a route tag.
const REAL_FETCH = globalThis.fetch;
globalThis.fetch = async (url) => ({
  ...(String(url).includes('/functions/v1/voice-conversation') ? (cloudCalled = true, {}) : {}),
  ok: true,
  json: async () => [{ settings: state.settings || {}, retain_transcripts: false }],
});

const accountConfig = require_('./account-config.js');
const { converse } = require_('./converse.js');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '✅' : '🔴'} ${name}\n     got  ${JSON.stringify(got)}${ok ? '' : `\n     want ${JSON.stringify(want)}`}`);
};

const scenario = (s) => {
  Object.assign(state, { signedIn: true, keys: {}, options: {}, settings: {}, localBlob: {} }, s);
  captured = null;
  warnings = [];
  cloudCalled = false;
  accountConfig.invalidate();          // 30 s TTL — must not leak between scenarios
};

// Run a turn and report ONLY what this file is about: the route tag and the endpoint the
// inference call was actually addressed to.
const turn = async () => {
  const realWarn = console.warn, realLog = console.log;
  console.warn = (...a) => { warnings.push(a.join(' ')); };
  console.log = () => {};
  try {
    const r = await converse({ text: 'what time is it' });
    return {
      route: r.routeTag || (cloudCalled ? 'cloud' : (r.body && r.body.error) || 'refused'),
      target: captured ? (captured.endpoint || captured.chatUrl || null) : null,
      model: captured ? captured.model : null,
    };
  } finally { console.warn = realWarn; console.log = realLog; }
};

const STALE_ENGINE = { kind: 'llm', id: 'eng-1', url: 'http://192.168.1.99:11434', model: 'qwen3:30b' };

console.log('\n── 🔴 THE RED BASELINE: the live defect (T cont.27) ────────────────');
// John's Fire, 2026-08-22: account on a cloud model with his own key, and ONE leftover
// engine row from when he ran locally. Every turn went to the terminated box.
scenario({
  settings: { ai: { model: 'gemini-2.5-flash' }, voice: { householdSharing: true, localEngines: [STALE_ENGINE] } },
  keys: { gemini: true },
});
check('BYOK cloud model + a stale engine row → goes to the PROVIDER, not the box',
  await turn(),
  { route: 'byok:gemini', target: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-2.5-flash' });

console.log('\n── ⚖️ POSITIVE CONTROLS: the local tier still works, both ways in ──');
// Without these, "never route to the box" is satisfiable by deleting Tier 1 outright.
scenario({
  settings: { ai: { model: 'local' }, voice: { householdSharing: true, localLlmUrl: 'http://box:11434', localLlmModel: 'qwen3' } },
});
check('⚖️ ai.model=local + inline fields → the account\'s own box',
  await turn(), { route: 'local:account', target: 'http://box:11434', model: 'qwen3' });

// The engine SCRAPE is still defensible here — the user means to run locally and simply
// never named an engine. Fix 2 narrowed that scrape; this pins that it did not kill it.
scenario({
  settings: { ai: { model: 'local' }, voice: { householdSharing: true, localEngines: [STALE_ENGINE] } },
});
check('⚖️ ai.model=local + only an engine row → the scrape still resolves it',
  await turn(), { route: 'local:account', target: 'http://192.168.1.99:11434', model: 'qwen3:30b' });

scenario({
  signedIn: false,
  localBlob: { ai: { model: 'local' }, voice: { localLlmUrl: 'http://panel-box:11434', localLlmModel: 'llama3' } },
});
check('⚖️ signed-OUT box with the panel blob → local:box, unchanged',
  await turn(), { route: 'local:box', target: 'http://panel-box:11434', model: 'llama3' });

console.log('\n── 🗑️ hermes: was the third victim, now just an unknown model ──────');
// `hermes` was a third `route:'local'` reason with no tier, so Tier 1 claimed it and sent
// those turns to whatever engine the account had lying around. It was STRIPPED from the
// vocabulary on 2026-08-23 (John: Hermes is not a brain), so a leftover `ai.model='hermes'`
// is now an ordinary unrecognised model → the cloud brain. The assertion that still earns
// its place is that it CANNOT reach the stale engine.
scenario({
  settings: { ai: { model: 'hermes' }, voice: { householdSharing: true, localEngines: [STALE_ENGINE] } },
});
const hermes = await turn();
check('a leftover ai.model=hermes → NOT sent to a local engine', hermes.target, null);
check('  …it is simply an unknown model now, routed to cloud', hermes.route, 'cloud');

console.log('\n── ⚖️ the no-shell DROP still fires where it is REACHABLE ──────────');
// The rule-2 guard that caught hermes must not have been retired with it. Its live case:
// an account that says `local` but stores no usable endpoint — tier 1's url/model guard
// fails, nothing else claims the turn, and it would otherwise land on the metered cloud
// brain looking exactly like a normal turn on the bill.
scenario({ settings: { ai: { model: 'local' }, voice: { householdSharing: true } } });
const noEndpoint = await turn();
check('ai.model=local with NO endpoint → loud DROP before the cloud fall-through',
  warnings.some((w) => w.startsWith('DROP:') && w.includes('reason=local_model')), true);
check('  …and it does go to cloud (the DROP explains a real spend)', noEndpoint.route, 'cloud');

console.log('\n── ⚖️ the resolver itself: no invented endpoint for a cloud account ─');
// Fix 2, asserted at its own layer rather than only through converse: a cloud-model
// account must not have a local endpoint conjured out of a leftover engine row.
scenario({
  settings: { ai: { model: 'gemini-2.5-flash' }, voice: { householdSharing: true, localEngines: [STALE_ENGINE] } },
  keys: { gemini: true },
});
const acctCloud = await accountConfig.getAccountVoiceConfig();
check('cloud model + an engine row → NO localLlmUrl is resolved',
  { url: acctCloud.localLlmUrl, model: acctCloud.localLlmModel }, { url: '', model: '' });
check('  …and the route/reason pair says byok, not local_model',
  { route: acctCloud.route, reason: acctCloud.routeReason }, { route: 'local', reason: 'byok' });

console.log('\n── 🔴 THE SPOKEN LINE must not name a machine the user does not own ─');
// The `unreachable` flag is what makes the core say "your local AI box isn't responding".
// `callGateway` serves BOTH shells, so setting it unconditionally told a BYOK household
// their local box was down when their PROVIDER was. Driven against a genuinely dead port
// — a real failure, not a simulated one — in each posture.
const realIO = createRequire(path.join(SERVER, 'x.js'));
delete realIO.cache[realIO.resolve('./brain/addon-io')];   // we stubbed it above; get the real file
const { createAddonIO } = realIO('./brain/addon-io.js');
const DEAD = 'http://127.0.0.1:9/v1/chat/completions';     // discard port: connects nowhere
const callDead = async (opts) => {
  // 🔴 The account-row fetch is stubbed at the top of this file; leaving it in place here
  // would make the "dead" port answer 200 and both assertions pass for the wrong reason.
  // (It did, on the first run.) Restore the real fetch so this is a genuine failure.
  const stubbedFetch = globalThis.fetch;
  globalThis.fetch = REAL_FETCH;
  try {
    const io = createAddonIO({ chatUrl: DEAD, model: 'm', log: () => {}, ...opts });
    return await io.callGateway({ prompt: 'hi' });
  } finally { globalThis.fetch = stubbedFetch; }
};

const onBox = await callDead({});                              // no providerLabel = the user's own box
check('the account\'s OWN box is unreachable → flag set (the ruled sentence fires)',
  { ok: onBox.ok, unreachable: onBox.unreachable === true }, { ok: false, unreachable: true });

const viaProvider = await callDead({ providerLabel: 'Gemini' });
check('a BYOK PROVIDER is unreachable → flag NOT set (no "your local AI box")',
  { ok: viaProvider.ok, unreachable: viaProvider.unreachable === true }, { ok: false, unreachable: false });

console.log('\n── 🔇 THE SILENT TURN: a BYOK failure must SAY something ───────────');
// The 2026-08-22 fix stopped the wrong sentence and left silence in its place (T
// cont.34/35). These pin the two ruled lines by the FLAGS the core keys on, so the
// wording can be re-read from the core without this file guessing at prose.
const flagsFor = async (status, opts) => {
  const stubbedFetch = globalThis.fetch;
  globalThis.fetch = status === 'dead'
    ? REAL_FETCH
    : async () => ({ ok: false, status, json: async () => ({ error: { message: 'nope' } }) });
  try {
    const io = createAddonIO({ chatUrl: status === 'dead' ? DEAD : 'http://x/v1/chat/completions',
      model: 'gemini-2.5-flash', log: () => {}, ...opts });
    return await io.callGateway({ prompt: 'hi' });
  } finally { globalThis.fetch = stubbedFetch; }
};

const provDown = await flagsFor('dead', { providerLabel: 'Gemini' });
check('BYOK provider unreachable → provider_unreachable + the provider name',
  { pu: provDown.provider_unreachable === true, label: provDown.provider_label, box: provDown.unreachable === true },
  { pu: true, label: 'Gemini', box: false });

const modelGone = await flagsFor(404, { providerLabel: 'Gemini' });
check('provider answers 404 → model_unavailable + the model id (not a network claim)',
  { mu: modelGone.model_unavailable === true, model: modelGone.model_id, pu: modelGone.provider_unreachable === true },
  { mu: true, model: 'gemini-2.5-flash', pu: false });

// ⚖️ Controls. Without these, "always flag something" passes: a 500 is a real
// provider error the user cannot act on differently, and the on-box lane must keep
// the flag that was already ruled for it.
const serverErr = await flagsFor(500, { providerLabel: 'Gemini' });
check('⚖️ a provider 500 is NOT a model problem', 
  { mu: serverErr.model_unavailable === true, pu: serverErr.provider_unreachable === true },
  { mu: false, pu: false });

const boxDown = await flagsFor('dead', {});
check('⚖️ the on-box lane still sets `unreachable`, not the BYOK flags',
  { box: boxDown.unreachable === true, pu: boxDown.provider_unreachable === true },
  { box: true, pu: false });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
