// SPDX-License-Identifier: AGPL-3.0-only
// check-cloud-env-names.mjs — the cloud_env rename must be NAMES ONLY.
//
// John ruled the values should read `dev`/`prod` rather than `beta`/`stable`
// (2026-08-23). That is a naming change, and the entire risk is that it stops
// being one: `cloud_env` decides which SUPABASE PROJECT a signed-in household
// talks to, and the resolved name also travels on the wire as `supabase_env`,
// where the console uses it to choose a GOOGLE CLIENT ID.
//
// So there are two ways this rename could silently break a box, and this file
// pins both:
//   1. a stored legacy value resolving to a DIFFERENT project than before —
//      the household's account, history and credits would move;
//   2. a prod box whose new env name is missing from the console's prod list —
//      it falls through to the development Google client and sign-in breaks.
//      That is not hypothetical: the list read ['production','stable'] and the
//      rename to `prod` would have hit every prod box, John's included, since
//      his dev add-on deliberately stores `stable` to run against prod.
//
//   node scripts/check-cloud-env-names.mjs
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'dashie-ha', 'server', 'config.js');
const AUTH = join(ROOT, 'dashie-ha', 'frontend', 'console', 'js', 'lib', 'console-auth.js');
const YAML = join(ROOT, 'dashie-ha', 'config.yaml');

const cfg = readFileSync(CONFIG, 'utf8');
const auth = readFileSync(AUTH, 'utf8');
const yaml = readFileSync(YAML, 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '✅' : '🔴'} ${name}\n     got  ${JSON.stringify(got)}${ok ? '' : `\n     want ${JSON.stringify(want)}`}`);
};

// The two Supabase project refs, which are what "same environment" actually means.
const DEV_REF = 'cwglbtosingboqepsmjk';
const PROD_REF = 'cseaywxcvnxcsypaqaid';

/** Resolve a stored cloud_env the way server/config.js does, reading the real file. */
const aliasBlock = cfg.slice(cfg.indexOf('const ENV_ALIASES'), cfg.indexOf('let envName'));
const aliases = Object.fromEntries([...aliasBlock.matchAll(/(\w+):\s*'(\w+)'/g)].map(m => [m[1], m[2]]));
const envBlock = cfg.slice(cfg.indexOf('const ENVIRONMENTS'), cfg.indexOf('const ENV_ALIASES'));
const projectOf = (envName) => {
  const i = envBlock.indexOf(`    ${envName}: {`);
  if (i < 0) return null;
  const m = envBlock.slice(i).match(/https:\/\/([a-z]+)\.supabase\.co/);
  return m ? m[1] : null;
};
const resolveStored = (stored) => projectOf(aliases[stored] || stored);

console.log('\n── 🔴 NAMES ONLY: every stored value reaches the SAME project as before ──');
// beta/stable are what shipped through 0.9.20; development/production preceded them.
check('legacy `beta`   → the dev project', resolveStored('beta'), DEV_REF);
check('legacy `stable` → the prod project', resolveStored('stable'), PROD_REF);
check('legacy `development` → the dev project', resolveStored('development'), DEV_REF);
check('legacy `production`  → the prod project', resolveStored('production'), PROD_REF);
check('canonical `dev`  → the dev project', resolveStored('dev'), DEV_REF);
check('canonical `prod` → the prod project', resolveStored('prod'), PROD_REF);

console.log('\n── 🔴 THE SILENT AUTH BREAK: prod env names → the production Google client ──');
const prodList = (auth.match(/_PROD_SUPABASE_ENVS:\s*\[([^\]]*)\]/) || [, ''])[1]
  .split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
check('the console treats every PROD name as production',
  ['prod', 'production', 'stable'].every(n => prodList.includes(n)), true);
// ⚖️ Without this the leg is satisfiable by listing every name, which would send
// dev boxes to the production Google client — the same bug pointing the other way.
check('⚖️ …and treats NO dev name as production',
  ['dev', 'beta', 'development'].some(n => prodList.includes(n)), false);

console.log('\n── ⚖️ the schema still accepts what boxes already store ──────────────');
const list = (yaml.match(/cloud_env:\s*list\(([^)]*)\)/) || [, ''])[1].split('|');
check('every legacy AND canonical value is still valid in the schema',
  ['dev', 'prod', 'beta', 'stable', 'development', 'production'].every(v => list.includes(v)), true,
);
check('the shipped DEFAULT is the canonical dev name',
  (yaml.match(/^\s{2}cloud_env:\s*(\w+)\s*$/m) || [, ''])[1], 'dev');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
