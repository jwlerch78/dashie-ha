#!/usr/bin/env node
/**
 * check-turn-log — the per-turn history (B2b, row 80) keeps the promises that
 * made it approvable.
 *
 * Every leg here guards a property that is INVISIBLE at runtime: the code runs,
 * turns get recorded, the page renders. What differs is what ends up on disk,
 * who can read it, and what a delete actually removes.
 *
 * Exit 0 = green, 1 = a real failure, 2 = cannot check.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const errors = [];
const pass = [];
const ok = (m) => pass.push(m);
const fail = (m) => errors.push(m);
function read(rel) {
    try { return readFileSync(resolve(ROOT, rel), 'utf8'); }
    catch (e) { console.error(`cannot read ${rel}: ${e.message}`); process.exit(2); }
}

/**
 * 🔴 Strip comments before asserting on CODE.
 *
 * This is the corrective for a failure mode that hit five separate legs across
 * two gates on 2026-08-28, always the same shape: a regex matched a string that
 * also lived somewhere the mutation would never touch — a KDoc, an error
 * message, a sibling declaration, prose explaining why the thing is forbidden.
 * The gate then passed under the exact mutation it existed to catch.
 *
 * Leg 4 below found it live: turn-log.js's header EXPLAINS that it must not
 * carry session_id/endpoint_id, so a naive scan for those names failed the file
 * for documenting its own rule. 📌 The same trap sank a brand-residue gate on
 * 2026-08-04 — "documenting a forbidden string is a way of shipping it."
 *
 * A gate is a claim about behaviour only if the bytes it reads are bytes the
 * mutation would change. Comments are not those bytes.
 */
function code(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')     // block comments (incl. KDoc)
        .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');   // line comments, sparing ://
}

const log       = read('dashie-ha/server/turn-log.js');
const usageStore= read('dashie-ha/server/usage-store.js');
const turnsApi  = read('dashie-ha/server/api/turns.js');
const usageApi  = read('dashie-ha/server/api/usage.js');
const page      = read('dashie-ha/frontend/console/js/pages/usage.js');
const source    = read('dashie-ha/frontend/console/js/pages/usage-source.js');
const cfgProd   = read('dashie-ha/config.yaml');
const cfgDev    = read('dashie-ha-dev/config.yaml');
const brainIo   = read('dashie-ha/server/brain/addon-io.js');
const sttUsage  = read('dashie-ha/server/stt-usage.js');
const byokTts   = read('dashie-ha/server/byok-tts.js');
const LANE_SRC  = [['addon-io', brainIo], ['stt-usage', sttUsage], ['byok-tts', byokTts]];

// Leg 1: BACKUP-EXCLUDED, in BOTH channels.
// B's insisted condition on row 80, un-overruled: the backup fix lands in the SAME
// commit as the first per-turn write. usage.json is deliberately NOT excluded and
// argues why ("no text, no ids and no keys") — but that argument was made on the
// premise that per-turn data does not exist. This file IS that premise removed.
{
    const missing = [['prod', cfgProd], ['dev', cfgDev]]
        .filter(([, c]) => !/backup_exclude:[\s\S]*?- turns\.jsonl/.test(c))
        .map(([n]) => n);
    if (missing.length === 0) ok('1: turns.jsonl is backup_exclude-d in both channel config.yamls');
    else fail(
        `[1] turns.jsonl is NOT in backup_exclude for: ${missing.join(', ')}. A per-turn log without ` +
        `that line is a household occupancy record riding into every HA backup — including ones ` +
        `uploaded to cloud backup targets. This condition was the basis on which B2b was approved.`
    );
}

// Leg 2: the two artifacts do not share a retention.
{
    const m = log.match(/RETENTION_DAYS\s*=\s*(\d+)/);
    const agg = usageStore.match(/^const RETENTION_DAYS\s*=\s*(\d+)/m);
    if (!m || !agg) fail('[2] Could not read one of the two RETENTION_DAYS constants.');
    else if (Number(m[1]) < Number(agg[1])) ok(`2: the per-turn window (${m[1]}d) is shorter than the aggregate's (${agg[1]}d)`);
    else fail(
        `[2] The per-turn retention (${m[1]}d) is not shorter than the aggregate's (${agg[1]}d). They are ` +
        `different artifacts: a counter is cheap to keep, a presence record is not. A shared window ` +
        `would be a coincidence rather than a decision.`
    );
}

// Leg 3: DELETE lives off the usage router, so the counters have no delete path.
// The amendment scopes deletion to the per-turn store; this makes that structural.
{
    const usageHasWrite = /router\.(post|put|patch|delete)\s*\(/i.test(usageApi);
    const turnsHasDelete = /router\.delete\s*\(/i.test(turnsApi);
    if (!usageHasWrite && turnsHasDelete) ok('3: DELETE is on the turns router only — the aggregate counters have no delete path');
    else if (usageHasWrite) fail(`[3] The USAGE router grew a write verb. Deletion is scoped to the per-turn store; the counters must have no delete path at all.`);
    else fail(`[3] The turns router has no DELETE — "toggling off deletes history" has no server side.`);
}

// Leg 4: the recorder holds no ids, and no lane spreads a caller's object into it.
{
    // ⚠️ Scope to the CALL, not to a byte window after it. A first cut used
    // `[\s\S]{0,600}` and ran 18 lines past the call into an unrelated
    // `postDbOp(..., { ...data, byok: true })`, failing addon-io for a spread
    // that is not this one. A window is not a scope.
    const spreads = LANE_SRC
        .filter(([, src]) => (code(src).match(/recordTurnIfEnabled\(\{[\s\S]*?\n\s*\}\)/g) || [])
            .some((call) => /\.\.\./.test(call)))
        .map(([n]) => n);
    // Comments stripped: the header legitimately NAMES these fields to explain
    // why they are excluded, and failing the file for documenting its own rule is
    // the gate reading prose.
    const storeNamesIds = /session_id|endpoint_id|request_length|user_id/.test(code(log));
    if (spreads.length === 0 && !storeNamesIds) ok('4: no lane spreads its payload into the turn log, and the store names no id field');
    else if (spreads.length) fail(`[4] These lanes SPREAD an object into recordTurnIfEnabled: ${spreads.join(', ')}. The brain's payload carries session_id/endpoint_id/request_length and this store holds no ids.`);
    else fail(`[4] turn-log.js references an identifying field. The row shape must carry none.`);
}

// Leg 5: ONE holder resolves the gate. Three lanes call it; if each resolved the
// local key + account fallback + default itself, a missed copy is a lane that
// silently never records — which looks exactly like a quiet box.
{
    const lanesResolving = LANE_SRC
        .filter(([, src]) => /recordHistory|isRecordingEnabled/.test(code(src)))
        .map(([n]) => n);
    if (lanesResolving.length === 0) ok('5: no lane re-derives the record-history gate — turn-log is the one holder');
    else fail(`[5] These lanes reason about the gate themselves: ${lanesResolving.join(', ')}. A lane says WHAT happened; turn-log alone decides WHETHER it is kept.`);
}

// Leg 6: the gate is the ON-BOX key, not the account column. retain_transcripts is
// a Supabase column — unreachable without a JWT and false without an account — so
// gating on it would record nothing on exactly the boxes this store exists for.
{
    // ⚠️ Scope to isRecordingEnabled's BODY — the function that decides. A first
    // cut tested the whole file and passed under a mutation that gutted this
    // function, because the same expression appears in the caller's "should I read
    // the account" check. Presence in a file is not the same as use at the point
    // of decision.
    const decider = code(log).match(/function isRecordingEnabled\([\s\S]*?\n\}/)?.[0] || '';
    const readsLocalKey = /localSettings\?\.ai\?\.recordHistory/.test(decider);
    const consoleReadsLocal = /fetchRecordHistory[\s\S]{0,700}?api\/settings\/local/.test(source);
    if (readsLocalKey && consoleReadsLocal) ok('6: the gate reads the on-box key; the account value only seeds an absent one');
    else fail(
        `[6] The record-history gate does not read the on-box key on both sides. retain_transcripts is ` +
        `a Supabase column — unreadable and unsettable without an account, and false server-side — so ` +
        `gating on it ships a store that records nothing on the account-less boxes it exists for.`
    );
}

// Leg 7: toggle-OFF confirms before deleting, and says what it deletes.
{
    const opensDialog = /toggleRecordHistory\(enabled\)\s*\{[\s\S]{0,300}?_confirmOff\s*=\s*true/.test(page);
    const saysScope = /usage totals above are <strong>not<\/strong> deleted/.test(page);
    const cancelBody = page.match(/cancelRecordHistoryOff\(\)\s*\{[\s\S]*?\n    \},/)?.[0] || '';
    const cancelIsInert = /_confirmOff\s*=\s*false/.test(cancelBody) && !/clearTurns|setRecordHistory/.test(cancelBody);
    if (opensDialog && saysScope && cancelIsInert) ok('7: toggle-off confirms first, names what is deleted, and cancel deletes nothing');
    else if (!opensDialog) fail(`[7] Toggling record-history OFF does not open a confirmation. John's amendment: "Toggling off deletes history, but after a confirmation prompt."`);
    else if (!saysScope) fail(`[7] The confirmation does not say the usage TOTALS survive. Both live on this page and the reader cannot know the deletion is scoped unless told.`);
    else fail(`[7] Cancel is not inert — it must leave the toggle on and delete nothing.`);
}

// Leg 8: stop recording BEFORE deleting. The reverse races a turn landing between
// the delete and the toggle write, leaving a row behind after a confirmed delete.
{
    const body = page.match(/async confirmRecordHistoryOff\(\)[\s\S]*?\n    \},/)?.[0] || '';
    const setAt = body.indexOf('setRecordHistory(false)');
    const clearAt = body.indexOf('clearTurns()');
    if (setAt !== -1 && clearAt !== -1 && setAt < clearAt) ok('8: recording stops before the delete (no turn can land in between)');
    else fail(`[8] confirmRecordHistoryOff deletes before (or without) stopping recording. A turn landing in that window survives a confirmed delete.`);
}

if (errors.length) {
    console.error(`\nturn-log check FAILED (${errors.length} issue${errors.length > 1 ? 's' : ''}):\n`);
    for (const e of errors) console.error('  • ' + e + '\n');
    process.exit(1);
}
console.log(`✅ turn-log check passed — ${pass.length} assertions:`);
for (const p of pass) console.log(`   · ${p}`);
