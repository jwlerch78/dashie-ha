#!/usr/bin/env node
/**
 * check-keys-write-guard — can a malformed PUT /api/keys DESTROY a stored key?
 *
 * ── WHY THIS IS DRIVEN AND NOT STATIC ────────────────────────────────────────
 *
 * The defect it closes was reported (T, 2026-08-07) as *"PUT /api/keys silently
 * drops unknown fields"* — a 200 with `api-keys.json` written as `{}`. Driving it
 * showed that description was too kind:
 *
 *   1. save a real key            → 200, stored
 *   2. PUT the same provider with ONE wrong inner field name
 *                                 → 200, and the STORED KEY IS GONE
 *
 * `writeProvider` copies only fields it knows, so an unrecognised name yields an
 * empty object, which falls into its `delete store[provider]` branch — the same
 * path an explicit `value: null` takes. A typo destroyed a working credential and
 * reported success. That is data loss, not a dropped write, and no static check of
 * the handler would have shown it: every line in it was individually reasonable.
 *
 * So this starts the REAL router on an ephemeral port over a temp DATA_DIR and
 * asserts on what is on disk afterwards. Same argument as
 * check-api-keys-surface's header: the components were all fine and the outcome
 * was wrong.
 *
 * ── THE PROPERTIES ───────────────────────────────────────────────────────────
 *
 *   • a good save stores the key                          (the positive control —
 *     without it every "key survived" assertion below could pass on a route that
 *     never writes anything at all)
 *   • an UNKNOWN inner field is refused, and the existing key SURVIVES
 *   • an object with no usable field is refused, and the key SURVIVES
 *   • `value: null` still clears — the one intent that SHOULD destroy
 *   • the refusals carry a grep-able DROP: marker (standing rule 2)
 *
 * Exit 0 = every leg passes, 1 = a violation, 2 = cannot check.
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'dashie-ha', 'server');
const require_ = createRequire(import.meta.url);

if (!existsSync(join(SERVER, 'api', 'keys.js'))) {
  console.error(`check-keys-write-guard: cannot find the server at ${SERVER}`);
  process.exit(2);
}

let express;
try {
  express = require_(join(SERVER, '..', 'node_modules', 'express'));
} catch {
  // Skip LOUDLY rather than pass: a missing dev dependency means the question was
  // not asked, which is a different answer from "no violation".
  console.log('check-keys-write-guard: ⏭️  SKIPPED — express not installed (npm i in dashie-ha/)');
  console.log('                        the write guard was NOT verified.');
  process.exit(0);
}

const dataDir = mkdtempSync(join(tmpdir(), 'keys-guard-'));
process.env.DASHIE_DATA_DIR = dataDir;

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  if (!ok) failures++;
};

const cfg = require_(join(SERVER, 'config.js'));
const keysRouter = require_(join(SERVER, 'api', 'keys.js'));

// Capture console.warn so the DROP: marker is an assertion, not a hope.
const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(' ')); realWarn(...a); };

const app = express();
app.use('/api/keys', keysRouter);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api/keys`;

const put = async (body) => {
  const r = await fetch(base, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const stored = () => {
  try {
    return JSON.parse(readFileSync(join(cfg.DATA_DIR, 'api-keys.json'), 'utf8')).gemini || null;
  } catch { return null; }
};

try {
  console.log('\ncheck-keys-write-guard — driving the real router:\n');

  const good = await put({ provider: 'gemini', value: { key: 'sk-guard-positive-control' } });
  check(good.status === 200, 'a well-formed save is accepted (200)');
  check(stored()?.key === 'sk-guard-positive-control',
    '…and the key is on disk  ← positive control: without this, every "survived" leg below is vacuous');

  const unknownField = await put({ provider: 'gemini', value: { value: 'sk-typo' } });
  check(unknownField.status === 400, 'an UNKNOWN inner field is refused (400), not accepted');
  check(unknownField.body?.error === 'unknown_fields', '…with an error naming the class');
  check(stored()?.key === 'sk-guard-positive-control',
    '🔴 …and THE EXISTING KEY SURVIVES (this is the data-loss bug)');

  const emptyObj = await put({ provider: 'gemini', value: {} });
  check(emptyObj.status === 400, 'an object with no usable field is refused (400)');
  check(stored()?.key === 'sk-guard-positive-control', '…and the existing key SURVIVES');

  check(warnings.some((w) => w.includes('DROP:') && w.includes('gemini')),
    'the refusals log a grep-able DROP: marker naming the provider (standing rule 2)');

  const cleared = await put({ provider: 'gemini', value: null });
  check(cleared.status === 200, 'an explicit { value: null } is still accepted');
  check(stored() === null, '…and DOES clear — the one intent that should destroy');
} finally {
  console.warn = realWarn;
  // AWAIT the close, don't just request it (B, 09-02). `server.close()` is asynchronous, and the
  // process.exit() below used to fire while the listening handle was still tearing down. On
  // Windows that trips a libuv assertion —
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
  // — which ABORTS the process with exit 127 AFTER every check has already passed and "✅ the
  // write guard holds" has been printed. It only reproduced when stdout was redirected (a pipe
  // changes the stdio handle types), so it is invisible when you run the gate by hand and fatal
  // when release.sh runs it into a log: the cut aborts on a gate that passed.
  await new Promise((r) => server.close(r));
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(failures ? `\n❌ ${failures} violation(s)` : '\n✅ the write guard holds');
// process.exitCode, NOT process.exit() (B, 09-02). process.exit() tears the process down
// immediately, while the listening handle closed just above is still finishing. On Windows
// that trips a libuv assertion (UV_HANDLE_CLOSING, src/win/async.c:94) and ABORTS with 127
// AFTER every check has passed and the success line has printed. Setting exitCode lets the
// loop drain and the process exit on its own with the right status.
process.exitCode = failures ? 1 : 0;
