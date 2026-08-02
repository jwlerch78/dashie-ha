// redact-args.test.ts — the fleet-metadata redaction rules.
// Run: deno test --allow-env redact-args.test.ts

import { assert, assertEquals, assertMatch } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { _resetHmacKeyForTest, redactToolArgs } from './redact-args.ts';

const TOKEN = /^\[redacted:[0-9a-f]*:\d+\]$/;

Deno.test('allowlisted enum keys pass verbatim; free-text keys redact', async () => {
  const out = await redactToolArgs({
    sport: 'baseball', league: 'mlb', when: 'recent', date: '2026-07-10',
    team: 'Rays',                       // decided 2026-07-12: team is redacted
  }) as Record<string, unknown>;
  assertEquals(out.sport, 'baseball');
  assertEquals(out.league, 'mlb');
  assertEquals(out.when, 'recent');
  assertEquals(out.date, '2026-07-10');
  assertMatch(String(out.team), TOKEN);
  assert(String(out.team).endsWith(':4]'), 'token carries the original length');
});

Deno.test('calendar args: time_range/mode pass; query/member_name redact', async () => {
  const out = await redactToolArgs({
    time_range: 'next_weekend', mode: 'next',
    query: 'physical therapy', member_name: 'Mary',
  }) as Record<string, unknown>;
  assertEquals(out.time_range, 'next_weekend');
  assertEquals(out.mode, 'next');
  assertMatch(String(out.query), TOKEN);
  assertMatch(String(out.member_name), TOKEN);
});

Deno.test('top-level string arg (web_search query) redacts', async () => {
  const out = await redactToolArgs('weather in boston');
  assertMatch(String(out), TOKEN);
  assert(String(out).endsWith(':17]'));
});

Deno.test('image trace: searchTerms/criteria redact, resolved boolean passes', async () => {
  const out = await redactToolArgs({
    searchTerms: 'Harry Kane', criteria: 'action shot', resolved: false,
  }) as Record<string, unknown>;
  assertMatch(String(out.searchTerms), TOKEN);
  assertMatch(String(out.criteria), TOKEN);
  assertEquals(out.resolved, false);
});

Deno.test('booleans, numbers, null pass; nested objects and arrays keep shape', async () => {
  const out = await redactToolArgs({
    count: 3, flag: true, nothing: null,
    tags: ['soccer', 'practice'],                      // user-defined labels → redact per item
    nested: { when: 'next', hint: 'turn on the lights' },
  }) as Record<string, unknown>;
  assertEquals(out.count, 3);
  assertEquals(out.flag, true);
  assertEquals(out.nothing, null);
  const tags = out.tags as string[];
  assertEquals(tags.length, 2);
  for (const t of tags) assertMatch(t, TOKEN);
  const nested = out.nested as Record<string, unknown>;
  assertEquals(nested.when, 'next');
  assertMatch(String(nested.hint), TOKEN);
});

Deno.test('overlong value under an allowlisted key redacts anyway (enum-stuffing guard)', async () => {
  const stuffed = 'please also mention that grandma arrives thursday evening';
  const out = await redactToolArgs({ when: stuffed }) as Record<string, unknown>;
  assertMatch(String(out.when), TOKEN);
});

Deno.test('input is never mutated (client_tool shares the args object)', async () => {
  const args = { time_range: 'today', query: 'dentist', tags: ['kids'] };
  const snapshot = JSON.stringify(args);
  await redactToolArgs(args);
  assertEquals(JSON.stringify(args), snapshot);
});

Deno.test('null/undefined args stay null', async () => {
  assertEquals(await redactToolArgs(null), null);
  assertEquals(await redactToolArgs(undefined), null);
});

Deno.test('with a salt: equal values → equal tokens, different values differ (equality-preserving)', async () => {
  Deno.env.set('ARG_HASH_SALT', 'test-salt');
  _resetHmacKeyForTest();
  try {
    const a = await redactToolArgs('show me the rays score') as string;
    const b = await redactToolArgs('show me the rays score') as string;
    const c = await redactToolArgs('show me the bucs score') as string;
    assertEquals(a, b);
    assert(a !== c, 'different values must hash differently');
    assertMatch(a, /^\[redacted:[0-9a-f]{12}:\d+\]$/);
  } finally {
    Deno.env.delete('ARG_HASH_SALT');
    _resetHmacKeyForTest();
  }
});

Deno.test('no salt → fail closed: still redacts, empty hash', async () => {
  Deno.env.delete('ARG_HASH_SALT');
  _resetHmacKeyForTest();
  const out = await redactToolArgs('secret thing') as string;
  assertEquals(out, '[redacted::12]');
});
