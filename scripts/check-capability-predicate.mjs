// SPDX-License-Identifier: AGPL-3.0-only
// check-capability-predicate.mjs — controls for server/capability.js, the
// metered-spend predicate.
//
// This is MONEY LOGIC, so every case is asserted in both directions: the point
// is never that it grants, it is that it WITHHOLDS where the previous gate did
// not. The first case below is the defect this replaced, run as a red baseline.
//
// It stubs the five modules capability.js reads (auth · key-store ·
// settings-store · options · account-config) through the require cache, so the
// file under test is the real one and nothing touches /data. No dependencies,
// no runner — `node scripts/check-capability-predicate.mjs`.
//
// Point it at a generated channel to check the SUBSTITUTED copy too:
//   node scripts/check-capability-predicate.mjs ../chickadee/chickadee/server
//
// ⚠️ Worth reading before trusting: three of these expectations were WRONG when
// first written — they demanded a total refusal where the correct answer is a
// PARTIAL grant (withhold the metered capability, keep the free ones). Being
// wrong is what surfaced the real gap: a partial grant explained nothing, so
// "the household withdrew it" and "nothing is configured" looked identical.
// Hence the `withheld` map, and hence these controls asserting it.
import { createRequire } from 'node:module';
import path from 'node:path';

const SERVER = path.resolve(
    process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dashie-ha', 'server'),
);
const require_ = createRequire(path.join(SERVER, 'x.js'));

// Fakes, injected through the require cache so capability.js itself is the real
// file under test and nothing it depends on touches /data.
const state = {};
const stub = (rel, exports) => {
  const p = require_.resolve(rel);
  require_.cache[p] = { id: p, filename: p, loaded: true, exports };
};

stub('./auth', { readStoredJwt: () => (state.signedIn ? { userEmail: 'x@y' } : null) });
stub('./key-store', { status: () => state.keys || {} });
stub('./settings-store', { readUserSettings: () => state.userSettings ?? {} });
stub('./options', { readOptions: () => state.options || {} });
stub('./account-config', {
  getAccountVoiceConfig: async () => {
    if (state.accountThrows) throw new Error('unreachable');
    return { householdSharing: state.accountSharing === true };
  },
});

const cap = require_('./capability.js');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '✅' : '🔴'} ${name}\n     got  ${JSON.stringify(got)}${ok ? '' : `\n     want ${JSON.stringify(want)}`}`);
};

const scenario = (s) => Object.assign(state, { signedIn: false, keys: {}, options: {}, userSettings: {}, accountSharing: false, accountThrows: false }, s);
const grant = async (asked = null) => {
  const r = await cap.grantableCapabilities(asked);
  return { granted: r.granted, reason: r.reason };
};
const withheld = async (asked = null) => (await cap.grantableCapabilities(asked)).withheld;

console.log('\n── THE RED BASELINE: the defect this replaces ─────────────────────');
// Chickadee-shaped box: no account, a household BYOK key, sharing turned OFF.
// The old gate skipped entirely (CLOUD.url blank) and granted everything.
scenario({ userSettings: { voice: { householdSharing: false } }, keys: { openrouter: true } });
// ⚠️ The expectation this control was FIRST written with — "granted: []" — was
// wrong, and being wrong is what surfaced the real gap. A partial grant is the
// correct answer: the metered capability is withheld while the free ones (HA's
// own Whisper/Piper, keyless sports and images) are not, because they cost the
// household nothing. Downgrade, not outage.
check('account-less + BYOK key + sharing OFF → ai WITHHELD, free caps kept',
  await grant(), { granted: ['voice', 'tools'], reason: 'ok' });
// …and the partial grant must SAY why, or it is indistinguishable from a box
// that simply has no key — the two opposite operator actions.
check('  …and it names the OPERATOR ACTION per capability',
  await withheld(), { ai: 'sharing_disabled' });
check('  …a keyless box withholds ai for the OTHER reason',
  (scenario({ userSettings: { voice: { householdSharing: false } } }), await withheld()),
  { ai: 'capability_unavailable' });

console.log('\n── the same box with sharing ON ───────────────────────────────────');
scenario({ userSettings: { voice: { householdSharing: true } }, keys: { openrouter: true } });
check('account-less + BYOK key + sharing ON → all three', await grant(), { granted: ['voice', 'ai', 'tools'], reason: 'ok' });

console.log('\n── the default when nobody has answered (account-less) ────────────');
scenario({ keys: { openrouter: true } });   // no householdSharing key at all
check('account-less default is ON → grants', await grant(), { granted: ['voice', 'ai', 'tools'], reason: 'ok' });

console.log('\n── free routes are NEVER gated ────────────────────────────────────');
// 🔴 These three fixtures configured the local brain through the add-on
// Configuration tab (`options.llm_url`/`llm_model`/`llm_api_key`). Those fields
// were REMOVED on 2026-08-21 — the web UI is the only config surface — so an
// account-less box's own AI box now comes from the local settings blob that
// `converse.js` routes on (`ai.model='local'` + `voice.localLlm*`). The
// PROPERTY being pinned is unchanged and is the whole point of the block: a
// free route is never gated, and only the KEY decides free vs metered. Only the
// input moved, so the fixtures are re-pointed rather than deleted — deleting
// them would have retired the invariant along with the stale input.
const localBox = (extra) => ({ userSettings: { ai: { model: 'local' }, voice: { householdSharing: false, ...extra } } });

scenario(localBox({ localLlmUrl: 'http://box:11434', localLlmModel: 'qwen3' }));
check('local endpoint, EMPTY key, sharing OFF → still granted', await grant(), { granted: ['voice', 'ai', 'tools'], reason: 'ok' });
check('  …and its state is free', cap.capabilityState('ai'), 'free');

scenario(localBox({ localLlmUrl: 'http://paid.example', localLlmModel: 'gpt', localLlmKey: 'sk-real' }));
check('SAME route with a NON-EMPTY key, sharing OFF → ai withheld',
  await grant(), { granted: ['voice', 'tools'], reason: 'ok' });
check('  …and its state is metered', cap.capabilityState('ai'), 'metered');
// …and it must be withheld for the SHARING reason, not because nothing is
// configured. Without this the re-pointing above is satisfiable by a fixture
// that configures no brain at all — the two look identical at the grant level,
// which is the exact confusion the `withheld` map exists to end.
check('  …withheld because SHARING is off, not because it is absent',
  await withheld(), { ai: 'sharing_disabled' });

// ⚖️ NEGATIVE CONTROL for the removal itself: the retired tab fields must no
// longer conjure a brain. Without it, re-introducing that tier — the thing the
// removal exists to prevent — would pass every other case in this file.
scenario({ userSettings: { voice: { householdSharing: false } }, options: { llm_url: 'http://box:11434', llm_model: 'qwen3', llm_api_key: '' } });
check('⚖️ the RETIRED Configuration-tab fields grant no brain', cap.capabilityState('ai'), 'absent');

console.log('\n── absent ≠ free: an empty box must not claim it can think ────────');
scenario({ userSettings: { voice: { householdSharing: true } } });
check('no brain at all → ai withheld, HA-engine caps granted', await grant(), { granted: ['voice', 'tools'], reason: 'ok' });
check('  …ai state is absent', cap.capabilityState('ai'), 'absent');
scenario({});
check('nothing configured, nothing asked but ai → capability_unavailable', await grant(['ai']), { granted: [], reason: 'capability_unavailable' });

console.log('\n── Dashie (account) behaviour is unchanged ────────────────────────');
scenario({ signedIn: true, accountSharing: false });
check('signed in + sharing OFF → refused (as today)', await grant(), { granted: [], reason: 'sharing_disabled' });
scenario({ signedIn: true, accountSharing: true });
check('signed in + sharing ON  → all three (as today)', await grant(), { granted: ['voice', 'ai', 'tools'], reason: 'ok' });
scenario({ signedIn: true, accountThrows: true });
check('signed in + config unreadable → fails CLOSED', await cap.readHouseholdSharing(), false);

console.log('\n── the ONE intended change, asserted rather than discovered ───────');
scenario({ keys: { openrouter: true } });   // signed OUT Dashie box holding a key
check('signed-OUT box with a BYOK key now grants ai (was: not_signed_in)',
  (await grant(['ai'])), { granted: ['ai'], reason: 'ok' });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
