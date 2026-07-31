// addon-io.test.ts — the I4 regression, extended to the TWO postures of the add-on shell.
//
// Step 7 (2026-07-31) made brain/addon-io.js conditional: one input, `accountToken`,
// switches every account-backed member between the no-account posture and the
// account-backed one. That `if` is now the thing standing between "a signed-out HA box
// contacts no Dashie service" (PRIVACY.md's local-mode paragraph, the strongest asset of
// the r/HA positioning) and a box that quietly POSTs to Dashie's paid gateways.
//
// orchestrator.test.ts already pins the CORE half of I4 — that `paidTools: false` beats a
// caller's `retrieve_pictures: true`. What it could not see is whether the real shell
// still SETS it. These tests bind the actual addon-io.js, so the invariant is checked
// against shipped code rather than a hand-written literal that can drift from it.
//
// addon-io.js is CommonJS and deliberately free of top-level requires of the cloud config
// — that is what lets this file load it directly, and it is also the machine-checkable
// form of "signed out, the module that names a Dashie endpoint is never even loaded".

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { type OrchestratorIO, runOrchestration } from './src/voice-conversation/orchestrator.ts';

// `node:module` via a NON-literal specifier on purpose. A static `import … from
// 'node:module'` makes Deno resolve npm:@types/node for type-checking, which fails in a
// repo with no node_modules — and the whole point of these tests is that they run with
// nothing installed. A computed specifier is not statically analyzed, so no type
// reference is emitted. (dashie-ha/package.json declares "type": "commonjs" so Deno will
// load the .js shell as CJS at all.)
const NODE_MODULE = 'node:module';
const { createRequire } = await import(NODE_MODULE) as { createRequire: (u: string) => (s: string) => unknown };
// deno-lint-ignore no-explicit-any
const { createAddonIO } = createRequire(import.meta.url)('./addon-io.js') as { createAddonIO: (o: Record<string, unknown>) => any };

const OUT = () => createAddonIO({ endpoint: 'http://localhost:11434', model: 'qwen3', log: () => {} });
const IN = () => createAddonIO({ endpoint: 'http://localhost:11434', model: 'qwen3', accountToken: 'jwt.for.tests', log: () => {} });

// ── The gate itself ─────────────────────────────────────────────────────────────────────

Deno.test('I4 shell: signed OUT → paidTools:false (the Dashie-funded tools are off by rule)', () => {
  assertEquals(OUT().paidTools, false);
});

Deno.test('I4 shell: signed IN → paidTools is ABSENT, so the funded tools are available', () => {
  // Absent, NOT `true`: the contract type is `paidTools?: false` and the core reads
  // `io.paidTools !== false`. Absent is precisely the cloud shell's behaviour — the
  // account setting and the request override decide, exactly as on the metered brain.
  // (Writing `true` would work at runtime and violate the published type; don't.)
  assertEquals(IN().paidTools, undefined);
  assert(IN().paidTools !== false, 'signed in, paid tools must not be gated off');
});

Deno.test('I4 shell: billing stays byok in BOTH postures (the AI is never Dashie-funded here)', () => {
  // This route always runs the AI on the user's own endpoint or their own provider key,
  // so an empty balance must never reject the turn — only the funded TOOLS are gated.
  assertEquals(OUT().billing, 'byok');
  assertEquals(IN().billing, 'byok');
});

// ── Signed out: no Dashie service is reachable through this shell ────────────────────────

Deno.test('signed OUT: web search REFUSES rather than silently returning nothing', async () => {
  await assertRejects(() => OUT().runWebSearch('chickadee'), Error, 'without a Dashie account');
});

Deno.test('signed OUT: sports returns the empty stub — no gateway call', async () => {
  const r = await OUT().runSports({ team: 'reds' });
  assertEquals(r.provider, 'none');
  assertEquals(r.result_count, 0);
});

Deno.test('signed OUT: toolConn is empty — the core has no hosted tool backend to reach', () => {
  assertEquals(OUT().toolConn, { supabaseUrl: '', anonKey: '' });
});

Deno.test('signed OUT: credits fail OPEN (a BYOK turn must still run with no account)', async () => {
  const s = await OUT().checkSpendable();
  assertEquals(s.spendable, true);
  assertEquals(s.balance, Number.POSITIVE_INFINITY);
});

Deno.test('signed OUT: account AI config + transcript retention resolve locally, never over the wire', async () => {
  assertEquals(await OUT().readAccountAiConfig(), {
    model: null, webSearchEnabled: false, retrievePicturesEnabled: false, zipCode: null,
  });
  assertEquals(await OUT().readRetainTranscripts(), false);
});

Deno.test('signed OUT: logging is local only — logInteraction returns nothing to await', () => {
  const lines: string[] = [];
  const io = createAddonIO({ endpoint: 'http://x', model: 'm', log: (s: string) => lines.push(s) });
  assertEquals(io.logInteraction('', { response_type: 'chat', model: 'm' }), undefined);
  assertEquals(io.logWebSearch(), undefined);
  assertEquals(io.logSports(), undefined);
  assert(lines.length === 1 && lines[0].includes('[brain] turn:'), 'the turn is recorded on the box');
});

// ── Signed in: the account-backed members actually change shape ──────────────────────────

Deno.test('signed IN: toolConn carries a real Supabase connection (image search needs it in Node)', () => {
  const conn = IN().toolConn;
  assert(conn.supabaseUrl.startsWith('https://'), 'a real project URL');
  assert(conn.anonKey.length > 0, 'a real anon key');
});

Deno.test('signed IN: sports forwards the ACCOUNT JWT, not the anon key', async () => {
  // The landmine. sports-gateway:83 reads `sub` off this Bearer behind
  // `gateway_auth_enforce`; that flag is OBSERVE-ONLY today, so shipping the anon-key
  // shape works now and dies silently the day it flips. Same for web-search-gateway:97.
  const seen: { auth?: string | null; apikey?: string | null } = {};
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    seen.auth = h.get('authorization');
    seen.apikey = h.get('apikey');
    assert(String(url).includes('/functions/v1/sports-gateway'), 'hits the sports gateway');
    return Promise.resolve(new Response(JSON.stringify({ provider: 'espn', games: [], result_count: 0 }), { status: 200 }));
  }) as typeof fetch;
  try {
    await IN().runSports({ team: 'reds' });
  } finally {
    globalThis.fetch = real;
  }
  assertEquals(seen.auth, 'Bearer jwt.for.tests');
  assert(seen.apikey && seen.apikey !== 'jwt.for.tests', 'anon key still rides as `apikey`, not as the identity');
});

Deno.test('signed IN: web search forwards the ACCOUNT JWT (node-io sent Bearer <anonKey>)', async () => {
  let auth: string | null = null;
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    auth = new Headers(init?.headers).get('authorization');
    assert(String(url).includes('/functions/v1/web-search-gateway'));
    return Promise.resolve(new Response(JSON.stringify({ provider: 'tavily', results: [], result_count: 0 }), { status: 200 }));
  }) as typeof fetch;
  try {
    await IN().runWebSearch('chickadee');
  } finally {
    globalThis.fetch = real;
  }
  assertEquals(auth, 'Bearer jwt.for.tests');
});

Deno.test("signed IN: the TURN's token wins over the box token when the core supplies one", async () => {
  let auth: string | null = null;
  const real = globalThis.fetch;
  globalThis.fetch = ((_u: string | URL | Request, init?: RequestInit) => {
    auth = new Headers(init?.headers).get('authorization');
    return Promise.resolve(new Response(JSON.stringify({ provider: 'tavily', results: [], result_count: 0 }), { status: 200 }));
  }) as typeof fetch;
  try {
    await IN().runWebSearch('chickadee', 'turn.jwt');
  } finally {
    globalThis.fetch = real;
  }
  assertEquals(auth, 'Bearer turn.jwt');
});

// ── End to end through the core: the shell's flags reach the capability decision ─────────

const okJson = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: {} }), { status: 200 });

/** Run one turn against the REAL shell with the model server + any gateway stubbed out,
 *  and hand back the capability snapshot the core logged. */
async function capsFor(accountToken: string): Promise<{ web_search: boolean; retrieve_pictures: boolean }> {
  const io = createAddonIO({ endpoint: 'http://model.test', model: 'qwen3', accountToken, log: () => {} });
  let caps: { web_search: boolean; retrieve_pictures: boolean } | null = null;
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request) => {
    if (String(url).includes('model.test')) return Promise.resolve(okJson('{"type":"response","voice":"hi"}'));
    // Any Dashie call a turn attempts (balance read, image search, logging) resolves inert;
    // what we are asserting is the CAPS decision, not the network.
    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as typeof fetch;
  const spy: OrchestratorIO = {
    ...io,
    logInteraction: (_t: string, d: Record<string, unknown>) => {
      const t = d.tool_trace as { caps?: { web_search: boolean; retrieve_pictures: boolean } } | null;
      if (t?.caps) caps = t.caps;
      return Promise.resolve();
    },
  };
  try {
    await runOrchestration({
      req: { text: 'show me a picture of a chickadee', retrieve_pictures: true, options: { model: 'qwen3' } },
      userId: 'local', token: '', supabase: null,
      // deno-lint-ignore no-explicit-any
    } as any, spy);
  } finally {
    globalThis.fetch = real;
  }
  assert(caps, 'the terminal row carries a caps snapshot');
  return caps!;
}

Deno.test('I4 end-to-end: signed OUT, retrieve_pictures:true CANNOT re-enable the funded tools', async () => {
  const caps = await capsFor('');
  assertEquals(caps.retrieve_pictures, false);
  assertEquals(caps.web_search, false);
});

Deno.test('I4 end-to-end: signed IN, the same request gets the funded tools back', async () => {
  // The other half of the regression, and the reason Option A was rejected: a signed-in
  // tester on the HA edition used to get a strictly SMALLER brain than the full add-on's.
  const caps = await capsFor('jwt.for.tests');
  assertEquals(caps.retrieve_pictures, true);
  assertEquals(caps.web_search, true);
});
