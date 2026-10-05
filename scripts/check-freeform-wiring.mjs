#!/usr/bin/env node
/**
 * check-freeform-wiring — the add-on actually serves the household's prompt, and the
 * console's preview is not lying about it.
 *
 * ── THE CLAIM THAT MATTERS ──────────────────────────────────────────────────────
 *
 * The Freeform editor tells the user the Raw view is "everything that will be sent".
 * JS_KOTLIN_CONTRACTS row 183 exists because that is only true while the console and
 * the add-on assemble identically. They now share one generated source, so this gate
 * asserts the thing the sharing is FOR: for the same inputs, the string the add-on
 * hands the model is byte-identical to the string the console previews.
 *
 * ── AND THE FAILURES THAT ARE SILENT ────────────────────────────────────────────
 *
 * Every fallback in freeform-turn.js looks, to the user, exactly like Freeform
 * working: the assistant answers, in a Dashie voice, from the Dashie prompt. A quiet
 * fallback means they believe their prompt is live when it is not. So each one has to
 * be loud, and each loud marker gets a leg.
 *
 * 🔴 ADD-ON ONLY is enforced here too, not merely intended. The cloud brain has no HA
 * access and cannot render Jinja, so if the four keys ever appear on that path the
 * feature is pointing at a runtime that cannot serve it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = `${ROOT}/dashie-ha/server`;

let pass = 0, fail = 0;
const t = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); } };

for (const f of ['freeform-turn.js', 'freeform-prompt.js', 'prompt-tool-catalog.js', 'converse.js', 'account-config.js']) {
    if (!existsSync(`${SERVER}/${f}`)) { console.log(`BLIND: ${f} missing`); process.exit(2); }
}

// ── stub HA's renderer, so nothing here needs a Home Assistant ──────────────────
let renderMode = 'ok';
let lastTemplate = null;
require.cache[require.resolve(`${SERVER}/ha-client.js`)] = {
    id: 'stub', filename: 'stub', loaded: true,
    exports: {
        getConfig: () => ({ baseUrl: 'http://ha', token: 'x' }),
        async renderTemplate(template) {
            lastTemplate = template;
            if (renderMode === 'fail') return { ok: false, error: "UndefinedError: 'nope'" };
            if (renderMode === 'throw') throw new Error('HA unreachable');
            return { ok: true, rendered: 'You are the voice assistant for Lerch Home.' };
        },
    },
};

const { buildFreeformPrompt } = require(`${SERVER}/freeform-turn.js`);
const FP = require(`${SERVER}/freeform-prompt.js`);
const CAT = require(`${SERVER}/prompt-tool-catalog.js`);

const warns = [];
const realWarn = console.warn;
console.warn = (...a) => { warns.push(a.join(' ')); };
const since = () => { const n = warns.length; return () => warns.slice(n).join('\n'); };

const ACCT = (over = {}) => ({
    promptMode: 'freeform',
    freeformPrompt: 'You are the voice assistant for {{ ha_name }}.',
    houseRules: '',
    toolsEnabled: undefined,
    personalityMode: 'off',
    ...over,
});

// ── 1 only Freeform mode, and only with something to send ──────────────────────
renderMode = 'ok';
t('1 dynamic mode sends NO override', await buildFreeformPrompt(ACCT({ promptMode: 'dynamic' })) === null);
t('1a an unset mode sends no override', await buildFreeformPrompt(ACCT({ promptMode: '' })) === null);
t('1b a null account (signed out) does not crash and sends no override',
  await buildFreeformPrompt(null) === null);

let w = since();
t('1c freeform with an EMPTY box falls back', await buildFreeformPrompt(ACCT({ freeformPrompt: '   ' })) === null);
t('1d ...LOUDLY, because a quiet fallback looks exactly like Freeform working',
  /DROP: freeform mode with an EMPTY prompt/.test(w()), w());

// ── 2 HA render failures are loud fallbacks, never silent ones ─────────────────
renderMode = 'fail'; w = since();
t('2 a Jinja error falls back', await buildFreeformPrompt(ACCT()) === null);
t('2a ...and the log carries HA\'s own message, so the cause is diagnosable',
  /DROP: freeform template failed to render/.test(w()) && /UndefinedError/.test(w()), w());

renderMode = 'throw'; w = since();
t('2b HA unreachable falls back', await buildFreeformPrompt(ACCT()) === null);
t('2c ...loudly', /DROP: freeform template could not be rendered/.test(w()), w());

// ── 3 🔴 THE ROW-183 CLAIM, EXECUTABLE ─────────────────────────────────────────
renderMode = 'ok';
const built = await buildFreeformPrompt(ACCT());
t('3 freeform mode produces a prompt', !!built && typeof built.prompt === 'string' && built.prompt.length > 50);
t('3a the add-on sent HA the user\'s TEMPLATE, not the rendered text',
  lastTemplate === 'You are the voice assistant for {{ ha_name }}.', String(lastTemplate));

// The console's Raw view, assembled from the SAME shared holder with the same inputs.
const consolePreview = FP.raw({
    rendered: 'You are the voice assistant for Lerch Home.',
    toolsStored: undefined,
    dateLine: FP.dateLine(),
    catalog: CAT,
});
t('3b 🔴 the add-on\'s prompt is BYTE-IDENTICAL to the console\'s preview',
  built.prompt === consolePreview,
  'the Raw view is lying about what gets sent — row 183\'s whole point');
t('3c ...and it carries the format block, or pass 1 cannot route a tool',
  built.prompt.includes('HOW TO REPLY') && built.prompt.includes('"type":"info_request"'));
t('3d ...and the TOOLS block names BRAIN tools, which parseContent recognises',
  built.prompt.includes('calendar_events(') && !built.prompt.includes('dashie__'),
  'printing dashie__* names would route nothing');

// ── 4 the tool list is the user's, and OFF means off ───────────────────────────
const noTools = await buildFreeformPrompt(ACCT({ toolsEnabled: '' }));
t('4 every tool off → no TOOLS block and no format block (plain prose, as HA does)',
  !noTools.prompt.includes('TOOLS') && !noTools.prompt.includes('HOW TO REPLY'), noTools.prompt.slice(0, 120));
const someTools = await buildFreeformPrompt(ACCT({ toolsEnabled: 'calendar,weather' }));
t('4a a chosen subset reaches the prompt',
  someTools.prompt.includes('calendar_events(') && someTools.prompt.includes('weather_data('));
t('4b CONTROL: and a tool NOT chosen does not — the toggle is not decorative',
  !someTools.prompt.includes('music('),
  'a tool the user switched off is still being handed to the model');
t('4c the clock tool suppresses the date line (HA: a fact is a tool or a line, never both)',
  !(await buildFreeformPrompt(ACCT({ toolsEnabled: 'calendar,schedule' }))).prompt.includes('Current time is')
  && someTools.prompt.includes('Current time is'));

// ── 5 the personality gap is countable, not hidden ─────────────────────────────
w = since();
await buildFreeformPrompt(ACCT({ personalityMode: 'automatic' }));
t('5 asking for a personality logs the gap (resolvePersonality is stubbed null here)',
  /carries NO personality/.test(w()), w());
w = since();
await buildFreeformPrompt(ACCT({ personalityMode: 'off' }));
t('5a CONTROL: personality off logs nothing', !/carries NO personality/.test(w()));

console.warn = realWarn;

// ── 6 add-on only, enforced ────────────────────────────────────────────────────
const KEYS = ['promptMode', 'freeformPrompt', 'houseRules', 'toolsEnabled'];
t('6 account-config surfaces all four keys', (() => {
    const src = readFileSync(`${SERVER}/account-config.js`, 'utf8');
    return KEYS.every((k) => src.includes(`${k}:`));
})());
t('6a converse.js passes freeform_prompt into the brain options',
  /freeform_prompt: freeform\.prompt/.test(readFileSync(`${SERVER}/converse.js`, 'utf8')));
t('6b ...and logs per turn WHICH prompt served it',
  /prompt=\$\{freeform \? /.test(readFileSync(`${SERVER}/converse.js`, 'utf8')),
  'without this nobody can tell from a log whether the household prompt was used');

console.log(`check-freeform-wiring: ${pass} pass, ${fail} fail`);
if (!fail) console.log('✅ freeform wiring: the add-on sends what the console previews, and every fallback is loud');
process.exit(fail ? 1 : 0);
