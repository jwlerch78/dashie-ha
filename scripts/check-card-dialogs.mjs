#!/usr/bin/env node
/**
 * check-card-dialogs — every dialog a card tile can OPEN must be RENDERED on the page
 * that draws the card.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 * John, 2026-09-21: *"Clicking on the wake word and the voice in the device card isn't
 * opening anything. the other boxes open settings."*
 *
 * The card's five tiles called six `DevicesDetailModals.open*` handlers. `devices.js`
 * rendered five `render*Modal()` calls, and `renderWakeWordModal` / `renderVoiceSetupModal`
 * were not among them — they were rendered only on the DETAIL page. So the click set the
 * open flag, App.renderPage() ran, and the page came back without the dialog.
 *
 * 🔴 WHY IT SURVIVED EVERY OTHER GATE: nothing was broken. Both dialogs existed, both
 * rendered correctly, and both worked where they were wired. Unit checks of the dialog
 * pass; a grep for the render function finds it. The defect lived only in the JOIN between
 * two hand-maintained lists in different files, which is the one place nothing was looking.
 * This is the third list of that shape found in one evening (see check-apply-targets'
 * RENDERERS map, and _APPLY_ALL_KEYS itself).
 *
 * ── HOW ─────────────────────────────────────────────────────────────────────
 * Derived from source, both sides. Reads every `DevicesDetailModals.openX(` a card tile
 * wires up, maps each to its `renderXModal()` by the module's own naming convention, and
 * requires that call to appear on the list page. The convention is verified rather than
 * assumed: if an opener has no matching render function in the modals module at all, that
 * is BLIND, not a pass — the mapping would be silently vacuous.
 *
 * Exit: 0 all dialogs reachable · 1 a tile opens nothing · 2 BLIND.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const F = (p) => join(ROOT, 'dashie-ha/frontend/console/js/pages', p);
const CARD = F('devices-card.js'), LIST = F('devices.js'), MODALS = F('devices-detail-modals.js');

const blind = (m) => { console.error(`❌ check-card-dialogs: BLIND — ${m}`); process.exit(2); };
for (const f of [CARD, LIST, MODALS]) if (!existsSync(f)) blind(`missing ${f}`);
const card = readFileSync(CARD, 'utf8'), list = readFileSync(LIST, 'utf8'), modals = readFileSync(MODALS, 'utf8');

/** Openers the CARD wires to a tile. */
const openers = [...new Set([...card.matchAll(/DevicesDetailModals\.(open[A-Z]\w*)\s*\(/g)].map(m => m[1]))];
if (openers.length === 0) blind('the card wires no dialogs at all — the scan found nothing to check');

/** openSleep → renderSleepModal, openVoiceSetup → renderVoiceSetupModal. */
const renderFor = (opener) => `render${opener.slice('open'.length)}Modal`;

const problems = [];
let checked = 0;
for (const opener of openers) {
  const render = renderFor(opener);
  // The convention must HOLD, or this gate maps openers to functions that do not exist and
  // reports a clean pass on a mapping that means nothing.
  if (!modals.includes(`    ${render}() {`)) {
    blind(`the card calls ${opener}() but ${render}() does not exist in devices-detail-modals.js — `
      + `either the naming convention changed or the opener is dead; a mapping this gate cannot `
      + `resolve must not be reported as reachable`);
  }
  checked++;
  if (!list.includes(`${render}()`)) {
    problems.push(
      `a card tile calls ${opener}(), but devices.js never renders ${render}().\n`
      + `    → the tile sets the open flag, the page re-renders, and NOTHING appears.\n`
      + `      It looks like a dead button sitting next to tiles that work.\n`
      + `      Add \${DevicesDetailModals.${render}()} to the modal list in devices.js.`);
  }
}

if (problems.length) {
  console.error('❌ check-card-dialogs: a card tile opens a dialog the page does not render:\n');
  for (const p of problems) console.error(`  · ${p}\n`);
  process.exit(1);
}
console.log(`✅ check-card-dialogs — every dialog a card tile opens is rendered on the list page (${checked} dialogs)`);
