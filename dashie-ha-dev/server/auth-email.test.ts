// auth-email.test.ts — board row 122: a VERIFIED sign-up is a success, not a failure.
//
//   deno test --unstable-detect-cjs --allow-read --allow-env --allow-sys \
//        dashie-ha/server/auth-email.test.ts
//
// ⚠️ --unstable-detect-cjs IS REQUIRED and is not optional politeness: auth.js is
// CommonJS, this repo has no root package.json, so without the flag Deno refuses to
// load the module and the suite dies with a MODULE error BEFORE any assertion runs —
// a red that proves nothing. (The pre-existing brain/addon-io.test.ts fails the same
// way for the same reason; not touched here, it is another thread's file.)
//
// THE DEFECT THIS PINS. `emailAuth` decided with a two-branch `if`:
//
//     if (body?.success && body.jwtToken) { signed in } else { ok:false, error, message }
//
// Row 122 (U's `7c1d3f542`) added a THIRD response that the two branches cannot express.
// With `require_email_verification` on, a sign-up mints no JWT and jwt-auth answers
// **HTTP 200**:
//
//     { success: true, verification_required: true,
//       message: 'Check your email for a confirmation link, then sign in.' }
//
// That is a SUCCESS — the account was created and the mail was sent — but it has no
// `jwtToken`, so it fell to the else and the console rendered our own check-your-email
// sentence as an ERROR, under the machine code `http_200` (there is no `body.error` to
// fall back to, so the `http_${status}` default fires on a 200). The user is told their
// sign-up failed at the exact moment it succeeded, and `email_signup` is the
// Dashie-for-HA edition's account front door on BOTH channels.
//
// 🔴 WHY THE SERVER FIX ALONE WOULD HAVE BEEN WORSE THAN THE BUG. The obvious repair is
// "return ok:true, it succeeded". The frontend does `if (r.ok) window.location.reload()`
// — and there is no JWT to boot from, so the reload lands back on the login screen with
// no message at all. A silent loop is worse than a wrong-coloured sentence, so `ok`
// keeps meaning "signed in" (which is FALSE here) and the third case is carried by its
// own discriminator that an old frontend simply ignores.
//
// COMPAT, both directions, since server and console can ship on different vehicles:
//   new server + old console -> no `verificationRequired` branch, falls to the error
//                               path: exactly today's behaviour, no regression.
//   old server + new console -> the field is never set, branch never taken: likewise.
// Either half alone is harmless; together they fix it.

import { assertEquals } from 'jsr:@std/assert@1';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyEmailAuthResponse } = require('./auth.js') as {
  classifyEmailAuthResponse: (status: number, body: unknown) => {
    kind: string; error?: string; message?: string;
  };
};

/** The exact shape jwt-auth returns — email-auth.ts:373-378, copied verbatim. */
const VERIFICATION_REQUIRED = {
  success: true,
  verification_required: true,
  message: 'Check your email for a confirmation link, then sign in.',
};

Deno.test('a verified sign-up is NOT a failure', () => {
  const out = classifyEmailAuthResponse(200, VERIFICATION_REQUIRED);
  assertEquals(out.kind, 'verification_required');
});

Deno.test('the check-your-email sentence is carried through, not replaced', () => {
  const out = classifyEmailAuthResponse(200, VERIFICATION_REQUIRED);
  assertEquals(out.message, 'Check your email for a confirmation link, then sign in.');
});

Deno.test('a verified sign-up never reports the http_200 machine code', () => {
  // The visible half of the bug: no body.error on a 200, so `http_${status}` fired and
  // "http_200" reached the panel as the reason a successful sign-up had failed.
  const out = classifyEmailAuthResponse(200, VERIFICATION_REQUIRED);
  assertEquals(out.error, undefined);
});

// ── the paths that must NOT move (this is a three-case decision, not a new default) ──

Deno.test('a real sign-in still signs in', () => {
  assertEquals(
    classifyEmailAuthResponse(200, { success: true, jwtToken: 'jwt.abc', user: { id: 'u1' } }).kind,
    'signed_in',
  );
});

Deno.test('a genuine refusal is still a failure, code and message intact', () => {
  const out = classifyEmailAuthResponse(400, {
    success: false, error: 'invalid_credentials', message: 'Wrong email or password.',
  });
  assertEquals(out.kind, 'failed');
  assertEquals(out.error, 'invalid_credentials');
  assertEquals(out.message, 'Wrong email or password.');
});

Deno.test('use_google_signin still reaches the panel — it keys on this code', () => {
  assertEquals(
    classifyEmailAuthResponse(400, { success: false, error: 'use_google_signin' }).error,
    'use_google_signin',
  );
});

Deno.test('a transport failure with no body still fails with the http_ code', () => {
  const out = classifyEmailAuthResponse(502, null);
  assertEquals(out.kind, 'failed');
  assertEquals(out.error, 'http_502');
});

Deno.test('success with NEITHER jwtToken nor verification_required stays a failure', () => {
  // A shape no current server sends. It must not become an accidental success just
  // because it says success:true — and standing rule 2 says the drop is logged loudly
  // rather than swallowed. Failing closed is the right direction for an auth decision.
  assertEquals(classifyEmailAuthResponse(200, { success: true }).kind, 'failed');
});
