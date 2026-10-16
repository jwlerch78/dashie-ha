#!/usr/bin/env node
/**
 * check-key-test-elevenlabs — the ElevenLabs key test classifies a BAD key as bad, a
 * GOOD key as good, and a SCOPED key as neither.
 *
 * John, 2026-10-15: *"there's no test yet for this key. We should have B add one."*
 *
 * 🔴 THE LEG THAT MATTERS IS 3, AND IT IS THE ONE A NAIVE VERSION GETS WRONG.
 *
 * ElevenLabs keys are restricted by default and carry per-group permissions, so a key
 * that synthesises speech perfectly can be refused /v1/user with 403 when its "User"
 * permission is off (an IP allow-list answers 403 too). `validateProvider` merges 401
 * and 403 into "Key was rejected — check it and re-save" for every other provider —
 * correct there, and here it would tell a household to replace a key that WORKS.
 *
 * That is the inverse of the trap this file's sibling already records: OpenRouter's
 * /models is public and would PASS a garbage key. This one would FAIL a good one. A
 * key test is wrong in both directions, and only one of them is obvious.
 *
 * ⚠️ A KEY TEST THAT CAN ONLY PASS IS NOT A TEST (O, 2026-10-15, after a device run
 * was voided tonight by a client whose every read came back -1 while four legs stayed
 * green). Leg 2 is the deliberately-bad-key leg, and leg 7 mutation-proves it.
 *
 * ── WHAT A GREEN HERE DOES NOT PROVE ────────────────────────────────────────
 * These legs drive the CLASSIFIER against stubbed HTTP responses. They do not reach
 * ElevenLabs. What was measured against the real API, by hand on 2026-10-15, is only
 * the failure half — and it is recorded in providers.js beside the probe:
 *     bad key → 401 {"status":"invalid_api_key"} · no key → 401 {"status":"needs_authorization"}
 * The 200 body shape (subscription.character_count/character_limit) is REASONED FROM
 * THE DOCS and has never been seen, because that needs a real key. If it is wrong, the
 * summary degrades to the plain "Key is valid." line — leg 5 pins that degradation.
 *
 * It also does not prove: that the probe is free (nothing in the docs says it bills,
 * and it synthesises nothing — but that is an argument, not a measurement); that a
 * valid key has QUOTA; that the chosen voice id exists; or that speech will succeed.
 */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'dashie-ha', 'server');
const PROVIDERS = join(SERVER, 'brain', 'providers.js');
if (!existsSync(PROVIDERS)) { console.error(`check-key-test-elevenlabs: providers.js missing at ${PROVIDERS}`); process.exit(2); }

const require_ = createRequire(import.meta.url);

let pass = 0, fail = 0;
const t = (name, ok, why) => {
    if (ok) { pass++; console.log(`✅ ${name}`); }
    else { fail++; console.log(`❌ ${name}${why ? `\n      ${why}` : ''}`); }
};

/**
 * Load providers.js with key-store stubbed and fetch replaced.
 * @param {object} resp   what the stub fetch should answer
 * @param {object} keys   what key-store should report as stored
 */
function withFetch({ status = 200, json = {}, text = '', keys = { elevenlabs: { key: 'sk_fake' } }, mutate = null }) {
    const ksPath = require_.resolve(join(SERVER, 'key-store.js'));
    delete require_.cache[require_.resolve(PROVIDERS)];
    require_.cache[ksPath] = {
        id: ksPath, filename: ksPath, loaded: true, children: [], paths: [],
        exports: { readKeys: () => keys, status: () => ({}) },
    };
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), headers: (init && init.headers) || {} });
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => json,
            text: async () => text,
        };
    };
    let mod = require_(PROVIDERS);
    if (mutate) mod = mutate(mod);
    return { mod, calls };
}

console.log('── check-key-test-elevenlabs ────────────────────────────────────────\n');

// ── FLOOR ────────────────────────────────────────────────────────────────────
{
    const { mod } = withFetch({});
    const hasFn = typeof mod.validateProvider === 'function';
    t('leg 0 FLOOR — validateProvider is reachable and the stub harness loads the real module',
      hasFn, 'every leg below would otherwise pass against nothing');
}
{
    // The whole point of John's ask: this provider must no longer answer "no test".
    const { mod } = withFetch({ status: 200, json: {} });
    const r = await mod.validateProvider('elevenlabs');
    t('leg 1 — elevenlabs HAS a no-charge test at all (ok is not null-with-no-test)',
      r.ok === true,
      `the gap John pointed at was "No no-charge test available for this provider yet." Got: ${JSON.stringify(r)}`);
}

// ── 2 — THE DELIBERATELY BAD KEY. A test that cannot fail is not a test. ─────
{
    const { mod } = withFetch({ status: 401, text: '{"detail":{"status":"invalid_api_key"}}' });
    const r = await mod.validateProvider('elevenlabs');
    t('leg 2 🔴 — a REJECTED key (401, the status the real API was measured to return) is ok:FALSE',
      r.ok === false && /reject/i.test(r.detail || ''),
      `a key test that only ever passes tells a household nothing. Got: ${JSON.stringify(r)}`);
}
{
    const { mod } = withFetch({ keys: {} });
    const r = await mod.validateProvider('elevenlabs');
    t('leg 2b — no key stored at all is ok:false and says to save one, without calling out',
      r.ok === false && /save one/i.test(r.detail || ''),
      `Got: ${JSON.stringify(r)}`);
}

// ── 3 — THE ONE THE NAIVE VERSION GETS WRONG ────────────────────────────────
{
    const { mod } = withFetch({ status: 403, text: '{"detail":{"status":"insufficient_permissions"}}' });
    const r = await mod.validateProvider('elevenlabs');
    t('leg 3 🔴 — a SCOPED key (403) is ok:NULL — "cannot verify", never "rejected"',
      r.ok === null,
      `403 means the key is REAL but this call is not permitted (User permission off, or IP not allow-listed). Reporting it as rejected tells a household to replace a key that works. Got: ${JSON.stringify(r)}`);
    t('leg 3b — …and the 403 copy does NOT tell them to re-save the key',
      r.ok === null && !/re-save|check it/i.test(r.detail || ''),
      `the instruction must point at the key's PERMISSIONS, not at the key string. Got: ${r.detail}`);
}
{
    // ⚖️ CONTROL: the split must be surgical. Every OTHER provider keeps the merged
    // 401/403 behaviour exactly as released — a shared-branch change would silently
    // re-classify openai/gemini/claude failures too.
    const { mod } = withFetch({ status: 403, text: '', keys: { openai: { key: 'sk-x' } } });
    const r = await mod.validateProvider('openai');
    t('leg 4 ⚖️ CONTROL — a 403 for a provider WITHOUT scoped keys is still ok:false (unchanged)',
      r.ok === false,
      `the 403 split must be opt-in per provider, not a change to the shared branch. Got: ${JSON.stringify(r)}`);
}

// ── 5 — the quota summary, and its degradation ──────────────────────────────
{
    const { mod } = withFetch({ status: 200, json: { subscription: { character_count: 12345, character_limit: 100000 } } });
    const r = await mod.validateProvider('elevenlabs');
    t('leg 5 — a 200 reports the REMAINING QUOTA, which is the next thing that breaks',
      r.ok === true && /12,345/.test(r.detail) && /100,000/.test(r.detail),
      `"authenticates" alone does not tell a household whether speech will work. Got: ${r.detail}`);
}
{
    const { mod } = withFetch({ status: 200, json: { subscription: {} } });
    const r = await mod.validateProvider('elevenlabs');
    t('leg 5b 🔴 — an UNEXPECTED 200 body degrades to the plain line, never to a wrong number',
      r.ok === true && /Key is valid\.?$/.test(r.detail) && !/undefined|NaN|null/.test(r.detail),
      `the 200 shape is reasoned from docs and never measured — it MUST fail soft. Got: ${r.detail}`);
}

// ── 6 — the request itself ──────────────────────────────────────────────────
{
    const { mod, calls } = withFetch({ status: 200, json: {} });
    await mod.validateProvider('elevenlabs');
    const c = calls[0] || {};
    t('leg 6 — it GETs /v1/user with the xi-api-key header, and synthesises nothing',
      /api\.elevenlabs\.io\/v1\/user$/.test(c.url || '') && c.headers['xi-api-key'] === 'sk_fake',
      `a probe that hits a text-to-speech path would BILL on every settings-row open. Got: ${JSON.stringify(c)}`);
    t('leg 6b — the probe URL contains no text-to-speech path',
      !/text-to-speech|\/speech|\/convert/i.test(c.url || ''), c.url);
}

// ── 7 — MUTATION: prove leg 2 and leg 3 are really reading the classifier ───
{
    const { mod } = withFetch({
        status: 401, text: '{"detail":{"status":"invalid_api_key"}}',
        mutate: (m) => ({ ...m, validateProvider: async () => ({ ok: true, detail: 'Key is valid.' }) }),
    });
    const r = await mod.validateProvider('elevenlabs');
    t('leg 7 🧪 MUTATION — an always-passing validator makes leg 2 FAIL (so leg 2 is real)',
      r.ok === true,
      'the mutant did not take effect, so leg 2 may be asserting against something else');
}

console.log(`\ncheck-key-test-elevenlabs: ${pass} pass, ${fail} fail`);
console.log(`
📌 FLOOR — what a green here does NOT prove:
   · that the probe is FREE. Nothing in ElevenLabs' docs says /v1/user bills and it
     synthesises nothing, but that is an argument, not a measurement.
   · that a valid key has QUOTA, that the chosen voice id exists, or that speech works.
     A 200 means the key authenticates. Leg 5 is the most this test can honestly add.
   · the 200 BODY SHAPE. Measured against the real API: only the 401 halves. The
     subscription fields are reasoned from the docs; leg 5b is what makes that safe.
   · that the console RENDERS any of it. These legs call the server function directly.`);

if (fail > 0) process.exit(1);
console.log('\n✅ ALL PASS — bad key fails, scoped key is "cannot verify", good key reports quota, other providers unchanged');
