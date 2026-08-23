// SPDX-License-Identifier: AGPL-3.0-only
// check-orphan-prune.mjs — controls for server/prune-orphan-options.js.
//
// This module WRITES the household's stored add-on configuration through the
// Supervisor, so the interesting assertions are not "does it prune" but "when
// does it refuse to". The whole design is a set of branches that fail toward
// doing nothing, and a refusal branch that silently stopped working would not
// show up as an error — it would show up as a box whose configuration was
// emptied on restart.
//
// Real module under test; `fetch` is the only thing stubbed, because it is the
// entire boundary.
//
//   node scripts/check-orphan-prune.mjs
import { createRequire } from 'node:module';
import path from 'node:path';

const SERVER = path.resolve(
    process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dashie-ha', 'server'),
);
const require_ = createRequire(path.join(SERVER, 'x.js'));
const { pruneOrphanOptions } = require_('./prune-orphan-options.js');

let pass = 0, fail = 0;
const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    console.log(`${ok ? '✅' : '🔴'} ${name}\n     got  ${JSON.stringify(got)}${ok ? '' : `\n     want ${JSON.stringify(want)}`}`);
};

const REAL_FETCH = globalThis.fetch;
let posted;   // the options body the module tried to write, or undefined

/** Drive one scenario: what /addons/self/info returns, and whether the write succeeds. */
async function run({ info, token = 'tok', writeOk = true, infoStatus = 200 }) {
    posted = undefined;
    const prevToken = process.env.SUPERVISOR_TOKEN;
    if (token === null) delete process.env.SUPERVISOR_TOKEN;
    else process.env.SUPERVISOR_TOKEN = token;

    globalThis.fetch = async (url, init) => {
        if (String(url).endsWith('/addons/self/info')) {
            return { ok: infoStatus === 200, status: infoStatus, json: async () => info };
        }
        if (String(url).endsWith('/addons/self/options')) {
            posted = JSON.parse(init.body).options;
            return { ok: writeOk, status: writeOk ? 200 : 500, json: async () => ({ result: 'ok' }) };
        }
        throw new Error(`unexpected url ${url}`);
    };
    const quiet = console.warn, quietLog = console.log;
    console.warn = () => {}; console.log = () => {};
    try { return await pruneOrphanOptions(); }
    finally {
        console.warn = quiet; console.log = quietLog;
        globalThis.fetch = REAL_FETCH;
        if (prevToken === undefined) delete process.env.SUPERVISOR_TOKEN;
        else process.env.SUPERVISOR_TOKEN = prevToken;
    }
}

// John's box after 0.9.20, verbatim: an 11-row schema and 15 stored options.
const SCHEMA_11 = Object.fromEntries(['service_policy_enforce', 'lease_ttl_minutes', 'lease_ttl_seconds',
    'cloud_env', 'install_integration', 'stt_url', 'stt_model', 'stt_api_key',
    'tts_url', 'tts_voice', 'tts_api_key'].map(k => [k, 'str?']));
const STORED_15 = {
    ...Object.fromEntries(Object.keys(SCHEMA_11).map(k => [k, ''])),
    log_level: 'debug', llm_url: '', llm_model: '', llm_api_key: '',
};

console.log('\n── the case this exists for: John\'s box ────────────────────────────');
check('4 orphans pruned, and named',
    (await run({ info: { data: { schema: SCHEMA_11, options: STORED_15 } } })).sort(),
    ['llm_api_key', 'llm_model', 'llm_url', 'log_level']);
check('  …the write KEEPS every schema key and its value',
    Object.keys(posted || {}).sort(), Object.keys(SCHEMA_11).sort());
check('  …and log_level=debug (the value John actually set) is gone',
    Object.prototype.hasOwnProperty.call(posted || {}, 'log_level'), false);

console.log('\n── ⚖️ REFUSAL BRANCHES — each would corrupt a box if it stopped working ──');
// The one that matters most: an empty schema makes EVERY stored option look
// orphaned. Without this guard the module empties the household's config.
check('⚖️ EMPTY schema → refuse, write nothing',
    await run({ info: { data: { schema: {}, options: STORED_15 } } }), []);
check('  …and it did NOT post', posted, undefined);

check('⚖️ schema missing entirely → refuse',
    await run({ info: { data: { options: STORED_15 } } }), []);
check('⚖️ schema is an ARRAY (wrong shape) → refuse',
    await run({ info: { data: { schema: ['a'], options: STORED_15 } } }), []);
check('⚖️ no SUPERVISOR_TOKEN (not under a Supervisor) → refuse',
    await run({ info: { data: { schema: SCHEMA_11, options: STORED_15 } }, token: null }), []);
check('⚖️ info call returns non-200 → refuse',
    await run({ info: null, infoStatus: 502 }), []);

console.log('\n── ⚖️ POSITIVE CONTROLS: it does nothing when there is nothing to do ──');
// Without these, every refusal above is satisfiable by a module that never prunes.
const clean = { ...Object.fromEntries(Object.keys(SCHEMA_11).map(k => [k, ''])) };
check('⚖️ nothing orphaned → no write at all',
    await run({ info: { data: { schema: SCHEMA_11, options: clean } } }), []);
check('  …and it did NOT post', posted, undefined);
check('⚖️ a failed write reports nothing pruned (never claims success)',
    await run({ info: { data: { schema: SCHEMA_11, options: STORED_15 } }, writeOk: false }), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
