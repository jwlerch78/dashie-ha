// dialog-policy.test.ts — the unified dialog policy (shared by both surfaces).

import { assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { isEndIntent, isMissReply, classifyMiss, NOISE_REPLY } from './dialog-policy.ts';
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

Deno.test('isEndIntent: stop imperatives + polite closers → true', () => {
  for (const t of [
    'shut up', 'Shut up.', 'stop talking', 'be quiet', 'quiet', 'stop it', "that's enough",
    'thanks', 'thank you', 'goodbye', "that's all", 'never mind', 'done', 'stop',
    'shut up already',                                   // substring hard-stop
    "Sorry. I didn't catch that. Shot. Oh. Stop talking.",  // stop phrase buried in a garbled/echoed transcript
  ]) {
    assert(isEndIntent(t), `expected end-intent for: "${t}"`);
  }
});

Deno.test('isEndIntent: STT mid-utterance punctuation still matches (the "okay. thanks." bug, 2026-07-10)', () => {
  for (const t of [
    'okay. thanks.',      // Deepgram's actual rendering of the field failure
    'Ok, thanks!',
    'OK thanks',
    'okay thank you.',
    'Thank you!',
    "That's. All.",       // multi-word closer split by punctuation
  ]) {
    assert(isEndIntent(t), `expected end-intent for: "${t}"`);
  }
});

Deno.test('isEndIntent: real requests → false (no false close)', () => {
  for (const t of [
    "No. You're not.",
    'what if I don\'t think you\'re a large language model',
    "what's the weather",
    'add milk to the grocery list',
    'ok',                         // bare ok/okay deliberately NOT closers — too ambiguous
    'okay',                       // (could be a confirmation answer mid-dialog)
    "okay what's the weather",    // okay-prefixed request must not close
    '',
  ]) {
    assert(!isEndIntent(t), `did NOT expect end-intent for: "${t}"`);
  }
});

Deno.test('isEndIntent: trailing polite closer at the END → true ("got it, thanks")', () => {
  for (const t of [
    'got it, thanks',            // the reported case (STT "god, thanks" too)
    'god, thanks',
    'great, thank you',
    'perfect thank you',
    "ok that's all",
    'alright goodbye',
    'no thanks',                 // declining = end
  ]) {
    assert(isEndIntent(t), `expected trailing-closer end-intent for: "${t}"`);
  }
});

Deno.test('isEndIntent: a closer at the START with more speech after → false (no early close)', () => {
  for (const t of [
    "thanks, what's the weather",   // closer up front, real request follows
    'thanks can you also add milk',
    'thank you for that what time is the game',
    "i'm not done",                 // 'done' must NOT trailing-match
    "don't stop",                   // 'stop' must NOT trailing-match
    'there is nothing on the calendar', // 'nothing' must NOT trailing-match
  ]) {
    assert(!isEndIntent(t), `did NOT expect end-intent for: "${t}"`);
  }
});

Deno.test('isMissReply: the canonical noise line (and the clarify variant) → true', () => {
  assert(isMissReply(NOISE_REPLY));
  assert(isMissReply('Sorry, I didn\'t catch that.'));
  assert(isMissReply("Sorry, I didn't quite catch that — could you say it again?"));
});

Deno.test('isMissReply: a real answer → false', () => {
  assert(!isMissReply('The Yankees beat the Red Sox 6 to 3.'));
  assert(!isMissReply(''));
  assert(!isMissReply(null));
});

// ── classifyMiss (WS-F.0a — the single miss rule) ────────────────────────────
Deno.test('classifyMiss: route=noise → miss/noise (the ambient/false-wake class)', () => {
  assertEquals(classifyMiss('noise', ''), { miss: true, reason: 'noise' });
  // route wins even if the voice looks like a real answer
  assertEquals(classifyMiss('noise', 'The Yankees won.'), { miss: true, reason: 'noise' });
});

Deno.test('classifyMiss: model punted with the catch-that line → miss/no_intent', () => {
  assertEquals(
    classifyMiss('direct', "Sorry, I didn't quite catch that — could you say it again?"),
    { miss: true, reason: 'no_intent' },
  );
});

Deno.test('classifyMiss: a real answer → not a miss', () => {
  assertEquals(classifyMiss('sports', 'The Yankees beat the Red Sox 6 to 3.'), { miss: false, reason: null });
  assertEquals(classifyMiss('direct', 'The capital of France is Paris.'), { miss: false, reason: null });
});

Deno.test('classifyMiss: empty/undefined inputs → not a miss (never a false positive)', () => {
  assertEquals(classifyMiss(undefined, undefined), { miss: false, reason: null });
  assertEquals(classifyMiss(null, null), { miss: false, reason: null });
  assertEquals(classifyMiss('', ''), { miss: false, reason: null });
});
